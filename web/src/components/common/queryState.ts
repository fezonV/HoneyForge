import { useEffect, useState } from 'react';

export function useHashQuery() {
  const [search, setSearch] = useState(() => window.location.hash.split('?')[1] || '');
  useEffect(() => {
    const sync = () => setSearch(window.location.hash.split('?')[1] || '');
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);
  return search;
}
export const dateInputUTC = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().slice(0, 19) : '';
export const isoUTC = (value: string) => value ? new Date(`${value}Z`).toISOString() : '';
export const queryInputClass = 'block w-full border border-slate-300 rounded p-2 mt-1 text-sm';

// Refresh failures retain the previous snapshot; a new selection drops it.
export function useResource<T>(scope: string, epoch: number, load: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<{ scope: string; data?: T; loading: boolean; error?: string; updated?: string }>({ scope, loading: true });
  useEffect(() => {
    const controller = new AbortController();
    setState((old) => ({ ...(old.scope === scope ? old : { scope }), loading: true, error: undefined }));
    load(controller.signal).then((data) => {
      if (!controller.signal.aborted) setState({ scope, data, loading: false, updated: new Date().toISOString() });
    }).catch((cause) => {
      if (!controller.signal.aborted) setState((old) => ({ ...old, loading: false, error: cause instanceof Error ? cause.message : 'Ошибка чтения' }));
    });
    return () => controller.abort();
  }, [scope, epoch, load]);
  return state.scope === scope ? state : { scope, loading: true };
}
