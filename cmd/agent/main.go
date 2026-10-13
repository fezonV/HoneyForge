package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"honeyforge/internal/agent"
)

func main() {
	centerURL := flag.String("center", "", "HTTPS origin of the HoneyForge control center")
	trapID := flag.String("trap", "", "trap UUID (required only for first enrollment)")
	enrollmentToken := flag.String("enrollment-token", "", "one-time enrollment token (required only for first enrollment)")
	statePath := flag.String("state", defaultStatePath(), "private path for persistent agent credentials and config")
	queuePath := flag.String("queue", defaultQueuePath(), "private SQLite path for pending telemetry")
	flag.Parse()

	if *centerURL == "" {
		log.Fatal("-center is required and must be an HTTPS origin")
	}
	client, err := agent.NewClient(*centerURL)
	if err != nil {
		log.Fatal(err)
	}
	queue, err := agent.OpenQueue(*queuePath, 10000)
	if err != nil {
		log.Fatalf("open event queue: %v", err)
	}
	defer queue.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	state, err := agent.LoadState(*statePath)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			log.Fatalf("load agent state: %v", err)
		}
		if *trapID == "" || *enrollmentToken == "" {
			log.Fatal("first run requires -trap and -enrollment-token")
		}
		state, err = client.Enroll(ctx, *trapID, *enrollmentToken)
		if err != nil {
			log.Fatalf("enroll agent: %v", err)
		}
		if err = agent.SaveState(*statePath, state); err != nil {
			log.Fatalf("save enrolled credentials: %v", err)
		}
		log.Printf("agent enrolled for trap %s; credential saved to %s", state.TrapID, *statePath)
	} else if *trapID != "" || *enrollmentToken != "" {
		log.Fatal("agent is already enrolled; do not pass enrollment credentials again")
	}

	if err = syncConfig(ctx, client, state, *statePath); err != nil {
		log.Printf("initial configuration sync failed: %v", err)
	}
	if err = sendHeartbeat(ctx, client, state); err != nil {
		log.Printf("initial heartbeat failed: %v", err)
	}
	syncTicker := time.NewTicker(2 * time.Second)
	heartbeatTicker := time.NewTicker(5 * time.Second)
	deliveryTicker := time.NewTicker(1 * time.Second)
	defer syncTicker.Stop()
	defer heartbeatTicker.Stop()
	defer deliveryTicker.Stop()
	var metrics agent.DeliveryMetrics
	for {
		select {
		case <-ctx.Done():
			return
		case <-syncTicker.C:
			if err = syncConfig(ctx, client, state, *statePath); err != nil {
				log.Printf("configuration sync failed: %v", err)
				continue
			}
			log.Printf("desired configuration is revision %d for trap %s", state.Config.Revision, state.TrapID)
			syncTicker.Reset(time.Duration(state.Config.Config.Channel.SyncSeconds) * time.Second)
			heartbeatTicker.Reset(time.Duration(state.Config.Config.Channel.HeartbeatSeconds) * time.Second)
		case <-heartbeatTicker.C:
			if err = sendHeartbeat(ctx, client, state); err != nil {
				log.Printf("heartbeat failed: %v", err)
			}
		case <-deliveryTicker.C:
			flushCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
			if err = queue.Flush(flushCtx, client, state, 100, &metrics); err != nil {
				log.Printf("telemetry delivery failed: %v", err)
			}
			cancel()
		}
	}
}

func syncConfig(ctx context.Context, client *agent.Client, state *agent.State, statePath string) error {
	requestCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	config, err := client.FetchConfig(requestCtx, state)
	if err != nil {
		return err
	}
	state.Config = config
	return agent.SaveState(statePath, state)
}

func sendHeartbeat(ctx context.Context, client *agent.Client, state *agent.State) error {
	requestCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return client.Heartbeat(requestCtx, state, "unknown")
}

func defaultStatePath() string {
	if path := os.Getenv("HF_AGENT_STATE"); path != "" {
		return path
	}
	configDir, err := os.UserConfigDir()
	if err != nil {
		return filepath.Join(".", "honeyforge-agent.json")
	}
	return filepath.Join(configDir, "honeyforge", "agent-state.json")
}

func defaultQueuePath() string {
	if path := os.Getenv("HF_AGENT_QUEUE"); path != "" {
		return path
	}
	configDir, err := os.UserConfigDir()
	if err != nil {
		return filepath.Join(".", "honeyforge-agent.sqlite")
	}
	return filepath.Join(configDir, "honeyforge", "agent-events.sqlite")
}
