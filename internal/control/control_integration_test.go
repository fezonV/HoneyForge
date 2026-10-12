package control

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
	"honeyforge/internal/contracts"
	"honeyforge/migrations"
)

const testOrigin = "http://127.0.0.1:8081"

type testAPI struct {
	t            *testing.T
	h            http.Handler
	cookie, csrf string
}

func (a *testAPI) request(method, path, body string, csrf bool, cookies bool) *httptest.ResponseRecorder {
	a.t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if csrf {
		r.Header.Set("Origin", testOrigin)
		r.Header.Set("X-CSRF-Token", a.csrf)
	}
	if cookies && a.cookie != "" {
		r.AddCookie(&http.Cookie{Name: "hf_session", Value: a.cookie})
		r.AddCookie(&http.Cookie{Name: "csrf_token", Value: a.csrf})
	}
	w := httptest.NewRecorder()
	a.h.ServeHTTP(w, r)
	return w
}
func (a *testAPI) login(username, password string) {
	a.t.Helper()
	w := a.request("POST", "/api/v1/auth/login", fmt.Sprintf(`{"username":%q,"password":%q}`, username, password), false, false)
	if w.Code != 200 {
		a.t.Fatalf("login %s: %d %s", username, w.Code, w.Body.String())
	}
	for _, c := range w.Result().Cookies() {
		if c.Name == "hf_session" {
			a.cookie = c.Value
		}
		if c.Name == "csrf_token" {
			a.csrf = c.Value
		}
	}
	if a.cookie == "" || a.csrf == "" {
		a.t.Fatal("login cookies missing")
	}
}
func setupIntegration(t *testing.T) (*pgxpool.Pool, string, func()) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set; PostgreSQL integration coverage skipped")
	}
	ctx := context.Background()
	adminCfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal("parse TEST_DATABASE_URL")
	}
	admin, err := pgxpool.NewWithConfig(ctx, adminCfg)
	if err != nil {
		t.Fatal("connect to TEST_DATABASE_URL")
	}
	schema := "be01_" + strings.ReplaceAll(uuid(), "-", "")
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		admin.Close()
		t.Fatal("create isolated integration schema")
	}
	appCfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	appCfg.ConnConfig.RuntimeParams["search_path"] = schema
	db, err := pgxpool.NewWithConfig(ctx, appCfg)
	if err != nil {
		t.Fatal(err)
	}
	cleanup := func() {
		db.Close()
		_, _ = admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		admin.Close()
	}
	if err = migrations.Apply(ctx, db); err != nil {
		cleanup()
		t.Fatalf("apply migrations: %v", err)
	}
	if err = migrations.Apply(ctx, db); err != nil {
		cleanup()
		t.Fatalf("apply migrations twice: %v", err)
	}
	return db, schema, cleanup
}
func profileConfig() contracts.ProfileConfig {
	return contracts.ProfileConfig{TemplateID: "medium-http", Level: "medium", Services: []contracts.Service{{ID: "web", Name: "Web", Protocol: "http", Port: 8080, Banner: "HoneyForge"}}, VisibleTexts: contracts.VisibleTexts{Title: "Admin", LoginPrompt: "Sign in", Success: "Welcome", Failure: "Denied"}, SyntheticCredentials: []contracts.SyntheticCredential{{Username: "demo", Password: "lab-credential-secret"}}, FakeFS: []contracts.FakeFile{{Path: "reports/summary.txt", Content: "synthetic report"}}, Logging: contracts.Logging{Categories: []string{"http.request", "auth.attempt", "session.started", "file.listed", "file.read", "file.downloaded", "session.ended"}}, Channel: contracts.Channel{TLSRequired: true, HeartbeatSeconds: 10, SyncSeconds: 2}}
}
func profileJSON(name string, base int) string {
	cfg, _ := json.Marshal(profileConfig())
	if base == 0 {
		return fmt.Sprintf(`{"name":%q,"description":"integration","config":%s}`, name, cfg)
	}
	return fmt.Sprintf(`{"base_revision":%d,"name":%q,"description":"integration-v%d","config":%s}`, base, name, base+1, cfg)
}

func TestControlPostgresFoundation(t *testing.T) {
	db, schema, cleanup := setupIntegration(t)
	defer cleanup()
	ctx := context.Background()
	for _, u := range []struct{ name, role string }{{"op", "operator"}, {"view", "viewer"}} {
		pw := []byte("integration-password-12")
		hash, e := bcrypt.GenerateFromPassword(pw, bcrypt.DefaultCost)
		if e != nil {
			t.Fatal(e)
		}
		if _, e = db.Exec(ctx, `INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,$4)`, uuid(), u.name, string(hash), u.role); e != nil {
			t.Fatal("seed user")
		}
	}
	h := New(db, Config{PublicOrigin: testOrigin, CookieSecure: false}).Handler()
	unauth := httptest.NewRecorder()
	h.ServeHTTP(unauth, httptest.NewRequest("GET", "/api/v1/profiles", nil))
	if unauth.Code != 401 {
		t.Fatalf("anonymous profile read=%d", unauth.Code)
	}
	viewer := &testAPI{t: t, h: h}
	viewer.login("view", "integration-password-12")
	vw := viewer.request("POST", "/api/v1/profiles", profileJSON("forbidden", 0), true, true)
	if vw.Code != 403 {
		t.Fatalf("viewer write=%d body=%s", vw.Code, vw.Body.String())
	}
	op := &testAPI{t: t, h: h}
	op.login("op", "integration-password-12")
	badCSRF := httptest.NewRecorder()
	rq := httptest.NewRequest("POST", "/api/v1/traps", strings.NewReader(`{"name":"x","deployment_bindings":[]}`))
	rq.Header.Set("Content-Type", "application/json")
	rq.AddCookie(&http.Cookie{Name: "hf_session", Value: op.cookie})
	h.ServeHTTP(badCSRF, rq)
	if badCSRF.Code != 403 {
		t.Fatalf("missing CSRF=%d", badCSRF.Code)
	}
	created := op.request("POST", "/api/v1/profiles", profileJSON("Shared medium", 0), true, true)
	if created.Code != 201 {
		t.Fatalf("create profile=%d %s", created.Code, created.Body.String())
	}
	var profileResp struct {
		Profile struct {
			ID string `json:"id"`
		} `json:"profile"`
		Revision contracts.ProfileRevision `json:"revision"`
	}
	if e := json.Unmarshal(created.Body.Bytes(), &profileResp); e != nil {
		t.Fatal(e)
	}
	pid := profileResp.Profile.ID
	if strings.Contains(created.Body.String(), "lab-credential-secret") {
		t.Fatal("profile creation leaked synthetic password")
	}
	trapIDs := make([]string, 2)
	for i := range trapIDs {
		tw := op.request("POST", "/api/v1/traps", fmt.Sprintf(`{"name":"trap-%d","deployment_bindings":[{"service_id":"web","host_port":%d}]}`, i, 18080+i), true, true)
		if tw.Code != 201 {
			t.Fatalf("create trap=%d %s", tw.Code, tw.Body.String())
		}
		var v contracts.Trap
		if e := json.Unmarshal(tw.Body.Bytes(), &v); e != nil {
			t.Fatal(e)
		}
		trapIDs[i] = v.ID
		aw := op.request("PUT", "/api/v1/traps/"+v.ID+"/profile", fmt.Sprintf(`{"profile_id":%q,"revision":1}`, pid), true, true)
		if aw.Code != 200 {
			t.Fatalf("assign shared profile=%d %s", aw.Code, aw.Body.String())
		}
		var assigned contracts.Trap
		_ = json.Unmarshal(aw.Body.Bytes(), &assigned)
		if assigned.AppliedRevision != nil {
			t.Fatal("admin assignment fabricated applied revision")
		}
	}
	normal := op.request("GET", "/api/v1/profiles/"+pid, "", false, true)
	if normal.Code != 200 || strings.Contains(normal.Body.String(), "lab-credential-secret") {
		t.Fatalf("normal profile read did not redact secret: %d", normal.Code)
	}
	sensitive := op.request("GET", fmt.Sprintf("/api/v1/profiles/%s/revisions/1/sensitive", pid), "", false, true)
	if sensitive.Code != 200 || !strings.Contains(sensitive.Body.String(), "lab-credential-secret") {
		t.Fatalf("sensitive read=%d", sensitive.Code)
	}
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			name := fmt.Sprintf("racer-%d", i)
			w := op.request("PATCH", "/api/v1/profiles/"+pid, profileJSON(name, 1), true, true)
			codes <- w.Code
		}(i)
	}
	wg.Wait()
	close(codes)
	success, conflict := 0, 0
	for c := range codes {
		if c == 200 {
			success++
		}
		if c == 409 {
			conflict++
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("stale revision race statuses: success=%d conflict=%d", success, conflict)
	}
	reassign := op.request("PUT", "/api/v1/traps/"+trapIDs[0]+"/profile", fmt.Sprintf(`{"profile_id":%q,"revision":2}`, pid), true, true)
	if reassign.Code != 200 {
		t.Fatalf("selective revision assignment=%d %s", reassign.Code, reassign.Body.String())
	}
	var first, second contracts.Trap
	_ = json.Unmarshal(reassign.Body.Bytes(), &first)
	readSecond := op.request("GET", "/api/v1/traps/"+trapIDs[1], "", false, true)
	_ = json.Unmarshal(readSecond.Body.Bytes(), &second)
	if first.DesiredRevision == nil || *first.DesiredRevision != 2 || second.DesiredRevision == nil || *second.DesiredRevision != 1 || first.AppliedRevision != nil || second.AppliedRevision != nil {
		t.Fatal("revision save changed unrelated or applied trap state")
	}
	trapPage := op.request("GET", "/api/v1/traps?limit=1", "", false, true)
	if trapPage.Code != 200 || !strings.Contains(trapPage.Body.String(), "next_cursor") {
		t.Fatalf("trap pagination=%d %s", trapPage.Code, trapPage.Body.String())
	}
	var page contracts.Page[contracts.Trap]
	_ = json.Unmarshal(trapPage.Body.Bytes(), &page)
	if len(page.Items) != 1 || page.NextCursor == "" {
		t.Fatal("expected one-item trap page with cursor")
	}
	next := op.request("GET", "/api/v1/traps?limit=1&cursor="+url.QueryEscape(page.NextCursor), "", false, true)
	if next.Code != 200 {
		t.Fatalf("next page=%d %s", next.Code, next.Body.String())
	}
	var lastPage contracts.Page[contracts.Trap]
	if err := json.Unmarshal(next.Body.Bytes(), &lastPage); err != nil {
		t.Fatal(err)
	}
	if len(lastPage.Items) != 1 || lastPage.Items[0].ID == page.Items[0].ID || lastPage.NextCursor != "" {
		t.Fatalf("unexpected final trap page: %#v", lastPage)
	}
	if badCursor := op.request("GET", "/api/v1/traps?cursor=", "", false, true); badCursor.Code != 400 {
		t.Fatalf("empty cursor status=%d", badCursor.Code)
	}
	assignedDelete := op.request("DELETE", "/api/v1/profiles/"+pid, "", true, true)
	if assignedDelete.Code != 409 {
		t.Fatalf("delete assigned profile=%d", assignedDelete.Code)
	}
	for _, id := range trapIDs {
		w := op.request("DELETE", "/api/v1/traps/"+id+"/profile", "", true, true)
		if w.Code != 200 {
			t.Fatalf("detach=%d %s", w.Code, w.Body.String())
		}
	}
	deleted := op.request("DELETE", "/api/v1/profiles/"+pid, "", true, true)
	if deleted.Code != 204 {
		t.Fatalf("logical delete=%d", deleted.Code)
	}
	history := op.request("GET", "/api/v1/profiles/"+pid+"/revisions", "", false, true)
	if history.Code != 200 || !strings.Contains(history.Body.String(), "\"revision\":2") {
		t.Fatalf("revision history after delete=%d %s", history.Code, history.Body.String())
	}
	newP := op.request("POST", "/api/v1/profiles", profileJSON("Agent profile", 0), true, true)
	var np struct {
		Profile struct {
			ID string `json:"id"`
		} `json:"profile"`
	}
	_ = json.Unmarshal(newP.Body.Bytes(), &np)
	newTrap := op.request("POST", "/api/v1/traps", `{"name":"agent-target","deployment_bindings":[{"service_id":"web","host_port":18090}]}`, true, true)
	var nt contracts.Trap
	_ = json.Unmarshal(newTrap.Body.Bytes(), &nt)
	assign := op.request("PUT", "/api/v1/traps/"+nt.ID+"/profile", fmt.Sprintf(`{"profile_id":%q,"revision":1}`, np.Profile.ID), true, true)
	if assign.Code != 200 {
		t.Fatalf("assign agent profile=%d %s", assign.Code, assign.Body.String())
	}
	enrollment := op.request("POST", "/api/v1/traps/"+nt.ID+"/enrollment-token", `{}`, true, true)
	if enrollment.Code != 201 {
		t.Fatalf("issue enrollment=%d %s", enrollment.Code, enrollment.Body.String())
	}
	var enrollmentResp struct {
		Token   string `json:"token"`
		AgentID string `json:"agent_id"`
	}
	_ = json.Unmarshal(enrollment.Body.Bytes(), &enrollmentResp)
	cross := httptest.NewRecorder()
	h.ServeHTTP(cross, httptest.NewRequest("POST", "/agent/v1/enroll", strings.NewReader(fmt.Sprintf(`{"trap_id":%q,"token":%q}`, trapIDs[0], enrollmentResp.Token))))
	if cross.Code != 401 {
		t.Fatalf("cross-trap enrollment=%d", cross.Code)
	}
	var enrollWG sync.WaitGroup
	enrollCodes := make(chan int, 2)
	agentTokens := make(chan string, 2)
	for i := 0; i < 2; i++ {
		enrollWG.Add(1)
		go func() {
			defer enrollWG.Done()
			res := httptest.NewRecorder()
			h.ServeHTTP(res, httptest.NewRequest("POST", "/agent/v1/enroll", strings.NewReader(fmt.Sprintf(`{"trap_id":%q,"token":%q}`, nt.ID, enrollmentResp.Token))))
			enrollCodes <- res.Code
			if res.Code == 201 {
				var data struct {
					AgentToken string `json:"agent_token"`
				}
				_ = json.Unmarshal(res.Body.Bytes(), &data)
				agentTokens <- data.AgentToken
			}
		}()
	}
	enrollWG.Wait()
	close(enrollCodes)
	close(agentTokens)
	createdAgents, invalidAttempts := 0, 0
	for code := range enrollCodes {
		if code == 201 {
			createdAgents++
		}
		if code == 401 {
			invalidAttempts++
		}
	}
	if createdAgents != 1 || invalidAttempts != 1 {
		t.Fatalf("concurrent enrollment statuses: created=%d rejected=%d", createdAgents, invalidAttempts)
	}
	agentToken := <-agentTokens
	replay := httptest.NewRecorder()
	h.ServeHTTP(replay, httptest.NewRequest("POST", "/agent/v1/enroll", strings.NewReader(fmt.Sprintf(`{"trap_id":%q,"token":%q}`, nt.ID, enrollmentResp.Token))))
	if replay.Code != 401 {
		t.Fatalf("enrollment replay=%d", replay.Code)
	}
	configReq := httptest.NewRequest("GET", "/agent/v1/traps/"+nt.ID+"/config", nil)
	configReq.Header.Set("Authorization", "Bearer "+agentToken)
	configRes := httptest.NewRecorder()
	h.ServeHTTP(configRes, configReq)
	if configRes.Code != 200 || !strings.Contains(configRes.Body.String(), "lab-credential-secret") {
		t.Fatalf("agent config=%d %s", configRes.Code, configRes.Body.String())
	}
	heartbeatReq := httptest.NewRequest("POST", "/agent/v1/traps/"+nt.ID+"/heartbeat", strings.NewReader(`{"service_state":"running"}`))
	heartbeatReq.Header.Set("Authorization", "Bearer "+agentToken)
	heartbeatReq.Header.Set("Content-Type", "application/json")
	heartbeatRes := httptest.NewRecorder()
	h.ServeHTTP(heartbeatRes, heartbeatReq)
	if heartbeatRes.Code != 200 || !strings.Contains(heartbeatRes.Body.String(), `"agent_status":"online"`) || !strings.Contains(heartbeatRes.Body.String(), `"service_status":"running"`) {
		t.Fatalf("agent heartbeat=%d %s", heartbeatRes.Code, heartbeatRes.Body.String())
	}
	if _, err := db.Exec(ctx, `UPDATE agents SET revoked_at=now() WHERE id=$1`, enrollmentResp.AgentID); err != nil {
		t.Fatal("revoke heartbeat fixture", err)
	}
	revokedHeartbeatReq := httptest.NewRequest("POST", "/agent/v1/traps/"+nt.ID+"/heartbeat", strings.NewReader(`{"service_state":"running"}`))
	revokedHeartbeatReq.Header.Set("Authorization", "Bearer "+agentToken)
	revokedHeartbeatReq.Header.Set("Content-Type", "application/json")
	revokedHeartbeatRes := httptest.NewRecorder()
	h.ServeHTTP(revokedHeartbeatRes, revokedHeartbeatReq)
	if revokedHeartbeatRes.Code != 401 {
		t.Fatalf("revoked agent heartbeat=%d", revokedHeartbeatRes.Code)
	}
	if _, err := db.Exec(ctx, `UPDATE agents SET revoked_at=NULL WHERE id=$1`, enrollmentResp.AgentID); err != nil {
		t.Fatal("restore heartbeat fixture", err)
	}
	wrongBearer := httptest.NewRecorder()
	rawReq := httptest.NewRequest("GET", "/agent/v1/traps/"+nt.ID+"/config", nil)
	rawReq.Header.Set("Authorization", agentToken)
	h.ServeHTTP(wrongBearer, rawReq)
	if wrongBearer.Code != 401 {
		t.Fatalf("raw token accepted=%d", wrongBearer.Code)
	}
	otherTrapConfig := httptest.NewRecorder()
	otherReq := httptest.NewRequest("GET", "/agent/v1/traps/"+trapIDs[0]+"/config", nil)
	otherReq.Header.Set("Authorization", "Bearer "+agentToken)
	h.ServeHTTP(otherTrapConfig, otherReq)
	if otherTrapConfig.Code != 401 {
		t.Fatalf("agent token crossed trap scope=%d", otherTrapConfig.Code)
	}
	reqCommand := op.request("POST", "/api/v1/traps/"+nt.ID+"/commands", fmt.Sprintf(`{"type":"apply_profile","expected_profile_id":%q,"expected_revision":1,"ttl_seconds":60}`, np.Profile.ID), true, true)
	if reqCommand.Code != 201 || !strings.Contains(reqCommand.Body.String(), `"status":"queued"`) {
		t.Fatalf("command queue=%d %s", reqCommand.Code, reqCommand.Body.String())
	}
	var command struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(reqCommand.Body.Bytes(), &command)
	_, err := db.Exec(ctx, `UPDATE commands SET expires_at=now()-interval '1 second' WHERE id=$1`, command.ID)
	if err != nil {
		t.Fatal("expire command fixture")
	}
	commands := op.request("GET", "/api/v1/traps/"+nt.ID+"/commands", "", false, true)
	if commands.Code != 200 || !strings.Contains(commands.Body.String(), `"status":"expired"`) {
		t.Fatalf("command lazy expiry=%d %s", commands.Code, commands.Body.String())
	}
	filteredCommands := op.request("GET", "/api/v1/traps/"+nt.ID+"/commands?status=expired", "", false, true)
	if filteredCommands.Code != 200 || !strings.Contains(filteredCommands.Body.String(), command.ID) {
		t.Fatalf("command status filter=%d %s", filteredCommands.Code, filteredCommands.Body.String())
	}
	_, err = db.Exec(ctx, `UPDATE traps SET last_seen=now()-interval '21 seconds',agent_status='online' WHERE id=$1`, nt.ID)
	if err != nil {
		t.Fatal("age agent fixture")
	}
	offline := op.request("GET", "/api/v1/traps/"+nt.ID, "", false, true)
	var offlineTrap contracts.Trap
	_ = json.Unmarshal(offline.Body.Bytes(), &offlineTrap)
	if offlineTrap.AgentStatus != "offline" {
		t.Fatalf("stale agent status=%q", offlineTrap.AgentStatus)
	}
	offlineList := op.request("GET", "/api/v1/traps?status=offline", "", false, true)
	if offlineList.Code != 200 || !strings.Contains(offlineList.Body.String(), nt.ID) {
		t.Fatalf("offline status filter=%d %s", offlineList.Code, offlineList.Body.String())
	}
	audit := op.request("GET", "/api/v1/audit?limit=100", "", false, true)
	if audit.Code != 200 {
		t.Fatalf("audit read=%d %s", audit.Code, audit.Body.String())
	}
	if strings.Contains(audit.Body.String(), "lab-credential-secret") {
		t.Fatal("audit leaked synthetic password")
	}
	for _, secret := range []string{op.cookie, op.csrf, enrollmentResp.Token, agentToken} {
		if secret != "" && strings.Contains(audit.Body.String(), secret) {
			t.Fatal("audit leaked an authentication or enrollment token")
		}
	}
	for _, action := range []string{"auth.login", "profile.created", "profile.revision_created", "trap.profile_assigned", "agent.enrollment_issued", "agent.enrolled", "command.queued", "profile.sensitive_read"} {
		if !strings.Contains(audit.Body.String(), action) {
			t.Fatalf("audit missing %s", action)
		}
	}
	firstAuditPage := op.request("GET", "/api/v1/audit?limit=3", "", false, true)
	var auditPage contracts.Page[contracts.AuditEntry]
	_ = json.Unmarshal(firstAuditPage.Body.Bytes(), &auditPage)
	auditIDs := map[string]bool{}
	for _, item := range auditPage.Items {
		auditIDs[item.ID] = true
	}
	cursor := auditPage.NextCursor
	for pages := 0; cursor != "" && pages < 30; pages++ {
		pageResp := op.request("GET", "/api/v1/audit?limit=7&cursor="+url.QueryEscape(cursor), "", false, true)
		if pageResp.Code != 200 {
			t.Fatalf("audit cursor page=%d %s", pageResp.Code, pageResp.Body.String())
		}
		var nextPage contracts.Page[contracts.AuditEntry]
		_ = json.Unmarshal(pageResp.Body.Bytes(), &nextPage)
		for _, item := range nextPage.Items {
			if auditIDs[item.ID] {
				t.Fatalf("audit pagination repeated %s", item.ID)
			}
			auditIDs[item.ID] = true
		}
		cursor = nextPage.NextCursor
	}
	if cursor != "" || len(auditIDs) < 8 {
		t.Fatalf("audit pagination incomplete, count=%d cursor=%s", len(auditIDs), cursor)
	}
	for _, path := range []string{"/api/v1/audit", "/api/v1/profiles/" + pid + "/revisions/1/sensitive", "/api/v1/traps/" + nt.ID + "/commands", "/api/v1/traps/" + nt.ID + "/enrollment-token"} {
		method := "GET"
		body := ""
		if strings.Contains(path, "commands") || strings.Contains(path, "enrollment-token") {
			method = "POST"
			body = `{"type":"start","expected_profile_id":"` + np.Profile.ID + `","expected_revision":1,"ttl_seconds":60}`
		}
		denied := viewer.request(method, path, body, true, true)
		if denied.Code != 403 {
			t.Fatalf("viewer should not access %s: %d %s", path, denied.Code, denied.Body.String())
		}
	}
	expiredIssue := op.request("POST", "/api/v1/traps/"+trapIDs[0]+"/enrollment-token", `{}`, true, true)
	var expiredToken struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(expiredIssue.Body.Bytes(), &expiredToken)
	_, err = db.Exec(ctx, `UPDATE enrollment_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1`, tokenHash(expiredToken.Token))
	if err != nil {
		t.Fatal("expire enrollment fixture")
	}
	expiredEnrollment := httptest.NewRecorder()
	h.ServeHTTP(expiredEnrollment, httptest.NewRequest("POST", "/agent/v1/enroll", strings.NewReader(fmt.Sprintf(`{"trap_id":%q,"token":%q}`, trapIDs[0], expiredToken.Token))))
	if expiredEnrollment.Code != 401 {
		t.Fatalf("expired enrollment=%d", expiredEnrollment.Code)
	}
	viewerRead := viewer.request("GET", "/api/v1/profiles?limit=5", "", false, true)
	if viewerRead.Code != 200 {
		t.Fatalf("viewer read=%d", viewerRead.Code)
	}
	noCSRFLogout := httptest.NewRecorder()
	logoutReq := httptest.NewRequest("POST", "/api/v1/auth/logout", strings.NewReader(`{}`))
	logoutReq.Header.Set("Content-Type", "application/json")
	logoutReq.AddCookie(&http.Cookie{Name: "hf_session", Value: op.cookie})
	h.ServeHTTP(noCSRFLogout, logoutReq)
	if noCSRFLogout.Code != 403 {
		t.Fatalf("logout without CSRF=%d", noCSRFLogout.Code)
	}
	logout := op.request("POST", "/api/v1/auth/logout", `{}`, true, true)
	if logout.Code != 204 {
		t.Fatalf("logout=%d %s", logout.Code, logout.Body.String())
	}
	postLogout := op.request("GET", "/api/v1/auth/me", "", false, true)
	if postLogout.Code != 401 {
		t.Fatalf("session remained valid after logout=%d", postLogout.Code)
	}
	expiredSession := &testAPI{t: t, h: h}
	expiredSession.login("view", "integration-password-12")
	_, err = db.Exec(ctx, `UPDATE operator_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1`, tokenHash(expiredSession.cookie))
	if err != nil {
		t.Fatal("expire session fixture")
	}
	if w := expiredSession.request("GET", "/api/v1/auth/me", "", false, true); w.Code != 401 {
		t.Fatalf("expired operator session=%d", w.Code)
	}
	secondCfg, err := pgxpool.ParseConfig(os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal("parse second test pool")
	}
	secondCfg.ConnConfig.RuntimeParams["search_path"] = schema
	secondPool, err := pgxpool.NewWithConfig(ctx, secondCfg)
	if err != nil {
		t.Fatal("open second pool")
	}
	defer secondPool.Close()
	if err = secondPool.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = secondPool.QueryRow(ctx, `SELECT count(*) FROM profiles`).Scan(&count); err != nil || count < 2 {
		t.Fatalf("data did not persist to new pool: count=%d err=%v", count, err)
	}
}

func TestProfileValidatorRejectsUnsafePathsAndUnsupportedProtocol(t *testing.T) {
	c := profileConfig()
	c.FakeFS = []contracts.FakeFile{{Path: "C:/Windows/file.txt", Content: "x"}}
	if len(contracts.ValidateProfile(c)) == 0 {
		t.Fatal("drive-prefixed path accepted")
	}
	c = profileConfig()
	c.Services[0].Protocol = "ssh"
	if len(contracts.ValidateProfile(c)) == 0 {
		t.Fatal("unsupported service protocol accepted")
	}
}
