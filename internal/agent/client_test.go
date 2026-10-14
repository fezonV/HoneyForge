package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"honeyforge/internal/contracts"
)

func TestNewClientRequiresHTTPSOrigin(t *testing.T) {
	for _, input := range []string{"http://center.example", "https://center.example/api", "https://user:pass@center.example"} {
		if _, err := NewClient(input); err == nil {
			t.Errorf("NewClient(%q) succeeded; want error", input)
		}
	}
	if _, err := NewClient("https://center.example"); err != nil {
		t.Fatalf("NewClient HTTPS origin: %v", err)
	}
}

func TestEnrollAndFetchConfig(t *testing.T) {
	const trapID = "11111111-1111-4111-8111-111111111111"
	const agentID = "22222222-2222-4222-8222-222222222222"
	var gotAuth string
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/agent/v1/enroll":
			var request map[string]string
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Errorf("decode enrollment request: %v", err)
			}
			if request["trap_id"] != trapID || request["token"] != "one-time-token" {
				t.Errorf("unexpected enrollment body: %#v", request)
			}
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"agent_id":"` + agentID + `","trap_id":"` + trapID + `","agent_token":"long-lived-secret"}`))
		case "/agent/v1/traps/" + trapID + "/config":
			gotAuth = r.Header.Get("Authorization")
			_, _ = w.Write([]byte(`{"trap_id":"` + trapID + `","profile_id":"33333333-3333-4333-8333-333333333333","revision":2,"config":{"template_id":"low-http","level":"low","services":[{"id":"web","name":"Web","protocol":"http","port":8080}],"visible_texts":{"title":"Test"},"synthetic_credentials":[],"fake_fs":[],"logging":{"categories":["http.request"]},"channel":{"tls_required":true,"heartbeat_seconds":10,"sync_seconds":2}}}`))
		case "/agent/v1/traps/" + trapID + "/heartbeat":
			gotAuth = r.Header.Get("Authorization")
			var request map[string]string
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Errorf("decode heartbeat request: %v", err)
			}
			if request["service_state"] != "running" {
				t.Errorf("unexpected heartbeat body: %#v", request)
			}
			_, _ = w.Write([]byte(`{"trap_id":"` + trapID + `","agent_status":"online","service_status":"running","last_seen":"2026-10-12T00:00:00Z"}`))
		case "/agent/v1/traps/" + trapID + "/events":
			gotAuth = r.Header.Get("Authorization")
			_, _ = w.Write([]byte(`{"accepted_ids":["44444444-4444-4444-8444-444444444444"],"duplicate_ids":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	client := &Client{baseURL: server.URL, http: server.Client()}
	state, err := client.Enroll(context.Background(), trapID, "one-time-token")
	if err != nil {
		t.Fatalf("Enroll: %v", err)
	}
	if state.AgentID != agentID || state.TrapID != trapID || state.Token != "long-lived-secret" {
		t.Fatalf("unexpected enrollment state: %#v", state)
	}
	config, err := client.FetchConfig(context.Background(), state)
	if err != nil {
		t.Fatalf("FetchConfig: %v", err)
	}
	if config.Revision != 2 || config.Config.Level != "low" || gotAuth != "Bearer long-lived-secret" {
		t.Fatalf("unexpected config/auth: %#v, auth=%q", config, gotAuth)
	}
	if err := client.Heartbeat(context.Background(), state, "running"); err != nil {
		t.Fatalf("Heartbeat: %v", err)
	}
	if gotAuth != "Bearer long-lived-secret" {
		t.Fatalf("heartbeat auth = %q", gotAuth)
	}
	event := queueEvent("44444444-4444-4444-8444-444444444444")
	result, err := client.SendEvents(context.Background(), state, []contracts.Event{event})
	if err != nil || len(result.AcceptedIDs) != 1 || gotAuth != "Bearer long-lived-secret" {
		t.Fatalf("SendEvents result=%+v auth=%q err=%v", result, gotAuth, err)
	}
}

func TestFetchConfigRejectsCrossTrapResponse(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"trap_id":"other","profile_id":"p","revision":1,"config":{}}`))
	}))
	defer server.Close()
	client := &Client{baseURL: server.URL, http: server.Client()}
	_, err := client.FetchConfig(context.Background(), &State{TrapID: "my-trap", Token: "secret"})
	if err == nil || !strings.Contains(err.Error(), "invalid configuration") {
		t.Fatalf("FetchConfig error = %v, want cross-trap rejection", err)
	}
}

func TestFetchConfigRejectsInvalidProfileConfiguration(t *testing.T) {
	const trapID = "11111111-1111-4111-8111-111111111111"
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"trap_id":"` + trapID + `","profile_id":"33333333-3333-4333-8333-333333333333","revision":2,"config":{"template_id":"low-http","level":"low","services":[{"id":"web","name":"Web","protocol":"http","port":8080}],"visible_texts":{"title":"Test"},"synthetic_credentials":[],"fake_fs":[],"logging":{"categories":["http.request"]},"channel":{"tls_required":true,"heartbeat_seconds":10,"sync_seconds":0}}}`))
	}))
	defer server.Close()
	client := &Client{baseURL: server.URL, http: server.Client()}
	_, err := client.FetchConfig(context.Background(), &State{TrapID: trapID, Token: "secret"})
	if err == nil || !strings.Contains(err.Error(), "invalid configuration") {
		t.Fatalf("FetchConfig error = %v, want invalid configuration rejection", err)
	}
}

func TestSaveAndLoadState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private", "state.json")
	want := &State{AgentID: "agent-id", TrapID: "trap-id", Token: "secret", Config: &ConfigResponse{Revision: 3, Config: contracts.ProfileConfig{Level: "medium"}}}
	if err := SaveState(path, want); err != nil {
		t.Fatalf("SaveState: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
		t.Fatalf("state permissions = %o, want private", info.Mode().Perm())
	}
	got, err := LoadState(path)
	if err != nil {
		t.Fatalf("LoadState: %v", err)
	}
	if got.AgentID != want.AgentID || got.TrapID != want.TrapID || got.Token != want.Token || got.Config.Revision != 3 {
		t.Fatalf("loaded state = %#v, want %#v", got, want)
	}
}

func TestLoadStateRejectsBroadPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows ACLs are not represented by os.FileMode")
	}
	path := filepath.Join(t.TempDir(), "state.json")
	if err := os.WriteFile(path, []byte(`{"agent_id":"a","trap_id":"t","agent_token":"s"}`), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadState(path); err == nil || !strings.Contains(err.Error(), "permissions") {
		t.Fatalf("LoadState error = %v, want permission error", err)
	}
}
