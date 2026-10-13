package control

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"honeyforge/internal/contracts"
)

type profileRow struct {
	ID, Name, Description string
	Current               int
	Created, Updated      time.Time
	Deleted               *time.Time
}

func readProfile(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, id string) (profileRow, error) {
	var p profileRow
	err := q.QueryRow(ctx, `SELECT id::text,name,description,current_revision,created_at,updated_at,deleted_at FROM profiles WHERE id=$1`, id).Scan(&p.ID, &p.Name, &p.Description, &p.Current, &p.Created, &p.Updated, &p.Deleted)
	return p, err
}
func asProfile(p profileRow) contracts.Profile {
	out := contracts.Profile{ID: p.ID, Name: p.Name, Description: p.Description, CurrentRevision: p.Current, CreatedAt: p.Created.UTC().Format(time.RFC3339Nano), UpdatedAt: p.Updated.UTC().Format(time.RFC3339Nano)}
	if p.Deleted != nil {
		v := p.Deleted.UTC().Format(time.RFC3339Nano)
		out.DeletedAt = &v
	}
	return out
}
func scrub(c contracts.ProfileConfig) contracts.ProfileConfig {
	for i := range c.SyntheticCredentials {
		c.SyntheticCredentials[i].Password = ""
	}
	return c
}
func revision(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, profileID string, n int) (contracts.ProfileConfig, time.Time, string, error) {
	var raw []byte
	var created time.Time
	var by string
	err := q.QueryRow(ctx, `SELECT config,created_at,COALESCE(created_by::text,'') FROM profile_revisions WHERE profile_id=$1 AND revision=$2`, profileID, n).Scan(&raw, &created, &by)
	var c contracts.ProfileConfig
	if err == nil {
		err = json.Unmarshal(raw, &c)
	}
	return c, created, by, err
}
func (s *Server) listProfiles(w http.ResponseWriter, r *http.Request) {
	limit, cursor, e := parsePage(r, "name", "level")
	if parseFailure(w, r, e) {
		return
	}
	if cursor != "" && !contracts.ValidID(cursor) {
		fail(w, r, 400, "invalid_cursor", "cursor is invalid", nil)
		return
	}
	q := r.URL.Query()
	name := strings.TrimSpace(q.Get("name"))
	if len(name) > 120 {
		fail(w, r, 400, "invalid_filter", "name filter is too long", nil)
		return
	}
	level := q.Get("level")
	if level != "" && !contracts.ValidLevel(level) {
		fail(w, r, 400, "invalid_filter", "level must be low or medium", map[string]string{"level": "unsupported"})
		return
	}
	rows, err := s.db.Query(r.Context(), `SELECT p.id::text,p.name,p.description,p.current_revision,p.created_at,p.updated_at,p.deleted_at FROM profiles p JOIN profile_revisions pr ON pr.profile_id=p.id AND pr.revision=p.current_revision WHERE p.deleted_at IS NULL AND p.id>$1 AND ($2='' OR p.name ILIKE '%'||$2||'%') AND ($3='' OR pr.config->>'level'=$3) ORDER BY p.id LIMIT $4`, nullableCursor(cursor), name, level, limit+1)
	if err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	defer rows.Close()
	items := []contracts.Profile{}
	for rows.Next() {
		var p profileRow
		if err = rows.Scan(&p.ID, &p.Name, &p.Description, &p.Current, &p.Created, &p.Updated, &p.Deleted); err != nil {
			break
		}
		items = append(items, asProfile(p))
	}
	if err = rows.Err(); err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		next = base64Cursor(items[len(items)-1].ID)
	}
	writeJSON(w, 200, contracts.Page[contracts.Profile]{Items: items, NextCursor: next})
}
func nullableCursor(s string) any {
	if s == "" {
		return "00000000-0000-0000-0000-000000000000"
	}
	return s
}
func validateProfileInput(w http.ResponseWriter, r *http.Request, name, desc string, c contracts.ProfileConfig) bool {
	fields := contracts.ValidateProfile(c)
	if strings.TrimSpace(name) == "" || len(name) > 120 {
		fields["name"] = "must be 1 to 120 characters"
	}
	if len(desc) > 2000 {
		fields["description"] = "must be at most 2000 bytes"
	}
	if len(fields) > 0 {
		fail(w, r, 422, "validation_failed", "profile is invalid", fields)
		return false
	}
	return true
}
func (s *Server) createProfile(w http.ResponseWriter, r *http.Request) {
	var req contracts.CreateProfileRequest
	if !decode(w, r, &req) || !validateProfileInput(w, r, req.Name, req.Description, req.Config) {
		return
	}
	a := currentActor(r)
	id := uuid()
	raw, _ := json.Marshal(req.Config)
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	defer tx.Rollback(context.Background())
	_, err = tx.Exec(r.Context(), `INSERT INTO profiles(id,name,description,current_revision) VALUES($1,$2,$3,1)`, id, strings.TrimSpace(req.Name), req.Description)
	if err == nil {
		_, err = tx.Exec(r.Context(), `INSERT INTO profile_revisions(profile_id,revision,config,created_by) VALUES($1,1,$2,$3)`, id, raw, a.id)
	}
	if err == nil {
		err = auditTx(r.Context(), tx, &a.id, "profile.created", "profile", id, map[string]any{"revision": 1})
	}
	if err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	p, err := readProfile(r.Context(), tx, id)
	if err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	_, created, _, err := revision(r.Context(), tx, id, 1)
	if err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	writeJSON(w, 201, map[string]any{"profile": asProfile(p), "revision": contracts.ProfileRevision{ProfileID: id, Revision: 1, Config: scrub(req.Config), CreatedAt: created.UTC().Format(time.RFC3339Nano), CreatedBy: a.id, SensitiveRedacted: true}})
}
func (s *Server) getProfile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !checkID(w, r, id) {
		return
	}
	p, err := readProfile(r.Context(), s.db, id)
	if noRows(err) || p.Deleted != nil {
		fail(w, r, 404, "not_found", "profile not found", nil)
		return
	}
	if err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	c, created, by, err := revision(r.Context(), s.db, id, p.Current)
	if err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	writeJSON(w, 200, map[string]any{"profile": asProfile(p), "revision": contracts.ProfileRevision{ProfileID: id, Revision: p.Current, Config: scrub(c), CreatedAt: created.UTC().Format(time.RFC3339Nano), CreatedBy: by, SensitiveRedacted: true}})
}
func (s *Server) patchProfile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !checkID(w, r, id) {
		return
	}
	var req contracts.PatchProfileRequest
	if !decode(w, r, &req) || !validateProfileInput(w, r, req.Name, req.Description, req.Config) {
		return
	}
	if req.BaseRevision < 1 {
		fail(w, r, 422, "validation_failed", "base_revision must be positive", map[string]string{"base_revision": "must be positive"})
		return
	}
	a := currentActor(r)
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	defer tx.Rollback(context.Background())
	var current int
	var deleted *time.Time
	err = tx.QueryRow(r.Context(), `SELECT current_revision,deleted_at FROM profiles WHERE id=$1 FOR UPDATE`, id).Scan(&current, &deleted)
	if noRows(err) || deleted != nil {
		fail(w, r, 404, "not_found", "profile not found", nil)
		return
	}
	if err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	if req.BaseRevision != current {
		fail(w, r, 409, "revision_conflict", "profile changed since it was read", map[string]string{"current_revision": strconv.Itoa(current)})
		return
	}
	next := current + 1
	raw, _ := json.Marshal(req.Config)
	_, err = tx.Exec(r.Context(), `INSERT INTO profile_revisions(profile_id,revision,config,created_by) VALUES($1,$2,$3,$4)`, id, next, raw, a.id)
	if err == nil {
		_, err = tx.Exec(r.Context(), `UPDATE profiles SET name=$2,description=$3,current_revision=$4,updated_at=now() WHERE id=$1`, id, strings.TrimSpace(req.Name), req.Description, next)
	}
	if err == nil {
		err = auditTx(r.Context(), tx, &a.id, "profile.revision_created", "profile", id, map[string]any{"revision": next})
	}
	if err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	p, err := readProfile(r.Context(), tx, id)
	if err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	_, created, _, err := revision(r.Context(), tx, id, next)
	if err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	writeJSON(w, 200, map[string]any{"profile": asProfile(p), "revision": contracts.ProfileRevision{ProfileID: id, Revision: next, Config: scrub(req.Config), CreatedAt: created.UTC().Format(time.RFC3339Nano), CreatedBy: a.id, SensitiveRedacted: true}})
}
func (s *Server) deleteProfile(w http.ResponseWriter, r *http.Request) {
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
	var deleted *time.Time
	err = tx.QueryRow(r.Context(), `SELECT deleted_at FROM profiles WHERE id=$1 FOR UPDATE`, id).Scan(&deleted)
	if noRows(err) || deleted != nil {
		fail(w, r, 404, "not_found", "profile not found", nil)
		return
	}
	if err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	var assigned bool
	err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM traps WHERE desired_profile_id=$1 AND deleted_at IS NULL)`, id).Scan(&assigned)
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	if assigned {
		fail(w, r, 409, "profile_assigned", "detach profile from active traps before deletion", nil)
		return
	}
	_, err = tx.Exec(r.Context(), `UPDATE profiles SET deleted_at=now(),updated_at=now() WHERE id=$1`, id)
	if err == nil {
		err = auditTx(r.Context(), tx, &a.id, "profile.deleted", "profile", id, map[string]any{})
	}
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	w.WriteHeader(204)
}
func (s *Server) listRevisions(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !checkID(w, r, id) {
		return
	}
	var exists bool
	if err := s.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM profiles WHERE id=$1)`, id).Scan(&exists); err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	} else if !exists {
		fail(w, r, 404, "not_found", "profile not found", nil)
		return
	}
	limit := contracts.DefaultPageSize
	if vals, ok := r.URL.Query()["limit"]; ok {
		if len(vals) != 1 {
			fail(w, r, 400, "invalid_query", "query parameters may appear only once", nil)
			return
		}
		if vals[0] == "" {
			fail(w, r, 400, "invalid_limit", "limit must be between 1 and 100", nil)
			return
		}
		n, e := strconv.Atoi(vals[0])
		if e != nil || n < 1 || n > contracts.MaxPageSize {
			fail(w, r, 400, "invalid_limit", "limit must be between 1 and 100", nil)
			return
		}
		limit = n
	}
	cursor := 0
	if vals, ok := r.URL.Query()["cursor"]; ok {
		if len(vals) != 1 {
			fail(w, r, 400, "invalid_query", "query parameters may appear only once", nil)
			return
		}
		if vals[0] == "" || len(vals[0]) > 16 {
			fail(w, r, 400, "invalid_cursor", "cursor is invalid", nil)
			return
		}
		b, e := base64.RawURLEncoding.DecodeString(vals[0])
		if e != nil || len(b) > 10 {
			fail(w, r, 400, "invalid_cursor", "cursor is invalid", nil)
			return
		}
		cursor, e = strconv.Atoi(string(b))
		if e != nil || cursor < 1 || cursor > 2147483647 {
			fail(w, r, 400, "invalid_cursor", "cursor is invalid", nil)
			return
		}
	}
	for k := range r.URL.Query() {
		if k != "limit" && k != "cursor" {
			fail(w, r, 400, "invalid_query", "unsupported query parameter", map[string]string{k: "unsupported"})
			return
		}
	}
	rows, err := s.db.Query(r.Context(), `SELECT revision,config,created_at,COALESCE(created_by::text,'') FROM profile_revisions WHERE profile_id=$1 AND ($2=0 OR revision<$2) ORDER BY revision DESC LIMIT $3`, id, cursor, limit+1)
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	defer rows.Close()
	items := []contracts.ProfileRevision{}
	for rows.Next() {
		var it contracts.ProfileRevision
		var raw []byte
		var created time.Time
		if err = rows.Scan(&it.Revision, &raw, &created, &it.CreatedBy); err != nil {
			fail(w, r, 500, "internal_error", "request could not be completed", nil)
			return
		}
		if err = json.Unmarshal(raw, &it.Config); err != nil {
			fail(w, r, 500, "internal_error", "stored profile is invalid", nil)
			return
		}
		it.ProfileID = id
		it.Config = scrub(it.Config)
		it.SensitiveRedacted = true
		it.CreatedAt = created.UTC().Format(time.RFC3339Nano)
		items = append(items, it)
	}
	if err = rows.Err(); err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		next = base64Cursor(strconv.Itoa(items[len(items)-1].Revision))
	}
	writeJSON(w, 200, contracts.Page[contracts.ProfileRevision]{Items: items, NextCursor: next})
}
func (s *Server) getRevision(w http.ResponseWriter, r *http.Request) { s.revisionHandler(w, r, false) }
func (s *Server) getSensitiveRevision(w http.ResponseWriter, r *http.Request) {
	s.revisionHandler(w, r, true)
}
func (s *Server) revisionHandler(w http.ResponseWriter, r *http.Request, sensitive bool) {
	id := r.PathValue("id")
	if !checkID(w, r, id) {
		return
	}
	n, err := strconv.Atoi(r.PathValue("revision"))
	if err != nil || n < 1 {
		fail(w, r, 400, "invalid_revision", "revision must be a positive integer", nil)
		return
	}
	c, created, by, err := revision(r.Context(), s.db, id, n)
	if noRows(err) {
		fail(w, r, 404, "not_found", "profile revision not found", nil)
		return
	}
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	if sensitive {
		a := currentActor(r)
		tx, e := s.db.Begin(r.Context())
		if e != nil {
			fail(w, r, 500, "internal_error", "request could not be completed", nil)
			return
		}
		defer tx.Rollback(context.Background())
		if e = auditTx(r.Context(), tx, &a.id, "profile.sensitive_read", "profile", id, map[string]any{"revision": n}); e != nil {
			fail(w, r, 500, "internal_error", "request could not be completed", nil)
			return
		}
		if e = tx.Commit(r.Context()); e != nil {
			fail(w, r, 500, "internal_error", "request could not be completed", nil)
			return
		}
	} else {
		c = scrub(c)
	}
	writeJSON(w, 200, contracts.ProfileRevision{ProfileID: id, Revision: n, Config: c, CreatedAt: created.UTC().Format(time.RFC3339Nano), CreatedBy: by, SensitiveRedacted: !sensitive})
}
func normalizeTime(s string) string {
	t, e := time.Parse(time.RFC3339Nano, s)
	if e != nil {
		return s
	}
	return t.UTC().Format(time.RFC3339Nano)
}
func auditTx(ctx context.Context, tx pgx.Tx, actorID *string, action, entityType, entityID string, details map[string]any) error {
	raw, _ := json.Marshal(details)
	_, err := tx.Exec(ctx, `INSERT INTO audit_log(id,actor_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5,$6)`, uuid(), actorID, action, entityType, entityID, raw)
	return err
}
