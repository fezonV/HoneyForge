package control

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
	"honeyforge/internal/contracts"
)

// QA-01 is intentionally kept as a separate suite. These tests exercise the
// public HTTP boundary and are independent of the implementation-level tests
// in control_integration_test.go.

func TestQA01ProfileAuthorizationValidationAndRevisionIsolation(t *testing.T) {
	db, _, cleanup := setupIntegration(t)
	defer cleanup()
	ctx := context.Background()
	hash, err := bcrypt.GenerateFromPassword([]byte("qa01-password-12"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	for _, user := range []struct{ name, role string }{{"qa01-operator", "operator"}, {"qa01-viewer", "viewer"}} {
		if _, err = db.Exec(ctx, `INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,$4)`, uuid(), user.name, string(hash), user.role); err != nil {
			t.Fatal("seed QA-01 user:", err)
		}
	}
	h := New(db, Config{PublicOrigin: testOrigin, CookieSecure: false}).Handler()

	anonymous := httptest.NewRecorder()
	h.ServeHTTP(anonymous, httptest.NewRequest(http.MethodGet, "/api/v1/profiles", nil))
	if anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous profile read=%d", anonymous.Code)
	}

	viewer := &testAPI{t: t, h: h}
	viewer.login("qa01-viewer", "qa01-password-12")
	if got := viewer.request(http.MethodPost, "/api/v1/profiles", `{"name":"denied","description":"","config":{}}`, true, true).Code; got != http.StatusForbidden {
		t.Fatalf("viewer profile write=%d", got)
	}

	op := &testAPI{t: t, h: h}
	op.login("qa01-operator", "qa01-password-12")
	loginCookie := op.cookie
	if loginCookie == "" {
		t.Fatal("operator session cookie missing")
	}
	if w := op.request(http.MethodPost, "/api/v1/profiles", `{"name":"unknown","description":"","config":{},"unexpected":true}`, true, true); w.Code != http.StatusBadRequest {
		t.Fatalf("unknown request field status=%d body=%s", w.Code, w.Body.String())
	}

	tooMany := profileConfig()
	tooMany.Services = make([]contracts.Service, 17)
	for i := range tooMany.Services {
		tooMany.Services[i] = contracts.Service{ID: fmt.Sprintf("web-%d", i), Name: "Web", Protocol: "http", Port: 8080 + i, Banner: "HoneyForge"}
	}
	tooManyBody, _ := json.Marshal(map[string]any{"name": "too-many", "description": "", "config": tooMany})
	if w := op.request(http.MethodPost, "/api/v1/profiles", string(tooManyBody), true, true); w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("profile limit status=%d body=%s", w.Code, w.Body.String())
	}

	created := op.request(http.MethodPost, "/api/v1/profiles", profileJSON("QA-01 profile", 0), true, true)
	if created.Code != http.StatusCreated || strings.Contains(created.Body.String(), "lab-credential-secret") {
		t.Fatalf("profile create=%d or secret leaked: %s", created.Code, created.Body.String())
	}
	var createdBody struct {
		Profile contracts.Profile `json:"profile"`
	}
	if err = json.Unmarshal(created.Body.Bytes(), &createdBody); err != nil {
		t.Fatal("decode profile:", err)
	}
	for _, actor := range []*testAPI{op, viewer} {
		read := actor.request(http.MethodGet, "/api/v1/profiles/"+createdBody.Profile.ID, "", false, true)
		if read.Code != http.StatusOK || strings.Contains(read.Body.String(), "lab-credential-secret") {
			t.Fatalf("ordinary profile read leaked credentials: status=%d body=%s", read.Code, read.Body.String())
		}
	}
	if sensitive := op.request(http.MethodGet, "/api/v1/profiles/"+createdBody.Profile.ID+"/revisions/1/sensitive", "", false, true); sensitive.Code != http.StatusOK || !strings.Contains(sensitive.Body.String(), "lab-credential-secret") {
		t.Fatalf("operator sensitive profile read=%d body=%s", sensitive.Code, sensitive.Body.String())
	}
	if sensitive := viewer.request(http.MethodGet, "/api/v1/profiles/"+createdBody.Profile.ID+"/revisions/1/sensitive", "", false, true); sensitive.Code != http.StatusForbidden {
		t.Fatalf("viewer sensitive profile read=%d", sensitive.Code)
	}

	newTrap := op.request(http.MethodPost, "/api/v1/traps", `{"name":"qa01-trap","deployment_bindings":[{"service_id":"web","host_port":19081}]}`, true, true)
	if newTrap.Code != http.StatusCreated {
		t.Fatalf("trap create=%d body=%s", newTrap.Code, newTrap.Body.String())
	}
	var trap contracts.Trap
	if err = json.Unmarshal(newTrap.Body.Bytes(), &trap); err != nil {
		t.Fatal("decode trap:", err)
	}
	invalidRevision := fmt.Sprintf(`{"profile_id":%q,"revision":99}`, createdBody.Profile.ID)
	if w := op.request(http.MethodPut, "/api/v1/traps/"+trap.ID+"/profile", invalidRevision, true, true); w.Code != http.StatusNotFound {
		t.Fatalf("unknown revision status=%d body=%s", w.Code, w.Body.String())
	}
	assign := fmt.Sprintf(`{"profile_id":%q,"revision":1}`, createdBody.Profile.ID)
	if w := op.request(http.MethodPut, "/api/v1/traps/"+trap.ID+"/profile", assign, true, true); w.Code != http.StatusOK {
		t.Fatalf("profile assignment status=%d body=%s", w.Code, w.Body.String())
	}
	if w := op.request(http.MethodDelete, "/api/v1/profiles/"+createdBody.Profile.ID, "", true, true); w.Code != http.StatusConflict {
		t.Fatalf("assigned profile deletion status=%d", w.Code)
	}

	patch := profileJSON("QA-01 revision", 1)
	if w := op.request(http.MethodPatch, "/api/v1/profiles/"+createdBody.Profile.ID, strings.Replace(patch, `"base_revision":1`, `"base_revision":99`, 1), true, true); w.Code != http.StatusConflict {
		t.Fatalf("stale revision status=%d body=%s", w.Code, w.Body.String())
	}
	updated := op.request(http.MethodPatch, "/api/v1/profiles/"+createdBody.Profile.ID, patch, true, true)
	if updated.Code != http.StatusOK || !strings.Contains(updated.Body.String(), `"revision":2`) {
		t.Fatalf("profile revision status=%d body=%s", updated.Code, updated.Body.String())
	}
	var after contracts.Trap
	if w := op.request(http.MethodGet, "/api/v1/traps/"+trap.ID, "", false, true); w.Code != http.StatusOK {
		t.Fatalf("trap read=%d", w.Code)
	} else if err = json.Unmarshal(w.Body.Bytes(), &after); err != nil {
		t.Fatal("decode assigned trap:", err)
	}
	if after.DesiredRevision == nil || *after.DesiredRevision != 1 || after.AppliedRevision != nil {
		t.Fatalf("profile edit changed assignment: %+v", after)
	}

	if w := op.request(http.MethodDelete, "/api/v1/traps/"+trap.ID+"/profile", "", true, true); w.Code != http.StatusOK {
		t.Fatalf("detach status=%d", w.Code)
	}
	if w := op.request(http.MethodDelete, "/api/v1/profiles/"+createdBody.Profile.ID, "", true, true); w.Code != http.StatusNoContent {
		t.Fatalf("free profile deletion status=%d", w.Code)
	}
	if w := op.request(http.MethodGet, "/api/v1/profiles/"+createdBody.Profile.ID+"/revisions", "", false, true); w.Code != http.StatusOK {
		t.Fatalf("revision history after deletion status=%d", w.Code)
	}
}

func TestQA01RegistrationAndSecretBoundary(t *testing.T) {
	db, _, cleanup := setupIntegration(t)
	defer cleanup()
	ctx := context.Background()
	hash, err := bcrypt.GenerateFromPassword([]byte("qa01-password-12"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	for _, user := range []struct{ name, role string }{{"qa01-reg-op", "operator"}, {"qa01-reg-view", "viewer"}} {
		if _, err = db.Exec(ctx, `INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,$4)`, uuid(), user.name, string(hash), user.role); err != nil {
			t.Fatal("seed QA-01 registration user:", err)
		}
	}
	h := New(db, Config{PublicOrigin: testOrigin, CookieSecure: false}).Handler()
	op := &testAPI{t: t, h: h}
	op.login("qa01-reg-op", "qa01-password-12")
	viewer := &testAPI{t: t, h: h}
	viewer.login("qa01-reg-view", "qa01-password-12")
	trapResponse := op.request(http.MethodPost, "/api/v1/traps", `{"name":"registration target","deployment_node":"qa01-node","deployment_bindings":[]}`, true, true)
	if trapResponse.Code != http.StatusCreated {
		t.Fatalf("trap create=%d body=%s", trapResponse.Code, trapResponse.Body.String())
	}
	var trap contracts.Trap
	if err = json.Unmarshal(trapResponse.Body.Bytes(), &trap); err != nil {
		t.Fatal(err)
	}
	if w := viewer.request(http.MethodPost, "/api/v1/traps/"+trap.ID+"/enrollment-token", `{}`, true, true); w.Code != http.StatusForbidden {
		t.Fatalf("viewer enrollment issue=%d", w.Code)
	}
	issued := op.request(http.MethodPost, "/api/v1/traps/"+trap.ID+"/enrollment-token", `{}`, true, true)
	if issued.Code != http.StatusCreated {
		t.Fatalf("enrollment issue=%d body=%s", issued.Code, issued.Body.String())
	}
	var tokenResponse struct{ Token string `json:"token"` }
	if err = json.Unmarshal(issued.Body.Bytes(), &tokenResponse); err != nil || tokenResponse.Token == "" {
		t.Fatal("enrollment token missing")
	}
	var storedHash string
	if err = db.QueryRow(ctx, `SELECT encode(token_hash,'hex') FROM enrollment_tokens WHERE trap_id=$1`, trap.ID).Scan(&storedHash); err != nil {
		t.Fatal("read enrollment hash:", err)
	}
	if storedHash != hex.EncodeToString(tokenHash(tokenResponse.Token)) || strings.Contains(issued.Body.String(), storedHash) {
		t.Fatal("enrollment token was not persisted as its SHA-256 hash")
	}

	enroll := func(trapID, token string) *httptest.ResponseRecorder {
		body := fmt.Sprintf(`{"trap_id":%q,"token":%q}`, trapID, token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/agent/v1/enroll", strings.NewReader(body)))
		return w
	}
	if w := enroll(trap.ID, "wrong-token"); w.Code != http.StatusUnauthorized {
		t.Fatalf("invalid enrollment=%d", w.Code)
	}
	valid := enroll(trap.ID, tokenResponse.Token)
	if valid.Code != http.StatusCreated || strings.Contains(valid.Body.String(), "qa01-password-12") {
		t.Fatalf("valid enrollment=%d body=%s", valid.Code, valid.Body.String())
	}
	if w := enroll(trap.ID, tokenResponse.Token); w.Code != http.StatusUnauthorized {
		t.Fatalf("enrollment replay=%d", w.Code)
	}
	if w := op.request(http.MethodGet, "/api/v1/traps/"+trap.ID+"/registration-attempts", "", false, true); w.Code != http.StatusOK || strings.Contains(w.Body.String(), tokenResponse.Token) {
		t.Fatalf("registration history=%d or leaked token: %s", w.Code, w.Body.String())
	}
	if w := op.request(http.MethodPost, "/api/v1/auth/logout", `{}`, false, true); w.Code != http.StatusForbidden {
		t.Fatalf("logout without CSRF=%d", w.Code)
	}
	if w := op.request(http.MethodPost, "/api/v1/auth/logout", `{}`, true, true); w.Code != http.StatusNoContent {
		t.Fatalf("logout=%d", w.Code)
	}
	if w := op.request(http.MethodGet, "/api/v1/auth/me", "", false, true); w.Code != http.StatusUnauthorized {
		t.Fatalf("session survived logout=%d", w.Code)
	}
	if _, err = db.Exec(ctx, `UPDATE operator_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1`, tokenHash(viewer.cookie)); err != nil {
		t.Fatal("expire viewer session:", err)
	}
	if w := viewer.request(http.MethodGet, "/api/v1/auth/me", "", false, true); w.Code != http.StatusUnauthorized {
		t.Fatalf("expired session remained valid=%d", w.Code)
	}
}
