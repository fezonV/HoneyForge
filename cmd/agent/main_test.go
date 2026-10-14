package main

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"honeyforge/internal/agent"
	"honeyforge/internal/contracts"
)

type fixedConfigFetcher struct {
	config *agent.ConfigResponse
	err    error
}

func TestHeartbeatAndIntakeContinueDuringStalledDelivery(t *testing.T) {
	q, err := agent.OpenQueue(filepath.Join(t.TempDir(), "queue.sqlite"), 2)
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	state := &agent.State{AgentID: "11111111-1111-4111-8111-111111111111", TrapID: "22222222-2222-4222-8222-222222222222", Token: "agent-secret"}
	cfg := &agent.ConfigResponse{TrapID: state.TrapID, ProfileID: "33333333-3333-4333-8333-333333333333", Revision: 1, Config: contracts.ProfileConfig{
		TemplateID: "low-http", Level: "low", Services: []contracts.Service{{ID: "web", Name: "Web", Protocol: "http", Port: 8080}},
		VisibleTexts: contracts.VisibleTexts{Title: "Test"}, Logging: contracts.Logging{Categories: []string{"http.request"}}, Channel: contracts.Channel{TLSRequired: true, HeartbeatSeconds: 5, SyncSeconds: 2},
	}}
	state.SetConfig(cfg)
	event := contracts.Event{SchemaVersion: "1.0", EventID: "44444444-4444-4444-8444-444444444444", AgentID: state.AgentID, TrapID: state.TrapID, ServiceID: "web", EventType: "http.request", Timestamp: time.Now().UTC().Format(time.RFC3339Nano), DestinationPort: 8080, Protocol: "http", Payload: map[string]any{"path": "/"}}
	if _, err = q.Enqueue(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	heartbeats := make(chan string, 4)
	deliveryStarted := make(chan struct{}, 1)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/config"):
			_ = json.NewEncoder(w).Encode(cfg)
		case strings.HasSuffix(r.URL.Path, "/commands"):
			_, _ = w.Write([]byte(`{"items":[]}`))
		case strings.HasSuffix(r.URL.Path, "/events"):
			_, _ = io.Copy(io.Discard, r.Body)
			select {
			case deliveryStarted <- struct{}{}:
			default:
			}
			<-r.Context().Done()
		case strings.HasSuffix(r.URL.Path, "/heartbeat"):
			var body struct {
				ServiceState string                   `json:"service_state"`
				Telemetry    contracts.AgentTelemetry `json:"telemetry"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			heartbeats <- body.ServiceState
			_ = json.NewEncoder(w).Encode(map[string]any{"trap_id": state.TrapID, "agent_status": "online", "service_status": body.ServiceState, "last_seen": time.Now().UTC().Format(time.RFC3339Nano)})
		}
	}))
	defer server.Close()
	caPath := filepath.Join(t.TempDir(), "ca.pem")
	if err = os.WriteFile(caPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	client, err := agent.NewClientWithCA(server.URL, caPath)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	done := make(chan struct{})
	statePath := filepath.Join(t.TempDir(), "state.json")
	go func() {
		runAgentLoops(ctx, client, state, statePath, q, heartbeatAdapter{state: "running"})
		close(done)
	}()
	defer func() { cancel(); <-done }()
	select {
	case <-deliveryStarted:
	case <-ctx.Done():
		t.Fatal("delivery did not start")
	}
	select {
	case <-heartbeats:
	case <-ctx.Done():
		t.Fatal("initial heartbeat missing")
	}
	// Fill intake while delivery is waiting on the center; the next heartbeat
	// must still arrive and expose queue degradation.
	event.EventID = "55555555-5555-4555-8555-555555555555"
	if _, err = q.Enqueue(ctx, event); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-heartbeats:
		if got != "degraded" {
			t.Fatalf("full queue service state=%s", got)
		}
	case <-ctx.Done():
		t.Fatal("stalled delivery suppressed heartbeat")
	}
}

func TestReadSecretSupportsDockerSecretFiles(t *testing.T) {
	path := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(path, []byte("  bootstrap-token\n"), 0400); err != nil {
		t.Fatal(err)
	}
	if got, err := readSecret("ignored-inline-value", path); err != nil || got != "bootstrap-token" {
		t.Fatalf("readSecret()=(%q,%v), want trimmed file value", got, err)
	}
	if got, err := readSecret("legacy-token", ""); err != nil || got != "legacy-token" {
		t.Fatalf("inline secret compatibility=(%q,%v)", got, err)
	}
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, make([]byte, 4097), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readSecret("", path); err == nil {
		t.Fatal("oversized secret file was accepted")
	}
}

func (f fixedConfigFetcher) FetchConfig(context.Context, *agent.State) (*agent.ConfigResponse, error) {
	return f.config, f.err
}

func TestSyncConfigDoesNotChangeStateWhenPersistenceFails(t *testing.T) {
	state := &agent.State{AgentID: "11111111-1111-4111-8111-111111111111", TrapID: "22222222-2222-4222-8222-222222222222", Token: "agent-token", Config: &agent.ConfigResponse{ProfileID: "33333333-3333-4333-8333-333333333333", Revision: 1}}
	fetcher := fixedConfigFetcher{config: &agent.ConfigResponse{TrapID: state.TrapID, ProfileID: state.Config.ProfileID, Revision: 2}}
	dir := t.TempDir()
	if err := syncConfig(context.Background(), fetcher, state, dir); err == nil {
		t.Fatal("syncConfig succeeded while its state path was a directory")
	}
	if got := state.ConfigSnapshot(); got == nil || got.Revision != 1 {
		t.Fatalf("in-memory configuration changed after failed persistence: %+v", got)
	}

	statePath := filepath.Join(dir, "retry", "agent-state.json")
	if err := syncConfig(context.Background(), fetcher, state, statePath); err != nil {
		t.Fatalf("retry syncConfig after persistence failure: %v", err)
	}
	if got := state.ConfigSnapshot(); got == nil || got.Revision != 2 {
		t.Fatalf("successful retry did not update in-memory configuration: %+v", got)
	}
	persisted, err := agent.LoadState(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.Config == nil || persisted.Config.Revision != 2 {
		t.Fatalf("persisted revision=%v, want 2", persisted.Config)
	}
}

type heartbeatAdapter struct {
	state string
	err   error
}

func (a heartbeatAdapter) ApplyConfiguration(context.Context, agent.ConfigResponse) error { return nil }
func (a heartbeatAdapter) Start(context.Context) error                                    { return nil }
func (a heartbeatAdapter) Stop(context.Context) error                                     { return nil }
func (a heartbeatAdapter) ServiceState(context.Context) (string, error)                   { return a.state, a.err }

func TestCurrentServiceStateUsesAdapterStatus(t *testing.T) {
	for _, test := range []struct {
		name    string
		adapter agent.DecoyAdapter
		want    string
	}{
		{name: "running", adapter: heartbeatAdapter{state: "running"}, want: "running"},
		{name: "adapter error", adapter: heartbeatAdapter{state: "running", err: errors.New("status unavailable")}, want: "error"},
		{name: "unsupported status", adapter: heartbeatAdapter{state: "starting"}, want: "error"},
		{name: "missing adapter", want: "unknown"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := currentServiceState(context.Background(), test.adapter); got != test.want {
				t.Fatalf("currentServiceState()=%q, want %q", got, test.want)
			}
		})
	}
}
