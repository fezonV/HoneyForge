package agent

import (
	"context"

	"honeyforge/internal/contracts"
)

// TelemetryStatus contains counters and reasons, never visitor payloads or tokens.
func (q *EventQueue) TelemetryStatus(ctx context.Context) (contracts.AgentTelemetry, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	result := q.stats
	result.QueueLimit = q.limit
	err := q.db.QueryRowContext(ctx, `SELECT count(*),count(NULLIF(quarantine_reason,'')),COALESCE(MAX(NULLIF(quarantine_reason,'')),'') FROM queued_events`).Scan(&result.QueueDepth, &result.Quarantined, &result.QuarantineReason)
	if err != nil {
		return result, err
	}
	if result.QueueDepth < q.limit && result.StorageError == "telemetry queue is full" {
		result.StorageError, q.stats.StorageError = "", ""
	}
	result.Degraded = result.QueueDepth >= q.limit || result.Quarantined > 0 || result.StorageError != "" || result.DeliveryError != ""
	return result, nil
}

func (q *EventQueue) recordDelivery(outcome deliveryOutcome, err error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.stats.SentEvents += int64(outcome.sentEvents)
	if err != nil {
		q.stats.DeliveryErrors++
		q.stats.DeliveryRetries++
		q.stats.DeliveryError = "telemetry delivery failed; queued events retained"
	} else if outcome.sentEvents > 0 || outcome.quarantined > 0 {
		q.stats.DeliveryError = ""
	}
}
