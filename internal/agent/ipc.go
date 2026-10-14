package agent

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"honeyforge/internal/contracts"
)

// IPCHandler exposes only durable telemetry submission to the decoy process.
// The shared IPC token is distinct from the center credential and never grants
// access to configuration, commands, or the center API.
func IPCHandler(queue *EventQueue, state *State, token string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/events", func(w http.ResponseWriter, r *http.Request) {
		provided := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if token == "" || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || subtle.ConstantTimeCompare([]byte(provided), []byte(token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 256*1024)
		var event contracts.Event
		if err := json.NewDecoder(r.Body).Decode(&event); err != nil {
			http.Error(w, "invalid event", http.StatusBadRequest)
			return
		}
		if !contracts.ValidID(event.EventID) || event.ServiceID == "" || len(event.ServiceID) > 64 || event.EventType == "" || event.Timestamp == "" || event.Protocol != "http" || len(event.Payload) > 64 {
			http.Error(w, "required event fields are missing", http.StatusUnprocessableEntity)
			return
		}
		if _, err := time.Parse(time.RFC3339Nano, event.Timestamp); err != nil {
			http.Error(w, "invalid event timestamp", http.StatusUnprocessableEntity)
			return
		}
		if state == nil || state.AgentID == "" || state.TrapID == "" {
			http.Error(w, "agent is not enrolled", http.StatusServiceUnavailable)
			return
		}
		event.AgentID, event.TrapID = state.AgentID, state.TrapID
		if config := state.ConfigSnapshot(); config != nil {
			event.ProfileID, event.AppliedRevision = config.ProfileID, intPointer(config.Revision)
		}
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		duplicate, err := queue.Enqueue(ctx, event)
		if err != nil {
			if errors.Is(err, ErrQueueFull) {
				http.Error(w, "telemetry queue is full", http.StatusInsufficientStorage)
				return
			}
			http.Error(w, "telemetry was not persisted", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]any{"event_id": event.EventID, "duplicate": duplicate, "persisted": true})
	})
	return mux
}

func intPointer(v int) *int { return &v }
