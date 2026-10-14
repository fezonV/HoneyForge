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
  TrapCommand,
  RegistrationAttempt,
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
let isDevFixturesEnabled = import.meta.env.DEV && localStorage.getItem(DEV_FIXTURES_KEY) === 'true';

export function isDevModeActive(): boolean {
  return isDevFixturesEnabled;
}

export function setDevModeActive(active: boolean) {
  isDevFixturesEnabled = import.meta.env.DEV && active;
  cachedCsrfToken = null;
  profileRevisionCache.clear();
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
  timeoutMs: number = 10000,
  responseType: 'json' | 'blob' = 'json'
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

    if (response.status === 204) {
      return {} as T;
    }

    if (response.ok && responseType === 'blob') {
      if (!response.headers.get('Content-Type')?.includes('application/zip')) {
        throw new ApiRequestError('Сервер вернул некорректный комплект запуска', 502, 'invalid_bundle');
      }
      return await response.blob() as T;
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
    if (error instanceof ApiRequestError) {
      throw error;
    }
    if (error.name === 'AbortError') {
      throw new ApiRequestError(`Превышено время ожидания ответа сервера (${timeoutMs / 1000} сек)`, 504, 'TIMEOUT', undefined, true);
    }
    throw new ApiRequestError('Нет связи с сервером управления', 0, 'NETWORK_ERROR', undefined, true);
  } finally {
    clearTimeout(timeoutId);
  }
}

// In-memory local fixture store for development & offline testing
let mockProfiles = [...FIXTURE_PROFILES];
const mockTraps = [...FIXTURE_TRAPS];
const mockEvents = [...FIXTURE_ATTACK_EVENTS];
const mockAudit = [...FIXTURE_AUDIT_LOGS];
let mockCurrentUser: User | null = FIXTURE_OPERATOR;
const profileRevisionCache = new Map<string, ProfileRevision>();

function mapTrap(t: any): Trap {
  const seen = t.last_seen || undefined;
  const agentStatus = t.agent_status === 'online' ? 'online' : 'offline';
  return {
    id: t.id, name: t.name,
    status: t.registration_status === 'rejected' ? 'registration_failed' : !seen && t.registration_status !== 'registered' ? 'unregistered' : agentStatus,
    deployment_node: t.deployment_node || '',
    registration_status: t.registration_status,
    agent_id: t.agent_id,
    last_registration_attempt: t.last_registration_attempt,
    level: 'low', // Enriched from the assigned profile by the screen.
    desired_profile_id: t.desired_profile_id,
    desired_revision: t.desired_revision,
    applied_profile_id: t.applied_profile_id,
    applied_revision: t.applied_revision,
    profile_id: t.desired_profile_id || undefined,
    profile_revision: t.desired_revision || undefined,
    ip_address: t.deployment_bindings?.[0]?.bind_address || '—',
    last_seen_at: seen,
    agent_status: agentStatus,
    service_status: t.service_status || 'unknown',
    telemetry: t.telemetry || undefined,
    attacks_count_24h: 0,
    deployment_bindings: t.deployment_bindings || [],
    created_at: t.created_at,
  };
}

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

      const now = new Date();
      const period = new URLSearchParams({ from: new Date(now.getTime() - 86400000).toISOString(), to: now.toISOString() });
      const [traps, profiles, summary] = await Promise.all([
        api.traps.list(), api.profiles.list(), request<{
          total_events: number; unique_sources: number;
          top_sources: Array<{ source_ip: string; count: number; source_country_name?: string }>;
        }>(`/api/v1/events/summary?${period}`),
      ]);
      const byId = new Map(profiles.map((profile) => [profile.id, profile]));
      return {
        total_traps: traps.length,
        traps_low: traps.filter((trap) => byId.get(trap.profile_id || '')?.level === 'low').length,
        traps_medium: traps.filter((trap) => byId.get(trap.profile_id || '')?.level === 'medium').length,
        traps_high: 0,
        online_traps: traps.filter((trap) => trap.agent_status === 'online').length,
        events_24h: summary.total_events,
        unique_attackers_24h: summary.unique_sources,
        top_attackers: summary.top_sources.map((source) => ({
          ip: source.source_ip, country: source.source_country_name || '—', events_count: source.count,
          share_percent: summary.total_events ? source.count / summary.total_events * 100 : 0,
        })),
      };
    },
  },

  profiles: {
    async rotateCredentials(id: string, baseRevision: number, name: string, description: string, config: ProfileConfig): Promise<ProfileRevision> {
      const result = await request<{ revision: ProfileRevision }>(`/api/v1/profiles/${encodeURIComponent(id)}`, {
        method: 'PATCH', body: JSON.stringify({ base_revision: baseRevision, name, description, config }),
      });
      return result.revision;
    },
    async revision(id: string, revision: number): Promise<ProfileRevision> {
      if (isDevModeActive()) {
        const items = await api.profiles.revisions(id);
        const found = items.find((item) => item.revision === revision);
        if (!found) throw new ApiRequestError('Версия профиля недоступна', 404, 'not_found');
        return found;
      }
      const key = `${id}:${revision}`;
      let result = profileRevisionCache.get(key);
      if (!result) {
        result = await request<ProfileRevision>(`/api/v1/profiles/${encodeURIComponent(id)}/revisions/${revision}`);
        profileRevisionCache.set(key, result);
      }
      return result;
    },
    async revisions(id: string): Promise<ProfileRevision[]> {
      if (isDevModeActive()) {
        const profile = mockProfiles.find((p) => p.id === id);
        return profile ? [{ profile_id: id, revision: profile.revision, config: profile.config || {
          template_id: profile.level === 'medium' ? 'medium-http' : 'low-http', level: profile.level,
          services: profile.services, visible_texts: { title: profile.name, login_prompt: '', success: '', failure: '' },
          synthetic_credentials: [], fake_fs: [], logging: { categories: [] },
          channel: { tls_required: true, heartbeat_seconds: 15, sync_seconds: 30 },
        }, created_at: profile.created_at, created_by: '', sensitive_redacted: true }] : [];
      }
      const revisions: ProfileRevision[] = [];
      let cursor = '';
      do {
        const params = new URLSearchParams({ limit: '100' });
        if (cursor) params.set('cursor', cursor);
        const page = await request<Page<ProfileRevision>>(`/api/v1/profiles/${encodeURIComponent(id)}/revisions?${params}`);
        revisions.push(...(page.items || []));
        cursor = page.next_cursor || '';
      } while (cursor);
      return revisions;
    },
    async list(): Promise<Profile[]> {
      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 200));
        return [...mockProfiles];
      }

      const items: any[] = [];
      let cursor = '';
      do {
        const params = new URLSearchParams({ limit: '100' });
        if (cursor) params.set('cursor', cursor);
        const page = await request<Page<any>>(`/api/v1/profiles?${params}`);
        items.push(...(page.items || []));
        cursor = page.next_cursor || '';
      } while (cursor);

      return Promise.all(items.map(async (p: any) => {
        const key = `${p.id}:${p.current_revision}`;
        let current = profileRevisionCache.get(key);
        if (!current) {
          current = await request<ProfileRevision>(`/api/v1/profiles/${encodeURIComponent(p.id)}/revisions/${p.current_revision}`);
          profileRevisionCache.set(key, current);
        }
        return {
        id: p.id,
        name: p.name,
        description: p.description || '',
        level: current.config.level as InteractionLevel,
        revision: p.current_revision || 1,
        services: current.config.services,
        masking: {
          jitter_enabled: true,
          min_jitter_sec: 2,
          max_jitter_sec: 8,
          decoy_path: '/static/bundle.js',
          hidden_service_name: 'systemd-timesyncd-worker',
        },
        config: current.config,
        created_at: p.created_at,
        updated_at: p.updated_at,
        traps_count: 0,
      };
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
          level: res.revision?.config?.level || 'low',
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
    async registrationAttempts(trapId: string): Promise<RegistrationAttempt[]> {
      if (isDevModeActive()) return [];
      const page = await request<Page<RegistrationAttempt>>(`/api/v1/traps/${encodeURIComponent(trapId)}/registration-attempts?limit=100`);
      return page.items || [];
    },
    async commands(trapId: string): Promise<TrapCommand[]> {
      if (isDevModeActive()) return [];
      const items: TrapCommand[] = [];
      let cursor = '';
      do {
        const params = new URLSearchParams({ limit: '100' });
        if (cursor) params.set('cursor', cursor);
        const page = await request<Page<TrapCommand>>(`/api/v1/traps/${encodeURIComponent(trapId)}/commands?${params}`);
        items.push(...(page.items || []));
        cursor = page.next_cursor || '';
      } while (cursor);
      return items.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
    },
    async downloadBundle(trapId: string): Promise<void> {
      if (isDevModeActive()) throw new ApiRequestError('Комплект доступен только через настоящий API', 409, 'demo_mode');
      const artifact = await request<Blob>(`/api/v1/traps/${encodeURIComponent(trapId)}/bundle`, {}, 30000, 'blob');
      const url = URL.createObjectURL(artifact);
      const link = document.createElement('a');
      link.href = url;
      link.download = `honeyforge-trap-${trapId}.zip`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    async list(): Promise<Trap[]> {
      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 200));
        return [...mockTraps];
      }

      const items: any[] = [];
      let cursor = '';
      do {
        const params = new URLSearchParams({ limit: '100' });
        if (cursor) params.set('cursor', cursor);
        const page = await request<Page<any>>(`/api/v1/traps?${params}`);
        items.push(...(page.items || []));
        cursor = page.next_cursor || '';
      } while (cursor);
      return items.map(mapTrap);
    },

    async create(data: { name: string; deployment_node?: string; deployment_bindings?: DeploymentBinding[] }): Promise<Trap> {
      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 250));
        const newTrap: Trap = {
          id: `c3d4e5f6-a1b2-4c3d-ae4f-${Date.now().toString(16).padStart(12, '0')}`.slice(0, 36),
          name: data.name,
          deployment_node: data.deployment_node,
          registration_status: 'pending',
          status: 'unregistered',
          level: 'low',
          profile_name: 'Не назначен',
          ip_address: data.deployment_bindings?.[0]?.bind_address || '127.0.0.1',
          location: 'DMZ Core',
          agent_status: 'offline',
          service_status: 'unknown',
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
          deployment_node: data.deployment_node || '',
          deployment_bindings: data.deployment_bindings || [],
        }),
      });

      return mapTrap(res);
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
          trap.desired_profile_id = profileId;
          trap.desired_revision = revision;
          trap.level = profile?.level || 'low';
        }
        return trap!;
      }

      const res = await request<any>(`/api/v1/traps/${encodeURIComponent(trapId)}/profile`, {
        method: 'PUT',
        body: JSON.stringify({ profile_id: profileId, revision }),
      });

      return mapTrap(res);
    },

    async generateToken(trapId: string): Promise<{ token: string; expires_in_seconds: number }> {
      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 300));
        const token = `hf_enr_${Math.random().toString(36).substring(2, 10)}${Math.random().toString(36).substring(2, 10)}`;
        return {
          token,
          expires_in_seconds: 600,
        };
      }

      const res = await request<{ token: string; expires_in_seconds: number }>(
        `/api/v1/traps/${encodeURIComponent(trapId)}/enrollment-token`,
        { method: 'POST' }
      );

      return res;
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

      const query = new URLSearchParams();
      if (params.limit) query.set('limit', String(params.limit));
      if (params.trap_id) query.set('trap_id', params.trap_id);
      const [page, traps, profiles] = await Promise.all([
        request<Page<{ event_id: string; timestamp: string; trap_id: string; profile_id?: string; event_type: AttackEvent['event_type']; source_ip?: string; source_port?: number; destination_port?: number; protocol: string; payload?: AttackEvent['payload'] }>>(`/api/v1/events?${query}`),
        api.traps.list(), api.profiles.list(),
      ]);
      const byTrap = new Map(traps.map((trap) => [trap.id, trap]));
      const byProfile = new Map(profiles.map((profile) => [profile.id, profile]));
      const items: AttackEvent[] = (page.items || []).map((event) => ({
        id: event.event_id, occurred_at: event.timestamp, trap_id: event.trap_id,
        trap_name: byTrap.get(event.trap_id)?.name || event.trap_id,
        level: byProfile.get(event.profile_id || '')?.level || 'low',
        event_type: event.event_type, source_ip: event.source_ip || '—', source_port: event.source_port,
        destination_port: event.destination_port || 0, protocol: event.protocol,
        payload: event.payload || {}, severity: 'info',
      }));
      return params.severity ? items.filter((event) => event.severity === params.severity) : items;
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
