package decoy

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"honeyforge/internal/contracts"
)

// HTTPAgentSink waits for the local management agent to confirm that an event
// has been written to its durable queue before the decoy continues the request.
type HTTPAgentSink struct {
	endpoint string
	token    string
	client   *http.Client
}

func NewHTTPAgentSink(rawURL, token string) (*HTTPAgentSink, error) {
	u, err := url.Parse(rawURL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, errors.New("agent URL must be an HTTP(S) origin")
	}
	if token == "" {
		return nil, errors.New("agent IPC token is required")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	return &HTTPAgentSink{endpoint: strings.TrimRight(u.String(), "/") + "/v1/events", token: token, client: &http.Client{Transport: transport, Timeout: 3 * time.Second}}, nil
}

func (s *HTTPAgentSink) Submit(ctx context.Context, event contracts.Event) error {
	data, err := json.Marshal(event)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.endpoint, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+s.token)
	resp, err := s.client.Do(req)
	if err != nil {
		return fmt.Errorf("submit event to local agent: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		return fmt.Errorf("local agent did not persist event (HTTP %d)", resp.StatusCode)
	}
	var ack struct {
		EventID   string `json:"event_id"`
		Persisted bool   `json:"persisted"`
	}
	if err = json.NewDecoder(resp.Body).Decode(&ack); err != nil {
		return fmt.Errorf("decode local agent event acknowledgement: %w", err)
	}
	if ack.EventID != event.EventID || !ack.Persisted {
		return errors.New("local agent returned an invalid event acknowledgement")
	}
	return nil
}
