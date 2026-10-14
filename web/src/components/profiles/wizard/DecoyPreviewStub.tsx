import React from 'react';
import { AlertCircle, FileText, Key, Server, Radio, Layers } from 'lucide-react';
import { ProfileConfig } from '../../../api/types';

interface DecoyPreviewStubProps {
  name: string;
  config: ProfileConfig;
}

export const DecoyPreviewStub: React.FC<DecoyPreviewStubProps> = ({ name, config }) => {
  const isMedium = config.level === 'medium';

  return (
    <div className="space-y-4">
      {/* Explicit Stub Notice Banner */}
      <div className="p-4 bg-amber-50 border border-amber-300 rounded-xl">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="text-xs space-y-1">
            <h4 className="font-bold text-amber-900 text-sm">
              Временная заглушка предпросмотра (ожидает интеграции TL-01 #18)
            </h4>
            <p className="text-amber-800 leading-relaxed">
              По техническому заданию (FE1-02 / Issue #7), до готовности задачи тимлида TL-01 (#18) используется простая явно обозначенная заглушка. Она не является финальным результатом.
            </p>
            <p className="text-amber-700 text-[11px]">
              Подключение компонентов предпросмотра TL-01 будет выполнено отдельным заключительным PR. Дублирующий комплект оформленных страниц Low/Medium в рамках задач FE1 намеренно не создаётся.
            </p>
          </div>
        </div>
      </div>

      {/* Structured Configuration Overview */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
        <div className="px-4 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-slate-500" />
            <span className="font-semibold text-xs text-slate-800">
              Параметры профиля «{name || 'Новый профиль'}»
            </span>
          </div>
          <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full uppercase ${
            isMedium ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'
          }`}>
            {config.level} ({config.template_id})
          </span>
        </div>

        <div className="p-4 space-y-4 text-xs">
          {/* Visible Texts */}
          <div>
            <h5 className="font-semibold text-slate-700 flex items-center gap-1.5 mb-2">
              <FileText className="w-3.5 h-3.5 text-brand-600" />
              Тексты приманки (Visible Texts)
            </h5>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 bg-slate-50 p-3 rounded-lg border border-slate-100">
              <div>
                <span className="text-slate-400 text-[11px] block">Заголовок страницы:</span>
                <span className="text-slate-800 font-medium">{config.visible_texts?.title || name || '—'}</span>
              </div>
              <div>
                <span className="text-slate-400 text-[11px] block">Приглашение к аутентификации:</span>
                <span className="text-slate-800 font-medium">{config.visible_texts?.login_prompt || '—'}</span>
              </div>
              <div>
                <span className="text-slate-400 text-[11px] block">Сообщение об успехе:</span>
                <span className="text-slate-800 font-medium">{config.visible_texts?.success || '—'}</span>
              </div>
              <div>
                <span className="text-slate-400 text-[11px] block">Сообщение об отказе:</span>
                <span className="text-slate-800 font-medium">{config.visible_texts?.failure || '—'}</span>
              </div>
            </div>
          </div>

          {/* Services & Ports */}
          <div>
            <h5 className="font-semibold text-slate-700 flex items-center gap-1.5 mb-2">
              <Server className="w-3.5 h-3.5 text-brand-600" />
              Сервисы и порты ({config.services.length})
            </h5>
            <div className="space-y-1.5">
              {config.services.map((svc) => (
                <div key={svc.id} className="flex items-center justify-between bg-slate-50 px-3 py-2 rounded-lg border border-slate-100 font-mono text-[11px]">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-800">{svc.name}</span>
                    <span className="text-slate-500">порт {svc.port}/{svc.protocol.toUpperCase()}</span>
                  </div>
                  {svc.banner && (
                    <span className="text-slate-400 truncate max-w-[200px]" title={svc.banner}>
                      banner: {svc.banner}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Synthetic Credentials and Fake FS (for Medium) */}
          {isMedium ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="border border-slate-200 rounded-lg p-3">
                <h6 className="font-semibold text-slate-700 flex items-center gap-1.5 mb-2">
                  <Key className="w-3.5 h-3.5 text-amber-600" />
                  Учётные записи ({config.synthetic_credentials.length})
                </h6>
                {config.synthetic_credentials.length === 0 ? (
                  <p className="text-slate-400 text-[11px]">Нет настроенных учётных записей</p>
                ) : (
                  <div className="max-h-28 overflow-y-auto space-y-1">
                    {config.synthetic_credentials.map((cred, idx) => (
                      <div key={idx} className="text-[11px] font-mono text-slate-600 bg-slate-50 px-2 py-1 rounded">
                        {cred.username} : {cred.password ? '••••••••' : '(пусто)'}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="border border-slate-200 rounded-lg p-3">
                <h6 className="font-semibold text-slate-700 flex items-center gap-1.5 mb-2">
                  <FileText className="w-3.5 h-3.5 text-amber-600" />
                  Синтетические файлы ({config.fake_fs.length})
                </h6>
                {config.fake_fs.length === 0 ? (
                  <p className="text-slate-400 text-[11px]">Нет настроенных файлов</p>
                ) : (
                  <div className="max-h-28 overflow-y-auto space-y-1">
                    {config.fake_fs.map((file, idx) => (
                      <div key={idx} className="text-[11px] font-mono text-slate-600 bg-slate-50 px-2 py-1 rounded truncate" title={file.path}>
                        {file.path} ({file.content ? `${file.content.length} симв.` : 'пустой'})
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="p-3 bg-slate-50 border border-slate-100 rounded-lg text-slate-500 text-[11px]">
              Для уровня Low синтетические учётные записи и динамическая файловая система не применяются (статический ответ).
            </div>
          )}

          {/* Channel & Telemetry */}
          <div className="pt-2 border-t border-slate-100">
            <h6 className="font-semibold text-slate-700 flex items-center gap-1.5 mb-1.5">
              <Radio className="w-3.5 h-3.5 text-brand-600" />
              Канал связи и аудит
            </h6>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-slate-600 bg-slate-50 p-2.5 rounded-lg border border-slate-100">
              <div>TLS шифрование: <span className="font-semibold text-slate-800">{config.channel.tls_required ? 'Обязательно' : 'Отключено'}</span></div>
              <div>Интервалы: <span className="font-semibold text-slate-800">Heartbeat {config.channel.heartbeat_seconds}с, Sync {config.channel.sync_seconds}с</span></div>
              <div className="sm:col-span-2">
                Категории журнала: <span className="font-mono text-slate-800">{config.logging.categories.join(', ')}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
