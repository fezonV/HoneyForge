package decoy

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"net"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"honeyforge/internal/contracts"
)

type Configuration struct {
	TrapID    string                  `json:"trap_id"`
	ProfileID string                  `json:"profile_id"`
	Revision  int                     `json:"revision"`
	Config    contracts.ProfileConfig `json:"config"`
}

type EventSink interface {
	Submit(context.Context, contracts.Event) error
}

type session struct {
	id      string
	expires time.Time
}

type configContextKey struct{}
type connectionErrorContextKey struct{}

type Server struct {
	lifecycle         sync.RWMutex
	mu                sync.RWMutex
	cfg               Configuration
	sink              EventSink
	store             ConfigurationStore
	sessions          map[string]session
	pendingSessions   int
	started           bool
	lastEventUnixNano atomic.Int64
}

func New(cfg Configuration, sink EventSink) (*Server, error) {
	return NewWithStore(cfg, sink, nil)
}

func NewWithStore(cfg Configuration, sink EventSink, store ConfigurationStore) (*Server, error) {
	if !contracts.ValidID(cfg.TrapID) || !contracts.ValidID(cfg.ProfileID) || cfg.Revision < 1 {
		return nil, errors.New("trap, profile and positive revision are required")
	}
	if fields := contracts.ValidateProfile(cfg.Config); len(fields) > 0 {
		return nil, fmt.Errorf("invalid profile configuration: %v", fields)
	}
	return &Server{cfg: cloneConfiguration(cfg), sink: sink, store: store, sessions: map[string]session{}}, nil
}

func (s *Server) PublicHandler(serviceID string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) { s.handleRoot(w, r, serviceID) })
	mux.HandleFunc("GET /login", s.handleLoginPage)
	mux.HandleFunc("POST /login", func(w http.ResponseWriter, r *http.Request) { s.handleLogin(w, r, serviceID) })
	mux.HandleFunc("POST /logout", func(w http.ResponseWriter, r *http.Request) { s.handleLogout(w, r, serviceID) })
	mux.HandleFunc("GET /files", func(w http.ResponseWriter, r *http.Request) { s.handleFiles(w, r, serviceID) })
	mux.HandleFunc("GET /console", func(w http.ResponseWriter, r *http.Request) { s.handleConsolePage(w, r, serviceID) })
	mux.HandleFunc("POST /console", func(w http.ResponseWriter, r *http.Request) { s.handleConsole(w, r, serviceID) })
	return securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.lifecycle.RLock()
		defer s.lifecycle.RUnlock()
		cfg := s.Snapshot()
		r = r.WithContext(context.WithValue(r.Context(), configContextKey{}, cfg))
		if !s.isStarted() {
			http.Error(w, "service unavailable", http.StatusServiceUnavailable)
			return
		}
		if err := connectionError(r.Context()); err != nil {
			http.Error(w, "service unavailable", http.StatusServiceUnavailable)
			return
		}
		if len(r.URL.Path) > 1024 {
			http.Error(w, "request path too long", http.StatusRequestURITooLong)
			return
		}
		s.requestLogger(serviceID, mux).ServeHTTP(w, r)
	}))
}

func (s *Server) requestLogger(serviceID string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sessionID, _, authErr := s.authenticated(r, serviceID)
		if authErr != nil {
			http.Error(w, "service unavailable", http.StatusServiceUnavailable)
			return
		}
		if err := s.emit(r, serviceID, "http.request", sessionID, map[string]any{"method": r.Method, "path": r.URL.Path}); err != nil {
			http.Error(w, "service unavailable", http.StatusServiceUnavailable)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) AdminHandler(token string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /internal/config", func(w http.ResponseWriter, r *http.Request) {
		if !authorized(r, token) {
			http.Error(w, "unauthorized", 401)
			return
		}
		var cfg Configuration
		if err := decodeJSON(w, r, &cfg); err != nil {
			http.Error(w, "invalid config", 400)
			return
		}
		current := s.Snapshot()
		if cfg.TrapID != current.TrapID {
			http.Error(w, "configuration trap does not match this decoy", http.StatusConflict)
			return
		}
		if err := s.ApplyContext(r.Context(), cfg); err != nil {
			http.Error(w, err.Error(), 409)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"trap_id": cfg.TrapID, "profile_id": cfg.ProfileID, "revision": cfg.Revision})
	})
	mux.HandleFunc("POST /internal/start", func(w http.ResponseWriter, r *http.Request) {
		if !authorized(r, token) {
			http.Error(w, "unauthorized", 401)
			return
		}
		s.SetRunning(true)
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /internal/stop", func(w http.ResponseWriter, r *http.Request) {
		if !authorized(r, token) {
			http.Error(w, "unauthorized", 401)
			return
		}
		s.SetRunning(false)
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /internal/status", func(w http.ResponseWriter, r *http.Request) {
		if !authorized(r, token) {
			http.Error(w, "unauthorized", 401)
			return
		}
		s.lifecycle.RLock()
		defer s.lifecycle.RUnlock()
		cfg := s.Snapshot()
		started := s.Started()
		status := "stopped"
		if started {
			status = "running"
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"status": status, "trap_id": cfg.TrapID, "profile_id": cfg.ProfileID, "revision": cfg.Revision})
	})
	return mux
}

func (s *Server) Apply(cfg Configuration) error {
	return s.ApplyContext(context.Background(), cfg)
}

func (s *Server) ApplyContext(ctx context.Context, cfg Configuration) error {
	if !contracts.ValidID(cfg.TrapID) || !contracts.ValidID(cfg.ProfileID) || cfg.Revision < 1 {
		return errors.New("invalid configuration identity")
	}
	if fields := contracts.ValidateProfile(cfg.Config); len(fields) > 0 {
		return fmt.Errorf("invalid profile configuration: %v", fields)
	}
	cfg = cloneConfiguration(cfg)
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if cfg.TrapID != s.cfg.TrapID {
		return errors.New("configuration targets a different trap")
	}
	if !sameListeners(s.cfg.Config.Services, cfg.Config.Services) {
		return errors.New("service listener changes require stopping and restarting the deployment")
	}
	if cfg.ProfileID == s.cfg.ProfileID && cfg.Revision == s.cfg.Revision {
		if sameConfiguration(s.cfg, cfg) {
			return nil
		}
		return errors.New("configuration content conflicts with the applied revision")
	}
	if s.store != nil {
		if err := s.store.Save(cfg); err != nil {
			return fmt.Errorf("persist applied configuration: %w", err)
		}
	}
	s.cfg = cfg
	s.sessions = map[string]session{}
	return nil
}

func (s *Server) SetRunning(value bool) {
	s.lifecycle.Lock()
	defer s.lifecycle.Unlock()
	s.mu.Lock()
	s.started = value
	if !value {
		s.sessions = map[string]session{}
	}
	s.mu.Unlock()
}
func (s *Server) Started() bool { s.mu.RLock(); defer s.mu.RUnlock(); return s.started }
func (s *Server) Snapshot() Configuration {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneConfiguration(s.cfg)
}

func (s *Server) handleRoot(w http.ResponseWriter, r *http.Request, serviceID string) {
	cfg := requestConfiguration(r)
	if cfg.Config.Level == "medium" {
		if _, ok, err := s.authenticated(r, serviceID); err != nil {
			http.Error(w, "service unavailable", 503)
			return
		} else if !ok {
			http.Redirect(w, r, "/login", http.StatusSeeOther)
			return
		}
	}
	title := cfg.Config.VisibleTexts.Title
	service := configuredService(cfg.Config.Services, serviceID)
	if title == "" {
		title = service.Name
	}
	banner := service.Banner
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = rootTemplate.Execute(w, struct {
		Title, Banner string
		Medium        bool
	}{title, banner, cfg.Config.Level == "medium"})
}

func (s *Server) handleLoginPage(w http.ResponseWriter, r *http.Request) {
	cfg := requestConfiguration(r)
	if cfg.Config.Level != "medium" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = loginTemplate.Execute(w, struct{ Title, Prompt string }{cfg.Config.VisibleTexts.Title, cfg.Config.VisibleTexts.LoginPrompt})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request, serviceID string) {
	cfg := requestConfiguration(r)
	if cfg.Config.Level != "medium" {
		http.NotFound(w, r)
		return
	}
	if err := parseBoundedForm(w, r); err != nil {
		writeFormError(w, err)
		return
	}
	username, password := r.Form.Get("username"), r.Form.Get("password")
	if len(username) > 128 || len(password) > 256 {
		http.Error(w, "credentials too long", http.StatusBadRequest)
		return
	}
	if err := s.cleanupOneExpiredSession(r, serviceID); err != nil {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
		return
	}
	accepted := false
	for _, credential := range cfg.Config.SyntheticCredentials {
		u := subtle.ConstantTimeCompare([]byte(username), []byte(credential.Username))
		p := subtle.ConstantTimeCompare([]byte(password), []byte(credential.Password))
		if u&p == 1 {
			accepted = true
		}
	}
	sid := ""
	cookie := ""
	reserved := false
	if accepted {
		s.mu.Lock()
		if len(s.sessions)+s.pendingSessions >= 4096 {
			s.mu.Unlock()
			http.Error(w, "session capacity reached", http.StatusServiceUnavailable)
			return
		}
		s.pendingSessions++
		reserved = true
		s.mu.Unlock()
		defer func() {
			if reserved {
				s.mu.Lock()
				s.pendingSessions--
				s.mu.Unlock()
			}
		}()
		var err error
		sid, err = randomID()
		if err != nil {
			http.Error(w, "session unavailable", 500)
			return
		}
		cookie, err = randomToken()
		if err != nil {
			http.Error(w, "session unavailable", 500)
			return
		}
	}
	payload := map[string]any{"username": username, "outcome": "failed", "sensitive_fields": []string{"username", "credential_attempt"}, "credential_attempt": password}
	if accepted {
		payload["outcome"] = "success"
	}
	if err := s.emit(r, serviceID, "auth.attempt", sid, payload); err != nil {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
		return
	}
	if !accepted {
		failure := cfg.Config.VisibleTexts.Failure
		if failure == "" {
			failure = "Authentication failed"
		}
		http.Error(w, failure, http.StatusUnauthorized)
		return
	}
	if err := s.emit(r, serviceID, "session.started", sid, map[string]any{"username": username, "sensitive_fields": []string{"username"}}); err != nil {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
		return
	}
	s.mu.Lock()
	s.sessions[cookie] = session{id: sid, expires: time.Now().Add(15 * time.Minute)}
	s.pendingSessions--
	reserved = false
	s.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: "archive_session", Value: cookie, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: r.TLS != nil, MaxAge: 900})
	http.Redirect(w, r, "/files", http.StatusSeeOther)
}

func (s *Server) handleFiles(w http.ResponseWriter, r *http.Request, serviceID string) {
	requested := r.URL.Query().Get("path")
	if len(requested) > 1024 {
		http.Error(w, "request path too long", http.StatusRequestURITooLong)
		return
	}
	cfg := requestConfiguration(r)
	sid, ok := "", false
	if cfg.Config.Level == "medium" {
		var authErr error
		sid, ok, authErr = s.authenticated(r, serviceID)
		if authErr != nil {
			http.Error(w, "service unavailable", 503)
			return
		}
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
	}
	if requested == "" {
		if err := s.emit(r, serviceID, "file.listed", sid, map[string]any{"count": len(cfg.Config.FakeFS)}); err != nil {
			http.Error(w, "service unavailable", 503)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		fmt.Fprint(w, "{\"files\":[")
		for i, file := range cfg.Config.FakeFS {
			if i > 0 {
				fmt.Fprint(w, ",")
			}
			fmt.Fprintf(w, "%q", file.Path)
		}
		fmt.Fprint(w, "]}")
		return
	}
	if cfg.Config.Level != "medium" {
		http.Error(w, "file content unavailable", http.StatusForbidden)
		return
	}
	decoded, decodeErr := url.PathUnescape(requested)
	if decodeErr != nil {
		http.NotFound(w, r)
		return
	}
	file, ok := fakeFile(cfg.Config.FakeFS, decoded)
	if !ok {
		http.NotFound(w, r)
		return
	}
	download := r.URL.Query().Get("download") == "1"
	eventType := "file.read"
	if download {
		eventType = "file.downloaded"
	}
	if err := s.emit(r, serviceID, eventType, sid, map[string]any{"path": file.Path}); err != nil {
		http.Error(w, "service unavailable", 503)
		return
	}
	if download {
		w.Header().Set("Content-Disposition", `attachment; filename="`+safeFilename(file.Path)+`"`)
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write([]byte(file.Content))
}

func (s *Server) handleConsolePage(w http.ResponseWriter, r *http.Request, serviceID string) {
	if _, ok, err := s.authenticated(r, serviceID); err != nil {
		http.Error(w, "service unavailable", 503)
		return
	} else if !ok {
		http.Error(w, "unauthorized", 401)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = consoleTemplate.Execute(w, nil)
}

func (s *Server) handleConsole(w http.ResponseWriter, r *http.Request, serviceID string) {
	sid, ok, authErr := s.authenticated(r, serviceID)
	if authErr != nil {
		http.Error(w, "service unavailable", 503)
		return
	}
	if !ok {
		http.Error(w, "unauthorized", 401)
		return
	}
	if err := parseBoundedForm(w, r); err != nil {
		writeFormError(w, err)
		return
	}
	input := strings.TrimSpace(r.Form.Get("command"))
	if len(input) > 1024 {
		http.Error(w, "command too long", http.StatusBadRequest)
		return
	}
	parts := strings.Fields(input)
	cfg := requestConfiguration(r)
	output := ""
	if len(parts) > 0 {
		switch parts[0] {
		case "pwd":
			if len(parts) == 1 {
				output = "/"
			} else {
				output = "usage: pwd"
			}
		case "ls":
			if len(parts) == 1 {
				for _, file := range cfg.Config.FakeFS {
					output += file.Path + "\n"
				}
			} else {
				output = "usage: ls"
			}
		case "cat":
			pathText := strings.TrimSpace(strings.TrimPrefix(input, parts[0]))
			path, pathErr := url.PathUnescape(pathText)
			if pathText == "" {
				output = "usage: cat <path>"
			} else if file, ok := fakeFile(cfg.Config.FakeFS, path); pathErr == nil && ok {
				output = file.Content
			} else {
				output = "file not found"
			}
		default:
			output = "command not found: " + parts[0]
		}
	}
	telemetryOutput, truncated := limitUTF8(output, 8192)
	if err := s.emit(r, serviceID, "command.received", sid, map[string]any{"command": input, "output": telemetryOutput, "output_truncated": truncated}); err != nil {
		http.Error(w, "service unavailable", 503)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write([]byte(output))
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request, serviceID string) {
	sid, ok, authErr := s.authenticated(r, serviceID)
	if authErr != nil {
		http.Error(w, "service unavailable", 503)
		return
	}
	if !ok {
		http.Error(w, "unauthorized", 401)
		return
	}
	if err := s.emit(r, serviceID, "session.ended", sid, map[string]any{}); err != nil {
		http.Error(w, "service unavailable", 503)
		return
	}
	if c, err := r.Cookie("archive_session"); err == nil {
		s.mu.Lock()
		delete(s.sessions, c.Value)
		s.mu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{Name: "archive_session", Value: "", Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: -1})
	http.Redirect(w, r, "/login", http.StatusSeeOther)
}

func (s *Server) authenticated(r *http.Request, serviceID string) (string, bool, error) {
	c, err := r.Cookie("archive_session")
	if err != nil {
		return "", false, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok := s.sessions[c.Value]
	if !ok {
		return "", false, nil
	}
	if time.Now().After(session.expires) {
		if err := s.emit(r, serviceID, "session.ended", session.id, map[string]any{"reason": "expired"}); err != nil {
			return "", false, err
		}
		delete(s.sessions, c.Value)
		return "", false, nil
	}
	return session.id, true, nil
}

func (s *Server) cleanupOneExpiredSession(r *http.Request, serviceID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for cookie, item := range s.sessions {
		if now.After(item.expires) {
			if err := s.emit(r, serviceID, "session.ended", item.id, map[string]any{"reason": "expired"}); err != nil {
				return err
			}
			delete(s.sessions, cookie)
			break // Keep login-time cleanup bounded to one durable event.
		}
	}
	return nil
}
func (s *Server) isStarted() bool { s.mu.RLock(); defer s.mu.RUnlock(); return s.started }

func (s *Server) emit(r *http.Request, serviceID, eventType, sessionID string, payload map[string]any) error {
	if s.sink == nil {
		return errors.New("agent event sink is unavailable")
	}
	cfg := requestConfiguration(r)
	host, portText, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
		portText = "0"
	}
	port, _ := strconv.Atoi(portText)
	sourcePort := port
	event, err := s.newEvent(cfg, serviceID, eventType, sessionID, host, sourcePort, servicePort(cfg.Config.Services, serviceID), payload)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	return s.sink.Submit(ctx, event)
}

// ConnectionContext records one durable event per accepted network connection,
// before net/http can dispatch its first request on that connection.
func (s *Server) ConnectionContext(serviceID string) func(context.Context, net.Conn) context.Context {
	return func(ctx context.Context, conn net.Conn) context.Context {
		s.lifecycle.RLock()
		defer s.lifecycle.RUnlock()
		cfg := s.Snapshot()
		ctx = context.WithValue(ctx, configContextKey{}, cfg)
		if !hasCategory(cfg.Config.Logging.Categories, "connection.opened") {
			return ctx
		}
		err := s.emitConnection(ctx, conn, cfg, serviceID)
		if err == nil {
			return ctx
		}
		return context.WithValue(ctx, connectionErrorContextKey{}, err)
	}
}

func (s *Server) emitConnection(ctx context.Context, conn net.Conn, cfg Configuration, serviceID string) error {
	if s.sink == nil {
		return errors.New("agent event sink is unavailable")
	}
	remoteHost, remotePortText, err := net.SplitHostPort(conn.RemoteAddr().String())
	if err != nil {
		remoteHost, remotePortText = conn.RemoteAddr().String(), "0"
	}
	remotePort, _ := strconv.Atoi(remotePortText)
	localPort := 0
	if _, portText, splitErr := net.SplitHostPort(conn.LocalAddr().String()); splitErr == nil {
		localPort, _ = strconv.Atoi(portText)
	}
	event, err := s.newEvent(cfg, serviceID, "connection.opened", "", remoteHost, remotePort, localPort, map[string]any{})
	if err != nil {
		return err
	}
	submitCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return s.sink.Submit(submitCtx, event)
}

func (s *Server) newEvent(cfg Configuration, serviceID, eventType, sessionID, sourceIP string, sourcePort, destinationPort int, payload map[string]any) (contracts.Event, error) {
	eventID, err := randomID()
	if err != nil {
		return contracts.Event{}, err
	}
	now := time.Now().UTC()
	for {
		previous := s.lastEventUnixNano.Load()
		if now.UnixNano() <= previous {
			now = time.Unix(0, previous+1).UTC()
		}
		if s.lastEventUnixNano.CompareAndSwap(previous, now.UnixNano()) {
			break
		}
	}
	return contracts.Event{SchemaVersion: "1.0", EventID: eventID, TrapID: cfg.TrapID, ServiceID: serviceID, SessionID: sessionID, ProfileID: cfg.ProfileID, AppliedRevision: &cfg.Revision, EventType: eventType, Timestamp: now.Format(time.RFC3339Nano), SourceIP: sourceIP, SourcePort: &sourcePort, DestinationPort: destinationPort, Protocol: "http", Payload: payload}, nil
}

func fakeFile(files []contracts.FakeFile, requested string) (contracts.FakeFile, bool) {
	if len(requested) > 256 || !utf8.ValidString(requested) || strings.ContainsAny(requested, "\\:\x00") {
		return contracts.FakeFile{}, false
	}
	requested = strings.TrimPrefix(requested, "/")
	for _, file := range files {
		if subtle.ConstantTimeCompare([]byte(file.Path), []byte(requested)) == 1 {
			return file, true
		}
	}
	return contracts.FakeFile{}, false
}
func servicePort(services []contracts.Service, id string) int {
	for _, service := range services {
		if service.ID == id {
			return service.Port
		}
	}
	return 0
}
func sameListeners(a, b []contracts.Service) bool {
	if len(a) != len(b) {
		return false
	}
	byID := make(map[string]contracts.Service, len(a))
	for _, service := range a {
		byID[service.ID] = service
	}
	for _, service := range b {
		old, ok := byID[service.ID]
		if !ok || old.Port != service.Port || old.Protocol != service.Protocol {
			return false
		}
	}
	return true
}
func cloneConfiguration(cfg Configuration) Configuration {
	cfg.Config.Services = append([]contracts.Service(nil), cfg.Config.Services...)
	cfg.Config.SyntheticCredentials = append([]contracts.SyntheticCredential(nil), cfg.Config.SyntheticCredentials...)
	cfg.Config.FakeFS = append([]contracts.FakeFile(nil), cfg.Config.FakeFS...)
	cfg.Config.Logging.Categories = append([]string(nil), cfg.Config.Logging.Categories...)
	return cfg
}
func sameConfiguration(a, b Configuration) bool { return reflect.DeepEqual(a, b) }
func requestConfiguration(r *http.Request) Configuration {
	if cfg, ok := r.Context().Value(configContextKey{}).(Configuration); ok {
		return cfg
	}
	return Configuration{}
}
func connectionError(ctx context.Context) error {
	err, _ := ctx.Value(connectionErrorContextKey{}).(error)
	return err
}
func hasCategory(categories []string, category string) bool {
	for _, configured := range categories {
		if configured == category {
			return true
		}
	}
	return false
}
func configuredService(services []contracts.Service, id string) contracts.Service {
	for _, service := range services {
		if service.ID == id {
			return service
		}
	}
	return contracts.Service{}
}
func parseBoundedForm(w http.ResponseWriter, r *http.Request) error {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	return r.ParseForm()
}
func writeFormError(w http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		http.Error(w, "form too large", http.StatusRequestEntityTooLarge)
		return
	}
	http.Error(w, "invalid form", http.StatusBadRequest)
}
func limitUTF8(value string, maxBytes int) (string, bool) {
	if len(value) <= maxBytes {
		return value, false
	}
	value = value[:maxBytes]
	for !utf8.ValidString(value) {
		value = value[:len(value)-1]
	}
	return value, true
}
func randomID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	h := hex.EncodeToString(b[:])
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:], nil
}
func randomToken() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}
func safeFilename(path string) string {
	part := path[strings.LastIndex(path, "/")+1:]
	return strings.NewReplacer("\"", "", "\r", "", "\n", "").Replace(part)
}
func authorized(r *http.Request, token string) bool {
	value := r.Header.Get("Authorization")
	return token != "" && strings.HasPrefix(value, "Bearer ") && subtle.ConstantTimeCompare([]byte(strings.TrimPrefix(value, "Bearer ")), []byte(token)) == 1
}
func decodeJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	return json.NewDecoder(r.Body).Decode(dst)
}
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

var rootTemplate = template.Must(template.New("root").Parse(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>{{.Title}}</title><h1>{{.Title}}</h1><p>{{.Banner}}</p>{{if .Medium}}<a href="/files">Архив</a>{{end}}</html>`))
var loginTemplate = template.Must(template.New("login").Parse(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>{{.Title}}</title><h1>{{.Title}}</h1><form method="post" action="/login"><label>{{.Prompt}} <input name="username" autocomplete="username"></label><label>Пароль <input type="password" name="password" autocomplete="current-password"></label><button>Войти</button></form></html>`))
var consoleTemplate = template.Must(template.New("console").Parse(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>Консоль</title><form method="post"><label>Команда <input name="command"></label><button>Выполнить</button></form></html>`))
