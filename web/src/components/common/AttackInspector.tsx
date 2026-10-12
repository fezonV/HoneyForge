import React from 'react';
import { X, ShieldAlert, Terminal, Key, Globe, Clock, Layers } from 'lucide-react';
import { AttackEvent } from '../../api/types';
import { LevelBadge, SeverityBadge } from './Badge';

interface AttackInspectorProps {
  event: AttackEvent | null;
  onClose: () => void;
}

export const AttackInspector: React.FC<AttackInspectorProps> = ({ event, onClose }) => {
  if (!event) return null;

  const formattedTimeUtc = new Date(event.occurred_at).toUTCString();
  const formattedTimeLocal = new Date(event.occurred_at).toLocaleString('ru-RU', {
    timeZoneName: 'short',
  });

  return (
    <div
      className="fixed inset-y-0 right-0 z-50 w-full max-w-xl bg-white shadow-2xl border-l border-slate-200 flex flex-col animate-in slide-in-from-right duration-200"
      role="dialog"
      aria-labelledby="inspector-title"
    >
      {/* Header */}
      <div className="p-5 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-5 h-5 text-rose-600" />
            <h3 id="inspector-title" className="font-bold text-slate-900 text-base">
              Инспектор телеметрии атаки
            </h3>
            <span className="text-xs font-mono text-slate-500">{event.id}</span>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            Детальный снимок перехваченного сетевого взаимодействия
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-200 transition-colors"
          aria-label="Закрыть инспектор"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Status & Severity Bar */}
        <div className="flex items-center justify-between p-3.5 bg-slate-50 rounded-lg border border-slate-200">
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">Уровень риска:</span>
            <SeverityBadge severity={event.severity} />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">Ловушка:</span>
            <LevelBadge level={event.level} />
          </div>
        </div>

        {/* Network & Source */}
        <div>
          <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Globe className="w-3.5 h-3.5" /> Сетевой источник
          </h4>
          <div className="bg-slate-50 p-4 rounded-lg border border-slate-200 grid grid-cols-2 gap-4 text-sm">
            <div>
              <span className="text-xs text-slate-500 block">IP источника:</span>
              <span className="font-mono font-bold text-slate-900 select-all">{event.source_ip}</span>
              {event.source_port && (
                <span className="text-xs font-mono text-slate-500"> :{event.source_port}</span>
              )}
            </div>
            <div>
              <span className="text-xs text-slate-500 block">Целевой порт / Протокол:</span>
              <span className="font-mono font-medium text-slate-800">
                {event.destination_port} / {event.protocol}
              </span>
            </div>
            <div>
              <span className="text-xs text-slate-500 block">Ловушка:</span>
              <span className="font-medium text-slate-800">{event.trap_name}</span>
            </div>
            <div>
              <span className="text-xs text-slate-500 block">Тип события:</span>
              <span className="font-mono text-xs bg-slate-200/80 px-2 py-0.5 rounded text-slate-800">
                {event.event_type}
              </span>
            </div>
          </div>
        </div>

        {/* Time Info */}
        <div>
          <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5" /> Время фиксации
          </h4>
          <div className="bg-slate-50 p-3 rounded-lg border border-slate-200 text-xs space-y-1">
            <div className="flex justify-between">
              <span className="text-slate-500">Локальное время:</span>
              <span className="font-mono font-medium text-slate-800">{formattedTimeLocal}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">UTC:</span>
              <span className="font-mono text-slate-600">{formattedTimeUtc}</span>
            </div>
          </div>
        </div>

        {/* Captured Credentials */}
        {(event.payload.username || event.payload.password) && (
          <div>
            <h4 className="text-xs font-semibold text-amber-700 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <Key className="w-3.5 h-3.5" /> Перехваченные учётные данные (Honeytoken)
            </h4>
            <div className="bg-amber-50/70 p-4 rounded-lg border border-amber-200 text-sm space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs text-amber-800">Логин / User:</span>
                <span className="font-mono font-bold text-amber-950 bg-amber-100 px-2 py-0.5 rounded select-all">
                  {event.payload.username || '—'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-amber-800">Пароль / Secret:</span>
                <span className="font-mono font-bold text-rose-700 bg-amber-100 px-2 py-0.5 rounded select-all">
                  {event.payload.password || '—'}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Executed Commands (Medium fake-FS) */}
        {event.payload.command && (
          <div>
            <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <Terminal className="w-3.5 h-3.5" /> Команда во Fake-FS
            </h4>
            <div className="bg-slate-900 text-slate-100 p-4 rounded-lg font-mono text-xs overflow-x-auto select-all">
              <span className="text-emerald-400 mr-2">$</span>
              <span>{event.payload.command}</span>
            </div>
          </div>
        )}

        {/* HTTP Request Details */}
        {(event.payload.path || event.payload.method) && (
          <div>
            <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
              <Layers className="w-3.5 h-3.5" /> HTTP Детали
            </h4>
            <div className="bg-slate-50 p-4 rounded-lg border border-slate-200 space-y-2 text-xs">
              <div className="flex gap-2 items-center">
                <span className="font-bold bg-brand-100 text-brand-800 px-2 py-0.5 rounded">
                  {event.payload.method || 'GET'}
                </span>
                <span className="font-mono text-slate-800 select-all">{event.payload.path}</span>
              </div>
              {event.payload.user_agent && (
                <div className="mt-2 text-slate-500 break-all">
                  <span className="font-semibold block text-slate-600">User-Agent:</span>
                  {event.payload.user_agent}
                </div>
              )}
            </div>
          </div>
        )}

        {/* IoC Flags */}
        {event.ioc_flags && event.ioc_flags.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
              Индикаторы компрометации (IoC)
            </h4>
            <div className="flex flex-wrap gap-1.5">
              {event.ioc_flags.map((flag) => (
                <span
                  key={flag}
                  className="px-2.5 py-1 rounded bg-rose-100 text-rose-800 text-xs font-semibold border border-rose-200"
                >
                  {flag}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-4 bg-slate-50 border-t border-slate-200 flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-800 rounded-lg text-sm font-medium transition-colors"
        >
          Закрыть
        </button>
      </div>
    </div>
  );
};
