commit 9c71957c0e68401902827d344cba5ac1bf6ba8f0
Author: Анна Ардышева <ardyshevaanna@gmail.com>
Date:   Wed Oct 14 12:48:08 2026 +0000

    feat(be-04): generate audited pinned trap bundles

diff --git a/cmd/agent/main.go b/cmd/agent/main.go
index 4695010..a4a5b2b 100644
--- a/cmd/agent/main.go
+++ b/cmd/agent/main.go
@@ -9,6 +9,7 @@ import (
 	"os"
 	"os/signal"
 	"path/filepath"
+	"strings"
 	"syscall"
 	"time"
 
@@ -20,17 +21,31 @@ func main() {
 	caFile := flag.String("ca-file", os.Getenv("HF_CA_FILE"), "optional PEM CA bundle for a private center certificate authority")
 	trapID := flag.String("trap", "", "trap UUID (required only for first enrollment)")
 	enrollmentToken := flag.String("enrollment-token", "", "one-time enrollment token (required only for first enrollment)")
+	enrollmentTokenFile := flag.String("enrollment-token-file", os.Getenv("HF_ENROLLMENT_TOKEN_FILE"), "file containing the one-time enrollment token")
 	statePath := flag.String("state", defaultStatePath(), "private path for persistent agent credentials and config")
 	queuePath := flag.String("queue", defaultQueuePath(), "private SQLite path for pending telemetry")
 	ipcListen := flag.String("ipc-listen", envOr("HF_AGENT_IPC_LISTEN", "127.0.0.1:9101"), "private listener for decoy telemetry")
 	ipcToken := flag.String("ipc-token", os.Getenv("HF_DECOY_AGENT_IPC_TOKEN"), "shared secret for local decoy-to-agent telemetry IPC")
+	ipcTokenFile := flag.String("ipc-token-file", os.Getenv("HF_DECOY_AGENT_IPC_TOKEN_FILE"), "file containing the decoy-to-agent IPC secret")
 	decoyToken := flag.String("decoy-token", os.Getenv("HF_AGENT_DECOY_IPC_TOKEN"), "shared secret for local agent-to-decoy administration")
+	decoyTokenFile := flag.String("decoy-token-file", os.Getenv("HF_AGENT_DECOY_IPC_TOKEN_FILE"), "file containing the agent-to-decoy IPC secret")
 	decoyURL := flag.String("decoy-admin", os.Getenv("HF_DECOY_ADMIN_URL"), "private decoy administration URL")
 	flag.Parse()
 
 	if *centerURL == "" {
 		log.Fatal("-center is required and must be an HTTPS origin")
 	}
+	var err error
+	*ipcToken, err = readSecret(*ipcToken, *ipcTokenFile)
+	if err != nil {
+		log.Fatal("decoy telemetry IPC secret is unavailable")
+	}
+	if *decoyURL != "" {
+		*decoyToken, err = readSecret(*decoyToken, *decoyTokenFile)
+		if err != nil {
+			log.Fatal("decoy administration IPC secret is unavailable")
+		}
+	}
 	client, err := agent.NewClientWithCA(*centerURL, *caFile)
 	if err != nil {
 		log.Fatal(err)
@@ -48,10 +63,18 @@ func main() {
 		if !errors.Is(err, os.ErrNotExist) {
 			log.Fatalf("load agent state: %v", err)
 		}
-		if *trapID == "" || *enrollmentToken == "" {
+		token := *enrollmentToken
+		if *enrollmentTokenFile != "" {
+			token, err = readSecret(token, *enrollmentTokenFile)
+			if err != nil {
+				log.Fatal("one-time enrollment token file is unavailable")
+			}
+		}
+		if *trapID == "" || token == "" {
 			log.Fatal("first run requires -trap and -enrollment-token")
 		}
-		state, err = client.Enroll(ctx, *trapID, *enrollmentToken)
+		state, err = client.Enroll(ctx, *trapID, token)
+		token = ""
 		if err != nil {
 			log.Fatalf("enroll agent: %v", err)
 		}
@@ -59,13 +82,18 @@ func main() {
 			log.Fatalf("save enrolled credentials: %v", err)
 		}
 		log.Printf("agent enrolled for trap %s; credential saved to %s", state.TrapID, *statePath)
-	} else if *trapID != "" || *enrollmentToken != "" {
-		log.Fatal("agent is already enrolled; do not pass enrollment credentials again")
+	} else {
+		if *trapID != "" && *trapID != state.TrapID {
+			log.Fatal("configured trap does not match the persisted enrollment")
+		}
+		if *enrollmentToken != "" {
+			log.Fatal("agent is already enrolled; do not pass an enrollment token again")
+		}
 	}
 
 	var ipcServer *http.Server
 	if *ipcToken != "" {
-		ipcServer = &http.Server{Addr: *ipcListen, Handler: agent.IPCHandler(queue, state, *ipcToken), ReadHeaderTimeout: 5 * time.Second}
+		ipcServer = &http.Server{Addr: *ipcListen, Handler: agent.IPCHandler(queue, state, *ipcToken), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 << 10}
 		go func() {
 			log.Printf("agent telemetry IPC listening on %s", *ipcListen)
 			if serveErr := ipcServer.ListenAndServe(); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
@@ -175,6 +203,21 @@ func envOr(key, fallback string) string {
 	return fallback
 }
 
+func readSecret(value, path string) (string, error) {
+	if path == "" {
+		return value, nil
+	}
+	data, err := os.ReadFile(path)
+	if err != nil || len(data) > 4096 {
+		return "", errors.New("secret file unavailable")
+	}
+	secret := strings.TrimSpace(string(data))
+	if secret == "" {
+		return "", errors.New("secret file is empty")
+	}
+	return secret, nil
+}
+
 func sendHeartbeat(ctx context.Context, client *agent.Client, state *agent.State, adapter agent.DecoyAdapter) error {
 	requestCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
 	defer cancel()
