package control

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
	"honeyforge/internal/contracts"
)

// TestQA03SensitiveDataAndManagementBoundary checks the API as an attacker
// and as a viewer. It proves that redaction is enforced by the handler rather
// than by UI visibility, while the audited operator path remains available.
func TestQA03SensitiveDataAndManagementBoundary(t *testing.T) {
	db, _, cleanup := setupIntegration(t)
	defer cleanup()
	ctx := context.Background()
	hash, err := bcrypt.GenerateFromPassword([]byte("qa03-password-12"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	for _, user := range []struct{ name, role string }{{"qa03-operator", "operator"}, {"qa03-viewer", "viewer"}} {
		if _, err = db.Exec(ctx, `INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,$4)`, uuid(), user.name, string(hash), user.role); err != nil {
			t.Fatal("seed QA-03 user:", err)
		}
	}
	handler := New(db, Config{PublicOrigin: testOrigin, CookieSecure: false}).Handler()
	op := &testAPI{t: t, h: handler}
	op.login("qa03-operator", "qa03-password-12")
	viewer := &testAPI{t: t, h: handler}
	viewer.login("qa03-viewer", "qa03-password-12")

	profileResponse := op.request(http.MethodPost, "/api/v1/profiles", profileJSON("QA-03 profile", 0), true, true)
	if profileResponse.Code != http.StatusCreated || strings.Contains(profileResponse.Body.String(), "lab-credential-secret") {
		t.Fatalf("profile response=%d leaked secret: %s", profileResponse.Code, profileResponse.Body.String())
	}
	var profileBody struct {
		Profile contracts.Profile `json:"profile"`
	}
	if err = json.Unmarshal(profileResponse.Body.Bytes(), &profileBody); err != nil {
		t.Fatal(err)
	}
	trapResponse := op.request(http.MethodPost, "/api/v1/traps", `{"name":"qa03-trap","deployment_bindings":[{"service_id":"web","host_port":19083}]}`, true, true)
	if trapResponse.Code != http.StatusCreated {
		t.Fatalf("trap response=%d %s", trapResponse.Code, trapResponse.Body.String())
	}
	var trap contracts.Trap
	if err = json.Unmarshal(trapResponse.Body.Bytes(), &trap); err != nil {
		t.Fatal(err)
	}
	if w := op.request(http.MethodPut, "/api/v1/traps/"+trap.ID+"/profile", fmt.Sprintf(`{"profile_id":%q,"revision":1}`, profileBody.Profile.ID), true, true); w.Code != http.StatusOK {
		t.Fatalf("assignment=%d %s", w.Code, w.Body.String())
	}

	agentID, agentToken, eventID := uuid(), "qa03-agent-secret", uuid()
	if _, err = db.Exec(ctx, `INSERT INTO agents(id,trap_id,token_hash) VALUES($1,$2,$3)`, agentID, trap.ID, tokenHash(agentToken)); err != nil {
		t.Fatal("seed agent:", err)
	}
	payload := `{"username":"alice","password":"visitor-secret","html":"<script>alert(1)</script>","formula":"=1+1"}`
	if _, err = db.Exec(ctx, `INSERT INTO events(id,schema_version,trap_id,agent_id,service_id,profile_id,applied_revision,event_type,occurred_at,source_ip,destination_port,protocol,payload,source_asn_org) VALUES($1,'1.0',$2,$3,'web',$4,1,'http.request','2026-10-14T12:00:00Z','192.0.2.53',80,'http',$5::jsonb,'=1+1')`, eventID, trap.ID, agentID, profileBody.Profile.ID, payload); err != nil {
		t.Fatal("seed sensitive event:", err)
	}

	query := "/api/v1/events?trap_id=" + trap.ID + "&from=2026-10-14T00%3A00%3A00Z&to=2026-10-15T00%3A00%3A00Z&source_ip=192.0.2.53&event_type=http.request"
	for _, actor := range []*testAPI{op, viewer} {
		page := actor.request(http.MethodGet, query, "", false, true)
		body := page.Body.String()
		if page.Code != http.StatusOK || !strings.Contains(body, `"payload_redacted":true`) || strings.Contains(body, "visitor-secret") || strings.Contains(body, "<script>") || strings.Contains(body, agentToken) {
			t.Fatalf("redacted event page status=%d body=%s", page.Code, body)
		}
	}
	if w := viewer.request(http.MethodGet, "/api/v1/traps/"+trap.ID+"/events/"+eventID+"/sensitive", "", false, true); w.Code != http.StatusForbidden {
		t.Fatalf("viewer sensitive event status=%d", w.Code)
	}
	if w := viewer.request(http.MethodGet, "/api/v1/events/export.csv?trap_id="+trap.ID+"&from=2026-10-14T00%3A00%3A00Z&to=2026-10-15T00%3A00%3A00Z", "", false, true); w.Code != http.StatusForbidden {
		t.Fatalf("viewer CSV status=%d", w.Code)
	}
	operatorSensitive := op.request(http.MethodGet, "/api/v1/traps/"+trap.ID+"/events/"+eventID+"/sensitive", "", false, true)
	if operatorSensitive.Code != http.StatusOK || !strings.Contains(operatorSensitive.Body.String(), "visitor-secret") {
		t.Fatalf("operator sensitive event status=%d body=%s", operatorSensitive.Code, operatorSensitive.Body.String())
	}
	operatorCSV := op.request(http.MethodGet, "/api/v1/events/export.csv?trap_id="+trap.ID+"&from=2026-10-14T00%3A00%3A00Z&to=2026-10-15T00%3A00%3A00Z", "", false, true)
	if operatorCSV.Code != http.StatusOK || strings.Contains(operatorCSV.Body.String(), "visitor-secret") {
		t.Fatalf("operator CSV leaked or failed formula neutralization: %d %s", operatorCSV.Code, operatorCSV.Body.String())
	}
	rows, err := csv.NewReader(strings.NewReader(operatorCSV.Body.String())).ReadAll()
	if err != nil || len(rows) != 2 || len(rows[1]) != 14 || rows[1][1] != eventID || rows[1][10] != "'=1+1" {
		t.Fatalf("CSV did not neutralize a field actually included in the export: rows=%v err=%v", rows, err)
	}
	if w := viewer.request(http.MethodGet, "/api/v1/audit", "", false, true); w.Code != http.StatusForbidden {
		t.Fatalf("viewer audit status=%d", w.Code)
	}
	audit := op.request(http.MethodGet, "/api/v1/audit?action=event.sensitive_read", "", false, true)
	if audit.Code != http.StatusOK || !strings.Contains(audit.Body.String(), "event.sensitive_read") || strings.Contains(audit.Body.String(), agentToken) {
		t.Fatalf("sensitive-read audit status=%d body=%s", audit.Code, audit.Body.String())
	}

	unauthenticatedAgent := httptest.NewRecorder()
	handler.ServeHTTP(unauthenticatedAgent, httptest.NewRequest(http.MethodGet, "/agent/v1/traps/"+trap.ID+"/config", nil))
	if unauthenticatedAgent.Code != http.StatusUnauthorized {
		t.Fatalf("agent config without bearer status=%d", unauthenticatedAgent.Code)
	}
}
