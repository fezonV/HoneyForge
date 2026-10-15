package control

import (
	"context"
	"fmt"
	"honeyforge/internal/contracts"
	"io"
	"net/http/httptest"
	"path/filepath"
	"sort"
	"sync"
	"testing"
	"time"

	"honeyforge/internal/agent"
	"honeyforge/internal/decoy"
)

type qa02MeasuredSink struct {
	next decoy.EventSink
	mu   sync.Mutex
	ids  map[string]bool
}

func (s *qa02MeasuredSink) Submit(ctx context.Context, event contracts.Event) error {
	if err := s.next.Submit(ctx, event); err != nil {
		return err
	}
	s.mu.Lock()
	s.ids[event.EventID] = true
	s.mu.Unlock()
	return nil
}

// This measures HTTP action -> committed PostgreSQL ACK, not dashboard rendering.
// The browser event journal has a separate outstanding acceptance in #12/#15.
func TestQA02HTTPActionLoadToCommittedEvents(t *testing.T) {
	db, handler, states, profileID := be02Fixture(t)
	state := states[0]
	ctx := context.Background()
	queue, err := agent.OpenQueue(filepath.Join(t.TempDir(), "load.sqlite"), 10000)
	if err != nil {
		t.Fatal(err)
	}
	defer queue.Close()
	ipc := httptest.NewServer(agent.IPCHandler(queue, state, "load-ipc"))
	defer ipc.Close()
	sink, err := decoy.NewHTTPAgentSink(ipc.URL, "load-ipc")
	if err != nil {
		t.Fatal(err)
	}
	cfg := profileConfig()
	cfg.Level = "low"
	cfg.TemplateID = "low-http"
	cfg.SyntheticCredentials = nil
	cfg.Logging.Categories = []string{"http.request"} // exactly one event per action
	measuredSink := &qa02MeasuredSink{next: sink, ids: map[string]bool{}}
	runtime, err := decoy.New(decoy.Configuration{TrapID: state.TrapID, ProfileID: profileID, Revision: 1, Config: cfg}, measuredSink)
	if err != nil {
		t.Fatal(err)
	}
	runtime.SetRunning(true)
	public := httptest.NewServer(runtime.PublicHandler("web"))
	defer public.Close()
	client := be02TLSClient(t, handler)
	type deliveryResult struct {
		ids       map[string]bool
		latencies []time.Duration
		err       error
	}
	result := make(chan deliveryResult, 1)
	stop := make(chan struct{})
	go func() {
		measured := deliveryResult{ids: map[string]bool{}}
		defer func() { result <- measured }()
		ticker := time.NewTicker(50 * time.Millisecond)
		defer ticker.Stop()
		finished := false
		for {
			select {
			case <-stop:
				finished = true
			case <-ticker.C:
			}

			if err := queue.Flush(ctx, client, state, 500, nil); err != nil {
				measured.err = err
				return
			}
			rows, err := db.Query(ctx, `SELECT id::text,occurred_at FROM events WHERE agent_id=$1`, state.AgentID)
			if err != nil {
				measured.err = err
				return
			}
			committed := time.Now()
			for rows.Next() {
				var id string
				var occurred time.Time
				if err = rows.Scan(&id, &occurred); err != nil {
					rows.Close()
					measured.err = err
					return
				}
				if !measured.ids[id] {
					measured.ids[id] = true
					measured.latencies = append(measured.latencies, committed.Sub(occurred))
				}
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				measured.err = err
				return
			}

			if finished {
				return
			}
		}
	}()
	started := time.Now()
	ticker := time.NewTicker(20 * time.Millisecond)
	failures := make(chan error, 3000)
	// Bounded concurrent clients maintain the offered 50 actions/s independently
	// of response latency; excess latency fails instead of hiding under pacing.
	slots := make(chan struct{}, 100)
	for action := 0; action < 3000; action++ {
		<-ticker.C
		slots <- struct{}{}
		go func() {
			defer func() { <-slots }()
			response, err := public.Client().Get(public.URL + "/")
			if err != nil {
				failures <- err
				return
			}
			_, err = io.Copy(io.Discard, response.Body)
			response.Body.Close()
			if err != nil {
				failures <- err
			} else if response.StatusCode != 200 {
				failures <- fmt.Errorf("HTTP %d", response.StatusCode)
			}
		}()
	}
	ticker.Stop()
	for i := 0; i < cap(slots); i++ {
		slots <- struct{}{}
	}
	elapsed := time.Since(started)
	close(stop)
	measured := <-result
	close(failures)
	for err := range failures {
		t.Error(err)
	}
	if measured.err != nil {
		t.Fatal(measured.err)
	}
	if len(measured.ids) != 3000 || len(measured.latencies) != 3000 {
		t.Fatalf("ACKed IDs=%d, samples=%d, want 3000", len(measured.ids), len(measured.latencies))
	}

	measuredSink.mu.Lock()
	for id := range measured.ids {
		if !measuredSink.ids[id] {
			t.Errorf("unexpected committed ID %s", id)
		}
		delete(measuredSink.ids, id)
	}
	missing := len(measuredSink.ids)
	measuredSink.mu.Unlock()
	if missing != 0 {
		t.Fatalf("missing locally ACKed IDs=%d", missing)
	}
	if depth, err := queue.Depth(ctx); err != nil || depth != 0 {
		t.Fatalf("remaining queue=%d err=%v", depth, err)
	}

	sort.Slice(measured.latencies, func(i, j int) bool { return measured.latencies[i] < measured.latencies[j] })
	p95 := measured.latencies[(len(measured.latencies)*95-1)/100]
	t.Logf("3000 HTTP actions, elapsed=%s, throughput=%.2f/s, event-to-commit-ACK p95=%s; UI latency NOT measured", elapsed.Round(time.Millisecond), 3000/elapsed.Seconds(), p95.Round(time.Millisecond))
	if p95 > 3*time.Second || elapsed > 65*time.Second {
		t.Fatalf("load target missed: elapsed=%s p95=%s", elapsed, p95)
	}
}
