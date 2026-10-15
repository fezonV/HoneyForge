import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api/client';
import { EventFilters, StoredEvent } from '../../api/types';
import { eventKey, PAGE_SIZE, uniqueEvents } from './eventView';

const BUFFER_LIMIT = 1000;

export function useEventFeed(filters: EventFilters, cursor: string, frozen: boolean, eventRevision: number) {
  const [items, setItems] = useState<StoredEvent[]>([]);
  const [nextCursor, setNextCursor] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newCount, setNewCount] = useState(0);
  const [changed, setChanged] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const generation = useRef(0);
  const baseline = useRef<Set<string> | null>(null);
  const pending = useRef(new Set<string>());
  const handledRevision = useRef(eventRevision);
  const live = useRef({ filters, cursor, frozen, eventRevision });
  live.current = { filters, cursor, frozen, eventRevision };
  const refresh = useCallback(() => setEpoch((value) => value + 1), []);

  useEffect(() => {
    const id = ++generation.current;
    const controller = new AbortController();
    handledRevision.current = live.current.eventRevision;
    baseline.current = null; pending.current.clear();
    setLoading(true); setError(''); setItems([]); setNextCursor('');
    setNewCount(0); setChanged(false); setOverflow(false);
    const load = async () => {
      try {
        const [page, head] = await Promise.all([
          api.events.page({ ...filters, cursor: cursor || undefined, limit: PAGE_SIZE }, controller.signal),
          cursor ? api.events.page({ ...filters, limit: PAGE_SIZE }, controller.signal) : Promise.resolve(null),
        ]);
        if (controller.signal.aborted || generation.current !== id || live.current.filters !== filters || live.current.cursor !== cursor) return;
        setItems(uniqueEvents(page.items).slice(0, PAGE_SIZE));
        setNextCursor(page.next_cursor || '');
        baseline.current = new Set((head || page).items.map(eventKey));
      } catch (cause) {
        if (!controller.signal.aborted && generation.current === id) setError(cause instanceof Error ? cause.message : 'Ошибка загрузки событий');
      } finally { if (!controller.signal.aborted && generation.current === id) setLoading(false); }
    };
    void load();
    return () => controller.abort();
  }, [filters, cursor, epoch]);

  useEffect(() => {
    if (!eventRevision || loading || handledRevision.current === eventRevision) return;
    const controller = new AbortController();
    const id = generation.current;
    if (!baseline.current) return;
    const reconcile = async () => {
      try {
        // Query the active filters on the server: WS metadata has no source_ip or period.
        const head = await api.events.page({ ...filters, limit: PAGE_SIZE }, controller.signal);
        if (controller.signal.aborted || generation.current !== id || live.current.filters !== filters) return;
        handledRevision.current = eventRevision;
        if (!live.current.frozen && !live.current.cursor) {
          setItems(uniqueEvents(head.items).slice(0, PAGE_SIZE));
          setNextCursor(head.next_cursor || ''); setError('');
          baseline.current = new Set(head.items.map(eventKey));
          pending.current.clear(); setNewCount(0); setChanged(false); setOverflow(false);
        } else {
          for (const item of head.items) {
            const key = eventKey(item);
            if (!baseline.current?.has(key)) {
              if (pending.current.size < BUFFER_LIMIT) pending.current.add(key);
              else setOverflow(true);
            }
          }
          if (head.items.length === PAGE_SIZE && head.items.every((item) => !baseline.current?.has(eventKey(item)))) setOverflow(true);
          setNewCount(pending.current.size);
          // A reconnect can also reveal late-arriving events outside the first page.
          setChanged(true);
        }
      } catch (cause) {
        if (!controller.signal.aborted && generation.current === id) setError(cause instanceof Error ? cause.message : 'Не удалось восстановить события');
      }
    };
    void reconcile();
    return () => controller.abort();
  }, [eventRevision, filters, loading]);

  return { items, nextCursor, loading, error, newCount, changed, overflow, refresh };
}
