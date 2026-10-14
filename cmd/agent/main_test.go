package main

import (
	"context"
	"errors"
	"testing"

	"honeyforge/internal/agent"
)

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
