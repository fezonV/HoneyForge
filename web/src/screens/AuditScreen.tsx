import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, isDevModeActive } from '../api/client';
import { AuditFilters, StoredAuditEntry, TrapCommand } from '../api/types';
import { useAuth } from '../context/AuthContext';
import { Button } from '../components/common/Button';
import { dateInputUTC, isoUTC, queryInputClass, useHashQuery, useResource } from '../components/common/queryState';

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
const committed = new Set(['profile.created', 'profile.revision_created', 'profile.deleted', 'profile.sensitive_read', 'trap.created', 'trap.profile_assigned', 'trap.profile_detached', 'trap.deleted', 'trap.bundle_downloaded', 'agent.enrollment_issued', 'agent.enrolled', 'agent.config_read', 'auth.login', 'auth.logout', 'event.sensitive_read']);
const safeKeys = new Set(['revision', 'profile_id', 'trap_id', 'agent_id', 'type', 'expected_revision', 'ttl_seconds', 'reason', 'outcome', 'expires_in_seconds', 'source_revision']);
function result(entry: StoredAuditEntry) {
  if (entry.action === 'command.queued') return 'queued — поставлена в очередь';
  if (entry.action === 'auth.login_failed' || entry.action === 'agent.enrollment_rejected') return 'Отказ';
  return committed.has(entry.action) ? 'Операция зафиксирована' : 'Результат не указан сервером';
}
function objectLink(entry: StoredAuditEntry): string | null {
  if (entry.entity_type === 'trap' && uuid(entry.entity_id)) return `#traps/${entry.entity_id}`;
  if (entry.entity_type === 'profile' && uuid(entry.entity_id)) return `#profiles?profile_id=${entry.entity_id}`;
  if (entry.entity_type === 'command' && uuid(entry.details.trap_id)) return `#traps/${entry.details.trap_id}`;
  if (entry.entity_type === 'event') {
    const [trap, event] = (entry.entity_id || '').split('/');
    if (uuid(trap) && uuid(event)) return `#events?event_trap=${trap}&event_id=${event}`;
  }
  return null;
}
function CommandResult({ entry }: { entry: StoredAuditEntry }) {
  const [command, setCommand] = useState<TrapCommand>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const read = async () => {
    if (controller.current || !uuid(entry.details.trap_id)) return;
    const request = new AbortController(); controller.current = request; setBusy(true); setError('');
    try {
      const commands = await api.traps.commands(entry.details.trap_id, request.signal);
      if (!request.signal.aborted) {
        const found = commands.find((item) => item.id === entry.entity_id);
        if (!found) throw new Error('Команда отсутствует в доступной истории');
        setCommand(found);
      }
    } catch (cause) { if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : 'Ошибка чтения команды'); }
    finally { if (!request.signal.aborted) setBusy(false); if (controller.current === request) controller.current = null; }
  };
  return <div className="space-y-2 mt-2"><Button size="sm" variant="outline" isLoading={busy} onClick={read}>Проверить результат команды</Button>
    {command && <p>Текущее состояние: {command.status}{command.error ? ` — ${command.error}` : ''}. Снимок результата обновляется этой кнопкой.</p>}
    {error && <p role="alert" className="text-rose-700">{error}{command ? ' Предыдущий результат устарел.' : ''}</p>}
  </div>;
}

export function AuditScreen() {
  const { role, user } = useAuth();
  if (role !== 'operator') return <div className="max-w-7xl mx-auto p-8"><h1 className="text-2xl font-bold">Журнал аудита действий</h1><p role="alert">Аудит доступен только оператору.</p></div>;
  return <AuditPage key={`${user?.id}:${role}`} />;
}
function AuditPage() {
  const search = useHashQuery();
  const filters = useMemo(() => {
    const params = new URLSearchParams(search);
    return Object.fromEntries(['action', 'actor_id', 'from', 'to', 'cursor'].map((key) => [key, params.get(key) || undefined])) as AuditFilters;
  }, [search]);
  const [draft, setDraft] = useState(filters);
  const [error, setError] = useState(''), [epoch, setEpoch] = useState(0);
  useEffect(() => { setDraft(filters); setError(''); }, [filters]);
  const load = useCallback((signal: AbortSignal) => api.audit.page({ ...filters, limit: 50 }, signal), [filters]);
  const state = useResource(search, epoch, load);
  const apply = (event: FormEvent) => {
    event.preventDefault();
    if (draft.from && draft.to && Date.parse(draft.from) > Date.parse(draft.to)) { setError('Начало периода позже окончания.'); return; }
    const query = new URLSearchParams();
    for (const key of ['action', 'actor_id', 'from', 'to'] as const) if (draft[key]?.trim()) query.set(key, draft[key]!.trim());
    window.location.hash = `audit?${query}`;
    if (query.toString() === search) setEpoch((value) => value + 1);
  };
  const cursor = (value?: string) => { const query = new URLSearchParams(search); if (value) query.set('cursor', value); else query.delete('cursor'); window.location.hash = `audit?${query}`; };
  return <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-5">
    <div className="flex flex-wrap justify-between gap-3"><h1 className="text-2xl font-bold">Журнал аудита действий</h1><Button size="sm" variant="outline" disabled={state.loading} onClick={() => setEpoch((value) => value + 1)}>Обновить аудит</Button></div>
    <p className="text-sm">Время — UTC. Оператор указан по actor_id; серверные действия без actor_id показаны отдельно. Назначение профиля не означает его применение. Запись queued не подтверждает исполнение.</p>
    {isDevModeActive() && <p role="alert">Аудит запрашивается у настоящего API. Для приёмки войдите в режиме API.</p>}
    <form aria-label="Фильтры аудита" onSubmit={apply} className="bg-white border rounded-xl p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <label className="text-xs">Действие<input className={queryInputClass} value={draft.action || ''} onChange={(e) => setDraft({ ...draft, action: e.target.value })} placeholder="Например, trap.profile_assigned" /></label>
      <label className="text-xs">Оператор (actor_id)<input className={queryInputClass} value={draft.actor_id || ''} onChange={(e) => setDraft({ ...draft, actor_id: e.target.value })} /></label>
      <label className="text-xs">Начало периода (UTC)<input className={queryInputClass} type="datetime-local" step="1" value={dateInputUTC(draft.from)} onChange={(e) => setDraft({ ...draft, from: isoUTC(e.target.value) })} /></label>
      <label className="text-xs">Окончание периода (UTC)<input className={queryInputClass} type="datetime-local" step="1" value={dateInputUTC(draft.to)} onChange={(e) => setDraft({ ...draft, to: isoUTC(e.target.value) })} /></label>
      <div className="flex flex-wrap gap-2"><Button type="submit" size="sm">Применить фильтры</Button><Button size="sm" type="button" variant="outline" onClick={() => { window.location.hash = 'audit'; if (!search) setEpoch((value) => value + 1); }}>Сбросить фильтры</Button></div>
      {error && <p role="alert">{error}</p>}
    </form>
    {state.loading && <p role="status">Загрузка аудита…</p>}
    {state.error && <p role="alert" className="text-rose-700">{state.error}. {state.data ? 'Предыдущий снимок устарел.' : 'Данные недоступны.'}</p>}
    {state.updated && <p className="text-xs">Снимок: {new Date(state.updated).toISOString()}</p>}
    {state.data && (!state.data.items.length ? <p>Записей аудита по этим фильтрам нет.</p> : <div className="bg-white border rounded-xl overflow-x-auto"><table aria-label="Таблица аудита" className="w-full text-left text-sm">
      <thead className="bg-slate-50"><tr>{['Время UTC', 'Оператор', 'Действие', 'Объект', 'Результат', 'Подробности'].map((label) => <th scope="col" key={label} className="p-3">{label}</th>)}</tr></thead>
      <tbody>{state.data.items.map((entry) => {
        const link = objectLink(entry);
        const details = Object.fromEntries(Object.entries(entry.details).filter(([key]) => safeKeys.has(key)));
        return <tr key={entry.id} className="border-t align-top"><td className="p-3 text-xs whitespace-nowrap">{entry.created_at}</td><td className="p-3 text-xs break-all">{entry.actor_id || 'Система / агент (actor_id отсутствует)'}</td><td className="p-3 text-xs break-all">{entry.action}</td>
          <td className="p-3 text-xs break-all">{link ? <a className="text-brand-700 underline focus-visible:ring-2 rounded" href={link}>{entry.entity_type}: {entry.entity_id}</a> : `${entry.entity_type}: ${entry.entity_id || 'Не указан'}`}</td>
          <td className="p-3 text-xs">{result(entry)}{entry.entity_type === 'command' && uuid(entry.details.trap_id) && <CommandResult entry={entry} />}</td>
          <td className="p-3"><pre className="whitespace-pre-wrap break-all text-xs max-w-sm">{JSON.stringify(details, null, 2).slice(0, 4096)}</pre></td></tr>;
      })}</tbody>
    </table></div>)}
    <div className="flex gap-3">{filters.cursor && <Button size="sm" variant="outline" onClick={() => cursor()}>К началу аудита</Button>}<Button size="sm" disabled={state.loading || !!state.error || !state.data?.next_cursor} onClick={() => cursor(state.data?.next_cursor)}>Более ранние записи</Button></div>
  </div>;
}
