commit 9c71957c0e68401902827d344cba5ac1bf6ba8f0
Author: Анна Ардышева <ardyshevaanna@gmail.com>
Date:   Wed Oct 14 12:48:08 2026 +0000

    feat(be-04): generate audited pinned trap bundles

diff --git a/internal/control/bundle.go b/internal/control/bundle.go
new file mode 100644
index 0000000..a2c1665
--- /dev/null
+++ b/internal/control/bundle.go
@@ -0,0 +1,447 @@
+package control
+
+import (
+	"archive/zip"
+	"bytes"
+	"context"
+	"encoding/json"
+	"errors"
+	"fmt"
+	"net/http"
+	"net/url"
+	"regexp"
+	"strings"
+	"text/template"
+	"time"
+
+	"github.com/jackc/pgx/v5"
+	"honeyforge/internal/contracts"
+)
+
+var gitRevisionRE = regexp.MustCompile(`^(?:[0-9a-f]{40}|[0-9a-f]{64})$`)
+
+const defaultBundleSourceRepository = "https://github.com/fezonV/HoneyForge.git"
+
+type bundlePort struct {
+	TargetPort  int
+	Published   int
+	HostAddress string
+}
+
+type bundleManifest struct {
+	TrapID      string                        `json:"trap_id"`
+	ProfileID   string                        `json:"profile_id"`
+	Revision    int                           `json:"profile_revision"`
+	SourceRepo  string                        `json:"source_repository"`
+	SourceSHA   string                        `json:"source_revision"`
+	AgentOrigin string                        `json:"agent_origin"`
+	Ports       []contracts.DeploymentBinding `json:"ports"`
+	CreatedAt   string                        `json:"created_at"`
+}
+
+type bundleTemplateData struct {
+	AgentOrigin  string
+	TrapID       string
+	SourceRepo   string
+	SourceSHA    string
+	Ports        []bundlePort
+	NeedsBindCap bool
+}
+
+func (s *Server) downloadTrapBundle(w http.ResponseWriter, r *http.Request) {
+	trapID := r.PathValue("id")
+	if !checkID(w, r, trapID) {
+		return
+	}
+	if !validHTTPSOrigin(s.agentOrigin) || !validHTTPSRepository(s.bundleSource) || !gitRevisionRE.MatchString(s.bundleRevision) {
+		fail(w, r, 503, "bundle_unavailable", "deployment bundle settings are incomplete", nil)
+		return
+	}
+
+	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
+	defer cancel()
+	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadWrite})
+	if err != nil {
+		fail(w, r, 503, "not_ready", "deployment bundle could not be prepared", nil)
+		return
+	}
+	defer tx.Rollback(context.Background())
+
+	var name string
+	var profileID *string
+	var revision *int
+	var rawBindings, rawConfig []byte
+	err = tx.QueryRow(ctx, `SELECT name,desired_profile_id::text,desired_revision,deployment_bindings
+		FROM traps WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, trapID).Scan(&name, &profileID, &revision, &rawBindings)
+	if noRows(err) {
+		fail(w, r, 404, "not_found", "trap not found", nil)
+		return
+	}
+	if err != nil {
+		logDB(r, err)
+		fail(w, r, 503, "not_ready", "deployment bundle could not be prepared", nil)
+		return
+	}
+	if profileID == nil || revision == nil {
+		fail(w, r, 409, "profile_not_assigned", "assign a profile revision before downloading a deployment bundle", nil)
+		return
+	}
+	if err = tx.QueryRow(ctx, `SELECT config FROM profile_revisions WHERE profile_id=$1 AND revision=$2`, *profileID, *revision).Scan(&rawConfig); err != nil {
+		logDB(r, err)
+		fail(w, r, 503, "not_ready", "assigned profile revision could not be read", nil)
+		return
+	}
+	var config contracts.ProfileConfig
+	if json.Unmarshal(rawConfig, &config) != nil || len(contracts.ValidateProfile(config)) != 0 {
+		fail(w, r, 500, "invalid_profile", "assigned profile revision is invalid", nil)
+		return
+	}
+	var bindings []contracts.DeploymentBinding
+	if err = json.Unmarshal(rawBindings, &bindings); err != nil {
+		fail(w, r, 500, "invalid_bindings", "trap deployment bindings are invalid", nil)
+		return
+	}
+	if len(bindings) != len(config.Services) || len(validateBindings(bindings)) != 0 || len(bindingServices(bindings, config)) != 0 {
+		fail(w, r, 409, "binding_mismatch", "configure one valid host port for every service before downloading a deployment bundle", nil)
+		return
+	}
+
+	artifact, err := renderTrapBundle(trapID, *profileID, *revision, name, config, bindings, s.agentOrigin, s.bundleSource, s.bundleRevision)
+	if err != nil {
+		fail(w, r, 500, "bundle_failed", "deployment bundle could not be rendered", nil)
+		return
+	}
+	actor := currentActor(r)
+	if err = auditTx(ctx, tx, &actor.id, "trap.bundle_downloaded", "trap", trapID, map[string]any{
+		"profile_id": *profileID, "revision": *revision, "source_revision": s.bundleRevision,
+	}); err != nil {
+		logDB(r, err)
+		fail(w, r, 503, "not_ready", "deployment bundle access could not be audited", nil)
+		return
+	}
+	if err = tx.Commit(ctx); err != nil {
+		fail(w, r, 503, "not_ready", "deployment bundle access could not be audited", nil)
+		return
+	}
+	w.Header().Set("Content-Type", "application/zip")
+	w.Header().Set("Content-Disposition", `attachment; filename="honeyforge-trap-`+trapID+`.zip"`)
+	w.Header().Set("Cache-Control", "no-store")
+	w.Header().Set("X-HoneyForge-Profile-ID", *profileID)
+	w.Header().Set("X-HoneyForge-Profile-Revision", fmt.Sprint(*revision))
+	w.WriteHeader(200)
+	_, _ = w.Write(artifact)
+}
+
+func renderTrapBundle(trapID, profileID string, revision int, trapName string, config contracts.ProfileConfig, bindings []contracts.DeploymentBinding, agentOrigin, sourceRepo, sourceSHA string) ([]byte, error) {
+	if !contracts.ValidID(trapID) || !contracts.ValidID(profileID) || revision < 1 || !validHTTPSOrigin(agentOrigin) || !validHTTPSRepository(sourceRepo) || !gitRevisionRE.MatchString(sourceSHA) {
+		return nil, errors.New("invalid deployment bundle identity or source")
+	}
+	if len(bindings) != len(config.Services) || len(validateBindings(bindings)) != 0 || len(bindingServices(bindings, config)) != 0 {
+		return nil, errors.New("deployment bindings do not cover the profile services")
+	}
+	ports := make([]bundlePort, 0, len(config.Services))
+	bindingByService := make(map[string]contracts.DeploymentBinding, len(bindings))
+	for _, binding := range bindings {
+		bindingByService[binding.ServiceID] = binding
+	}
+	needsBindCap := false
+	for _, service := range config.Services {
+		binding := bindingByService[service.ID]
+		hostAddress := binding.BindAddress
+		if hostAddress == "" {
+			hostAddress = "0.0.0.0"
+		}
+		ports = append(ports, bundlePort{TargetPort: service.Port, Published: binding.HostPort, HostAddress: hostAddress})
+		if service.Port < 1024 {
+			needsBindCap = true
+		}
+	}
+	configJSON, err := json.MarshalIndent(contracts.ProfileConfig{
+		TemplateID: config.TemplateID, Level: config.Level, Services: config.Services,
+		VisibleTexts: config.VisibleTexts, SyntheticCredentials: config.SyntheticCredentials,
+		FakeFS: config.FakeFS, Logging: config.Logging, Channel: config.Channel,
+	}, "", "  ")
+	if err != nil {
+		return nil, err
+	}
+	decoyConfig, err := json.MarshalIndent(map[string]any{
+		"trap_id": trapID, "profile_id": profileID, "revision": revision, "config": json.RawMessage(configJSON),
+	}, "", "  ")
+	if err != nil {
+		return nil, err
+	}
+	portsJSON, err := json.Marshal(bindings)
+	if err != nil {
+		return nil, err
+	}
+	manifest, err := json.MarshalIndent(bundleManifest{
+		TrapID: trapID, ProfileID: profileID, Revision: revision, SourceRepo: sourceRepo,
+		SourceSHA: sourceSHA, AgentOrigin: agentOrigin, Ports: bindings, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
+	}, "", "  ")
+	if err != nil {
+		return nil, err
+	}
+	compose, err := renderBundleCompose(bundleTemplateData{
+		AgentOrigin: agentOrigin, TrapID: trapID, SourceRepo: sourceRepo, SourceSHA: sourceSHA,
+		Ports: ports, NeedsBindCap: needsBindCap,
+	})
+	if err != nil {
+		return nil, err
+	}
+	install := renderBundleInstaller(agentOrigin, trapID, sourceRepo, sourceSHA)
+	readme := renderBundleReadme(trapName, trapID, profileID, revision, bindings, agentOrigin, sourceSHA)
+	return zipBundle(map[string]bundleFile{
+		"compose.yaml":             {data: compose},
+		"decoy-config.json":        {data: decoyConfig},
+		"manifest.json":            {data: manifest},
+		"install.sh":               {data: []byte(install), mode: 0755},
+		"README.txt":               {data: []byte(readme)},
+		"deployment-bindings.json": {data: portsJSON},
+	})
+}
+
+func validHTTPSOrigin(raw string) bool {
+	u, err := url.Parse(raw)
+	return err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil && u.Path == "" && u.RawQuery == "" && u.Fragment == ""
+}
+
+func validHTTPSRepository(raw string) bool {
+	u, err := url.Parse(raw)
+	return err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil && u.Path != "" && u.RawQuery == "" && u.Fragment == ""
+}
+
+func renderBundleCompose(data bundleTemplateData) ([]byte, error) {
+	const source = `services:
+  agent:
+    build:
+      context: ./source
+      dockerfile: Dockerfile.agent
+    command:
+      - "-center"
+      - {{q .AgentOrigin}}
+      - "-trap"
+      - {{q .TrapID}}
+      - "-enrollment-token-file"
+      - "/run/secrets/enrollment_token"
+      - "-ipc-token-file"
+      - "/run/secrets/decoy_agent_ipc_token"
+      - "-decoy-token-file"
+      - "/run/secrets/agent_decoy_ipc_token"
+    environment:
+      HF_AGENT_IPC_LISTEN: "0.0.0.0:9101"
+      HF_AGENT_STATE: "/var/lib/honeyforge/agent-state.json"
+      HF_AGENT_QUEUE: "/var/lib/honeyforge/agent-events.sqlite"
+      HF_DECOY_ADMIN_URL: "http://decoy:9100"
+    secrets: [enrollment_token, decoy_agent_ipc_token, agent_decoy_ipc_token]
+    volumes: [agent_state:/var/lib/honeyforge]
+    networks: [management, ipc]
+    read_only: true
+    tmpfs: ["/tmp:rw,noexec,nosuid,size=16m"]
+    cap_drop: [ALL]
+    security_opt: [no-new-privileges:true]
+    mem_limit: 512m
+    cpus: 1.0
+    pids_limit: 128
+    healthcheck:
+      test: ["CMD-SHELL", "kill -0 1"]
+      interval: 10s
+      timeout: 3s
+      retries: 3
+    restart: unless-stopped
+
+  decoy:
+    build:
+      context: ./source
+      dockerfile: Dockerfile.decoy
+{{if .NeedsBindCap}}    cap_add: [NET_BIND_SERVICE]
+{{end}}    command:
+      - "-bind"
+      - "0.0.0.0"
+      - "-admin-listen"
+      - "0.0.0.0:9100"
+      - "-admin-token-file"
+      - "/run/secrets/agent_decoy_ipc_token"
+      - "-agent-url"
+      - "http://agent:9101"
+      - "-agent-token-file"
+      - "/run/secrets/decoy_agent_ipc_token"
+    secrets: [decoy_agent_ipc_token, agent_decoy_ipc_token]
+    volumes:
+      - ./decoy-config.json:/etc/honeyforge/decoy-config.json:ro
+      - decoy_state:/var/lib/honeyforge
+    ports:
+{{range .Ports}}      - target: {{.TargetPort}}
+        published: {{q (printf "%d" .Published)}}
+        host_ip: {{q .HostAddress}}
+        protocol: tcp
+{{end}}    networks: [ipc, attack]
+    read_only: true
+    tmpfs: ["/tmp:rw,noexec,nosuid,size=16m"]
+    cap_drop: [ALL]
+    security_opt: [no-new-privileges:true]
+    mem_limit: 512m
+    cpus: 1.0
+    pids_limit: 128
+    depends_on:
+      agent:
+        condition: service_healthy
+    healthcheck:
+      test: ["CMD-SHELL", "kill -0 1"]
+      interval: 10s
+      timeout: 3s
+      retries: 3
+    restart: unless-stopped
+
+volumes:
+  agent_state:
+  decoy_state:
+
+secrets:
+  enrollment_token:
+    file: ./secrets/enrollment_token
+  decoy_agent_ipc_token:
+    file: ./secrets/decoy_agent_ipc_token
+  agent_decoy_ipc_token:
+    file: ./secrets/agent_decoy_ipc_token
+
+networks:
+  ipc:
+    internal: true
+  attack:
+    internal: true
+  management:
+    driver: bridge
+`
+	t, err := template.New("compose").Funcs(template.FuncMap{"q": yamlQuote}).Parse(source)
+	if err != nil {
+		return nil, err
+	}
+	var output bytes.Buffer
+	if err = t.Execute(&output, data); err != nil {
+		return nil, err
+	}
+	return output.Bytes(), nil
+}
+
+func yamlQuote(value string) string {
+	encoded, _ := json.Marshal(value)
+	return string(encoded)
+}
+
+func renderBundleInstaller(agentOrigin, trapID, sourceRepo, sourceSHA string) string {
+	return fmt.Sprintf(`#!/bin/sh
+set -eu
+cd "$(dirname "$0")"
+
+if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
+	printf 'Docker Engine with the Compose plugin is required.\n' >&2
+	exit 1
+fi
+if ! command -v git >/dev/null 2>&1 || ! command -v openssl >/dev/null 2>&1 || ! command -v stty >/dev/null 2>&1; then
+	printf 'git, openssl, and stty are required.\n' >&2
+	exit 1
+fi
+if [ ! -t 0 ]; then
+	printf 'Run this installer from an interactive terminal so the enrollment token is not echoed.\n' >&2
+	exit 1
+fi
+
+mkdir -p secrets
+chmod 0700 secrets
+if [ -e secrets/enrollment_token ]; then
+	printf 'secrets/enrollment_token already exists; remove it before installing a fresh enrollment.\n' >&2
+	exit 1
+fi
+umask 077
+printf 'Issue a fresh one-time enrollment token in the HoneyForge operator UI/API.\n'
+printf 'Paste the token here; it is not part of this bundle: '
+terminal_state=$(stty -g)
+restore_terminal() { stty "$terminal_state" 2>/dev/null || true; }
+trap restore_terminal EXIT HUP INT TERM
+stty -echo
+if ! IFS= read -r enrollment_token; then
+	printf '\n' >&2
+	exit 1
+fi
+stty "$terminal_state"
+trap - EXIT HUP INT TERM
+printf '\n'
+if [ -z "$enrollment_token" ]; then
+	printf 'Enrollment token is required.\n' >&2
+	exit 1
+fi
+printf '%%s' "$enrollment_token" > secrets/enrollment_token
+unset enrollment_token
+openssl rand -hex 32 > secrets/decoy_agent_ipc_token
+openssl rand -hex 32 > secrets/agent_decoy_ipc_token
+chmod 0444 secrets/enrollment_token secrets/decoy_agent_ipc_token secrets/agent_decoy_ipc_token
+
+if [ ! -d source/.git ]; then
+	git clone --quiet --no-checkout %s source
+fi
+git -C source fetch --quiet --depth 1 origin %s
+git -C source checkout --quiet --detach %s
+test "$(git -C source rev-parse HEAD)" = %s
+
+docker compose -f compose.yaml up --build -d
+printf 'Bundle started. Confirm agent registration and applied profile in HoneyForge before treating the trap as online.\n'
+`, shellQuote(sourceRepo), shellQuote(sourceSHA), shellQuote(sourceSHA), shellQuote(sourceSHA))
+}
+
+func shellQuote(value string) string {
+	return "'" + strings.ReplaceAll(value, "'", "'\"'\"'") + "'"
+}
+
+func renderBundleReadme(trapName, trapID, profileID string, revision int, bindings []contracts.DeploymentBinding, agentOrigin, sourceSHA string) string {
+	var out strings.Builder
+	fmt.Fprintf(&out, "HoneyForge deployment bundle\n\nTrap: %s (%s)\nProfile: %s, revision %d\nControl agent origin: %s\nRuntime source commit: %s\n\n", trapName, trapID, profileID, revision, agentOrigin, sourceSHA)
+	out.WriteString("This archive contains a decoy configuration and a Compose manifest. It does not contain an enrollment token. The installer prompts for a fresh one-time token and generates separate random secrets for the private agent/decoy IPC channels. The assigned profile includes synthetic visitor credentials; keep this archive operator-only.\n\n")
+	out.WriteString("Before starting, prepare a host with Docker Engine, the Docker Compose plugin, git, openssl, and outbound HTTPS access to the configured HoneyForge agent origin, the source repository, Docker image registries, and the Go module proxy. Open only the visitor ports listed below in the host firewall. The default bind address 0.0.0.0 listens on every host interface.\n\nVisitor port bindings (host -> container):\n")
+	for _, binding := range bindings {
+		address := binding.BindAddress
+		if address == "" {
+			address = "0.0.0.0"
+		}
+		fmt.Fprintf(&out, "- %s:%d\n", address, binding.HostPort)
+	}
+	out.WriteString("\nRun ./install.sh and enter a newly issued enrollment token when prompted. After the agent registers, queue an apply_profile command for the assigned revision and verify its applied status in HoneyForge. The bootstrap config already uses that revision; the command records the decoy's IPC confirmation in the center. Downloading this archive alone does not deploy or register the trap.\n\nTo stop the services, run `docker compose -f compose.yaml down`. Agent state, queued events, and applied decoy configuration are stored in named volumes. Removing those volumes with `down -v` deletes local state. After the one-time token is consumed, remove `secrets/enrollment_token` from the host and rotate it if a fresh enrollment is needed.\n")
+	return out.String()
+}
+
+type bundleFile struct {
+	data []byte
+	mode uint32
+}
+
+func zipBundle(files map[string]bundleFile) ([]byte, error) {
+	var output bytes.Buffer
+	archive := zip.NewWriter(&output)
+	for _, name := range []string{"compose.yaml", "decoy-config.json", "deployment-bindings.json", "manifest.json", "install.sh", "README.txt"} {
+		file, ok := files[name]
+		if !ok {
+			continue
+		}
+		mode := file.mode
+		if mode == 0 {
+			mode = 0644
+		}
+		header := &zip.FileHeader{Name: name, Method: zip.Deflate, Modified: time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC)}
+		header.SetMode(0644)
+		if mode == 0755 {
+			header.SetMode(0755)
+		}
+		writer, err := archive.CreateHeader(header)
+		if err != nil {
+			_ = archive.Close()
+			return nil, err
+		}
+		if _, err = writer.Write(file.data); err != nil {
+			_ = archive.Close()
+			return nil, err
+		}
+	}
+	if err := archive.Close(); err != nil {
+		return nil, err
+	}
+	return output.Bytes(), nil
+}
