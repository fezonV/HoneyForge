import React from 'react';
import { AlertTriangle, GitMerge, Copy, RotateCcw, ArrowRight } from 'lucide-react';
import { ProfileConfig, ProfileRevision } from '../../api/types';
import { Modal } from '../common/Modal';
import { Button } from '../common/Button';
import { ProfileDiffView } from './ProfileDiffView';

interface ProfileConflictModalProps {
  isOpen: boolean;
  onClose: () => void;
  profileName: string;
  baseRevision: number;
  serverRevision: ProfileRevision | null;
  draftConfig: ProfileConfig;
  onApplyOverServer: (newBaseRevision: number) => void;
  onAcceptServer: () => void;
  onSaveAsCopy: () => void;
  isSubmitting?: boolean;
}

export const ProfileConflictModal: React.FC<ProfileConflictModalProps> = ({
  isOpen,
  onClose,
  profileName,
  baseRevision,
  serverRevision,
  draftConfig,
  onApplyOverServer,
  onAcceptServer,
  onSaveAsCopy,
  isSubmitting = false,
}) => {
  if (!isOpen || !serverRevision) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Конфликт одновременного редактирования (HTTP 409)"
      maxWidth="xl"
    >
      <div className="space-y-5">
        {/* Warning Banner */}
        <div className="p-4 bg-amber-50 border border-amber-300 rounded-xl flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="text-xs space-y-1">
            <h4 className="font-bold text-amber-900 text-sm">
              Профиль был изменён другим оператором на сервере
            </h4>
            <p className="text-amber-800 leading-relaxed">
              Вы начали редактирование на базе ревизии <span className="font-bold font-mono">v{baseRevision}</span>, но на сервере уже зарегистрирована ревизия <span className="font-bold font-mono">v{serverRevision.revision}</span> (создана: {new Date(serverRevision.created_at).toLocaleString('ru-RU')}).
            </p>
            <p className="text-amber-700 font-semibold">
              Ваш черновик не потерян. Выберите способ разрешения конфликта:
            </p>
          </div>
        </div>

        {/* Diff Comparison */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between pb-2 border-b border-slate-100">
            <span className="font-bold text-xs text-slate-800 flex items-center gap-1.5">
              <GitMerge className="w-4 h-4 text-brand-600" />
              Сравнение изменений: Серверная версия v{serverRevision.revision} vs Ваш черновик
            </span>
            <span className="text-[11px] text-slate-400">
              Профиль «{profileName}»
            </span>
          </div>

          <div className="max-h-72 overflow-y-auto pr-1">
            <ProfileDiffView
              baseTitle={`Серверная ревизия (v${serverRevision.revision})`}
              newTitle="Ваш локальный черновик"
              baseConfig={serverRevision.config}
              newConfig={draftConfig}
            />
          </div>
        </div>

        {/* Action Strategy Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <div className="p-3 bg-brand-50/60 border border-brand-200 rounded-xl space-y-2 flex flex-col justify-between">
            <div>
              <span className="font-bold text-brand-900 block">Применить мои правки</span>
              <p className="text-slate-600 text-[11px] mt-1 leading-relaxed">
                Записать ваш черновик как новую ревизию v{serverRevision.revision + 1} поверх серверной версии.
              </p>
            </div>
            <Button
              variant="primary"
              size="sm"
              isLoading={isSubmitting}
              leftIcon={<ArrowRight className="w-3.5 h-3.5" />}
              onClick={() => onApplyOverServer(serverRevision.revision)}
            >
              Перенести правки
            </Button>
          </div>

          <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2 flex flex-col justify-between">
            <div>
              <span className="font-bold text-slate-900 block">Принять серверную</span>
              <p className="text-slate-600 text-[11px] mt-1 leading-relaxed">
                Сбросить черновик и загрузить актуальную серверную версию v{serverRevision.revision}.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              leftIcon={<RotateCcw className="w-3.5 h-3.5" />}
              onClick={onAcceptServer}
            >
              Принять серверную
            </Button>
          </div>

          <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2 flex flex-col justify-between">
            <div>
              <span className="font-bold text-slate-900 block">Сохранить как копию</span>
              <p className="text-slate-600 text-[11px] mt-1 leading-relaxed">
                Создать новый профиль с вашим черновиком и отдельной историей.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              leftIcon={<Copy className="w-3.5 h-3.5" />}
              onClick={onSaveAsCopy}
            >
              Создать копию
            </Button>
          </div>
        </div>

        <div className="pt-2 flex justify-end">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Вернуться к редактированию черновика
          </Button>
        </div>
      </div>
    </Modal>
  );
};
