package control

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
	"honeyforge/internal/contracts"
)

func TestTrapNodeAndRegistrationHistoryPersistWithoutSecrets(t *testing.T) {
	db, _, cleanup := setupIntegration(t)
	defer cleanup()
	ctx := context.Background()
	hash, _ := bcrypt.GenerateFromPassword([]byte("registration-test-password"), bcrypt.MinCost)
	for _, role := range []string{"operator", "viewer"} {
		if _, err := db.Exec(ctx, `INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,$2)`, uuid(), role, string(hash)); err != nil {
			t.Fatal(err)
		}
	}
	handler := New(db, Config{PublicOrigin: testOrigin}).Handler()
	op := &testAPI{t: t, h: handler}
	op.login("operator", "registration-test-password")
	viewer := &testAPI{t: t, h: handler}
	viewer.login("viewer", "registration-test-password")
	for _, node := range []string{"node\ninvalid", strings.Repeat("n", 254)} {
		body, _ := json.Marshal(map[string]any{"name": "bad", "deployment_node": node, "deployment_bindings": []any{}})
		if w := op.request("POST", "/api/v1/traps", string(body), true, true); w.Code != 422 {
			t.Fatalf("invalid node: %d %s", w.Code, w.Body.String())
		}
	}
	w := op.request("POST", "/api/v1/traps", `{"name":"node trap","deployment_node":"  linux-lab-02  ","deployment_bindings":[]}`, true, true)
	if w.Code != 201 {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	var trap contracts.Trap
	_ = json.Unmarshal(w.Body.Bytes(), &trap)
	if trap.DeploymentNode != "linux-lab-02" || trap.RegistrationStatus != "pending" {
		t.Fatalf("node/status: %+v", trap)
	}
	if w := viewer.request("POST", "/api/v1/traps", `{"name":"forbidden","deployment_node":"node"}`, true, true); w.Code != 403 {
		t.Fatal("viewer created trap")
	}
	path := "/api/v1/traps/" + trap.ID + "/registration-attempts"
	if w := op.request("GET", path, "", false, false); w.Code != 401 {
		t.Fatal("anonymous history allowed")
	}
	enroll := func(token string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]string{"trap_id": trap.ID, "token": token})
		return op.request("POST", "/agent/v1/enroll", string(body), false, false)
	}
	invalidToken := strings.Repeat("invalid-", 5)
	for i := 0; i < 105; i++ {
		if w := enroll(invalidToken); w.Code != 401 {
			t.Fatalf("invalid enrollment=%d", w.Code)
		}
	}
	var retained int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM registration_attempts WHERE trap_id=$1`, trap.ID).Scan(&retained); err != nil || retained != 100 {
		t.Fatalf("retained=%d err=%v", retained, err)
	}
	ids := map[string]bool{}
	cursor := ""
	for {
		w := viewer.request("GET", path+"?limit=17"+cursor, "", false, true)
		if w.Code != 200 {
			t.Fatalf("history: %d %s", w.Code, w.Body.String())
		}
		if strings.Contains(w.Body.String(), invalidToken) || strings.Contains(w.Body.String(), "token_hash") {
			t.Fatal("history leaked credential")
		}
		var page contracts.Page[contracts.RegistrationAttempt]
		_ = json.Unmarshal(w.Body.Bytes(), &page)
		for _, a := range page.Items {
			if ids[a.ID] || a.Reason != "invalid_token" {
				t.Fatalf("duplicate or invalid attempt %+v", a)
			}
			ids[a.ID] = true
		}
		if page.NextCursor == "" {
			break
		}
		cursor = "&cursor=" + page.NextCursor
	}
	if len(ids) != 100 {
		t.Fatalf("paginated attempts=%d", len(ids))
	}
	if w := op.request("GET", path+"?cursor=invalid", "", false, true); w.Code != 400 {
		t.Fatal("invalid cursor accepted")
	}
	issue := func() string {
		w := op.request("POST", "/api/v1/traps/"+trap.ID+"/enrollment-token", "", true, true)
		if w.Code != 201 {
			t.Fatalf("issue: %d %s", w.Code, w.Body.String())
		}
		var value struct {
			Token string `json:"token"`
		}
		_ = json.Unmarshal(w.Body.Bytes(), &value)
		return value.Token
	}
	expired := issue()
	_, _ = db.Exec(ctx, `UPDATE enrollment_tokens SET expires_at=now()-interval '1 second' WHERE trap_id=$1`, trap.ID)
	if w := enroll(expired); w.Code != 401 {
		t.Fatal("expired token accepted")
	}
	inactive := issue()
	valid := issue()
	if w := enroll(inactive); w.Code != 401 {
		t.Fatal("inactive token accepted")
	}
	if w := enroll(valid); w.Code != 201 {
		t.Fatalf("valid enrollment=%d %s", w.Code, w.Body.String())
	}
	already := issue()
	if w := enroll(already); w.Code != 409 {
		t.Fatal("second enrollment accepted")
	}
	restarted := &testAPI{t: t, h: New(db, Config{PublicOrigin: testOrigin}).Handler(), cookie: op.cookie, csrf: op.csrf}
	w = restarted.request("GET", "/api/v1/traps/"+trap.ID, "", false, true)
	_ = json.Unmarshal(w.Body.Bytes(), &trap)
	if trap.DeploymentNode != "linux-lab-02" || trap.AgentID == nil || trap.RegistrationStatus != "registered" || trap.LastRegistrationAttempt == nil || trap.LastRegistrationAttempt.Reason != "already_enrolled" {
		t.Fatalf("persisted state=%s", w.Body.String())
	}
	history := restarted.request("GET", path, "", false, true)
	for _, token := range []string{invalidToken, expired, inactive, valid, already} {
		if strings.Contains(history.Body.String(), token) {
			t.Fatal("credential in history")
		}
	}
	for _, reason := range []string{"invalid_token", "expired_token", "inactive_token", "registered", "already_enrolled"} {
		if !strings.Contains(history.Body.String(), fmt.Sprintf(`"reason":%q`, reason)) {
			t.Fatalf("missing reason %s", reason)
		}
	}
}
