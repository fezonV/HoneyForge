package agent

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"honeyforge/internal/contracts"
)

const maxResponseBytes = 1 << 20

type HTTPStatusError struct {
	StatusCode int
	Message    string
}

func (e *HTTPStatusError) Error() string {
	return fmt.Sprintf("center returned HTTP %d: %s", e.StatusCode, e.Message)
}

// State contains the agent credential and last desired configuration. It must
// only be written to a private path because AgentToken grants trap access.
type State struct {
	mu      sync.RWMutex    `json:"-"`
	AgentID string          `json:"agent_id"`
	TrapID  string          `json:"trap_id"`
	Token   string          `json:"agent_token"`
	Config  *ConfigResponse `json:"config,omitempty"`
}

func (s *State) SetConfig(config *ConfigResponse) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if config == nil {
		s.Config = nil
		return
	}
	copy := *config
	copy.Config.Services = append([]contracts.Service(nil), config.Config.Services...)
	copy.Config.SyntheticCredentials = append([]contracts.SyntheticCredential(nil), config.Config.SyntheticCredentials...)
	copy.Config.FakeFS = append([]contracts.FakeFile(nil), config.Config.FakeFS...)
	copy.Config.Logging.Categories = append([]string(nil), config.Config.Logging.Categories...)
	s.Config = &copy
}
func (s *State) ConfigSnapshot() *ConfigResponse {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.Config == nil {
		return nil
	}
	copy := *s.Config
	copy.Config.Services = append([]contracts.Service(nil), s.Config.Config.Services...)
	copy.Config.SyntheticCredentials = append([]contracts.SyntheticCredential(nil), s.Config.Config.SyntheticCredentials...)
	copy.Config.FakeFS = append([]contracts.FakeFile(nil), s.Config.Config.FakeFS...)
	copy.Config.Logging.Categories = append([]string(nil), s.Config.Config.Logging.Categories...)
	return &copy
}

type ConfigResponse struct {
	TrapID    string                  `json:"trap_id"`
	ProfileID string                  `json:"profile_id"`
	Revision  int                     `json:"revision"`
	Config    contracts.ProfileConfig `json:"config"`
}

type EventSendResponse struct {
	AcceptedIDs  []string `json:"accepted_ids"`
	DuplicateIDs []string `json:"duplicate_ids"`
}

type CommandResult struct {
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

type Client struct {
	baseURL string
	http    *http.Client
}

func NewClient(rawURL string) (*Client, error) {
	return NewClientWithCA(rawURL, "")
}

// NewClientWithCA keeps normal system trust and optionally adds a pinned local
// CA for centers that use a private certificate authority.
func NewClientWithCA(rawURL, caFile string) (*Client, error) {
	u, err := url.Parse(strings.TrimRight(rawURL, "/"))
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" {
		return nil, errors.New("center URL must be an origin without path, query, or credentials")
	}
	if u.Scheme != "https" {
		return nil, errors.New("center URL must use HTTPS")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	tlsConfig := &tls.Config{MinVersion: tls.VersionTLS12}
	if caFile != "" {
		certificatePEM, readErr := os.ReadFile(caFile)
		if readErr != nil {
			return nil, fmt.Errorf("read center CA file: %w", readErr)
		}
		roots, poolErr := x509.SystemCertPool()
		if poolErr != nil || roots == nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM(certificatePEM) {
			return nil, errors.New("center CA file contains no valid certificates")
		}
		tlsConfig.RootCAs = roots
	}
	transport.TLSClientConfig = tlsConfig
	return &Client{baseURL: u.String(), http: &http.Client{Transport: transport, Timeout: 10 * time.Second, CheckRedirect: rejectRedirect}}, nil
}

func rejectRedirect(*http.Request, []*http.Request) error {
	return errors.New("IPC and management API redirects are not allowed")
}

func (c *Client) Enroll(ctx context.Context, trapID, enrollmentToken string) (*State, error) {
	var result State
	err := c.doJSON(ctx, http.MethodPost, "/agent/v1/enroll", "", map[string]string{"trap_id": trapID, "token": enrollmentToken}, http.StatusCreated, &result)
	if err != nil {
		return nil, err
	}
	if result.AgentID == "" || result.TrapID != trapID || result.Token == "" {
		return nil, errors.New("center returned an incomplete enrollment response")
	}
	return &result, nil
}

func (c *Client) FetchConfig(ctx context.Context, state *State) (*ConfigResponse, error) {
	if state == nil || state.Token == "" || state.TrapID == "" {
		return nil, errors.New("agent state is missing its credential or trap ID")
	}
	var result ConfigResponse
	err := c.doJSON(ctx, http.MethodGet, "/agent/v1/traps/"+url.PathEscape(state.TrapID)+"/config", state.Token, nil, http.StatusOK, &result)
	if err != nil {
		return nil, err
	}
	if result.TrapID != state.TrapID || !contracts.ValidID(result.ProfileID) || result.Revision < 1 || len(contracts.ValidateProfile(result.Config)) > 0 {
		return nil, errors.New("center returned an invalid configuration response")
	}
	return &result, nil
}

func (c *Client) Heartbeat(ctx context.Context, state *State, serviceState string) error {
	return c.HeartbeatWithTelemetry(ctx, state, serviceState, nil)
}

func (c *Client) HeartbeatWithTelemetry(ctx context.Context, state *State, serviceState string, telemetry *contracts.AgentTelemetry) error {
	if state == nil || state.Token == "" || state.TrapID == "" {
		return errors.New("agent state is missing its credential or trap ID")
	}
	var result struct {
		TrapID       string `json:"trap_id"`
		AgentStatus  string `json:"agent_status"`
		ServiceState string `json:"service_status"`
		LastSeen     string `json:"last_seen"`
	}
	err := c.doJSON(ctx, http.MethodPost, "/agent/v1/traps/"+url.PathEscape(state.TrapID)+"/heartbeat", state.Token, struct {
		ServiceState string                    `json:"service_state"`
		Telemetry    *contracts.AgentTelemetry `json:"telemetry,omitempty"`
	}{serviceState, telemetry}, http.StatusOK, &result)
	if err != nil {
		return err
	}
	if result.TrapID != state.TrapID || result.AgentStatus != "online" || result.LastSeen == "" {
		return errors.New("center returned an invalid heartbeat response")
	}
	return nil
}

func (c *Client) SendEvents(ctx context.Context, state *State, events []contracts.Event) (EventSendResponse, error) {
	if state == nil || state.Token == "" || state.TrapID == "" {
		return EventSendResponse{}, errors.New("agent state is missing its credential or trap ID")
	}
	if len(events) == 0 || len(events) > 100 {
		return EventSendResponse{}, errors.New("event batch must contain 1 to 100 items")
	}
	var result EventSendResponse
	err := c.doJSON(ctx, http.MethodPost, "/agent/v1/traps/"+url.PathEscape(state.TrapID)+"/events", state.Token, map[string]any{"events": events}, http.StatusOK, &result)
	return result, err
}

func (c *Client) FetchCommands(ctx context.Context, state *State) ([]contracts.Command, error) {
	if state == nil || state.Token == "" || state.TrapID == "" {
		return nil, errors.New("agent state is missing its credential or trap ID")
	}
	var result struct {
		Items []contracts.Command `json:"items"`
	}
	err := c.doJSON(ctx, http.MethodGet, "/agent/v1/traps/"+url.PathEscape(state.TrapID)+"/commands", state.Token, nil, http.StatusOK, &result)
	return result.Items, err
}

func (c *Client) ReportCommand(ctx context.Context, state *State, commandID, status, commandError string) error {
	if state == nil || state.Token == "" || state.TrapID == "" {
		return errors.New("agent state is missing its credential or trap ID")
	}
	var result CommandResult
	err := c.doJSON(ctx, http.MethodPost, "/agent/v1/traps/"+url.PathEscape(state.TrapID)+"/commands/"+url.PathEscape(commandID), state.Token, CommandResult{Status: status, Error: commandError}, http.StatusOK, &result)
	if err == nil && result.Status != status {
		return errors.New("center returned an unexpected command status")
	}
	return err
}

func (c *Client) doJSON(ctx context.Context, method, path, token string, input any, expectedStatus int, output any) error {
	var body io.Reader
	if input != nil {
		data, err := json.Marshal(input)
		if err != nil {
			return fmt.Errorf("encode request: %w", err)
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return err
	}
	if input != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("contact control center: %w", err)
	}
	defer resp.Body.Close()
	limited := io.LimitReader(resp.Body, maxResponseBytes+1)
	data, err := io.ReadAll(limited)
	if err != nil {
		return fmt.Errorf("read center response: %w", err)
	}
	if len(data) > maxResponseBytes {
		return errors.New("center response exceeds 1 MiB limit")
	}
	if resp.StatusCode != expectedStatus {
		return &HTTPStatusError{StatusCode: resp.StatusCode, Message: safeBody(data)}
	}
	if err = json.Unmarshal(data, output); err != nil {
		return fmt.Errorf("decode center response: %w", err)
	}
	return nil
}

func safeBody(data []byte) string {
	var apiErr contracts.APIError
	if err := json.Unmarshal(data, &apiErr); err == nil && apiErr.Error.Code != "" {
		return apiErr.Error.Code
	}
	return "unexpected response"
}

// SaveState atomically replaces a private JSON state file. The containing
// directory and file are restricted to the current user on Unix systems.
func SaveState(path string, state *State) error {
	if path == "" || state == nil {
		return errors.New("state path and state are required")
	}
	state.mu.RLock()
	persisted := struct {
		AgentID string          `json:"agent_id"`
		TrapID  string          `json:"trap_id"`
		Token   string          `json:"agent_token"`
		Config  *ConfigResponse `json:"config,omitempty"`
	}{state.AgentID, state.TrapID, state.Token, state.Config}
	data, err := json.MarshalIndent(persisted, "", "  ")
	state.mu.RUnlock()
	if err != nil {
		return fmt.Errorf("encode agent state: %w", err)
	}
	dir := filepath.Dir(path)
	if err = os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("create state directory: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".agent-state-*")
	if err != nil {
		return fmt.Errorf("create temporary state file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err = tmp.Chmod(0600); err == nil {
		_, err = tmp.Write(data)
	}
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("write agent state: %w", err)
	}
	if err = os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("replace agent state: %w", err)
	}
	return nil
}

func LoadState(path string) (*State, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
		return nil, errors.New("agent state file permissions are too broad; restrict access to the current user")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var state State
	if err = json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("decode agent state: %w", err)
	}
	if state.AgentID == "" || state.TrapID == "" || state.Token == "" {
		return nil, errors.New("agent state is incomplete")
	}
	return &state, nil
}
