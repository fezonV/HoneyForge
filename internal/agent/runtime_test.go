package agent

import (
	"context"
	"errors"
	"testing"

	"honeyforge/internal/contracts"
)

type fakeAdapter struct {
	applied, started, stopped int
	err                       error
}

func (f *fakeAdapter) ApplyConfiguration(context.Context, ConfigResponse) error {
	f.applied++
	return f.err
}
func (f *fakeAdapter) Start(context.Context) error                  { f.started++; return f.err }
func (f *fakeAdapter) Stop(context.Context) error                   { f.stopped++; return f.err }
func (f *fakeAdapter) ServiceState(context.Context) (string, error) { return "running", f.err }

func TestExecuteCommandRequiresLoadedTargetRevision(t *testing.T) {
	adapter := &fakeAdapter{}
	state := &State{Config: &ConfigResponse{ProfileID: "profile-1", Revision: 2}}
	target := "profile-1"
	revision := 1
	err := executeCommand(context.Background(), adapter, state, contracts.Command{Type: "apply_profile", TargetProfileID: &target, TargetRevision: &revision})
	if err == nil || adapter.applied != 0 {
		t.Fatalf("err=%v applied=%d", err, adapter.applied)
	}
	revision = 2
	if err = executeCommand(context.Background(), adapter, state, contracts.Command{Type: "apply_profile", TargetProfileID: &target, TargetRevision: &revision}); err != nil || adapter.applied != 1 {
		t.Fatalf("err=%v applied=%d", err, adapter.applied)
	}
}

func TestExecuteCommandPropagatesAdapterFailure(t *testing.T) {
	adapter := &fakeAdapter{err: errors.New("invalid configuration")}
	if err := executeCommand(context.Background(), adapter, &State{}, contracts.Command{Type: "start"}); err == nil || adapter.started != 1 {
		t.Fatalf("err=%v started=%d", err, adapter.started)
	}
}
