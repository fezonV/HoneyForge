package agent

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"net"
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
	mux.HandleFunc("GET /v1/status", func(w http.ResponseWriter, r *http.Request) {
		provided := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if token == "" || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || subtle.ConstantTimeCompare([]byte(provided), []byte(token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		status, err := queue.TelemetryStatus(r.Context())
		if err != nil {
			http.Error(w, "telemetry status unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(status)
	})
	mux.HandleFunc("POST /v1/events", func(w http.ResponseWriter, r *http.Request) {
		provided := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if token == "" || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || subtle.ConstantTimeCompare([]byte(provided), []byte(token)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if state == nil || !contracts.ValidID(state.AgentID) || !contracts.ValidID(state.TrapID) {
			http.Error(w, "agent is not enrolled", http.StatusServiceUnavailable)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 256*1024)
		var event contracts.Event
		if err := json.NewDecoder(r.Body).Decode(&event); err != nil {
			var maxBytesErr *http.MaxBytesError
			if errors.As(err, &maxBytesErr) {
				http.Error(w, "event body is too large", http.StatusRequestEntityTooLarge)
				return
			}
			http.Error(w, "invalid event", http.StatusBadRequest)
			return
		}
		if !contracts.ValidID(event.EventID) || event.ServiceID == "" || len(event.ServiceID) > 64 || !validEventType(event.EventType) || event.SchemaVersion != "1.0" || event.Timestamp == "" || event.Protocol != "http" || event.Payload == nil || len(event.Payload) > 64 {
			http.Error(w, "required event fields are missing", http.StatusUnprocessableEntity)
			return
		}
		if event.TrapID != "" && !contracts.ValidID(event.TrapID) {
			http.Error(w, "invalid trap ID", http.StatusUnprocessableEntity)
			return
		}
		if event.SessionID != "" && !contracts.ValidID(event.SessionID) {
			http.Error(w, "invalid session ID", http.StatusUnprocessableEntity)
			return
		}
		if event.ProfileID != "" && !contracts.ValidID(event.ProfileID) {
			http.Error(w, "invalid profile ID", http.StatusUnprocessableEntity)
			return
		}
		if (event.ProfileID == "") != (event.AppliedRevision == nil) || (event.AppliedRevision != nil && *event.AppliedRevision < 1) {
			http.Error(w, "profile ID and applied revision must be provided together", http.StatusUnprocessableEntity)
			return
		}
		if event.SourceIP != "" && net.ParseIP(event.SourceIP) == nil {
			http.Error(w, "invalid source IP", http.StatusUnprocessableEntity)
			return
		}
		if event.SourcePort != nil && (*event.SourcePort < 1 || *event.SourcePort > 65535) || event.DestinationPort < 1 || event.DestinationPort > 65535 {
			http.Error(w, "invalid event port", http.StatusUnprocessableEntity)
			return
		}
		payload, err := json.Marshal(event.Payload)
		if err != nil || len(payload) > 256*1024 {
			http.Error(w, "invalid event payload", http.StatusUnprocessableEntity)
			return
		}
		if _, err := time.Parse(time.RFC3339Nano, event.Timestamp); err != nil {
			http.Error(w, "invalid event timestamp", http.StatusUnprocessableEntity)
			return
		}
		if event.TrapID != "" && event.TrapID != state.TrapID {
			http.Error(w, "event trap does not match enrollment", http.StatusUnprocessableEntity)
			return
		}
		event.AgentID, event.TrapID = state.AgentID, state.TrapID
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		duplicate, err := queue.Enqueue(ctx, event)
		if err != nil {
			if errors.Is(err, ErrEventConflict) {
				http.Error(w, "event ID already exists with different content", http.StatusConflict)
				return
			}
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

func validEventType(s string) bool {
	switch s {
	case "connection.opened", "http.request", "auth.attempt", "session.started", "file.listed", "file.read", "file.downloaded", "session.ended", "command.received":
		return true
	default:
		return false
	}
}
