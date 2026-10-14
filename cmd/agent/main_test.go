commit 9c71957c0e68401902827d344cba5ac1bf6ba8f0
Author: Анна Ардышева <ardyshevaanna@gmail.com>
Date:   Wed Oct 14 12:48:08 2026 +0000

    feat(be-04): generate audited pinned trap bundles

diff --git a/cmd/agent/main_test.go b/cmd/agent/main_test.go
index 0ebcbe9..c7c9dad 100644
--- a/cmd/agent/main_test.go
+++ b/cmd/agent/main_test.go
@@ -3,6 +3,7 @@ package main
 import (
 	"context"
 	"errors"
+	"os"
 	"path/filepath"
 	"testing"
 
@@ -14,6 +15,28 @@ type fixedConfigFetcher struct {
 	err    error
 }
 
+func TestReadSecretSupportsDockerSecretFiles(t *testing.T) {
+	path := filepath.Join(t.TempDir(), "secret")
+	if err := os.WriteFile(path, []byte("  bootstrap-token\n"), 0400); err != nil {
+		t.Fatal(err)
+	}
+	if got, err := readSecret("ignored-inline-value", path); err != nil || got != "bootstrap-token" {
+		t.Fatalf("readSecret()=(%q,%v), want trimmed file value", got, err)
+	}
+	if got, err := readSecret("legacy-token", ""); err != nil || got != "legacy-token" {
+		t.Fatalf("inline secret compatibility=(%q,%v)", got, err)
+	}
+	if err := os.Chmod(path, 0600); err != nil {
+		t.Fatal(err)
+	}
+	if err := os.WriteFile(path, make([]byte, 4097), 0600); err != nil {
+		t.Fatal(err)
+	}
+	if _, err := readSecret("", path); err == nil {
+		t.Fatal("oversized secret file was accepted")
+	}
+}
+
 func (f fixedConfigFetcher) FetchConfig(context.Context, *agent.State) (*agent.ConfigResponse, error) {
 	return f.config, f.err
 }
