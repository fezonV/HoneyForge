package decoy

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"honeyforge/internal/contracts"
)

const trapID = "11111111-1111-4111-8111-111111111111"
const profileID = "22222222-2222-4222-8222-222222222222"

type memorySink struct {
	mu     sync.Mutex
	events []contracts.Event
	err    error
}

func (s *memorySink) Submit(_ context.Context, e contracts.Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return s.err
	}
	s.events = append(s.events, e)
	return nil
}

func testConfig(level string) Configuration {
	templateID := "low-http"
	categories := []string{"http.request"}
	creds := []contracts.SyntheticCredential(nil)
	if level == "medium" {
		templateID = "medium-http"
		categories = []string{"http.request", "auth.attempt", "session.started", "file.listed", "file.read", "file.downloaded", "session.ended"}
		creds = []contracts.SyntheticCredential{{Username: "demo", Password: "synthetic-secret"}}
	}
	return Configuration{TrapID: trapID, ProfileID: profileID, Revision: 1, Config: contracts.ProfileConfig{TemplateID: templateID, Level: level, Services: []contracts.Service{{ID: "web", Name: "Web", Protocol: "http", Port: 8080, Banner: "test"}}, VisibleTexts: contracts.VisibleTexts{Title: "Test", LoginPrompt: "Sign in", Failure: "Denied"}, SyntheticCredentials: creds, FakeFS: []contracts.FakeFile{{Path: "reports/summary.txt", Content: "synthetic report"}}, Logging: contracts.Logging{Categories: categories}, Channel: contracts.Channel{TLSRequired: true, HeartbeatSeconds: 10, SyncSeconds: 2}}}
}

func serve(t *testing.T, server *Server, path string, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if body != "" {
		req = httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	server.PublicHandler("web").ServeHTTP(w, req)
	return w
}

func TestLowPageAndStop(t *testing.T) {
	sink := &memorySink{}
	server, err := New(testConfig("low"), sink)
	if err != nil {
		t.Fatal(err)
	}
	server.SetRunning(true)
	if got := serve(t, server, "/", "", nil); got.Code != 200 || !strings.Contains(got.Body.String(), "test") {
		t.Fatalf("root: %d %s", got.Code, got.Body.String())
	}
	server.SetRunning(false)
	if got := serve(t, server, "/", "", nil); got.Code != 503 {
		t.Fatalf("stopped request status=%d", got.Code)
	}
}

func TestMediumAuthFakeFSConsoleAndSessionIsolation(t *testing.T) {
	sink := &memorySink{}
	server, err := New(testConfig("medium"), sink)
	if err != nil {
		t.Fatal(err)
	}
	server.SetRunning(true)
	bad := serve(t, server, "/login", "username=demo&password=incorrect", nil)
	if bad.Code != 401 {
		t.Fatalf("bad login=%d", bad.Code)
	}
	login := serve(t, server, "/login", "username=demo&password=synthetic-secret", nil)
	if login.Code != 303 {
		t.Fatalf("login=%d %s", login.Code, login.Body.String())
	}
	cookies := login.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatal("session cookie missing")
	}
	cookie := cookies[0]
	files := serve(t, server, "/files?path=reports/summary.txt", "", cookie)
	if files.Code != 200 || files.Body.String() != "synthetic report" {
		t.Fatalf("fake file: %d %q", files.Code, files.Body.String())
	}
	for _, path := range []string{"../../etc/passwd", "%2e%2e%2fetc%2fpasswd", "%252e%252e%252fetc%252fpasswd", `..\\etc\\passwd`} {
		traversal := serve(t, server, "/files?path="+path, "", cookie)
		if traversal.Code != 404 {
			t.Fatalf("traversal path %q status=%d", path, traversal.Code)
		}
	}
	cmd := serve(t, server, "/console", "command=pwd", cookie)
	if cmd.Code != 200 || cmd.Body.String() != "/" {
		t.Fatalf("pwd: %d %q", cmd.Code, cmd.Body.String())
	}
	denied := serve(t, server, "/console", "command=whoami", cookie)
	if strings.Contains(strings.ToLower(denied.Body.String()), "root") {
		t.Fatalf("host command appeared to execute: %q", denied.Body.String())
	}
	other, _ := New(testConfig("medium"), sink)
	other.SetRunning(true)
	if got := serve(t, other, "/files", "", cookie); got.Code != 401 {
		t.Fatalf("session leaked across instances: %d", got.Code)
	}
	if len(sink.events) < 6 {
		t.Fatalf("expected telemetry for requests; got %d events", len(sink.events))
	}
	for _, event := range sink.events {
		if event.TrapID != trapID || event.ProfileID != profileID || event.AppliedRevision == nil || *event.AppliedRevision != 1 {
			t.Fatalf("missing event identity: %+v", event)
		}
	}
}

func TestTelemetryFailureBlocksVisitorAction(t *testing.T) {
	sink := &memorySink{err: errors.New("queue unavailable")}
	server, err := New(testConfig("low"), sink)
	if err != nil {
		t.Fatal(err)
	}
	server.SetRunning(true)
	if got := serve(t, server, "/", "", nil); got.Code != 503 {
		t.Fatalf("request proceeded without durable telemetry: %d", got.Code)
	}
}

func TestApplyInvalidatesSessionsAndKeepsListenersFixed(t *testing.T) {
	sink := &memorySink{}
	server, err := New(testConfig("medium"), sink)
	if err != nil {
		t.Fatal(err)
	}
	server.SetRunning(true)
	login := serve(t, server, "/login", "username=demo&password=synthetic-secret", nil)
	cookie := login.Result().Cookies()[0]
	next := testConfig("medium")
	next.Revision = 2
	next.Config.VisibleTexts.Title = "Updated"
	if err := server.Apply(next); err != nil {
		t.Fatal(err)
	}
	if got := serve(t, server, "/files", "", cookie); got.Code != 401 {
		t.Fatalf("old session survived config apply: %d", got.Code)
	}
	changed := testConfig("medium")
	changed.Config.Services[0].Port++
	if err := server.Apply(changed); err == nil {
		t.Fatal("listener change should require restart")
	}
}

func TestAdminHandlerRequiresToken(t *testing.T) {
	server, err := New(testConfig("low"), &memorySink{})
	if err != nil {
		t.Fatal(err)
	}
	handler := server.AdminHandler("secret")
	for _, auth := range []string{"", "Bearer wrong"} {
		req := httptest.NewRequest(http.MethodPost, "/internal/start", nil)
		req.Header.Set("Authorization", auth)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != 401 {
			t.Fatalf("auth %q status %d", auth, w.Code)
		}
	}
}

func TestHandlerNeverReturnsSyntheticPasswordInResponse(t *testing.T) {
	sink := &memorySink{}
	server, err := New(testConfig("medium"), sink)
	if err != nil {
		t.Fatal(err)
	}
	server.SetRunning(true)
	w := serve(t, server, "/login", "username=demo&password=synthetic-secret", nil)
	if strings.Contains(w.Body.String(), "synthetic-secret") {
		t.Fatal("synthetic password was included in response")
	}
	for _, event := range sink.events {
		if event.EventType == "auth.attempt" && event.Payload["credential_attempt"] != "synthetic-secret" {
			t.Fatalf("credential attempt was not logged to authorized telemetry: %+v", event.Payload)
		}
	}
}

func TestFakeFileRejectsEncodedAndAbsoluteHostPaths(t *testing.T) {
	files := []contracts.FakeFile{{Path: "reports/summary.txt", Content: "only synthetic"}}
	for _, path := range []string{"../../etc/passwd", `C:\\Windows\\win.ini`, "reports%2f..%2f..%2fsecret", "/etc/passwd"} {
		if _, ok := fakeFile(files, path); ok {
			t.Fatalf("unsafe/unmapped path matched fake file: %q", path)
		}
	}
}
