import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { api, isDevModeActive } from '../api/client';
import { ConnectionStatus } from '../api/realtime';
import { EventFilters, StoredEvent } from '../api/types';
import { Button } from '../components/common/Button';
import { dateInputUTC, isoUTC, queryInputClass, useHashQuery, useResource } from '../components/common/queryState';
import { EventTable } from '../components/events/EventTable';
import { EventExport } from '../components/events/EventExport';
import { formatTime } from '../components/events/eventView';

type Period = { from: string; to: string };
const lastPeriod = (hours: number): Period => {
  const to = Date.now();
  return { from: new Date(to - hours * 3600000).toISOString(), to: new Date(to).toISOString() };
};
const eventLink = (filters: EventFilters) => `#events?${new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))}`;
const linkClass = 'text-brand-700 underline rounded focus-visible:ring-2';
function Widget({ title, state, children }: { title: string; state: { loading: boolean; error?: string; updated?: string }; children: ReactNode }) {
  return <section aria-label={title} className="bg-white border rounded-xl p-5 space-y-3 min-w-0" aria-busy={state.loading}>
    <h2 className="font-semibold text-lg">{title}</h2>
    {state.loading && <p role="status" className="text-sm">Обновление…</p>}
    {state.error && <p role="alert" className="text-rose-700 text-sm">{state.error}. {state.updated ? 'Снимок устарел, актуальность не подтверждена.' : 'Данные недоступны.'}</p>}
    {state.updated && <p className="text-xs text-slate-500">Снимок: {formatTime(state.updated)}</p>}
    {children}
  </section>;
}

export function OverviewScreen({ connectionStatus = 'disconnected' }: { connectionStatus?: ConnectionStatus }) {
  const search = useHashQuery();
  const [initial] = useState(() => lastPeriod(24));
  const params = new URLSearchParams(search);
  const from = params.get('from') || initial.from, to = params.get('to') || initial.to;
  const [draft, setDraft] = useState({ from, to });
  const [error, setError] = useState('');
  useEffect(() => { setDraft({ from, to }); setError(''); }, [from, to]);
  useEffect(() => { if (!search) window.location.hash = `overview?${new URLSearchParams(initial)}`; }, [initial, search]);
  const valid = Number.isFinite(Date.parse(from)) && Number.isFinite(Date.parse(to)) && Date.parse(from) < Date.parse(to);
  const select = (period: Period) => { window.location.hash = `overview?${new URLSearchParams(period)}`; };
  const apply = (event: FormEvent) => {
    event.preventDefault();
    if (!draft.from || !draft.to || Date.parse(draft.from) >= Date.parse(draft.to)) { setError('Укажите начало раньше окончания периода.'); return; }
    select(draft);
  };
  return <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-5">
    <h1 className="text-2xl font-bold">Обзор мониторинга</h1>
    <p className="text-sm text-slate-600">События — наблюдаемые обращения, их количество не подтверждает число атак. Парк показан на момент снимка; период относится к событиям.</p>
    {isDevModeActive() && <p role="alert">Для реальной сводки включите режим API. События и агрегаты запрашиваются у центра.</p>}
    <p role="status" className="text-sm">Канал уведомлений: {connectionStatus === 'connected' ? 'WS подключён' : connectionStatus === 'connecting' ? 'WS подключается' : 'WS отключён'}. Сводка обновляется кнопкой; время снимка указано отдельно у каждого виджета.</p>
    <form aria-label="Период dashboard" onSubmit={apply} className="bg-white border rounded-xl p-4 flex flex-wrap items-end gap-3">
      <label className="text-xs">Начало периода (UTC)<input type="datetime-local" step="1" required className={queryInputClass} value={dateInputUTC(draft.from)} onChange={(e) => setDraft({ ...draft, from: isoUTC(e.target.value) })} /></label>
      <label className="text-xs">Окончание периода (UTC)<input type="datetime-local" step="1" required className={queryInputClass} value={dateInputUTC(draft.to)} onChange={(e) => setDraft({ ...draft, to: isoUTC(e.target.value) })} /></label>
      <Button size="sm" type="submit">Применить период</Button>
      {[1, 24, 168].map((hours) => <Button key={hours} size="sm" type="button" variant="outline" onClick={() => select(lastPeriod(hours))}>{hours === 168 ? '7 дней' : `${hours} ч`}</Button>)}
      {error && <p role="alert">{error}</p>}
    </form>
    {valid ? <Dashboard from={from} to={to} /> : <p role="alert">Некорректный период в URL. Выберите период выше.</p>}
  </div>;
}

function Dashboard({ from, to }: Period) {
  const [epoch, setEpoch] = useState(0);
  const period = useMemo(() => ({ from, to }), [from, to]);
  const scope = `${from}/${to}`;
  const previous = useMemo(() => ({ from: new Date(Date.parse(from) - (Date.parse(to) - Date.parse(from))).toISOString(),
    // PostgreSQL timestamps have microsecond precision. A nanosecond gap could
    // round back onto the current boundary and count the same event twice.
    to: new Date(Date.parse(from) - 1).toISOString().replace(/(\.\d{3})Z$/, '$1999Z') }), [from, to]);
  const loadSummary = useCallback((signal: AbortSignal) => api.events.summary(period, signal), [period]);
  const loadPrevious = useCallback((signal: AbortSignal) => api.events.summary(previous, signal), [previous]);
  const loadEvents = useCallback((signal: AbortSignal) => api.events.page({ ...period, limit: 10 }, signal), [period]);
  const loadTraps = useCallback((signal: AbortSignal) => api.traps.list(signal), []);
  const summary = useResource(scope, epoch, loadSummary);
  const prior = useResource(`${previous.from}/${previous.to}`, epoch, loadPrevious);
  const recent = useResource(scope, epoch, loadEvents);
  const fleet = useResource('fleet', epoch, loadTraps);
  const traps = fleet.data;
  const counts = traps ? { online: traps.filter((trap) => trap.agent_status === 'online').length,
    offline: traps.filter((trap) => trap.agent_status === 'offline').length,
    degraded: traps.filter((trap) => trap.service_status === 'degraded' || trap.service_status === 'error' || trap.telemetry?.degraded === true).length } : null;
  const selectEvent = (event: StoredEvent) => { window.location.hash = eventLink(period) + `&event_id=${encodeURIComponent(event.event_id)}&event_trap=${encodeURIComponent(event.trap_id)}`; };
  return <>
    <div className="flex flex-wrap gap-3 items-center"><Button size="sm" variant="outline" onClick={() => setEpoch((value) => value + 1)}>Обновить сводку</Button><p className="text-xs break-all">Период включительно: {from} — {to} (UTC).</p></div>
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <Widget title="Парк ловушек" state={fleet}>
        {traps && counts && <><p>Всего экземпляров: <a href="#traps" className={linkClass}>{traps.length}</a></p><div className="flex flex-wrap gap-5">{Object.entries(counts).map(([status, count]) => <a key={status} className={linkClass} href={`#traps?status=${status}`} aria-label={`${status}: ${count}`}><span className="block text-3xl font-bold">{count}</span>{status}</a>)}</div>
          <p className="text-xs text-slate-500">Degraded: service_state error/degraded или telemetry.degraded; может пересекаться с online/offline.</p>
          <ul className="text-xs space-y-2 max-h-72 overflow-auto">{traps.map((trap) => <li key={trap.id} className="border-t pt-2 break-words"><a className={linkClass} href={`#traps/${trap.id}`}>{trap.name}</a> · агент {trap.agent_status || 'неизвестно'} · сервис {trap.service_status || 'неизвестно'} · last_seen {trap.last_seen_at ? formatTime(trap.last_seen_at) : 'неизвестно'}
            <p>Очередь: {trap.telemetry?.queue_depth ?? 'Неизвестно'} / {trap.telemetry?.queue_limit ?? 'Неизвестно'}; карантин: {trap.telemetry?.quarantined ?? 'Неизвестно'}; ошибки доставки: {trap.telemetry?.delivery_errors ?? 'Неизвестно'}; повторы: {trap.telemetry?.delivery_retries ?? 'Неизвестно'}; ошибки хранилища: {trap.telemetry?.storage_errors ?? 'Неизвестно'}.</p>
            {(trap.telemetry?.delivery_error || trap.telemetry?.storage_error || trap.telemetry?.quarantine_reason) && <p className="text-rose-700">{trap.telemetry.delivery_error} {trap.telemetry.storage_error} {trap.telemetry.quarantine_reason}</p>}</li>)}</ul>
          {!traps.length && <p>Экземпляров нет.</p>}</>}
      </Widget>
      <div className="space-y-4">
        <Widget title="События за период" state={summary}>
          {summary.data && <><a className={`${linkClass} text-3xl font-bold`} href={eventLink(period)} aria-label={`Все события периода: ${summary.data.total_events}`}>{summary.data.total_events}</a><p>Уникальных IP: {summary.data.unique_sources}</p>
            {!summary.data.total_events && <p>За выбранный период событий нет.</p>}
            <ul className="text-sm space-y-1">{summary.data.by_event_type.map((item) => <li key={item.event_type}><a className={linkClass} href={eventLink({ ...period, event_type: item.event_type })}>{item.event_type}: {item.count}</a></li>)}</ul>
          </>}
        </Widget>
        <Widget title="Динамика событий" state={prior}>
          <p className="text-xs break-all">Предыдущий период (UTC): {previous.from} — {previous.to}</p>
          {prior.data && <p><a className={linkClass} href={eventLink(previous)}>Предыдущий период: {prior.data.total_events}</a></p>}
          {summary.data && <p><a className={linkClass} href={eventLink(period)}>Выбранный период: {summary.data.total_events}</a></p>}
          {prior.data && summary.data && <p>Изменение: {summary.data.total_events - prior.data.total_events} событий. {prior.data.total_events ? `${((summary.data.total_events / prior.data.total_events - 1) * 100).toFixed(1)}%` : 'Процент не рассчитывается: в предыдущем периоде нет событий.'}{summary.error || summary.loading ? ' Текущая сводка не подтверждена; сравнение по последним снимкам.' : ''}</p>}
          {!summary.data && <p>Для сравнения ожидается сводка выбранного периода.</p>}
        </Widget>
      </div>
    </div>
    <Widget title="Top источников" state={summary}>
      {summary.data && <>{!summary.data.top_sources.length && <p>IP источников за период не зарегистрированы.</p>}<ul className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">{summary.data.top_sources.map((source) => <li key={source.source_ip} className="border rounded p-3 break-words"><a className={linkClass} href={eventLink({ ...period, source_ip: source.source_ip.replace(/\/(32|128)$/, '') })}>{source.source_ip} — {source.count} событий</a>
        <p>Страна: {source.source_country_name || source.source_country_code || 'Неизвестно'}; ASN: {source.source_asn ?? 'Неизвестно'} {source.source_asn_org || ''}</p></li>)}</ul></>}
    </Widget>
    <Widget title="Последние события периода" state={recent}>
      {recent.data && (recent.data.items.length ? <EventTable events={recent.data.items} onSelect={selectEvent} names={new Map(traps?.map((trap) => [trap.id, trap.name]))} /> : <p>Событий нет.</p>)}
      <a className={linkClass} href={eventLink(period)}>Открыть журнал за этот период</a>
    </Widget>
    <EventExport filters={period} />
  </>;
}
