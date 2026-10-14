package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"honeyforge/internal/contracts"
)

func TestIPCHandlerPersistsEventAndInjectsAgentIdentity(t *testing.T) {
	queue, err := OpenQueue(filepath.Join(t.TempDir(), "events.sqlite"), 10)
	if err != nil {
		t.Fatal(err)
	}
	defer queue.Close()
	state := &State{AgentID: "11111111-1111-4111-8111-111111111111", TrapID: "22222222-2222-4222-8222-222222222222"}
	state.SetConfig(&ConfigResponse{ProfileID: "44444444-4444-4444-8444-444444444444", Revision: 7})
	handler := IPCHandler(queue, state, "ipc-secret")
	revision := 3
	event := contracts.Event{SchemaVersion: "1.0", EventID: "33333333-3333-4333-8333-333333333333", AgentID: "spoofed", TrapID: state.TrapID, ProfileID: "55555555-5555-4555-8555-555555555555", AppliedRevision: &revision, ServiceID: "web", EventType: "http.request", Timestamp: "2026-10-14T12:00:00Z", DestinationPort: 8080, Protocol: "http", Payload: map[string]any{}}
	body, _ := json.Marshal(event)
	req := httptest.NewRequest(http.MethodPost, "/v1/events", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer ipc-secret")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var ack map[string]any
	if err = json.Unmarshal(w.Body.Bytes(), &ack); err != nil {
		t.Fatal(err)
	}
	if ack["persisted"] != true || ack["event_id"] != event.EventID {
		t.Fatalf("ack=%v", ack)
	}
	items, err := queue.Batch(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("queued events=%d", len(items))
	}
	got := items[0].Event
	if got.AgentID != state.AgentID || got.TrapID != state.TrapID || got.ProfileID != event.ProfileID || got.AppliedRevision == nil || *got.AppliedRevision != 3 {
		t.Fatalf("enrolled identity or actual applied revision was not preserved: %+v", got)
	}

	conflicting := event
	conflicting.Payload = map[string]any{"path": "/changed"}
	conflictBody, _ := json.Marshal(conflicting)
	conflictReq := httptest.NewRequest(http.MethodPost, "/v1/events", bytes.NewReader(conflictBody))
	conflictReq.Header.Set("Authorization", "Bearer ipc-secret")
	conflictRes := httptest.NewRecorder()
	handler.ServeHTTP(conflictRes, conflictReq)
	if conflictRes.Code != http.StatusConflict {
		t.Fatalf("same event ID with different payload status=%d body=%s", conflictRes.Code, conflictRes.Body.String())
	}
	items, err = queue.Batch(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Event.Payload["path"] != nil {
		t.Fatalf("conflicting IPC replay changed queued event: %+v", items)
	}
}

func TestIPCHandlerRejectsUnauthorizedAndUnavailableQueue(t *testing.T) {
	queue, err := OpenQueue(filepath.Join(t.TempDir(), "events.sqlite"), 10)
	if err != nil {
		t.Fatal(err)
	}
	defer queue.Close()
	handler := IPCHandler(queue, &State{AgentID: "agent", TrapID: "trap"}, "secret")
	req := httptest.NewRequest(http.MethodPost, "/v1/events", bytes.NewBufferString(`{}`))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status=%d", w.Code)
	}
	req = httptest.NewRequest(http.MethodPost, "/v1/events", bytes.NewBufferString(`{"schema_version":"1.0","event_id":"33333333-3333-4333-8333-333333333333","service_id":"web","event_type":"http.request","timestamp":"2026-10-14T12:00:00Z","destination_port":8080,"protocol":"http","payload":{}}`))
	req.Header.Set("Authorization", "Bearer secret")
	w = httptest.NewRecorder()
	IPCHandler(queue, nil, "secret").ServeHTTP(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("unavailable agent status=%d", w.Code)
	}
}

func TestIPCStatusRequiresBearerAndExposesBoundedQuarantineWithoutPayload(t *testing.T) {
	q, err := OpenQueue(filepath.Join(t.TempDir(), "queue.sqlite"), 1)
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	event := queueEvent("one")
	event.Payload["password"] = "synthetic-sensitive-payload"
	ctx := context.Background()
	if _, err = q.Enqueue(ctx, event); err != nil {
		t.Fatal(err)
	}
	batch, err := q.Batch(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if err = q.Quarantine(ctx, batch, "center returned HTTP 409: event_conflict"); err != nil {
		t.Fatal(err)
	}
	if _, err = q.Enqueue(ctx, queueEvent("two")); err != ErrQueueFull {
		t.Fatalf("bounded quarantine: %v", err)
	}
	handler := IPCHandler(q, nil, "ipc-secret")
	for _, auth := range []string{"", "ipc-secret", "Bearer wrong", "Bearer ipc-secret"} {
		req := httptest.NewRequest("GET", "/v1/status", nil)
		req.Header.Set("Authorization", auth)
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		if auth != "Bearer ipc-secret" {
			if res.Code != 401 {
				t.Fatalf("auth=%q status=%d", auth, res.Code)
			}
			continue
		}
		var status contracts.AgentTelemetry
		if err = json.Unmarshal(res.Body.Bytes(), &status); err != nil {
			t.Fatal(err)
		}
		if res.Code != 200 || status.QueueDepth != 1 || status.Quarantined != 1 || !status.Degraded || status.QuarantineReason == "" {
			t.Fatalf("status=%d %s", res.Code, res.Body.String())
		}
		if strings.Contains(res.Body.String(), "synthetic-sensitive-payload") || strings.Contains(res.Body.String(), "ipc-secret") {
			t.Fatal("diagnostics leaked payload or token")
		}
	}
}

func TestIPCHandlerRejectsOversizedBodyAndMissingPayload(t *testing.T) {
	queue, err := OpenQueue(filepath.Join(t.TempDir(), "events.sqlite"), 10)
	if err != nil {
		t.Fatal(err)
	}
	defer queue.Close()
	state := &State{AgentID: "11111111-1111-4111-8111-111111111111", TrapID: "22222222-2222-4222-8222-222222222222"}
	handler := IPCHandler(queue, state, "secret")

	tooLarge := contracts.Event{SchemaVersion: "1.0", EventID: "33333333-3333-4333-8333-333333333333", TrapID: state.TrapID, ServiceID: "web", EventType: "http.request", Timestamp: "2026-10-14T12:00:00Z", Protocol: "http", Payload: map[string]any{"data": strings.Repeat("x", 300*1024)}}
	body, err := json.Marshal(tooLarge)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/events", bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized event status=%d body=%s", response.Code, response.Body.String())
	}

	missingPayload := tooLarge
	missingPayload.EventID = "44444444-4444-4444-8444-444444444444"
	missingPayload.Payload = nil
	body, err = json.Marshal(missingPayload)
	if err != nil {
		t.Fatal(err)
	}
	request = httptest.NewRequest(http.MethodPost, "/v1/events", bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer secret")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnprocessableEntity {
		t.Fatalf("missing payload status=%d body=%s", response.Code, response.Body.String())
	}

	items, err := queue.Batch(context.Background(), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 0 {
		t.Fatalf("invalid events changed durable queue: %+v", items)
	}
}
