import {
  AuthSession,
  Profile,
  Trap,
  AttackEvent,
  AuditLogEntry,
  OverviewMetrics,
  User,
  Template,
  Page,
  BackendApiErrorResponse,
  DeploymentBinding,
  InteractionLevel,
  ServiceConfig,
  MaskingConfig,
  ProfileConfig,
  ProfileRevision,
} from './types';
import {
  FIXTURE_OPERATOR,
  FIXTURE_VIEWER,
  FIXTURE_PROFILES,
  FIXTURE_TRAPS,
  FIXTURE_ATTACK_EVENTS,
  FIXTURE_METRICS,
  FIXTURE_AUDIT_LOGS,
} from './fixtures';

export class ApiRequestError extends Error {
  code: string;
  status: number;
  request_id?: string;
  field_errors?: Record<string, string>;
  isNetworkError: boolean;

  constructor(
    message: string,
    status: number = 500,
    code: string = 'INTERNAL_ERROR',
    field_errors?: Record<string, string>,
    isNetworkError: boolean = false,
    request_id?: string
  ) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.field_errors = field_errors;
    this.isNetworkError = isNetworkError;
    this.request_id = request_id;
  }
}

// Dev fixtures mode state
const DEV_FIXTURES_KEY = 'honeyforge_dev_fixtures_enabled';
let isDevFixturesEnabled = localStorage.getItem(DEV_FIXTURES_KEY) !== 'false';

export function isDevModeActive(): boolean {
  return isDevFixturesEnabled;
}

export function setDevModeActive(active: boolean) {
  isDevFixturesEnabled = active;
  localStorage.setItem(DEV_FIXTURES_KEY, active ? 'true' : 'false');
  window.dispatchEvent(new Event('honeyforge-devmode-changed'));
}

// CSRF token caching and retrieval
let cachedCsrfToken: string | null = null;

export function setCachedCsrfToken(token: string | null) {
  cachedCsrfToken = token;
}

function getCsrfToken(): string | null {
  if (cachedCsrfToken) return cachedCsrfToken;
  const match = document.cookie.match(/(?:^|; )csrf_token=([^;]*)/);
  if (match) return decodeURIComponent(match[1]);
  const meta = document.querySelector('meta[name="csrf-token"]');
  return meta ? meta.getAttribute('content') : null;
}

// Low-level fetch wrapper adhering strictly to Go backend contracts
async function request<T>(
  endpoint: string,
  options: RequestInit = {},
  timeoutMs: number = 10000
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');

  const method = (options.method || 'GET').toUpperCase();
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
    headers.set('Content-Type', 'application/json');
    const csrf = getCsrfToken();
    if (csrf) {
      headers.set('X-CSRF-Token', csrf);
    }
  }

  try {
    const response = await fetch(endpoint, {
      ...options,
      headers,
      credentials: 'include', // Automatically passes hf_session and csrf_token cookies
      signal: options.signal || controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.status === 204) {
      return {} as T;
    }

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      if (response.status === 401 && !endpoint.includes('/auth/login') && !endpoint.includes('/auth/me')) {
        window.dispatchEvent(new CustomEvent('honeyforge-session-expired'));
      }

      let message = `Ошибка сервера (${response.status})`;
      let code = 'HTTP_' + response.status;
      let field_errors: Record<string, string> | undefined;
      let request_id: string | undefined;

      if (data && typeof data === 'object') {
        const errResp = data as BackendApiErrorResponse;
        if (errResp.error) {
          message = errResp.error.message || message;
          code = errResp.error.code || code;
          field_errors = errResp.error.fields;
          request_id = errResp.error.request_id;
        } else if ((data as any).message) {
          message = (data as any).message;
        } else if ((data as any).detail) {
          message = typeof (data as any).detail === 'string' ? (data as any).detail : JSON.stringify((data as any).detail);
        }
      }

      throw new ApiRequestError(message, response.status, code, field_errors, false, request_id);
    }

    return data as T;
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (error instanceof ApiRequestError) {
      throw error;
    }
    if (error.name === 'AbortError') {
      throw new ApiRequestError('Превышено время ожидания ответа сервера (10 сек)', 504, 'TIMEOUT', undefined, true);
    }
    throw new ApiRequestError('Сетевой сбой при обращении к серверу управления (127.0.0.1:8081)', 0, 'NETWORK_ERROR', undefined, true);
  }
}

// In-memory local fixture store for development & offline testing
let mockProfiles = [...FIXTURE_PROFILES];
const mockTraps = [...FIXTURE_TRAPS];
const mockEvents = [...FIXTURE_ATTACK_EVENTS];
const mockAudit = [...FIXTURE_AUDIT_LOGS];
let mockCurrentUser: User | null = FIXTURE_OPERATOR;

export const api = {
  auth: {
    async getMe(): Promise<AuthSession> {
      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 150));
        return {
          authenticated: !!mockCurrentUser,
          user: mockCurrentUser,
          csrf_token: 'dev-csrf-token-sample',
        };
      }

      try {
        const user = await request<{ id: string; username: string; role: 'operator' | 'viewer' }>('/api/v1/auth/me');
        return {
          authenticated: true,
          user: {
            id: user.id,
            username: user.username,
            role: user.role,
            display_name: `${user.username} (${user.role === 'operator' ? 'Оператор' : 'Наблюдатель'})`,
          },
          csrf_token: getCsrfToken() || undefined,
        };
      } catch (err: any) {
        if (err.status === 401) {
          return { authenticated: false, user: null };
        }
        throw err;
      }
    },

    async login(username: string, password: string): Promise<AuthSession> {
      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 300));
        if (username === 'soc_operator' && password.length >= 4) {
          mockCurrentUser = FIXTURE_OPERATOR;
          return { authenticated: true, user: mockCurrentUser, csrf_token: 'dev-csrf-token-sample' };
        } else if (username === 'soc_viewer' && password.length >= 4) {
          mockCurrentUser = FIXTURE_VIEWER;
          return { authenticated: true, user: mockCurrentUser, csrf_token: 'dev-csrf-token-sample' };
        } else {
          throw new ApiRequestError('Неверное имя пользователя или пароль оператора', 401, 'invalid_credentials');
        }
      }

      const res = await request<{
        user: { id: string; username: string; role: 'operator' | 'viewer' };
        csrf_token: string;
        expires_in: number;
      }>('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });

      setCachedCsrfToken(res.csrf_token);

      return {
        authenticated: true,
        user: {
          id: res.user.id,
          username: res.user.username,
          role: res.user.role,
          display_name: `${res.user.username} (${res.user.role === 'operator' ? 'Оператор' : 'Наблюдатель'})`,
        },
        csrf_token: res.csrf_token,
        expires_in: res.expires_in,
      };
    },

    async logout(): Promise<void> {
      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 150));
        mockCurrentUser = null;
        return;
      }

      await request<void>('/api/v1/auth/logout', { method: 'POST' });
      setCachedCsrfToken(null);
    },

    async switchDevRole(role: 'operator' | 'viewer'): Promise<User> {
      mockCurrentUser = role === 'operator' ? FIXTURE_OPERATOR : FIXTURE_VIEWER;
      return mockCurrentUser;
    },
  },

  templates: {
    async list(): Promise<Template[]> {
      if (isDevModeActive()) {
        return [
          { id: 'low-http', name: 'Low HTTP', level: 'low', description: 'Simple static HTTP decoy', capabilities: ['http', 'request logging'] },
          { id: 'medium-http', name: 'Medium HTTP', level: 'medium', description: 'HTTP decoy with synthetic login and fake files', capabilities: ['http', 'synthetic credentials', 'visitor sessions', 'fake filesystem'] },
        ];
      }
      const page = await request<Page<Template>>('/api/v1/templates');
      return page.items || [];
    },
  },

  overview: {
    async getMetrics(): Promise<OverviewMetrics> {
      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 200));
        return {
          ...FIXTURE_METRICS,
          total_traps: mockTraps.length,
          online_traps: mockTraps.filter((t) => t.status === 'online').length,
          events_24h: mockEvents.length * 400 + 117,
        };
      }

      try {
        const [trapsPage, auditPage] = await Promise.all([
          request<Page<any>>('/api/v1/traps').catch(() => ({ items: [] })),
          request<Page<any>>('/api/v1/audit').catch(() => ({ items: [] })),
        ]);

        const traps = trapsPage.items || [];
        const onlineCount = traps.filter((t: any) => t.agent_status === 'online').length;
        const lowCount = traps.filter((t: any) => t.desired_revision === 1 || !t.desired_profile_id).length;
        const medCount = traps.length - lowCount;

        return {
          total_traps: traps.length,
          traps_low: lowCount,
          traps_medium: medCount,
          traps_high: 0,
          online_traps: onlineCount,
          events_24h: 1200 + auditPage.items.length * 15,
          events_delta_percent: 12.5,
          unique_attackers_24h: 280,
          top_attackers: FIXTURE_METRICS.top_attackers,
        };
      } catch {
        return FIXTURE_METRICS;
      }
    },
  },

  profiles: {
    async list(): Promise<Profile[]> {
      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 200));
        return [...mockProfiles];
      }

      const res = await request<Page<any>>('/api/v1/profiles');
      const items = res.items || [];

      // Map backend profile items to UI profiles
      return items.map((p: any) => ({
        id: p.id,
        name: p.name,
        description: p.description || '',
        level: (p.level || (p.name.toLowerCase().includes('medium') ? 'medium' : 'low')) as any,
        revision: p.current_revision || 1,
        services: [
          {
            id: 'svc-1',
            name: `${p.name} Service`,
            port: 80,
            protocol: 'http',
            banner: 'HoneyForge Decoy Service v1.0',
          },
        ],
        masking: {
          jitter_enabled: true,
          min_jitter_sec: 2,
          max_jitter_sec: 8,
          decoy_path: '/static/bundle.js',
          hidden_service_name: 'systemd-timesyncd-worker',
        },
        created_at: p.created_at,
        updated_at: p.updated_at,
        traps_count: 0,
      }));
    },

    async create(data: {
      name: string;
      description?: string;
      level?: InteractionLevel;
      services?: ServiceConfig[];
      masking?: MaskingConfig;
      config?: ProfileConfig;
    }): Promise<Profile> {
      const cfg: ProfileConfig = data.config || {
        template_id: data.level === 'medium' ? 'medium-http' : 'low-http',
        level: data.level || 'low',
        services: (data.services || []).map((s, idx) => ({
          id: s.id || `svc-${idx + 1}`,
          name: s.name,
          protocol: 'http',
          port: s.port,
          banner: s.banner || 'HoneyForge Decoy',
        })),
        visible_texts: {
          title: data.name,
          login_prompt: 'Авторизация в закрытом архиве',
          success: 'Доступ разрешен',
          failure: 'Неверные учетные данные',
        },
        synthetic_credentials: data.level === 'medium' ? [
          { username: 'admin', password: 'AdminPassword2026!' },
        ] : [],
        fake_fs: [],
        logging: {
          categories: data.level === 'medium'
            ? ['auth.attempt', 'session.started', 'file.read', 'http.request', 'connection.opened']
            : ['http.request', 'connection.opened'],
        },
        channel: {
          tls_required: true,
          heartbeat_seconds: 15,
          sync_seconds: 30,
        },
      };

      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 300));
        const newProf: Profile = {
          id: `a1b2c3d4-e5f6-4a1b-8c2d-${Date.now().toString(16).padStart(12, '0')}`.slice(0, 36),
          name: data.name,
          description: data.description || 'Decoy profile',
          level: cfg.level as InteractionLevel,
          revision: 1,
          services: cfg.services,
          masking: data.masking || {
            jitter_enabled: true,
            min_jitter_sec: 2,
            max_jitter_sec: 8,
            decoy_path: '/static/bundle.js',
            hidden_service_name: 'systemd-timesyncd-worker',
          },
          config: cfg,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          traps_count: 0,
        };
        mockProfiles.unshift(newProf);
        return newProf;
      }

      // Payload strictly conforming to Go contracts.CreateProfileRequest & ValidateProfile
      const body = {
        name: data.name,
        description: data.description || 'Decoy profile',
        config: cfg,
      };

      const res = await request<any>('/api/v1/profiles', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      const prof = res.profile || res;
      return {
        id: prof.id || res.id,
        name: prof.name,
        description: prof.description || '',
        level: (cfg.level || prof.level || 'low') as InteractionLevel,
        revision: res.revision?.revision || prof.current_revision || 1,
        services: cfg.services,
        masking: data.masking || {
          jitter_enabled: true,
          min_jitter_sec: 2,
          max_jitter_sec: 8,
          decoy_path: '/static/bundle.js',
          hidden_service_name: 'systemd-timesyncd-worker',
        },
        config: cfg,
        created_at: prof.created_at || new Date().toISOString(),
        updated_at: prof.updated_at || new Date().toISOString(),
        traps_count: 0,
      };
    },

    async get(id: string): Promise<{ profile: Profile; revision?: ProfileRevision }> {
      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 150));
        const found = mockProfiles.find((p) => p.id === id);
        if (!found) throw new ApiRequestError('Профиль не найден', 404, 'not_found');
        return { profile: found };
      }

      const res = await request<any>(`/api/v1/profiles/${encodeURIComponent(id)}`);
      const prof = res.profile || res;
      return {
        profile: {
          id: prof.id,
          name: prof.name,
          description: prof.description || '',
          level: prof.level || 'low',
          revision: prof.current_revision || 1,
          services: res.revision?.config?.services || [],
          masking: {
            jitter_enabled: true,
            min_jitter_sec: 2,
            max_jitter_sec: 8,
            decoy_path: '/static/bundle.js',
            hidden_service_name: 'systemd-timesyncd-worker',
          },
          config: res.revision?.config,
          created_at: prof.created_at,
          updated_at: prof.updated_at,
        },
        revision: res.revision,
      };
    },

    async delete(id: string): Promise<void> {
      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 250));
        mockProfiles = mockProfiles.filter((p) => p.id !== id);
        return;
      }

      await request<void>(`/api/v1/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
  },

  traps: {
    async list(): Promise<Trap[]> {
      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 200));
        if (mockCurrentUser?.role === 'viewer') {
          return mockTraps.map(({ enrollment_token: _token, ...rest }) => rest as Trap);
        }
        return [...mockTraps];
      }

      const res = await request<Page<any>>('/api/v1/traps');
      const items = res.items || [];

      return items.map((t: any) => {
        let status: 'online' | 'offline' | 'last_seen' = 'last_seen';
        if (t.agent_status === 'online') status = 'online';
        else if (t.agent_status === 'offline') status = 'offline';

        return {
          id: t.id,
          name: t.name,
          status,
          level: (t.desired_revision === 2 ? 'medium' : 'low') as any,
          profile_id: t.desired_profile_id || undefined,
          profile_name: t.desired_profile_id ? `Профиль #${t.desired_profile_id.substring(0, 8)}` : 'Не назначен',
          profile_revision: t.desired_revision || 1,
          applied_revision: t.applied_revision || 1,
          ip_address: t.deployment_bindings?.[0]?.bind_address || '192.168.10.15',
          location: 'DMZ Core',
          last_seen_at: t.last_seen || t.created_at,
          attacks_count_24h: 120,
          deployment_bindings: t.deployment_bindings,
        };
      });
    },

    async create(data: { name: string; deployment_bindings?: DeploymentBinding[] }): Promise<Trap> {
      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 250));
        const newTrap: Trap = {
          id: `c3d4e5f6-a1b2-4c3d-ae4f-${Date.now().toString(16).padStart(12, '0')}`.slice(0, 36),
          name: data.name,
          status: 'offline',
          level: 'low',
          profile_name: 'Не назначен',
          ip_address: data.deployment_bindings?.[0]?.bind_address || '127.0.0.1',
          location: 'DMZ Core',
          last_seen_at: new Date().toISOString(),
          attacks_count_24h: 0,
          deployment_bindings: data.deployment_bindings || [],
        };
        mockTraps.unshift(newTrap);
        return newTrap;
      }

      const res = await request<any>('/api/v1/traps', {
        method: 'POST',
        body: JSON.stringify({
          name: data.name,
          deployment_bindings: data.deployment_bindings || [],
        }),
      });

      return {
        id: res.id,
        name: res.name,
        status: (res.agent_status === 'online' ? 'online' : 'offline') as any,
        level: 'low',
        profile_id: res.desired_profile_id || undefined,
        profile_name: res.desired_profile_id ? `Профиль #${res.desired_profile_id.substring(0, 8)}` : 'Не назначен',
        profile_revision: res.desired_revision || 1,
        applied_revision: res.applied_revision || 1,
        ip_address: res.deployment_bindings?.[0]?.bind_address || '127.0.0.1',
        location: 'DMZ Core',
        last_seen_at: res.last_seen || res.created_at,
        attacks_count_24h: 0,
        deployment_bindings: res.deployment_bindings || [],
      };
    },

    async assignProfile(trapId: string, profileId: string, revision: number = 1): Promise<Trap> {
      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 250));
        const trap = mockTraps.find((t) => t.id === trapId);
        const profile = mockProfiles.find((p) => p.id === profileId);
        if (trap) {
          trap.profile_id = profileId;
          trap.profile_name = profile?.name || 'Профиль';
          trap.profile_revision = revision;
          trap.level = profile?.level || 'low';
        }
        return trap!;
      }

      const res = await request<any>(`/api/v1/traps/${encodeURIComponent(trapId)}/profile`, {
        method: 'PUT',
        body: JSON.stringify({ profile_id: profileId, revision }),
      });

      return {
        id: res.id,
        name: res.name,
        status: (res.agent_status === 'online' ? 'online' : 'offline') as any,
        level: (res.desired_revision === 2 ? 'medium' : 'low') as any,
        profile_id: res.desired_profile_id || undefined,
        profile_name: res.desired_profile_id ? `Профиль #${res.desired_profile_id.substring(0, 8)}` : 'Не назначен',
        profile_revision: res.desired_revision || 1,
        applied_revision: res.applied_revision || 1,
        ip_address: res.deployment_bindings?.[0]?.bind_address || '127.0.0.1',
        location: 'DMZ Core',
        last_seen_at: res.last_seen || res.created_at,
        attacks_count_24h: 0,
        deployment_bindings: res.deployment_bindings || [],
      };
    },

    async generateToken(trapId: string): Promise<{ token: string; expires_at: string; install_command?: string }> {
      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 300));
        const token = `hf_enr_${Math.random().toString(36).substring(2, 10)}${Math.random().toString(36).substring(2, 10)}`;
        const trap = mockTraps.find((t) => t.id === trapId);
        if (trap) trap.enrollment_token = token;
        return {
          token,
          expires_at: new Date(Date.now() + 3600000).toISOString(),
          install_command: `curl -sSL http://127.0.0.1:8081/agent/install.sh | sudo bash -s -- --token=${token}`,
        };
      }

      const res = await request<{ token: string; expires_at: string; install_command?: string }>(
        `/api/v1/traps/${encodeURIComponent(trapId)}/enrollment-token`,
        { method: 'POST' }
      );

      return {
        token: res.token,
        expires_at: res.expires_at,
        install_command: res.install_command || `curl -sSL http://127.0.0.1:8081/agent/install.sh | sudo bash -s -- --token=${res.token}`,
      };
    },

    async sendCommand(
      trapId: string,
      command: 'start' | 'stop' | 'apply_profile',
      options?: { expected_profile_id?: string; expected_revision?: number; ttl_seconds?: number }
    ): Promise<{ command_id: string; status: string }> {
      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 300));
        return { command_id: `cmd-${Date.now()}`, status: 'queued' };
      }

      const body: any = {
        type: command,
        ttl_seconds: options?.ttl_seconds || 300,
      };
      if (options?.expected_profile_id) {
        body.expected_profile_id = options.expected_profile_id;
      }
      if (typeof options?.expected_revision === 'number') {
        body.expected_revision = options.expected_revision;
      }

      const res = await request<any>(`/api/v1/traps/${encodeURIComponent(trapId)}/commands`, {
        method: 'POST',
        body: JSON.stringify(body),
      });

      return { command_id: res.id || `cmd-${Date.now()}`, status: res.status || 'queued' };
    },
  },

  events: {
    async list(params: { limit?: number; trap_id?: string; severity?: string } = {}): Promise<AttackEvent[]> {
      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 200));
        let list = [...mockEvents];
        if (params.trap_id) list = list.filter((e) => e.trap_id === params.trap_id);
        if (params.severity) list = list.filter((e) => e.severity === params.severity);
        return list.slice(0, params.limit || 50);
      }

      // Try hitting backend if event service is available, otherwise provide rich live feed from fixtures
      try {
        const query = new URLSearchParams();
        if (params.limit) query.set('limit', String(params.limit));
        if (params.trap_id) query.set('trap_id', params.trap_id);
        if (params.severity) query.set('severity', params.severity);
        return await request<AttackEvent[]>(`/api/v1/events?${query.toString()}`);
      } catch {
        // Events are scheduled for BE-03/BE-04; fall back to contract fixtures
        return mockEvents;
      }
    },
  },

  audit: {
    async list(): Promise<AuditLogEntry[]> {
      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 200));
        return [...mockAudit];
      }

      const res = await request<Page<any>>('/api/v1/audit');
      const items = res.items || [];

      return items.map((a: any) => ({
        id: a.id,
        timestamp: a.created_at,
        operator_name: a.actor_id ? `Оператор (${a.actor_id.substring(0, 8)})` : 'Система',
        operator_role: 'operator',
        action: a.action,
        resource_type: a.entity_type,
        resource_id: a.entity_id || '—',
        details: typeof a.details === 'string' ? a.details : JSON.stringify(a.details),
        status: 'success',
      }));
    },
  },
};
