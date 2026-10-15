import { StoredEvent } from '../../api/types';
import { description, eventKey, formatTime } from './eventView';

export function EventTable({ events, onSelect, names = new Map<string, string>() }: {
  events: StoredEvent[]; onSelect: (event: StoredEvent) => void; names?: Map<string, string>;
}) {
  return <div className="bg-white border rounded-xl overflow-x-auto"><table className="w-full text-left text-sm" aria-label="Журнал событий атак">
    <thead className="bg-slate-50 text-slate-600"><tr>{['Время', 'Ловушка / сервис', 'Источник / назначение', 'Тип', 'Историческая версия', 'Описание', 'Детали'].map((label) => <th key={label} className="p-3" scope="col">{label}</th>)}</tr></thead>
    <tbody>{events.map((event) => <tr key={eventKey(event)} className="border-t align-top">
      <td className="p-3 whitespace-nowrap text-xs">{formatTime(event.timestamp)}</td>
      <td className="p-3"><span>{names.get(event.trap_id) || 'Имя неизвестно'}</span><div className="text-xs font-mono break-all">{event.trap_id}</div><div>Сервис: {event.service_id || 'Неизвестно'}</div></td>
      <td className="p-3 text-xs"><p>IP: {event.source_ip || 'Неизвестно'}</p><p>Порт источника: {event.source_port ?? 'Неизвестно'}</p><p>Целевой порт: {event.destination_port ?? 'Неизвестно'}</p><p>Протокол: {event.protocol || 'Неизвестно'}</p></td>
      <td className="p-3 font-mono text-xs">{event.event_type}</td>
      <td className="p-3 text-xs"><p>{event.applied_revision == null ? 'Revision неизвестна' : `v${event.applied_revision}`}</p><p className="font-mono break-all">{event.profile_id || 'Профиль неизвестен'}</p></td>
      <td className="p-3 text-xs">{description(event)}<p className="text-slate-500">{event.payload_redacted ? 'Payload скрыт сервером' : 'Без описания payload'}</p></td>
      <td className="p-3"><button type="button" className="text-brand-700 underline focus-visible:ring-2 rounded" onClick={() => onSelect(event)} aria-label={`Открыть событие ${event.event_id}`}>Открыть</button><div className="font-mono text-xs break-all mt-1">{event.event_id}</div></td>
    </tr>)}</tbody>
  </table></div>;
}
