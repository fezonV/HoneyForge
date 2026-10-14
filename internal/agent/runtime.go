package agent

import (
	"context"
	"fmt"

	"honeyforge/internal/contracts"
)

// ProcessCommands claims and executes one command batch. Commands are handled
// sequentially so a profile replacement cannot race with start/stop. A command
// is reported applied only after the adapter confirms the side effect.
func ProcessCommands(ctx context.Context, client *Client, state *State, adapter DecoyAdapter) error {
	if adapter == nil {
		return fmt.Errorf("decoy adapter is not configured")
	}
	commands, err := client.FetchCommands(ctx, state)
	if err != nil {
		return err
	}
	for _, command := range commands {
		commandErr := executeCommand(ctx, adapter, state, command)
		status := "applied"
		message := ""
		if commandErr != nil {
			status, message = "failed", commandErr.Error()
		}
		if reportErr := client.ReportCommand(ctx, state, command.ID, status, message); reportErr != nil {
			return fmt.Errorf("report command %s: %w", command.ID, reportErr)
		}
	}
	return nil
}

func executeCommand(ctx context.Context, adapter DecoyAdapter, state *State, command contracts.Command) error {
	switch command.Type {
	case "start":
		return adapter.Start(ctx)
	case "stop":
		return adapter.Stop(ctx)
	case "apply_profile":
		if state.Config == nil || command.TargetProfileID == nil || command.TargetRevision == nil {
			return fmt.Errorf("target profile configuration is unavailable")
		}
		if state.Config.ProfileID != *command.TargetProfileID || state.Config.Revision != *command.TargetRevision {
			return fmt.Errorf("desired configuration %s revision %d is not loaded", *command.TargetProfileID, *command.TargetRevision)
		}
		return adapter.ApplyConfiguration(ctx, *state.Config)
	default:
		return fmt.Errorf("unsupported command type %q", command.Type)
	}
}

type RejectingAdapter struct{}

func (RejectingAdapter) ApplyConfiguration(context.Context, ConfigResponse) error {
	return fmt.Errorf("decoy adapter is not configured")
}
func (RejectingAdapter) Start(context.Context) error {
	return fmt.Errorf("decoy adapter is not configured")
}
func (RejectingAdapter) Stop(context.Context) error {
	return fmt.Errorf("decoy adapter is not configured")
}
func (RejectingAdapter) ServiceState(context.Context) (string, error) {
	return "error", fmt.Errorf("decoy adapter is not configured")
}
