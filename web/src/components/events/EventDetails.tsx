import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { StoredEvent } from '../../api/types';
import { useAuth } from '../../context/AuthContext';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';
import { description, formatTime } from './eventView';

export function EventDetails({ trapId, eventId, onClose, onTimeline }: {
  trapId: string; eventId: string; onClose: () => void; onTimeline: (sessionId: string, trapId: string) => void;
}) {
  const { role } = useAuth();
  const [event, setEvent] = useState<StoredEvent | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [payload, setPayload] = useState<string | null>(null);
  const [payloadError, setPayloadError] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [reading, setReading] = useState(false);
  const sensitive = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; sensitive.current?.abort(); }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    api.events.detail(trapId, eventId, false, controller.signal).then((item) => {
      if (!controller.signal.aborted) setEvent(item);
    }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Не удалось прочитать событие'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [trapId, eventId, attempt]);

  const readPayload = async () => {
    if (role !== 'operator' || sensitive.current) return;
    const controller = new AbortController(); sensitive.current = controller;
    setReading(true); setPayloadError('');
    try {
      const detail = await api.events.detail(trapId, eventId, true, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      if (detail.payload_redacted !== false) throw new Error('Сервер не разрешил раскрытие payload');
      const text = JSON.stringify(detail.payload || {}, null, 2);
      setPayload(text.slice(0, 16384)); setTruncated(text.length > 16384);
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) setPayloadError(cause instanceof Error ? cause.message : 'Ошибка чтения payload');
    } finally { sensitive.current = null; if (mounted.current) setReading(false); }
  };

  return <Modal isOpen title="Детали события" description={eventId} maxWidth="xl" onClose={onClose}>
    <div className="space-y-4 text-sm" aria-busy={loading}>
      {loading && <p>Загрузка метаданных…</p>}
      {error && <div role="alert"><p className="text-rose-700">{error}</p><Button size="sm" variant="outline" onClick={() => setAttempt((value) => value + 1)}>Повторить чтение</Button></div>}
      {event && !error && <>
        <h4 className="font-semibold">{description(event)} — {event.event_type}</h4>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 break-words">
          {[
            ['Событие', event.event_id], ['Ловушка', event.trap_id], ['Агент', event.agent_id], ['Сервис', event.service_id],
            ['Произошло', formatTime(event.timestamp)], ['Получено центром', formatTime(event.received_at)],
            ['IP источника', event.source_ip], ['Порт источника', event.source_port], ['Целевой порт', event.destination_port], ['Протокол', event.protocol],
            ['Исторический профиль', event.profile_id], ['Историческая revision', event.applied_revision], ['Сессия', event.session_id],
            ['Страна', event.source_country_name || event.source_country_code], ['ASN', event.source_asn], ['Организация ASN', event.source_asn_org],
            ['Источник GeoIP', event.geo_source], ['Версия GeoIP', event.geo_version], ['Артефакты', undefined],
          ].map(([label, value]) => <div key={label}><dt className="text-xs text-slate-500">{label}</dt><dd className="whitespace-pre-wrap break-all">{value ?? 'Неизвестно'}</dd></div>)}
        </dl>
        {event.session_id && <Button variant="outline" onClick={() => onTimeline(event.session_id!, event.trap_id)}>Открыть timeline сессии</Button>}
        <section className="border rounded-lg p-3 space-y-3" aria-label="Payload события">
          <h4 className="font-semibold">Payload</h4>
          <p>Учётные данные и остальные поля не загружаются обычным запросом метаданных.</p>
          {role === 'operator' ? <>
            <p className="text-xs text-slate-600">Явное раскрытие запрашивается отдельным GET. Сервер проверяет права и записывает доступ в аудит. Значения могут содержать введённые посетителем credentials.</p>
            {payload === null && <Button size="sm" isLoading={reading} onClick={readPayload}>Запросить payload с аудитом</Button>}
            {payloadError && <p role="alert" className="text-rose-700">{payloadError}</p>}
            {payload !== null && <>
              <pre className="bg-slate-100 p-3 rounded whitespace-pre-wrap break-all max-h-80 overflow-auto text-xs">{payload}</pre>
              {truncated && <p className="text-amber-800">Показаны первые 16 384 символа. Остальная часть payload пропущена.</p>}
              <Button variant="outline" size="sm" onClick={() => { setPayload(null); setTruncated(false); }}>Убрать payload из просмотра</Button>
            </>}
          </> : <p className="text-slate-600">Чувствительные данные доступны только оператору по разрешению сервера.</p>}
        </section>
      </>}
    </div>
  </Modal>;
}
