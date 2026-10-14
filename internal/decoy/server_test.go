package decoy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"honeyforge/internal/contracts"
)

const trapID = "11111111-1111-4111-8111-111111111111"
const profileID = "22222222-2222-4222-8222-222222222222"

type memorySink struct {
	mu     sync.Mutex
	events []contracts.Event
	err    error
}

type gateSink struct {
	entered chan struct{}
	release chan struct{}
}

type testConfigurationStore struct {
	err   error
	calls int
}

func (s *testConfigurationStore) Save(Configuration) error {
	s.calls++
	return s.err
}

func (s *gateSink) Submit(ctx context.Context, event contracts.Event) error {
	if event.EventType == "auth.attempt" {
		close(s.entered)
		select {
		case <-s.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
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

func (s *memorySink) snapshot() []contracts.Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]contracts.Event(nil), s.events...)
}

type blockingSink struct {
	mu      sync.Mutex
	events  []contracts.Event
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (s *blockingSink) Submit(ctx context.Context, event contracts.Event) error {
	if event.EventType == "auth.attempt" {
		s.once.Do(func() { close(s.entered) })
		select {
		case <-s.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	s.mu.Lock()
	s.events = append(s.events, event)
	s.mu.Unlock()
	return nil
}

func (s *blockingSink) snapshot() []contracts.Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]contracts.Event(nil), s.events...)
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

func TestPublicResponsesDoNotExposeManagementMarkers(t *testing.T) {
	sink := &memorySink{}
	medium, err := New(testConfig("medium"), sink)
	if err != nil {
		t.Fatal(err)
	}
	medium.SetRunning(true)
	responses := []*httptest.ResponseRecorder{
		serve(t, medium, "/login", "", nil),
		serve(t, medium, "/login", "username=demo&password=wrong", nil),
		serve(t, medium, "/files", "", nil),
		serve(t, medium, "/console", "", nil),
		serve(t, medium, "/login", "username=demo&password=synthetic-secret", nil),
	}
	failedSink, err := New(testConfig("low"), &memorySink{err: errors.New("private sink details")})
	if err != nil {
		t.Fatal(err)
	}
	failedSink.SetRunning(true)
	responses = append(responses, serve(t, failedSink, "/", "", nil))
	for _, response := range responses {
		var visible strings.Builder
		visible.WriteString(response.Body.String())
		for name, values := range response.Header() {
			visible.WriteString(name)
			for _, value := range values {
				visible.WriteString(value)
			}
		}
		for _, cookie := range response.Result().Cookies() {
			visible.WriteString(cookie.Name)
			visible.WriteString(cookie.Value)
		}
		lower := strings.ToLower(visible.String())
		for _, marker := range []string{"decoy", "honeyforge", "agent", "ipc", "private sink details"} {
			if strings.Contains(lower, marker) {
				t.Fatalf("visitor response exposed %q: %q", marker, visible.String())
			}
		}
	}
	loginCookies := responses[4].Result().Cookies()
	if len(loginCookies) != 1 || loginCookies[0].Name != "archive_session" {
		t.Fatalf("login cookie should use a neutral name: %#v", loginCookies)
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

func TestSuccessfulLoginUsesOneSessionIDAcrossEvents(t *testing.T) {
	sink := &memorySink{}
	server, _ := New(testConfig("medium"), sink)
	server.SetRunning(true)
	login := serve(t, server, "/login", "username=demo&password=synthetic-secret", nil)
	if login.Code != http.StatusSeeOther {
		t.Fatalf("login status=%d", login.Code)
	}
	var authID, startedID string
	for _, event := range sink.events {
		switch event.EventType {
		case "auth.attempt":
			authID = event.SessionID
			if got, _ := event.Payload["sensitive_fields"].([]string); len(got) != 2 || got[0] != "username" || got[1] != "credential_attempt" {
				t.Fatalf("auth fields are not marked sensitive: %#v", event.Payload)
			}
		case "session.started":
			startedID = event.SessionID
		}
	}
	if authID == "" || authID != startedID {
		t.Fatalf("auth session id %q differs from started session id %q", authID, startedID)
	}
}

func TestBoundedLoginRejectsOversizeWithoutCookie(t *testing.T) {
	server, _ := New(testConfig("medium"), &memorySink{})
	server.SetRunning(true)
	w := serve(t, server, "/login", "username="+strings.Repeat("x", 17<<10), nil)
	if w.Code != http.StatusRequestEntityTooLarge || len(w.Result().Cookies()) != 0 {
		t.Fatalf("oversized login status=%d cookies=%v", w.Code, w.Result().Cookies())
	}
}

func TestConsoleLsOutputIsExactAndRejectsArguments(t *testing.T) {
	sink := &memorySink{}
	server, _ := New(testConfig("medium"), sink)
	server.SetRunning(true)
	login := serve(t, server, "/login", "username=demo&password=synthetic-secret", nil)
	cookie := login.Result().Cookies()[0]
	got := serve(t, server, "/console", "command=ls", cookie)
	if got.Code != 200 || got.Body.String() != "reports/summary.txt\n" {
		t.Fatalf("ls output=%q status=%d", got.Body.String(), got.Code)
	}
	got = serve(t, server, "/console", "command=ls+ignored", cookie)
	if got.Body.String() != "usage: ls" {
		t.Fatalf("ls with extra arguments=%q", got.Body.String())
	}
}

func TestConsoleCatUsesExactSyntheticPathWithSpaces(t *testing.T) {
	cfg := testConfig("medium")
	cfg.Config.FakeFS = append(cfg.Config.FakeFS, contracts.FakeFile{Path: "reports/final report.txt", Content: "exact synthetic text"})
	sink := &memorySink{}
	server, err := New(cfg, sink)
	if err != nil {
		t.Fatal(err)
	}
	server.SetRunning(true)
	login := serve(t, server, "/login", "username=demo&password=synthetic-secret", nil)
	cookie := login.Result().Cookies()[0]
	got := serve(t, server, "/console", "command=cat+reports%2Ffinal+report.txt", cookie)
	if got.Code != http.StatusOK || got.Body.String() != "exact synthetic text" {
		t.Fatalf("cat with spaces status=%d body=%q", got.Code, got.Body.String())
	}
}

func TestApplyIdenticalRevisionPreservesSessionsAndRejectsChangedContent(t *testing.T) {
	server, _ := New(testConfig("medium"), &memorySink{})
	server.SetRunning(true)
	login := serve(t, server, "/login", "username=demo&password=synthetic-secret", nil)
	cookie := login.Result().Cookies()[0]
	if err := server.Apply(testConfig("medium")); err != nil {
		t.Fatalf("identical apply: %v", err)
	}
	if got := serve(t, server, "/files", "", cookie); got.Code != 200 {
		t.Fatalf("idempotent apply cleared the session: %d", got.Code)
	}
	changed := testConfig("medium")
	changed.Config.VisibleTexts.Title = "changed at same revision"
	if err := server.Apply(changed); err == nil {
		t.Fatal("changed config at same profile revision was accepted")
	}
	newer := testConfig("medium")
	newer.Revision = 2
	if err := server.Apply(newer); err != nil {
		t.Fatalf("new revision: %v", err)
	}
	if err := server.Apply(testConfig("medium")); err != nil {
		t.Fatalf("explicit rollback to older revision: %v", err)
	}
}

func TestFailedConfigurationStoreLeavesConfigAndSessionsUntouched(t *testing.T) {
	store := &testConfigurationStore{err: errors.New("disk unavailable")}
	server, err := NewWithStore(testConfig("medium"), &memorySink{}, store)
	if err != nil {
		t.Fatal(err)
	}
	server.SetRunning(true)
	login := serve(t, server, "/login", "username=demo&password=synthetic-secret", nil)
	cookie := login.Result().Cookies()[0]
	next := testConfig("medium")
	next.Revision = 2
	next.Config.VisibleTexts.Title = "not applied"
	if err = server.Apply(next); err == nil {
		t.Fatal("store failure was ignored")
	}
	if current := server.Snapshot(); current.Revision != 1 || current.Config.VisibleTexts.Title != "Test" {
		t.Fatalf("failed persistence changed active configuration: %+v", current)
	}
	if got := serve(t, server, "/files", "", cookie); got.Code != http.StatusOK {
		t.Fatalf("failed persistence invalidated active session: %d", got.Code)
	}
	if store.calls != 1 {
		t.Fatalf("store Save calls=%d", store.calls)
	}
}

func TestFileConfigurationStorePersistsForRestartAndCleansAtomicTemps(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "applied.json")
	initial := testConfig("medium")
	bootstrap, err := json.Marshal(initial)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, bootstrap, 0600); err != nil {
		t.Fatal(err)
	}
	store, err := NewFileConfigurationStore(path)
	if err != nil {
		t.Fatal(err)
	}
	server, err := NewWithStore(initial, &memorySink{}, store)
	if err != nil {
		t.Fatal(err)
	}
	updated := testConfig("medium")
	updated.Revision = 2
	updated.Config.VisibleTexts.Title = "persisted revision"
	if err = server.Apply(updated); err != nil {
		t.Fatal(err)
	}
	if err = server.Apply(updated); err != nil {
		t.Fatalf("idempotent apply: %v", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "applied.json" {
		t.Fatalf("unexpected temp files after apply: %v", entries)
	}
	saved, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var restartedConfig Configuration
	if err = json.Unmarshal(saved, &restartedConfig); err != nil {
		t.Fatal(err)
	}
	restarted, err := New(restartedConfig, &memorySink{})
	if err != nil {
		t.Fatal(err)
	}
	if got := restarted.Snapshot(); got.Revision != 2 || got.Config.VisibleTexts.Title != "persisted revision" {
		t.Fatalf("restart loaded stale configuration: revision=%d title=%q", got.Revision, got.Config.VisibleTexts.Title)
	}
}

func TestFileConfigurationStoreFailureKeepsOriginalAndLeavesNoTemps(t *testing.T) {
	dir := t.TempDir()
	originalPath := filepath.Join(dir, "original.json")
	original := []byte(`{"original":true}`)
	if err := os.WriteFile(originalPath, original, 0600); err != nil {
		t.Fatal(err)
	}
	badParentStore, err := NewFileConfigurationStore(filepath.Join(originalPath, "child.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err = badParentStore.Save(testConfig("low")); err == nil {
		t.Fatal("save beneath a regular file succeeded")
	}
	got, err := os.ReadFile(originalPath)
	if err != nil || string(got) != string(original) {
		t.Fatalf("original config changed: %q err=%v", got, err)
	}

	blockedPath := filepath.Join(dir, "blocked.json")
	if err = os.Mkdir(blockedPath, 0700); err != nil {
		t.Fatal(err)
	}
	sentinel := filepath.Join(blockedPath, "keep.txt")
	if err = os.WriteFile(sentinel, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	blockedStore, err := NewFileConfigurationStore(blockedPath)
	if err != nil {
		t.Fatal(err)
	}
	if err = blockedStore.Save(testConfig("low")); err == nil {
		t.Fatal("rename over a directory succeeded")
	}
	if contents, readErr := os.ReadFile(sentinel); readErr != nil || string(contents) != "keep" {
		t.Fatalf("failed atomic replacement damaged existing target: %q err=%v", contents, readErr)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".blocked.json-") && strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatalf("orphan temporary configuration remains: %s", entry.Name())
		}
	}
}

func TestCanceledApplyWaitingForRequestDoesNotMutateConfig(t *testing.T) {
	sink := &gateSink{entered: make(chan struct{}), release: make(chan struct{})}
	server, err := New(testConfig("medium"), sink)
	if err != nil {
		t.Fatal(err)
	}
	server.SetRunning(true)
	loginResult := make(chan *httptest.ResponseRecorder, 1)
	go func() { loginResult <- serve(t, server, "/login", "username=demo&password=synthetic-secret", nil) }()
	select {
	case <-sink.entered:
	case <-time.After(time.Second):
		t.Fatal("request did not reach gated auth event")
	}
	next := testConfig("medium")
	next.Revision = 2
	next.Config.VisibleTexts.Title = "revision two"
	applyCtx, cancel := context.WithCancel(context.Background())
	applyResult := make(chan error, 1)
	started := make(chan struct{})
	go func() { close(started); applyResult <- server.ApplyContext(applyCtx, next) }()
	<-started
	cancel()
	close(sink.release)
	login := <-loginResult
	if login.Code != http.StatusSeeOther {
		t.Fatalf("login status=%d", login.Code)
	}
	select {
	case err := <-applyResult:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled apply error=%v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("canceled ApplyContext did not return")
	}
	if got := server.Snapshot(); got.Revision != 1 || got.Config.VisibleTexts.Title != "Test" {
		t.Fatalf("canceled apply mutated config: revision=%d title=%q", got.Revision, got.Config.VisibleTexts.Title)
	}
	cookie := login.Result().Cookies()[0]
	if got := serve(t, server, "/files", "", cookie); got.Code != http.StatusOK {
		t.Fatalf("canceled apply invalidated active session: %d", got.Code)
	}
}

func TestUnknownRouteAndPerServiceBanner(t *testing.T) {
	cfg := testConfig("low")
	cfg.Config.Services = append(cfg.Config.Services, contracts.Service{ID: "api", Name: "API", Protocol: "http", Port: 8081, Banner: "api service banner"})
	server, err := New(cfg, &memorySink{})
	if err != nil {
		t.Fatal(err)
	}
	server.SetRunning(true)
	for serviceID, banner := range map[string]string{"web": "test", "api": "api service banner"} {
		w := httptest.NewRecorder()
		server.PublicHandler(serviceID).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/", nil))
		if w.Code != 200 || !strings.Contains(w.Body.String(), banner) {
			t.Fatalf("service %s banner response=%d %q", serviceID, w.Code, w.Body.String())
		}
	}
	w := httptest.NewRecorder()
	server.PublicHandler("web").ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/not-found", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("unknown route status=%d", w.Code)
	}
}

func TestLowFilesExposeCatalogButNeverFileContent(t *testing.T) {
	server, _ := New(testConfig("low"), &memorySink{})
	server.SetRunning(true)
	catalog := serve(t, server, "/files", "", nil)
	if catalog.Code != 200 || catalog.Body.String() != `{"files":["reports/summary.txt"]}` {
		t.Fatalf("low catalog=%d %q", catalog.Code, catalog.Body.String())
	}
	for _, path := range []string{"/files?path=reports/summary.txt", "/files?path=reports/summary.txt&download=1"} {
		w := serve(t, server, path, "", nil)
		if w.Code != http.StatusForbidden || strings.Contains(w.Body.String(), "synthetic report") {
			t.Fatalf("low read %s returned %d %q", path, w.Code, w.Body.String())
		}
	}
}

func TestConnectionTelemetryIsPerKeepAliveConnection(t *testing.T) {
	sink := &memorySink{}
	cfg := testConfig("low")
	cfg.Config.Logging.Categories = append(cfg.Config.Logging.Categories, "connection.opened")
	server, _ := New(cfg, sink)
	server.SetRunning(true)
	ts := httptest.NewUnstartedServer(server.PublicHandler("web"))
	ts.Config.ConnContext = server.ConnectionContext("web")
	ts.Start()
	defer ts.Close()
	client := ts.Client()
	for i := 0; i < 2; i++ {
		resp, err := client.Get(ts.URL + "/")
		if err != nil {
			t.Fatal(err)
		}
		if _, err = io.Copy(io.Discard, resp.Body); err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
	}
	opened, requests := 0, 0
	for _, event := range sink.snapshot() {
		if event.EventType == "connection.opened" {
			opened++
		}
		if event.EventType == "http.request" {
			requests++
		}
	}
	if opened != 1 || requests != 2 {
		t.Fatalf("connection events=%d HTTP request events=%d, want 1 and 2", opened, requests)
	}
}

func TestApplyWaitsForRequestAndCannotMixRevisions(t *testing.T) {
	sink := &blockingSink{entered: make(chan struct{}), release: make(chan struct{})}
	server, _ := New(testConfig("medium"), sink)
	server.SetRunning(true)
	loginResult := make(chan *httptest.ResponseRecorder, 1)
	go func() { loginResult <- serve(t, server, "/login", "username=demo&password=synthetic-secret", nil) }()
	select {
	case <-sink.entered:
	case <-time.After(time.Second):
		t.Fatal("login did not reach auth telemetry")
	}
	updated := testConfig("medium")
	updated.Revision = 2
	updated.Config.VisibleTexts.Title = "revision two"
	applyStarted := make(chan struct{})
	applyDone := make(chan error, 1)
	go func() { close(applyStarted); applyDone <- server.Apply(updated) }()
	<-applyStarted
	select {
	case err := <-applyDone:
		t.Fatalf("Apply completed during public request: %v", err)
	case <-time.After(25 * time.Millisecond):
	}
	close(sink.release)
	login := <-loginResult
	if login.Code != http.StatusSeeOther {
		t.Fatalf("login status=%d", login.Code)
	}
	select {
	case err := <-applyDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("Apply did not finish after request")
	}
	for _, event := range sink.snapshot() {
		if event.EventType == "auth.attempt" || event.EventType == "session.started" {
			if event.AppliedRevision == nil || *event.AppliedRevision != 1 {
				t.Fatalf("login event mixed revisions: %+v", event)
			}
		}
	}
	cookie := login.Result().Cookies()[0]
	if got := serve(t, server, "/files", "", cookie); got.Code != http.StatusUnauthorized {
		t.Fatalf("session from prior revision remained valid after apply: %d", got.Code)
	}
}

func TestCatReturnsFullSyntheticContentAndBoundsTelemetry(t *testing.T) {
	sink := &memorySink{}
	cfg := testConfig("medium")
	cfg.Config.FakeFS[0].Content = strings.Repeat("я", 10000)
	server, err := New(cfg, sink)
	if err != nil {
		t.Fatal(err)
	}
	server.SetRunning(true)
	login := serve(t, server, "/login", "username=demo&password=synthetic-secret", nil)
	cookie := login.Result().Cookies()[0]
	response := serve(t, server, "/console", "command=cat+reports%2Fsummary.txt", cookie)
	if response.Code != http.StatusOK || response.Body.String() != cfg.Config.FakeFS[0].Content {
		t.Fatalf("cat response length=%d status=%d", response.Body.Len(), response.Code)
	}
	for _, event := range sink.snapshot() {
		if event.EventType == "command.received" {
			output, _ := event.Payload["output"].(string)
			truncated, _ := event.Payload["output_truncated"].(bool)
			if len(output) > 8192 || !utf8.ValidString(output) || !truncated {
				t.Fatalf("telemetry output length=%d truncated=%v validUTF8=%v", len(output), truncated, utf8.ValidString(output))
			}
			return
		}
	}
	t.Fatal("command.received telemetry missing")
}

func TestExpiredSessionEndMustPersistBeforeRemoval(t *testing.T) {
	sink := &memorySink{}
	server, _ := New(testConfig("medium"), sink)
	server.SetRunning(true)
	server.mu.Lock()
	server.sessions["expired-cookie"] = session{id: "33333333-3333-4333-8333-333333333333", expires: time.Now().Add(-time.Minute)}
	server.mu.Unlock()
	w := serve(t, server, "/files", "", &http.Cookie{Name: "archive_session", Value: "expired-cookie"})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expired session status=%d", w.Code)
	}
	found := false
	for _, event := range sink.events {
		if event.EventType == "session.ended" && event.SessionID == "33333333-3333-4333-8333-333333333333" && event.Payload["reason"] == "expired" {
			found = true
		}
	}
	if !found {
		t.Fatal("expired session.ended event was not persisted")
	}
	if _, ok := server.sessions["expired-cookie"]; ok {
		t.Fatal("expired session was not removed after persistence")
	}

	failing := &memorySink{err: errors.New("queue unavailable")}
	blocked, _ := New(testConfig("medium"), failing)
	blocked.SetRunning(true)
	blocked.mu.Lock()
	blocked.sessions["expired-cookie"] = session{id: "33333333-3333-4333-8333-333333333333", expires: time.Now().Add(-time.Minute)}
	blocked.mu.Unlock()
	w = serve(t, blocked, "/files", "", &http.Cookie{Name: "archive_session", Value: "expired-cookie"})
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("expired event failure status=%d", w.Code)
	}
	if _, ok := blocked.sessions["expired-cookie"]; !ok {
		t.Fatal("session removed before durable end event")
	}
}

func TestConnectionTelemetryFailureBlocksHTTPAction(t *testing.T) {
	sink := &memorySink{err: errors.New("queue unavailable")}
	cfg := testConfig("low")
	cfg.Config.Logging.Categories = append(cfg.Config.Logging.Categories, "connection.opened")
	server, _ := New(cfg, sink)
	server.SetRunning(true)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	httpServer := &http.Server{Handler: server.PublicHandler("web"), ConnContext: server.ConnectionContext("web")}
	go func() { _ = httpServer.Serve(listener) }()
	defer httpServer.Close()
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://%s/", listener.Addr()))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("connection telemetry failure status=%d", resp.StatusCode)
	}
}
