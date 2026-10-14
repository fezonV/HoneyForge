import { useEffect, useState } from 'react';

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

// Notifications invalidate REST data; they never replace confirmed trap state.
export function useTrapRealtime(enabled: boolean, sessionKey?: string) {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!enabled) { setStatus('disconnected'); return; }
    let stopped = false;
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    let reconcile: number | undefined;
    let attempts = 0;

    const invalidate = () => {
      if (reconcile !== undefined) return;
      reconcile = window.setTimeout(() => {
        reconcile = undefined;
        if (!stopped) setRevision((value) => value + 1);
      }, 150);
    };
    const connect = () => {
      if (stopped || socket || !navigator.onLine) return;
      setStatus('connecting');
      const url = new URL('/api/v1/ws', window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const connection = new WebSocket(url);
      socket = connection;
      connection.onopen = () => {
        if (stopped) return;
        attempts = 0;
        setStatus('connected');
        invalidate(); // Includes changes missed during a disconnect.
      };
      connection.onmessage = (event) => {
        if (stopped || typeof event.data !== 'string' || event.data.length > 65536) return;
        try {
          const message: unknown = JSON.parse(event.data);
          if (message && typeof message === 'object' && 'type' in message &&
            (message.type === 'trap.status_changed' || message.type === 'command.updated')) invalidate();
        } catch { /* Ignore malformed notifications; REST polling still reconciles state. */ }
      };
      connection.onclose = () => {
        if (socket === connection) socket = null;
        if (stopped) return;
        setStatus('disconnected');
        if (navigator.onLine) {
          retry = window.setTimeout(connect, Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5)));
        }
      };
      connection.onerror = () => connection.close();
    };
    const online = () => { window.clearTimeout(retry); connect(); };
    const offline = () => { window.clearTimeout(retry); socket?.close(); setStatus('disconnected'); };
    connect();
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      stopped = true;
      window.clearTimeout(retry);
      window.clearTimeout(reconcile);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
      socket?.close();
    };
  }, [enabled, sessionKey]);

  return { status, revision };
}
