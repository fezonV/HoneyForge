package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"honeyforge/internal/agent"
	"honeyforge/internal/contracts"
	"honeyforge/internal/decoy"
)

func TestTwoDecoyProcessesAcceptance(t *testing.T) {
	if os.Getenv("HF_DECOY_PROCESS_TEST") != "1" {
		t.Skip("set HF_DECOY_PROCESS_TEST=1 to build and launch real decoy processes")
	}

	tempDir := t.TempDir()
	binary := filepath.Join(tempDir, "decoy.exe")
	buildCtx, buildCancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer buildCancel()
	build := exec.CommandContext(buildCtx, filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-o", binary, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build decoy binary: %v\n%s", err, output)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	lowTrap, mediumTrap := "11111111-1111-4111-8111-111111111111", "33333333-3333-4333-8333-333333333333"
	lowProfile, mediumProfile := "22222222-2222-4222-8222-222222222222", "44444444-4444-4444-8444-444444444444"
	lowQueue := openProcessQueue(t, filepath.Join(tempDir, "low", "events.sqlite"))
	mediumQueue := openProcessQueue(t, filepath.Join(tempDir, "medium", "events.sqlite"))
	lowToken, mediumToken := "low-decoy-telemetry-token", "medium-decoy-telemetry-token"
	lowAgent := &agent.State{AgentID: "55555555-5555-4555-8555-555555555555", TrapID: lowTrap}
	mediumAgent := &agent.State{AgentID: "66666666-6666-4666-8666-666666666666", TrapID: mediumTrap}
	lowIPC := httptest.NewServer(agent.IPCHandler(lowQueue, lowAgent, lowToken))
	mediumIPC := httptest.NewServer(agent.IPCHandler(mediumQueue, mediumAgent, mediumToken))
	t.Cleanup(lowIPC.Close)
	t.Cleanup(mediumIPC.Close)

	ports := freePorts(t, 4)
	lowPublicPort, lowAdminPort := ports[0], ports[1]
	mediumPublicPort, mediumAdminPort := ports[2], ports[3]
	lowConfig := processTestConfig(lowTrap, lowProfile, "low", "low original banner", "low.txt", "low synthetic content")
	mediumConfig := processTestConfig(mediumTrap, mediumProfile, "medium", "medium original banner", "records.txt", "medium synthetic content")
	lowConfig.Config.Services[0].Port = portNumber(t, lowPublicPort)
	mediumConfig.Config.Services[0].Port = portNumber(t, mediumPublicPort)
	lowPath := writeProcessConfig(t, tempDir, "low.json", lowConfig)
	mediumPath := writeProcessConfig(t, tempDir, "medium.json", mediumConfig)
	lowAdminToken, mediumAdminToken := "low-agent-admin-token", "medium-agent-admin-token"

	startDecoyProcess(t, binary, lowPath, lowAdminPort, lowAdminToken, lowIPC.URL, lowToken)
	mediumProcess := startDecoyProcess(t, binary, mediumPath, mediumAdminPort, mediumAdminToken, mediumIPC.URL, mediumToken)
	lowAdapter := mustDecoyAdapter(t, lowAdminPort, lowAdminToken)
	mediumAdapter := mustDecoyAdapter(t, mediumAdminPort, mediumAdminToken)
	waitServiceState(t, ctx, lowAdapter, "running")
	waitServiceState(t, ctx, mediumAdapter, "running")

	lowClient, mediumClient := noRedirectClient(), noRedirectClient()
	lowBase, mediumBase := "http://127.0.0.1:"+lowPublicPort, "http://127.0.0.1:"+mediumPublicPort
	lowRoot := processRequest(t, lowClient, http.MethodGet, lowBase+"/", "", nil)
	if lowRoot.StatusCode != http.StatusOK || !strings.Contains(lowRoot.Body, "low original banner") {
		t.Fatalf("Low root status=%d body=%q", lowRoot.StatusCode, lowRoot.Body)
	}
	lowCatalog := processRequest(t, lowClient, http.MethodGet, lowBase+"/files", "", nil)
	if lowCatalog.StatusCode != http.StatusOK || !strings.Contains(lowCatalog.Body, "low.txt") || strings.Contains(lowCatalog.Body, "low synthetic content") {
		t.Fatalf("Low catalog status=%d body=%q", lowCatalog.StatusCode, lowCatalog.Body)
	}
	lowRead := processRequest(t, lowClient, http.MethodGet, lowBase+"/files?path=low.txt", "", nil)
	if lowRead.StatusCode != http.StatusForbidden || strings.Contains(lowRead.Body, "low synthetic content") {
		t.Fatalf("Low read status=%d body=%q", lowRead.StatusCode, lowRead.Body)
	}

	mediumUnauth := processRequest(t, mediumClient, http.MethodGet, mediumBase+"/files", "", nil)
	if mediumUnauth.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated Medium files status=%d", mediumUnauth.StatusCode)
	}
	login := postLogin(t, mediumClient, mediumBase, "demo", "synthetic-secret")
	if login.StatusCode != http.StatusSeeOther || login.Cookie == nil {
		t.Fatalf("Medium login status=%d cookie=%v", login.StatusCode, login.Cookie)
	}
	mediumCatalog := processRequest(t, mediumClient, http.MethodGet, mediumBase+"/files", "", login.Cookie)
	mediumRead := processRequest(t, mediumClient, http.MethodGet, mediumBase+"/files?path=records.txt", "", login.Cookie)
	if mediumCatalog.StatusCode != http.StatusOK || mediumRead.StatusCode != http.StatusOK || mediumRead.Body != "medium synthetic content" {
		t.Fatalf("Medium file flow catalog=%d read=%d body=%q", mediumCatalog.StatusCode, mediumRead.StatusCode, mediumRead.Body)
	}
	for _, command := range []struct{ value, want string }{{"pwd", "/"}, {"cat records.txt", "medium synthetic content"}} {
		response := postCommand(t, mediumClient, mediumBase, command.value, login.Cookie)
		if response.StatusCode != http.StatusOK || response.Body != command.want {
			t.Fatalf("command %q status=%d body=%q", command.value, response.StatusCode, response.Body)
		}
	}
	crossProfile := processRequest(t, lowClient, http.MethodGet, lowBase+"/files?path=low.txt", "", login.Cookie)
	if crossProfile.StatusCode != http.StatusForbidden || strings.Contains(crossProfile.Body, "low synthetic content") {
		t.Fatalf("Medium cookie granted Low file access: %d %q", crossProfile.StatusCode, crossProfile.Body)
	}

	updated := processTestConfig(mediumTrap, mediumProfile, "medium", "medium revision two banner", "records.txt", "new medium content")
	updated.Config.Services[0].Port = portNumber(t, mediumPublicPort)
	updated.Config.SyntheticCredentials = []contracts.SyntheticCredential{{Username: "new-demo", Password: "new-secret"}}
	updated.Revision = 2
	if err := mediumAdapter.ApplyConfiguration(ctx, agent.ConfigResponse(updated)); err != nil {
		t.Fatalf("apply Medium revision two: %v", err)
	}
	oldSession := processRequest(t, mediumClient, http.MethodGet, mediumBase+"/files", "", login.Cookie)
	if oldSession.StatusCode != http.StatusUnauthorized {
		t.Fatalf("old Medium session after apply status=%d", oldSession.StatusCode)
	}
	oldCredentials := postLogin(t, mediumClient, mediumBase, "demo", "synthetic-secret")
	if oldCredentials.StatusCode != http.StatusUnauthorized || oldCredentials.Cookie != nil {
		t.Fatalf("old credentials after apply status=%d cookie=%v", oldCredentials.StatusCode, oldCredentials.Cookie)
	}
	newLogin := postLogin(t, mediumClient, mediumBase, "new-demo", "new-secret")
	if newLogin.StatusCode != http.StatusSeeOther || newLogin.Cookie == nil {
		t.Fatalf("new credentials after apply status=%d", newLogin.StatusCode)
	}
	newRead := processRequest(t, mediumClient, http.MethodGet, mediumBase+"/files?path=records.txt", "", newLogin.Cookie)
	mediumRoot := processRequest(t, mediumClient, http.MethodGet, mediumBase+"/", "", newLogin.Cookie)
	if newRead.StatusCode != http.StatusOK || newRead.Body != "new medium content" || !strings.Contains(mediumRoot.Body, "medium revision two banner") {
		t.Fatalf("Medium revision two read=%d %q root=%d %q", newRead.StatusCode, newRead.Body, mediumRoot.StatusCode, mediumRoot.Body)
	}
	lowStillUp := processRequest(t, lowClient, http.MethodGet, lowBase+"/", "", nil)
	if lowStillUp.StatusCode != http.StatusOK || !strings.Contains(lowStillUp.Body, "low original banner") {
		t.Fatalf("Low changed with Medium apply: %d %q", lowStillUp.StatusCode, lowStillUp.Body)
	}

	mediumProcess.stop(t)
	mediumProcess = startDecoyProcess(t, binary, mediumPath, mediumAdminPort, mediumAdminToken, mediumIPC.URL, mediumToken)
	waitServiceState(t, ctx, mediumAdapter, "running")
	mediumClient = noRedirectClient()
	storedData, err := os.ReadFile(mediumPath)
	if err != nil {
		t.Fatal(err)
	}
	var storedConfig decoy.Configuration
	if err = json.Unmarshal(storedData, &storedConfig); err != nil {
		t.Fatal(err)
	}
	if storedConfig.Revision != 2 || storedConfig.Config.VisibleTexts.Title != "Process test" || storedConfig.Config.Services[0].Banner != "medium revision two banner" {
		t.Fatalf("config file was not updated before process restart: %+v", storedConfig)
	}
	oldCredentialsAfterRestart := postLogin(t, mediumClient, mediumBase, "demo", "synthetic-secret")
	if oldCredentialsAfterRestart.StatusCode != http.StatusUnauthorized {
		t.Fatalf("old credentials after process restart status=%d", oldCredentialsAfterRestart.StatusCode)
	}
	restartedLogin := postLogin(t, mediumClient, mediumBase, "new-demo", "new-secret")
	if restartedLogin.StatusCode != http.StatusSeeOther || restartedLogin.Cookie == nil {
		t.Fatalf("revision two credentials after restart status=%d", restartedLogin.StatusCode)
	}
	restartedRead := processRequest(t, mediumClient, http.MethodGet, mediumBase+"/files?path=records.txt", "", restartedLogin.Cookie)
	if restartedRead.StatusCode != http.StatusOK || restartedRead.Body != "new medium content" {
		t.Fatalf("restarted Medium loaded stale file: %d %q", restartedRead.StatusCode, restartedRead.Body)
	}

	if err := mediumAdapter.Stop(ctx); err != nil {
		t.Fatalf("stop Medium: %v", err)
	}
	mediumStopped := processRequest(t, mediumClient, http.MethodGet, mediumBase+"/", "", nil)
	if mediumStopped.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("stopped Medium status=%d", mediumStopped.StatusCode)
	}
	if err := mediumAdapter.Start(ctx); err != nil {
		t.Fatalf("start Medium: %v", err)
	}
	waitServiceState(t, ctx, mediumAdapter, "running")
	mediumResumed := processRequest(t, mediumClient, http.MethodGet, mediumBase+"/", "", nil)
	if mediumResumed.StatusCode != http.StatusSeeOther {
		t.Fatalf("resumed Medium status=%d", mediumResumed.StatusCode)
	}

	mediumIPC.Close()
	mediumIPCClosed := processRequest(t, mediumClient, http.MethodGet, mediumBase+"/", "", nil)
	lowAfterIPCFailure := processRequest(t, lowClient, http.MethodGet, lowBase+"/", "", nil)
	if mediumIPCClosed.StatusCode != http.StatusServiceUnavailable || lowAfterIPCFailure.StatusCode != http.StatusOK {
		t.Fatalf("agent IPC failure statuses medium=%d low=%d", mediumIPCClosed.StatusCode, lowAfterIPCFailure.StatusCode)
	}

	assertProcessQueue(t, lowQueue, lowAgent.AgentID, lowTrap, lowProfile, map[int]bool{1: true})
	assertProcessQueue(t, mediumQueue, mediumAgent.AgentID, mediumTrap, mediumProfile, map[int]bool{1: true, 2: true})
}

type processResponse struct {
	StatusCode int
	Body       string
	Cookie     *http.Cookie
}

type decoyProcess struct {
	cmd    *exec.Cmd
	done   chan struct{}
	once   sync.Once
	output *bytes.Buffer
}

func openProcessQueue(t *testing.T, path string) *agent.EventQueue {
	t.Helper()
	queue, err := agent.OpenQueue(path, 1000)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = queue.Close() })
	return queue
}

func processTestConfig(trapID, profileID, level, banner, fileName, content string) decoy.Configuration {
	template := "low-http"
	categories := []string{"http.request", "connection.opened", "file.listed"}
	credentials := []contracts.SyntheticCredential(nil)
	if level == "medium" {
		template = "medium-http"
		categories = []string{"http.request", "connection.opened", "auth.attempt", "session.started", "file.listed", "file.read", "file.downloaded", "session.ended", "command.received"}
		credentials = []contracts.SyntheticCredential{{Username: "demo", Password: "synthetic-secret"}}
	}
	return decoy.Configuration{TrapID: trapID, ProfileID: profileID, Revision: 1, Config: contracts.ProfileConfig{
		TemplateID: template, Level: level,
		Services:             []contracts.Service{{ID: "web", Name: "Process test", Protocol: "http", Port: 8080, Banner: banner}},
		VisibleTexts:         contracts.VisibleTexts{Title: "Process test", LoginPrompt: "Sign in", Failure: "Denied"},
		SyntheticCredentials: credentials, FakeFS: []contracts.FakeFile{{Path: fileName, Content: content}},
		Logging: contracts.Logging{Categories: categories},
		Channel: contracts.Channel{TLSRequired: true, HeartbeatSeconds: 10, SyncSeconds: 2},
	}}
}

func writeProcessConfig(t *testing.T, dir, name string, cfg decoy.Configuration) string {
	t.Helper()
	path := filepath.Join(dir, name)
	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func freePorts(t *testing.T, count int) []string {
	t.Helper()
	listeners := make([]net.Listener, 0, count)
	ports := make([]string, 0, count)
	for i := 0; i < count; i++ {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			for _, opened := range listeners {
				_ = opened.Close()
			}
			t.Fatal(err)
		}
		listeners = append(listeners, listener)
		ports = append(ports, fmt.Sprint(listener.Addr().(*net.TCPAddr).Port))
	}
	for _, listener := range listeners {
		if err := listener.Close(); err != nil {
			t.Fatal(err)
		}
	}
	return ports
}

func portNumber(t *testing.T, port string) int {
	t.Helper()
	var number int
	if _, err := fmt.Sscan(port, &number); err != nil {
		t.Fatal(err)
	}
	return number
}

func startDecoyProcess(t *testing.T, binary, configPath, adminPort, adminToken, agentURL, agentToken string) *decoyProcess {
	t.Helper()
	output := &bytes.Buffer{}
	cmd := exec.Command(binary, "-config", configPath, "-bind", "127.0.0.1", "-admin-listen", "127.0.0.1:"+adminPort, "-admin-token", adminToken, "-agent-url", agentURL, "-agent-token", agentToken)
	cmd.Env = os.Environ()
	cmd.Stdout, cmd.Stderr = output, output
	if err := cmd.Start(); err != nil {
		t.Fatalf("start decoy process: %v", err)
	}
	process := &decoyProcess{cmd: cmd, done: make(chan struct{}), output: output}
	go func() { _ = cmd.Wait(); close(process.done) }()
	t.Cleanup(func() { process.stop(t) })
	return process
}

func (p *decoyProcess) stop(t *testing.T) {
	t.Helper()
	p.once.Do(func() {
		if p.cmd.Process != nil {
			_ = p.cmd.Process.Kill()
		}
		select {
		case <-p.done:
		case <-time.After(3 * time.Second):
			if p.cmd.Process != nil {
				_ = p.cmd.Process.Kill()
			}
			select {
			case <-p.done:
			case <-time.After(3 * time.Second):
				t.Errorf("decoy child did not exit after Kill")
			}
		}
	})
}

func mustDecoyAdapter(t *testing.T, port, token string) *agent.HTTPDecoyAdapter {
	t.Helper()
	adapter, err := agent.NewHTTPDecoyAdapter("http://127.0.0.1:"+port, token)
	if err != nil {
		t.Fatal(err)
	}
	return adapter
}

func waitServiceState(t *testing.T, parent context.Context, adapter *agent.HTTPDecoyAdapter, expected string) {
	t.Helper()
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		ctx, cancel := context.WithTimeout(parent, 500*time.Millisecond)
		state, err := adapter.ServiceState(ctx)
		cancel()
		if err == nil && state == expected {
			return
		}
		select {
		case <-deadline.C:
			t.Fatalf("decoy did not report %q; last state=%q err=%v", expected, state, err)
		case <-parent.Done():
			t.Fatalf("test context ended waiting for %q: %v", expected, parent.Err())
		case <-ticker.C:
		}
	}
}

func noRedirectClient() *http.Client {
	return &http.Client{Timeout: 3 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func processRequest(t *testing.T, client *http.Client, method, rawURL, body string, cookie *http.Cookie) processResponse {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, rawURL, reader)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(rawURL, "/login") || strings.Contains(rawURL, "/console") {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, rawURL, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		t.Fatal(err)
	}
	result := processResponse{StatusCode: resp.StatusCode, Body: string(data)}
	for _, got := range resp.Cookies() {
		if got.Name == "archive_session" && got.Value != "" {
			result.Cookie = got
		}
	}
	return result
}

func postLogin(t *testing.T, client *http.Client, base, username, password string) processResponse {
	t.Helper()
	return processRequest(t, client, http.MethodPost, base+"/login", url.Values{"username": {username}, "password": {password}}.Encode(), nil)
}

func postCommand(t *testing.T, client *http.Client, base, command string, cookie *http.Cookie) processResponse {
	t.Helper()
	return processRequest(t, client, http.MethodPost, base+"/console", url.Values{"command": {command}}.Encode(), cookie)
}

func assertProcessQueue(t *testing.T, queue *agent.EventQueue, agentID, trapID, profileID string, revisions map[int]bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	items, err := queue.Batch(ctx, 1000)
	if err != nil {
		t.Fatalf("read durable queue: %v", err)
	}
	if len(items) == 0 {
		t.Fatal("expected durable telemetry events")
	}
	seen := map[int]bool{}
	for _, item := range items {
		event := item.Event
		if event.AgentID != agentID || event.TrapID != trapID || event.ProfileID != profileID {
			t.Fatalf("event crossed process identity: %+v", event)
		}
		if event.AppliedRevision == nil || !revisions[*event.AppliedRevision] {
			t.Fatalf("unexpected applied revision in queued event: %+v", event)
		}
		seen[*event.AppliedRevision] = true
	}
	for revision := range revisions {
		if !seen[revision] {
			t.Fatalf("queue has no event for applied revision %d", revision)
		}
	}
}
