package control

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"honeyforge/internal/contracts"
)

func TestParseEventFiltersCanonicalizesAndValidates(t *testing.T) {
	q := url.Values{
		"source_ip":  {"2001:0db8::1"},
		"from":       {"2026-10-01T00:00:00Z"},
		"to":         {"2026-10-02T00:00:00Z"},
		"event_type": {"http.request"},
	}
	filters, failure := parseEventFilters(q)
	if failure != nil {
		t.Fatalf("parse valid filters: %+v", failure)
	}
	if filters.sourceIP != "2001:db8::1" || filters.from == nil || filters.to == nil {
		t.Fatalf("parsed filters=%+v", filters)
	}
	q.Set("source_ip", "not-an-ip")
	if _, failure = parseEventFilters(q); failure == nil || failure.code != "invalid_filter" {
		t.Fatalf("invalid source_ip failure=%+v", failure)
	}
	q = url.Values{"from": {"2026-10-03T00:00:00Z"}, "to": {"2026-10-02T00:00:00Z"}}
	if _, failure = parseEventFilters(q); failure == nil {
		t.Fatal("accepted inverted time range")
	}
}

func TestEventCursorRoundTripAndRejectsMalformed(t *testing.T) {
	want := contracts.EventRecord{
		EventID:   "44444444-4444-4444-8444-444444444444",
		AgentID:   "33333333-3333-4333-8333-333333333333",
		Timestamp: "2026-10-14T10:20:30.123456789Z",
	}
	encoded := encodeEventCursor(want)
	cursor, failure := parseEventCursor(encoded)
	if failure != nil {
		t.Fatalf("parse cursor: %+v", failure)
	}
	if cursor.EventID != want.EventID || cursor.AgentID != want.AgentID || !cursor.OccurredAt.Equal(time.Date(2026, 10, 14, 10, 20, 30, 123456789, time.UTC)) {
		t.Fatalf("cursor=%+v", cursor)
	}
	if _, failure = parseEventCursor("not-base64"); failure == nil {
		t.Fatal("accepted malformed cursor")
	}
	bad, _ := json.Marshal(eventCursor{OccurredAt: time.Now(), EventID: "bad", AgentID: want.AgentID})
	if _, failure = parseEventCursor(base64.RawURLEncoding.EncodeToString(bad)); failure == nil {
		t.Fatal("accepted cursor with invalid event ID")
	}
}

func TestParseEventPageAcceptsStructuredCursor(t *testing.T) {
	encoded := encodeEventCursor(contracts.EventRecord{
		EventID:   "44444444-4444-4444-8444-444444444444",
		AgentID:   "33333333-3333-4333-8333-333333333333",
		Timestamp: "2026-10-14T10:20:30Z",
	})
	r := httptest.NewRequest("GET", "/api/v1/events?limit=25&cursor="+url.QueryEscape(encoded), nil)
	limit, gotCursor, failure := parseEventPage(r, "trap_id")
	if failure != nil || limit != 25 || gotCursor != encoded {
		t.Fatalf("page=(%d,%q), failure=%+v", limit, gotCursor, failure)
	}
	if _, failure = parseEventCursor(gotCursor); failure != nil {
		t.Fatalf("event cursor rejected after page parsing: %+v", failure)
	}
	r = httptest.NewRequest("GET", "/api/v1/events?cursor=", nil)
	if _, _, failure = parseEventPage(r); failure == nil || failure.code != "invalid_cursor" {
		t.Fatalf("empty explicit cursor failure=%+v", failure)
	}
}

func TestEventMetadataScanNeverLoadsRawPayload(t *testing.T) {
	record, err := scanEventMetadata(eventScanStub(true))
	if err != nil {
		t.Fatalf("scan metadata: %v", err)
	}
	encoded, _ := json.Marshal(record)
	if !record.PayloadRedacted || len(record.Payload) != 0 {
		t.Fatalf("event metadata did not mark payload redacted: %+v", record)
	}
	if strings.Contains(string(encoded), "password") || strings.Contains(string(encoded), "private value") {
		t.Fatalf("raw payload escaped metadata response: %s", encoded)
	}
}

func TestSensitiveEventScanReturnsPayloadForAuditedHandler(t *testing.T) {
	record, payload, err := scanEventRecord(eventScanStub([]byte(`{"password":"private value"}`)))
	if err != nil {
		t.Fatalf("scan sensitive record: %v", err)
	}
	if record.Payload["password"] != "private value" || payload["password"] != "private value" {
		t.Fatalf("sensitive payload was not decoded: %#v", record.Payload)
	}
}

type eventScanValues []any

func (stub eventScanValues) Scan(dest ...any) error {
	if len(dest) != len(stub) {
		return fmt.Errorf("scan columns=%d, values=%d", len(dest), len(stub))
	}
	for i, target := range dest {
		value := reflect.ValueOf(target).Elem()
		source := reflect.ValueOf(stub[i])
		if !source.IsValid() {
			value.SetZero()
			continue
		}
		if !source.Type().AssignableTo(value.Type()) {
			return fmt.Errorf("column %d: %s cannot be assigned to %s", i, source.Type(), value.Type())
		}
		value.Set(source)
	}
	return nil
}

func eventScanStub(payloadTarget any) eventScanValues {
	eventID := "44444444-4444-4444-8444-444444444444"
	trapID := "22222222-2222-4222-8222-222222222222"
	agentID := "33333333-3333-4333-8333-333333333333"
	serviceID := "web"
	eventType := "http.request"
	protocol := "http"
	timestamp := time.Date(2026, 10, 14, 10, 20, 30, 0, time.UTC)
	return eventScanValues{
		eventID, trapID, agentID, serviceID,
		(*string)(nil), (*string)(nil), (*int)(nil), eventType,
		timestamp, timestamp, (*string)(nil), (*string)(nil), (*string)(nil), (*int64)(nil),
		(*string)(nil), (*string)(nil), (*string)(nil), (*int)(nil), (*int)(nil), protocol, payloadTarget,
	}
}

func TestSafeCSVCellNeutralizesFormulaPrefixes(t *testing.T) {
	cases := map[string]string{
		"=1+1":       "'=1+1",
		"  @SUM(A1)": "'  @SUM(A1)",
		"\t-2+3":     "'\t-2+3",
		"ordinary":   "ordinary",
	}
	for input, want := range cases {
		if got := safeCSVCell(input); got != want {
			t.Errorf("safeCSVCell(%q)=%q, want %q", input, got, want)
		}
	}
}

func TestAllowQueryRejectsRepeatedAndUnknownParameters(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/v1/events?trap_id=a&trap_id=b", nil)
	if failure := allowQuery(req, "trap_id"); failure == nil {
		t.Fatal("accepted repeated filter")
	}
	req = httptest.NewRequest("GET", "/api/v1/events?payload=secret", nil)
	if failure := allowQuery(req, "trap_id"); failure == nil {
		t.Fatal("accepted unsupported filter")
	}
}

func TestEventFilterArgsKeepNullAndBoundValues(t *testing.T) {
	filters := eventFilters{trapID: "22222222-2222-4222-8222-222222222222", eventType: "http.request"}
	args := filters.args()
	want := []any{filters.trapID, nil, nil, filters.eventType, nil, nil}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("args=%#v, want %#v", args, want)
	}
}
