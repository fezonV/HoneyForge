package control

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"honeyforge/internal/contracts"
)

// Enrollment holds the trap row lock. Retain the last 100 attempts per trap;
// never store tokens, hashes, raw request bodies or operator/agent credentials.
func recordRegistration(ctx context.Context, tx pgx.Tx, trapID, outcome, reason string) error {
	if _, err := tx.Exec(ctx, `INSERT INTO registration_attempts(id,trap_id,outcome,reason) VALUES($1,$2,$3,$4)`, uuid(), trapID, outcome, reason); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `DELETE FROM registration_attempts WHERE trap_id=$1 AND id IN (SELECT id FROM registration_attempts WHERE trap_id=$1 ORDER BY created_at DESC,id DESC OFFSET 100)`, trapID)
	return err
}

func (s *Server) rejectEnrollment(w http.ResponseWriter, r *http.Request, tx pgx.Tx, trapID, reason string, status int) {
	if err := recordRegistration(r.Context(), tx, trapID, "rejected", reason); err != nil {
		fail(w, r, 503, "not_ready", "registration result could not be stored", nil)
		return
	}
	if err := auditTx(r.Context(), tx, nil, "agent.enrollment_rejected", "trap", trapID, map[string]any{"reason": reason}); err != nil {
		fail(w, r, 503, "not_ready", "registration result could not be audited", nil)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		fail(w, r, 503, "not_ready", "registration result could not be committed", nil)
		return
	}
	// Detailed reasons belong to the authenticated operator API, not the public response.
	if status == 409 {
		fail(w, r, status, "already_enrolled", "trap already has an active agent", nil)
	} else {
		fail(w, r, status, "enrollment_invalid", "enrollment token is invalid", nil)
	}
	s.publishNotification("trap.status_changed", trapID, map[string]any{"trap_id": trapID})
}

type registrationCursor struct {
	CreatedAt time.Time `json:"at"`
	ID        string    `json:"id"`
}

func (s *Server) listRegistrationAttempts(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !checkID(w, r, id) {
		return
	}
	limit, rawCursor, failure := parseEventPage(r)
	if parseFailure(w, r, failure) {
		return
	}
	var cursor registrationCursor
	if rawCursor != "" {
		raw, err := base64.RawURLEncoding.DecodeString(rawCursor)
		if err != nil || json.Unmarshal(raw, &cursor) != nil || !contracts.ValidID(cursor.ID) || cursor.CreatedAt.IsZero() {
			fail(w, r, 400, "invalid_cursor", "cursor is invalid", nil)
			return
		}
	}
	var exists bool
	if err := s.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM traps WHERE id=$1 AND deleted_at IS NULL)`, id).Scan(&exists); err != nil {
		fail(w, r, 503, "not_ready", "database unavailable", nil)
		return
	}
	if !exists {
		fail(w, r, 404, "not_found", "trap not found", nil)
		return
	}
	before := cursor.CreatedAt
	if before.IsZero() {
		before = time.Date(9999, 1, 1, 0, 0, 0, 0, time.UTC)
	}
	rows, err := s.db.Query(r.Context(), `SELECT id::text,trap_id::text,outcome,reason,created_at FROM registration_attempts WHERE trap_id=$1 AND (created_at,id)<($2,$3::uuid) ORDER BY created_at DESC,id DESC LIMIT $4`, id, before, nullableCursor(cursor.ID), limit+1)
	if err != nil {
		fail(w, r, 503, "not_ready", "registration history unavailable", nil)
		return
	}
	defer rows.Close()
	items := []contracts.RegistrationAttempt{}
	var lastTime time.Time
	for rows.Next() {
		var attempt contracts.RegistrationAttempt
		var created time.Time
		if err = rows.Scan(&attempt.ID, &attempt.TrapID, &attempt.Outcome, &attempt.Reason, &created); err != nil {
			break
		}
		attempt.CreatedAt = created.UTC().Format(time.RFC3339Nano)
		items = append(items, attempt)
		if len(items) == limit {
			lastTime = created
		}
	}
	if err != nil || rows.Err() != nil {
		fail(w, r, 503, "not_ready", "registration history unavailable", nil)
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		raw, _ := json.Marshal(registrationCursor{CreatedAt: lastTime, ID: items[len(items)-1].ID})
		next = base64.RawURLEncoding.EncodeToString(raw)
	}
	writeJSON(w, 200, contracts.Page[contracts.RegistrationAttempt]{Items: items, NextCursor: next})
}
