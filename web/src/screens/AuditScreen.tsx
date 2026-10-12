import React, { useState, useEffect, useCallback } from 'react';
import { RefreshCw, AlertTriangle, CheckCircle } from 'lucide-react';
import { AuditLogEntry } from '../api/types';
import { api } from '../api/client';
import { Button } from '../components/common/Button';
import { RoleBadge } from '../components/common/Badge';
import { LoadingSkeleton, ErrorState, EmptyState } from '../components/common/StateViews';

export const AuditScreen: React.FC = () => {
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAudit = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await api.audit.list();
      setAuditLogs(data);
    } catch (err: any) {
      setError(err.message || 'Ошибка загрузки журнала аудита');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAudit();
  }, [fetchAudit]);

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      {/* Title */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Журнал аудита действий</h1>
          <p className="text-sm text-slate-500 mt-1">
            Неизменяемый журнал операций операторов, изменений профилей и авторизаций (FR-C5 / Раздел 10)
          </p>
        </div>

        <Button
          variant="outline"
          size="sm"
          leftIcon={<RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />}
          onClick={fetchAudit}
          disabled={isLoading}
        >
          Обновить
        </Button>
      </div>

      {isLoading ? (
        <LoadingSkeleton rows={5} />
      ) : error ? (
        <ErrorState message={error} onRetry={fetchAudit} />
      ) : auditLogs.length === 0 ? (
        <EmptyState
          title="Записей аудита нет"
          description="Журнал пуст. Все административные действия будут автоматически фиксироваться здесь."
        />
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm" aria-label="Таблица аудита">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wider">
                  <th scope="col" className="px-5 py-3.5">Время UTC</th>
                  <th scope="col" className="px-5 py-3.5">Оператор</th>
                  <th scope="col" className="px-5 py-3.5">Действие</th>
                  <th scope="col" className="px-5 py-3.5">Ресурс</th>
                  <th scope="col" className="px-5 py-3.5">Подробности операции</th>
                  <th scope="col" className="px-5 py-3.5 text-right">Статус</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {auditLogs.map((log) => {
                  const utcTime = new Date(log.timestamp).toUTCString().replace('GMT', 'UTC');
                  const isSuccess = log.status === 'success';

                  return (
                    <tr key={log.id} className="hover:bg-slate-50/70 transition-colors">
                      <td className="px-5 py-4 font-mono text-xs text-slate-500 whitespace-nowrap">
                        {utcTime}
                      </td>
                      <td className="px-5 py-4">
                        <div className="font-semibold text-slate-900">{log.operator_name}</div>
                        <RoleBadge role={log.operator_role} />
                      </td>
                      <td className="px-5 py-4">
                        <span className="font-mono text-xs bg-slate-100 px-2 py-0.5 rounded text-slate-800">
                          {log.action}
                        </span>
                      </td>
                      <td className="px-5 py-4">
                        <span className="text-xs font-medium text-slate-600">
                          {log.resource_type}: {log.resource_id}
                        </span>
                      </td>
                      <td className="px-5 py-4 text-xs text-slate-700 max-w-md">
                        {log.details}
                      </td>
                      <td className="px-5 py-4 text-right">
                        {isSuccess ? (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200">
                            <CheckCircle className="w-3.5 h-3.5" /> Успешно
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-rose-700 bg-rose-50 px-2 py-0.5 rounded border border-rose-200">
                            <AlertTriangle className="w-3.5 h-3.5" /> Ошибка 403
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
