import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { SessionTimeline as Timeline, StoredEvent } from '../../api/types';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';
import { EventTable } from './EventTable';
import { formatTime, PAGE_SIZE, uniqueEvents } from './eventView';

export function SessionTimeline({ sessionId, trapId, cursor, onCursor, onSelect, onClose }: {
  sessionId: string; trapId?: string; cursor: string; onCursor: (cursor: string) => void;
  onSelect: (event: StoredEvent) => void; onClose: () => void;
}) {
  const [data, setData] = useState<Timeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(''); setData(null);
    api.events.timeline(sessionId, cursor || undefined, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (trapId && result.session.trap_id !== trapId) throw new Error('Сессия принадлежит другой ловушке');
      setData({ ...result, items: uniqueEvents(result.items).slice(0, PAGE_SIZE) });
    }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Ошибка timeline'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sessionId, trapId, cursor, epoch]);
  return <Modal isOpen title="Timeline сессии" description={sessionId} maxWidth="xl" onClose={onClose}>
    <div className="space-y-4 text-sm" aria-busy={loading}>
      <p>Хронология от старых действий к новым. Используется revision каждого события. Читаемая страница обновляется только по вашему действию.</p>
      {loading && <p>Загрузка timeline…</p>}
      {error && <p role="alert" className="text-rose-700">{error}</p>}
      {data && <><p>Ловушка: {data.session.trap_id}</p><p>Начало: {formatTime(data.session.started_at)}; завершение: {data.session.ended_at ? formatTime(data.session.ended_at) : 'Не зарегистрировано'}</p>
        {data.items.length ? <EventTable events={data.items} onSelect={onSelect} /> : <p>Событий на этой странице нет.</p>}
      </>}
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={loading} onClick={() => setEpoch((value) => value + 1)}>Обновить timeline</Button>
        {cursor && <Button size="sm" variant="outline" onClick={() => onCursor('')}>К началу сессии</Button>}
        <Button size="sm" disabled={loading || !data?.next_cursor} onClick={() => onCursor(data?.next_cursor || '')}>Следующая страница timeline</Button>
      </div>
    </div>
  </Modal>;
}
