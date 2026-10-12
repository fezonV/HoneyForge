import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Server, Lock } from 'lucide-react';
import { Profile, InteractionLevel } from '../api/types';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useNotification } from '../context/NotificationContext';
import { LevelBadge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { Modal } from '../components/common/Modal';
import { LoadingSkeleton, ErrorState, EmptyState } from '../components/common/StateViews';

export const ProfilesScreen: React.FC = () => {
  const { role } = useAuth();
  const { notify } = useNotification();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Modal State
  const [isCreateOpen, setIsCreateOpen] = useState<boolean>(false);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [newName, setNewName] = useState<string>('');
  const [newDesc, setNewDesc] = useState<string>('');
  const [newLevel, setNewLevel] = useState<InteractionLevel>('low');
  const [newPort, setNewPort] = useState<number>(80);
  const [newBanner, setNewBanner] = useState<string>('nginx/1.24.0');
  const [newDecoyPath, setNewDecoyPath] = useState<string>('/static/assets/bundle.js');
  const [newProcessName, setNewProcessName] = useState<string>('systemd-timesyncd');

  const fetchProfiles = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await api.profiles.list();
      setProfiles(data);
    } catch (err: any) {
      setError(err.message || 'Ошибка загрузки списка профилей');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProfiles();
  }, [fetchProfiles]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;

    setIsSubmitting(true);
    try {
      const created = await api.profiles.create({
        name: newName.trim(),
        description: newDesc.trim() || 'Без описания',
        level: newLevel,
        services: [
          {
            name: `${newName.trim()} Service`,
            port: Number(newPort),
            protocol: 'tcp',
            banner: newBanner.trim(),
          },
        ],
        masking: {
          jitter_enabled: true,
          min_jitter_sec: 2,
          max_jitter_sec: 10,
          decoy_path: newDecoyPath.trim(),
          hidden_service_name: newProcessName.trim(),
        },
      });

      notify('success', 'Профиль создан', `Профиль "${created.name}" успешно добавлен в реестр`);
      setIsCreateOpen(false);
      resetForm();
      fetchProfiles();
    } catch (err: any) {
      notify('error', 'Ошибка создания профиля', err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`Удалить профиль "${name}"?`)) return;

    try {
      await api.profiles.delete(id);
      notify('success', 'Профиль удален', `Профиль "${name}" удален`);
      fetchProfiles();
    } catch (err: any) {
      notify('error', 'Не удалось удалить профиль', err.message);
    }
  };

  const resetForm = () => {
    setNewName('');
    setNewDesc('');
    setNewLevel('low');
    setNewPort(80);
    setNewBanner('nginx/1.24.0');
    setNewDecoyPath('/static/assets/bundle.js');
    setNewProcessName('systemd-timesyncd');
  };

  const isViewer = role === 'viewer';

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Профили ловушек</h1>
          <p className="text-sm text-slate-500 mt-1">
            Шаблоны конфигурации сервисов, портов, баннеров и параметров маскировки (FR-C1)
          </p>
        </div>

        <div>
          {isViewer ? (
            <div className="inline-flex items-center gap-1.5 px-3 py-2 bg-slate-100 text-slate-500 rounded-lg text-sm border border-slate-200 cursor-not-allowed">
              <Lock className="w-4 h-4" />
              <span>Создание профилей недоступно (Viewer)</span>
            </div>
          ) : (
            <Button
              variant="primary"
              size="md"
              leftIcon={<Plus className="w-4 h-4" />}
              onClick={() => setIsCreateOpen(true)}
            >
              Создать профиль
            </Button>
          )}
        </div>
      </div>

      {isLoading ? (
        <LoadingSkeleton rows={4} />
      ) : error ? (
        <ErrorState message={error} onRetry={fetchProfiles} />
      ) : profiles.length === 0 ? (
        <EmptyState
          title="Профили не найдены"
          description="Создайте первый профиль для привязки к honeypot-ловушкам"
          actionText={isViewer ? undefined : 'Создать профиль'}
          onAction={isViewer ? undefined : () => setIsCreateOpen(true)}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {profiles.map((prof) => (
            <div
              key={prof.id}
              className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 flex flex-col justify-between hover:border-slate-300 transition-colors"
            >
              <div>
                <div className="flex items-start justify-between gap-2 mb-2">
                  <h3 className="font-bold text-slate-900 text-base">{prof.name}</h3>
                  <LevelBadge level={prof.level} />
                </div>
                <p className="text-xs text-slate-500 min-h-[36px] line-clamp-2">{prof.description}</p>

                {/* Services list */}
                <div className="mt-4 pt-3 border-t border-slate-100 space-y-2">
                  <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
                    Сервисы и порты:
                  </span>
                  {prof.services.map((srv, idx) => (
                    <div
                      key={idx}
                      className="bg-slate-50 p-2.5 rounded-lg border border-slate-100 flex items-center justify-between text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <Server className="w-3.5 h-3.5 text-slate-400" />
                        <span className="font-medium text-slate-800">{srv.name}</span>
                      </div>
                      <span className="font-mono bg-white px-2 py-0.5 rounded border border-slate-200 text-slate-700">
                        {srv.port}/{srv.protocol}
                      </span>
                    </div>
                  ))}
                </div>

                {/* Masking features */}
                <div className="mt-3 pt-3 border-t border-slate-100 space-y-1.5 text-xs">
                  <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
                    Маскировка канала:
                  </span>
                  <div className="flex justify-between text-slate-600">
                    <span>Decoy-путь:</span>
                    <span className="font-mono text-[11px] text-slate-800 bg-slate-100 px-1.5 py-0.5 rounded">
                      {prof.masking.decoy_path}
                    </span>
                  </div>
                  <div className="flex justify-between text-slate-600">
                    <span>Имя процесса:</span>
                    <span className="font-mono text-[11px] text-slate-800">
                      {prof.masking.hidden_service_name}
                    </span>
                  </div>
                </div>
              </div>

              {/* Card Footer */}
              <div className="mt-5 pt-4 border-t border-slate-100 flex items-center justify-between">
                <span className="text-xs text-slate-400 font-mono">Ревизия: rev {prof.revision}</span>

                {!isViewer && (
                  <button
                    type="button"
                    onClick={() => handleDelete(prof.id, prof.name)}
                    className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                    title="Удалить профиль"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create Profile Modal */}
      <Modal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        title="Создание профиля ловушки"
        description="Задайте параметры сервисов и маскировки канала связи с центром"
        maxWidth="lg"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Название профиля</label>
            <input
              type="text"
              required
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Например: Fake SSH Ubuntu 22.04"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Описание назначения</label>
            <textarea
              rows={2}
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="Краткое описание эмулируемой среды и задачи ловушки..."
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Уровень взаимодействия</label>
              <select
                value={newLevel}
                onChange={(e) => setNewLevel(e.target.value as InteractionLevel)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:ring-2 focus:ring-brand-500 focus:outline-none"
              >
                <option value="low">Low (только порты/баннеры)</option>
                <option value="medium">Medium (логика fake-сервиса)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Порт сервиса</label>
              <input
                type="number"
                min={1}
                max={65535}
                required
                value={newPort}
                onChange={(e) => setNewPort(Number(e.target.value))}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
              >
              </input>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">Эмулируемый баннер сервиса</label>
            <input
              type="text"
              value={newBanner}
              onChange={(e) => setNewBanner(e.target.value)}
              placeholder="SSH-2.0-OpenSSH_8.9p1 Ubuntu..."
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm font-mono focus:ring-2 focus:ring-brand-500 focus:outline-none"
            />
          </div>

          <div className="pt-2 border-t border-slate-200">
            <h4 className="text-xs font-bold text-slate-900 uppercase tracking-wider mb-2">
              Параметры маскировки связи (Раздел 9 ТЗ)
            </h4>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-slate-600 mb-1">Decoy URL путь (приём телеметрии)</label>
                <input
                  type="text"
                  value={newDecoyPath}
                  onChange={(e) => setNewDecoyPath(e.target.value)}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-600 mb-1">Маскировка имени процесса</label>
                <input
                  type="text"
                  value={newProcessName}
                  onChange={(e) => setNewProcessName(e.target.value)}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-xs font-mono"
                />
              </div>
            </div>
          </div>

          <div className="pt-4 flex justify-end gap-2.5">
            <Button type="button" variant="outline" size="sm" onClick={() => setIsCreateOpen(false)}>
              Отмена
            </Button>
            <Button type="submit" variant="primary" size="sm" isLoading={isSubmitting}>
              Сохранить профиль
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
