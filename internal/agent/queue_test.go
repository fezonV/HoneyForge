package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"honeyforge/internal/contracts"
)

func queueEvent(id string) contracts.Event {
	return contracts.Event{SchemaVersion: "1.0", EventID: id, AgentID: "agent-1", TrapID: "trap-1", ServiceID: "web", EventType: "http.request", Timestamp: "2026-10-13T00:00:00Z", DestinationPort: 8080, Protocol: "http", Payload: map[string]any{"path": "/"}}
}

func TestQueueUsesPrivateFilesAndFullDurability(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.sqlite")
	// Also repair a pre-existing file created with a permissive umask.
	if err := os.WriteFile(path, nil, 0644); err != nil {
		t.Fatal(err)
	}
	q, err := OpenQueue(path, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	if _, err = q.Enqueue(context.Background(), queueEvent("one")); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{path, path + "-wal", path + "-shm"} {
		info, err := os.Stat(name)
		// Windows exposes synthetic permission bits rather than Unix mode bits.
		if err != nil || (runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0) {
			t.Fatalf("private file %s: info=%v err=%v", name, info, err)
		}
	}
	var synchronous int
	if err := q.db.QueryRow(`PRAGMA synchronous`).Scan(&synchronous); err != nil || synchronous != 2 {
		t.Fatalf("synchronous=%d err=%v", synchronous, err)
	}
}

func TestDiskFullDoesNotACKOrLoseExistingEvents(t *testing.T) {
	q, err := OpenQueue(filepath.Join(t.TempDir(), "agent.sqlite"), 10)
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	ctx := context.Background()
	if _, err = q.Enqueue(ctx, queueEvent("one")); err != nil {
		t.Fatal(err)
	}
	var pages int
	if err = q.db.QueryRow(`PRAGMA page_count`).Scan(&pages); err != nil {
		t.Fatal(err)
	}
	if _, err = q.db.Exec(fmt.Sprintf(`PRAGMA max_page_count=%d`, pages)); err != nil {
		t.Fatal(err)
	}
	large := queueEvent("two")
	large.Payload["body"] = strings.Repeat("x", 200000)
	if _, err = q.Enqueue(ctx, large); err == nil {
		t.Fatal("disk-full write acknowledged")
	}
	status, err := q.TelemetryStatus(ctx)
	if err != nil || !status.Degraded || status.StorageErrors != 1 || status.QueueDepth != 1 {
		t.Fatalf("status=%+v err=%v", status, err)
	}
	batch, err := q.Batch(ctx, 10)
	if err != nil || len(batch) != 1 || batch[0].Event.EventID != "one" {
		t.Fatalf("batch=%v err=%v", batch, err)
	}
}

func TestEventQueueDeduplicatesAndDetectsConflicts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.sqlite")
	q, err := OpenQueue(path, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	ctx := context.Background()
	event := queueEvent("event-1")
	duplicate, err := q.Enqueue(ctx, event)
	if err != nil || duplicate {
		t.Fatalf("first enqueue duplicate=%v err=%v", duplicate, err)
	}
	duplicate, err = q.Enqueue(ctx, event)
	if err != nil || !duplicate {
		t.Fatalf("second enqueue duplicate=%v err=%v", duplicate, err)
	}
	conflict := event
	conflict.Payload = map[string]any{"path": "/different"}
	if _, err = q.Enqueue(ctx, conflict); !errors.Is(err, ErrEventConflict) {
		t.Fatalf("conflict error=%v", err)
	}
	if _, err = q.Enqueue(ctx, queueEvent("event-2")); err != nil {
		t.Fatal(err)
	}
	if _, err = q.Enqueue(ctx, queueEvent("event-3")); !errors.Is(err, ErrQueueFull) {
		t.Fatalf("full queue error=%v", err)
	}
}

func TestEventQueueSurvivesReopenAndOnlyAckRemoves(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.sqlite")
	ctx := context.Background()
	q, err := OpenQueue(path, 10)
	if err != nil {
		t.Fatal(err)
	}
	event := queueEvent("event-1")
	if _, err = q.Enqueue(ctx, event); err != nil {
		t.Fatal(err)
	}
	batch, err := q.Batch(ctx, 10)
	if err != nil || len(batch) != 1 {
		t.Fatalf("batch len=%d err=%v", len(batch), err)
	}
	if err = q.MarkAttempted(ctx, batch); err != nil {
		t.Fatal(err)
	}
	if err = q.Close(); err != nil {
		t.Fatal(err)
	}
	q, err = OpenQueue(path, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	batch, err = q.Batch(ctx, 10)
	if err != nil || len(batch) != 1 || batch[0].Attempts != 1 {
		t.Fatalf("reopened batch=%+v err=%v", batch, err)
	}
	if err = q.Ack(ctx, []contracts.Event{event}); err != nil {
		t.Fatal(err)
	}
	depth, err := q.Depth(ctx)
	if err != nil || depth != 0 {
		t.Fatalf("depth=%d err=%v", depth, err)
	}
}
