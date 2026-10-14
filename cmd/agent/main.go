package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
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
	ipcListen := flag.String("ipc-listen", envOr("HF_AGENT_IPC_LISTEN", "127.0.0.1:9101"), "private listener for decoy telemetry")
	ipcToken := flag.String("ipc-token", os.Getenv("HF_DECOY_AGENT_IPC_TOKEN"), "shared secret for local decoy-to-agent telemetry IPC")
	decoyToken := flag.String("decoy-token", os.Getenv("HF_AGENT_DECOY_IPC_TOKEN"), "shared secret for local agent-to-decoy administration")
	decoyURL := flag.String("decoy-admin", os.Getenv("HF_DECOY_ADMIN_URL"), "private decoy administration URL")
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

	var ipcServer *http.Server
	if *ipcToken != "" {
		ipcServer = &http.Server{Addr: *ipcListen, Handler: agent.IPCHandler(queue, state, *ipcToken), ReadHeaderTimeout: 5 * time.Second}
		go func() {
			log.Printf("agent telemetry IPC listening on %s", *ipcListen)
			if serveErr := ipcServer.ListenAndServe(); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
				log.Printf("agent telemetry IPC stopped: %v", serveErr)
				stop()
			}
		}()
		defer func() {
			shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			_ = ipcServer.Shutdown(shutdownCtx)
		}()
	}

	if err = syncConfig(ctx, client, state, *statePath); err != nil {
		log.Printf("initial configuration sync failed: %v", err)
	}
	syncTicker := time.NewTicker(2 * time.Second)
	heartbeatTicker := time.NewTicker(5 * time.Second)
	deliveryTicker := time.NewTicker(1 * time.Second)
	commandTicker := time.NewTicker(2 * time.Second)
	defer syncTicker.Stop()
	defer heartbeatTicker.Stop()
	defer deliveryTicker.Stop()
	defer commandTicker.Stop()
	var metrics agent.DeliveryMetrics
	var adapter agent.DecoyAdapter = agent.RejectingAdapter{}
	if *decoyURL != "" {
		if *decoyToken == "" {
			log.Fatal("HF_AGENT_DECOY_IPC_TOKEN is required when decoy administration is enabled")
		}
		adapter, err = agent.NewHTTPDecoyAdapter(*decoyURL, *decoyToken)
		if err != nil {
			log.Fatalf("configure decoy adapter: %v", err)
		}
		if state.ConfigSnapshot() != nil && ipcServer == nil {
			log.Printf("decoy commands are enabled but the event IPC token is missing")
		}
	}
	if err = sendHeartbeat(ctx, client, state, adapter); err != nil {
		log.Printf("initial heartbeat failed: %v", err)
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-syncTicker.C:
			if err = syncConfig(ctx, client, state, *statePath); err != nil {
				log.Printf("configuration sync failed: %v", err)
				continue
			}
			config := state.ConfigSnapshot()
			if config == nil {
				log.Printf("configuration sync returned no configuration")
				continue
			}
			log.Printf("desired configuration is revision %d for trap %s", config.Revision, state.TrapID)
			syncTicker.Reset(time.Duration(config.Config.Channel.SyncSeconds) * time.Second)
			heartbeatTicker.Reset(time.Duration(config.Config.Channel.HeartbeatSeconds) * time.Second)
		case <-heartbeatTicker.C:
			if err = sendHeartbeat(ctx, client, state, adapter); err != nil {
				log.Printf("heartbeat failed: %v", err)
			}
		case <-deliveryTicker.C:
			flushCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
			if err = queue.Flush(flushCtx, client, state, 100, &metrics); err != nil {
				log.Printf("telemetry delivery failed: %v", err)
			}
			cancel()
		case <-commandTicker.C:
			commandCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
			if err = agent.ProcessCommands(commandCtx, client, state, adapter); err != nil {
				log.Printf("command processing failed: %v", err)
			}
			cancel()
		}
	}
}

type configFetcher interface {
	FetchConfig(context.Context, *agent.State) (*agent.ConfigResponse, error)
}

func syncConfig(ctx context.Context, client configFetcher, state *agent.State, statePath string) error {
	requestCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	config, err := client.FetchConfig(requestCtx, state)
	if err != nil {
		return err
	}
	previous := state.ConfigSnapshot()
	if previous != nil && previous.ProfileID == config.ProfileID && previous.Revision == config.Revision {
		return nil
	}
	candidate := &agent.State{AgentID: state.AgentID, TrapID: state.TrapID, Token: state.Token, Config: config}
	if err = agent.SaveState(statePath, candidate); err != nil {
		return err
	}
	state.SetConfig(config)
	return nil
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func sendHeartbeat(ctx context.Context, client *agent.Client, state *agent.State, adapter agent.DecoyAdapter) error {
	requestCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	serviceState, err := adapter.ServiceState(requestCtx)
	if err != nil {
		serviceState = "error"
	}
	return client.Heartbeat(requestCtx, state, serviceState)
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
