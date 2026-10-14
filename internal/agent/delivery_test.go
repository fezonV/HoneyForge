package agent

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"honeyforge/internal/contracts"
)

func TestFlushQuarantinesOnlyPermanentlyRejectedEvent(t *testing.T) {
	q, err := OpenQueue(filepath.Join(t.TempDir(), "agent.sqlite"), 10)
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	ctx := context.Background()
	events := []contracts.Event{
		queueEvent("event-1"),
		queueEvent("event-bad"),
		queueEvent("event-3"),
	}
	for _, event := range events {
		if _, err = q.Enqueue(ctx, event); err != nil {
			t.Fatal(err)
		}
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Events []contracts.Event `json:"events"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode events: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		for _, event := range request.Events {
			if event.EventID == "event-bad" {
				w.WriteHeader(http.StatusUnprocessableEntity)
				_, _ = w.Write([]byte(`{"error":{"code":"validation_failed","message":"invalid event"}}`))
				return
			}
		}
		ids := make([]string, 0, len(request.Events))
		for _, event := range request.Events {
			ids = append(ids, event.EventID)
		}
		_ = json.NewEncoder(w).Encode(EventSendResponse{AcceptedIDs: ids, DuplicateIDs: []string{}})
	}))
	defer server.Close()
	client := &Client{baseURL: server.URL, http: server.Client()}
	metrics := DeliveryMetrics{}
	if err = q.Flush(ctx, client, &State{TrapID: "trap-1", Token: "secret"}, 10, &metrics); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	depth, err := q.Depth(ctx)
	if err != nil || depth != 1 {
		t.Fatalf("queue depth=%d err=%v, want only rejected event", depth, err)
	}
	quarantined, err := q.Quarantined(ctx)
	if err != nil || quarantined != 1 {
		t.Fatalf("quarantined=%d err=%v, want 1", quarantined, err)
	}
	if metrics.SentEvents != 2 || metrics.Quarantined != 1 || metrics.Retries != 0 {
		t.Fatalf("metrics=%+v", metrics)
	}
}

func TestFlushRetriesAuthorizationErrorsWithoutQuarantine(t *testing.T) {
	q, err := OpenQueue(filepath.Join(t.TempDir(), "agent.sqlite"), 10)
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	event := queueEvent("event-1")
	if _, err = q.Enqueue(context.Background(), event); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"code":"unauthorized","message":"invalid token"}}`))
	}))
	defer server.Close()
	client := &Client{baseURL: server.URL, http: server.Client()}
	metrics := DeliveryMetrics{}
	err = q.Flush(context.Background(), client, &State{TrapID: "trap-1", Token: "secret"}, 10, &metrics)
	var statusErr *HTTPStatusError
	if !errors.As(err, &statusErr) || statusErr.StatusCode != http.StatusUnauthorized {
		t.Fatalf("Flush error=%v, want HTTP 401", err)
	}
	depth, err := q.Depth(context.Background())
	if err != nil || depth != 1 {
		t.Fatalf("queue depth=%d err=%v, want retained event", depth, err)
	}
	quarantined, err := q.Quarantined(context.Background())
	if err != nil || quarantined != 0 {
		t.Fatalf("quarantined=%d err=%v, want 0", quarantined, err)
	}
	batch, err := q.Batch(context.Background(), 10)
	if err != nil || len(batch) != 1 || batch[0].Attempts != 1 {
		t.Fatalf("retry batch=%+v err=%v", batch, err)
	}
}

func TestFlushRejectsUnexpectedAcknowledgedIDs(t *testing.T) {
	q, err := OpenQueue(filepath.Join(t.TempDir(), "agent.sqlite"), 10)
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	if _, err = q.Enqueue(context.Background(), queueEvent("event-1")); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(EventSendResponse{AcceptedIDs: []string{"unrelated-event"}})
	}))
	defer server.Close()
	client := &Client{baseURL: server.URL, http: server.Client()}
	if err = q.Flush(context.Background(), client, &State{TrapID: "trap-1", Token: "secret"}, 10, nil); err == nil {
		t.Fatal("Flush succeeded with an unexpected acknowledged event ID")
	}
	depth, err := q.Depth(context.Background())
	if err != nil || depth != 1 {
		t.Fatalf("queue depth=%d err=%v, want retained event", depth, err)
	}
}
