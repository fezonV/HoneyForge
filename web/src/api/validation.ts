type Check = (value: unknown) => boolean;
const text: Check = (v) => typeof v === 'string';
const number: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const bool: Check = (v) => typeof v === 'boolean';
const record: Check = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const optional = (check: Check): Check => (v) => v === undefined || v === null || check(v);
const array = (check: Check): Check => (v) => Array.isArray(v) && v.every(check);
const object = (fields: Record<string, Check>): Check => (v) => record(v) &&
  Object.entries(fields).every(([key, check]) => check((v as Record<string, unknown>)[key]));
const oneOf = (...values: string[]): Check => (v) => typeof v === 'string' && values.includes(v);
const page = (item: Check) => object({ items: array(item), next_cursor: optional(text) });
const user = object({ id: text, username: text, role: oneOf('operator', 'viewer') });
const service = object({ id: text, name: text, protocol: text, port: number, banner: optional(text) });
const config = object({
  template_id: oneOf('low-http', 'medium-http'), level: oneOf('low', 'medium'), services: array(service),
  visible_texts: object({ title: text, login_prompt: text, success: text, failure: text }),
  synthetic_credentials: array(object({ username: text, password: text })),
  fake_fs: array(object({ path: text, content: text })),
  logging: object({ categories: array(text) }),
  channel: object({ tls_required: bool, heartbeat_seconds: number, sync_seconds: number }),
});
const profile = object({ id: text, name: text, current_revision: number, description: optional(text), created_at: optional(text), updated_at: optional(text) });
const revision = object({ profile_id: text, revision: number, config, created_at: optional(text), sensitive_redacted: optional(bool) });
const binding = object({ service_id: text, host_port: number, bind_address: optional(text) });
const trap = object({
  id: text, name: text, desired_profile_id: optional(text), desired_revision: optional(number),
  applied_profile_id: optional(text), applied_revision: optional(number), agent_status: oneOf('online', 'offline'),
  service_status: text, deployment_bindings: array(binding), last_seen: optional(text),
});
const command = object({ id: text, trap_id: text, type: oneOf('start', 'stop', 'apply_profile'),
  status: oneOf('queued', 'delivered', 'applied', 'failed', 'expired'), created_at: text, expires_at: text });
const event = object({ event_id: text, timestamp: text, trap_id: text, event_type: text, protocol: text,
  source_ip: optional(text), source_port: optional(number), destination_port: optional(number), payload: optional(record),
  agent_id: optional(text), service_id: optional(text), received_at: optional(text),
  profile_id: optional(text), applied_revision: optional(number), session_id: optional(text), payload_redacted: optional(bool),
  source_country_code: optional(text), source_country_name: optional(text), source_asn: optional(number), source_asn_org: optional(text),
  geo_source: optional(text), geo_version: optional(text) });
const audit = object({ id: text, created_at: text, action: text, entity_type: text, actor_id: optional(text), entity_id: optional(text), details: record });

// Validate the wire format before mapping it into UI models. Unknown properties
// remain compatible with additive API changes; required data never gets invented.
export function validResponse(endpoint: string, method: string, value: unknown): boolean {
  const path = endpoint.split('?')[0];
  if (path === '/api/v1/auth/me') return user(value);
  if (path === '/api/v1/auth/login') return object({ user, csrf_token: text, expires_in: number })(value);
  if (path === '/api/v1/templates') return array(object({ id: text, name: text, level: text, description: text, capabilities: array(text) }))(value);
  if (path === '/api/v1/profiles') return (method === 'GET' ? page(profile) : object({ profile, revision }))(value);
  if (/^\/api\/v1\/profiles\/[^/]+\/revisions$/.test(path)) return page(revision)(value);
  if (/^\/api\/v1\/profiles\/[^/]+\/revisions\/\d+(\/sensitive)?$/.test(path)) return revision(value);
  if (/^\/api\/v1\/profiles\/[^/]+$/.test(path)) return object({ profile, revision })(value);
  if (path === '/api/v1/traps') return (method === 'GET' ? page(trap) : trap)(value);
  if (/\/registration-attempts$/.test(path)) return page(object({ id: text, trap_id: text, outcome: text, reason: text, created_at: text }))(value);
  if (/\/enrollment-token$/.test(path)) return object({ trap_id: text, token: text, expires_in_seconds: number })(value);
  if (/\/commands$/.test(path)) return (method === 'GET' ? page(command) : command)(value);
  if (/^\/api\/v1\/traps\/[^/]+(\/profile)?$/.test(path)) return trap(value);
  if (path === '/api/v1/events') return page(event)(value);
  if (/^\/api\/v1\/traps\/[^/]+\/events\/[^/]+(\/sensitive)?$/.test(path)) return event(value);
  if (/^\/api\/v1\/sessions\/[^/]+\/timeline$/.test(path)) return object({ session: object({ id: text, trap_id: text, started_at: text }), items: array(event), next_cursor: optional(text) })(value);
  if (path === '/api/v1/events/summary') return object({ from: text, to: text, total_events: number, unique_sources: number,
    by_event_type: array(object({ event_type: text, count: number })),
    top_sources: array(object({ source_ip: text, count: number, source_country_name: optional(text), source_country_code: optional(text), source_asn: optional(number), source_asn_org: optional(text) })) })(value);
  if (path === '/api/v1/audit') return page(audit)(value);
  return false;
}
