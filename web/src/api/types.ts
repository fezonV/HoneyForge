export type UserRole = 'operator' | 'viewer';

export interface User {
  id: string;
  username: string;
  role: UserRole;
  display_name?: string;
}

export interface AuthSession {
  authenticated: boolean;
  user: User | null;
  csrf_token?: string;
  expires_in?: number;
}

export type InteractionLevel = 'low' | 'medium' | 'high';
export type TrapStatus = 'online' | 'offline' | 'last_seen' | 'unregistered' | 'registration_failed' | 'degraded';

export interface ServiceConfig {
  id?: string;
  name: string;
  port: number;
  protocol: string;
  banner?: string;
}

export interface MaskingConfig {
  jitter_enabled: boolean;
  min_jitter_sec: number;
  max_jitter_sec: number;
  decoy_path: string;
  hidden_service_name: string;
}

export interface Template {
  id: string;
  name: string;
  level: string;
  description: string;
  capabilities: string[];
}

export interface SyntheticCredential {
  username: string;
  password?: string;
}

export interface FakeFile {
  path: string;
  content: string;
}

export interface VisibleTexts {
  title: string;
  login_prompt: string;
  success: string;
  failure: string;
}

export interface LoggingConfig {
  categories: string[];
}

export interface ChannelConfig {
  tls_required: boolean;
  heartbeat_seconds: number;
  sync_seconds: number;
}

export interface ProfileConfig {
  template_id: string;
  level: string;
  services: ServiceConfig[];
  visible_texts: VisibleTexts;
  synthetic_credentials: SyntheticCredential[];
  fake_fs: FakeFile[];
  logging: LoggingConfig;
  channel: ChannelConfig;
}

export interface ProfileRevision {
  profile_id: string;
  revision: number;
  config: ProfileConfig;
  created_at: string;
  created_by: string;
  sensitive_redacted: boolean;
}

export interface Profile {
  id: string;
  name: string;
  description: string;
  level: InteractionLevel;
  revision: number;
  services: ServiceConfig[];
  masking: MaskingConfig;
  config?: ProfileConfig;
  created_at: string;
  updated_at: string;
  traps_count?: number;
}

export interface CreateProfileRequest {
  name: string;
  description: string;
  config: ProfileConfig;
}


export interface DeploymentBinding {
  service_id: string;
  host_port: number;
  bind_address?: string;
}

export interface RegistrationAttempt {
  id: string;
  trap_id: string;
  outcome: 'registered' | 'rejected';
  reason: 'registered' | 'invalid_token' | 'expired_token' | 'inactive_token' | 'already_enrolled';
  created_at: string;
}

export interface Trap {
  deployment_node?: string;
  registration_status?: 'pending' | 'rejected' | 'registered';
  agent_id?: string;
  last_registration_attempt?: RegistrationAttempt;
  id: string;
  name: string;
  status: TrapStatus;
  level: InteractionLevel;
  profile_id?: string;
  profile_name?: string;
  profile_revision?: number;
  applied_revision?: number;
  ip_address: string;
  location?: string;
  last_seen_at?: string;
  agent_status?: string;
  service_status?: string;
  telemetry?: AgentTelemetry;
  desired_profile_id?: string | null;
  desired_revision?: number | null;
  applied_profile_id?: string | null;
  created_at?: string;
  attacks_count_24h: number;
  deployment_bindings?: DeploymentBinding[];
}

export interface AgentTelemetry {
  queue_depth: number;
  queue_limit: number;
  quarantined: number;
  quarantine_reason?: string;
  sent_events: number;
  delivery_errors: number;
  delivery_retries: number;
  storage_errors: number;
  storage_error?: string;
  delivery_error?: string;
  degraded: boolean;
}

export interface TrapCommand {
  id: string;
  trap_id: string;
  type: 'start' | 'stop' | 'apply_profile';
  target_profile_id?: string | null;
  target_revision?: number | null;
  status: 'queued' | 'delivered' | 'applied' | 'failed' | 'expired';
  error?: string;
  created_at: string;
  expires_at: string;
}

export type EventType =
  | 'connection.opened'
  | 'http.request'
  | 'auth.attempt'
  | 'session.started'
  | 'file.read'
  | 'command.exec'
  | 'port.scan';

export interface AttackPayload {
  path?: string;
  method?: string;
  username?: string;
  password?: string;
  command?: string;
  query?: string;
  user_agent?: string;
  raw?: string;
}

export interface AttackEvent {
  id: string;
  occurred_at: string;
  trap_id: string;
  trap_name: string;
  level: InteractionLevel;
  event_type: EventType;
  source_ip: string;
  source_port?: number;
  destination_port: number;
  protocol: string;
  payload: AttackPayload;
  ioc_flags?: string[];
  severity: 'info' | 'warning' | 'critical';
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  operator_name: string;
  operator_role: UserRole;
  action: string;
  resource_type: string;
  resource_id: string;
  details: string;
  status: 'success' | 'failed';
}

export interface OverviewMetrics {
  total_traps: number;
  traps_low: number;
  traps_medium: number;
  traps_high: number;
  online_traps: number;
  events_24h: number;
  events_delta_percent?: number;
  unique_attackers_24h: number;
  top_attackers: Array<{
    ip: string;
    country: string;
    events_count: number;
    share_percent: number;
  }>;
}

// Contract-level Page container matching Go contracts.Page[T]
export interface Page<T> {
  items: T[];
  next_cursor?: string;
}

// Backend API error detail matching Go contracts.APIError
export interface ApiErrorDetail {
  code: string;
  message: string;
  request_id: string;
  fields?: Record<string, string>;
}

export interface BackendApiErrorResponse {
  error: ApiErrorDetail;
}
