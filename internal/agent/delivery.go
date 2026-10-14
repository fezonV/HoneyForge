package agent

import (
	"context"
	"errors"
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
// removed. Known permanent event rejections are isolated by splitting the batch
// and quarantining only the individual event that cannot be accepted.
func (q *EventQueue) Flush(ctx context.Context, client *Client, state *State, batchSize int, metrics *DeliveryMetrics) error {
	items, err := q.Batch(ctx, batchSize)
	if err != nil || len(items) == 0 {
		if err != nil {
			q.recordDelivery(deliveryOutcome{}, err)
		}
		return err
	}
	var outcome deliveryOutcome
	err = q.flushBatch(ctx, client, state, items, &outcome)
	if err != nil {
		if markErr := q.MarkAttempted(ctx, items); markErr != nil {
			err = fmt.Errorf("%w; schedule retry: %v", err, markErr)
		}
		if metrics != nil {
			metrics.Retries++
		}
	}
	if metrics != nil {
		metrics.SentBatches += outcome.sentBatches
		metrics.SentEvents += outcome.sentEvents
		metrics.Quarantined += outcome.quarantined
	}
	q.recordDelivery(outcome, err)
	return err
}

type deliveryOutcome struct {
	sentBatches uint64
	sentEvents  uint64
	quarantined uint64
}

func (q *EventQueue) flushBatch(ctx context.Context, client *Client, state *State, items []QueuedEvent, outcome *deliveryOutcome) error {
	events := make([]contracts.Event, 0, len(items))
	for _, item := range items {
		events = append(events, item.Event)
	}
	result, err := client.SendEvents(ctx, state, events)
	if err != nil {
		var statusErr *HTTPStatusError
		if errors.As(err, &statusErr) && permanentEventRejection(statusErr) {
			if len(items) == 1 {
				if err = q.Quarantine(ctx, items, statusErr.Error()); err != nil {
					return fmt.Errorf("quarantine rejected event: %w", err)
				}
				outcome.quarantined++
				return nil
			}
			middle := len(items) / 2
			if err = q.flushBatch(ctx, client, state, items[:middle], outcome); err != nil {
				return err
			}
			return q.flushBatch(ctx, client, state, items[middle:], outcome)
		}
		return err
	}
	if !acknowledgesExactly(result, events) {
		return errors.New("center acknowledged a different set of event IDs")
	}
	if err = q.Ack(ctx, events); err != nil {
		return err
	}
	outcome.sentBatches++
	outcome.sentEvents += uint64(len(events))
	return nil
}

func permanentEventRejection(err *HTTPStatusError) bool {
	if err.StatusCode != 400 && err.StatusCode != 409 && err.StatusCode != 413 && err.StatusCode != 422 {
		return false
	}
	switch err.Message {
	case "invalid_json", "event_conflict", "session_conflict", "body_too_large", "validation_failed":
		return true
	default:
		return false
	}
}

func acknowledgesExactly(result EventSendResponse, events []contracts.Event) bool {
	expected := make(map[string]struct{}, len(events))
	for _, event := range events {
		expected[event.EventID] = struct{}{}
	}
	acknowledged := make(map[string]struct{}, len(events))
	for _, ids := range [][]string{result.AcceptedIDs, result.DuplicateIDs} {
		for _, id := range ids {
			if _, ok := expected[id]; !ok {
				return false
			}
			if _, duplicate := acknowledged[id]; duplicate {
				return false
			}
			acknowledged[id] = struct{}{}
		}
	}
	return len(acknowledged) == len(expected)
}
