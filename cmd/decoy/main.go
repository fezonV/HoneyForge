package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"honeyforge/internal/decoy"
)

func main() {
	configPath := flag.String("config", os.Getenv("HF_DECOY_CONFIG"), "path to the applied profile JSON")
	publicBind := flag.String("bind", envOr("HF_DECOY_BIND", "127.0.0.1"), "address on which public decoy HTTP services listen")
	adminAddr := flag.String("admin-listen", envOr("HF_DECOY_ADMIN_LISTEN", "127.0.0.1:9100"), "private agent administration listener")
	adminToken := flag.String("admin-token", os.Getenv("HF_AGENT_DECOY_IPC_TOKEN"), "shared secret for local agent to control the decoy")
	agentURL := flag.String("agent-url", envOr("HF_AGENT_IPC_URL", "http://127.0.0.1:9101"), "local agent event IPC origin")
	agentToken := flag.String("agent-token", os.Getenv("HF_DECOY_AGENT_IPC_TOKEN"), "shared secret for decoy to submit telemetry to the agent")
	flag.Parse()
	if *configPath == "" {
		log.Fatal("-config or HF_DECOY_CONFIG is required")
	}
	if *adminToken == "" {
		*adminToken = makeIPCSecret()
		log.Printf("generated agent-to-decoy IPC token for this process: %s", *adminToken)
	}
	if *agentToken == "" {
		*agentToken = makeIPCSecret()
		log.Printf("generated decoy-to-agent telemetry token for this process: %s", *agentToken)
	}
	data, err := os.ReadFile(*configPath)
	if err != nil {
		log.Fatalf("read decoy configuration: %v", err)
	}
	var cfg decoy.Configuration
	if err = json.Unmarshal(data, &cfg); err != nil {
		log.Fatalf("decode decoy configuration: %v", err)
	}
	sink, err := decoy.NewHTTPAgentSink(*agentURL, *agentToken)
	if err != nil {
		log.Fatalf("configure telemetry sink: %v", err)
	}
	server, err := decoy.New(cfg, sink)
	if err != nil {
		log.Fatalf("validate decoy configuration: %v", err)
	}
	server.SetRunning(true)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	admin := &http.Server{Addr: *adminAddr, Handler: server.AdminHandler(*adminToken), ReadHeaderTimeout: 5 * time.Second}
	go serve(ctx, admin, "private decoy administration")
	listeners := make([]net.Listener, 0, len(cfg.Config.Services))
	for _, service := range cfg.Config.Services {
		listener, listenErr := net.Listen("tcp", net.JoinHostPort(*publicBind, fmt.Sprint(service.Port)))
		if listenErr != nil {
			closeListeners(listeners)
			log.Fatalf("bind decoy service %s: %v", service.ID, listenErr)
		}
		listeners = append(listeners, listener)
	}
	go watchConfiguration(ctx, *configPath, server)
	for i, service := range cfg.Config.Services {
		httpServer := &http.Server{Handler: server.PublicHandler(service.ID), ReadHeaderTimeout: 5 * time.Second}
		go serveListener(ctx, httpServer, listeners[i], service.ID)
		log.Printf("decoy service %s listening on %s", service.ID, listeners[i].Addr())
	}
	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = admin.Shutdown(shutdownCtx)
	closeListeners(listeners)
}

func watchConfiguration(ctx context.Context, path string, server *decoy.Server) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			data, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			var next decoy.Configuration
			if json.Unmarshal(data, &next) != nil {
				continue
			}
			current := server.Snapshot()
			if next.ProfileID == current.ProfileID && next.Revision == current.Revision {
				continue
			}
			if err = server.Apply(next); err != nil {
				log.Printf("reload decoy profile revision %d: %v", next.Revision, err)
				continue
			}
			log.Printf("loaded decoy profile %s revision %s", next.ProfileID, strconv.Itoa(next.Revision))
		}
	}
}

func serve(ctx context.Context, server *http.Server, name string) {
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Printf("%s stopped: %v", name, err)
	}
}

func serveListener(ctx context.Context, server *http.Server, listener net.Listener, name string) {
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Printf("decoy service %s stopped: %v", name, err)
	}
}

func closeListeners(listeners []net.Listener) {
	for _, listener := range listeners {
		_ = listener.Close()
	}
}
func envOr(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
func makeIPCSecret() string {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		log.Fatalf("generate IPC token: %v", err)
	}
	return hex.EncodeToString(value)
}
