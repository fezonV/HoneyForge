import {
  AuthSession,
  Profile,
  Trap,
  AttackEvent,
  AuditLogEntry,
  OverviewMetrics,
  User,
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
  field_errors?: Record<string, string[]>;
  isNetworkError: boolean;

  constructor(message: string, status: number = 500, code: string = 'INTERNAL_ERROR', field_errors?: Record<string, string[]>, isNetworkError: boolean = false) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
    this.field_errors = field_errors;
    this.isNetworkError = isNetworkError;
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

// CSRF helper
function getCsrfToken(): string | null {
  const match = document.cookie.match(/(?:^|; )csrf_token=([^;]*)/);
  if (match) return decodeURIComponent(match[1]);
  const meta = document.querySelector('meta[name="csrf-token"]');
  return meta ? meta.getAttribute('content') : null;
}

// Low-level fetch wrapper
async function request<T>(
  endpoint: string,
  options: RequestInit = {},
  timeoutMs: number = 10000
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');

  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes((options.method || 'GET').toUpperCase())) {
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
      credentials: 'include', // HttpOnly cookie handling
      signal: options.signal || controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.status === 204) {
      return {} as T;
    }

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      let message = `Ошибка сервера (${response.status})`;
      let code = 'HTTP_' + response.status;
      let field_errors: Record<string, string[]> | undefined;

      if (data && typeof data === 'object') {
        if (data.message) message = data.message;
        if (data.detail) message = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
        if (data.code) code = data.code;
        if (data.field_errors) field_errors = data.field_errors;
      }

      throw new ApiRequestError(message, response.status, code, field_errors);
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
    throw new ApiRequestError('Сетевой сбой при обращении к серверу управления', 0, 'NETWORK_ERROR', undefined, true);
  }
}

// In-memory local fixture store
let mockProfiles = [...FIXTURE_PROFILES];
let mockTraps = [...FIXTURE_TRAPS];
let mockEvents = [...FIXTURE_ATTACK_EVENTS];
let mockAudit = [...FIXTURE_AUDIT_LOGS];
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
      return request<AuthSession>('/api/auth/me');
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
          throw new ApiRequestError('Неверное имя пользователя или пароль оператора', 401, 'INVALID_CREDENTIALS');
        }
      }
      return request<AuthSession>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
    },

    async logout(): Promise<void> {
      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 150));
        mockCurrentUser = null;
        return;
      }
      await request<void>('/api/auth/logout', { method: 'POST' });
    },

    async switchDevRole(role: 'operator' | 'viewer'): Promise<User> {
      mockCurrentUser = role === 'operator' ? FIXTURE_OPERATOR : FIXTURE_VIEWER;
      return mockCurrentUser;
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
      return request<OverviewMetrics>('/api/overview/metrics');
    },
  },

  profiles: {
    async list(): Promise<Profile[]> {
      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 200));
        return [...mockProfiles];
      }
      return request<Profile[]>('/api/profiles');
    },

    async create(data: Omit<Profile, 'id' | 'created_at' | 'updated_at' | 'revision'>): Promise<Profile> {
      if (mockCurrentUser?.role === 'viewer') {
        throw new ApiRequestError('Действие запрещено: роль Viewer не может изменять профили', 403, 'PERMISSION_DENIED');
      }
      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 300));
        const newProf: Profile = {
          ...data,
          id: `prof-${Date.now().toString(36)}`,
          revision: 1,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          traps_count: 0,
        };
        mockProfiles.unshift(newProf);
        return newProf;
      }
      return request<Profile>('/api/profiles', {
        method: 'POST',
        body: JSON.stringify(data),
      });
    },

    async delete(id: string): Promise<void> {
      if (mockCurrentUser?.role === 'viewer') {
        throw new ApiRequestError('Действие запрещено: роль Viewer не может удалять профили', 403, 'PERMISSION_DENIED');
      }
      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 250));
        const prof = mockProfiles.find((p) => p.id === id);
        if (prof && (prof.traps_count || 0) > 0) {
          throw new ApiRequestError(`Невозможно удалить профиль: к нему привязано ловушек: ${prof.traps_count}`, 409, 'PROFILE_IN_USE');
        }
        mockProfiles = mockProfiles.filter((p) => p.id !== id);
        return;
      }
      return request<void>(`/api/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
  },

  traps: {
    async list(): Promise<Trap[]> {
      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 200));
        // Viewer should not receive enrollment tokens
        if (mockCurrentUser?.role === 'viewer') {
          return mockTraps.map(({ enrollment_token, ...rest }) => rest as Trap);
        }
        return [...mockTraps];
      }
      return request<Trap[]>('/api/traps');
    },

    async generateToken(trapId: string): Promise<{ token: string; expires_at: string }> {
      if (mockCurrentUser?.role === 'viewer') {
        throw new ApiRequestError('Действие запрещено: только роль Operator может генерировать токены', 403, 'PERMISSION_DENIED');
      }
      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 300));
        const token = `hf_enr_${Math.random().toString(36).substring(2, 10)}${Math.random().toString(36).substring(2, 10)}`;
        const trap = mockTraps.find((t) => t.id === trapId);
        if (trap) trap.enrollment_token = token;
        return { token, expires_at: new Date(Date.now() + 3600000).toISOString() };
      }
      return request<{ token: string; expires_at: string }>(`/api/traps/${encodeURIComponent(trapId)}/token`, {
        method: 'POST',
      });
    },

    async sendCommand(trapId: string, command: 'start' | 'stop' | 'apply_profile'): Promise<{ command_id: string; status: string }> {
      if (mockCurrentUser?.role === 'viewer') {
        throw new ApiRequestError('Действие запрещено: роль Viewer не может отправлять команды ловушкам', 403, 'PERMISSION_DENIED');
      }
      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 300));
        return { command_id: `cmd-${Date.now()}`, status: 'queued' };
      }
      return request<{ command_id: string; status: string }>(`/api/traps/${encodeURIComponent(trapId)}/commands`, {
        method: 'POST',
        body: JSON.stringify({ command }),
      });
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
      if (params.severity) query.set('severity', params.severity);
      return request<AttackEvent[]>(`/api/events?${query.toString()}`);
    },
  },

  audit: {
    async list(): Promise<AuditLogEntry[]> {
      if (isDevModeActive()) {
        await new Promise((r) => setTimeout(r, 200));
        return [...mockAudit];
      }
      return request<AuditLogEntry[]>('/api/audit');
    },
  },
};
