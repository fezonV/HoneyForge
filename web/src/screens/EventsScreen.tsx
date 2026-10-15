import { FormEvent, useEffect, useMemo, useState } from 'react';
import { api, isDevModeActive } from '../api/client';
import { ConnectionStatus } from '../api/realtime';
import { EventFilters, StoredEvent, Trap } from '../api/types';
import { useAuth } from '../context/AuthContext';
import { Button } from '../components/common/Button';
import { EventTable } from '../components/events/EventTable';
import { EventDetails } from '../components/events/EventDetails';
import { SessionTimeline } from '../components/events/SessionTimeline';
import { eventTypes, FILTER_KEYS, getEventSearch, navigateEvents, readFilters } from '../components/events/eventView';
import { useEventFeed } from '../components/events/useEventFeed';
import { EventExport } from '../components/events/EventExport';

const dateInput = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().slice(0, 19) : '';
const inputClass = 'block w-full border border-slate-300 rounded p-2 mt-1 text-sm';
const utcValue = (value: string) => value ? new Date(`${value}Z`).toISOString() : '';

export const EventsScreen = ({ eventRevision = 0, connectionStatus = 'disconnected' }: {
  eventRevision?: number; connectionStatus?: ConnectionStatus;
}) => {
  const { user, role } = useAuth();
  const [search, setSearch] = useState(getEventSearch);
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const filterKey = JSON.stringify(readFilters(params));
  // A stable object prevents detail navigation from restarting the event-page request.
  const filters = useMemo(() => JSON.parse(filterKey) as EventFilters, [filterKey]);
  const cursor = params.get('cursor') || '';
  const eventId = params.get('event_id') || '';
  const eventTrap = params.get('event_trap') || filters.trap_id || '';
  const sessionId = params.get('timeline_id') || '';
  const sessionTrap = params.get('timeline_trap') || '';
  const timelineCursor = params.get('timeline_cursor') || '';
  const [draft, setDraft] = useState<EventFilters>(filters);
  const [validationError, setValidationError] = useState('');
  const [paused, setPaused] = useState(false);
  const [traps, setTraps] = useState<Trap[]>([]);
  const frozen = paused || !!cursor || !!eventId || !!sessionId;
  const feed = useEventFeed(filters, cursor, frozen, eventRevision);
  const names = useMemo(() => new Map(traps.map((trap) => [trap.id, trap.name])), [traps]);

  useEffect(() => {
    const sync = () => setSearch(getEventSearch());
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  useEffect(() => { setDraft(filters); setValidationError(''); }, [filters]);
  useEffect(() => {
    let active = true;
    api.traps.list().then((items) => { if (active) setTraps(items); }).catch(() => { /* IDs remain available if the registry is unavailable. */ });
    return () => { active = false; };
  }, []);

  const navigate = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) { if (value) next.set(key, value); else next.delete(key); }
    navigateEvents(next);
  };
  const apply = (event: FormEvent) => {
    event.preventDefault();
    if (draft.from && draft.to && Date.parse(draft.from) > Date.parse(draft.to)) {
      setValidationError('Начало периода должно быть раньше его окончания.'); return;
    }
    const query = new URLSearchParams();
    for (const key of FILTER_KEYS) if (draft[key]?.trim()) query.set(key, draft[key]!.trim());
    navigateEvents(query);
    if (query.toString() === search) feed.refresh();
  };
  const fresh = () => {
    navigate({ cursor: null });
    if (!cursor) feed.refresh();
  };
  const selectEvent = (event: StoredEvent) => navigate({ event_id: event.event_id, event_trap: event.trap_id, timeline_id: null, timeline_trap: null, timeline_cursor: null });

  return <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-5">
    <div className="flex flex-wrap justify-between items-start gap-3">
      <div><h1 className="text-2xl font-bold text-slate-900">Журнал событий атак</h1><p className="text-sm text-slate-500 mt-1">История действий посетителя из PostgreSQL. Время событий показано с часовым поясом.</p></div>
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => { if (paused) fresh(); setPaused(!paused); }}>{paused ? 'Возобновить ленту' : 'Пауза ленты'}</Button><Button size="sm" disabled={feed.loading} onClick={fresh}>Обновить события</Button></div>
    </div>
    {isDevModeActive() && <p role="alert" className="text-amber-800">Выбран демо-режим. Журнал запрашивает настоящий API; для проверки телеметрии войдите в режиме API.</p>}
    <p role="status" className="text-sm text-slate-600">{connectionStatus === 'connected' ? 'WS подключён' : connectionStatus === 'connecting' ? 'WS подключается' : 'WS отключён. Доступны история REST и ручное обновление.'} · {frozen ? 'Читаемая страница зафиксирована' : 'Живая первая страница'}</p>
    <form onSubmit={apply} className="bg-white border rounded-xl p-4 space-y-3" aria-label="Фильтры событий">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <label className="text-xs text-slate-600">Ловушка (trap_id)<input aria-label="Ловушка (trap_id)" list="event-traps" value={draft.trap_id || ''} onChange={(e) => setDraft({ ...draft, trap_id: e.target.value })} className={inputClass} placeholder="Все ловушки" /></label>
        <datalist id="event-traps">{traps.map((trap) => <option key={trap.id} value={trap.id}>{trap.name}</option>)}</datalist>
        <label className="text-xs text-slate-600">Начало периода (UTC)<input aria-label="Начало периода (UTC)" type="datetime-local" step="1" value={dateInput(draft.from)} onChange={(e) => setDraft({ ...draft, from: utcValue(e.target.value) })} className={inputClass} /></label>
        <label className="text-xs text-slate-600">Окончание периода (UTC)<input aria-label="Окончание периода (UTC)" type="datetime-local" step="1" value={dateInput(draft.to)} onChange={(e) => setDraft({ ...draft, to: utcValue(e.target.value) })} className={inputClass} /></label>
        <label className="text-xs text-slate-600">IP источника<input aria-label="IP источника" value={draft.source_ip || ''} onChange={(e) => setDraft({ ...draft, source_ip: e.target.value })} className={inputClass} placeholder="IPv4 или IPv6" /></label>
        <label className="text-xs text-slate-600">Тип события<input aria-label="Тип события" list="event-types" value={draft.event_type || ''} onChange={(e) => setDraft({ ...draft, event_type: e.target.value })} className={inputClass} placeholder="Все типы" /></label>
        <datalist id="event-types">{eventTypes.map((type) => <option key={type} value={type} />)}</datalist>
        <label className="text-xs text-slate-600">Сессия (session_id)<input aria-label="Сессия (session_id)" value={draft.session_id || ''} onChange={(e) => setDraft({ ...draft, session_id: e.target.value })} className={inputClass} placeholder="Все сессии" /></label>
      </div>
      {validationError && <p role="alert" className="text-rose-700">{validationError}</p>}
      <div className="flex gap-2"><Button size="sm" type="submit">Применить фильтры</Button><Button size="sm" type="button" variant="outline" onClick={() => navigateEvents(new URLSearchParams())}>Сбросить фильтры</Button></div>
    </form>
    {(feed.changed || feed.newCount > 0) && <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex flex-wrap gap-3 items-center" role="status">
      <p>Новых событий в начале выборки: {feed.newCount}{feed.overflow ? '+' : ''}. {feed.overflow ? 'Буфер ограничен; обновите выборку из REST.' : 'История могла измениться, включая более ранние события.'}</p><Button size="sm" onClick={fresh}>Показать новые события</Button>
    </div>}
    <EventExport filters={filters} />
    {feed.loading && <p role="status">Загрузка событий…</p>}
    {feed.error && <div role="alert" className="border border-rose-200 bg-rose-50 rounded p-3 space-y-2"><p>{feed.error}</p>{feed.items.length > 0 && <p>Показан предыдущий снимок, актуальность не подтверждена.</p>}<Button size="sm" variant="outline" onClick={feed.refresh}>Повторить чтение событий</Button></div>}
    {!feed.loading && !feed.error && feed.items.length === 0 && <p className="bg-white border rounded-xl p-6">События не найдены. Проверьте фильтры или выполните запрос к Low/Medium.</p>}
    {feed.items.length > 0 && <EventTable events={feed.items} names={names} onSelect={selectEvent} />}
    <div className="flex flex-wrap items-center gap-3 text-sm"><p>На странице: {feed.items.length} / 50.</p>{cursor && <Button size="sm" variant="outline" onClick={fresh}>К свежим событиям</Button>}<Button size="sm" disabled={feed.loading || !!feed.error || !feed.nextCursor} onClick={() => navigate({ cursor: feed.nextCursor })}>Более ранние события</Button></div>
    {eventId && !sessionId && (eventTrap ? <EventDetails key={`${eventTrap}:${eventId}:${user?.id}:${role}`} trapId={eventTrap} eventId={eventId} onClose={() => navigate({ event_id: null, event_trap: null })} onTimeline={(id, trap) => navigate({ event_id: null, event_trap: null, timeline_id: id, timeline_trap: trap, timeline_cursor: null })} /> : <p role="alert">Для ссылки на детали требуется event_trap или trap_id.</p>)}
    {sessionId && <SessionTimeline key={`${sessionId}:${sessionTrap}`} sessionId={sessionId} trapId={sessionTrap || undefined} cursor={timelineCursor} onCursor={(value) => navigate({ timeline_cursor: value })} onSelect={selectEvent} onClose={() => navigate({ timeline_id: null, timeline_trap: null, timeline_cursor: null })} />}
  </div>;
};
