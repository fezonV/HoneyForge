package control

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
	"honeyforge/internal/contracts"
)

type Config struct {
	PublicOrigin           string
	CookieSecure           bool
	GeoResolver            GeoResolver
	AgentOrigin            string
	BundleSourceRepository string
	BundleSourceRevision   string
}
type Server struct {
	db             *pgxpool.Pool
	origin         string
	agentOrigin    string
	bundleSource   string
	bundleRevision string
	secure         bool
	geo            GeoResolver
	ws             *wsHub
	mu             sync.Mutex
	logins         map[string][]time.Time
}
type ctxKey string

const actorKey ctxKey = "actor"

var dummyPasswordHash = func() []byte {
	h, err := bcrypt.GenerateFromPassword([]byte("not-a-real-password"), bcrypt.DefaultCost)
	if err != nil {
		panic(err)
	}
	return h
}()

type actor struct {
	id, role, session string
	csrfHash          []byte
}
type apiFailure struct {
	status        int
	code, message string
	fields        map[string]string
}

func New(db *pgxpool.Pool, cfg Config) *Server {
	return &Server{db: db, origin: strings.TrimRight(cfg.PublicOrigin, "/"), agentOrigin: strings.TrimRight(cfg.AgentOrigin, "/"), bundleSource: cfg.BundleSourceRepository, bundleRevision: cfg.BundleSourceRevision, secure: cfg.CookieSecure, geo: cfg.GeoResolver, ws: newWSHub(), logins: map[string][]time.Time{}}
}
func (s *Server) Handler() http.Handler {
	m := http.NewServeMux()
	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]string{"status": "ok"}) })
	m.HandleFunc("GET /readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := s.db.Ping(ctx); err != nil {
			fail(w, r, 503, "not_ready", "database unavailable", nil)
			return
		}
		writeJSON(w, 200, map[string]string{"status": "ready"})
	})
	m.Handle("GET /api/v1/templates", s.auth(false, "", http.HandlerFunc(s.templates)))
	m.HandleFunc("POST /api/v1/auth/login", s.login)
	m.Handle("POST /api/v1/auth/logout", s.auth(true, "", http.HandlerFunc(s.logout)))
	m.Handle("GET /api/v1/auth/me", s.auth(false, "", http.HandlerFunc(s.me)))
	m.Handle("GET /api/v1/profiles", s.auth(false, "", http.HandlerFunc(s.listProfiles)))
	m.Handle("POST /api/v1/profiles", s.auth(true, "operator", http.HandlerFunc(s.createProfile)))
	m.Handle("GET /api/v1/profiles/{id}", s.auth(false, "", http.HandlerFunc(s.getProfile)))
	m.Handle("PATCH /api/v1/profiles/{id}", s.auth(true, "operator", http.HandlerFunc(s.patchProfile)))
	m.Handle("DELETE /api/v1/profiles/{id}", s.auth(true, "operator", http.HandlerFunc(s.deleteProfile)))
	m.Handle("GET /api/v1/profiles/{id}/revisions", s.auth(false, "", http.HandlerFunc(s.listRevisions)))
	m.Handle("GET /api/v1/profiles/{id}/revisions/{revision}", s.auth(false, "", http.HandlerFunc(s.getRevision)))
	m.Handle("GET /api/v1/profiles/{id}/revisions/{revision}/sensitive", s.auth(false, "operator", http.HandlerFunc(s.getSensitiveRevision)))
	m.Handle("GET /api/v1/traps", s.auth(false, "", http.HandlerFunc(s.listTraps)))
	m.Handle("POST /api/v1/traps", s.auth(true, "operator", http.HandlerFunc(s.createTrap)))
	m.Handle("GET /api/v1/traps/{id}", s.auth(false, "", http.HandlerFunc(s.getTrap)))
	m.Handle("PUT /api/v1/traps/{id}/profile", s.auth(true, "operator", http.HandlerFunc(s.assignProfile)))
	m.Handle("DELETE /api/v1/traps/{id}/profile", s.auth(true, "operator", http.HandlerFunc(s.detachProfile)))
	m.Handle("DELETE /api/v1/traps/{id}", s.auth(true, "operator", http.HandlerFunc(s.deleteTrap)))
	m.Handle("POST /api/v1/traps/{id}/enrollment-token", s.auth(true, "operator", http.HandlerFunc(s.createEnrollment)))
	m.Handle("GET /api/v1/traps/{id}/bundle", s.auth(false, "operator", http.HandlerFunc(s.downloadTrapBundle)))
	m.Handle("POST /api/v1/traps/{id}/commands", s.auth(true, "operator", http.HandlerFunc(s.queueCommand)))
	m.Handle("GET /api/v1/traps/{id}/commands", s.auth(false, "", http.HandlerFunc(s.listCommands)))
	m.Handle("GET /api/v1/events", s.auth(false, "", http.HandlerFunc(s.listEvents)))
	m.Handle("GET /api/v1/events/summary", s.auth(false, "", http.HandlerFunc(s.eventSummary)))
	m.Handle("GET /api/v1/events/export.csv", s.auth(false, "operator", http.HandlerFunc(s.exportEventsCSV)))
	m.Handle("GET /api/v1/traps/{trap_id}/events/{event_id}", s.auth(false, "", http.HandlerFunc(s.getEvent)))
	m.Handle("GET /api/v1/traps/{trap_id}/events/{event_id}/sensitive", s.auth(false, "operator", http.HandlerFunc(s.getSensitiveEvent)))
	m.Handle("GET /api/v1/sessions/{id}/timeline", s.auth(false, "", http.HandlerFunc(s.getSessionTimeline)))
	m.Handle("GET /api/v1/ws", s.websocketOrigin(s.auth(false, "", http.HandlerFunc(s.websocket))))
	m.Handle("GET /api/v1/audit", s.auth(false, "operator", http.HandlerFunc(s.listAudit)))
	m.HandleFunc("POST /agent/v1/enroll", s.enroll)
	m.HandleFunc("POST /agent/v1/traps/{id}/heartbeat", s.agentHeartbeat)
	m.HandleFunc("POST /agent/v1/traps/{id}/events", s.agentEvents)
	m.HandleFunc("GET /agent/v1/traps/{id}/commands", s.agentCommands)
	m.HandleFunc("POST /agent/v1/traps/{id}/commands/{command_id}", s.agentCommandResult)
	m.HandleFunc("GET /agent/v1/traps/{id}/config", s.agentConfig)
	return s.requestIDs(m)
}

func (s *Server) requestIDs(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := randomToken(12)
		r = r.WithContext(context.WithValue(r.Context(), ctxKey("request_id"), id))
		w.Header().Set("X-Request-ID", id)
		w.Header().Set("Cache-Control", "no-store")
		mux, ok := next.(*http.ServeMux)
		if !ok {
			next.ServeHTTP(w, r)
			return
		}
		_, pattern := mux.Handler(r)
		if pattern != "" {
			next.ServeHTTP(w, r)
			return
		}
		capture := &responseCapture{header: make(http.Header)}
		next.ServeHTTP(capture, r)
		status := capture.status
		if status == 0 {
			status = http.StatusOK
		}
		if status != http.StatusNotFound && status != http.StatusMethodNotAllowed {
			for k, values := range capture.header {
				for _, v := range values {
					w.Header().Add(k, v)
				}
			}
			w.WriteHeader(status)
			_, _ = w.Write(capture.body.Bytes())
			return
		}
		if allow := capture.header.Get("Allow"); allow != "" {
			w.Header().Set("Allow", allow)
		}
		if status == http.StatusMethodNotAllowed {
			fail(w, r, 405, "method_not_allowed", "method is not supported for this resource", nil)
		} else {
			fail(w, r, 404, "not_found", "resource not found", nil)
		}
	})
}

type responseCapture struct {
	header http.Header
	body   bytes.Buffer
	status int
}

func (c *responseCapture) Header() http.Header { return c.header }
func (c *responseCapture) WriteHeader(status int) {
	if c.status == 0 {
		c.status = status
	}
}
func (c *responseCapture) Write(p []byte) (int, error) {
	if c.status == 0 {
		c.status = http.StatusOK
	}
	return c.body.Write(p)
}
func requestID(r *http.Request) string {
	v, _ := r.Context().Value(ctxKey("request_id")).(string)
	return v
}
func fail(w http.ResponseWriter, r *http.Request, status int, code, msg string, fields map[string]string) {
	writeJSON(w, status, contracts.APIError{Error: contracts.ErrorDetail{Code: code, Message: msg, RequestID: requestID(r), Fields: fields}})
}
func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func decode(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, contracts.MaxBodyBytes)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(dst); err != nil {
		var max *http.MaxBytesError
		if errors.As(err, &max) {
			fail(w, r, 413, "body_too_large", "request body exceeds 1 MiB", nil)
		} else {
			fail(w, r, 400, "invalid_json", "request body must be one valid JSON object with known fields", nil)
		}
		return false
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		fail(w, r, 400, "invalid_json", "request body must contain exactly one JSON value", nil)
		return false
	}
	return true
}
func randomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}
func randomToken(n int) string     { return base64.RawURLEncoding.EncodeToString(randomBytes(n)) }
func base64Cursor(s string) string { return base64.RawURLEncoding.EncodeToString([]byte(s)) }
func uuid() string {
	b := randomBytes(16)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func tokenHash(s string) []byte { x := sha256.Sum256([]byte(s)); return x[:] }
func parsePage(r *http.Request, allowedFilters ...string) (int, string, *apiFailure) {
	q := r.URL.Query()
	allowed := map[string]bool{"limit": true, "cursor": true}
	for _, k := range allowedFilters {
		allowed[k] = true
	}
	for k := range q {
		if !allowed[k] {
			return 0, "", &apiFailure{400, "invalid_query", "unsupported query parameter", map[string]string{k: "unsupported"}}
		}
		if len(q[k]) != 1 {
			return 0, "", &apiFailure{400, "invalid_query", "query parameters may appear only once", map[string]string{k: "duplicate"}}
		}
	}
	limit := contracts.DefaultPageSize
	if vals, ok := q["limit"]; ok {
		v := vals[0]
		n, e := strconv.Atoi(v)
		if e != nil || n < 1 || n > contracts.MaxPageSize {
			return 0, "", &apiFailure{400, "invalid_limit", "limit must be between 1 and 100", nil}
		}
		limit = n
	}
	cur := q.Get("cursor")
	if _, ok := q["cursor"]; ok {
		if cur == "" || len(cur) > 64 {
			return 0, "", &apiFailure{400, "invalid_cursor", "cursor is invalid", nil}
		}
		b, e := base64.RawURLEncoding.DecodeString(cur)
		if e != nil || len(b) > 256 || !contracts.ValidID(string(b)) {
			return 0, "", &apiFailure{400, "invalid_cursor", "cursor is invalid", nil}
		}
		cur = string(b)
	}
	return limit, cur, nil
}
func (s *Server) auth(csrf bool, role string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie("hf_session")
		if err != nil || c.Value == "" {
			fail(w, r, 401, "unauthorized", "authentication required", nil)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		var a actor
		err = s.db.QueryRow(ctx, `SELECT u.id::text,u.role,os.id::text,os.csrf_hash FROM operator_sessions os JOIN users u ON u.id=os.user_id WHERE os.token_hash=$1 AND os.revoked_at IS NULL AND os.expires_at>now()`, tokenHash(c.Value)).Scan(&a.id, &a.role, &a.session, &a.csrfHash)
		if err != nil {
			if noRows(err) {
				fail(w, r, 401, "unauthorized", "authentication required", nil)
			} else {
				fail(w, r, 503, "not_ready", "authentication service unavailable", nil)
			}
			return
		}
		if role != "" && a.role != role {
			fail(w, r, 403, "forbidden", "insufficient permission", nil)
			return
		}
		if csrf {
			if err = s.checkOrigin(r); err != nil {
				fail(w, r, 403, "origin_forbidden", "request origin is not allowed", nil)
				return
			}
			cc, e := r.Cookie("csrf_token")
			if e != nil || len(cc.Value) == 0 || subtle.ConstantTimeCompare(tokenHash(cc.Value), a.csrfHash) != 1 {
				fail(w, r, 403, "csrf_failed", "CSRF validation failed", nil)
				return
			}
			if r.Header.Get("X-CSRF-Token") != cc.Value {
				fail(w, r, 403, "csrf_failed", "CSRF validation failed", nil)
				return
			}
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), actorKey, a)))
	})
}
func currentActor(r *http.Request) actor { a, _ := r.Context().Value(actorKey).(actor); return a }
func (s *Server) checkOrigin(r *http.Request) error {
	o := r.Header.Get("Origin")
	if o != "" && o != s.origin {
		return errors.New("origin mismatch")
	}
	return nil
}
func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if err := s.checkOrigin(r); err != nil {
		fail(w, r, 403, "origin_forbidden", "request origin is not allowed", nil)
		return
	}
	if !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
		fail(w, r, 400, "content_type", "login requires application/json", nil)
		return
	}
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	if ip == "" {
		ip = r.RemoteAddr
	}
	if !s.allowLogin(ip) {
		fail(w, r, 429, "rate_limited", "too many login attempts", nil)
		return
	}
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !decode(w, r, &req) {
		return
	}
	if len(req.Username) == 0 || len(req.Username) > 120 || len(req.Password) == 0 || len(req.Password) > 72 {
		fail(w, r, 401, "invalid_credentials", "username or password is invalid", nil)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
	defer cancel()
	var id, hash, role string
	err := s.db.QueryRow(ctx, "SELECT id::text,password_hash,role FROM users WHERE username=$1", req.Username).Scan(&id, &hash, &role)
	if err != nil && !noRows(err) {
		fail(w, r, 503, "not_ready", "authentication service unavailable", nil)
		return
	}
	compareHash := []byte(hash)
	if noRows(err) {
		compareHash = dummyPasswordHash
	}
	valid := bcrypt.CompareHashAndPassword(compareHash, []byte(req.Password)) == nil && err == nil
	if !valid {
		if auditErr := s.audit(ctx, nil, "auth.login_failed", "user", "", map[string]any{"outcome": "invalid_credentials"}); auditErr != nil {
			fail(w, r, 503, "not_ready", "authentication service unavailable", nil)
			return
		}
		fail(w, r, 401, "invalid_credentials", "username or password is invalid", nil)
		return
	}
	session, csrf := randomToken(32), randomToken(32)
	sid := uuid()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		fail(w, r, 503, "not_ready", "authentication service unavailable", nil)
		return
	}
	defer tx.Rollback(context.Background())
	_, err = tx.Exec(ctx, "INSERT INTO operator_sessions(id,user_id,token_hash,csrf_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '8 hours')", sid, id, tokenHash(session), tokenHash(csrf))
	if err == nil {
		err = auditTx(ctx, tx, &id, "auth.login", "user", id, map[string]any{})
	}
	if err != nil {
		log.Printf("request %s: create session failed", requestID(r))
		fail(w, r, 503, "not_ready", "authentication service unavailable", nil)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		fail(w, r, 503, "not_ready", "authentication service unavailable", nil)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "hf_session", Value: session, Path: "/", HttpOnly: true, Secure: s.secure, SameSite: http.SameSiteLaxMode, MaxAge: 28800})
	http.SetCookie(w, &http.Cookie{Name: "csrf_token", Value: csrf, Path: "/", Secure: s.secure, SameSite: http.SameSiteLaxMode, MaxAge: 28800})
	writeJSON(w, 200, map[string]any{"user": map[string]string{"id": id, "username": req.Username, "role": role}, "csrf_token": csrf, "expires_in": 28800})
}
func (s *Server) allowLogin(ip string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	for key, times := range s.logins {
		kept := times[:0]
		for _, at := range times {
			if now.Sub(at) < time.Minute {
				kept = append(kept, at)
			}
		}
		if len(kept) == 0 {
			delete(s.logins, key)
		} else {
			s.logins[key] = kept
		}
	}
	if _, exists := s.logins[ip]; !exists && len(s.logins) >= 4096 {
		return false
	}
	xs := s.logins[ip][:0]
	for _, t := range s.logins[ip] {
		if now.Sub(t) < time.Minute {
			xs = append(xs, t)
		}
	}
	if len(xs) >= 10 {
		s.logins[ip] = xs
		return false
	}
	s.logins[ip] = append(xs, now)
	return true
}
func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	a := currentActor(r)
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		fail(w, r, 503, "not_ready", "authentication service unavailable", nil)
		return
	}
	defer tx.Rollback(context.Background())
	_, err = tx.Exec(ctx, "UPDATE operator_sessions SET revoked_at=now() WHERE id=$1", a.session)
	if err == nil {
		err = auditTx(ctx, tx, &a.id, "auth.logout", "user", a.id, map[string]any{})
	}
	if err != nil {
		fail(w, r, 503, "not_ready", "authentication service unavailable", nil)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		fail(w, r, 503, "not_ready", "authentication service unavailable", nil)
		return
	}
	if s.ws != nil {
		s.ws.closeSession(a.session)
	}
	expireCookie(w, "hf_session", s.secure, true)
	expireCookie(w, "csrf_token", s.secure, false)
	w.WriteHeader(204)
}
func expireCookie(w http.ResponseWriter, name string, secure, httpOnly bool) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: "", Path: "/", MaxAge: -1, Expires: time.Unix(1, 0), Secure: secure, HttpOnly: httpOnly, SameSite: http.SameSiteLaxMode})
}
func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	a := currentActor(r)
	var username string
	_ = s.db.QueryRow(r.Context(), "SELECT username FROM users WHERE id=$1", a.id).Scan(&username)
	writeJSON(w, 200, map[string]any{"id": a.id, "username": username, "role": a.role})
}
func (s *Server) templates(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, contracts.Page[contracts.Template]{Items: []contracts.Template{{ID: "low-http", Name: "Low HTTP", Level: "low", Description: "Simple static HTTP decoy", Capabilities: []string{"http", "request logging"}}, {ID: "medium-http", Name: "Medium HTTP", Level: "medium", Description: "HTTP decoy with synthetic login and fake files", Capabilities: []string{"http", "synthetic credentials", "visitor sessions", "fake filesystem"}}}})
}
func (s *Server) audit(ctx context.Context, actorID *string, action, entityType, entityID string, details map[string]any) error {
	b, _ := json.Marshal(details)
	_, err := s.db.Exec(ctx, "INSERT INTO audit_log(id,actor_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)", uuid(), actorID, action, entityType, entityID, b)
	return err
}
func logDB(r *http.Request, err error) {
	if err != nil {
		log.Printf("request %s: database operation failed", requestID(r))
	}
}
func noRows(err error) bool { return errors.Is(err, pgx.ErrNoRows) }
func checkID(w http.ResponseWriter, r *http.Request, id string) bool {
	if !contracts.ValidID(id) {
		fail(w, r, 400, "invalid_id", "id must be a UUID", nil)
		return false
	}
	return true
}
func parseFailure(w http.ResponseWriter, r *http.Request, e *apiFailure) bool {
	if e == nil {
		return false
	}
	fail(w, r, e.status, e.code, e.message, e.fields)
	return true
}
func hexID(b []byte) string { return hex.EncodeToString(b) }
