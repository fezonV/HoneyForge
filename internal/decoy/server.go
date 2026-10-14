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

type Server struct {
	mu                sync.RWMutex
	cfg               Configuration
	sink              EventSink
	sessions          map[string]session
	started           bool
	lastEventUnixNano atomic.Int64
}

func New(cfg Configuration, sink EventSink) (*Server, error) {
	if !contracts.ValidID(cfg.TrapID) || !contracts.ValidID(cfg.ProfileID) || cfg.Revision < 1 {
		return nil, errors.New("trap, profile and positive revision are required")
	}
	if fields := contracts.ValidateProfile(cfg.Config); len(fields) > 0 {
		return nil, fmt.Errorf("invalid profile configuration: %v", fields)
	}
	return &Server{cfg: cfg, sink: sink, sessions: map[string]session{}}, nil
}

func (s *Server) PublicHandler(serviceID string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) { s.handleRoot(w, r, serviceID) })
	mux.HandleFunc("GET /login", s.handleLoginPage)
	mux.HandleFunc("POST /login", func(w http.ResponseWriter, r *http.Request) { s.handleLogin(w, r, serviceID) })
	mux.HandleFunc("POST /logout", func(w http.ResponseWriter, r *http.Request) { s.handleLogout(w, r, serviceID) })
	mux.HandleFunc("GET /files", func(w http.ResponseWriter, r *http.Request) { s.handleFiles(w, r, serviceID) })
	mux.HandleFunc("GET /console", func(w http.ResponseWriter, r *http.Request) { s.handleConsolePage(w, r, serviceID) })
	mux.HandleFunc("POST /console", func(w http.ResponseWriter, r *http.Request) { s.handleConsole(w, r, serviceID) })
	return securityHeaders(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.isStarted() {
			http.Error(w, "service unavailable", http.StatusServiceUnavailable)
			return
		}
		s.requestLogger(serviceID, mux).ServeHTTP(w, r)
	}))
}

func (s *Server) requestLogger(serviceID string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sessionID, _ := s.authenticated(r)
		if err := s.emit(r, serviceID, "http.request", sessionID, map[string]any{"method": r.Method, "path": r.URL.Path}); err != nil {
			http.Error(w, "telemetry unavailable", http.StatusServiceUnavailable)
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
		if err := s.Apply(cfg); err != nil {
			http.Error(w, err.Error(), 409)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /internal/start", func(w http.ResponseWriter, r *http.Request) {
		if !authorized(r, token) {
			http.Error(w, "unauthorized", 401)
			return
		}
		s.setStarted(true)
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /internal/stop", func(w http.ResponseWriter, r *http.Request) {
		if !authorized(r, token) {
			http.Error(w, "unauthorized", 401)
			return
		}
		s.setStarted(false)
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /internal/status", func(w http.ResponseWriter, r *http.Request) {
		if !authorized(r, token) {
			http.Error(w, "unauthorized", 401)
			return
		}
		s.mu.RLock()
		started := s.started
		s.mu.RUnlock()
		status := "stopped"
		if started {
			status = "running"
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"status":%q}`, status)
	})
	return mux
}

func (s *Server) Apply(cfg Configuration) error {
	if !contracts.ValidID(cfg.TrapID) || !contracts.ValidID(cfg.ProfileID) || cfg.Revision < 1 {
		return errors.New("invalid configuration identity")
	}
	if fields := contracts.ValidateProfile(cfg.Config); len(fields) > 0 {
		return fmt.Errorf("invalid profile configuration: %v", fields)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if cfg.TrapID != s.cfg.TrapID {
		return errors.New("configuration targets a different trap")
	}
	if cfg.ProfileID == s.cfg.ProfileID && cfg.Revision < s.cfg.Revision {
		return errors.New("configuration revision cannot move backwards")
	}
	if !sameListeners(s.cfg.Config.Services, cfg.Config.Services) {
		return errors.New("service listener changes require stopping and restarting the deployment")
	}
	s.cfg = cfg
	s.sessions = map[string]session{}
	return nil
}

func (s *Server) setStarted(value bool) { s.mu.Lock(); s.started = value; s.mu.Unlock() }
func (s *Server) SetRunning(value bool) { s.setStarted(value) }
func (s *Server) Started() bool         { s.mu.RLock(); defer s.mu.RUnlock(); return s.started }
func (s *Server) Snapshot() Configuration {
	s.mu.RLock()
	defer s.mu.RUnlock()
	copy := s.cfg
	copy.Config.Services = append([]contracts.Service(nil), s.cfg.Config.Services...)
	copy.Config.SyntheticCredentials = append([]contracts.SyntheticCredential(nil), s.cfg.Config.SyntheticCredentials...)
	copy.Config.FakeFS = append([]contracts.FakeFile(nil), s.cfg.Config.FakeFS...)
	copy.Config.Logging.Categories = append([]string(nil), s.cfg.Config.Logging.Categories...)
	return copy
}

func (s *Server) handleRoot(w http.ResponseWriter, r *http.Request, serviceID string) {
	cfg := s.Snapshot()
	if !s.isStarted() {
		http.Error(w, "service unavailable", http.StatusServiceUnavailable)
		return
	}
	if cfg.Config.Level == "medium" {
		if _, ok := s.authenticated(r); !ok {
			http.Redirect(w, r, "/login", http.StatusSeeOther)
			return
		}
	}
	title := cfg.Config.VisibleTexts.Title
	if title == "" {
		title = cfg.Config.Services[0].Name
	}
	banner := cfg.Config.Services[0].Banner
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = rootTemplate.Execute(w, struct {
		Title, Banner string
		Medium        bool
	}{title, banner, cfg.Config.Level == "medium"})
}

func (s *Server) handleLoginPage(w http.ResponseWriter, r *http.Request) {
	cfg := s.Snapshot()
	if cfg.Config.Level != "medium" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = loginTemplate.Execute(w, struct{ Title, Prompt string }{cfg.Config.VisibleTexts.Title, cfg.Config.VisibleTexts.LoginPrompt})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request, serviceID string) {
	cfg := s.Snapshot()
	if cfg.Config.Level != "medium" {
		http.NotFound(w, r)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid form", 400)
		return
	}
	username, password := r.Form.Get("username"), r.Form.Get("password")
	accepted := false
	for _, credential := range cfg.Config.SyntheticCredentials {
		u := subtle.ConstantTimeCompare([]byte(username), []byte(credential.Username))
		p := subtle.ConstantTimeCompare([]byte(password), []byte(credential.Password))
		if u&p == 1 {
			accepted = true
		}
	}
	payload := map[string]any{"username": username, "outcome": "failed", "sensitive_fields": []string{"credential_attempt"}, "credential_attempt": password}
	if accepted {
		payload["outcome"] = "success"
	}
	if err := s.emit(r, serviceID, "auth.attempt", "", payload); err != nil {
		http.Error(w, "telemetry unavailable", http.StatusServiceUnavailable)
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
	sid, err := randomID()
	if err != nil {
		http.Error(w, "session unavailable", 500)
		return
	}
	if err = s.emit(r, serviceID, "session.started", sid, map[string]any{"username": username}); err != nil {
		http.Error(w, "telemetry unavailable", http.StatusServiceUnavailable)
		return
	}
	cookie, err := randomToken()
	if err != nil {
		http.Error(w, "session unavailable", 500)
		return
	}
	s.mu.Lock()
	s.sessions[cookie] = session{id: sid, expires: time.Now().Add(15 * time.Minute)}
	s.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: "decoy_session", Value: cookie, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: r.TLS != nil, MaxAge: 900})
	http.Redirect(w, r, "/files", http.StatusSeeOther)
}

func (s *Server) handleFiles(w http.ResponseWriter, r *http.Request, serviceID string) {
	sid, ok := s.authenticated(r)
	if !ok {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	requested := r.URL.Query().Get("path")
	cfg := s.Snapshot()
	if requested == "" {
		if err := s.emit(r, serviceID, "file.listed", sid, map[string]any{"count": len(cfg.Config.FakeFS)}); err != nil {
			http.Error(w, "telemetry unavailable", 503)
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
		http.Error(w, "telemetry unavailable", 503)
		return
	}
	if download {
		w.Header().Set("Content-Disposition", `attachment; filename="`+safeFilename(file.Path)+`"`)
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write([]byte(file.Content))
}

func (s *Server) handleConsolePage(w http.ResponseWriter, r *http.Request, serviceID string) {
	if _, ok := s.authenticated(r); !ok {
		http.Error(w, "unauthorized", 401)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_ = consoleTemplate.Execute(w, nil)
}

func (s *Server) handleConsole(w http.ResponseWriter, r *http.Request, serviceID string) {
	sid, ok := s.authenticated(r)
	if !ok {
		http.Error(w, "unauthorized", 401)
		return
	}
	if err := r.ParseForm(); err != nil {
		http.Error(w, "invalid form", 400)
		return
	}
	input := strings.TrimSpace(r.Form.Get("command"))
	parts := strings.Fields(input)
	cfg := s.Snapshot()
	output := "command not found"
	if len(parts) > 0 {
		switch parts[0] {
		case "pwd":
			output = "/"
		case "ls":
			for _, file := range cfg.Config.FakeFS {
				output += file.Path + "\n"
			}
		case "cat":
			if len(parts) == 2 {
				path, pathErr := url.PathUnescape(parts[1])
				if file, ok := fakeFile(cfg.Config.FakeFS, path); pathErr == nil && ok {
					output = file.Content
				} else {
					output = "file not found"
				}
			} else {
				output = "usage: cat <path>"
			}
		}
	}
	if err := s.emit(r, serviceID, "command.received", sid, map[string]any{"command": input, "output": output}); err != nil {
		http.Error(w, "telemetry unavailable", 503)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write([]byte(output))
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request, serviceID string) {
	sid, ok := s.authenticated(r)
	if !ok {
		http.Error(w, "unauthorized", 401)
		return
	}
	if err := s.emit(r, serviceID, "session.ended", sid, map[string]any{}); err != nil {
		http.Error(w, "telemetry unavailable", 503)
		return
	}
	if c, err := r.Cookie("decoy_session"); err == nil {
		s.mu.Lock()
		delete(s.sessions, c.Value)
		s.mu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{Name: "decoy_session", Value: "", Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: -1})
	http.Redirect(w, r, "/login", http.StatusSeeOther)
}

func (s *Server) authenticated(r *http.Request) (string, bool) {
	c, err := r.Cookie("decoy_session")
	if err != nil {
		return "", false
	}
	s.mu.RLock()
	session, ok := s.sessions[c.Value]
	s.mu.RUnlock()
	if !ok || time.Now().After(session.expires) {
		s.mu.Lock()
		delete(s.sessions, c.Value)
		s.mu.Unlock()
		return "", false
	}
	return session.id, true
}
func (s *Server) isStarted() bool { s.mu.RLock(); defer s.mu.RUnlock(); return s.started }

func (s *Server) emit(r *http.Request, serviceID, eventType, sessionID string, payload map[string]any) error {
	if s.sink == nil {
		return errors.New("agent event sink is unavailable")
	}
	cfg := s.Snapshot()
	host, portText, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
		portText = "0"
	}
	port, _ := strconv.Atoi(portText)
	sourcePort := port
	eventID, err := randomID()
	if err != nil {
		return err
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
	event := contracts.Event{SchemaVersion: "1.0", EventID: eventID, TrapID: cfg.TrapID, ServiceID: serviceID, SessionID: sessionID, ProfileID: cfg.ProfileID, AppliedRevision: &cfg.Revision, EventType: eventType, Timestamp: now.Format(time.RFC3339Nano), SourceIP: host, SourcePort: &sourcePort, DestinationPort: servicePort(cfg.Config.Services, serviceID), Protocol: "http", Payload: payload}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	return s.sink.Submit(ctx, event)
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
