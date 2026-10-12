import React, { useState, useEffect, useCallback } from 'react';
import {
  Filter,
  Download,
  Search,
  RefreshCw,
  ChevronRight,
} from 'lucide-react';
import { AttackEvent } from '../api/types';
import { api } from '../api/client';
import { useNotification } from '../context/NotificationContext';
import { LevelBadge, SeverityBadge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { AttackInspector } from '../components/common/AttackInspector';
import { LoadingSkeleton, ErrorState, EmptyState } from '../components/common/StateViews';

export const EventsScreen: React.FC = () => {
  const { notify } = useNotification();
  const [events, setEvents] = useState<AttackEvent[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<AttackEvent | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [severityFilter, setSeverityFilter] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');

  const fetchEvents = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await api.events.list({
        severity: severityFilter === 'all' ? undefined : severityFilter,
      });
      setEvents(data);
    } catch (err: any) {
      setError(err.message || 'Ошибка загрузки журнала событий');
    } finally {
      setIsLoading(false);
    }
  }, [severityFilter]);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  // Export IoC CSV
  const handleExportIoc = () => {
    if (events.length === 0) {
      notify('warning', 'Экспорт IoC', 'Нет событий для формирования выгрузки');
      return;
    }

    const headers = ['Timestamp', 'Source_IP', 'Port', 'Protocol', 'Trap', 'Event_Type', 'Severity', 'IoC_Flags'];
    const rows = events.map((e) => [
      e.occurred_at,
      e.source_ip,
      e.destination_port,
      e.protocol,
      `"${e.trap_name.replace(/"/g, '""')}"`,
      e.event_type,
      e.severity,
      `"${(e.ioc_flags || []).join(';')}"`,
    ]);

    const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `honeyforge-ioc-export-${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    notify('success', 'Экспорт завершен', `Выгружено индикаторов IoC: ${events.length}`);
  };

  // Filtered in memory
  const filteredEvents = events.filter((e) => {
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      const matchesIp = e.source_ip.toLowerCase().includes(query);
      const matchesTrap = e.trap_name.toLowerCase().includes(query);
      const matchesPayload =
        (e.payload.username && e.payload.username.toLowerCase().includes(query)) ||
        (e.payload.path && e.payload.path.toLowerCase().includes(query)) ||
        (e.payload.command && e.payload.command.toLowerCase().includes(query));
      if (!matchesIp && !matchesTrap && !matchesPayload) return false;
    }

    if (typeFilter !== 'all' && e.event_type !== typeFilter) {
      return false;
    }

    return true;
  });

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      {/* Title & Actions */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Журнал событий атак</h1>
          <p className="text-sm text-slate-500 mt-1">
            Полноразмерный аудит входящего трафика, инцидентов и IoC индикаторов (FR-C4)
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <Button
            variant="outline"
            size="sm"
            leftIcon={<Download className="w-3.5 h-3.5" />}
            onClick={handleExportIoc}
          >
            Экспорт IoC (CSV)
          </Button>
          <Button
            variant="outline"
            size="sm"
            leftIcon={<RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />}
            onClick={fetchEvents}
            disabled={isLoading}
          >
            Обновить
          </Button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-1 items-center gap-3 min-w-[280px]">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Поиск по IP, ловушке, пути или команде..."
              className="w-full pl-9 pr-3 py-1.5 border border-slate-300 rounded-lg text-xs focus:ring-2 focus:ring-brand-500 focus:outline-none"
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs text-slate-600">
            <Filter className="w-3.5 h-3.5 text-slate-400" />
            <span>Уровень риска:</span>
            <select
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value)}
              className="px-2 py-1 border border-slate-300 rounded-md text-xs bg-white focus:outline-none"
            >
              <option value="all">Все</option>
              <option value="critical">Атака (Critical)</option>
              <option value="warning">Внимание (Warning)</option>
              <option value="info">Инфо (Info)</option>
            </select>
          </div>

          <div className="flex items-center gap-1.5 text-xs text-slate-600">
            <span>Тип:</span>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="px-2 py-1 border border-slate-300 rounded-md text-xs bg-white focus:outline-none"
            >
              <option value="all">Все типы</option>
              <option value="auth.attempt">Попытка входа</option>
              <option value="http.request">HTTP Запрос</option>
              <option value="command.exec">Выполнение команды</option>
              <option value="port.scan">Сканирование портов</option>
              <option value="file.read">Чтение файла</option>
            </select>
          </div>
        </div>
      </div>

      {isLoading ? (
        <LoadingSkeleton rows={6} />
      ) : error ? (
        <ErrorState message={error} onRetry={fetchEvents} />
      ) : filteredEvents.length === 0 ? (
        <EmptyState
          title="События не найдены"
          description="По заданным фильтрам событий не обнаружено"
          actionText="Сбросить фильтры"
          onAction={() => {
            setSearchQuery('');
            setSeverityFilter('all');
            setTypeFilter('all');
          }}
        />
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm" aria-label="Журнал событий атак">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wider">
                  <th scope="col" className="px-5 py-3.5">Время UTC</th>
                  <th scope="col" className="px-5 py-3.5">IP Источника</th>
                  <th scope="col" className="px-5 py-3.5">Тип события</th>
                  <th scope="col" className="px-5 py-3.5">Ловушка</th>
                  <th scope="col" className="px-5 py-3.5">Полезная нагрузка (Payload)</th>
                  <th scope="col" className="px-5 py-3.5">Серьезность</th>
                  <th scope="col" className="px-5 py-3.5 text-right">Инспектор</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredEvents.map((evt) => {
                  const utcTime = new Date(evt.occurred_at).toUTCString().replace('GMT', 'UTC');
                  return (
                    <tr
                      key={evt.id}
                      onClick={() => setSelectedEvent(evt)}
                      className="hover:bg-slate-50/80 cursor-pointer transition-colors group"
                    >
                      <td className="px-5 py-4 font-mono text-xs text-slate-500 whitespace-nowrap">
                        {utcTime}
                      </td>
                      <td className="px-5 py-4">
                        <div className="font-mono font-medium text-slate-900 group-hover:text-brand-600">
                          {evt.source_ip}
                        </div>
                        <div className="text-xs text-slate-400 font-mono">порт {evt.destination_port}</div>
                      </td>
                      <td className="px-5 py-4">
                        <span className="font-mono text-xs bg-slate-100 px-2 py-0.5 rounded text-slate-700">
                          {evt.event_type}
                        </span>
                      </td>
                      <td className="px-5 py-4">
                        <div className="text-xs font-medium text-slate-800">{evt.trap_name}</div>
                        <LevelBadge level={evt.level} />
                      </td>
                      <td className="px-5 py-4 max-w-xs">
                        {evt.payload.command ? (
                          <div className="font-mono text-xs text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded truncate">
                            $ {evt.payload.command}
                          </div>
                        ) : evt.payload.username ? (
                          <div className="text-xs text-amber-900 bg-amber-50 px-2 py-0.5 rounded font-mono truncate">
                            usr: {evt.payload.username} / pass: {evt.payload.password || '***'}
                          </div>
                        ) : evt.payload.path ? (
                          <div className="text-xs text-slate-700 font-mono truncate">
                            {evt.payload.method || 'GET'} {evt.payload.path}
                          </div>
                        ) : (
                          <div className="text-xs text-slate-400 italic">Сетевое соединение</div>
                        )}
                      </td>
                      <td className="px-5 py-4">
                        <SeverityBadge severity={evt.severity} />
                      </td>
                      <td className="px-5 py-4 text-right">
                        <span className="inline-flex items-center text-xs text-brand-600 font-medium group-hover:underline">
                          Открыть <ChevronRight className="w-3.5 h-3.5 ml-0.5" />
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Attack Inspector Modal */}
      <AttackInspector event={selectedEvent} onClose={() => setSelectedEvent(null)} />
    </div>
  );
};
