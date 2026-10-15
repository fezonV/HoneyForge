import React, { useState, useEffect, useCallback } from 'react';
import {
  Plus,
  Trash2,
  Server,
  Eye,
  Rocket,
  RefreshCw,
  Search,
  Copy,
  Edit3,
  Layers,
  Filter,
} from 'lucide-react';
import { Profile, Trap } from '../api/types';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useNotification } from '../context/NotificationContext';
import { LevelBadge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { LoadingSkeleton, ErrorState, EmptyState } from '../components/common/StateViews';
import { ProfileWizardModal } from '../components/profiles/ProfileWizardModal';
import { ProfileDetailModal } from '../components/profiles/ProfileDetailModal';
import { ProfileDeleteModal } from '../components/profiles/ProfileDeleteModal';

export const ProfilesScreen: React.FC = () => {
  const { role } = useAuth();
  const { notify } = useNotification();
  const isViewer = role === 'viewer';

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [traps, setTraps] = useState<Trap[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [levelFilter, setLevelFilter] = useState<'all' | 'low' | 'medium'>('all');

  // Modals state
  const [isWizardOpen, setIsWizardOpen] = useState<boolean>(false);
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [detailProfile, setDetailProfile] = useState<Profile | null>(null);
  const [deletingProfile, setDeletingProfile] = useState<Profile | null>(null);
  const [isDeleting, setIsDeleting] = useState<boolean>(false);
  const [isActionLoading, setIsActionLoading] = useState<boolean>(false);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [profilesData, trapsData] = await Promise.all([
        api.profiles.list(),
        api.traps.list(),
      ]);
      setProfiles(profilesData);
      setTraps(trapsData);
    } catch (err: any) {
      setError(err.message || 'Ошибка загрузки данных каталога профилей');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleEditProfile = async (prof: Profile) => {
    setIsActionLoading(true);
    try {
      const revision = await api.profiles.sensitiveRevision(prof.id, prof.revision);
      setEditingProfile({ ...prof, config: revision.config });
      setIsWizardOpen(true);
    } catch (cause) {
      notify('error', 'Не удалось открыть профиль', cause instanceof Error ? cause.message : 'Ошибка чтения версии');
    } finally { setIsActionLoading(false); }
  };

  const handleCopyProfile = async (prof: Profile) => {
    setIsActionLoading(true);
    try {
      const copy = await api.profiles.copy(prof);
      notify(
        'success',
        'Профиль скопирован',
        `Создана независимая копия "${copy.name}" (v1) с отдельной историей ревизий`
      );
      await fetchData();
    } catch (err: any) {
      notify('error', 'Не удалось скопировать профиль', err.message);
    } finally {
      setIsActionLoading(false);
    }
  };

  const handleDelete = async (profileId: string) => {
    setIsDeleting(true);
    try {
      await api.profiles.delete(profileId);
      notify('success', 'Профиль удалён', 'Профиль успешно удалён из реестра');
      setDeletingProfile(null);
      await fetchData();
    } catch (err: any) {
      notify('error', 'Не удалось удалить профиль', err.message || 'Ошибка удаления');
      if (err.status === 409) {
        try { setTraps(await api.traps.list()); } catch { setError('Не удалось перечитать связанные экземпляры'); }
      }
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDeployInstance = (prof: Profile, revision?: number) => {
    const rev = revision !== undefined ? revision : prof.revision;
    sessionStorage.setItem('hf_deploy_profile_id', prof.id);
    sessionStorage.setItem('hf_deploy_profile_name', prof.name);
    sessionStorage.setItem('hf_deploy_profile_revision', String(rev));
    window.dispatchEvent(
      new CustomEvent('honeyforge-deploy-profile', {
        detail: { profileId: prof.id, profileName: prof.name, revision: rev },
      })
    );
    window.location.hash = 'traps';
    notify('info', 'Переход к развёртыванию', `Создание ловушки с профилем "${prof.name}" (v${rev})`);
  };

  const getLinkedTraps = (profileId: string): Trap[] => {
    return traps.filter((t) => t.desired_profile_id === profileId || t.applied_profile_id === profileId);
  };

  // Filter profiles
  const filteredProfiles = profiles.filter((prof) => {
    const query = searchQuery.trim().toLowerCase();
    const matchesSearch =
      !query ||
      prof.name.toLowerCase().includes(query) ||
      prof.description?.toLowerCase().includes(query) ||
      prof.id.toLowerCase().includes(query);

    const matchesLevel = levelFilter === 'all' || prof.level === levelFilter;
    return matchesSearch && matchesLevel;
  });

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      {/* Title & Actions Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Реестр профилей ловушек</h1>
          <p className="text-sm text-slate-500 mt-1">
            Конструктор поведения приманок (Low/Medium), управление версиями, версионный дифф и безопасный предпросмотр (FR-C1, FR-C2)
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          {!isViewer && (
            <Button
              variant="primary"
              size="sm"
              leftIcon={<Plus className="w-4 h-4" />}
              onClick={() => {
                setEditingProfile(null);
                setIsWizardOpen(true);
              }}
            >
              Конструктор профиля (Мастер)
            </Button>
          )}

          <Button
            variant="outline"
            size="sm"
            leftIcon={<RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />}
            onClick={fetchData}
            disabled={isLoading || isActionLoading}
          >
            Обновить
          </Button>
        </div>
      </div>

      {/* Search & Level Filter Bar */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-2xs flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Поиск профилей по названию или описанию..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20 focus:border-brand-500 transition-all"
          />
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto">
          <span className="text-xs text-slate-400 flex items-center gap-1 mr-1">
            <Filter className="w-3.5 h-3.5" /> Уровень:
          </span>
          <button
            type="button"
            onClick={() => setLevelFilter('all')}
            className={`px-3 py-1 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
              levelFilter === 'all'
                ? 'bg-slate-900 text-white shadow-2xs'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            Все ({profiles.length})
          </button>
          <button
            type="button"
            onClick={() => setLevelFilter('low')}
            className={`px-3 py-1 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
              levelFilter === 'low'
                ? 'bg-slate-900 text-white shadow-2xs'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            Low ({profiles.filter((p) => p.level === 'low').length})
          </button>
          <button
            type="button"
            onClick={() => setLevelFilter('medium')}
            className={`px-3 py-1 text-xs font-semibold rounded-lg transition-colors cursor-pointer ${
              levelFilter === 'medium'
                ? 'bg-slate-900 text-white shadow-2xs'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            Medium ({profiles.filter((p) => p.level === 'medium').length})
          </button>
        </div>
      </div>

      {/* Profiles Grid */}
      {isLoading ? (
        <LoadingSkeleton rows={4} />
      ) : error ? (
        <ErrorState message={error} onRetry={fetchData} />
      ) : filteredProfiles.length === 0 ? (
        <EmptyState
          title={searchQuery || levelFilter !== 'all' ? 'Профили не найдены' : 'Профили не созданы'}
          description={
            searchQuery || levelFilter !== 'all'
              ? 'Попробуйте изменить параметры поиска или фильтрации'
              : 'Создайте первый профиль поведения с помощью мастера для настройки парка ловушек'
          }
          actionText={!isViewer && !searchQuery && levelFilter === 'all' ? 'Запустить конструктор профилей' : undefined}
          onAction={() => {
            setEditingProfile(null);
            setIsWizardOpen(true);
          }}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredProfiles.map((prof) => {
            const linkedTraps = getLinkedTraps(prof.id);
            const linkedCount = linkedTraps.length;

            return (
              <div
                key={prof.id}
                role="article"
                aria-label={prof.name}
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
                        {prof.services && prof.services.length > 0
                          ? prof.services.map((s) => `:${s.port}`).join(', ')
                          : '—'}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-slate-600">
                      <span className="flex items-center gap-1.5 font-medium">
                        <Layers className="w-3.5 h-3.5 text-slate-400" /> Связанные ловушки:
                      </span>
                      <span
                        className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                          linkedCount > 0
                            ? 'bg-brand-50 text-brand-700 border border-brand-200'
                            : 'bg-slate-100 text-slate-500'
                        }`}
                      >
                        {linkedCount} {linkedCount === 1 ? 'ловушка' : linkedCount >= 2 && linkedCount <= 4 ? 'ловушки' : 'ловушек'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Card Footer Actions */}
                <div className="mt-5 pt-4 border-t border-slate-100 flex items-center justify-between gap-1.5">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setDetailProfile(prof)}
                      className="px-2.5 py-1 text-xs font-medium text-slate-700 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors inline-flex items-center gap-1 cursor-pointer"
                      title="Детали профиля, версии, дифф и предпросмотр"
                    >
                      <Eye className="w-3.5 h-3.5" /> Предпросмотр
                    </button>

                    {!isViewer && (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            handleEditProfile(prof);
                          }}
                          className="px-2 py-1 text-xs font-medium text-slate-700 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors inline-flex items-center gap-1 cursor-pointer"
                          title="Редактировать профиль (создать новую ревизию)"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>

                        <button
                          type="button"
                          onClick={() => handleCopyProfile(prof)}
                          disabled={isActionLoading}
                          className="px-2 py-1 text-xs font-medium text-slate-700 hover:text-slate-900 bg-slate-100 hover:bg-slate-200 rounded-md transition-colors inline-flex items-center gap-1 cursor-pointer"
                          title="Создать независимую копию профиля (v1)"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>

                        <button
                          type="button"
                          onClick={() => handleDeployInstance(prof)}
                          className="px-2.5 py-1 text-xs font-medium text-brand-700 hover:text-brand-900 bg-brand-50 hover:bg-brand-100 border border-brand-200 rounded-md transition-colors inline-flex items-center gap-1 cursor-pointer"
                          title="Создать экземпляр ловушки с этим профилем (FE2-01)"
                        >
                          <Rocket className="w-3.5 h-3.5" /> Развернуть
                        </button>
                      </>
                    )}
                  </div>

                  {!isViewer && (
                    <button
                      type="button"
                      onClick={() => setDeletingProfile(prof)}
                      className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded transition-colors cursor-pointer"
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

      {/* Profile Wizard Modal (Create & Edit with revisioning) */}
      <ProfileWizardModal
        isOpen={isWizardOpen}
        onClose={() => {
          setIsWizardOpen(false);
          setEditingProfile(null);
        }}
        initialProfile={editingProfile}
        onProfileCreated={() => {
          fetchData();
        }}
        onProfileUpdated={() => {
          fetchData();
        }}
        onDeployInstance={(created, rev) => {
          handleDeployInstance(created, rev);
        }}
      />

      {/* Profile Detailed Inspect Modal (Preview TL-01, Revisions History, Diff, Linked Traps, JSON) */}
      <ProfileDetailModal
        isOpen={!!detailProfile}
        onClose={() => setDetailProfile(null)}
        profile={detailProfile}
        linkedTraps={detailProfile ? getLinkedTraps(detailProfile.id) : []}
        isViewer={isViewer}
        onEdit={(prof) => {
          setDetailProfile(null);
          handleEditProfile(prof);
        }}
        onCopy={(prof) => {
          setDetailProfile(null);
          handleCopyProfile(prof);
        }}
        onDeployRevision={(prof, rev) => {
          setDetailProfile(null);
          handleDeployInstance(prof, rev);
        }}
        onNavigateToTraps={() => {
          setDetailProfile(null);
          window.location.hash = 'traps';
        }}
      />

      {/* Safe Delete Modal with HTTP 409 profile_assigned explanation */}
      <ProfileDeleteModal
        isOpen={!!deletingProfile}
        onClose={() => setDeletingProfile(null)}
        profile={deletingProfile}
        linkedTraps={deletingProfile ? getLinkedTraps(deletingProfile.id) : []}
        onConfirmDelete={handleDelete}
        isDeleting={isDeleting}
        onNavigateToTraps={() => {
          setDeletingProfile(null);
          window.location.hash = 'traps';
        }}
      />
    </div>
  );
};
