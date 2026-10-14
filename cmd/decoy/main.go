package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
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
	adminTokenFile := flag.String("admin-token-file", os.Getenv("HF_AGENT_DECOY_IPC_TOKEN_FILE"), "file containing the agent-to-decoy IPC secret")
	agentURL := flag.String("agent-url", envOr("HF_AGENT_IPC_URL", "http://127.0.0.1:9101"), "local agent event IPC origin")
	agentToken := flag.String("agent-token", os.Getenv("HF_DECOY_AGENT_IPC_TOKEN"), "shared secret for decoy to submit telemetry to the agent")
	agentTokenFile := flag.String("agent-token-file", os.Getenv("HF_DECOY_AGENT_IPC_TOKEN_FILE"), "file containing the decoy-to-agent IPC secret")
	flag.Parse()
	if *configPath == "" {
		log.Fatal("-config or HF_DECOY_CONFIG is required")
	}
	adminSecret, err := readSecret(*adminToken, *adminTokenFile)
	if err != nil {
		log.Fatal("-admin-token or HF_AGENT_DECOY_IPC_TOKEN is required")
	}
	*adminToken = adminSecret
	agentSecret, err := readSecret(*agentToken, *agentTokenFile)
	if err != nil {
		log.Fatal("-agent-token or HF_DECOY_AGENT_IPC_TOKEN is required")
	}
	*agentToken = agentSecret
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
	store, err := decoy.NewFileConfigurationStore(*configPath)
	if err != nil {
		log.Fatalf("configure durable decoy profile storage: %v", err)
	}
	server, err := decoy.NewWithStore(cfg, sink, store)
	if err != nil {
		log.Fatalf("validate decoy configuration: %v", err)
	}

	// Bind every listener before serving any traffic so startup is all-or-nothing.
	adminListener, err := net.Listen("tcp", *adminAddr)
	if err != nil {
		log.Fatalf("bind private decoy administration: %v", err)
	}
	listeners := make([]net.Listener, 0, len(cfg.Config.Services))
	for _, service := range cfg.Config.Services {
		listener, listenErr := net.Listen("tcp", net.JoinHostPort(*publicBind, fmt.Sprint(service.Port)))
		if listenErr != nil {
			closeListeners(listeners)
			_ = adminListener.Close()
			log.Fatalf("bind decoy service %s: %v", service.ID, listenErr)
		}
		listeners = append(listeners, listener)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	server.SetRunning(true)
	admin := &http.Server{Handler: server.AdminHandler(*adminToken), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 << 10}
	go serveListener(ctx, stop, admin, adminListener, "private decoy administration")
	for i, service := range cfg.Config.Services {
		httpServer := &http.Server{Handler: server.PublicHandler(service.ID), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 << 10, ConnContext: server.ConnectionContext(service.ID)}
		go serveListener(ctx, stop, httpServer, listeners[i], service.ID)
		log.Printf("decoy service %s listening on %s", service.ID, listeners[i].Addr())
	}
	<-ctx.Done()
	server.SetRunning(false)
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = admin.Shutdown(shutdownCtx)
	closeListeners(listeners)
	_ = adminListener.Close()
}

func serveListener(ctx context.Context, stop context.CancelFunc, server *http.Server, listener net.Listener, name string) {
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Printf("decoy service %s stopped: %v", name, err)
		stop()
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

func readSecret(value, path string) (string, error) {
	if path == "" {
		if value == "" {
			return "", errors.New("secret is empty")
		}
		return value, nil
	}
	data, err := os.ReadFile(path)
	if err != nil || len(data) > 4096 {
		return "", errors.New("secret file unavailable")
	}
	secret := strings.TrimSpace(string(data))
	if secret == "" {
		return "", errors.New("secret file is empty")
	}
	return secret, nil
}
