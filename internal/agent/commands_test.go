package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"honeyforge/internal/contracts"
)

func TestCommandResultSurvivesLostACKAndRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "agent.sqlite")
	q, err := OpenQueue(path, 10)
	if err != nil {
		t.Fatal(err)
	}
	state := &State{AgentID: "11111111-1111-4111-8111-111111111111", TrapID: "22222222-2222-4222-8222-222222222222", Token: "secret"}
	command := contracts.Command{ID: "33333333-3333-4333-8333-333333333333", TrapID: state.TrapID, Type: "stop", ExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano)}
	loseACK := true
	reports := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "GET" {
			_ = json.NewEncoder(w).Encode(map[string]any{"items": []contracts.Command{command}})
			return
		}
		var result CommandResult
		if err := json.NewDecoder(r.Body).Decode(&result); err != nil {
			t.Error(err)
		}
		if result.Status != "applied" {
			t.Errorf("result=%+v", result)
		}
		reports++
		if loseACK {
			w.WriteHeader(503)
			return
		}
		_ = json.NewEncoder(w).Encode(result)
	}))
	defer server.Close()
	client := &Client{baseURL: server.URL, http: server.Client()}
	adapter := &fakeAdapter{}
	if err = ProcessCommands(ctx, client, state, adapter, q); err == nil {
		t.Fatal("lost result ACK was ignored")
	}
	if err = q.Close(); err != nil {
		t.Fatal(err)
	}
	q, err = OpenQueue(path, 10)
	if err != nil {
		t.Fatal(err)
	}
	defer q.Close()
	loseACK = false
	if err = ProcessCommands(ctx, client, state, adapter, q); err != nil {
		t.Fatal(err)
	}
	if adapter.stopped != 1 || reports != 2 {
		t.Fatalf("stop calls=%d reports=%d", adapter.stopped, reports)
	}
	// An ID is immutable even if a compromised or broken center reuses it.
	command.Type = "start"
	if err = ProcessCommands(ctx, client, state, adapter, q); err == nil || adapter.started != 0 {
		t.Fatalf("changed command: err=%v start=%d", err, adapter.started)
	}
}

func TestExpiredAndInterruptedCommandsNeverExecute(t *testing.T) {
	for _, interrupted := range []bool{false, true} {
		t.Run(fmt.Sprint(interrupted), func(t *testing.T) {
			q, err := OpenQueue(filepath.Join(t.TempDir(), "agent.sqlite"), 10)
			if err != nil {
				t.Fatal(err)
			}
			defer q.Close()
			state := &State{AgentID: "agent", TrapID: "trap", Token: "secret"}
			expires := time.Now().Add(-time.Second)
			if interrupted {
				expires = time.Now().Add(time.Minute)
			}
			command := contracts.Command{ID: "33333333-3333-4333-8333-333333333333", TrapID: state.TrapID, Type: "start", ExpiresAt: expires.UTC().Format(time.RFC3339Nano)}
			if interrupted {
				if _, err = q.claimCommand(context.Background(), state.AgentID, command, expires); err != nil {
					t.Fatal(err)
				}
			}
			var reported CommandResult
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == "GET" {
					_ = json.NewEncoder(w).Encode(map[string]any{"items": []contracts.Command{command}})
					return
				}
				_ = json.NewDecoder(r.Body).Decode(&reported)
				_ = json.NewEncoder(w).Encode(reported)
			}))
			defer server.Close()
			adapter := &fakeAdapter{}
			if err = ProcessCommands(context.Background(), &Client{baseURL: server.URL, http: server.Client()}, state, adapter, q); err != nil {
				t.Fatal(err)
			}
			if adapter.started != 0 || reported.Status != "failed" || reported.Error == "" {
				t.Fatalf("started=%d result=%+v", adapter.started, reported)
			}
		})
	}
}

func TestManagementRedirectCannotDowngradeTLS(t *testing.T) {
	called := false
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	defer plain.Close()
	secure := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, plain.URL, http.StatusTemporaryRedirect)
	}))
	defer secure.Close()
	client := &Client{baseURL: secure.URL, http: secure.Client()}
	client.http.CheckRedirect = rejectRedirect
	_, err := client.Enroll(context.Background(), "trap", "enrollment-secret")
	if err == nil || called || !strings.Contains(err.Error(), "redirect") {
		t.Fatalf("err=%v downgraded=%v", err, called)
	}
}
