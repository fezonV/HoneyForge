import { useEffect, useRef, useState } from 'react';
import { api, isDevModeActive } from '../../api/client';
import { EventFilters } from '../../api/types';
import { useAuth } from '../../context/AuthContext';
import { Button } from '../common/Button';
import { FILTER_KEYS } from './eventView';

export function EventExport({ filters }: { filters: EventFilters }) {
  const { role } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const selection = JSON.stringify(Object.fromEntries(FILTER_KEYS.map((key) => [key, filters[key]])));
  useEffect(() => {
    setBusy(false); setError(''); setDone(false);
    return () => { controller.current?.abort(); controller.current = null; };
  }, [selection, role]);
  const download = async () => {
    if (role !== 'operator' || controller.current) return;
    const request = new AbortController(); controller.current = request;
    setBusy(true); setError(''); setDone(false);
    try {
      const blob = await api.events.exportCsv(JSON.parse(selection), request.signal);
      if (request.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a'); link.href = url; link.download = 'honeyforge-events.csv';
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDone(true);
    } catch (cause) {
      if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : 'Ошибка экспорта');
    } finally {
      if (controller.current === request) controller.current = null;
      if (!request.signal.aborted) setBusy(false);
    }
  };
  if (role !== 'operator') return <p className="text-xs text-slate-500">CSV доступен только оператору.</p>;
  return <section aria-label="Выгрузка CSV" className="text-sm space-y-2">
    <Button size="sm" variant="outline" isLoading={busy} disabled={isDevModeActive()} onClick={download}>{busy ? 'Выгрузка CSV…' : 'Скачать CSV выборки'}</Button>
    <p className="text-xs text-slate-500">Все записи серверной выборки, включая историю за пределами страницы; максимум 10 000. При превышении сузьте фильтры. Payload и credentials не экспортируются.</p>
    {done && <p role="status">CSV получен от сервера и передан браузеру для сохранения.</p>}
    {error && <p role="alert" className="text-rose-700">{error}</p>}
  </section>;
}
