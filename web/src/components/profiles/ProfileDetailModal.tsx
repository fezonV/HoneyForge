import React, { useState, useEffect } from 'react';
import {
  Eye,
  GitBranch,
  Server,
  Code,
  Rocket,
  Copy,
  Edit3,
  Calendar,
  User,
  AlertCircle,
  ExternalLink,
} from 'lucide-react';
import { Profile, ProfileRevision, Trap } from '../../api/types';
import { api } from '../../api/client';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { LevelBadge } from '../common/Badge';
import { DecoyPreviewFrame } from './preview/DecoyPreviewFrame';
import { ProfileDiffView } from './ProfileDiffView';

interface ProfileDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  profile: Profile | null;
  linkedTraps: Trap[];
  isViewer: boolean;
  onEdit?: (profile: Profile) => void;
  onCopy?: (profile: Profile) => void;
  onDeployRevision?: (profile: Profile, revision: number) => void;
  onNavigateToTraps?: () => void;
}

export const ProfileDetailModal: React.FC<ProfileDetailModalProps> = ({
  isOpen,
  onClose,
  profile,
  linkedTraps,
  isViewer,
  onEdit,
  onCopy,
  onDeployRevision,
  onNavigateToTraps,
}) => {
  const [activeTab, setActiveTab] = useState<'preview' | 'history' | 'traps' | 'json'>('preview');
  const [revisions, setRevisions] = useState<ProfileRevision[]>([]);
  const [selectedRevision, setSelectedRevision] = useState<ProfileRevision | null>(null);
  const [diffAgainstRevision, setDiffAgainstRevision] = useState<ProfileRevision | null>(null);
  const [isLoadingRevisions, setIsLoadingRevisions] = useState<boolean>(false);

  useEffect(() => {
    if (!profile || !isOpen) return;
    setActiveTab('preview');
    setIsLoadingRevisions(true);

    api.profiles
      .revisions(profile.id)
      .then((items) => {
        setRevisions(items);
        const current = items.find((r) => r.revision === profile.revision) || items[0] || null;
        setSelectedRevision(current);
        const prev = items.find((r) => r.revision === profile.revision - 1) || null;
        setDiffAgainstRevision(prev);
      })
      .catch(() => {
        setRevisions([]);
      })
      .finally(() => {
        setIsLoadingRevisions(false);
      });
  }, [profile, isOpen]);

  if (!isOpen || !profile) return null;

  const activeConfig = selectedRevision?.config || profile.config || {
    template_id: profile.level === 'medium' ? 'medium-http' : 'low-http',
    level: profile.level,
    services: profile.services,
    visible_texts: {
      title: profile.name,
      login_prompt: profile.description,
      success: 'Доступ разрешён',
      failure: 'Неверные данные',
    },
    synthetic_credentials: [],
    fake_fs: [],
    logging: { categories: ['connection.opened', 'http.request'] },
    channel: { tls_required: true, heartbeat_seconds: 15, sync_seconds: 30 },
  };

  const currentRevNumber = selectedRevision?.revision || profile.revision;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Профиль: ${profile.name} (rev ${profile.revision})`}
      description={profile.description || 'Параметры профиля поведения и история ревизий'}
      maxWidth="xl"
    >
      <div className="space-y-4">
        {/* Subtitle & Tabs bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
          <div className="flex items-center gap-2 max-w-md">
            <LevelBadge level={profile.level} />
            <p className="text-xs text-slate-500 truncate">
              {profile.description || 'Конфигурация приманки'}
            </p>
          </div>

          <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg border border-slate-200 text-xs">
            <button
              type="button"
              onClick={() => setActiveTab('preview')}
              className={`px-3 py-1 rounded-md font-semibold flex items-center gap-1.5 transition-colors ${
                activeTab === 'preview'
                  ? 'bg-white text-slate-900 shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Eye className="w-3.5 h-3.5" /> Предпросмотр (TL-01)
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('history')}
              className={`px-3 py-1 rounded-md font-semibold flex items-center gap-1.5 transition-colors ${
                activeTab === 'history'
                  ? 'bg-white text-slate-900 shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <GitBranch className="w-3.5 h-3.5" /> История версий ({revisions.length || 1})
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('traps')}
              className={`px-3 py-1 rounded-md font-semibold flex items-center gap-1.5 transition-colors ${
                activeTab === 'traps'
                  ? 'bg-white text-slate-900 shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Server className="w-3.5 h-3.5" /> Ловушки ({linkedTraps.length})
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('json')}
              className={`px-3 py-1 rounded-md font-semibold flex items-center gap-1.5 transition-colors ${
                activeTab === 'json'
                  ? 'bg-white text-slate-900 shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Code className="w-3.5 h-3.5" /> JSON
            </button>
          </div>
        </div>

        {/* Tab 1: Preview */}
        {activeTab === 'preview' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs text-slate-500 bg-slate-50 px-3 py-1.5 rounded-lg border border-slate-200">
              <span>
                Отображение ревизии: <strong className="text-slate-800">v{currentRevNumber}</strong>
                {currentRevNumber !== profile.revision && ' (историческая версия)'}
              </span>
              {selectedRevision?.created_at && (
                <span>Создана: {new Date(selectedRevision.created_at).toLocaleString('ru-RU')}</span>
              )}
            </div>
            <DecoyPreviewFrame name={profile.name} config={activeConfig} />
          </div>
        )}

        {/* Tab 2: Version History & Diff */}
        {activeTab === 'history' && (
          <div className="space-y-4 text-xs">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {/* Revision list sidebar */}
              <div className="border border-slate-200 rounded-xl p-2.5 bg-slate-50 space-y-2">
                <span className="font-bold text-slate-700 block px-1">
                  Список ревизий ({revisions.length}):
                </span>
                <div className="space-y-1.5 max-h-72 overflow-y-auto">
                  {isLoadingRevisions ? (
                    <div className="text-center py-4 text-slate-400 text-xs">Загрузка ревизий...</div>
                  ) : revisions.length === 0 ? (
                    <div className="text-center py-4 text-slate-400 text-xs">Нет ревизий</div>
                  ) : (
                    revisions.map((rev) => (
                    <div
                      key={rev.revision}
                      onClick={() => setSelectedRevision(rev)}
                      className={`p-2 rounded-lg cursor-pointer transition-colors border ${
                        selectedRevision?.revision === rev.revision
                          ? 'bg-white border-brand-500 shadow-2xs ring-1 ring-brand-500'
                          : 'bg-white/80 border-slate-200 hover:bg-white'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-slate-800">Ревизия v{rev.revision}</span>
                        {rev.revision === profile.revision && (
                          <span className="text-[10px] bg-emerald-100 text-emerald-800 font-semibold px-1.5 py-0.2 rounded">
                            Актуальная
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-[11px] text-slate-500 mt-1">
                        <Calendar className="w-3 h-3" />
                        <span>{new Date(rev.created_at).toLocaleDateString('ru-RU')}</span>
                        {rev.created_by && (
                          <span className="flex items-center gap-0.5 truncate max-w-[80px]">
                            <User className="w-3 h-3" /> {rev.created_by}
                          </span>
                        )}
                      </div>
                    </div>
                  )))}
                </div>
              </div>

              {/* Revision details and diff */}
              <div className="md:col-span-2 border border-slate-200 rounded-xl p-4 bg-white space-y-4">
                <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                  <div>
                    <h4 className="font-bold text-slate-900 text-sm">
                      Конфигурация ревизии v{currentRevNumber}
                    </h4>
                    <p className="text-[11px] text-slate-500">
                      Неизменяемый снимок параметров приманки
                    </p>
                  </div>

                  {!isViewer && onDeployRevision && (
                    <Button
                      variant="primary"
                      size="sm"
                      leftIcon={<Rocket className="w-3.5 h-3.5" />}
                      onClick={() => onDeployRevision(profile, currentRevNumber)}
                    >
                      Развернуть экземпляр из v{currentRevNumber}
                    </Button>
                  )}
                </div>

                {/* Diff selector */}
                {revisions.length > 1 && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-[11px] text-slate-600 bg-slate-50 p-2 rounded-lg border border-slate-200">
                      <span>Сравнить v{currentRevNumber} с ревизией:</span>
                      <select
                        value={diffAgainstRevision?.revision || ''}
                        onChange={(e) => {
                          const target = revisions.find((r) => r.revision === Number(e.target.value));
                          setDiffAgainstRevision(target || null);
                        }}
                        className="bg-white border border-slate-200 rounded px-2 py-0.5 text-xs"
                      >
                        {revisions
                          .filter((r) => r.revision !== currentRevNumber)
                          .map((r) => (
                            <option key={r.revision} value={r.revision}>
                              v{r.revision} ({new Date(r.created_at).toLocaleDateString('ru-RU')})
                            </option>
                          ))}
                      </select>
                    </div>

                    {diffAgainstRevision && (
                      <div className="border border-slate-200 rounded-lg p-2.5 max-h-56 overflow-y-auto">
                        <ProfileDiffView
                          baseTitle={`Ревизия v${diffAgainstRevision.revision}`}
                          newTitle={`Ревизия v${currentRevNumber}`}
                          baseConfig={diffAgainstRevision.config}
                          newConfig={activeConfig}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Tab 3: Linked Traps */}
        {activeTab === 'traps' && (
          <div className="space-y-3 text-xs">
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2.5 text-amber-900">
              <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <p className="leading-relaxed">
                Сохранение новой версии профиля <strong>не меняет поведение работающей ловушки автоматически</strong>. Чтобы применить изменения, выберите конкретный экземпляр в парке ловушек или примените команду обновления.
              </p>
            </div>

            {linkedTraps.length === 0 ? (
              <div className="p-8 text-center text-slate-400 bg-slate-50 rounded-xl border border-slate-200">
                <Server className="w-6 h-6 mx-auto mb-2 text-slate-300" />
                <p>К этому профилю пока не привязана ни одна активная ловушка.</p>
                <p className="text-[11px] text-slate-400 mt-1">
                  Профиль свободен и может быть безопасно удалён или назначен при регистрации нового экземпляра.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between px-1 text-slate-500 font-semibold">
                  <span>Список назначенных ловушек ({linkedTraps.length}):</span>
                  {onNavigateToTraps && (
                    <button
                      type="button"
                      onClick={onNavigateToTraps}
                      className="text-brand-600 hover:text-brand-800 inline-flex items-center gap-1 font-medium text-[11px]"
                    >
                      Открыть в парке ловушек <ExternalLink className="w-3 h-3" />
                    </button>
                  )}
                </div>

                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {linkedTraps.map((trap) => {
                    const isSynced = trap.applied_revision === profile.revision;
                    return (
                      <div
                        key={trap.id}
                        className="bg-white p-3 rounded-xl border border-slate-200 flex items-center justify-between gap-3 shadow-2xs"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-slate-900">{trap.name}</span>
                            <span className="text-[11px] text-slate-500 font-mono">
                              ({trap.ip_address})
                            </span>
                          </div>
                          <div className="flex items-center gap-3 text-[11px] text-slate-500 mt-1">
                            <span>Агент: <strong className={trap.agent_status === 'online' ? 'text-emerald-700' : 'text-slate-600'}>{trap.agent_status || 'offline'}</strong></span>
                            <span>Сервис: {trap.service_status || 'unknown'}</span>
                            <span>Локация: {trap.location || 'DMZ'}</span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <div className="text-right text-[11px]">
                            <div className="font-mono text-slate-700">
                              применена: <strong>v{trap.applied_revision || '—'}</strong>
                            </div>
                            <div className="text-slate-400 text-[10px]">
                              целевая: v{trap.desired_revision || profile.revision}
                            </div>
                          </div>

                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                              isSynced
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-amber-100 text-amber-800'
                            }`}
                          >
                            {isSynced ? 'Актуальна' : 'Ожидает применения'}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tab 4: JSON */}
        {activeTab === 'json' && (
          <div className="space-y-2">
            <div className="bg-slate-900 text-slate-100 p-4 rounded-xl border border-slate-800 text-xs font-mono overflow-x-auto max-h-[460px] leading-relaxed">
              <pre>{JSON.stringify(activeConfig, null, 2)}</pre>
            </div>
            <p className="text-[11px] text-slate-400">
              Неизменяемый снимок ProfileConfig для ревизии v{currentRevNumber}
            </p>
          </div>
        )}

        {/* Modal Actions Footer */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-100">
          <div className="flex items-center gap-2">
            {!isViewer && onEdit && (
              <Button
                variant="primary"
                size="sm"
                leftIcon={<Edit3 className="w-3.5 h-3.5" />}
                onClick={() => {
                  onClose();
                  onEdit(profile);
                }}
              >
                Редактировать профиль
              </Button>
            )}

            {!isViewer && onCopy && (
              <Button
                variant="outline"
                size="sm"
                leftIcon={<Copy className="w-3.5 h-3.5" />}
                onClick={() => {
                  onClose();
                  onCopy(profile);
                }}
              >
                Создать копию
              </Button>
            )}

            {!isViewer && onDeployRevision && (
              <Button
                variant="outline"
                size="sm"
                leftIcon={<Rocket className="w-3.5 h-3.5" />}
                onClick={() => {
                  onClose();
                  onDeployRevision(profile, currentRevNumber);
                }}
              >
                Создать экземпляр (v{currentRevNumber})
              </Button>
            )}
          </div>

          <Button variant="outline" size="sm" onClick={onClose}>
            Закрыть
          </Button>
        </div>
      </div>
    </Modal>
  );
};
