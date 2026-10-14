package control

import (
	"context"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"honeyforge/internal/agent"
	"honeyforge/internal/contracts"
)

// TestQA02EventDeliveryRetainsIDsAcrossOutageAndLostACK exercises the
// center/agent boundary with a real TLS client and PostgreSQL-backed handler.
// It deliberately checks event IDs and queue depth, rather than relying on a
// row count alone.
func TestQA02EventDeliveryRetainsIDsAcrossOutageAndLostACK(t *testing.T) {
	db, handler, states, profileID := be02Fixture(t)
	state := states[0]
	var offline, dropACK atomic.Bool
	center := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if offline.Load() {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		if dropACK.Swap(false) {
			recorded := httptest.NewRecorder()
			handler.ServeHTTP(recorded, r)
			if recorded.Code != http.StatusOK {
				t.Errorf("center rejected event before ACK loss: %d %s", recorded.Code, recorded.Body.String())
			}
			hijacker, ok := w.(http.Hijacker)
			if !ok {
				t.Error("TLS test server does not expose a hijacker")
				return
			}
			conn, _, err := hijacker.Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			_ = conn.Close()
			return
		}
		handler.ServeHTTP(w, r)
	}))
	defer center.Close()
	caPath := filepath.Join(t.TempDir(), "center-ca.pem")
	if err := os.WriteFile(caPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: center.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	client, err := agent.NewClientWithCA(center.URL, caPath)
	if err != nil {
		t.Fatal(err)
	}

	queuePath := filepath.Join(t.TempDir(), "events.sqlite")
	queue, err := agent.OpenQueue(queuePath, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer queue.Close()
	ctx := context.Background()
	events := []contracts.Event{
		be03Event(uuid(), state.TrapID, state.AgentID, profileID, "", 1, "http.request", "2026-10-14T12:00:00Z"),
		be03Event(uuid(), state.TrapID, state.AgentID, profileID, "", 1, "connection.opened", "2026-10-14T12:00:01Z"),
	}
	for _, event := range events {
		if duplicate, enqueueErr := queue.Enqueue(ctx, event); enqueueErr != nil || duplicate {
			t.Fatalf("enqueue event %s duplicate=%v err=%v", event.EventID, duplicate, enqueueErr)
		}
	}
	offline.Store(true)
	if err = queue.Flush(ctx, client, state, 10, nil); err == nil {
		t.Fatal("management outage unexpectedly delivered events")
	}
	if depth, depthErr := queue.Depth(ctx); depthErr != nil || depth != len(events) {
		t.Fatalf("outage depth=%d err=%v", depth, depthErr)
	}
	if err = queue.Close(); err != nil {
		t.Fatal(err)
	}
	queue, err = agent.OpenQueue(queuePath, 10)
	if err != nil {
		t.Fatal(err)
	}
	offline.Store(false)
	if err = queue.Flush(ctx, client, state, 10, nil); err != nil {
		t.Fatalf("delivery after agent restart: %v", err)
	}

	lostACK := be03Event(uuid(), state.TrapID, state.AgentID, profileID, "", 1, "http.request", "2026-10-14T12:00:02Z")
	if _, err = queue.Enqueue(ctx, lostACK); err != nil {
		t.Fatal(err)
	}
	dropACK.Store(true)
	if err = queue.Flush(ctx, client, state, 10, nil); err == nil {
		t.Fatal("lost center ACK unexpectedly reported success")
	}
	if depth, depthErr := queue.Depth(ctx); depthErr != nil || depth != 1 {
		t.Fatalf("lost ACK removed queued event: depth=%d err=%v", depth, depthErr)
	}
	if err = queue.Flush(ctx, client, state, 10, nil); err != nil {
		t.Fatalf("retry after lost ACK: %v", err)
	}
	if depth, depthErr := queue.Depth(ctx); depthErr != nil || depth != 0 {
		t.Fatalf("retry left queue depth=%d err=%v", depth, depthErr)
	}
	var count int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM events WHERE agent_id=$1`, state.AgentID).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != len(events)+1 {
		t.Fatalf("center stored %d rows, want %d unique event IDs", count, len(events)+1)
	}
}
