package control

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"honeyforge/internal/agent"
	"honeyforge/internal/contracts"
	"honeyforge/internal/decoy"
)

func TestBE03AgentEventsMaintainVisitorSessions(t *testing.T) {
	db, _, cleanup := setupIntegration(t)
	defer cleanup()
	ctx := context.Background()

	profileID, trapOne, trapTwo := uuid(), uuid(), uuid()
	agentOne, agentTwo := uuid(), uuid()
	tokenOne, tokenTwo := "be03-agent-token-one", "be03-agent-token-two"
	tx, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `INSERT INTO profiles(id,name,current_revision) VALUES($1,'BE-03 integration profile',1)`, profileID); err != nil {
		t.Fatal("seed profile", err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO profile_revisions(profile_id,revision,config) VALUES($1,1,'{}')`, profileID); err != nil {
		t.Fatal("seed profile revision", err)
	}
	for _, trapID := range []string{trapOne, trapTwo} {
		if _, err = tx.Exec(ctx, `INSERT INTO traps(id,name,desired_profile_id,desired_revision,deployment_bindings) VALUES($1,$2,$3,1,'[]')`, trapID, "BE-03 trap", profileID); err != nil {
			t.Fatal("seed trap", err)
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO agents(id,trap_id,token_hash) VALUES($1,$2,$3),($4,$5,$6)`, agentOne, trapOne, tokenHash(tokenOne), agentTwo, trapTwo, tokenHash(tokenTwo)); err != nil {
		t.Fatal("seed agents", err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal("commit fixtures", err)
	}

	h := New(db, Config{PublicOrigin: testOrigin}).Handler()
	sessionID := uuid()
	events := []contracts.Event{
		be03Event(uuid(), trapOne, agentOne, profileID, sessionID, 1, "session.started", "2026-10-14T10:00:00Z"),
		be03Event(uuid(), trapOne, agentOne, profileID, sessionID, 1, "file.read", "2026-10-14T10:01:00Z"),
		be03Event(uuid(), trapOne, agentOne, profileID, sessionID, 1, "command.received", "2026-10-14T10:02:00Z"),
		be03Event(uuid(), trapOne, agentOne, profileID, sessionID, 1, "session.ended", "2026-10-14T10:03:00Z"),
	}
	post := func(trapID, token string, batch []contracts.Event) *httptest.ResponseRecorder {
		t.Helper()
		body, marshalErr := json.Marshal(map[string]any{"events": batch})
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		req := httptest.NewRequest(http.MethodPost, "/agent/v1/traps/"+trapID+"/events", strings.NewReader(string(body)))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		h.ServeHTTP(res, req)
		return res
	}
	if res := post(trapOne, tokenOne, events); res.Code != http.StatusOK {
		t.Fatalf("ingest session batch=%d %s", res.Code, res.Body.String())
	}
	if res := post(trapOne, tokenOne, events); res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "duplicate_ids") {
		t.Fatalf("repeat session batch=%d %s", res.Code, res.Body.String())
	}
	conflictingReplay := events[0]
	conflictingReplay.SessionID = uuid()
	conflictingReplay.Timestamp = "2026-10-14T09:00:00Z"
	if res := post(trapOne, tokenOne, []contracts.Event{conflictingReplay}); res.Code != http.StatusConflict {
		t.Fatalf("replay with changed session/time=%d %s", res.Code, res.Body.String())
	}
	var rogueSessionCount int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM visitor_sessions WHERE id=$1`, conflictingReplay.SessionID).Scan(&rogueSessionCount); err != nil || rogueSessionCount != 0 {
		t.Fatalf("conflicting replay left a session behind: count=%d err=%v", rogueSessionCount, err)
	}
	var started time.Time
	var ended *time.Time
	var linkedEvents int
	err = db.QueryRow(ctx, `SELECT started_at,ended_at,(SELECT count(*) FROM events WHERE session_id=$1) FROM visitor_sessions WHERE id=$1 AND trap_id=$2`, sessionID, trapOne).Scan(&started, &ended, &linkedEvents)
	if err != nil {
		t.Fatal("read persisted session", err)
	}
	if started.UTC().Format(time.RFC3339) != "2026-10-14T10:00:00Z" || ended == nil || ended.UTC().Format(time.RFC3339) != "2026-10-14T10:03:00Z" || linkedEvents != len(events) {
		t.Fatalf("session state started=%v ended=%v linked_events=%d", started, ended, linkedEvents)
	}

	outOfOrderSession := uuid()
	endFirst := be03Event(uuid(), trapOne, agentOne, profileID, outOfOrderSession, 1, "session.ended", "2026-10-14T10:03:00Z")
	startLater := be03Event(uuid(), trapOne, agentOne, profileID, outOfOrderSession, 1, "session.started", "2026-10-14T10:00:00Z")
	if res := post(trapOne, tokenOne, []contracts.Event{endFirst, startLater}); res.Code != http.StatusOK {
		t.Fatalf("ingest out-of-order lifecycle=%d %s", res.Code, res.Body.String())
	}
	if res := post(trapOne, tokenOne, []contracts.Event{startLater}); res.Code != http.StatusOK || !strings.Contains(res.Body.String(), "duplicate_ids") {
		t.Fatalf("replay out-of-order session start=%d %s", res.Code, res.Body.String())
	}
	var outOfOrderStarted time.Time
	var outOfOrderEnded *time.Time
	err = db.QueryRow(ctx, `SELECT started_at,ended_at FROM visitor_sessions WHERE id=$1 AND trap_id=$2`, outOfOrderSession, trapOne).Scan(&outOfOrderStarted, &outOfOrderEnded)
	if err != nil || outOfOrderEnded == nil || outOfOrderStarted.UTC().Format(time.RFC3339) != "2026-10-14T10:00:00Z" || outOfOrderEnded.UTC().Format(time.RFC3339) != "2026-10-14T10:03:00Z" {
		t.Fatalf("out-of-order session started=%v ended=%v err=%v", outOfOrderStarted, outOfOrderEnded, err)
	}

	collision := be03Event(uuid(), trapTwo, agentTwo, profileID, sessionID, 1, "session.started", "2026-10-14T09:00:00Z")
	if res := post(trapTwo, tokenTwo, []contracts.Event{collision}); res.Code != http.StatusConflict {
		t.Fatalf("cross-trap session collision=%d %s", res.Code, res.Body.String())
	}
	var collisionEvents int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM events WHERE id=$1`, collision.EventID).Scan(&collisionEvents); err != nil {
		t.Fatal(err)
	}
	if collisionEvents != 0 {
		t.Fatalf("cross-trap collision inserted event count=%d", collisionEvents)
	}
	atomicSession := uuid()
	beforeCollision := be03Event(uuid(), trapTwo, agentTwo, profileID, atomicSession, 1, "file.read", "2026-10-14T09:00:00Z")
	batchCollision := be03Event(uuid(), trapTwo, agentTwo, profileID, sessionID, 1, "session.started", "2026-10-14T09:01:00Z")
	if res := post(trapTwo, tokenTwo, []contracts.Event{beforeCollision, batchCollision}); res.Code != http.StatusConflict {
		t.Fatalf("cross-trap collision in a batch=%d %s", res.Code, res.Body.String())
	}
	var rolledBackEvents, rolledBackSessions int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM events WHERE id=$1`, beforeCollision.EventID).Scan(&rolledBackEvents); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRow(ctx, `SELECT count(*) FROM visitor_sessions WHERE id=$1 AND trap_id=$2`, atomicSession, trapTwo).Scan(&rolledBackSessions); err != nil {
		t.Fatal(err)
	}
	if rolledBackEvents != 0 || rolledBackSessions != 0 {
		t.Fatalf("batch collision was not atomic: event_count=%d session_count=%d", rolledBackEvents, rolledBackSessions)
	}
	var owner string
	if err = db.QueryRow(ctx, `SELECT trap_id::text FROM visitor_sessions WHERE id=$1`, sessionID).Scan(&owner); err != nil || owner != trapOne {
		t.Fatalf("session owner=%q err=%v", owner, err)
	}
}

func TestBE03DecoyTelemetryKeepsActuallyAppliedProfile(t *testing.T) {
	db, _, cleanup := setupIntegration(t)
	defer cleanup()
	ctx := context.Background()
	profileID, trapID, secondTrapID := uuid(), uuid(), uuid()
	agentID, secondAgentID := uuid(), uuid()
	centerToken, secondCenterToken := "be03-e2e-agent", "be03-e2e-agent-two"
	trapState := &agent.State{AgentID: agentID, TrapID: trapID, Token: centerToken}
	secondState := &agent.State{AgentID: secondAgentID, TrapID: secondTrapID, Token: secondCenterToken}

	profileOne := profileConfig()
	profileTwo := profileConfig()
	profileTwo.SyntheticCredentials = []contracts.SyntheticCredential{{Username: "next", Password: "next-secret"}}
	profileTwo.FakeFS[0].Content = "revision two report"
	profileTwo.Services[0].Banner = "Revision two banner"
	profileOneJSON, _ := json.Marshal(profileOne)
	profileTwoJSON, _ := json.Marshal(profileTwo)
	tx, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `INSERT INTO profiles(id,name,current_revision) VALUES($1,'BE-03 end-to-end profile',2)`, profileID); err != nil {
		t.Fatal("seed profile", err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO profile_revisions(profile_id,revision,config) VALUES($1,1,$2),( $1,2,$3)`, profileID, profileOneJSON, profileTwoJSON); err != nil {
		t.Fatal("seed profile revisions", err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO traps(id,name,desired_profile_id,desired_revision,deployment_bindings) VALUES($1,'BE-03 medium trap',$3,2,'[{"service_id":"web","host_port":8080}]'),($2,'BE-03 low trap',$3,1,'[{"service_id":"web","host_port":8081}]')`, trapID, secondTrapID, profileID); err != nil {
		t.Fatal("seed traps", err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO agents(id,trap_id,token_hash) VALUES($1,$2,$3),($4,$5,$6)`, agentID, trapID, tokenHash(centerToken), secondAgentID, secondTrapID, tokenHash(secondCenterToken)); err != nil {
		t.Fatal("seed agents", err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal("commit fixtures", err)
	}

	queueOne, err := agent.OpenQueue(filepath.Join(t.TempDir(), "medium-events.sqlite"), 100)
	if err != nil {
		t.Fatal("open medium queue", err)
	}
	defer queueOne.Close()
	queueTwo, err := agent.OpenQueue(filepath.Join(t.TempDir(), "low-events.sqlite"), 100)
	if err != nil {
		t.Fatal("open low queue", err)
	}
	defer queueTwo.Close()
	const ipcToken = "be03-e2e-ipc-secret"
	mediumIPC := httptest.NewServer(agent.IPCHandler(queueOne, trapState, ipcToken))
	defer mediumIPC.Close()
	lowIPC := httptest.NewServer(agent.IPCHandler(queueTwo, secondState, ipcToken))
	defer lowIPC.Close()
	mediumSink, err := decoy.NewHTTPAgentSink(mediumIPC.URL, ipcToken)
	if err != nil {
		t.Fatal(err)
	}
	lowSink, err := decoy.NewHTTPAgentSink(lowIPC.URL, ipcToken)
	if err != nil {
		t.Fatal(err)
	}
	mediumRuntime, err := decoy.New(decoy.Configuration{TrapID: trapID, ProfileID: profileID, Revision: 1, Config: profileOne}, mediumSink)
	if err != nil {
		t.Fatal("create medium decoy", err)
	}
	mediumRuntime.SetRunning(true)
	lowProfile := profileOne
	lowProfile.TemplateID, lowProfile.Level = "low-http", "low"
	lowProfile.SyntheticCredentials = nil
	lowProfile.Logging.Categories = []string{"http.request"}
	lowRuntime, err := decoy.New(decoy.Configuration{TrapID: secondTrapID, ProfileID: profileID, Revision: 1, Config: lowProfile}, lowSink)
	if err != nil {
		t.Fatal("create low decoy", err)
	}
	lowRuntime.SetRunning(true)
	mediumAdmin := httptest.NewServer(mediumRuntime.AdminHandler("decoy-admin-token"))
	defer mediumAdmin.Close()
	mediumAdminAdapter, err := agent.NewHTTPDecoyAdapter(mediumAdmin.URL, "decoy-admin-token")
	if err != nil {
		t.Fatal(err)
	}
	mediumPublic := httptest.NewServer(mediumRuntime.PublicHandler("web"))
	defer mediumPublic.Close()
	lowPublic := httptest.NewServer(lowRuntime.PublicHandler("web"))
	defer lowPublic.Close()

	// The agent already knows desired revision 2, while this decoy is still serving revision 1.
	trapState.SetConfig(&agent.ConfigResponse{TrapID: trapID, ProfileID: profileID, Revision: 2, Config: profileTwo})
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	mediumClient := &http.Client{Jar: jar, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	loginPage, err := mediumClient.Get(mediumPublic.URL + "/login")
	if err != nil {
		t.Fatal("open medium login page", err)
	}
	loginPage.Body.Close()
	loginBody := url.Values{"username": {"demo"}, "password": {"lab-credential-secret"}}
	loginResponse, err := mediumClient.PostForm(mediumPublic.URL+"/login", loginBody)
	if err != nil {
		t.Fatal("login to medium decoy", err)
	}
	loginResponse.Body.Close()
	if loginResponse.StatusCode != http.StatusSeeOther {
		t.Fatalf("medium login status=%d", loginResponse.StatusCode)
	}
	mediumCookies := loginResponse.Cookies()
	if len(mediumCookies) == 0 {
		t.Fatal("medium session cookie was not set")
	}
	files, err := mediumClient.Get(mediumPublic.URL + "/files?path=reports/summary.txt")
	if err != nil {
		t.Fatal("read medium fake file", err)
	}
	fileBody, _ := io.ReadAll(files.Body)
	files.Body.Close()
	if files.StatusCode != http.StatusOK || !strings.Contains(string(fileBody), "synthetic report") {
		t.Fatalf("medium fake file response=%d %q", files.StatusCode, string(fileBody))
	}
	consoleBody := url.Values{"command": {"pwd"}}
	consoleResponse, err := mediumClient.PostForm(mediumPublic.URL+"/console", consoleBody)
	if err != nil {
		t.Fatal("use medium console", err)
	}
	consoleResponse.Body.Close()
	if consoleResponse.StatusCode != http.StatusOK {
		t.Fatalf("medium console status=%d", consoleResponse.StatusCode)
	}

	// A cookie from the medium decoy does not authenticate on another runtime.
	lowRequest, _ := http.NewRequest(http.MethodGet, lowPublic.URL+"/console", nil)
	lowRequest.AddCookie(mediumCookies[0])
	lowResponse, err := lowPublic.Client().Do(lowRequest)
	if err != nil {
		t.Fatal("send medium cookie to low decoy", err)
	}
	lowResponse.Body.Close()
	if lowResponse.StatusCode != http.StatusUnauthorized {
		t.Fatalf("medium cookie crossed decoy boundary: status=%d", lowResponse.StatusCode)
	}
	lowCatalog, err := lowPublic.Client().Get(lowPublic.URL + "/files")
	if err != nil {
		t.Fatal("read low catalogue", err)
	}
	lowCatalog.Body.Close()
	if lowCatalog.StatusCode != http.StatusOK {
		t.Fatalf("low catalogue status=%d", lowCatalog.StatusCode)
	}

	// Explicit apply advances the runtime; its next event must now report revision 2.
	if err = mediumAdminAdapter.ApplyConfiguration(ctx, agent.ConfigResponse{TrapID: trapID, ProfileID: profileID, Revision: 2, Config: profileTwo}); err != nil {
		t.Fatalf("apply profile revision 2: %v", err)
	}
	oldCookieRequest, _ := http.NewRequest(http.MethodGet, mediumPublic.URL+"/files", nil)
	oldCookieRequest.AddCookie(mediumCookies[0])
	oldCookieResponse, err := mediumPublic.Client().Do(oldCookieRequest)
	if err != nil {
		t.Fatal("reuse old session after apply", err)
	}
	oldCookieResponse.Body.Close()
	if oldCookieResponse.StatusCode != http.StatusUnauthorized {
		t.Fatalf("old session survived configuration apply: %d", oldCookieResponse.StatusCode)
	}
	newLoginResponse, err := mediumClient.PostForm(mediumPublic.URL+"/login", url.Values{"username": {"next"}, "password": {"next-secret"}})
	if err != nil {
		t.Fatal("login after config apply", err)
	}
	newLoginResponse.Body.Close()
	if newLoginResponse.StatusCode != http.StatusSeeOther {
		t.Fatalf("revision 2 login status=%d", newLoginResponse.StatusCode)
	}

	// Persist queued decoy events through the authenticated agent ingestion route.
	controlHandler := New(db, Config{PublicOrigin: testOrigin}).Handler()
	queued, err := queueOne.Batch(ctx, 100)
	if err != nil || len(queued) == 0 {
		t.Fatalf("read queued medium events: count=%d err=%v", len(queued), err)
	}
	events := make([]contracts.Event, 0, len(queued))
	for _, item := range queued {
		events = append(events, item.Event)
	}
	body, err := json.Marshal(map[string]any{"events": events})
	if err != nil {
		t.Fatal(err)
	}
	ingest := httptest.NewRequest(http.MethodPost, "/agent/v1/traps/"+trapID+"/events", strings.NewReader(string(body)))
	ingest.Header.Set("Authorization", "Bearer "+centerToken)
	ingest.Header.Set("Content-Type", "application/json")
	ingestResponse := httptest.NewRecorder()
	controlHandler.ServeHTTP(ingestResponse, ingest)
	if ingestResponse.Code != http.StatusOK {
		t.Fatalf("persist decoy telemetry=%d %s", ingestResponse.Code, ingestResponse.Body.String())
	}
	var eventCount, revOneCount, revTwoCount, sessionCount int
	if err = db.QueryRow(ctx, `SELECT count(*),count(*) FILTER (WHERE applied_revision=1),count(*) FILTER (WHERE applied_revision=2),count(DISTINCT session_id) FROM events WHERE trap_id=$1 AND profile_id=$2`, trapID, profileID).Scan(&eventCount, &revOneCount, &revTwoCount, &sessionCount); err != nil {
		t.Fatal(err)
	}
	if eventCount != len(events) || revOneCount == 0 || revTwoCount == 0 || sessionCount != 2 {
		t.Fatalf("persisted event revisions/count: events=%d want=%d rev1=%d rev2=%d sessions=%d", eventCount, len(events), revOneCount, revTwoCount, sessionCount)
	}
	var unlinked int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM events e LEFT JOIN visitor_sessions s ON s.id=e.session_id WHERE e.trap_id=$1 AND e.session_id IS NOT NULL AND s.id IS NULL`, trapID).Scan(&unlinked); err != nil || unlinked != 0 {
		t.Fatalf("events without persisted visitor session=%d err=%v", unlinked, err)
	}
}

func be03Event(eventID, trapID, agentID, profileID, sessionID string, revision int, eventType, timestamp string) contracts.Event {
	return contracts.Event{
		SchemaVersion: "1.0", EventID: eventID, TrapID: trapID, AgentID: agentID,
		ServiceID: "web", SessionID: sessionID, ProfileID: profileID, AppliedRevision: &revision,
		EventType: eventType, Timestamp: timestamp, Protocol: "http", Payload: map[string]any{"fixture": fmt.Sprint(eventType)},
	}
}
