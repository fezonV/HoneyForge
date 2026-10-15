import React from 'react';
import { AlertCircle, Trash2, Server, ExternalLink } from 'lucide-react';
import { Profile, Trap } from '../../api/types';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';

interface ProfileDeleteModalProps {
  isOpen: boolean;
  onClose: () => void;
  profile: Profile | null;
  linkedTraps: Trap[];
  onConfirmDelete: (profileId: string) => Promise<void>;
  isDeleting: boolean;
  onNavigateToTraps?: () => void;
}

export const ProfileDeleteModal: React.FC<ProfileDeleteModalProps> = ({
  isOpen,
  onClose,
  profile,
  linkedTraps,
  onConfirmDelete,
  isDeleting,
  onNavigateToTraps,
}) => {
  if (!isOpen || !profile) return null;

  const assigned = linkedTraps.filter((trap) => trap.desired_profile_id === profile.id);
  const isAssigned = assigned.length > 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isAssigned ? 'Удаление профиля заблокировано' : 'Подтверждение удаления профиля'}
      maxWidth="md"
    >
      <div className="space-y-4">
        {isAssigned ? (
          <>
            <div className="p-4 bg-rose-50 border border-rose-200 rounded-xl flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
              <div className="text-xs space-y-1 text-rose-900">
                <h4 className="font-bold text-sm">
                  Нельзя удалить профиль «{profile.name}» (HTTP 409 Conflict)
                </h4>
                <p className="leading-relaxed">
                  Профиль назначен на <span className="font-bold">{assigned.length}</span> активных ловушек. Серверный контракт запрещает удаление занятых профилей (правило FR-C2).
                </p>
                <p className="text-rose-700 font-semibold pt-1">
                  Сначала переназначьте ловушки на другой профиль. Автоматическое удаление связанных ловушек запрещено в целях безопасности.
                </p>
              </div>
            </div>

            {/* List of Linked Traps */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-slate-600 font-semibold px-1">
                <span>Связанные экземпляры ловушек ({assigned.length}):</span>
                {onNavigateToTraps && (
                  <button
                    type="button"
                    onClick={onNavigateToTraps}
                    className="text-brand-600 hover:text-brand-800 text-[11px] inline-flex items-center gap-1 font-medium"
                  >
                    Открыть парк ловушек <ExternalLink className="w-3 h-3" />
                  </button>
                )}
              </div>

              <div className="max-h-48 overflow-y-auto space-y-1.5 border border-slate-200 rounded-xl p-2 bg-slate-50">
                {assigned.map((trap) => (
                  <div
                    key={trap.id}
                    className="bg-white p-2.5 rounded-lg border border-slate-200 text-xs flex items-center justify-between gap-2 shadow-2xs"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Server className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <span className="font-semibold text-slate-800 truncate">{trap.name}</span>
                      <span className="text-[11px] text-slate-400 font-mono">({trap.ip_address})</span>
                    </div>

                    <div className="flex items-center gap-2 shrink-0 text-[11px]">
                      <span className="bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded font-mono">
                        v{trap.desired_revision || profile.revision}
                      </span>
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                          trap.agent_status === 'online'
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-slate-100 text-slate-600'
                        }`}
                      >
                        {trap.agent_status || 'offline'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-slate-100">
              {onNavigateToTraps ? (
                <Button variant="primary" size="sm" onClick={onNavigateToTraps}>
                  Перейти в парк ловушек
                </Button>
              ) : <div />}
              <Button variant="outline" size="sm" onClick={onClose}>
                Закрыть
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-2 text-xs">
              <p className="text-slate-800 font-medium">
                Вы уверены, что хотите удалить профиль <span className="font-bold">«{profile.name}»</span> (rev {profile.revision})?
              </p>
              <p className="text-slate-500 leading-relaxed text-[11px]">
                Профиль будет скрыт из активного каталога. Созданные ранее ревизии сохраняются в истории для аудита и целостности логов.
              </p>
            </div>

            <div className="flex items-center justify-between pt-3 border-t border-slate-100">
              <Button
                variant="danger"
                size="sm"
                leftIcon={<Trash2 className="w-3.5 h-3.5" />}
                isLoading={isDeleting}
                onClick={() => onConfirmDelete(profile.id)}
              >
                Удалить профиль
              </Button>
              <Button variant="outline" size="sm" onClick={onClose} disabled={isDeleting}>
                Отмена
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};
