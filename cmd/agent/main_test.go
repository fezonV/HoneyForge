package main

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"honeyforge/internal/agent"
)

type fixedConfigFetcher struct {
	config *agent.ConfigResponse
	err    error
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
