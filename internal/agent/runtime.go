package agent

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"honeyforge/internal/contracts"
)

// ProcessCommands claims and executes one command batch. Commands are handled
// sequentially so a profile replacement cannot race with start/stop. A command
// is reported applied only after the adapter confirms the side effect.
func ProcessCommands(ctx context.Context, client *Client, state *State, adapter DecoyAdapter, queue *EventQueue) error {
	if client == nil || state == nil || state.AgentID == "" || state.TrapID == "" || state.Token == "" {
		return errors.New("enrolled agent state and center client are required")
	}
	if adapter == nil || queue == nil {
		return fmt.Errorf("decoy adapter and durable command journal are required")
	}
	queue.commandMu.Lock()
	defer queue.commandMu.Unlock()
	if err := queue.reportResults(ctx, client, state); err != nil {
		return err
	}
	commands, err := client.FetchCommands(ctx, state)
	if err != nil {
		return err
	}
	for _, command := range commands {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !contracts.ValidID(command.ID) || command.TrapID != state.TrapID {
			return errors.New("center returned an invalid command identity")
		}
		expires, parseErr := time.Parse(time.RFC3339Nano, command.ExpiresAt)
		if parseErr != nil {
			return errors.New("center returned an invalid command deadline")
		}
		claimed, err := queue.claimCommand(ctx, state.AgentID, command, expires)
		if err != nil {
			return err
		}
		if !claimed {
			continue
		}
		var commandErr error
		if !time.Now().Before(expires) {
			commandErr = errors.New("command expired before execution")
		} else {
			commandCtx, cancel := context.WithDeadline(ctx, expires)
			commandErr = executeCommand(commandCtx, adapter, state, command)
			cancel()
		}
		result := CommandResult{Status: "applied"}
		if commandErr != nil {
			result = CommandResult{Status: "failed", Error: commandErr.Error()}
		}
		// API limits errors by bytes. Keep truncated UTF-8 valid.
		if len(result.Error) > 500 {
			result.Error = strings.ToValidUTF8(result.Error[:497], "") + "..."
		}
		// Persist even when the operation consumed its deadline. An interrupted
		// journal entry is never blindly executed again after a restart.
		saveCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		err = queue.finishCommand(saveCtx, state.AgentID, command.ID, result)
		cancel()
		if err != nil {
			return err
		}
	}
	return queue.reportResults(ctx, client, state)
}

func executeCommand(ctx context.Context, adapter DecoyAdapter, state *State, command contracts.Command) error {
	switch command.Type {
	case "start":
		return adapter.Start(ctx)
	case "stop":
		return adapter.Stop(ctx)
	case "apply_profile":
		config := state.ConfigSnapshot()
		if config == nil || command.TargetProfileID == nil || command.TargetRevision == nil {
			return fmt.Errorf("target profile configuration is unavailable")
		}
		if config.ProfileID != *command.TargetProfileID || config.Revision != *command.TargetRevision {
			return fmt.Errorf("desired configuration %s revision %d is not loaded", *command.TargetProfileID, *command.TargetRevision)
		}
		return adapter.ApplyConfiguration(ctx, *config)
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
