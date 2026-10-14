package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"honeyforge/internal/contracts"
)

func TestIPCHandlerPersistsEventAndInjectsAgentIdentity(t *testing.T) {
	queue, err := OpenQueue(filepath.Join(t.TempDir(), "events.sqlite"), 10)
	if err != nil {
		t.Fatal(err)
	}
	defer queue.Close()
	state := &State{AgentID: "agent-id", TrapID: "trap-id"}
	state.SetConfig(&ConfigResponse{ProfileID: "profile-id", Revision: 7})
	handler := IPCHandler(queue, state, "ipc-secret")
	event := contracts.Event{EventID: "33333333-3333-4333-8333-333333333333", AgentID: "spoofed", TrapID: "spoofed", ProfileID: "spoofed", ServiceID: "web", EventType: "http.request", Timestamp: "2026-10-14T12:00:00Z", Protocol: "http", Payload: map[string]any{}}
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
	if got.AgentID != "agent-id" || got.TrapID != "trap-id" || got.ProfileID != "profile-id" || got.AppliedRevision == nil || *got.AppliedRevision != 7 {
		t.Fatalf("caller identity was trusted: %+v", got)
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
	req = httptest.NewRequest(http.MethodPost, "/v1/events", bytes.NewBufferString(`{"event_id":"33333333-3333-4333-8333-333333333333","service_id":"web","event_type":"http.request","timestamp":"2026-10-14T12:00:00Z","protocol":"http"}`))
	req.Header.Set("Authorization", "Bearer secret")
	w = httptest.NewRecorder()
	IPCHandler(queue, nil, "secret").ServeHTTP(w, req)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("unavailable agent status=%d", w.Code)
	}
}
