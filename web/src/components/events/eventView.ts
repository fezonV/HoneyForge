import { EventFilters, StoredEvent } from '../../api/types';

export const FILTER_KEYS = ['trap_id', 'from', 'to', 'source_ip', 'event_type', 'session_id'] as const;
export const PAGE_SIZE = 50;
export const eventTypes = ['connection.opened', 'http.request', 'auth.attempt', 'session.started', 'file.listed', 'file.read', 'file.downloaded', 'command.received', 'session.ended'];
const descriptions: Record<string, string> = {
  'connection.opened': 'Открыто соединение', 'http.request': 'HTTP-запрос', 'auth.attempt': 'Попытка входа',
  'session.started': 'Начало сессии', 'session.ended': 'Завершение сессии', 'file.listed': 'Просмотр списка файлов',
  'file.read': 'Чтение файла', 'file.downloaded': 'Скачивание файла', 'command.received': 'Псевдокоманда',
};
export const description = (event: StoredEvent) => descriptions[event.event_type] || 'Действие посетителя';
export const eventKey = (event: StoredEvent) => `${event.trap_id}:${event.event_id}`;
export function uniqueEvents(items: StoredEvent[]): StoredEvent[] {
  return [...new Map(items.map((item) => [eventKey(item), item])).values()];
}
export function readFilters(params: URLSearchParams): EventFilters {
  return Object.fromEntries(FILTER_KEYS.map((key) => [key, params.get(key) || undefined]));
}
export const formatTime = (value?: string) => value && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleString('ru-RU', { timeZoneName: 'short' }) : 'Неизвестно';
export const getEventSearch = () => window.location.hash.split('?').slice(1).join('?');
export function navigateEvents(params: URLSearchParams) {
  window.location.hash = `events${params.size ? `?${params}` : ''}`;
}
