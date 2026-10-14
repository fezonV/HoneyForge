package control

import (
	"context"
	"encoding/base64"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"honeyforge/internal/contracts"
)

const maxEventExportRows = 10000

type eventFilters struct {
	trapID    string
	sessionID string
	sourceIP  string
	eventType string
	from      *time.Time
	to        *time.Time
}

type eventCursor struct {
	OccurredAt time.Time `json:"occurred_at"`
	EventID    string    `json:"event_id"`
	AgentID    string    `json:"agent_id"`
}

func allowQuery(r *http.Request, allowed ...string) *apiFailure {
	set := make(map[string]bool, len(allowed))
	for _, key := range allowed {
		set[key] = true
	}
	for key, values := range r.URL.Query() {
		if !set[key] || len(values) != 1 {
			return &apiFailure{status: 400, code: "invalid_query", message: "unsupported or repeated query parameter", fields: map[string]string{key: "unsupported"}}
		}
	}
	return nil
}

func parseEventFilters(q url.Values) (eventFilters, *apiFailure) {
	filters := eventFilters{trapID: q.Get("trap_id"), sessionID: q.Get("session_id"), eventType: q.Get("event_type")}
	if filters.trapID != "" && !contracts.ValidID(filters.trapID) {
		return filters, &apiFailure{status: 400, code: "invalid_filter", message: "trap_id must be a UUID", fields: map[string]string{"trap_id": "invalid UUID"}}
	}
	if filters.sessionID != "" && !contracts.ValidID(filters.sessionID) {
		return filters, &apiFailure{status: 400, code: "invalid_filter", message: "session_id must be a UUID", fields: map[string]string{"session_id": "invalid UUID"}}
	}
	if filters.eventType != "" && (len(filters.eventType) > 128 || !validTelemetryEventType(filters.eventType)) {
		return filters, &apiFailure{status: 400, code: "invalid_filter", message: "event_type is unsupported", fields: map[string]string{"event_type": "unsupported"}}
	}
	if q.Get("source_ip") != "" {
		ip := net.ParseIP(q.Get("source_ip"))
		if ip == nil {
			return filters, &apiFailure{status: 400, code: "invalid_filter", message: "source_ip must be an IP address", fields: map[string]string{"source_ip": "invalid IP address"}}
		}
		filters.sourceIP = ip.String()
	}
	if q.Get("from") != "" {
		parsed, err := time.Parse(time.RFC3339Nano, q.Get("from"))
		if err != nil {
			return filters, &apiFailure{status: 400, code: "invalid_filter", message: "from must be RFC3339", fields: map[string]string{"from": "invalid timestamp"}}
		}
		parsed = parsed.UTC()
		filters.from = &parsed
	}
	if q.Get("to") != "" {
		parsed, err := time.Parse(time.RFC3339Nano, q.Get("to"))
		if err != nil {
			return filters, &apiFailure{status: 400, code: "invalid_filter", message: "to must be RFC3339", fields: map[string]string{"to": "invalid timestamp"}}
		}
		parsed = parsed.UTC()
		filters.to = &parsed
	}
	if filters.from != nil && filters.to != nil && filters.from.After(*filters.to) {
		return filters, &apiFailure{status: 400, code: "invalid_filter", message: "from must be earlier than or equal to to", fields: map[string]string{"from": "after to"}}
	}
	return filters, nil
}

func (f eventFilters) args() []any {
	var trapID, sessionID, sourceIP, eventType, from, to any
	if f.trapID != "" {
		trapID = f.trapID
	}
	if f.sessionID != "" {
		sessionID = f.sessionID
	}
	if f.sourceIP != "" {
		sourceIP = f.sourceIP
	}
	if f.eventType != "" {
		eventType = f.eventType
	}
	if f.from != nil {
		from = *f.from
	}
	if f.to != nil {
		to = *f.to
	}
	return []any{trapID, sessionID, sourceIP, eventType, from, to}
}

const eventFilterSQL = `($1::uuid IS NULL OR trap_id=$1) AND
	($2::uuid IS NULL OR session_id=$2) AND
	($3::inet IS NULL OR source_ip=$3) AND
	($4::text IS NULL OR event_type=$4) AND
	($5::timestamptz IS NULL OR occurred_at >= $5) AND
	($6::timestamptz IS NULL OR occurred_at <= $6)`

func parseEventCursor(encoded string) (*eventCursor, *apiFailure) {
	if encoded == "" {
		return nil, nil
	}
	if len(encoded) > 512 {
		return nil, &apiFailure{status: 400, code: "invalid_cursor", message: "cursor is invalid"}
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	var cursor eventCursor
	if err != nil || len(raw) > 256 || json.Unmarshal(raw, &cursor) != nil || cursor.OccurredAt.IsZero() || !contracts.ValidID(cursor.EventID) || !contracts.ValidID(cursor.AgentID) {
		return nil, &apiFailure{status: 400, code: "invalid_cursor", message: "cursor is invalid"}
	}
	cursor.OccurredAt = cursor.OccurredAt.UTC()
	return &cursor, nil
}

func parseEventPage(r *http.Request, allowedFilters ...string) (int, string, *apiFailure) {
	allowed := append(append([]string{}, allowedFilters...), "limit", "cursor")
	if failure := allowQuery(r, allowed...); failure != nil {
		return 0, "", failure
	}
	q := r.URL.Query()
	limit := contracts.DefaultPageSize
	if values, exists := q["limit"]; exists {
		parsed, err := strconv.Atoi(values[0])
		if err != nil || parsed < 1 || parsed > contracts.MaxPageSize {
			return 0, "", &apiFailure{status: 400, code: "invalid_limit", message: "limit must be between 1 and 100", fields: map[string]string{"limit": "out of range"}}
		}
		limit = parsed
	}
	encodedCursor, hasCursor := q["cursor"]
	if hasCursor && (encodedCursor[0] == "" || len(encodedCursor[0]) > 512) {
		return 0, "", &apiFailure{status: 400, code: "invalid_cursor", message: "cursor is invalid"}
	}
	if !hasCursor {
		return limit, "", nil
	}
	return limit, encodedCursor[0], nil
}

func encodeEventCursor(record contracts.EventRecord) string {
	occurredAt, _ := time.Parse(time.RFC3339Nano, record.Timestamp)
	raw, _ := json.Marshal(eventCursor{OccurredAt: occurredAt, EventID: record.EventID, AgentID: record.AgentID})
	return base64.RawURLEncoding.EncodeToString(raw)
}

func (s *Server) listEvents(w http.ResponseWriter, r *http.Request) {
	limit, encodedCursor, parseErr := parseEventPage(r, "trap_id", "from", "to", "source_ip", "event_type", "session_id")
	if parseFailure(w, r, parseErr) {
		return
	}
	filters, failure := parseEventFilters(r.URL.Query())
	if failure != nil {
		parseFailure(w, r, failure)
		return
	}
	cursor, failure := parseEventCursor(encodedCursor)
	if failure != nil {
		parseFailure(w, r, failure)
		return
	}
	items, err := queryEventRows(r.Context(), s.db, filters, cursor, limit+1, false)
	if err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		next = encodeEventCursor(items[len(items)-1])
	}
	writeJSON(w, 200, contracts.Page[contracts.EventRecord]{Items: items, NextCursor: next})
}

func queryEventRows(ctx context.Context, q interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}, filters eventFilters, cursor *eventCursor, limit int, ascending bool) ([]contracts.EventRecord, error) {
	args := filters.args()
	comparison, order := "<", "DESC"
	if ascending {
		comparison, order = ">", "ASC"
	}
	cursorTime, cursorEvent, cursorAgent := any(nil), any(nil), any(nil)
	if cursor != nil {
		cursorTime, cursorEvent, cursorAgent = cursor.OccurredAt, cursor.EventID, cursor.AgentID
	}
	args = append(args, cursorTime, cursorEvent, cursorAgent, limit)
	query := fmt.Sprintf(`SELECT id::text,trap_id::text,agent_id::text,service_id,session_id::text,profile_id::text,applied_revision,event_type,occurred_at,received_at,source_ip::text,source_country_code,source_country_name,source_asn,source_asn_org,geo_source,geo_version,source_port,destination_port,protocol,payload <> '{}'::jsonb
		FROM events WHERE %s AND ($7::timestamptz IS NULL OR (occurred_at,id,agent_id) %s ($7,$8::uuid,$9::uuid))
		ORDER BY occurred_at %s,id %s,agent_id %s LIMIT $10`, eventFilterSQL, comparison, order, order, order)
	rows, err := q.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]contracts.EventRecord, 0, limit)
	for rows.Next() {
		record, scanErr := scanEventMetadata(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, record)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

type eventScanner interface{ Scan(...any) error }

func scanEventRecord(row eventScanner) (contracts.EventRecord, map[string]any, error) {
	var rawPayload []byte
	record, err := scanEventColumns(row, &rawPayload)
	if err != nil {
		return record, nil, err
	}
	payload := map[string]any{}
	if err = json.Unmarshal(rawPayload, &payload); err != nil {
		return record, nil, err
	}
	if payload == nil {
		payload = map[string]any{}
	}
	record.Payload = payload
	return record, payload, nil
}

func scanEventMetadata(row eventScanner) (contracts.EventRecord, error) {
	var hasPayload bool
	record, err := scanEventColumns(row, &hasPayload)
	if err != nil {
		return record, err
	}
	redactEventPayload(&record, hasPayload)
	return record, nil
}

func scanEventColumns(row eventScanner, payloadTarget any) (contracts.EventRecord, error) {
	var record contracts.EventRecord
	var sessionID, profileID, sourceIP *string
	var countryCode, countryName, asnOrg, geoSource, geoVersion *string
	var asn *int64
	var appliedRevision, sourcePort, destinationPort *int
	var occurredAt, receivedAt time.Time
	err := row.Scan(&record.EventID, &record.TrapID, &record.AgentID, &record.ServiceID, &sessionID, &profileID, &appliedRevision,
		&record.EventType, &occurredAt, &receivedAt, &sourceIP, &countryCode, &countryName, &asn, &asnOrg, &geoSource, &geoVersion,
		&sourcePort, &destinationPort, &record.Protocol, payloadTarget)
	if err != nil {
		return record, err
	}
	record.SessionID, record.ProfileID, record.AppliedRevision = sessionID, profileID, appliedRevision
	record.SourceIP, record.SourcePort, record.DestinationPort = sourceIP, sourcePort, destinationPort
	record.SourceCountryCode, record.SourceCountryName, record.SourceASN = countryCode, countryName, asn
	record.SourceASNOrg, record.GeoSource, record.GeoVersion = asnOrg, geoSource, geoVersion
	record.Timestamp = occurredAt.UTC().Format(time.RFC3339Nano)
	record.ReceivedAt = receivedAt.UTC().Format(time.RFC3339Nano)
	return record, nil
}

func redactEventPayload(record *contracts.EventRecord, hasPayload bool) {
	// Event payload schemas can grow with decoy integrations. Until a field is
	// explicitly classified as safe, only the audited operator endpoint returns it.
	record.Payload = map[string]any{}
	record.PayloadRedacted = hasPayload
}

func (s *Server) getEvent(w http.ResponseWriter, r *http.Request) {
	trapID, eventID := r.PathValue("trap_id"), r.PathValue("event_id")
	if !checkID(w, r, trapID) || !checkID(w, r, eventID) {
		return
	}
	record, err := readEventMetadata(r.Context(), s.db, trapID, eventID)
	if noRows(err) {
		fail(w, r, 404, "not_found", "event not found", nil)
		return
	}
	if err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	writeJSON(w, 200, record)
}

func (s *Server) getSensitiveEvent(w http.ResponseWriter, r *http.Request) {
	trapID, eventID := r.PathValue("trap_id"), r.PathValue("event_id")
	if !checkID(w, r, trapID) || !checkID(w, r, eventID) {
		return
	}
	actor := currentActor(r)
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	defer tx.Rollback(context.Background())
	record, _, err := readEvent(r.Context(), tx, trapID, eventID)
	if noRows(err) {
		fail(w, r, 404, "not_found", "event not found", nil)
		return
	}
	if err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	if err = auditTx(r.Context(), tx, &actor.id, "event.sensitive_read", "event", trapID+"/"+eventID, map[string]any{}); err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	writeJSON(w, 200, record)
}

func readEventMetadata(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, trapID, eventID string) (contracts.EventRecord, error) {
	row := q.QueryRow(ctx, `SELECT id::text,trap_id::text,agent_id::text,service_id,session_id::text,profile_id::text,applied_revision,event_type,occurred_at,received_at,source_ip::text,source_country_code,source_country_name,source_asn,source_asn_org,geo_source,geo_version,source_port,destination_port,protocol,payload <> '{}'::jsonb
		FROM events WHERE trap_id=$1 AND id=$2 ORDER BY agent_id LIMIT 1`, trapID, eventID)
	return scanEventMetadata(row)
}

func readEvent(ctx context.Context, q interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, trapID, eventID string) (contracts.EventRecord, map[string]any, error) {
	row := q.QueryRow(ctx, `SELECT id::text,trap_id::text,agent_id::text,service_id,session_id::text,profile_id::text,applied_revision,event_type,occurred_at,received_at,source_ip::text,source_country_code,source_country_name,source_asn,source_asn_org,geo_source,geo_version,source_port,destination_port,protocol,payload
		FROM events WHERE trap_id=$1 AND id=$2 ORDER BY agent_id LIMIT 1`, trapID, eventID)
	return scanEventRecord(row)
}

func (s *Server) getSessionTimeline(w http.ResponseWriter, r *http.Request) {
	sessionID := r.PathValue("id")
	if !checkID(w, r, sessionID) {
		return
	}
	limit, encodedCursor, parseErr := parseEventPage(r, "from", "to", "source_ip", "event_type")
	if parseFailure(w, r, parseErr) {
		return
	}
	filters, failure := parseEventFilters(r.URL.Query())
	if failure != nil {
		parseFailure(w, r, failure)
		return
	}
	filters.sessionID = sessionID
	cursor, failure := parseEventCursor(encodedCursor)
	if failure != nil {
		parseFailure(w, r, failure)
		return
	}
	var session contracts.VisitorSession
	var endedAt *time.Time
	var startedAt time.Time
	err := s.db.QueryRow(r.Context(), `SELECT id::text,trap_id::text,started_at,ended_at FROM visitor_sessions WHERE id=$1`, sessionID).Scan(&session.ID, &session.TrapID, &startedAt, &endedAt)
	if noRows(err) {
		fail(w, r, 404, "not_found", "session not found", nil)
		return
	}
	if err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	session.StartedAt = startedAt.UTC().Format(time.RFC3339Nano)
	if endedAt != nil {
		ended := endedAt.UTC().Format(time.RFC3339Nano)
		session.EndedAt = &ended
	}
	items, err := queryEventRows(r.Context(), s.db, filters, cursor, limit+1, true)
	if err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	next := ""
	if len(items) > limit {
		items = items[:limit]
		next = encodeEventCursor(items[len(items)-1])
	}
	writeJSON(w, 200, contracts.SessionTimeline{Session: session, Items: items, NextCursor: next})
}

func (s *Server) eventSummary(w http.ResponseWriter, r *http.Request) {
	if failure := allowQuery(r, "trap_id", "from", "to", "source_ip", "event_type", "session_id"); failure != nil {
		parseFailure(w, r, failure)
		return
	}
	filters, failure := parseEventFilters(r.URL.Query())
	if failure != nil {
		parseFailure(w, r, failure)
		return
	}
	if filters.from == nil || filters.to == nil {
		fail(w, r, 400, "invalid_filter", "from and to are required for a period summary", map[string]string{"from": "required", "to": "required"})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	defer tx.Rollback(context.Background())
	args := filters.args()
	summary := contracts.EventSummary{From: filters.from.Format(time.RFC3339Nano), To: filters.to.Format(time.RFC3339Nano), ByEventType: []contracts.EventTypeCount{}, TopSources: []contracts.EventSourceCount{}}
	if err = tx.QueryRow(r.Context(), `SELECT count(*),count(DISTINCT source_ip) FROM events WHERE `+eventFilterSQL, args...).Scan(&summary.TotalEvents, &summary.UniqueSources); err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	rows, err := tx.Query(r.Context(), `SELECT event_type,count(*) FROM events WHERE `+eventFilterSQL+` GROUP BY event_type ORDER BY count(*) DESC,event_type LIMIT 100`, args...)
	if err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	for rows.Next() {
		var item contracts.EventTypeCount
		if err = rows.Scan(&item.EventType, &item.Count); err != nil {
			rows.Close()
			fail(w, r, 500, "internal_error", "request could not be completed", nil)
			return
		}
		summary.ByEventType = append(summary.ByEventType, item)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	rows.Close()
	rows, err = tx.Query(r.Context(), `SELECT source_ip::text,count(*),
		(array_agg(source_country_code ORDER BY occurred_at DESC,id DESC,agent_id DESC))[1],
		(array_agg(source_country_name ORDER BY occurred_at DESC,id DESC,agent_id DESC))[1],
		(array_agg(source_asn ORDER BY occurred_at DESC,id DESC,agent_id DESC))[1],
		(array_agg(source_asn_org ORDER BY occurred_at DESC,id DESC,agent_id DESC))[1]
		FROM events WHERE `+eventFilterSQL+` AND source_ip IS NOT NULL GROUP BY source_ip ORDER BY count(*) DESC,source_ip LIMIT 10`, args...)
	if err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	for rows.Next() {
		var item contracts.EventSourceCount
		if err = rows.Scan(&item.SourceIP, &item.Count, &item.SourceCountryCode, &item.SourceCountryName, &item.SourceASN, &item.SourceASNOrg); err != nil {
			rows.Close()
			fail(w, r, 500, "internal_error", "request could not be completed", nil)
			return
		}
		summary.TopSources = append(summary.TopSources, item)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	rows.Close()
	if err = tx.Commit(r.Context()); err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	writeJSON(w, 200, summary)
}

func (s *Server) exportEventsCSV(w http.ResponseWriter, r *http.Request) {
	if failure := allowQuery(r, "trap_id", "from", "to", "source_ip", "event_type", "session_id", "limit"); failure != nil {
		parseFailure(w, r, failure)
		return
	}
	filters, failure := parseEventFilters(r.URL.Query())
	if failure != nil {
		parseFailure(w, r, failure)
		return
	}
	limit := 5000
	if r.URL.Query().Get("limit") != "" {
		parsed, err := strconv.Atoi(r.URL.Query().Get("limit"))
		if err != nil || parsed < 1 || parsed > maxEventExportRows {
			fail(w, r, 400, "invalid_limit", "limit must be between 1 and 10000", nil)
			return
		}
		limit = parsed
	}
	items, err := queryEventRows(r.Context(), s.db, filters, nil, limit+1, false)
	if err != nil {
		logDB(r, err)
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	if len(items) > limit {
		fail(w, r, http.StatusRequestEntityTooLarge, "export_limit_exceeded", "narrow the filters or increase limit up to 10000", nil)
		return
	}
	var output strings.Builder
	csvWriter := csv.NewWriter(&output)
	if err = csvWriter.Write([]string{"timestamp", "event_id", "trap_id", "service_id", "event_type", "session_id", "source_ip", "source_country_code", "source_country_name", "source_asn", "source_asn_org", "source_port", "destination_port", "protocol"}); err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	for _, item := range items {
		row := []string{item.Timestamp, item.EventID, item.TrapID, item.ServiceID, item.EventType, derefString(item.SessionID), derefString(item.SourceIP), derefString(item.SourceCountryCode), derefString(item.SourceCountryName), derefInt64(item.SourceASN), derefString(item.SourceASNOrg), derefInt(item.SourcePort), derefInt(item.DestinationPort), item.Protocol}
		for i := range row {
			row[i] = safeCSVCell(row[i])
		}
		if err = csvWriter.Write(row); err != nil {
			fail(w, r, 500, "internal_error", "request could not be completed", nil)
			return
		}
	}
	csvWriter.Flush()
	if err = csvWriter.Error(); err != nil {
		fail(w, r, 500, "internal_error", "request could not be completed", nil)
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="honeyforge-events.csv"`)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(output.String()))
}

func derefString(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func derefInt(value *int) string {
	if value == nil {
		return ""
	}
	return strconv.Itoa(*value)
}

func derefInt64(value *int64) string {
	if value == nil {
		return ""
	}
	return strconv.FormatInt(*value, 10)
}

func safeCSVCell(value string) string {
	trimmed := strings.TrimLeftFunc(value, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) || r == '\uFEFF' })
	if trimmed != "" && strings.ContainsRune("=+-@", rune(trimmed[0])) {
		return "'" + value
	}
	return value
}
