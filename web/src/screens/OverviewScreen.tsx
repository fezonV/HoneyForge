import React, { useState, useEffect, useCallback } from 'react';
import {
  Activity,
  Radio,
  Globe,
  ChevronRight,
  TrendingUp,
  RefreshCw,
} from 'lucide-react';
import { AttackEvent, OverviewMetrics } from '../api/types';
import { api } from '../api/client';
import { LevelBadge, SeverityBadge } from '../components/common/Badge';
import { LoadingSkeleton, ErrorState, EmptyState } from '../components/common/StateViews';
import { AttackInspector } from '../components/common/AttackInspector';
import { Button } from '../components/common/Button';

export const OverviewScreen: React.FC = () => {
  const [metrics, setMetrics] = useState<OverviewMetrics | null>(null);
  const [events, setEvents] = useState<AttackEvent[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<AttackEvent | null>(null);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [m, evts] = await Promise.all([
        api.overview.getMetrics(),
        api.events.list({ limit: 10 }),
      ]);
      setMetrics(m);
      setEvents(evts);
    } catch (err: any) {
      setError(err.message || 'Не удалось загрузить данные дашборда');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (isLoading && !metrics) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        <LoadingSkeleton rows={6} />
      </div>
    );
  }

  if (error && !metrics) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <ErrorState message={error} onRetry={fetchData} />
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      {/* Page Title & Refresh */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Обзор мониторинга</h1>
          <p className="text-sm text-slate-500 mt-1">
            Оперативная сводка активности парка ловушек и перехваченной телеметрии
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          leftIcon={<RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />}
          onClick={fetchData}
          disabled={isLoading}
        >
          Обновить
        </Button>
      </div>

      {/* KPI Cards Row (Concept 1 structure + Concept 2 light theme) */}
      {metrics && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Card 1: Active Traps */}
          <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm hover:shadow-md transition-shadow">
            <div className="flex items-center justify-between text-slate-500 mb-2">
              <span className="text-sm font-semibold text-slate-700">Активные ловушки</span>
              <Radio className="w-5 h-5 text-brand-600" />
            </div>
            <div className="flex items-baseline gap-4 mt-2">
              <div>
                <span className="text-3xl font-extrabold text-slate-900">{metrics.traps_low}</span>
                <span className="text-xs text-sky-700 font-medium ml-1.5 block">Низкий (Low)</span>
              </div>
              <div className="border-l border-slate-200 pl-4">
                <span className="text-3xl font-extrabold text-slate-900">{metrics.traps_medium}</span>
                <span className="text-xs text-amber-700 font-medium ml-1.5 block">Медиум (Medium)</span>
              </div>
            </div>
            <div className="mt-4 pt-4 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
              <span>Всего узлов в парке: {metrics.total_traps}</span>
              <span className="text-emerald-700 font-medium">● В сети: {metrics.online_traps}</span>
            </div>
          </div>

          {/* Card 2: 24h Attack Events */}
          <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm hover:shadow-md transition-shadow">
            <div className="flex items-center justify-between text-slate-500 mb-2">
              <span className="text-sm font-semibold text-slate-700">События атак за 24ч</span>
              <Activity className="w-5 h-5 text-rose-600" />
            </div>
            <div className="mt-2">
              <span className="text-3xl font-extrabold text-slate-900 tracking-tight">
                {metrics.events_24h.toLocaleString('ru-RU')}
              </span>
              <div className="flex items-center gap-1.5 text-xs text-emerald-600 font-medium mt-1">
                <TrendingUp className="w-3.5 h-3.5" />
                <span>+{metrics.events_delta_percent}% по сравнению со вчерашним днем</span>
              </div>
            </div>
            <div className="mt-4 pt-4 border-t border-slate-100 text-xs text-slate-500">
              Уникальных атакующих IP: <strong className="text-slate-800">{metrics.unique_attackers_24h}</strong>
            </div>
          </div>

          {/* Card 3: Top Attacking IPs */}
          <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm hover:shadow-md transition-shadow">
            <div className="flex items-center justify-between text-slate-500 mb-2">
              <span className="text-sm font-semibold text-slate-700">Топ атакующих IP</span>
              <Globe className="w-5 h-5 text-brand-600" />
            </div>
            <div className="space-y-2 mt-2">
              {metrics.top_attackers.slice(0, 3).map((attacker) => (
                <div key={attacker.ip} className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="font-mono text-slate-800 font-medium">{attacker.ip}</span>
                    <span className="text-slate-500">{attacker.events_count} событий</span>
                  </div>
                  <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
                    <div
                      className="bg-brand-600 h-1.5 rounded-full"
                      style={{ width: `${attacker.share_percent}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Real-time Attack Events Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="p-5 border-b border-slate-200 flex items-center justify-between bg-slate-50/50">
          <div>
            <h2 className="text-base font-bold text-slate-900">Лента событий атак в реальном времени</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Входящая активность нарушителей, перехваченная агентами ловушек
            </p>
          </div>
          <span className="text-xs text-slate-500">
            Показаны последние 10 обращений
          </span>
        </div>

        {events.length === 0 ? (
          <EmptyState
            title="Событий атак пока нет"
            description="Ожидаем входящей активности от агентов ловушек. При атаке событие появится мгновенно."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm" aria-label="События атак">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wider">
                  <th scope="col" className="px-5 py-3">Время</th>
                  <th scope="col" className="px-5 py-3">IP Источника</th>
                  <th scope="col" className="px-5 py-3">Тип атаки</th>
                  <th scope="col" className="px-5 py-3">Ловушка</th>
                  <th scope="col" className="px-5 py-3">Статус</th>
                  <th scope="col" className="px-5 py-3 text-right">Инспектор</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {events.map((evt) => {
                  const timeStr = new Date(evt.occurred_at).toLocaleTimeString('ru-RU');
                  return (
                    <tr
                      key={evt.id}
                      onClick={() => setSelectedEvent(evt)}
                      className="hover:bg-slate-50/80 cursor-pointer transition-colors group"
                    >
                      <td className="px-5 py-3.5 font-mono text-xs text-slate-500 whitespace-nowrap">
                        {timeStr}
                      </td>
                      <td className="px-5 py-3.5">
                        <span className="font-mono font-medium text-slate-900 group-hover:text-brand-600">
                          {evt.source_ip}
                        </span>
                        {evt.source_port && (
                          <span className="text-xs text-slate-400 font-mono"> :{evt.source_port}</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-xs bg-slate-100 px-2 py-0.5 rounded text-slate-700">
                            {evt.event_type}
                          </span>
                          {evt.payload.username && (
                            <span className="text-xs text-amber-800 font-mono">
                              [{evt.payload.username}]
                            </span>
                          )}
                          {evt.payload.path && (
                            <span className="text-xs text-slate-500 font-mono max-w-[150px] truncate">
                              {evt.payload.path}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2">
                          <LevelBadge level={evt.level} />
                          <span className="text-xs text-slate-600">{evt.trap_name}</span>
                        </div>
                      </td>
                      <td className="px-5 py-3.5">
                        <SeverityBadge severity={evt.severity} />
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <span className="inline-flex items-center text-xs text-brand-600 group-hover:underline font-medium">
                          Детали <ChevronRight className="w-3.5 h-3.5 ml-0.5" />
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Selected Event Telemetry Inspector Drawer */}
      <AttackInspector event={selectedEvent} onClose={() => setSelectedEvent(null)} />
    </div>
  );
};
