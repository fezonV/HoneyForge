package agent

import (
	"context"

	"honeyforge/internal/contracts"
)

// DecoyAdapter is the narrow boundary between the management agent and a
// decoy runtime. The runtime receives only its configuration and supported
// lifecycle commands; it never receives the agent credential or center URL.
type DecoyAdapter interface {
	ApplyConfiguration(context.Context, ConfigResponse) error
	Start(context.Context) error
	Stop(context.Context) error
	ServiceState(context.Context) (string, error)
}

// EventSink is the only local boundary exposed to a decoy. The implementation
// persists before acknowledging the event, so a management outage cannot lose
// telemetry already accepted by the agent.
type EventSink interface {
	Enqueue(context.Context, contracts.Event) (duplicate bool, err error)
}

func (q *EventQueue) Submit(ctx context.Context, event contracts.Event) error {
	_, err := q.Enqueue(ctx, event)
	return err
}
