import React from 'react';
import { Archive, ShieldCheck, Info } from 'lucide-react';

interface Step1Props {
  name: string;
  setName: (name: string) => void;
  description: string;
  setDescription: (desc: string) => void;
  templateId: 'low-http' | 'medium-http';
  setTemplateId: (tpl: 'low-http' | 'medium-http') => void;
  errors: Record<string, string>;
}

export const Step1TemplateLevel: React.FC<Step1Props> = ({
  name,
  setName,
  description,
  setDescription,
  templateId,
  setTemplateId,
  errors,
}) => {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-bold text-slate-900">Шаг 1: Выбор базового шаблона и уровня</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Определите уровень интерактивности ловушки и метаданные профиля (FR-C1)
        </p>
      </div>

      {/* Template Selection Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Low HTTP Card */}
        <div
          onClick={() => setTemplateId('low-http')}
          className={`cursor-pointer rounded-xl border p-4 transition-all ${
            templateId === 'low-http'
              ? 'border-brand-600 bg-brand-50/30 ring-2 ring-brand-500/20 shadow-sm'
              : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/50'
          }`}
        >
          <div className="flex items-start justify-between">
            <div className="w-9 h-9 rounded-lg bg-sky-100 text-sky-700 flex items-center justify-center mb-3">
              <Archive className="w-5 h-5" />
            </div>
            <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-sky-100 text-sky-800">
              Low Interaction
            </span>
          </div>

          <h3 className="font-bold text-slate-900 text-sm">Low HTTP — Ведомственный архив</h3>
          <p className="text-xs text-slate-500 mt-1 leading-relaxed">
            Статический веб-каталог описей документов. Открытые порты, демонстрация баннеров сервисов и перехват сканирования.
          </p>

          <div className="mt-3 pt-3 border-t border-slate-200/60 text-[11px] text-slate-600 space-y-1">
            <div className="flex items-center gap-1.5">
              <span className="text-emerald-600">✓</span> Эмуляция HTTP-порта и баннера
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-emerald-600">✓</span> Логирование соединений и запросов
            </div>
            <div className="flex items-center gap-1.5 text-slate-400">
              <span>✕</span> Без интерактивной авторизации
            </div>
          </div>
        </div>

        {/* Medium HTTP Card */}
        <div
          onClick={() => setTemplateId('medium-http')}
          className={`cursor-pointer rounded-xl border p-4 transition-all ${
            templateId === 'medium-http'
              ? 'border-brand-600 bg-brand-50/30 ring-2 ring-brand-500/20 shadow-sm'
              : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/50'
          }`}
        >
          <div className="flex items-start justify-between">
            <div className="w-9 h-9 rounded-lg bg-amber-100 text-amber-700 flex items-center justify-center mb-3">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-100 text-amber-800">
              Medium Interaction
            </span>
          </div>

          <h3 className="font-bold text-slate-900 text-sm">Medium HTTP — Служебный портал архива</h3>
          <p className="text-xs text-slate-500 mt-1 leading-relaxed">
            Интерактивная панель входа с проверкой логинов/паролей, сессиями посетителей и фиктивной файловой системой.
          </p>

          <div className="mt-3 pt-3 border-t border-slate-200/60 text-[11px] text-slate-600 space-y-1">
            <div className="flex items-center gap-1.5">
              <span className="text-emerald-600">✓</span> Форма входа и синтетические пароли
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-emerald-600">✓</span> Фиктивная файловая система (Fake-FS)
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-emerald-600">✓</span> Фиксация сессий и перебор учёток
            </div>
          </div>
        </div>
      </div>

      {/* General Profile Fields */}
      <div className="space-y-4 pt-2">
        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Название профиля <span className="text-rose-500">*</span>
          </label>
          <input
            type="text"
            required
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="например: Корпоративный веб-архив Ubuntu 24.04 (Low HTTP)"
            className={`w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 ${
              errors.name ? 'border-rose-400 bg-rose-50/30' : 'border-slate-300 bg-white'
            }`}
          />
          {errors.name ? (
            <p className="text-xs text-rose-600 mt-1">{errors.name}</p>
          ) : (
            <p className="text-[11px] text-slate-400 mt-1">От 1 до 120 символов. Уникальное имя в каталоге C2.</p>
          )}
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Описание назначения профиля
          </label>
          <textarea
            rows={3}
            maxLength={2000}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Опишите сценарий эмуляции: сегмент сети, целевые сервисы и ожидаемое поведение злоумышленника..."
            className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white"
          />
          <div className="flex justify-between text-[11px] text-slate-400 mt-1">
            <span>Не более 2000 байт. Отображается операторам при назначении ловушкам.</span>
            <span>{description.length}/2000</span>
          </div>
        </div>
      </div>

      {/* Architectural Notice */}
      <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg flex items-start gap-2.5 text-xs text-slate-600">
        <Info className="w-4 h-4 text-brand-600 shrink-0 mt-0.5" />
        <div>
          <strong className="text-slate-800">Серверная архитектура шаблонов:</strong> Все профили строго валидируются сервером управления по схеме BE-01. Дополнительные движки приманок (SSH, RDP, SMB) активируются только при наличии соответствующей поддержки на стороне агента.
        </div>
      </div>
    </div>
  );
};
