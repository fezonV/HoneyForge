import React, { useState, useEffect, useCallback } from 'react';
import {
  Key,
  Play,
  Square,
  RefreshCw,
  Copy,
  Check,
  Lock,
  Terminal,
} from 'lucide-react';
import { Trap } from '../api/types';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useNotification } from '../context/NotificationContext';
import { StatusBadge, LevelBadge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { Modal } from '../components/common/Modal';
import { LoadingSkeleton, ErrorState, EmptyState } from '../components/common/StateViews';

export const TrapsScreen: React.FC = () => {
  const { role } = useAuth();
  const { notify } = useNotification();
  const [traps, setTraps] = useState<Trap[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Enrollment Token Modal
  const [activeTokenModal, setActiveTokenModal] = useState<{
    trap: Trap;
    token: string;
    expiresAt: string;
  } | null>(null);
  const [isCopied, setIsCopied] = useState<boolean>(false);

  const fetchTraps = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await api.traps.list();
      setTraps(data);
    } catch (err: any) {
      setError(err.message || 'Ошибка загрузки реестра ловушек');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTraps();
  }, [fetchTraps]);

  const handleGenerateToken = async (trap: Trap) => {
    try {
      const res = await api.traps.generateToken(trap.id);
      setActiveTokenModal({
        trap,
        token: res.token,
        expiresAt: res.expires_at,
      });
      setIsCopied(false);
      notify('success', 'Токен сгенерирован', `Одноразовый токен для ловушки ${trap.name} готов`);
    } catch (err: any) {
      notify('error', 'Ошибка генерации токена', err.message);
    }
  };

  const handleSendCommand = async (trap: Trap, cmd: 'start' | 'stop' | 'apply_profile') => {
    try {
      await api.traps.sendCommand(trap.id, cmd);
      const actionLabels = {
        start: 'Команда запуска отправлена',
        stop: 'Команда остановки отправлена',
        apply_profile: 'Профиль отправлен на синхронизацию',
      };
      notify('info', actionLabels[cmd], `Ловушка: ${trap.name}`);
      fetchTraps();
    } catch (err: any) {
      notify('error', 'Ошибка отправки команды', err.message);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  const isViewer = role === 'viewer';

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      {/* Title */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Реестр ловушек (Парк приманок)</h1>
          <p className="text-sm text-slate-500 mt-1">
            Мониторинг статусов (online/offline/last-seen), ревизий профилей и управление агентами (FR-C2)
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          leftIcon={<RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />}
          onClick={fetchTraps}
          disabled={isLoading}
        >
          Обновить статус
        </Button>
      </div>

      {isLoading ? (
        <LoadingSkeleton rows={5} />
      ) : error ? (
        <ErrorState message={error} onRetry={fetchTraps} />
      ) : traps.length === 0 ? (
        <EmptyState
          title="Ловушки не зарегистрированы"
          description="Зарегистрируйте первую ловушку в контуре для начала сбора телеметрии"
        />
      ) : (
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm" aria-label="Таблица ловушек">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600 uppercase tracking-wider">
                  <th scope="col" className="px-5 py-3.5">Ловушка</th>
                  <th scope="col" className="px-5 py-3.5">Статус</th>
                  <th scope="col" className="px-5 py-3.5">Уровень</th>
                  <th scope="col" className="px-5 py-3.5">Назначенный профиль</th>
                  <th scope="col" className="px-5 py-3.5">Сетевой адрес</th>
                  <th scope="col" className="px-5 py-3.5">Активность (24ч)</th>
                  <th scope="col" className="px-5 py-3.5 text-right">Управление</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {traps.map((trap) => {
                  const isRevisionSynced = trap.profile_revision === trap.applied_revision;
                  return (
                    <tr key={trap.id} className="hover:bg-slate-50/70 transition-colors">
                      <td className="px-5 py-4">
                        <div className="font-semibold text-slate-900">{trap.name}</div>
                        <div className="text-xs text-slate-400 font-mono mt-0.5">{trap.id}</div>
                      </td>
                      <td className="px-5 py-4">
                        <StatusBadge status={trap.status} />
                      </td>
                      <td className="px-5 py-4">
                        <LevelBadge level={trap.level} />
                      </td>
                      <td className="px-5 py-4">
                        <div className="text-xs font-medium text-slate-800">{trap.profile_name}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-1">
                          <span>rev {trap.applied_revision}</span>
                          {!isRevisionSynced && (
                            <span className="text-amber-600 font-semibold" title="Требуется синхронизация">
                              (ожидает v{trap.profile_revision})
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <div className="font-mono text-xs text-slate-800">{trap.ip_address}</div>
                        <div className="text-xs text-slate-400">{trap.location || 'DMZ'}</div>
                      </td>
                      <td className="px-5 py-4">
                        <span className="font-semibold text-slate-800">{trap.attacks_count_24h}</span>
                        <span className="text-xs text-slate-400 ml-1">атак</span>
                      </td>
                      <td className="px-5 py-4 text-right">
                        {isViewer ? (
                          <span className="text-xs text-slate-400 inline-flex items-center gap-1">
                            <Lock className="w-3 h-3" /> Только чтение
                          </span>
                        ) : (
                          <div className="inline-flex items-center gap-1.5 justify-end">
                            <button
                              type="button"
                              onClick={() => handleGenerateToken(trap)}
                              className="px-2.5 py-1 text-xs font-medium bg-brand-50 text-brand-700 hover:bg-brand-100 border border-brand-200 rounded-md transition-colors inline-flex items-center gap-1"
                              title="Сгенерировать Enrollment Token для агента"
                            >
                              <Key className="w-3 h-3" /> Токен
                            </button>
                            <button
                              type="button"
                              onClick={() => handleSendCommand(trap, 'start')}
                              className="p-1 text-slate-500 hover:text-emerald-700 hover:bg-emerald-50 rounded"
                              title="Запустить ловушку"
                            >
                              <Play className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleSendCommand(trap, 'stop')}
                              className="p-1 text-slate-500 hover:text-rose-700 hover:bg-rose-50 rounded"
                              title="Остановить ловушку"
                            >
                              <Square className="w-3.5 h-3.5" />
                            </button>
                          </div>
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

      {/* Enrollment Token Dialog */}
      {activeTokenModal && (
        <Modal
          isOpen={!!activeTokenModal}
          onClose={() => setActiveTokenModal(null)}
          title={`Enrollment Token: ${activeTokenModal.trap.name}`}
          description="Одноразовый секретный токен регистрации агента в центре управления"
          maxWidth="lg"
        >
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Одноразовый токен авторизации (Secret)
              </label>
              <div className="flex items-center gap-2 bg-slate-100 p-2.5 rounded-lg border border-slate-200 font-mono text-xs select-all">
                <span className="flex-1 font-bold text-slate-900 break-all">{activeTokenModal.token}</span>
                <button
                  type="button"
                  onClick={() => copyToClipboard(activeTokenModal.token)}
                  className="p-1.5 text-slate-500 hover:text-slate-800 rounded bg-white shadow-xs border border-slate-200"
                  title="Копировать токен"
                >
                  {isCopied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5" /> Команда развертывания агента на хосте ловушки
              </label>
              <div className="bg-slate-900 text-slate-100 p-3.5 rounded-lg font-mono text-xs overflow-x-auto select-all">
                <code>
                  curl -sSL https://c2.internal/agent/install.sh | sudo bash -s -- --token={activeTokenModal.token}
                </code>
              </div>
            </div>

            <p className="text-xs text-amber-800 bg-amber-50 p-3 rounded-lg border border-amber-200">
              ⚠️ <strong>Важно:</strong> Токен истекает через 60 минут. Токен не отображается наблюдателям (Viewer) и инвалидируется сразу после успешной регистрации хоста.
            </p>

            <div className="flex justify-end pt-2">
              <Button variant="primary" size="sm" onClick={() => setActiveTokenModal(null)}>
                Готово
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};
