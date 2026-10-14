import React from 'react';
import { ProfileConfig } from '../../api/types';
import { Check, AlertCircle, Plus, Minus, Edit3 } from 'lucide-react';

interface ProfileDiffViewProps {
  baseTitle?: string;
  newTitle?: string;
  baseConfig: ProfileConfig;
  newConfig: ProfileConfig;
}

export const ProfileDiffView: React.FC<ProfileDiffViewProps> = ({
  baseTitle = 'Базовая версия',
  newTitle = 'Новая версия',
  baseConfig,
  newConfig,
}) => {
  const levelChanged = baseConfig.level !== newConfig.level;
  const templateChanged = baseConfig.template_id !== newConfig.template_id;

  // Services diff
  const baseServicePorts = baseConfig.services.map((s) => `${s.port}/${s.protocol}`);
  const newServicePorts = newConfig.services.map((s) => `${s.port}/${s.protocol}`);
  const servicesChanged = JSON.stringify(baseConfig.services) !== JSON.stringify(newConfig.services);

  // Texts diff
  const titleChanged = baseConfig.visible_texts?.title !== newConfig.visible_texts?.title;
  const promptChanged = baseConfig.visible_texts?.login_prompt !== newConfig.visible_texts?.login_prompt;

  // Credentials diff
  const baseUsernames = (baseConfig.synthetic_credentials || []).map((c) => c.username);
  const newUsernames = (newConfig.synthetic_credentials || []).map((c) => c.username);
  const credsAdded = newUsernames.filter((u) => !baseUsernames.includes(u));
  const credsRemoved = baseUsernames.filter((u) => !newUsernames.includes(u));

  // Fake-FS diff
  const basePaths = (baseConfig.fake_fs || []).map((f) => f.path);
  const newPaths = (newConfig.fake_fs || []).map((f) => f.path);
  const filesAdded = newPaths.filter((p) => !basePaths.includes(p));
  const filesRemoved = basePaths.filter((p) => !newPaths.includes(p));

  // Channel & Logging diff
  const channelChanged =
    baseConfig.channel?.heartbeat_seconds !== newConfig.channel?.heartbeat_seconds ||
    baseConfig.channel?.sync_seconds !== newConfig.channel?.sync_seconds ||
    baseConfig.channel?.tls_required !== newConfig.channel?.tls_required;

  const categoriesChanged =
    JSON.stringify(baseConfig.logging?.categories) !== JSON.stringify(newConfig.logging?.categories);

  const hasAnyChange =
    levelChanged ||
    templateChanged ||
    servicesChanged ||
    titleChanged ||
    promptChanged ||
    credsAdded.length > 0 ||
    credsRemoved.length > 0 ||
    filesAdded.length > 0 ||
    filesRemoved.length > 0 ||
    channelChanged ||
    categoriesChanged;

  if (!hasAnyChange) {
    return (
      <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl text-center text-xs text-slate-500">
        <Check className="w-4 h-4 text-emerald-500 mx-auto mb-1" />
        Конфигурации идентичны. Различий в параметрах не обнаружено.
      </div>
    );
  }

  return (
    <div className="space-y-3 text-xs">
      <div className="grid grid-cols-2 gap-2 pb-2 border-b border-slate-200 font-semibold text-slate-500">
        <div>{baseTitle}</div>
        <div>{newTitle}</div>
      </div>

      {/* Level & Template */}
      {(levelChanged || templateChanged) && (
        <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200">
          <div className="font-semibold text-amber-900 flex items-center gap-1.5 mb-1">
            <Edit3 className="w-3.5 h-3.5" /> Уровень и шаблон взаимодействия
          </div>
          <div className="grid grid-cols-2 gap-2 text-slate-700">
            <div className="line-through text-rose-700">
              {baseConfig.level} ({baseConfig.template_id})
            </div>
            <div className="font-semibold text-emerald-700">
              {newConfig.level} ({newConfig.template_id})
            </div>
          </div>
        </div>
      )}

      {/* Services & Ports */}
      {servicesChanged && (
        <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
          <div className="font-semibold text-slate-800 flex items-center gap-1.5 mb-1">
            <Edit3 className="w-3.5 h-3.5 text-brand-600" /> Сетевые службы и порты
          </div>
          <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
            <div className="text-slate-600">
              {baseServicePorts.join(', ') || 'нет'}
            </div>
            <div className="text-emerald-700 font-semibold">
              {newServicePorts.join(', ') || 'нет'}
            </div>
          </div>
        </div>
      )}

      {/* Visible Texts */}
      {(titleChanged || promptChanged) && (
        <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
          <div className="font-semibold text-slate-800 flex items-center gap-1.5 mb-1">
            <Edit3 className="w-3.5 h-3.5 text-brand-600" /> Тексты приманки
          </div>
          <div className="space-y-1 text-[11px]">
            {titleChanged && (
              <div className="grid grid-cols-2 gap-2">
                <div className="line-through text-rose-700">«{baseConfig.visible_texts?.title}»</div>
                <div className="font-semibold text-emerald-700">«{newConfig.visible_texts?.title}»</div>
              </div>
            )}
            {promptChanged && (
              <div className="grid grid-cols-2 gap-2">
                <div className="line-through text-rose-700">«{baseConfig.visible_texts?.login_prompt}»</div>
                <div className="font-semibold text-emerald-700">«{newConfig.visible_texts?.login_prompt}»</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Credentials */}
      {(credsAdded.length > 0 || credsRemoved.length > 0) && (
        <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
          <div className="font-semibold text-slate-800 flex items-center gap-1.5 mb-1">
            <Edit3 className="w-3.5 h-3.5 text-brand-600" /> Учётные записи
          </div>
          <div className="space-y-0.5 text-[11px]">
            {credsAdded.map((u) => (
              <div key={u} className="text-emerald-700 flex items-center gap-1 font-mono">
                <Plus className="w-3 h-3" /> Добавлена учётка: {u}
              </div>
            ))}
            {credsRemoved.map((u) => (
              <div key={u} className="text-rose-700 flex items-center gap-1 font-mono">
                <Minus className="w-3 h-3" /> Удалена учётка: {u}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Fake-FS */}
      {(filesAdded.length > 0 || filesRemoved.length > 0) && (
        <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
          <div className="font-semibold text-slate-800 flex items-center gap-1.5 mb-1">
            <Edit3 className="w-3.5 h-3.5 text-brand-600" /> Файловая система (Fake-FS)
          </div>
          <div className="space-y-0.5 text-[11px]">
            {filesAdded.map((p) => (
              <div key={p} className="text-emerald-700 flex items-center gap-1 font-mono truncate">
                <Plus className="w-3 h-3" /> Добавлен файл: {p}
              </div>
            ))}
            {filesRemoved.map((p) => (
              <div key={p} className="text-rose-700 flex items-center gap-1 font-mono truncate">
                <Minus className="w-3 h-3" /> Удален файл: {p}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Channel / Logging */}
      {(channelChanged || categoriesChanged) && (
        <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
          <div className="font-semibold text-slate-800 flex items-center gap-1.5 mb-1">
            <AlertCircle className="w-3.5 h-3.5 text-brand-600" /> Параметры канала и аудита
          </div>
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div className="text-slate-600">
              HB: {baseConfig.channel?.heartbeat_seconds}с, Sync: {baseConfig.channel?.sync_seconds}с
            </div>
            <div className="text-emerald-700 font-semibold">
              HB: {newConfig.channel?.heartbeat_seconds}с, Sync: {newConfig.channel?.sync_seconds}с
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
