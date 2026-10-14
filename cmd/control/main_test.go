package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveDatabaseURLPrefersSecretFileAndTrimsNewline(t *testing.T) {
	path := filepath.Join(t.TempDir(), "database-url")
	if err := os.WriteFile(path, []byte("postgres://secret@db/honeyforge?sslmode=disable\n"), 0600); err != nil {
		t.Fatal(err)
	}
	got, err := resolveDatabaseURL("postgres://ignored", path)
	if err != nil {
		t.Fatal(err)
	}
	if got != "postgres://secret@db/honeyforge?sslmode=disable" {
		t.Fatalf("resolved URL=%q", got)
	}
}

func TestResolveDatabaseURLRejectsMissingEmptyAndOversizedSecret(t *testing.T) {
	if _, err := resolveDatabaseURL("", ""); err == nil {
		t.Fatal("accepted missing database URL")
	}
	if _, err := resolveDatabaseURL("  ", ""); err == nil {
		t.Fatal("accepted empty database URL")
	}
	path := filepath.Join(t.TempDir(), "oversized-url")
	if err := os.WriteFile(path, []byte(strings.Repeat("x", 16*1024+1)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := resolveDatabaseURL("", path); err == nil {
		t.Fatal("accepted oversized secret file")
	}
}
