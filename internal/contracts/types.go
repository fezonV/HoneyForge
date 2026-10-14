package contracts

import (
	"fmt"
	"path"
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	DefaultPageSize = 50
	MaxPageSize     = 100
	MaxBodyBytes    = 1 << 20
)

type Template struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Level        string   `json:"level"`
	Description  string   `json:"description"`
	Capabilities []string `json:"capabilities"`
}
type Service struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Protocol string `json:"protocol"`
	Port     int    `json:"port"`
	Banner   string `json:"banner"`
}
type SyntheticCredential struct {
	Username string `json:"username"`
	Password string `json:"password"`
}
type FakeFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}
type VisibleTexts struct {
	Title       string `json:"title"`
	LoginPrompt string `json:"login_prompt"`
	Success     string `json:"success"`
	Failure     string `json:"failure"`
}
type Logging struct {
	Categories []string `json:"categories"`
}
type Channel struct {
	TLSRequired      bool `json:"tls_required"`
	HeartbeatSeconds int  `json:"heartbeat_seconds"`
	SyncSeconds      int  `json:"sync_seconds"`
}
type ProfileConfig struct {
	TemplateID           string                `json:"template_id"`
	Level                string                `json:"level"`
	Services             []Service             `json:"services"`
	VisibleTexts         VisibleTexts          `json:"visible_texts"`
	SyntheticCredentials []SyntheticCredential `json:"synthetic_credentials"`
	FakeFS               []FakeFile            `json:"fake_fs"`
	Logging              Logging               `json:"logging"`
	Channel              Channel               `json:"channel"`
}
type Profile struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	Description     string  `json:"description"`
	CurrentRevision int     `json:"current_revision"`
	DeletedAt       *string `json:"deleted_at,omitempty"`
	CreatedAt       string  `json:"created_at"`
	UpdatedAt       string  `json:"updated_at"`
}
type ProfileRevision struct {
	ProfileID         string        `json:"profile_id"`
	Revision          int           `json:"revision"`
	Config            ProfileConfig `json:"config"`
	CreatedAt         string        `json:"created_at"`
	CreatedBy         string        `json:"created_by"`
	SensitiveRedacted bool          `json:"sensitive_redacted"`
}
type CreateProfileRequest struct {
	Name        string        `json:"name"`
	Description string        `json:"description"`
	Config      ProfileConfig `json:"config"`
}
type PatchProfileRequest struct {
	BaseRevision int           `json:"base_revision"`
	Name         string        `json:"name"`
	Description  string        `json:"description"`
	Config       ProfileConfig `json:"config"`
}
type DeploymentBinding struct {
	ServiceID   string `json:"service_id"`
	HostPort    int    `json:"host_port"`
	BindAddress string `json:"bind_address,omitempty"`
}
type Trap struct {
	ID                 string              `json:"id"`
	Name               string              `json:"name"`
	DesiredProfileID   *string             `json:"desired_profile_id"`
	DesiredRevision    *int                `json:"desired_revision"`
	AppliedProfileID   *string             `json:"applied_profile_id"`
	AppliedRevision    *int                `json:"applied_revision"`
	AgentStatus        string              `json:"agent_status"`
	ServiceStatus      string              `json:"service_status"`
	LastSeen           *string             `json:"last_seen,omitempty"`
	DeploymentBindings []DeploymentBinding `json:"deployment_bindings"`
	CreatedAt          string              `json:"created_at"`
}
type CreateTrapRequest struct {
	Name               string              `json:"name"`
	DeploymentBindings []DeploymentBinding `json:"deployment_bindings"`
}
type AssignProfileRequest struct {
	ProfileID string `json:"profile_id"`
	Revision  int    `json:"revision"`
}
type Agent struct {
	ID        string  `json:"id"`
	TrapID    string  `json:"trap_id"`
	CreatedAt string  `json:"created_at"`
	LastSeen  *string `json:"last_seen,omitempty"`
}
type Command struct {
	ID                string  `json:"id"`
	TrapID            string  `json:"trap_id"`
	Type              string  `json:"type"`
	ExpectedProfileID *string `json:"expected_profile_id"`
	ExpectedRevision  *int    `json:"expected_revision,omitempty"`
	TargetProfileID   *string `json:"target_profile_id,omitempty"`
	TargetRevision    *int    `json:"target_revision,omitempty"`
	Status            string  `json:"status"`
	Error             string  `json:"error,omitempty"`
	ExpiresAt         string  `json:"expires_at"`
	CreatedAt         string  `json:"created_at"`
}
type QueueCommandRequest struct {
	Type              string `json:"type"`
	ExpectedProfileID string `json:"expected_profile_id"`
	ExpectedRevision  *int   `json:"expected_revision"`
	TTLSeconds        int    `json:"ttl_seconds"`
}
type Event struct {
	SchemaVersion   string         `json:"schema_version"`
	EventID         string         `json:"event_id"`
	TrapID          string         `json:"trap_id"`
	AgentID         string         `json:"agent_id"`
	ServiceID       string         `json:"service_id"`
	SessionID       string         `json:"session_id,omitempty"`
	ProfileID       string         `json:"profile_id,omitempty"`
	AppliedRevision *int           `json:"applied_revision,omitempty"`
	EventType       string         `json:"event_type"`
	Timestamp       string         `json:"timestamp"`
	SourceIP        string         `json:"source_ip,omitempty"`
	SourcePort      *int           `json:"source_port,omitempty"`
	DestinationPort int            `json:"destination_port,omitempty"`
	Protocol        string         `json:"protocol"`
	Payload         map[string]any `json:"payload"`
}

// EventRecord is the operator-facing event representation. Payload values are
// redacted unless the caller uses the audited sensitive-event endpoint.
type EventRecord struct {
	EventID           string         `json:"event_id"`
	TrapID            string         `json:"trap_id"`
	AgentID           string         `json:"agent_id"`
	ServiceID         string         `json:"service_id"`
	SessionID         *string        `json:"session_id,omitempty"`
	ProfileID         *string        `json:"profile_id,omitempty"`
	AppliedRevision   *int           `json:"applied_revision,omitempty"`
	EventType         string         `json:"event_type"`
	Timestamp         string         `json:"timestamp"`
	ReceivedAt        string         `json:"received_at"`
	SourceIP          *string        `json:"source_ip,omitempty"`
	SourceCountryCode *string        `json:"source_country_code,omitempty"`
	SourceCountryName *string        `json:"source_country_name,omitempty"`
	SourceASN         *int64         `json:"source_asn,omitempty"`
	SourceASNOrg      *string        `json:"source_asn_org,omitempty"`
	GeoSource         *string        `json:"geo_source,omitempty"`
	GeoVersion        *string        `json:"geo_version,omitempty"`
	SourcePort        *int           `json:"source_port,omitempty"`
	DestinationPort   *int           `json:"destination_port,omitempty"`
	Protocol          string         `json:"protocol"`
	Payload           map[string]any `json:"payload"`
	PayloadRedacted   bool           `json:"payload_redacted"`
}
type EventTypeCount struct {
	EventType string `json:"event_type"`
	Count     int64  `json:"count"`
}
type EventSourceCount struct {
	SourceIP          string  `json:"source_ip"`
	Count             int64   `json:"count"`
	SourceCountryCode *string `json:"source_country_code,omitempty"`
	SourceCountryName *string `json:"source_country_name,omitempty"`
	SourceASN         *int64  `json:"source_asn,omitempty"`
	SourceASNOrg      *string `json:"source_asn_org,omitempty"`
}
type EventSummary struct {
	From          string             `json:"from"`
	To            string             `json:"to"`
	TotalEvents   int64              `json:"total_events"`
	UniqueSources int64              `json:"unique_sources"`
	ByEventType   []EventTypeCount   `json:"by_event_type"`
	TopSources    []EventSourceCount `json:"top_sources"`
}
type SessionTimeline struct {
	Session    VisitorSession `json:"session"`
	Items      []EventRecord  `json:"items"`
	NextCursor string         `json:"next_cursor,omitempty"`
}
type VisitorSession struct {
	ID        string  `json:"id"`
	TrapID    string  `json:"trap_id"`
	StartedAt string  `json:"started_at"`
	EndedAt   *string `json:"ended_at,omitempty"`
}
type AuditEntry struct {
	ID         string         `json:"id"`
	ActorID    *string        `json:"actor_id,omitempty"`
	Action     string         `json:"action"`
	EntityType string         `json:"entity_type"`
	EntityID   string         `json:"entity_id,omitempty"`
	Details    map[string]any `json:"details"`
	CreatedAt  string         `json:"created_at"`
}
type APIError struct {
	Error ErrorDetail `json:"error"`
}
type ErrorDetail struct {
	Code      string            `json:"code"`
	Message   string            `json:"message"`
	RequestID string            `json:"request_id"`
	Fields    map[string]string `json:"fields,omitempty"`
}
type Page[T any] struct {
	Items      []T    `json:"items"`
	NextCursor string `json:"next_cursor,omitempty"`
}
type WSNotification struct {
	Type       string         `json:"type"`
	ID         string         `json:"id"`
	OccurredAt string         `json:"occurred_at"`
	Data       map[string]any `json:"data"`
}

var idRE = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var logCategories = map[string]bool{"connection.opened": true, "http.request": true, "auth.attempt": true, "session.started": true, "file.listed": true, "file.read": true, "file.downloaded": true, "session.ended": true, "command.received": true}
var mediumCategories = []string{"auth.attempt", "session.started", "file.listed", "file.read", "file.downloaded", "session.ended"}

func ValidID(s string) bool { return idRE.MatchString(strings.ToLower(s)) }
func ValidateProfile(c ProfileConfig) map[string]string {
	f := map[string]string{}
	if c.TemplateID != "low-http" && c.TemplateID != "medium-http" {
		f["template_id"] = "must be low-http or medium-http"
	}
	if c.Level != "low" && c.Level != "medium" {
		f["level"] = "must be low or medium"
	}
	if (c.TemplateID == "low-http" && c.Level != "low") || (c.TemplateID == "medium-http" && c.Level != "medium") {
		f["level"] = "must match template_id"
	}
	if len(c.Services) == 0 || len(c.Services) > 16 {
		f["services"] = "must contain 1 to 16 services"
	}
	ports := map[int]bool{}
	serviceIDs := map[string]bool{}
	for i, s := range c.Services {
		k := fmt.Sprintf("services[%d]", i)
		if s.ID == "" || len(s.ID) > 64 || serviceIDs[s.ID] {
			f[k+".id"] = "must be unique and 1 to 64 characters"
		}
		serviceIDs[s.ID] = true
		if strings.TrimSpace(s.Name) == "" || len(s.Name) > 100 {
			f[k+".name"] = "must be 1 to 100 characters"
		}
		if s.Protocol != "http" {
			f[k+".protocol"] = "only http is supported"
		}
		if s.Port < 1 || s.Port > 65535 || ports[s.Port] {
			f[k+".port"] = "must be a unique port from 1 to 65535"
		}
		ports[s.Port] = true
		if len(s.Banner) > 4096 {
			f[k+".banner"] = "must be at most 4096 bytes"
		}
	}
	texts := []string{c.VisibleTexts.Title, c.VisibleTexts.LoginPrompt, c.VisibleTexts.Success, c.VisibleTexts.Failure}
	for _, v := range texts {
		if len(v) > 4096 {
			f["visible_texts"] = "each visible text must be at most 4096 bytes"
		}
	}
	if len(c.SyntheticCredentials) > 100 {
		f["synthetic_credentials"] = "must contain at most 100 entries"
	}
	for i, v := range c.SyntheticCredentials {
		if strings.TrimSpace(v.Username) == "" || len(v.Username) > 128 || len(v.Password) > 256 {
			f[fmt.Sprintf("synthetic_credentials[%d]", i)] = "username is required (max 128 bytes), password max 256 bytes"
		}
	}
	if len(c.FakeFS) > 200 {
		f["fake_fs"] = "must contain at most 200 files"
	}
	seen := map[string]bool{}
	for i, v := range c.FakeFS {
		p := v.Path
		clean := path.Clean(p)
		bad := len(p) > 256 || p == "" || strings.HasPrefix(p, "/") || clean == ".." || strings.HasPrefix(clean, "../") || clean == "." || strings.Contains(p, "\\") || strings.Contains(p, ":") || strings.Contains(p, "\x00") || !utf8.ValidString(v.Content)
		for _, part := range strings.Split(p, "/") {
			if part == "" || part == "." || part == ".." {
				bad = true
			}
		}
		for _, r := range p {
			if r < 32 || r == 127 {
				bad = true
			}
		}
		if bad {
			f[fmt.Sprintf("fake_fs[%d].path", i)] = "must be a safe POSIX relative path of at most 256 bytes"
		}
		if seen[clean] {
			f[fmt.Sprintf("fake_fs[%d].path", i)] = "must be unique"
		}
		seen[clean] = true
		if len(v.Content) > 65536 {
			f[fmt.Sprintf("fake_fs[%d].content", i)] = "must be at most 65536 bytes"
		}
	}
	if !contains(c.Logging.Categories, "http.request") {
		f["logging.categories"] = "must include http.request"
	}
	for _, v := range c.Logging.Categories {
		if !logCategories[v] {
			f["logging.categories"] = "contains unsupported category"
		}
	}
	if c.Level == "medium" {
		for _, v := range mediumCategories {
			if !contains(c.Logging.Categories, v) {
				f["logging.categories"] = "medium requires auth.attempt, session.started, file.listed, file.read, file.downloaded, and session.ended"
				break
			}
		}
	}
	if !c.Channel.TLSRequired {
		f["channel.tls_required"] = "must be true"
	}
	if c.Channel.HeartbeatSeconds < 5 || c.Channel.HeartbeatSeconds > 300 {
		f["channel.heartbeat_seconds"] = "must be between 5 and 300"
	}
	if c.Channel.SyncSeconds < 1 || c.Channel.SyncSeconds > 3600 {
		f["channel.sync_seconds"] = "must be between 1 and 3600"
	}
	return f
}
func contains(a []string, x string) bool {
	for _, v := range a {
		if v == x {
			return true
		}
	}
	return false
}
func ValidLevel(s string) bool { return s == "low" || s == "medium" }
