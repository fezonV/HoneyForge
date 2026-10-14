import React from 'react';
import { Radio, Lock, Activity } from 'lucide-react';
import { ChannelConfig } from '../../../api/types';

interface Step4Props {
  level: 'low' | 'medium';
  categories: string[];
  setCategories: (cats: string[]) => void;
  channel: ChannelConfig;
  setChannel: (channel: ChannelConfig) => void;
  errors: Record<string, string>;
}

export const Step4LoggingChannel: React.FC<Step4Props> = ({
  level,
  categories,
  setCategories,
  channel,
  setChannel,
  errors,
}) => {
  const isMedium = level === 'medium';

  // Mandatory categories per Go contract ValidateProfile
  const lowMandatory = ['connection.opened', 'http.request'];
  const mediumMandatory = [
    'auth.attempt',
    'session.started',
    'file.listed',
    'file.read',
    'file.downloaded',
    'session.ended',
  ];

  const mandatoryCategories = isMedium ? [...lowMandatory, ...mediumMandatory] : lowMandatory;

  const allCategoryOptions = [
    { id: 'connection.opened', label: 'connection.opened', desc: 'Открытие TCP/HTTP соединения с портом ловушки' },
    { id: 'http.request', label: 'http.request', desc: 'Входящий HTTP-запрос (URI, Method, Headers, User-Agent)' },
    { id: 'auth.attempt', label: 'auth.attempt', desc: 'Попытка аутентификации (перехват переданных кредов)' },
    { id: 'session.started', label: 'session.started', desc: 'Старт сессии взаимодействия посетителя с приманкой' },
    { id: 'file.listed', label: 'file.listed', desc: 'Просмотр каталога или списка доступных файлов' },
    { id: 'file.read', label: 'file.read', desc: 'Чтение содержимого фиктивного документа' },
    { id: 'file.downloaded', label: 'file.downloaded', desc: 'Выгрузка файла из эмулируемого архива' },
    { id: 'session.ended', label: 'session.ended', desc: 'Завершение сессии посетителя или таймаут' },
    { id: 'command.received', label: 'command.received', desc: 'Получение управляющей команды от центра C2 (опционально)' },
  ];

  const handleToggleCategory = (id: string) => {
    // Cannot toggle mandatory categories
    if (mandatoryCategories.includes(id)) return;

    if (categories.includes(id)) {
      setCategories(categories.filter((c) => c !== id));
    } else {
      setCategories([...categories, id]);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-bold text-slate-900">Шаг 4: Логирование телеметрии и канал связи</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Категории регистрируемых событий атаки и параметры синхронизации агента с C2 (FR-C1)
        </p>
      </div>

      {/* Logging Categories Section */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-4">
        <div className="flex items-center justify-between pb-2 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-brand-600" />
            <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wide">
              Категории логирования событий (Logging Categories)
            </h3>
          </div>
          <span className="text-[11px] text-slate-400">
            Выбрано: {categories.length} категорий
          </span>
        </div>

        {errors.logging && (
          <p className="text-xs text-rose-600 font-medium">{errors.logging}</p>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {allCategoryOptions.map((cat) => {
            const isMandatory = mandatoryCategories.includes(cat.id);
            const isChecked = categories.includes(cat.id) || isMandatory;

            return (
              <div
                key={cat.id}
                onClick={() => handleToggleCategory(cat.id)}
                className={`p-3 rounded-lg border text-xs transition-colors flex items-start gap-3 select-none ${
                  isMandatory
                    ? 'bg-slate-50 border-slate-200 cursor-not-allowed opacity-90'
                    : isChecked
                    ? 'bg-brand-50/40 border-brand-200 cursor-pointer'
                    : 'bg-white border-slate-200 hover:border-slate-300 cursor-pointer'
                }`}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  disabled={isMandatory}
                  onChange={() => {}}
                  className="mt-0.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                />

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 font-mono font-semibold text-slate-900">
                    <span>{cat.label}</span>
                    {isMandatory && (
                      <span className="text-[10px] font-sans px-1.5 py-0.2 rounded bg-amber-100 text-amber-800 font-normal">
                        Обязательно
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-500 mt-0.5 leading-snug">{cat.desc}</p>
                </div>
              </div>
            );
          })}
        </div>

        <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-[11px] text-slate-600 flex items-center gap-2">
          <Lock className="w-3.5 h-3.5 text-amber-600 shrink-0" />
          <span>
            Политика безопасности HoneyForge запрещает отключение обязательных категорий телеметрии для предотвращения слепых зон в SOC.
          </span>
        </div>
      </div>

      {/* Agent Communication Channel Section */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-4">
        <div className="flex items-center gap-2 pb-2 border-b border-slate-100">
          <Radio className="w-4 h-4 text-emerald-600" />
          <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wide">
            Канал связи агента с центром (Channel Settings)
          </h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-[11px] font-semibold text-slate-700 mb-1">
              Интервал Heartbeat (сек)
            </label>
            <input
              type="number"
              min={5}
              max={300}
              required
              value={channel.heartbeat_seconds}
              onChange={(e) => setChannel({ ...channel, heartbeat_seconds: Number(e.target.value) })}
              className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            <p className="text-[10px] text-slate-400 mt-1">От 5 до 300 сек. По умолчанию: 15 с.</p>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-700 mb-1">
              Синхронизация профиля (сек)
            </label>
            <input
              type="number"
              min={5}
              max={600}
              required
              value={channel.sync_seconds}
              onChange={(e) => setChannel({ ...channel, sync_seconds: Number(e.target.value) })}
              className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            <p className="text-[10px] text-slate-400 mt-1">Интервал сверки ревизии. По умолчанию: 30 с.</p>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-700 mb-1">
              Проверка TLS соединения
            </label>
            <label className="flex items-center gap-2 cursor-pointer mt-2 bg-slate-50 p-2 rounded-lg border border-slate-200">
              <input
                type="checkbox"
                checked={channel.tls_required}
                onChange={(e) => setChannel({ ...channel, tls_required: e.target.checked })}
                className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              <span className="text-xs text-slate-800 font-medium">Требовать TLS (mTLS)</span>
            </label>
            <p className="text-[10px] text-slate-400 mt-1">Обязательное шифрование канала в боевом контуре.</p>
          </div>
        </div>
      </div>
    </div>
  );
};
