import React from 'react';
import { Plus, Trash2, AlertTriangle } from 'lucide-react';
import { ServiceConfig } from '../../../api/types';

interface Step2Props {
  services: ServiceConfig[];
  setServices: (services: ServiceConfig[]) => void;
  errors: Record<string, string>;
}

export const Step2ServicesPorts: React.FC<Step2Props> = ({ services, setServices, errors }) => {
  const handleAddService = () => {
    if (services.length >= 16) return;
    const nextIdx = services.length + 1;
    const defaultPorts = [80, 8080, 8000, 8888, 8443, 3000, 5000];
    const usedPorts = new Set(services.map((s) => s.port));
    const nextPort = defaultPorts.find((p) => !usedPorts.has(p)) || (8000 + nextIdx);

    setServices([
      ...services,
      {
        id: `svc-http-${nextIdx}`,
        name: `HTTP Service #${nextIdx}`,
        port: nextPort,
        protocol: 'http',
        banner: 'nginx/1.24.0 (Ubuntu)',
      },
    ]);
  };

  const handleRemoveService = (index: number) => {
    if (services.length <= 1) return;
    setServices(services.filter((_, idx) => idx !== index));
  };

  const handleUpdateService = (index: number, patch: Partial<ServiceConfig>) => {
    setServices(
      services.map((svc, idx) => (idx === index ? { ...svc, ...patch } : svc))
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-slate-900">Шаг 2: Эмулируемые сервисы и сетевые порты</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Настройте внутренние порты приманки и баннеры веб-сервисов (от 1 до 16 сервисов)
          </p>
        </div>

        <button
          type="button"
          onClick={handleAddService}
          disabled={services.length >= 16}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-brand-50 hover:bg-brand-100 text-brand-700 border border-brand-200 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50"
        >
          <Plus className="w-3.5 h-3.5" /> Добавить сервис ({services.length}/16)
        </button>
      </div>

      {/* Critical Container Recreation Notice (FR-C1 Requirement) */}
      <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-3 text-xs text-amber-800">
        <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="font-semibold text-amber-900">
            ⚠️ Различие порта сервиса и сетевого биндинга (Host-Port Binding):
          </p>
          <p className="leading-relaxed text-amber-800">
            Порты сервиса в профиле задают конфигурацию среды эмуляции. Внешняя привязка к портам хоста (Deployment Binding) настраивается отдельно при развёртывании ловушки.
            <strong> Любое изменение портов в новой ревизии профиля потребует подготовки и запуска нового deployment на узле.</strong>
          </p>
        </div>
      </div>

      {/* General Services Error */}
      {errors.services && (
        <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-700 font-medium">
          {errors.services}
        </div>
      )}

      {/* Services List */}
      <div className="space-y-4">
        {services.map((svc, idx) => {
          const idErr = errors[`services[${idx}].id`];
          const nameErr = errors[`services[${idx}].name`];
          const portErr = errors[`services[${idx}].port`];
          const protoErr = errors[`services[${idx}].protocol`];

          return (
            <div
              key={idx}
              className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-3 relative hover:border-slate-300 transition-colors"
            >
              <div className="flex items-center justify-between pb-2 border-b border-slate-100">
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-md bg-slate-100 text-slate-700 font-bold text-xs flex items-center justify-center">
                    {idx + 1}
                  </span>
                  <span className="text-xs font-bold text-slate-900">{svc.name || 'Безымянный сервис'}</span>
                </div>

                {services.length > 1 && (
                  <button
                    type="button"
                    onClick={() => handleRemoveService(idx)}
                    className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded transition-colors"
                    title="Удалить сервис"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {/* Service ID */}
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    Идентификатор (Service ID) <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={64}
                    value={svc.id || ''}
                    onChange={(e) => handleUpdateService(idx, { id: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') })}
                    placeholder="svc-http-01"
                    className={`w-full px-2.5 py-1.5 text-xs font-mono border rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500 ${
                      idErr ? 'border-rose-400 bg-rose-50/40' : 'border-slate-300'
                    }`}
                  />
                  {idErr && <p className="text-[11px] text-rose-600 mt-0.5">{idErr}</p>}
                </div>

                {/* Service Name */}
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    Название сервиса <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    maxLength={100}
                    value={svc.name}
                    onChange={(e) => handleUpdateService(idx, { name: e.target.value })}
                    placeholder="Archive Public Gateway"
                    className={`w-full px-2.5 py-1.5 text-xs border rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500 ${
                      nameErr ? 'border-rose-400 bg-rose-50/40' : 'border-slate-300'
                    }`}
                  />
                  {nameErr && <p className="text-[11px] text-rose-600 mt-0.5">{nameErr}</p>}
                </div>

                {/* Service Port */}
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    Порт сервиса <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    required
                    value={svc.port}
                    onChange={(e) => handleUpdateService(idx, { port: Number(e.target.value) })}
                    className={`w-full px-2.5 py-1.5 text-xs font-mono border rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500 ${
                      portErr ? 'border-rose-400 bg-rose-50/40' : 'border-slate-300'
                    }`}
                  />
                  {portErr && <p className="text-[11px] text-rose-600 mt-0.5">{portErr}</p>}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {/* Protocol (Only HTTP is supported) */}
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    Протокол сервиса
                  </label>
                  <div className="flex items-center gap-2 px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs font-mono text-slate-700">
                    <span className="w-2 h-2 rounded-full bg-emerald-500" />
                    <span>HTTP (поддерживается)</span>
                  </div>
                  {protoErr && <p className="text-[11px] text-rose-600 mt-0.5">{protoErr}</p>}
                </div>

                {/* Banner / Server Header */}
                <div className="md:col-span-2">
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    HTTP Баннер (Server Header)
                  </label>
                  <input
                    type="text"
                    maxLength={4096}
                    value={svc.banner || ''}
                    onChange={(e) => handleUpdateService(idx, { banner: e.target.value })}
                    placeholder="nginx/1.24.0 (Ubuntu)"
                    className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500"
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
