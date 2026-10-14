package agent

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type HTTPDecoyAdapter struct {
	baseURL, token string
	client         *http.Client
}

func NewHTTPDecoyAdapter(rawURL, token string) (*HTTPDecoyAdapter, error) {
	if token == "" {
		return nil, errors.New("decoy IPC token is required")
	}
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, errors.New("decoy URL must be an HTTP(S) origin")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	return &HTTPDecoyAdapter{baseURL: strings.TrimRight(u.String(), "/"), token: token, client: &http.Client{Transport: transport, Timeout: 5 * time.Second, CheckRedirect: rejectRedirect}}, nil
}

func (a *HTTPDecoyAdapter) call(ctx context.Context, method, path string, input, output any) error {
	var body io.Reader
	if input != nil {
		data, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, a.baseURL+path, body)
	if err != nil {
		return err
	}
	if input != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+a.token)
	resp, err := a.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("decoy IPC returned HTTP %d", resp.StatusCode)
	}
	if output != nil {
		return json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(output)
	}
	return nil
}

func (a *HTTPDecoyAdapter) ApplyConfiguration(ctx context.Context, cfg ConfigResponse) error {
	var ack struct {
		TrapID    string `json:"trap_id"`
		ProfileID string `json:"profile_id"`
		Revision  int    `json:"revision"`
	}
	if err := a.call(ctx, http.MethodPost, "/internal/config", cfg, &ack); err != nil {
		return err
	}
	if ack.TrapID != cfg.TrapID || ack.ProfileID != cfg.ProfileID || ack.Revision != cfg.Revision {
		return fmt.Errorf("decoy IPC acknowledged a different configuration")
	}
	return nil
}
func (a *HTTPDecoyAdapter) Start(ctx context.Context) error {
	return a.call(ctx, http.MethodPost, "/internal/start", struct{}{}, nil)
}
func (a *HTTPDecoyAdapter) Stop(ctx context.Context) error {
	return a.call(ctx, http.MethodPost, "/internal/stop", struct{}{}, nil)
}
func (a *HTTPDecoyAdapter) ServiceState(ctx context.Context) (string, error) {
	var result struct {
		Status string `json:"status"`
	}
	err := a.call(ctx, http.MethodPost, "/internal/status", struct{}{}, &result)
	if err == nil && result.Status != "running" && result.Status != "stopped" {
		return "error", fmt.Errorf("decoy IPC returned invalid service state %q", result.Status)
	}
	return result.Status, err
}
