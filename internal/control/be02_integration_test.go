package control

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"honeyforge/internal/agent"
	"honeyforge/internal/contracts"
	"honeyforge/internal/decoy"
)

func be02Fixture(t *testing.T) (*pgxpool.Pool, http.Handler, []*agent.State, string) {
	t.Helper()
	db, _, cleanup := setupIntegration(t)
	t.Cleanup(cleanup)
	ctx := context.Background()
	profileID := uuid()
	cfg, _ := json.Marshal(profileConfig())
	tx, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `INSERT INTO profiles(id,name,current_revision) VALUES($1,'BE-02 test',1)`, profileID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO profile_revisions(profile_id,revision,config) VALUES($1,1,$2)`, profileID, cfg); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	states := []*agent.State{}
	for i := 0; i < 2; i++ {
		s := &agent.State{AgentID: uuid(), TrapID: uuid(), Token: fmt.Sprintf("be02-agent-%d", i)}
		if _, err := db.Exec(ctx, `INSERT INTO traps(id,name,desired_profile_id,desired_revision,applied_profile_id,applied_revision,deployment_bindings) VALUES($1,$2,$3,1,$3,1,'[]')`, s.TrapID, fmt.Sprintf("trap-%d", i), profileID); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(ctx, `INSERT INTO agents(id,trap_id,token_hash) VALUES($1,$2,$3)`, s.AgentID, s.TrapID, tokenHash(s.Token)); err != nil {
			t.Fatal(err)
		}
		states = append(states, s)
	}
	return db, New(db, Config{PublicOrigin: testOrigin}).Handler(), states, profileID
}

func be02TLSClient(t *testing.T, handler http.Handler) *agent.Client {
	t.Helper()
	server := httptest.NewTLSServer(handler)
	t.Cleanup(server.Close)
	caPath := filepath.Join(t.TempDir(), "ca.pem")
	if err := os.WriteFile(caPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: server.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	client, err := agent.NewClientWithCA(server.URL, caPath)
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func TestBE02SixtySecondOutageRestartAndLostCommitACK(t *testing.T) {
	if testing.Short() {
		t.Skip("60-second reliability acceptance")
	}
	db, handler, states, profileID := be02Fixture(t)
	state := states[0]
	var offline, dropACK atomic.Bool
	offline.Store(true)
	client := be02TLSClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if offline.Load() {
			w.WriteHeader(503)
			return
		}
		if dropACK.Swap(false) {
			recorded := httptest.NewRecorder()
			handler.ServeHTTP(recorded, r)
			if recorded.Code != 200 {
				t.Errorf("commit before lost ACK: %d %s", recorded.Code, recorded.Body.String())
			}
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			_ = conn.Close()
			return
		}
		handler.ServeHTTP(w, r)
	}))
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "agent.sqlite")
	q, err := agent.OpenQueue(path, 1000)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = q.Close() }()
	started := time.Now()
	for half := 0; half < 2; half++ {
		ipc := agent.IPCHandler(q, state, "ipc-secret")
		for i := 0; i < 50; i++ {
			event := be03Event(uuid(), state.TrapID, state.AgentID, profileID, "", 1, "http.request", time.Now().UTC().Format(time.RFC3339Nano))
			body, _ := json.Marshal(event)
			req := httptest.NewRequest("POST", "/v1/events", bytes.NewReader(body))
			req.Header.Set("Authorization", "Bearer ipc-secret")
			res := httptest.NewRecorder()
			ipc.ServeHTTP(res, req)
			if res.Code != 202 {
				t.Fatalf("local event ACK=%d %s", res.Code, res.Body.String())
			}
		}
		if err = q.Flush(ctx, client, state, 100, nil); err == nil {
			t.Fatal("management outage unexpectedly delivered events")
		}
		if half == 0 {
			<-time.After(time.Until(started.Add(30 * time.Second)))
			if err = q.Close(); err != nil {
				t.Fatal(err)
			}
			q, err = agent.OpenQueue(path, 1000)
			if err != nil {
				t.Fatal(err)
			}
			if depth, err := q.Depth(ctx); err != nil || depth != 50 {
				t.Fatalf("restart depth=%d err=%v", depth, err)
			}
		}
	}
	<-time.After(time.Until(started.Add(60 * time.Second)))
	offline.Store(false)
	dropACK.Store(true)
	if err = q.Flush(ctx, client, state, 100, nil); err == nil {
		t.Fatal("lost commit ACK unexpectedly acknowledged")
	}
	if depth, err := q.Depth(ctx); err != nil || depth != 100 {
		t.Fatalf("lost ACK depth=%d err=%v", depth, err)
	}
	// The retry deadline is durable; wait only until that bounded retry is due.
	deadline := time.Now().Add(12 * time.Second)
	for time.Now().Before(deadline) {
		if err = q.Flush(ctx, client, state, 100, nil); err != nil {
			t.Fatal(err)
		}
		depth, depthErr := q.Depth(ctx)
		if depthErr != nil {
			t.Fatal(depthErr)
		}
		if depth == 0 {
			break
		}
		<-time.After(100 * time.Millisecond)
	}
	if depth, err := q.Depth(ctx); err != nil || depth != 0 {
		t.Fatalf("recovered depth=%d err=%v", depth, err)
	}
	var count int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM events WHERE agent_id=$1`, state.AgentID).Scan(&count); err != nil || count != 100 {
		t.Fatalf("durable events=%d err=%v", count, err)
	}
	t.Logf("management outage %s; restart at 30s; 100 local ACKs, 100 PostgreSQL rows after lost commit ACK and retry", time.Since(started).Round(time.Millisecond))
}

func TestBE02IsolationCommandsTelemetryAndTransactionalFailure(t *testing.T) {
	db, handler, states, profileID := be02Fixture(t)
	ctx := context.Background()
	client := be02TLSClient(t, handler)
	state := states[0]
	q, err := agent.OpenQueue(filepath.Join(t.TempDir(), "agent.sqlite"), 10)
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	runtime, err := decoy.New(decoy.Configuration{TrapID: state.TrapID, ProfileID: profileID, Revision: 1, Config: profileConfig()}, q)
	if err != nil {
		t.Fatal(err)
	}
	runtime.SetRunning(true)
	admin := httptest.NewServer(runtime.AdminHandler("admin-secret"))
	defer admin.Close()
	adapter, err := agent.NewHTTPDecoyAdapter(admin.URL, "admin-secret")
	if err != nil {
		t.Fatal(err)
	}
	queueCommand := func(kind string) string {
		t.Helper()
		id := uuid()
		if _, err := db.Exec(ctx, `INSERT INTO commands(id,trap_id,command_type,expected_profile_id,expected_revision,target_profile_id,target_revision,status,expires_at) VALUES($1,$2,$3,$4,1,$4,1,'queued',now()+interval '60 seconds')`, id, state.TrapID, kind, profileID); err != nil {
			t.Fatal(err)
		}
		return id
	}
	stopID := queueCommand("stop")
	if err = agent.ProcessCommands(ctx, client, state, adapter, q); err != nil {
		t.Fatal(err)
	}
	if runtime.Started() {
		t.Fatal("stop did not stop decoy")
	}
	if err = client.Heartbeat(ctx, state, "stopped"); err != nil {
		t.Fatal(err)
	}
	if err = client.Heartbeat(ctx, states[1], "running"); err != nil {
		t.Fatal(err)
	}
	one, err := readTrap(ctx, db, state.TrapID)
	if err != nil || one.AgentStatus != "online" || one.ServiceStatus != "stopped" {
		t.Fatalf("stopped trap=%+v err=%v", one, err)
	}
	two, err := readTrap(ctx, db, states[1].TrapID)
	if err != nil || two.ServiceStatus != "running" {
		t.Fatalf("second trap=%+v err=%v", two, err)
	}
	// Re-reporting a completed command after TTL must keep its final result.
	if _, err = db.Exec(ctx, `UPDATE commands SET expires_at=now()-interval '1 second' WHERE id=$1`, stopID); err != nil {
		t.Fatal(err)
	}
	if err = client.ReportCommand(ctx, state, stopID, "applied", ""); err != nil {
		t.Fatal(err)
	}
	queueCommand("apply_profile")
	bad := profileConfig()
	bad.Services[0].Port = 0
	state.SetConfig(&agent.ConfigResponse{TrapID: state.TrapID, ProfileID: profileID, Revision: 1, Config: bad})
	if err = agent.ProcessCommands(ctx, client, state, adapter, q); err != nil {
		t.Fatal(err)
	}
	var failed int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM commands WHERE trap_id=$1 AND status='failed'`, state.TrapID).Scan(&failed); err != nil || failed != 1 {
		t.Fatalf("failed configs=%d err=%v", failed, err)
	}
	if runtime.Snapshot().Config.Services[0].Port != 8080 || runtime.Snapshot().Revision != 1 {
		t.Fatal("bad configuration replaced working revision")
	}
	telemetry := &contracts.AgentTelemetry{QueueDepth: 10, QueueLimit: 10, Quarantined: 1, Degraded: true, QuarantineReason: "center returned HTTP 409: event_conflict", DeliveryErrors: 2, DeliveryRetries: 2}
	if err = client.HeartbeatWithTelemetry(ctx, state, "degraded", telemetry); err != nil {
		t.Fatal(err)
	}
	one, err = readTrap(ctx, db, state.TrapID)
	if err != nil || one.Telemetry == nil || one.Telemetry.QueueDepth != 10 || !one.Telemetry.Degraded {
		t.Fatalf("operator telemetry=%+v err=%v", one.Telemetry, err)
	}
	event := be03Event(uuid(), state.TrapID, state.AgentID, profileID, "", 1, "http.request", time.Now().UTC().Format(time.RFC3339Nano))
	for _, forged := range []*agent.State{{TrapID: state.TrapID, Token: "foreign"}, {TrapID: states[1].TrapID, Token: state.Token}} {
		if _, err = client.SendEvents(ctx, forged, []contracts.Event{event}); err == nil {
			t.Fatal("foreign identity accepted")
		}
	}
	forged := event
	forged.TrapID = states[1].TrapID
	if _, err = client.SendEvents(ctx, state, []contracts.Event{forged}); err == nil {
		t.Fatal("forged event trap accepted")
	}
	// Force a real PostgreSQL error after an earlier row in the batch was inserted.
	if _, err = db.Exec(ctx, `CREATE FUNCTION reject_be02_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.payload->>'path'='/db-failure' THEN RAISE EXCEPTION 'synthetic database failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_be02_event BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION reject_be02_event()`); err != nil {
		t.Fatal(err)
	}
	second := event
	second.EventID = uuid()
	second.Payload = map[string]any{"path": "/db-failure"}
	response, err := client.SendEvents(ctx, state, []contracts.Event{event, second})
	var statusErr *agent.HTTPStatusError
	if !errors.As(err, &statusErr) || statusErr.StatusCode != 503 || len(response.AcceptedIDs) != 0 {
		t.Fatalf("DB failure response=%+v err=%v", response, err)
	}
	var count int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM events WHERE agent_id=$1`, state.AgentID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial batch committed: %d err=%v", count, err)
	}
	if _, err = db.Exec(ctx, `DROP TRIGGER reject_be02_event ON events; DROP FUNCTION reject_be02_event()`); err != nil {
		t.Fatal(err)
	}
	if _, err = client.SendEvents(ctx, state, []contracts.Event{event, second}); err != nil {
		t.Fatal(err)
	}
	if _, err = client.SendEvents(ctx, state, []contracts.Event{event, second}); err != nil {
		t.Fatal(err)
	}
	// Invalid counters cannot be persisted or masquerade as healthy telemetry.
	telemetry.QueueDepth = -1
	if err = client.HeartbeatWithTelemetry(ctx, state, "running", telemetry); err == nil || !strings.Contains(err.Error(), "422") {
		t.Fatalf("invalid telemetry accepted: %v", err)
	}
}
