package decoy

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

type ConfigurationStore interface {
	Save(Configuration) error
}

type FileConfigurationStore struct {
	path string
}

func NewFileConfigurationStore(path string) (*FileConfigurationStore, error) {
	if path == "" {
		return nil, errors.New("configuration path is required")
	}
	return &FileConfigurationStore{path: filepath.Clean(path)}, nil
}

// Save writes beside the active configuration and replaces it only after the
// complete JSON document has been flushed and closed successfully.
func (s *FileConfigurationStore) Save(cfg Configuration) error {
	data, err := json.Marshal(cloneConfiguration(cfg))
	if err != nil {
		return fmt.Errorf("encode applied configuration: %w", err)
	}
	directory := filepath.Dir(s.path)
	base := filepath.Base(s.path)
	temp, err := os.CreateTemp(directory, "."+base+"-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary configuration: %w", err)
	}
	tempPath := temp.Name()
	renamed := false
	defer func() {
		if !renamed {
			_ = os.Remove(tempPath)
		}
	}()
	if err = temp.Chmod(0600); err != nil {
		_ = temp.Close()
		return fmt.Errorf("set temporary configuration permissions: %w", err)
	}
	if _, err = temp.Write(data); err != nil {
		_ = temp.Close()
		return fmt.Errorf("write temporary configuration: %w", err)
	}
	if err = temp.Sync(); err != nil {
		_ = temp.Close()
		return fmt.Errorf("flush temporary configuration: %w", err)
	}
	if err = temp.Close(); err != nil {
		return fmt.Errorf("close temporary configuration: %w", err)
	}
	if err = os.Rename(tempPath, s.path); err != nil {
		return fmt.Errorf("replace applied configuration: %w", err)
	}
	renamed = true
	return nil
}
