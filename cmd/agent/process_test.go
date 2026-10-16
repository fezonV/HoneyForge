package main

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"honeyforge/internal/agent"
	"honeyforge/internal/contracts"
)

func TestAgentProcessCrashRetainsAcknowledgedIPCEvents(t *testing.T) {
	if testing.Short() {
		t.Skip("agent binary crash/restart acceptance")
	}
	dir := t.TempDir()
	binary := filepath.Join(dir, "agent")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	build := exec.Command(filepath.Join(runtime.GOROOT(), "bin", "go"), "build", "-o", binary, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build agent: %v\n%s", err, output)
	}
	state := &agent.State{AgentID: "11111111-1111-4111-8111-111111111111", TrapID: "22222222-2222-4222-8222-222222222222", Token: "agent-test-token"}
	statePath := filepath.Join(dir, "state.json")
	if err := agent.SaveState(statePath, state); err != nil {
		t.Fatal(err)
	}
	var online atomic.Bool
	var mu sync.Mutex
	stored := map[string]bool{}
	center := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !online.Load() {
			w.WriteHeader(503)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/events") {
			var body struct {
				Events []contracts.Event `json:"events"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			result := agent.EventSendResponse{AcceptedIDs: []string{}, DuplicateIDs: []string{}}
			mu.Lock()
			for _, event := range body.Events {
				if stored[event.EventID] {
					result.DuplicateIDs = append(result.DuplicateIDs, event.EventID)
				} else {
					stored[event.EventID] = true
					result.AcceptedIDs = append(result.AcceptedIDs, event.EventID)
				}
			}
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(result)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/heartbeat") {
			_ = json.NewEncoder(w).Encode(map[string]string{"trap_id": state.TrapID, "agent_status": "online", "last_seen": time.Now().UTC().Format(time.RFC3339Nano)})
			return
		}
		w.WriteHeader(503)
	}))
	defer center.Close()
	caPath := filepath.Join(dir, "ca.pem")
	if err := os.WriteFile(caPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: center.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := listener.Addr().String()
	_ = listener.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	request := func(method, path, body string) (int, []byte) {
		req, _ := http.NewRequestWithContext(ctx, method, "http://"+addr+path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer ipc-test-token")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			return 0, nil
		}
		defer res.Body.Close()
		data, _ := io.ReadAll(res.Body)
		return res.StatusCode, data
	}
	var process *exec.Cmd
	stop := func() {
		if process != nil && process.Process != nil {
			_ = process.Process.Kill()
			_ = process.Wait()
			process = nil
		}
	}
	defer stop()
	start := func() {
		t.Helper()
		process = exec.CommandContext(ctx, binary, "-center", center.URL, "-ca-file", caPath, "-state", statePath, "-queue", filepath.Join(dir, "events.sqlite"), "-ipc-listen", addr, "-ipc-token", "ipc-test-token")
		if err := process.Start(); err != nil {
			t.Fatal(err)
		}
		for ctx.Err() == nil {
			if code, _ := request("GET", "/v1/status", ""); code == 200 {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatal("agent IPC did not start")
	}
	start()
	for half := 0; half < 2; half++ {
		for i := 0; i < 50; i++ {
			event := contracts.Event{SchemaVersion: "1.0", EventID: fmt.Sprintf("44444444-4444-4444-8444-%012d", half*50+i), ServiceID: "web", EventType: "http.request", Timestamp: time.Now().UTC().Format(time.RFC3339Nano), DestinationPort: 8080, Protocol: "http", Payload: map[string]any{"path": "/synthetic"}}
			body, _ := json.Marshal(event)
			if code, data := request("POST", "/v1/events", string(body)); code != 202 {
				t.Fatalf("IPC ACK=%d %s", code, data)
			}
		}
		if half == 0 {
			stop() // SIGKILL: no graceful queue close or checkpoint.
			start()
			_, body := request("GET", "/v1/status", "")
			var status contracts.AgentTelemetry
			if err := json.Unmarshal(body, &status); err != nil || status.QueueDepth != 50 {
				t.Fatalf("crash recovery status=%s err=%v", body, err)
			}
		}
	}
	online.Store(true)
	for ctx.Err() == nil {
		_, body := request("GET", "/v1/status", "")
		var status contracts.AgentTelemetry
		if json.Unmarshal(body, &status) == nil && status.QueueDepth == 0 {
			mu.Lock()
			count := len(stored)
			mu.Unlock()
			if count != 100 {
				t.Fatalf("delivered %d events after crash, want 100", count)
			}
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("agent did not drain durable queue after reconnect")
}
