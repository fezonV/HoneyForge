package control

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"
	"honeyforge/internal/contracts"
)

func TestWebsocketHandshakeUsesConfiguredPublicOriginBehindProxy(t *testing.T) {
	s := &Server{origin: "https://console.example:8443", ws: newWSHub()}
	server := httptest.NewServer(s.websocketOrigin(http.HandlerFunc(s.websocket)))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, response, err := websocket.Dial(ctx, "ws"+server.URL[4:]+"/api/v1/ws", &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": {s.origin}},
	})
	if err != nil {
		t.Fatalf("configured public Origin rejected behind proxy: %v (response=%v)", err, response)
	}
	_ = conn.CloseNow()
}

func TestWebsocketOriginRequiresExactConfiguredOrigin(t *testing.T) {
	s := &Server{origin: "https://honeyforge.example"}
	next := s.websocketOrigin(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	tests := []struct {
		name       string
		origins    []string
		wantStatus int
	}{
		{name: "exact origin", origins: []string{"https://honeyforge.example"}, wantStatus: http.StatusNoContent},
		{name: "missing origin", wantStatus: http.StatusForbidden},
		{name: "other host", origins: []string{"https://attacker.example"}, wantStatus: http.StatusForbidden},
		{name: "same host different scheme", origins: []string{"http://honeyforge.example"}, wantStatus: http.StatusForbidden},
		{name: "duplicate origins", origins: []string{"https://honeyforge.example", "https://honeyforge.example"}, wantStatus: http.StatusForbidden},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/api/v1/ws", nil)
			for _, origin := range tt.origins {
				r.Header.Add("Origin", origin)
			}
			w := httptest.NewRecorder()
			next.ServeHTTP(w, r)
			if w.Code != tt.wantStatus {
				t.Fatalf("status = %d, want %d", w.Code, tt.wantStatus)
			}
		})
	}
}

func TestWSHubDisconnectsSlowClientsAtQueueLimit(t *testing.T) {
	h := newWSHub()
	c, ok := h.add(nil, "session-a")
	if !ok {
		t.Fatal("first client was rejected")
	}
	for i := 0; i < wsQueueLimit; i++ {
		h.publish(contracts.WSNotification{Type: "event.created", ID: "id"})
	}
	if got := len(c.queue); got != wsQueueLimit {
		t.Fatalf("queued messages = %d, want %d", got, wsQueueLimit)
	}
	h.publish(contracts.WSNotification{Type: "event.created", ID: "overflow"})
	if got := len(h.clients); got != 0 {
		t.Fatalf("registered clients = %d after overflow, want 0", got)
	}
	for i := 0; i < wsQueueLimit; i++ {
		if _, open := <-c.queue; !open {
			t.Fatal("slow client's queue closed before buffered notifications were drained")
		}
	}
	if _, open := <-c.queue; open {
		t.Fatal("slow client's queue was left open")
	}
}

func TestWSHubPublishesJSONNotifications(t *testing.T) {
	h := newWSHub()
	c, ok := h.add(nil, "session-a")
	if !ok {
		t.Fatal("client was rejected")
	}
	want := contracts.WSNotification{Type: "event.created", ID: "event-id", Data: map[string]any{"event_id": "event-id"}}
	(&Server{ws: h}).publishNotification(want.Type, want.ID, want.Data)
	var got contracts.WSNotification
	if err := json.Unmarshal(<-c.queue, &got); err != nil {
		t.Fatalf("decode notification: %v", err)
	}
	if got.Type != want.Type || got.ID != want.ID || got.Data["event_id"] != "event-id" || got.OccurredAt == "" {
		t.Fatalf("notification = %#v, want type/id/data and timestamp", got)
	}
	h.remove(c)
}

func TestWSHubClosesConnectionsForRevokedSession(t *testing.T) {
	h := newWSHub()
	matching, ok := h.add(nil, "session-a")
	if !ok {
		t.Fatal("matching client was rejected")
	}
	other, ok := h.add(nil, "session-b")
	if !ok {
		t.Fatal("other client was rejected")
	}
	h.closeSession("session-a")
	if len(h.clients) != 1 {
		t.Fatalf("registered clients after logout = %d, want 1", len(h.clients))
	}
	if _, open := <-matching.queue; open {
		t.Fatal("revoked session queue was left open")
	}
	select {
	case _, open := <-other.queue:
		if !open {
			t.Fatal("unrelated session queue was closed")
		}
	default:
	}
	h.remove(other)
}
