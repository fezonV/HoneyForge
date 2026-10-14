package control

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/coder/websocket"
	"honeyforge/internal/contracts"
)

const (
	wsClientLimit = 500
	wsQueueLimit  = 64
)

type wsClient struct {
	conn      *websocket.Conn
	sessionID string
	queue     chan []byte
}

// wsHub keeps notification fanout off the event-ingestion path. A slow client
// is disconnected when its bounded queue fills and can catch up over REST.
type wsHub struct {
	mu      sync.Mutex
	clients map[*wsClient]struct{}
}

func newWSHub() *wsHub { return &wsHub{clients: make(map[*wsClient]struct{})} }

func (h *wsHub) add(conn *websocket.Conn, sessionID string) (*wsClient, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.clients) >= wsClientLimit {
		return nil, false
	}
	c := &wsClient{conn: conn, sessionID: sessionID, queue: make(chan []byte, wsQueueLimit)}
	h.clients[c] = struct{}{}
	return c, true
}

func (h *wsHub) closeSession(sessionID string) {
	if sessionID == "" {
		return
	}
	h.mu.Lock()
	var closeClients []*wsClient
	for c := range h.clients {
		if c.sessionID != sessionID {
			continue
		}
		delete(h.clients, c)
		close(c.queue)
		closeClients = append(closeClients, c)
	}
	h.mu.Unlock()
	for _, c := range closeClients {
		if c.conn != nil {
			_ = c.conn.CloseNow()
		}
	}
}

func (h *wsHub) remove(c *wsClient) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, ok := h.clients[c]; !ok {
		return false
	}
	delete(h.clients, c)
	close(c.queue)
	return true
}

func (h *wsHub) publish(notification contracts.WSNotification) {
	h.mu.Lock()
	if len(h.clients) == 0 {
		h.mu.Unlock()
		return
	}
	encoded, err := json.Marshal(notification)
	if err != nil {
		h.mu.Unlock()
		return
	}
	var slow []*wsClient
	for c := range h.clients {
		select {
		case c.queue <- encoded:
		default:
			delete(h.clients, c)
			close(c.queue)
			slow = append(slow, c)
		}
	}
	h.mu.Unlock()
	for _, c := range slow {
		if c.conn != nil {
			_ = c.conn.CloseNow()
		}
	}
}

func (s *Server) websocketOrigin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origins := r.Header.Values("Origin")
		originURL, err := url.Parse(s.origin)
		if s.origin == "" || len(origins) != 1 || origins[0] != s.origin || err != nil ||
			(originURL.Scheme != "https" && originURL.Scheme != "http") || originURL.Host == "" ||
			originURL.User != nil || originURL.Path != "" || originURL.RawQuery != "" || originURL.Fragment != "" {
			fail(w, r, http.StatusForbidden, "origin_forbidden", "WebSocket Origin is not allowed", nil)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) websocket(w http.ResponseWriter, r *http.Request) {
	actor := currentActor(r)
	// websocketOrigin already requires the exact configured scheme/host/port.
	// A reverse proxy may use an internal Host when forwarding the upgrade.
	publicOrigin, err := url.Parse(s.origin)
	if err != nil || publicOrigin.Host == "" {
		fail(w, r, http.StatusForbidden, "origin_forbidden", "WebSocket Origin is not allowed", nil)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{publicOrigin.Host}})
	if err != nil {
		return
	}
	client, ok := s.ws.add(conn, actor.session)
	if !ok {
		_ = conn.Close(websocket.StatusTryAgainLater, "connection limit reached")
		return
	}
	defer func() {
		s.ws.remove(client)
		_ = conn.CloseNow()
	}()

	conn.SetReadLimit(1024)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		for {
			if _, _, readErr := conn.Read(ctx); readErr != nil {
				return
			}
			_ = conn.Close(websocket.StatusPolicyViolation, "client messages are not supported")
			return
		}
	}()

	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case message, open := <-client.queue:
			if !open {
				return
			}
			writeCtx, writeCancel := context.WithTimeout(ctx, 5*time.Second)
			err = conn.Write(writeCtx, websocket.MessageText, message)
			writeCancel()
			if err != nil {
				return
			}
		case <-ticker.C:
			authCtx, authCancel := context.WithTimeout(ctx, 5*time.Second)
			var sessionActive bool
			authErr := s.db.QueryRow(authCtx, `SELECT EXISTS(SELECT 1 FROM operator_sessions WHERE id=$1 AND revoked_at IS NULL AND expires_at>now())`, actor.session).Scan(&sessionActive)
			authCancel()
			if authErr != nil || !sessionActive {
				_ = conn.Close(websocket.StatusPolicyViolation, "operator session is no longer active")
				return
			}
			pingCtx, pingCancel := context.WithTimeout(ctx, 5*time.Second)
			err = conn.Ping(pingCtx)
			pingCancel()
			if err != nil {
				return
			}
		case <-readDone:
			return
		case <-r.Context().Done():
			return
		}
	}
}

func (s *Server) publishNotification(kind, id string, data map[string]any) {
	if s.ws == nil || id == "" {
		return
	}
	s.ws.publish(contracts.WSNotification{
		Type:       kind,
		ID:         id,
		OccurredAt: time.Now().UTC().Format(time.RFC3339Nano),
		Data:       data,
	})
}
