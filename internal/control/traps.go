package control

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"honeyforge/internal/contracts"
)

const commandDeliveryLease = 30 * time.Second

func validateBindings(bindings []contracts.DeploymentBinding) map[string]string {
	f := map[string]string{}
	if len(bindings) > 16 {
		f["deployment_bindings"] = "must contain at most 16 bindings"
	}
	seenSvc := map[string]bool{}
	seenPort := map[int]bool{}
	for i, b := range bindings {
		k := fmt.Sprintf("deployment_bindings[%d]", i)
		if b.ServiceID == "" || len(b.ServiceID) > 64 || seenSvc[b.ServiceID] {
			f[k+".service_id"] = "must be unique and 1 to 64 characters"
		}
		seenSvc[b.ServiceID] = true
		if b.HostPort < 1 || b.HostPort > 65535 || seenPort[b.HostPort] {
			f[k+".host_port"] = "must be a unique port from 1 to 65535"
		}
		seenPort[b.HostPort] = true
		if b.BindAddress != "" && net.ParseIP(b.BindAddress) == nil {
			f[k+".bind_address"] = "must be a valid IPv4 or IPv6 address"
		}
	}
	return f
}
func bindingServices(bindings []contracts.DeploymentBinding, c contracts.ProfileConfig) map[string]string {
	f := map[string]string{}
	ids := map[string]bool{}
	for _, svc := range c.Services {
		ids[svc.ID] = true
	}
	for i, b := range bindings {
		if !ids[b.ServiceID] {
			f[fmt.Sprintf("deployment_bindings[%d].service_id", i)] = "does not exist in selected profile"
		}
	}
	return f
}
func (s *Server) createTrap(w http.ResponseWriter, r *http.Request) {
	var req contracts.CreateTrapRequest
	if !decode(w, r, &req) {
		return
	}
	fields := validateBindings(req.DeploymentBindings)
	if strings.TrimSpace(req.Name) == "" || len(req.Name) > 120 {
		fields["name"] = "must be 1 to 120 characters"
	}
	if len(fields) > 0 {
		fail(w, r, 422, "validation_failed", "trap is invalid", fields)
		return
	}
	raw, _ := json.Marshal(req.DeploymentBindings)
	id := uuid()
	a := currentActor(r)
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	defer tx.Rollback(context.Background())
	_, err = tx.Exec(r.Context(), `INSERT INTO traps(id,name,deployment_bindings) VALUES($1,$2,$3)`, id, strings.TrimSpace(req.Name), raw)
	if err == nil {
		err = auditTx(r.Context(), tx, &a.id, "trap.created", "trap", id, map[string]any{})
	}
	if err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	t, err := readTrap(r.Context(), tx, id)
	if err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	writeJSON(w, 201, t)
}
func readTrap(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, id string) (contracts.Trap, error) {
	var t contracts.Trap
	var binds []byte
	var last *time.Time
	var created time.Time
	err := q.QueryRow(ctx, `SELECT id::text,name,desired_profile_id::text,desired_revision,applied_profile_id::text,applied_revision,service_status,last_seen,deployment_bindings,created_at FROM traps WHERE id=$1 AND deleted_at IS NULL`, id).Scan(&t.ID, &t.Name, &t.DesiredProfileID, &t.DesiredRevision, &t.AppliedProfileID, &t.AppliedRevision, &t.ServiceStatus, &last, &binds, &created)
	if err != nil {
		return t, err
	}
	if err = json.Unmarshal(binds, &t.DeploymentBindings); err != nil {
		return t, err
	}
	if t.DeploymentBindings == nil {
		t.DeploymentBindings = []contracts.DeploymentBinding{}
	}
	if last != nil {
		v := last.UTC().Format(time.RFC3339Nano)
		t.LastSeen = &v
		if time.Since(*last) < 20*time.Second {
			t.AgentStatus = "online"
		} else {
			t.AgentStatus = "offline"
		}
	} else {
		t.AgentStatus = "offline"
	}
	t.CreatedAt = created.UTC().Format(time.RFC3339Nano)
	return t, nil
}
func (s *Server) listTraps(w http.ResponseWriter, r *http.Request) {
	limit, cursor, e := parsePage(r, "name", "status", "profile_id")
	if parseFailure(w, r, e) {
		return
	}
	if cursor != "" && !contracts.ValidID(cursor) {
		fail(w, r, 400, "invalid_cursor", "cursor is invalid", nil)
		return
	}
	q := r.URL.Query()
	status := q.Get("status")
	if status != "" && status != "online" && status != "offline" && status != "unknown" && status != "running" && status != "stopped" && status != "degraded" && status != "error" {
		fail(w, r, 400, "invalid_filter", "unsupported trap status", nil)
		return
	}
	profile := q.Get("profile_id")
	if profile != "" && !contracts.ValidID(profile) {
		fail(w, r, 400, "invalid_filter", "profile_id must be a UUID", nil)
		return
	}
	rows, err := s.db.Query(r.Context(), `SELECT id::text FROM traps WHERE deleted_at IS NULL AND id>$1 AND ($2='' OR name ILIKE '%'||$2||'%') AND ($3='' OR (CASE WHEN last_seen >= now()-interval '20 seconds' THEN 'online' ELSE 'offline' END)=$3 OR service_status=$3) AND ($4='' OR desired_profile_id=NULLIF($4,'')::uuid) ORDER BY id LIMIT $5`, nullableCursor(cursor), q.Get("name"), status, profile, limit+1)
	if err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			break
		}
		ids = append(ids, id)
	}
	if err != nil || rows.Err() != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	more := len(ids) > limit
	if more {
		ids = ids[:limit]
	}
	items := make([]contracts.Trap, 0, len(ids))
	for _, id := range ids {
		t, e := readTrap(r.Context(), s.db, id)
		if e != nil {
			fail(w, r, 500, "internal_error", "request could not be completed", nil)
			return
		}
		items = append(items, t)
	}
	next := ""
	if more {
		next = baseCursor(ids[len(ids)-1])
	}
	writeJSON(w, 200, contracts.Page[contracts.Trap]{Items: items, NextCursor: next})
}
func baseCursor(id string) string { return base64Cursor(id) }
func (s *Server) getTrap(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !checkID(w, r, id) {
		return
	}
	t, err := readTrap(r.Context(), s.db, id)
	if noRows(err) {
		fail(w, r, 404, "not_found", "trap not found", nil)
		return
	}
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	writeJSON(w, 200, t)
}
func (s *Server) assignProfile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !checkID(w, r, id) {
		return
	}
	var req contracts.AssignProfileRequest
	if !decode(w, r, &req) {
		return
	}
	if !checkID(w, r, req.ProfileID) {
		return
	}
	if req.Revision < 1 {
		fail(w, r, 422, "validation_failed", "revision must be positive", nil)
		return
	}
	a := currentActor(r)
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	defer tx.Rollback(context.Background())
	var activeProfile string
	err = tx.QueryRow(r.Context(), `SELECT id::text FROM profiles WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, req.ProfileID).Scan(&activeProfile)
	if noRows(err) {
		fail(w, r, 404, "revision_not_found", "active profile revision not found", nil)
		return
	}
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	var lockedTrap string
	err = tx.QueryRow(r.Context(), `SELECT id::text FROM traps WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&lockedTrap)
	if noRows(err) {
		fail(w, r, 404, "not_found", "trap not found", nil)
		return
	}
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	var cfg []byte
	err = tx.QueryRow(r.Context(), `SELECT pr.config FROM profile_revisions pr JOIN profiles p ON p.id=pr.profile_id WHERE pr.profile_id=$1 AND pr.revision=$2 AND p.deleted_at IS NULL`, req.ProfileID, req.Revision).Scan(&cfg)
	if noRows(err) {
		fail(w, r, 404, "revision_not_found", "active profile revision not found", nil)
		return
	}
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	var c contracts.ProfileConfig
	if err = json.Unmarshal(cfg, &c); err != nil {
		fail(w, r, 500, "internal_error", "stored profile is invalid", nil)
		return
	}
	var raw []byte
	if err = tx.QueryRow(r.Context(), `SELECT deployment_bindings FROM traps WHERE id=$1`, id).Scan(&raw); err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	var binds []contracts.DeploymentBinding
	if err = json.Unmarshal(raw, &binds); err != nil {
		fail(w, r, 500, "internal_error", "stored deployment bindings are invalid", nil)
		return
	}
	fields := bindingServices(binds, c)
	if len(fields) > 0 {
		fail(w, r, 422, "binding_mismatch", "deployment bindings do not match the selected profile", fields)
		return
	}
	_, err = tx.Exec(r.Context(), `UPDATE traps SET desired_profile_id=$2,desired_revision=$3 WHERE id=$1`, id, req.ProfileID, req.Revision)
	if err == nil {
		err = auditTx(r.Context(), tx, &a.id, "trap.profile_assigned", "trap", id, map[string]any{"profile_id": req.ProfileID, "revision": req.Revision})
	}
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	t, err := readTrap(r.Context(), tx, id)
	if err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	writeJSON(w, 200, t)
}
func (s *Server) detachProfile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !checkID(w, r, id) {
		return
	}
	a := currentActor(r)
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	defer tx.Rollback(context.Background())
	tag, err := tx.Exec(r.Context(), `UPDATE traps SET desired_profile_id=NULL,desired_revision=NULL WHERE id=$1 AND deleted_at IS NULL`, id)
	if err != nil || tag.RowsAffected() == 0 {
		fail(w, r, 404, "not_found", "trap not found", nil)
		return
	}
	if err = auditTx(r.Context(), tx, &a.id, "trap.profile_detached", "trap", id, map[string]any{}); err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	t, err := readTrap(r.Context(), tx, id)
	if err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	writeJSON(w, 200, t)
}
func (s *Server) deleteTrap(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !checkID(w, r, id) {
		return
	}
	a := currentActor(r)
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	defer tx.Rollback(context.Background())
	var locked string
	err = tx.QueryRow(r.Context(), `SELECT id::text FROM traps WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&locked)
	if noRows(err) {
		fail(w, r, 404, "not_found", "trap not found", nil)
		return
	}
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	_, err = tx.Exec(r.Context(), `UPDATE traps SET deleted_at=now() WHERE id=$1`, id)
	if err == nil {
		_, err = tx.Exec(r.Context(), `UPDATE agents SET revoked_at=now() WHERE trap_id=$1 AND revoked_at IS NULL`, id)
	}
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	if err = auditTx(r.Context(), tx, &a.id, "trap.deleted", "trap", id, map[string]any{}); err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	w.WriteHeader(204)
}
func (s *Server) createEnrollment(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !checkID(w, r, id) {
		return
	}
	a := currentActor(r)
	tok := randomToken(32)
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	defer tx.Rollback(context.Background())
	var lockedTrap string
	err = tx.QueryRow(r.Context(), `SELECT id::text FROM traps WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&lockedTrap)
	if noRows(err) {
		fail(w, r, 404, "not_found", "trap not found", nil)
		return
	}
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	_, err = tx.Exec(r.Context(), `UPDATE enrollment_tokens SET consumed_at=now() WHERE trap_id=$1 AND consumed_at IS NULL`, id)
	if err == nil {
		_, err = tx.Exec(r.Context(), `INSERT INTO enrollment_tokens(id,trap_id,token_hash,expires_at,created_by) VALUES($1,$2,$3,now()+interval '10 minutes',$4)`, uuid(), id, tokenHash(tok), a.id)
	}
	if err == nil {
		err = auditTx(r.Context(), tx, &a.id, "agent.enrollment_issued", "trap", id, map[string]any{"expires_in_seconds": 600})
	}
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	writeJSON(w, 201, map[string]any{"trap_id": id, "token": tok, "expires_in_seconds": 600})
}
func (s *Server) enroll(w http.ResponseWriter, r *http.Request) {
	var req struct {
		TrapID string `json:"trap_id"`
		Token  string `json:"token"`
	}
	if !decode(w, r, &req) {
		return
	}
	if !contracts.ValidID(req.TrapID) || len(req.Token) < 32 || len(req.Token) > 128 {
		fail(w, r, 401, "enrollment_invalid", "enrollment token is invalid", nil)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
	defer cancel()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		fail(w, r, 503, "not_ready", "database unavailable", nil)
		return
	}
	defer tx.Rollback(context.Background())
	var lockedTrap string
	err = tx.QueryRow(ctx, `SELECT id::text FROM traps WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, req.TrapID).Scan(&lockedTrap)
	if noRows(err) {
		fail(w, r, 401, "enrollment_invalid", "enrollment token is invalid", nil)
		return
	}
	if err != nil {
		fail(w, r, 503, "not_ready", "database unavailable", nil)
		return
	}
	var tokenID string
	err = tx.QueryRow(ctx, `SELECT id::text FROM enrollment_tokens WHERE trap_id=$1 AND token_hash=$2 AND consumed_at IS NULL AND expires_at>now() FOR UPDATE`, req.TrapID, tokenHash(req.Token)).Scan(&tokenID)
	if noRows(err) {
		fail(w, r, 401, "enrollment_invalid", "enrollment token is invalid", nil)
		return
	}
	if err != nil {
		fail(w, r, 503, "not_ready", "database unavailable", nil)
		return
	}
	var enrolled bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agents WHERE trap_id=$1 AND revoked_at IS NULL)`, req.TrapID).Scan(&enrolled)
	if err != nil {
		fail(w, r, 503, "not_ready", "database unavailable", nil)
		return
	}
	if enrolled {
		fail(w, r, 409, "already_enrolled", "trap already has an active agent", nil)
		return
	}
	agentToken := randomToken(32)
	agentID := uuid()
	_, err = tx.Exec(ctx, `UPDATE enrollment_tokens SET consumed_at=now() WHERE id=$1`, tokenID)
	if err == nil {
		_, err = tx.Exec(ctx, `INSERT INTO agents(id,trap_id,token_hash) VALUES($1,$2,$3)`, agentID, req.TrapID, tokenHash(agentToken))
	}
	if err == nil {
		err = auditTx(ctx, tx, nil, "agent.enrolled", "trap", req.TrapID, map[string]any{"agent_id": agentID})
	}
	if err != nil {
		fail(w, r, 503, "not_ready", "database unavailable", nil)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		fail(w, r, 503, "not_ready", "database unavailable", nil)
		return
	}
	writeJSON(w, 201, map[string]string{"agent_id": agentID, "trap_id": req.TrapID, "agent_token": agentToken})
}
func (s *Server) agentConfig(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !contracts.ValidID(id) {
		fail(w, r, 401, "unauthorized", "agent authentication required", nil)
		return
	}
	authHeader := r.Header.Get("Authorization")
	if !strings.HasPrefix(authHeader, "Bearer ") {
		fail(w, r, 401, "unauthorized", "agent authentication required", nil)
		return
	}
	h := strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
	if h == "" || len(h) > 128 || strings.Contains(h, " ") {
		fail(w, r, 401, "unauthorized", "agent authentication required", nil)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
	defer cancel()
	var agentID, trapID string
	err := s.db.QueryRow(ctx, `SELECT id::text,trap_id::text FROM agents WHERE token_hash=$1 AND revoked_at IS NULL`, tokenHash(h)).Scan(&agentID, &trapID)
	if err != nil || trapID != id {
		fail(w, r, 401, "unauthorized", "agent authentication required", nil)
		return
	}
	var profileID *string
	var rev *int
	var raw []byte
	err = s.db.QueryRow(ctx, `SELECT desired_profile_id::text,desired_revision,pr.config FROM traps t JOIN profile_revisions pr ON pr.profile_id=t.desired_profile_id AND pr.revision=t.desired_revision WHERE t.id=$1 AND t.deleted_at IS NULL`, id).Scan(&profileID, &rev, &raw)
	if noRows(err) {
		fail(w, r, 404, "configuration_not_assigned", "trap has no desired profile", nil)
		return
	}
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	var cfg contracts.ProfileConfig
	_ = json.Unmarshal(raw, &cfg)
	tx, err := s.db.Begin(ctx)
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	defer tx.Rollback(context.Background())
	var previousAgentStatus string
	if err = tx.QueryRow(ctx, `SELECT agent_status FROM traps WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&previousAgentStatus); err != nil {
		fail(w, r, 503, "not_ready", "database unavailable", nil)
		return
	}
	if _, err = tx.Exec(ctx, `UPDATE agents SET last_seen=now() WHERE id=$1`, agentID); err == nil {
		_, err = tx.Exec(ctx, `UPDATE traps SET agent_status='online',last_seen=now() WHERE id=$1`, id)
	}
	if err == nil {
		err = auditTx(ctx, tx, nil, "agent.config_read", "trap", id, map[string]any{"agent_id": agentID, "profile_id": *profileID, "revision": *rev})
	}
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	if previousAgentStatus != "online" {
		s.publishNotification("trap.status_changed", id, map[string]any{"trap_id": id, "agent_status": "online"})
	}
	writeJSON(w, 200, map[string]any{"trap_id": id, "profile_id": *profileID, "revision": *rev, "config": cfg})
}

func (s *Server) agentHeartbeat(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !contracts.ValidID(id) {
		fail(w, r, 401, "unauthorized", "agent authentication required", nil)
		return
	}
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		fail(w, r, 401, "unauthorized", "agent authentication required", nil)
		return
	}
	token := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
	if token == "" || len(token) > 128 || strings.Contains(token, " ") {
		fail(w, r, 401, "unauthorized", "agent authentication required", nil)
		return
	}
	var request struct {
		ServiceState string `json:"service_state"`
	}
	if !decode(w, r, &request) {
		return
	}
	if request.ServiceState == "" {
		request.ServiceState = "unknown"
	}
	switch request.ServiceState {
	case "unknown", "running", "stopped", "degraded", "error":
	default:
		fail(w, r, 422, "validation_failed", "service_state is unsupported", map[string]string{"service_state": "unsupported"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 4*time.Second)
	defer cancel()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		fail(w, r, 503, "not_ready", "database unavailable", nil)
		return
	}
	defer tx.Rollback(context.Background())
	var agentID string
	err = tx.QueryRow(ctx, `SELECT id::text FROM agents WHERE trap_id=$1 AND token_hash=$2 AND revoked_at IS NULL FOR UPDATE`, id, tokenHash(token)).Scan(&agentID)
	if noRows(err) {
		fail(w, r, 401, "unauthorized", "agent authentication required", nil)
		return
	}
	if err != nil {
		fail(w, r, 503, "not_ready", "database unavailable", nil)
		return
	}
	var previousAgentStatus, previousServiceStatus string
	err = tx.QueryRow(ctx, `SELECT agent_status,service_status FROM traps WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&previousAgentStatus, &previousServiceStatus)
	if err != nil {
		fail(w, r, 503, "not_ready", "database unavailable", nil)
		return
	}
	if _, err = tx.Exec(ctx, `UPDATE agents SET last_seen=now() WHERE id=$1`, agentID); err == nil {
		_, err = tx.Exec(ctx, `UPDATE traps SET agent_status='online',last_seen=now(),service_status=$2 WHERE id=$1 AND deleted_at IS NULL`, id, request.ServiceState)
	}
	if err != nil {
		fail(w, r, 503, "not_ready", "database unavailable", nil)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		fail(w, r, 503, "not_ready", "database unavailable", nil)
		return
	}
	if previousAgentStatus != "online" || previousServiceStatus != request.ServiceState {
		s.publishNotification("trap.status_changed", id, map[string]any{"trap_id": id, "agent_status": "online", "service_status": request.ServiceState})
	}
	writeJSON(w, 200, map[string]any{"trap_id": id, "agent_status": "online", "service_status": request.ServiceState, "last_seen": time.Now().UTC().Format(time.RFC3339Nano)})
}

func validTelemetryEventType(s string) bool {
	switch s {
	case "connection.opened", "http.request", "auth.attempt", "session.started", "file.listed", "file.read", "file.downloaded", "session.ended", "command.received":
		return true
	default:
		return false
	}
}

func (s *Server) agentEvents(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !contracts.ValidID(id) {
		fail(w, r, 401, "unauthorized", "agent authentication required", nil)
		return
	}
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		fail(w, r, 401, "unauthorized", "agent authentication required", nil)
		return
	}
	token := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
	if token == "" || len(token) > 128 || strings.Contains(token, " ") {
		fail(w, r, 401, "unauthorized", "agent authentication required", nil)
		return
	}
	var request struct {
		Events []contracts.Event `json:"events"`
	}
	if !decode(w, r, &request) {
		return
	}
	if len(request.Events) == 0 || len(request.Events) > 100 {
		fail(w, r, 422, "validation_failed", "events must contain 1 to 100 items", nil)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		fail(w, r, 503, "not_ready", "database unavailable", nil)
		return
	}
	defer tx.Rollback(context.Background())
	var agentID string
	if err = tx.QueryRow(ctx, `SELECT id::text FROM agents WHERE trap_id=$1 AND token_hash=$2 AND revoked_at IS NULL`, id, tokenHash(token)).Scan(&agentID); err != nil {
		fail(w, r, 401, "unauthorized", "agent authentication required", nil)
		return
	}
	var previousAgentStatus string
	if err = tx.QueryRow(ctx, `SELECT agent_status FROM traps WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&previousAgentStatus); err != nil {
		fail(w, r, 503, "not_ready", "database unavailable", nil)
		return
	}
	accepted := make([]string, 0, len(request.Events))
	acceptedEvents := make([]contracts.Event, 0, len(request.Events))
	duplicates := make([]string, 0)
	for _, event := range request.Events {
		if event.SchemaVersion != "1.0" || !contracts.ValidID(event.EventID) || event.TrapID != id || event.AgentID != agentID ||
			event.ServiceID == "" || len(event.ServiceID) > 64 || !validTelemetryEventType(event.EventType) || event.Protocol != "http" ||
			(event.SessionID != "" && !contracts.ValidID(event.SessionID)) || (event.ProfileID != "" && !contracts.ValidID(event.ProfileID)) ||
			((event.ProfileID == "") != (event.AppliedRevision == nil)) || (event.AppliedRevision != nil && *event.AppliedRevision < 1) ||
			(event.SourceIP != "" && net.ParseIP(event.SourceIP) == nil) ||
			(event.SourcePort != nil && (*event.SourcePort < 1 || *event.SourcePort > 65535)) || event.DestinationPort < 1 || event.DestinationPort > 65535 ||
			event.Payload == nil || len(event.Payload) > 64 {
			fail(w, r, 422, "validation_failed", "event identity or fields are invalid", nil)
			return
		}
		occurred, parseErr := time.Parse(time.RFC3339Nano, event.Timestamp)
		if parseErr != nil {
			fail(w, r, 422, "validation_failed", "event timestamp must be RFC3339", nil)
			return
		}
		payload, marshalErr := json.Marshal(event.Payload)
		if marshalErr != nil || len(payload) > 256*1024 {
			fail(w, r, 422, "validation_failed", "event payload is invalid or too large", nil)
			return
		}
		if event.SessionID != "" {
			var sessionID string
			err = tx.QueryRow(ctx, `INSERT INTO visitor_sessions(id,trap_id,started_at) VALUES($1,$2,$3) ON CONFLICT (id) DO UPDATE SET started_at=LEAST(visitor_sessions.started_at,EXCLUDED.started_at) WHERE visitor_sessions.trap_id=EXCLUDED.trap_id RETURNING id::text`, event.SessionID, id, occurred).Scan(&sessionID)
			if errors.Is(err, pgx.ErrNoRows) {
				fail(w, r, 409, "session_conflict", "session ID belongs to another trap", nil)
				return
			}
			if err != nil {
				fail(w, r, 503, "not_ready", "visitor session could not be stored", nil)
				return
			}
			if event.EventType == "session.ended" {
				if _, err = tx.Exec(ctx, `UPDATE visitor_sessions SET ended_at=GREATEST(COALESCE(ended_at,$2),$2) WHERE id=$1 AND trap_id=$3`, event.SessionID, occurred, id); err != nil {
					fail(w, r, 503, "not_ready", "visitor session could not be updated", nil)
					return
				}
			}
		}
		var sourceGeo SourceGeo
		if s.geo != nil && event.SourceIP != "" {
			sourceGeo, _ = s.geo.Lookup(net.ParseIP(event.SourceIP))
		}
		var inserted bool
		err = tx.QueryRow(ctx, `INSERT INTO events(id,schema_version,trap_id,agent_id,service_id,session_id,profile_id,applied_revision,event_type,occurred_at,source_ip,source_port,destination_port,protocol,payload,source_country_code,source_country_name,source_asn,source_asn_org,geo_source,geo_version)
			VALUES($1,$2,$3,$4,$5,NULLIF($6,'')::uuid,NULLIF($7,'')::uuid,$8,$9,$10,NULLIF($11,'')::inet,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
			ON CONFLICT (agent_id,id) DO NOTHING RETURNING true`, event.EventID, event.SchemaVersion, event.TrapID, event.AgentID, event.ServiceID, event.SessionID, event.ProfileID, event.AppliedRevision, event.EventType, occurred, event.SourceIP, event.SourcePort, event.DestinationPort, event.Protocol, payload, sourceGeo.CountryCode, sourceGeo.CountryName, sourceGeo.ASN, sourceGeo.ASNOrg, sourceGeo.Source, sourceGeo.Version).Scan(&inserted)
		if errors.Is(err, pgx.ErrNoRows) {
			var sameContent bool
			err = tx.QueryRow(ctx, `SELECT schema_version=$3 AND trap_id=$4::uuid AND agent_id=$5::uuid AND service_id=$6 AND
				session_id IS NOT DISTINCT FROM NULLIF($7,'')::uuid AND profile_id IS NOT DISTINCT FROM NULLIF($8,'')::uuid AND
				applied_revision IS NOT DISTINCT FROM $9::integer AND event_type=$10 AND occurred_at=$11::timestamptz AND
				source_ip IS NOT DISTINCT FROM NULLIF($12,'')::inet AND source_port IS NOT DISTINCT FROM $13::integer AND
				destination_port IS NOT DISTINCT FROM $14::integer AND protocol=$15 AND payload=$16::jsonb
				FROM events WHERE agent_id=$1 AND id=$2`, agentID, event.EventID, event.SchemaVersion, event.TrapID, event.AgentID,
				event.ServiceID, event.SessionID, event.ProfileID, event.AppliedRevision, event.EventType, occurred, event.SourceIP,
				event.SourcePort, event.DestinationPort, event.Protocol, payload).Scan(&sameContent)
			if err != nil {
				fail(w, r, 503, "not_ready", "event identity could not be checked", nil)
				return
			}
			if !sameContent {
				fail(w, r, 409, "event_conflict", "event ID already exists with different content", nil)
				return
			}
			duplicates = append(duplicates, event.EventID)
			continue
		}
		if err != nil {
			fail(w, r, 503, "not_ready", "events could not be stored", nil)
			return
		}
		if inserted {
			accepted = append(accepted, event.EventID)
			acceptedEvents = append(acceptedEvents, event)
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE agents SET last_seen=now() WHERE id=$1`, agentID); err != nil {
		fail(w, r, 503, "not_ready", "agent state could not be updated", nil)
		return
	}
	if _, err = tx.Exec(ctx, `UPDATE traps SET agent_status='online',last_seen=now() WHERE id=$1 AND deleted_at IS NULL`, id); err != nil {
		fail(w, r, 503, "not_ready", "trap state could not be updated", nil)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		fail(w, r, 503, "not_ready", "events could not be committed", nil)
		return
	}
	for _, event := range acceptedEvents {
		s.publishNotification("event.created", event.EventID, map[string]any{"event_id": event.EventID, "trap_id": id, "event_type": event.EventType})
		if event.SessionID != "" && (event.EventType == "session.started" || event.EventType == "session.ended") {
			s.publishNotification("session.updated", event.EventID, map[string]any{"session_id": event.SessionID, "trap_id": id, "event_type": event.EventType})
		}
	}
	if previousAgentStatus != "online" {
		s.publishNotification("trap.status_changed", id, map[string]any{"trap_id": id, "agent_status": "online"})
	}
	writeJSON(w, 200, map[string]any{"accepted_ids": accepted, "duplicate_ids": duplicates})
}

func (s *Server) agentCommands(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	token, ok := agentBearer(r)
	if !ok || !contracts.ValidID(id) {
		fail(w, r, 401, "unauthorized", "agent authentication required", nil)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		fail(w, r, 503, "not_ready", "database unavailable", nil)
		return
	}
	defer tx.Rollback(context.Background())
	var agentID string
	if err = tx.QueryRow(ctx, `SELECT id::text FROM agents WHERE trap_id=$1 AND token_hash=$2 AND revoked_at IS NULL`, id, tokenHash(token)).Scan(&agentID); err != nil {
		fail(w, r, 401, "unauthorized", "agent authentication required", nil)
		return
	}
	expiredRows, err := tx.Query(ctx, `UPDATE commands SET status='expired',delivered_at=NULL WHERE trap_id=$1 AND status IN ('queued','delivered') AND expires_at<=now() RETURNING id::text`, id)
	if err != nil {
		fail(w, r, 503, "not_ready", "commands unavailable", nil)
		return
	}
	expiredIDs := make([]string, 0)
	for expiredRows.Next() {
		var commandID string
		if err = expiredRows.Scan(&commandID); err != nil {
			expiredRows.Close()
			fail(w, r, 503, "not_ready", "commands unavailable", nil)
			return
		}
		expiredIDs = append(expiredIDs, commandID)
	}
	if err = expiredRows.Err(); err != nil {
		expiredRows.Close()
		fail(w, r, 503, "not_ready", "commands unavailable", nil)
		return
	}
	expiredRows.Close()
	var previousAgentStatus string
	if err = tx.QueryRow(ctx, `SELECT agent_status FROM traps WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&previousAgentStatus); err != nil {
		fail(w, r, 503, "not_ready", "database unavailable", nil)
		return
	}
	rows, err := tx.Query(ctx, `SELECT id::text,trap_id::text,command_type,expected_profile_id::text,expected_revision,target_profile_id::text,target_revision,status,expires_at,created_at FROM commands WHERE trap_id=$1 AND expires_at>now() AND (status='queued' OR (status='delivered' AND (delivered_at IS NULL OR delivered_at<=now()-($2::bigint*interval '1 second')))) ORDER BY created_at,id LIMIT 20 FOR UPDATE SKIP LOCKED`, id, int64(commandDeliveryLease/time.Second))
	if err != nil {
		fail(w, r, 503, "not_ready", "commands unavailable", nil)
		return
	}
	defer rows.Close()
	commands := make([]contracts.Command, 0)
	ids := make([]string, 0)
	for rows.Next() {
		var c contracts.Command
		var expires, created time.Time
		if err = rows.Scan(&c.ID, &c.TrapID, &c.Type, &c.ExpectedProfileID, &c.ExpectedRevision, &c.TargetProfileID, &c.TargetRevision, &c.Status, &expires, &created); err != nil {
			fail(w, r, 503, "not_ready", "commands unavailable", nil)
			return
		}
		c.ExpiresAt, c.CreatedAt = expires.UTC().Format(time.RFC3339Nano), created.UTC().Format(time.RFC3339Nano)
		c.Status = "delivered"
		commands = append(commands, c)
		ids = append(ids, c.ID)
	}
	if err = rows.Err(); err != nil {
		fail(w, r, 503, "not_ready", "commands unavailable", nil)
		return
	}
	rows.Close()
	for _, commandID := range ids {
		if _, err = tx.Exec(ctx, `UPDATE commands SET status='delivered',delivered_at=now() WHERE id=$1`, commandID); err != nil {
			fail(w, r, 503, "not_ready", "commands unavailable", nil)
			return
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE agents SET last_seen=now() WHERE id=$1`, agentID); err == nil {
		_, err = tx.Exec(ctx, `UPDATE traps SET agent_status='online',last_seen=now() WHERE id=$1 AND deleted_at IS NULL`, id)
	}
	if err != nil {
		fail(w, r, 503, "not_ready", "agent state could not be updated", nil)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		fail(w, r, 503, "not_ready", "commands unavailable", nil)
		return
	}
	for _, commandID := range expiredIDs {
		s.publishNotification("command.updated", commandID, map[string]any{"command_id": commandID, "trap_id": id, "status": "expired"})
	}
	for _, command := range commands {
		s.publishNotification("command.updated", command.ID, map[string]any{"command_id": command.ID, "trap_id": id, "status": "delivered"})
	}
	if previousAgentStatus != "online" {
		s.publishNotification("trap.status_changed", id, map[string]any{"trap_id": id, "agent_status": "online"})
	}
	writeJSON(w, 200, map[string]any{"items": commands})
}

func (s *Server) agentCommandResult(w http.ResponseWriter, r *http.Request) {
	id, commandID := r.PathValue("id"), r.PathValue("command_id")
	token, ok := agentBearer(r)
	if !ok || !contracts.ValidID(id) || !contracts.ValidID(commandID) {
		fail(w, r, 401, "unauthorized", "agent authentication required", nil)
		return
	}
	var req struct {
		Status string `json:"status"`
		Error  string `json:"error,omitempty"`
	}
	if !decode(w, r, &req) {
		return
	}
	if req.Status != "applied" && req.Status != "failed" {
		fail(w, r, 422, "validation_failed", "status must be applied or failed", nil)
		return
	}
	if len(req.Error) > 500 || (req.Status == "applied" && req.Error != "") {
		fail(w, r, 422, "validation_failed", "error is only allowed for failed results and must be at most 500 characters", nil)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		fail(w, r, 503, "not_ready", "database unavailable", nil)
		return
	}
	defer tx.Rollback(context.Background())
	var agentID string
	if err = tx.QueryRow(ctx, `SELECT id::text FROM agents WHERE trap_id=$1 AND token_hash=$2 AND revoked_at IS NULL`, id, tokenHash(token)).Scan(&agentID); err != nil {
		fail(w, r, 401, "unauthorized", "agent authentication required", nil)
		return
	}
	var commandType string
	var targetProfile *string
	var targetRevision *int
	var currentStatus string
	var currentError string
	var expires time.Time
	err = tx.QueryRow(ctx, `SELECT command_type,target_profile_id::text,target_revision,status,result_error,expires_at FROM commands WHERE id=$1 AND trap_id=$2 FOR UPDATE`, commandID, id).Scan(&commandType, &targetProfile, &targetRevision, &currentStatus, &currentError, &expires)
	if noRows(err) {
		fail(w, r, 404, "not_found", "command not found", nil)
		return
	}
	if err != nil {
		fail(w, r, 503, "not_ready", "command unavailable", nil)
		return
	}
	if currentStatus == "expired" || time.Now().After(expires) {
		if currentStatus != "expired" {
			if _, err = tx.Exec(ctx, `UPDATE commands SET status='expired',delivered_at=NULL WHERE id=$1`, commandID); err != nil {
				fail(w, r, 503, "not_ready", "command state unavailable", nil)
				return
			}
			if err = tx.Commit(ctx); err != nil {
				fail(w, r, 503, "not_ready", "command unavailable", nil)
				return
			}
			s.publishNotification("command.updated", commandID, map[string]any{"command_id": commandID, "trap_id": id, "status": "expired"})
		}
		fail(w, r, 409, "command_expired", "command has expired", nil)
		return
	}
	if currentStatus == "applied" || currentStatus == "failed" {
		if err = tx.Commit(ctx); err != nil {
			fail(w, r, 503, "not_ready", "command unavailable", nil)
			return
		}
		writeJSON(w, 200, map[string]string{"status": currentStatus, "error": currentError})
		return
	}
	if currentStatus != "delivered" {
		fail(w, r, 409, "command_not_delivered", "command has not been delivered to the agent", nil)
		return
	}
	if _, err = tx.Exec(ctx, `UPDATE commands SET status=$1,result_error=$2,delivered_at=NULL WHERE id=$3`, req.Status, req.Error, commandID); err != nil {
		fail(w, r, 503, "not_ready", "command unavailable", nil)
		return
	}
	if req.Status == "applied" && commandType == "apply_profile" && targetProfile != nil && targetRevision != nil {
		_, err = tx.Exec(ctx, `UPDATE traps SET applied_profile_id=$1,applied_revision=$2 WHERE id=$3`, *targetProfile, *targetRevision, id)
	}
	if err != nil {
		fail(w, r, 503, "not_ready", "command state unavailable", nil)
		return
	}
	if err = tx.Commit(ctx); err != nil {
		fail(w, r, 503, "not_ready", "command unavailable", nil)
		return
	}
	s.publishNotification("command.updated", commandID, map[string]any{"command_id": commandID, "trap_id": id, "status": req.Status})
	writeJSON(w, 200, map[string]string{"status": req.Status, "error": req.Error})
}

func agentBearer(r *http.Request) (string, bool) {
	header := r.Header.Get("Authorization")
	if !strings.HasPrefix(header, "Bearer ") {
		return "", false
	}
	token := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
	return token, token != "" && len(token) <= 128 && !strings.Contains(token, " ")
}

func (s *Server) queueCommand(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !checkID(w, r, id) {
		return
	}
	var req contracts.QueueCommandRequest
	if !decode(w, r, &req) {
		return
	}
	if req.Type != "start" && req.Type != "stop" && req.Type != "apply_profile" {
		fail(w, r, 422, "validation_failed", "type must be start, stop, or apply_profile", map[string]string{"type": "unsupported"})
		return
	}
	if req.TTLSeconds < 1 || req.TTLSeconds > 3600 {
		fail(w, r, 422, "validation_failed", "ttl_seconds must be between 1 and 3600", nil)
		return
	}
	if req.ExpectedRevision == nil || *req.ExpectedRevision < 1 {
		fail(w, r, 422, "validation_failed", "expected_revision is required and must be positive", nil)
		return
	}
	a := currentActor(r)
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	defer tx.Rollback(context.Background())
	var desiredProfile *string
	var desired *int
	err = tx.QueryRow(r.Context(), `SELECT desired_profile_id::text,desired_revision FROM traps WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&desiredProfile, &desired)
	if noRows(err) {
		fail(w, r, 404, "not_found", "trap not found", nil)
		return
	}
	if err == nil && (desired == nil || desiredProfile == nil) {
		fail(w, r, 409, "profile_not_assigned", "a desired profile is required", nil)
		return
	}
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	if !contracts.ValidID(req.ExpectedProfileID) || *desiredProfile != req.ExpectedProfileID || *desired != *req.ExpectedRevision {
		fail(w, r, 409, "revision_conflict", "expected_revision does not match desired revision", map[string]string{"desired_revision": strconv.Itoa(*desired)})
		return
	}
	cmdID := uuid()
	var cmd contracts.Command
	var expiresAt, createdAt time.Time
	err = tx.QueryRow(r.Context(), `INSERT INTO commands(id,trap_id,command_type,expected_profile_id,expected_revision,target_profile_id,target_revision,status,expires_at,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,'queued',now()+($8*interval '1 second'),$9) RETURNING id::text,trap_id::text,command_type,expected_revision,target_profile_id::text,target_revision,status,expires_at,created_at`, cmdID, id, req.Type, req.ExpectedProfileID, *req.ExpectedRevision, *desiredProfile, *desired, req.TTLSeconds, a.id).Scan(&cmd.ID, &cmd.TrapID, &cmd.Type, &cmd.ExpectedRevision, &cmd.TargetProfileID, &cmd.TargetRevision, &cmd.Status, &expiresAt, &createdAt)
	cmd.ExpectedProfileID = desiredProfile
	if err == nil {
		err = auditTx(r.Context(), tx, &a.id, "command.queued", "command", cmdID, map[string]any{"trap_id": id, "type": req.Type, "expected_revision": *req.ExpectedRevision, "ttl_seconds": req.TTLSeconds})
	}
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	cmd.ExpiresAt = expiresAt.UTC().Format(time.RFC3339Nano)
	cmd.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
	if err = tx.Commit(r.Context()); err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	s.publishNotification("command.updated", cmd.ID, map[string]any{"command_id": cmd.ID, "trap_id": id, "status": "queued"})
	writeJSON(w, 201, cmd)
}
func (s *Server) listCommands(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !checkID(w, r, id) {
		return
	}
	limit, cursor, e := parsePage(r, "status")
	if parseFailure(w, r, e) {
		return
	}
	if cursor != "" && !contracts.ValidID(cursor) {
		fail(w, r, 400, "invalid_cursor", "cursor is invalid", nil)
		return
	}
	status := r.URL.Query().Get("status")
	if status != "" && status != "queued" && status != "delivered" && status != "applied" && status != "failed" && status != "expired" {
		fail(w, r, 400, "invalid_filter", "unsupported command status", nil)
		return
	}
	expiredRows, err := s.db.Query(r.Context(), `UPDATE commands SET status='expired',delivered_at=NULL WHERE trap_id=$1 AND status IN ('queued','delivered') AND expires_at<=now() RETURNING id::text`, id)
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	expiredIDs := make([]string, 0)
	for expiredRows.Next() {
		var commandID string
		if err = expiredRows.Scan(&commandID); err != nil {
			expiredRows.Close()
			fail(w, r, 500, "internal_error", "request could not be completed", nil)
			return
		}
		expiredIDs = append(expiredIDs, commandID)
	}
	if err = expiredRows.Err(); err != nil {
		expiredRows.Close()
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	expiredRows.Close()
	for _, commandID := range expiredIDs {
		s.publishNotification("command.updated", commandID, map[string]any{"command_id": commandID, "trap_id": id, "status": "expired"})
	}
	rows, err := s.db.Query(r.Context(), `SELECT id::text,trap_id::text,command_type,expected_profile_id::text,expected_revision,target_profile_id::text,target_revision,status,expires_at,created_at,result_error FROM commands WHERE trap_id=$1 AND id>$2 AND ($3='' OR status=$3) ORDER BY id LIMIT $4`, id, nullableCursor(cursor), status, limit+1)
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	defer rows.Close()
	items := []contracts.Command{}
	for rows.Next() {
		var c contracts.Command
		var expiresAt, createdAt time.Time
		if err = rows.Scan(&c.ID, &c.TrapID, &c.Type, &c.ExpectedProfileID, &c.ExpectedRevision, &c.TargetProfileID, &c.TargetRevision, &c.Status, &expiresAt, &createdAt, &c.Error); err != nil {
			break
		}
		c.ExpiresAt = expiresAt.UTC().Format(time.RFC3339Nano)
		c.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
		items = append(items, c)
	}
	if err != nil || rows.Err() != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		next = baseCursor(items[len(items)-1].ID)
	}
	writeJSON(w, 200, contracts.Page[contracts.Command]{Items: items, NextCursor: next})
}
func (s *Server) listAudit(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	for k, v := range q {
		if (k != "action" && k != "actor_id" && k != "from" && k != "to" && k != "limit" && k != "cursor") || len(v) != 1 {
			fail(w, r, 400, "invalid_query", "unsupported or repeated query parameter", map[string]string{k: "unsupported"})
			return
		}
	}
	limit := contracts.DefaultPageSize
	if q.Get("limit") != "" {
		n, e := strconv.Atoi(q.Get("limit"))
		if e != nil || n < 1 || n > contracts.MaxPageSize {
			fail(w, r, 400, "invalid_limit", "limit must be between 1 and 100", nil)
			return
		}
		limit = n
	}
	type auditCursor struct {
		CreatedAt time.Time `json:"created_at"`
		ID        string    `json:"id"`
	}
	var cursor auditCursor
	if q.Get("cursor") != "" {
		raw, e := base64.RawURLEncoding.DecodeString(q.Get("cursor"))
		if e != nil || json.Unmarshal(raw, &cursor) != nil || cursor.CreatedAt.IsZero() || !contracts.ValidID(cursor.ID) {
			fail(w, r, 400, "invalid_cursor", "cursor is invalid", nil)
			return
		}
	}
	if q.Get("actor_id") != "" && !contracts.ValidID(q.Get("actor_id")) {
		fail(w, r, 400, "invalid_filter", "actor_id must be a UUID", nil)
		return
	}
	var from, to, cursorTime, cursorID any
	if q.Get("from") != "" {
		v, e := time.Parse(time.RFC3339, q.Get("from"))
		if e != nil {
			fail(w, r, 400, "invalid_filter", "from must be RFC3339", nil)
			return
		}
		from = v.UTC()
	}
	if q.Get("to") != "" {
		v, e := time.Parse(time.RFC3339, q.Get("to"))
		if e != nil {
			fail(w, r, 400, "invalid_filter", "to must be RFC3339", nil)
			return
		}
		to = v.UTC()
	}
	if f, ok := from.(time.Time); ok {
		if t, ok := to.(time.Time); ok && f.After(t) {
			fail(w, r, 400, "invalid_filter", "from must be earlier than or equal to to", nil)
			return
		}
	}
	if !cursor.CreatedAt.IsZero() {
		cursorTime = cursor.CreatedAt
		cursorID = cursor.ID
	}
	rows, err := s.db.Query(r.Context(), `SELECT id::text,actor_id::text,action,entity_type,entity_id,details,created_at FROM audit_log WHERE ($1::timestamptz IS NULL OR (created_at,id)<($1::timestamptz,$2::uuid)) AND ($3='' OR action=$3) AND ($4='' OR actor_id=NULLIF($4,'')::uuid) AND ($5::timestamptz IS NULL OR created_at >= $5) AND ($6::timestamptz IS NULL OR created_at <= $6) ORDER BY created_at DESC,id DESC LIMIT $7`, cursorTime, cursorID, q.Get("action"), q.Get("actor_id"), from, to, limit+1)
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	defer rows.Close()
	items := []contracts.AuditEntry{}
	for rows.Next() {
		var x contracts.AuditEntry
		var raw []byte
		var created time.Time
		if err = rows.Scan(&x.ID, &x.ActorID, &x.Action, &x.EntityType, &x.EntityID, &raw, &created); err != nil {
			fail(w, r, 500, "internal_error", "request could not be completed", nil)
			return
		}
		if err = json.Unmarshal(raw, &x.Details); err != nil {
			fail(w, r, 500, "internal_error", "stored audit entry is invalid", nil)
			return
		}
		x.CreatedAt = created.UTC().Format(time.RFC3339Nano)
		items = append(items, x)
	}
	if err != nil || rows.Err() != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		last := items[len(items)-1]
		ts, _ := time.Parse(time.RFC3339Nano, last.CreatedAt)
		raw, _ := json.Marshal(auditCursor{CreatedAt: ts, ID: last.ID})
		next = base64.RawURLEncoding.EncodeToString(raw)
	}
	writeJSON(w, 200, contracts.Page[contracts.AuditEntry]{Items: items, NextCursor: next})
}
