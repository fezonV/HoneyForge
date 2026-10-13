import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Trash2, Server, Lock, Eye, Rocket, RefreshCw, Sliders } from 'lucide-react';
import { Profile } from '../api/types';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useNotification } from '../context/NotificationContext';
import { LevelBadge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { Modal } from '../components/common/Modal';
import { LoadingSkeleton, ErrorState, EmptyState } from '../components/common/StateViews';
import { ProfileWizardModal } from '../components/profiles/ProfileWizardModal';
import { DecoyPreviewStub } from '../components/profiles/wizard/DecoyPreviewStub';

export const ProfilesScreen: React.FC = () => {
  const { role } = useAuth();
  const { notify } = useNotification();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Profile Wizard Modal State
  const [isWizardOpen, setIsWizardOpen] = useState<boolean>(false);

  // View Existing Profile Modal State
  const [inspectProfile, setInspectProfile] = useState<Profile | null>(null);
  const [inspectTab, setInspectTab] = useState<'preview' | 'config'>('preview');

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

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`Удалить профиль "${name}"? Все ловушки с этим профилем потребуют переназначения.`)) {
      return;
    }

    try {
      await api.profiles.delete(id);
      notify('success', 'Профиль удалён', `Профиль "${name}" успешно удалён из реестра`);
      fetchProfiles();
    } catch (err: any) {
      notify('error', 'Не удалось удалить профиль', err.message);
    }
  };

  const handleDeployInstance = (prof: Profile) => {
    sessionStorage.setItem('hf_deploy_profile_id', prof.id);
    sessionStorage.setItem('hf_deploy_profile_name', prof.name);
    window.dispatchEvent(
      new CustomEvent('honeyforge-deploy-profile', {
        detail: { profileId: prof.id, profileName: prof.name, revision: prof.revision },
      })
    );
    window.location.hash = 'traps';
    notify('info', 'Переход к развёртыванию', `Создание ловушки с профилем "${prof.name}" (rev ${prof.revision})`);
  };

  const isViewer = role === 'viewer';

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      {/* Title & Actions Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Реестр профилей ловушек</h1>
          <p className="text-sm text-slate-500 mt-1">
            Конструктор поведения приманок (Low/Medium), управление версиями и безопасный предпросмотр (FR-C1)
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          {!isViewer && (
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Plus className="w-4 h-4" />}
              onClick={() => setIsWizardOpen(true)}
            >
              Конструктор профиля (Мастер)
            </Button>
          )}

          <Button
            variant="outline"
            size="sm"
            leftIcon={<RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />}
            onClick={fetchProfiles}
            disabled={isLoading}
          >
            Обновить
          </Button>
        </div>
      </div>

      {/* Profiles Grid */}
      {isLoading ? (
        <LoadingSkeleton rows={4} />
      ) : error ? (
        <ErrorState message={error} onRetry={fetchProfiles} />
      ) : profiles.length === 0 ? (
        <EmptyState
          title="Профили не созданы"
          description="Создайте первый профиль поведения с помощью мастера для настройки парка ловушек"
          actionText={!isViewer ? 'Запустить конструктор профилей' : undefined}
          onAction={() => setIsWizardOpen(true)}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {profiles.map((prof) => {
            return (
              <div
                key={prof.id}
                className="bg-white rounded-xl border border-slate-200 p-5 shadow-2xs hover:shadow-md transition-shadow flex flex-col justify-between"
              >
                <div>
                  {/* Card Header */}
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <span className="font-mono text-[11px] text-slate-400">
                      rev {prof.revision} · {prof.id.substring(0, 8)}...
                    </span>
                    <LevelBadge level={prof.level} />
                  </div>

                  <h3 className="font-bold text-slate-900 text-base leading-snug line-clamp-2">
                    {prof.name}
                  </h3>
                  <p className="text-xs text-slate-500 mt-1 line-clamp-2 leading-relaxed">
                    {prof.description || 'Без описания'}
                  </p>

                  {/* Services summary */}
                  <div className="mt-4 pt-3 border-t border-slate-100 space-y-2 text-xs">
                    <div className="flex items-center justify-between text-slate-600">
                      <span className="flex items-center gap-1.5 font-medium">
                        <Server className="w-3.5 h-3.5 text-slate-400" /> Сервисы:
                      </span>
                      <span className="font-mono text-xs font-semibold text-slate-800">
                        {prof.services.map((s) => `:${s.port}`).join(', ')}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-slate-600">
                      <span>Маскировка:</span>
                      <span className="text-[11px] text-slate-700 font-mono">
                        {prof.masking?.hidden_service_name || 'дефолтная'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Card Footer Actions */}
                <div className="mt-5 pt-4 border-t border-slate-100 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setInspectProfile(prof)}
                      className="px-2.5 py-1 text-xs font-medium text-slate-700 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors inline-flex items-center gap-1"
                      title="Предпросмотр приманки и параметров"
                    >
                      <Eye className="w-3.5 h-3.5" /> Предпросмотр
                    </button>

                    {!isViewer && (
                      <button
                        type="button"
                        onClick={() => handleDeployInstance(prof)}
                        className="px-2.5 py-1 text-xs font-medium text-brand-700 hover:text-brand-900 bg-brand-50 hover:bg-brand-100 border border-brand-200 rounded-md transition-colors inline-flex items-center gap-1"
                        title="Создать экземпляр ловушки с этим профилем (FE2-01)"
                      >
                        <Rocket className="w-3.5 h-3.5" /> Экземпляр
                      </button>
                    )}
                  </div>

                  {!isViewer && (
                    <button
                      type="button"
                      onClick={() => handleDelete(prof.id, prof.name)}
                      className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded transition-colors"
                      title="Удалить профиль"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Profile Wizard Modal (FE-02) */}
      <ProfileWizardModal
        isOpen={isWizardOpen}
        onClose={() => setIsWizardOpen(false)}
        onProfileCreated={() => {
          fetchProfiles();
        }}
        onDeployInstance={(created) => {
          handleDeployInstance(created);
        }}
      />

      {/* Inspect Profile & Live Decoy Preview Modal */}
      {inspectProfile && (
        <Modal
          isOpen={!!inspectProfile}
          onClose={() => setInspectProfile(null)}
          title={`Профиль: ${inspectProfile.name} (rev ${inspectProfile.revision})`}
          description="Безопасный предпросмотр веб-интерфейса и сводка параметров конфигурации"
          maxWidth="xl"
        >
          <div className="space-y-4">
            {/* Header Tabs */}
            <div className="flex items-center justify-between border-b border-slate-200 pb-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setInspectTab('preview')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 ${
                    inspectTab === 'preview'
                      ? 'bg-brand-50 text-brand-700 ring-1 ring-brand-500/20'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  <Eye className="w-3.5 h-3.5" /> Предпросмотр TL-01
                </button>
                <button
                  type="button"
                  onClick={() => setInspectTab('config')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1.5 ${
                    inspectTab === 'config'
                      ? 'bg-brand-50 text-brand-700 ring-1 ring-brand-500/20'
                      : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  <Sliders className="w-3.5 h-3.5" /> Параметры конфигурации
                </button>
              </div>

              {isViewer && (
                <span className="text-[11px] text-slate-500 flex items-center gap-1 bg-slate-100 px-2 py-0.5 rounded">
                  <Lock className="w-3 h-3" /> Пароли скрыты сервером (Redacted)
                </span>
              )}
            </div>

            {inspectTab === 'preview' ? (
              <DecoyPreviewStub
                name={inspectProfile.name}
                config={
                  inspectProfile.config || {
                    template_id: inspectProfile.level === 'medium' ? 'medium-http' : 'low-http',
                    level: inspectProfile.level,
                    services: inspectProfile.services,
                    visible_texts: {
                      title: inspectProfile.name,
                      login_prompt: inspectProfile.description,
                      success: 'Доступ разрешён',
                      failure: 'Неверные данные',
                    },
                    synthetic_credentials: [],
                    fake_fs: [],
                    logging: { categories: ['connection.opened', 'http.request'] },
                    channel: { tls_required: true, heartbeat_seconds: 15, sync_seconds: 30 },
                  }
                }
              />
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3 text-xs bg-slate-50 p-3.5 rounded-lg border border-slate-200">
                  <div>
                    <span className="text-slate-500">ID профиля:</span>
                    <span className="font-mono text-slate-800 ml-1 font-semibold">{inspectProfile.id}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Ревизия:</span>
                    <span className="font-bold text-brand-700 ml-1">v{inspectProfile.revision}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Уровень:</span>
                    <span className="font-medium text-slate-800 ml-1 uppercase">{inspectProfile.level}</span>
                  </div>
                  <div>
                    <span className="text-slate-500">Создан (UTC):</span>
                    <span className="font-mono text-slate-800 ml-1">
                      {inspectProfile.created_at ? new Date(inspectProfile.created_at).toUTCString().replace('GMT', 'UTC') : '—'}
                    </span>
                  </div>
                </div>

                <div className="bg-slate-900 text-slate-100 p-3 rounded-lg text-xs font-mono max-h-60 overflow-y-auto">
                  <pre>{JSON.stringify(inspectProfile.config || inspectProfile, null, 2)}</pre>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between pt-3 border-t border-slate-100">
              {!isViewer && (
                <Button
                  variant="primary"
                  size="sm"
                  leftIcon={<Rocket className="w-3.5 h-3.5" />}
                  onClick={() => {
                    const prof = inspectProfile;
                    setInspectProfile(null);
                    handleDeployInstance(prof);
                  }}
                >
                  Создать экземпляр ловушки из профиля
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => setInspectProfile(null)}>
                Закрыть
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};
