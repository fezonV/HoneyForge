package agent

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"honeyforge/internal/contracts"
	_ "modernc.org/sqlite"
)

const defaultQueueLimit = 10000

var ErrEventConflict = errors.New("event ID already exists with different content")
var ErrQueueFull = errors.New("agent event queue is full")

type EventQueue struct {
	db        *sql.DB
	mu        sync.Mutex
	commandMu sync.Mutex
	limit     int
	stats     contracts.AgentTelemetry
}

type QueuedEvent struct {
	Event    contracts.Event
	Attempts int
}

func OpenQueue(path string, limit int) (*EventQueue, error) {
	if path == "" {
		return nil, errors.New("queue path is required")
	}
	if limit < 1 {
		limit = defaultQueueLimit
	}
	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0700); err != nil {
			return nil, fmt.Errorf("create queue directory: %w", err)
		}
	}
	// Create privately before SQLite opens it; WAL permissions follow this file.
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, fmt.Errorf("create private event queue: %w", err)
	}
	err = file.Chmod(0600)
	closeErr := file.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	for _, sidecar := range []string{path + "-wal", path + "-shm"} {
		if err := os.Chmod(sidecar, 0600); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("restrict queue sidecar: %w", err)
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open event queue: %w", err)
	}
	db.SetMaxOpenConns(1)
	q := &EventQueue{db: db, limit: limit}
	if _, err = db.Exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;`); err == nil {
		_, err = db.Exec(`CREATE TABLE IF NOT EXISTS queued_events (
			agent_id TEXT NOT NULL, event_id TEXT NOT NULL, body BLOB NOT NULL,
			body_hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL, next_attempt_at TEXT NOT NULL DEFAULT '',
			quarantine_reason TEXT NOT NULL DEFAULT '', PRIMARY KEY(agent_id,event_id)
		);`)
	}
	if err == nil {
		_, err = db.Exec(`CREATE TABLE IF NOT EXISTS command_results (
			agent_id TEXT NOT NULL, command_id TEXT NOT NULL, body_hash TEXT NOT NULL,
			expires_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '',
			reported INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(agent_id,command_id)
		);`)
	}
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("initialize event queue: %w", err)
	}
	return q, nil
}

func (q *EventQueue) Close() error { return q.db.Close() }

func (q *EventQueue) Enqueue(ctx context.Context, event contracts.Event) (duplicate bool, err error) {
	if event.AgentID == "" || event.EventID == "" {
		return false, errors.New("event agent_id and event_id are required")
	}
	body, err := json.Marshal(event)
	if err != nil {
		return false, fmt.Errorf("encode event: %w", err)
	}
	hash := sha256.Sum256(body)
	hashText := hex.EncodeToString(hash[:])
	q.mu.Lock()
	defer q.mu.Unlock()
	defer func() {
		if err != nil && !errors.Is(err, ErrEventConflict) {
			q.stats.StorageErrors++
			q.stats.StorageError = "telemetry could not be persisted"
			if errors.Is(err, ErrQueueFull) {
				q.stats.StorageError = "telemetry queue is full"
			}
		} else if err == nil {
			q.stats.StorageError = ""
		}
	}()
	var count int
	if err = q.db.QueryRowContext(ctx, `SELECT count(*) FROM queued_events`).Scan(&count); err != nil {
		return false, fmt.Errorf("count event queue: %w", err)
	}
	var existingHash string
	err = q.db.QueryRowContext(ctx, `SELECT body_hash FROM queued_events WHERE agent_id=? AND event_id=?`, event.AgentID, event.EventID).Scan(&existingHash)
	if err == nil {
		if existingHash != hashText {
			return false, ErrEventConflict
		}
		return true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, fmt.Errorf("check event identity: %w", err)
	}
	if count >= q.limit {
		return false, ErrQueueFull
	}
	_, err = q.db.ExecContext(ctx, `INSERT INTO queued_events(agent_id,event_id,body,body_hash,created_at) VALUES(?,?,?,?,?)`, event.AgentID, event.EventID, body, hashText, time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		return false, fmt.Errorf("queue event: %w", err)
	}
	return false, nil
}

func (q *EventQueue) Batch(ctx context.Context, limit int) ([]QueuedEvent, error) {
	if limit < 1 {
		return nil, errors.New("batch limit must be positive")
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	rows, err := q.db.QueryContext(ctx, `SELECT body,attempts FROM queued_events WHERE quarantine_reason='' AND (next_attempt_at='' OR next_attempt_at<=?) ORDER BY created_at,agent_id,event_id LIMIT ?`, time.Now().UTC().Format(time.RFC3339Nano), limit)
	if err != nil {
		return nil, fmt.Errorf("read event queue: %w", err)
	}
	defer rows.Close()
	var result []QueuedEvent
	for rows.Next() {
		var body []byte
		var attempts int
		if err = rows.Scan(&body, &attempts); err != nil {
			return nil, fmt.Errorf("read queued event: %w", err)
		}
		var event contracts.Event
		if err = json.Unmarshal(body, &event); err != nil {
			return nil, fmt.Errorf("decode queued event: %w", err)
		}
		result = append(result, QueuedEvent{Event: event, Attempts: attempts})
	}
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate event queue: %w", err)
	}
	return result, nil
}

func (q *EventQueue) MarkAttempted(ctx context.Context, events []QueuedEvent) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	tx, err := q.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, item := range events {
		attempt := item.Attempts + 1
		backoff := ""
		if attempt > 1 {
			backoff = time.Now().UTC().Add(time.Duration(1<<min(attempt, 6)) * time.Second).Format(time.RFC3339Nano)
		}
		if _, err = tx.ExecContext(ctx, `UPDATE queued_events SET attempts=?,next_attempt_at=? WHERE agent_id=? AND event_id=?`, attempt, backoff, item.Event.AgentID, item.Event.EventID); err != nil {
			return fmt.Errorf("mark event attempt: %w", err)
		}
	}
	return tx.Commit()
}

func (q *EventQueue) Quarantine(ctx context.Context, events []QueuedEvent, reason string) error {
	if reason == "" || len(reason) > 500 {
		return errors.New("quarantine reason must contain 1 to 500 characters")
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, item := range events {
		if _, err := q.db.ExecContext(ctx, `UPDATE queued_events SET quarantine_reason=? WHERE agent_id=? AND event_id=?`, reason, item.Event.AgentID, item.Event.EventID); err != nil {
			return err
		}
	}
	return nil
}

func (q *EventQueue) Quarantined(ctx context.Context) (int, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	var count int
	err := q.db.QueryRowContext(ctx, `SELECT count(*) FROM queued_events WHERE quarantine_reason<>''`).Scan(&count)
	return count, err
}

func (q *EventQueue) Ack(ctx context.Context, events []contracts.Event) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	tx, err := q.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, event := range events {
		if _, err = tx.ExecContext(ctx, `DELETE FROM queued_events WHERE agent_id=? AND event_id=?`, event.AgentID, event.EventID); err != nil {
			return fmt.Errorf("ack event: %w", err)
		}
	}
	return tx.Commit()
}

func (q *EventQueue) Depth(ctx context.Context) (int, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	var count int
	if err := q.db.QueryRowContext(ctx, `SELECT count(*) FROM queued_events`).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
