package control

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"honeyforge/internal/contracts"
)

func TestRenderTrapBundleSeparatesEnrollmentSecret(t *testing.T) {
	trapID := "11111111-1111-4111-8111-111111111111"
	profileID := "22222222-2222-4222-8222-222222222222"
	sourceSHA := strings.Repeat("a", 40)
	bindings := []contracts.DeploymentBinding{{ServiceID: "web", HostPort: 18080}}
	archive, err := renderTrapBundle(trapID, profileID, 3, "medium archive", "linux-node-02", profileConfig(), bindings,
		"https://center.example.org:9443", defaultBundleSourceRepository, sourceSHA)
	if err != nil {
		t.Fatalf("render bundle: %v", err)
	}
	reader, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatalf("open bundle: %v", err)
	}
	files := make(map[string][]byte, len(reader.File))
	for _, file := range reader.File {
		item, openErr := file.Open()
		if openErr != nil {
			t.Fatalf("open %s: %v", file.Name, openErr)
		}
		data, readErr := io.ReadAll(item)
		_ = item.Close()
		if readErr != nil {
			t.Fatalf("read %s: %v", file.Name, readErr)
		}
		files[file.Name] = data
		if (file.Name == "install.sh" || file.Name == "restrict-egress.sh") && file.Mode().Perm() != 0755 {
			t.Fatalf("%s mode = %o, want 755", file.Name, file.Mode().Perm())
		}
	}
	for _, name := range []string{"compose.yaml", "compose.build-ca.yaml", "decoy-config.json", "manifest.json", "install.sh", "restrict-egress.sh", "README.txt"} {
		if _, ok := files[name]; !ok {
			t.Errorf("bundle is missing %s", name)
		}
	}
	var manifest bundleManifest
	if strings.Contains(string(files["restrict-egress.sh"]), "@@HOST@@") ||
		!strings.Contains(string(files["restrict-egress.sh"]), "host='center.example.org'") ||
		!strings.Contains(string(files["restrict-egress.sh"]), "port='9443'") {
		t.Fatal("egress policy does not use the configured center endpoint")
	}
	if err := json.Unmarshal(files["manifest.json"], &manifest); err != nil || manifest.DeploymentNode != "linux-node-02" {
		t.Fatalf("bundle target node not preserved: node=%q err=%v", manifest.DeploymentNode, err)
	}
	if bytes.Contains(files["install.sh"], []byte("one-time-secret-value")) || bytes.Contains(archive, []byte("enrollment_token=")) {
		t.Fatal("bundle contains enrollment-token material")
	}
	if !bytes.Contains(files["install.sh"], []byte(sourceSHA)) || !bytes.Contains(files["compose.yaml"], []byte("18080")) || !bytes.Contains(files["compose.yaml"], []byte("0.0.0.0")) {
		t.Fatal("bundle does not pin the runtime source and publish the selected host binding")
	}
	var decoyConfig struct {
		TrapID    string                  `json:"trap_id"`
		ProfileID string                  `json:"profile_id"`
		Revision  int                     `json:"revision"`
		Config    contracts.ProfileConfig `json:"config"`
	}
	if err = json.Unmarshal(files["decoy-config.json"], &decoyConfig); err != nil {
		t.Fatalf("decode bundled decoy configuration: %v", err)
	}
	if decoyConfig.TrapID != trapID || decoyConfig.ProfileID != profileID || decoyConfig.Revision != 3 || decoyConfig.Config.SyntheticCredentials[0].Password != "lab-credential-secret" {
		t.Fatalf("bundle did not preserve the selected profile revision: %+v", decoyConfig)
	}
}

func TestBundleRejectsIncompleteBindingsAndUnpinnedSource(t *testing.T) {
	config := profileConfig()
	if _, err := renderTrapBundle("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", 1, "trap", "linux-node", config, nil,
		"https://center.example.org:9443", defaultBundleSourceRepository, strings.Repeat("a", 40)); err == nil {
		t.Fatal("bundle accepted a profile without host bindings")
	}
	if _, err := renderTrapBundle("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", 1, "trap", "linux-node", config,
		[]contracts.DeploymentBinding{{ServiceID: "web", HostPort: 18080}}, "https://center.example.org:9443", defaultBundleSourceRepository, "dev"); err == nil {
		t.Fatal("bundle accepted an unpinned source revision")
	}
}
