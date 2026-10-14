commit 9c71957c0e68401902827d344cba5ac1bf6ba8f0
Author: Анна Ардышева <ardyshevaanna@gmail.com>
Date:   Wed Oct 14 12:48:08 2026 +0000

    feat(be-04): generate audited pinned trap bundles

diff --git a/internal/control/control_integration_test.go b/internal/control/control_integration_test.go
index 29c4474..bd38469 100644
--- a/internal/control/control_integration_test.go
+++ b/internal/control/control_integration_test.go
@@ -1,9 +1,12 @@
 package control
 
 import (
+	"archive/zip"
+	"bytes"
 	"context"
 	"encoding/json"
 	"fmt"
+	"io"
 	"net/http"
 	"net/http/httptest"
 	"net/url"
@@ -660,6 +663,75 @@ func TestControlPostgresFoundation(t *testing.T) {
 	}
 }
 
+func TestOperatorDownloadsAuditedTrapBundle(t *testing.T) {
+	db, _, cleanup := setupIntegration(t)
+	defer cleanup()
+	ctx := context.Background()
+	hash, err := bcrypt.GenerateFromPassword([]byte("integration-password-12"), bcrypt.DefaultCost)
+	if err != nil {
+		t.Fatal(err)
+	}
+	if _, err = db.Exec(ctx, `INSERT INTO users(id,username,password_hash,role) VALUES($1,'bundle-op',$2,'operator')`, uuid(), string(hash)); err != nil {
+		t.Fatal("seed bundle operator", err)
+	}
+	h := New(db, Config{
+		PublicOrigin: testOrigin, CookieSecure: false, AgentOrigin: "https://center.example.org:9443",
+		BundleSourceRepository: defaultBundleSourceRepository, BundleSourceRevision: strings.Repeat("a", 40),
+	}).Handler()
+	op := &testAPI{t: t, h: h}
+	op.login("bundle-op", "integration-password-12")
+	profileResponse := op.request(http.MethodPost, "/api/v1/profiles", profileJSON("bundle profile", 0), true, true)
+	if profileResponse.Code != http.StatusCreated {
+		t.Fatalf("create bundle profile=%d %s", profileResponse.Code, profileResponse.Body.String())
+	}
+	var profile contracts.Profile
+	if err = json.Unmarshal(profileResponse.Body.Bytes(), &profile); err != nil {
+		t.Fatal("decode profile response", err)
+	}
+	trapBody := `{"name":"bundle trap","deployment_bindings":[{"service_id":"web","host_port":18080}]}`
+	trapResponse := op.request(http.MethodPost, "/api/v1/traps", trapBody, true, true)
+	if trapResponse.Code != http.StatusCreated {
+		t.Fatalf("create bundle trap=%d %s", trapResponse.Code, trapResponse.Body.String())
+	}
+	var trap contracts.Trap
+	if err = json.Unmarshal(trapResponse.Body.Bytes(), &trap); err != nil {
+		t.Fatal("decode trap response", err)
+	}
+	assignment := fmt.Sprintf(`{"profile_id":%q,"revision":1}`, profile.ID)
+	assigned := op.request(http.MethodPut, "/api/v1/traps/"+trap.ID+"/profile", assignment, true, true)
+	if assigned.Code != http.StatusOK {
+		t.Fatalf("assign bundle profile=%d %s", assigned.Code, assigned.Body.String())
+	}
+	bundleResponse := op.request(http.MethodGet, "/api/v1/traps/"+trap.ID+"/bundle", "", false, true)
+	if bundleResponse.Code != http.StatusOK || bundleResponse.Header().Get("Content-Type") != "application/zip" || bundleResponse.Header().Get("Cache-Control") != "no-store" {
+		t.Fatalf("download bundle=%d type=%q cache=%q", bundleResponse.Code, bundleResponse.Header().Get("Content-Type"), bundleResponse.Header().Get("Cache-Control"))
+	}
+	archive, err := zip.NewReader(bytes.NewReader(bundleResponse.Body.Bytes()), int64(bundleResponse.Body.Len()))
+	if err != nil {
+		t.Fatalf("open returned bundle: %v", err)
+	}
+	contents := make(map[string]string, len(archive.File))
+	for _, file := range archive.File {
+		reader, openErr := file.Open()
+		if openErr != nil {
+			t.Fatal("open returned bundle entry", openErr)
+		}
+		data, readErr := io.ReadAll(reader)
+		_ = reader.Close()
+		if readErr != nil {
+			t.Fatal("read returned bundle entry", readErr)
+		}
+		contents[file.Name] = string(data)
+	}
+	if !strings.Contains(contents["decoy-config.json"], "lab-credential-secret") || !strings.Contains(contents["compose.yaml"], "18080") || strings.Contains(contents["install.sh"], "lab-credential-secret") {
+		t.Fatal("bundle content does not match the assigned revision or leaks credentials into the installer")
+	}
+	var bundleAuditCount int
+	if err = db.QueryRow(ctx, `SELECT count(*) FROM audit_log WHERE action='trap.bundle_downloaded' AND entity_id=$1`, trap.ID).Scan(&bundleAuditCount); err != nil || bundleAuditCount != 1 {
+		t.Fatalf("bundle access audit count=%d err=%v", bundleAuditCount, err)
+	}
+}
+
 func TestProfileValidatorRejectsUnsafePathsAndUnsupportedProtocol(t *testing.T) {
 	c := profileConfig()
 	c.FakeFS = []contracts.FakeFile{{Path: "C:/Windows/file.txt", Content: "x"}}
