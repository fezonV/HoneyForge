commit 9c71957c0e68401902827d344cba5ac1bf6ba8f0
Author: Анна Ардышева <ardyshevaanna@gmail.com>
Date:   Wed Oct 14 12:48:08 2026 +0000

    feat(be-04): generate audited pinned trap bundles

diff --git a/cmd/decoy/main.go b/cmd/decoy/main.go
index 80d6dda..9443f37 100644
--- a/cmd/decoy/main.go
+++ b/cmd/decoy/main.go
@@ -23,18 +23,24 @@ func main() {
 	publicBind := flag.String("bind", envOr("HF_DECOY_BIND", "127.0.0.1"), "address on which public decoy HTTP services listen")
 	adminAddr := flag.String("admin-listen", envOr("HF_DECOY_ADMIN_LISTEN", "127.0.0.1:9100"), "private agent administration listener")
 	adminToken := flag.String("admin-token", os.Getenv("HF_AGENT_DECOY_IPC_TOKEN"), "shared secret for local agent to control the decoy")
+	adminTokenFile := flag.String("admin-token-file", os.Getenv("HF_AGENT_DECOY_IPC_TOKEN_FILE"), "file containing the agent-to-decoy IPC secret")
 	agentURL := flag.String("agent-url", envOr("HF_AGENT_IPC_URL", "http://127.0.0.1:9101"), "local agent event IPC origin")
 	agentToken := flag.String("agent-token", os.Getenv("HF_DECOY_AGENT_IPC_TOKEN"), "shared secret for decoy to submit telemetry to the agent")
+	agentTokenFile := flag.String("agent-token-file", os.Getenv("HF_DECOY_AGENT_IPC_TOKEN_FILE"), "file containing the decoy-to-agent IPC secret")
 	flag.Parse()
 	if *configPath == "" {
 		log.Fatal("-config or HF_DECOY_CONFIG is required")
 	}
-	if *adminToken == "" {
+	adminSecret, err := readSecret(*adminToken, *adminTokenFile)
+	if err != nil {
 		log.Fatal("-admin-token or HF_AGENT_DECOY_IPC_TOKEN is required")
 	}
-	if *agentToken == "" {
+	*adminToken = adminSecret
+	agentSecret, err := readSecret(*agentToken, *agentTokenFile)
+	if err != nil {
 		log.Fatal("-agent-token or HF_DECOY_AGENT_IPC_TOKEN is required")
 	}
+	*agentToken = agentSecret
 	data, err := os.ReadFile(*configPath)
 	if err != nil {
 		log.Fatalf("read decoy configuration: %v", err)
@@ -116,3 +122,21 @@ func envOr(key, fallback string) string {
 	}
 	return fallback
 }
+
+func readSecret(value, path string) (string, error) {
+	if path == "" {
+		if value == "" {
+			return "", errors.New("secret is empty")
+		}
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
