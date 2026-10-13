package agent

import (
	"context"
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
