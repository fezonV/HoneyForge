import React, { useState } from 'react';
import { Eye, Code, AlertTriangle } from 'lucide-react';
import { ProfileConfig, CreateProfileRequest } from '../../../api/types';
import { ProfileDecoyPreview } from '../ProfileDecoyPreview';
import { profileToPreviewModel } from '../../../utils/previewAdapter';

interface Step5Props {
  name: string;
  description: string;
  config: ProfileConfig;
  errors: Record<string, string>;
}

export const Step5ReviewPreview: React.FC<Step5Props> = ({
  name,
  description,
  config,
  errors,
}) => {
  const [activeTab, setActiveTab] = useState<'preview' | 'json'>('preview');

  const previewModel = profileToPreviewModel(config, name);
  const isMedium = config.level === 'medium';

  const fullPayload: CreateProfileRequest = {
    name,
    description: description || 'Профиль приманки',
    config,
  };

  const hasErrors = Object.keys(errors).length > 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-slate-900">Шаг 5: Проверка конфигурации и предпросмотр</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Убедитесь в корректности настроек и проверьте внешний вид приманки перед сохранением
          </p>
        </div>

        {/* Tab Switcher */}
        <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg border border-slate-200">
          <button
            type="button"
            onClick={() => setActiveTab('preview')}
            className={`px-3 py-1 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-colors ${
              activeTab === 'preview'
                ? 'bg-white text-slate-900 shadow-2xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Eye className="w-3.5 h-3.5" /> Предпросмотр (TL-01)
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('json')}
            className={`px-3 py-1 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-colors ${
              activeTab === 'json'
                ? 'bg-white text-slate-900 shadow-2xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Code className="w-3.5 h-3.5" /> Спецификация JSON
          </button>
        </div>
      </div>

      {/* Validation Errors Notice */}
      {hasErrors && (
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-xl space-y-2">
          <div className="flex items-center gap-2 text-rose-800 font-semibold text-xs">
            <AlertTriangle className="w-4 h-4 text-rose-600" />
            <span>Обнаружены ошибки валидации (исправьте перед сохранением):</span>
          </div>
          <ul className="list-disc list-inside text-xs text-rose-700 space-y-1 pl-1">
            {Object.entries(errors).map(([k, v]) => (
              <li key={k}>
                <span className="font-mono">{k}</span>: {v}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Profile Metrics Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white p-3 rounded-lg border border-slate-200">
          <span className="text-[11px] text-slate-400 block">Уровень и шаблон</span>
          <span className="text-xs font-bold text-slate-900 mt-0.5 block uppercase">
            {config.level} ({config.template_id})
          </span>
        </div>

        <div className="bg-white p-3 rounded-lg border border-slate-200">
          <span className="text-[11px] text-slate-400 block">Сервисы и порты</span>
          <span className="text-xs font-bold text-slate-900 mt-0.5 block">
            {config.services.length} серв. ({config.services.map((s) => s.port).join(', ')})
          </span>
        </div>

        <div className="bg-white p-3 rounded-lg border border-slate-200">
          <span className="text-[11px] text-slate-400 block">Учётные записи</span>
          <span className="text-xs font-bold text-slate-900 mt-0.5 block">
            {isMedium ? `${config.synthetic_credentials.length} кредов` : 'Не требуются (Low)'}
          </span>
        </div>

        <div className="bg-white p-3 rounded-lg border border-slate-200">
          <span className="text-[11px] text-slate-400 block">Файловая система</span>
          <span className="text-xs font-bold text-slate-900 mt-0.5 block">
            {isMedium ? `${config.fake_fs.length} файлов` : 'Статический каталог'}
          </span>
        </div>
      </div>

      {/* Main Tab Content */}
      {activeTab === 'preview' ? (
        <div className="space-y-3">
          <ProfileDecoyPreview model={previewModel} level={config.level as 'low' | 'medium'} />
        </div>
      ) : (
        <div className="space-y-2">
          <div className="bg-slate-900 text-slate-100 p-4 rounded-xl border border-slate-800 text-xs font-mono overflow-x-auto max-h-[500px] leading-relaxed">
            <pre>{JSON.stringify(fullPayload, null, 2)}</pre>
          </div>
          <p className="text-[11px] text-slate-400">
            Строгая структура contracts.CreateProfileRequest с вложенной ProfileConfig для POST /api/v1/profiles
          </p>
        </div>
      )}
    </div>
  );
};
