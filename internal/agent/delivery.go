package agent

import (
	"context"
	"fmt"

	"honeyforge/internal/contracts"
)

type DeliveryMetrics struct {
	SentBatches uint64
	SentEvents  uint64
	Retries     uint64
	Quarantined uint64
}

// Flush sends one durable batch. Any transport failure leaves rows queued and
// schedules a bounded retry; only the center's accepted or duplicate IDs are
// removed. HTTP 4xx errors are quarantined because retrying them cannot repair
// the event payload.
func (q *EventQueue) Flush(ctx context.Context, client *Client, state *State, batchSize int, metrics *DeliveryMetrics) error {
	items, err := q.Batch(ctx, batchSize)
	if err != nil || len(items) == 0 {
		return err
	}
	events := make([]contracts.Event, 0, len(items))
	for _, item := range items {
		events = append(events, item.Event)
	}
	result, err := client.SendEvents(ctx, state, events)
	if err != nil {
		_ = q.MarkAttempted(ctx, items)
		if metrics != nil {
			metrics.Retries++
		}
		return err
	}
	if len(result.AcceptedIDs)+len(result.DuplicateIDs) != len(events) {
		_ = q.MarkAttempted(ctx, items)
		return fmt.Errorf("center acknowledged %d of %d events", len(result.AcceptedIDs)+len(result.DuplicateIDs), len(events))
	}
	if err = q.Ack(ctx, events); err != nil {
		return err
	}
	if metrics != nil {
		metrics.SentBatches++
		metrics.SentEvents += uint64(len(events))
	}
	return nil
}
