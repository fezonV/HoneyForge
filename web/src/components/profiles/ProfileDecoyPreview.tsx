import React, { useState } from 'react';
import { Shield, Lock } from 'lucide-react';
import { PreviewModel } from '../../api/types';

interface ProfileDecoyPreviewProps {
  model: PreviewModel;
  level: 'low' | 'medium';
}

export const ProfileDecoyPreview: React.FC<ProfileDecoyPreviewProps> = ({ model, level }) => {
  const isMedium = level === 'medium';
  const [activeState, setActiveState] = useState<string>(model.state || (isMedium ? 'login' : 'catalog'));
  const [selectedDocId, setSelectedDocId] = useState<string>(model.selectedDocumentId || model.documents[0]?.id || '');

  const currentDoc = model.documents.find((d) => d.id === selectedDocId) || model.documents[0];

  const lowStates = [
    { id: 'catalog', label: 'Каталог документов' },
    { id: 'empty', label: 'Пустой архив' },
    { id: 'not-found', label: 'Документ не найден' },
    { id: 'unavailable', label: 'Материал недоступен' },
  ];

  const mediumStates = [
    { id: 'login', label: 'Экран входа' },
    { id: 'login-error', label: 'Ошибка логина' },
    { id: 'expired', label: 'Сессия истекла' },
    { id: 'files', label: 'Каталог после входа' },
    { id: 'file', label: 'Просмотр файла' },
    { id: 'empty', label: 'Пустой каталог' },
  ];

  const stateOptions = isMedium ? mediumStates : lowStates;

  return (
    <div className="flex flex-col h-full bg-slate-900 rounded-xl overflow-hidden border border-slate-700 shadow-xl text-slate-900">
      {/* Sandbox Preview Bar */}
      <div className="bg-slate-800 px-4 py-2.5 border-b border-slate-700 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-300">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-sky-400" />
          <span className="font-semibold text-white">TL-01 Live Decoy Preview</span>
          <span className="px-1.5 py-0.5 rounded bg-slate-700 text-[10px] text-slate-300 uppercase font-mono">
            {level.toUpperCase()} HTTP
          </span>
        </div>

        {/* State Toggle Selector */}
        <div className="flex items-center gap-1.5 overflow-x-auto">
          <span className="text-slate-400 text-[11px] mr-1">Состояние:</span>
          {stateOptions.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setActiveState(opt.id)}
              className={`px-2 py-1 rounded text-[11px] transition-colors ${
                activeState === opt.id
                  ? 'bg-sky-600 text-white font-medium shadow-xs'
                  : 'bg-slate-700/70 hover:bg-slate-700 text-slate-300'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Honeypot Browser Viewport Window */}
      <div className="flex-1 overflow-y-auto bg-white p-6 min-h-[460px] max-h-[640px] font-sans text-slate-800">
        {/* Decoy Header */}
        <header className="flex items-center gap-4 pb-4 mb-6 border-b border-slate-200">
          <div className="w-8 h-8 rounded bg-[#285d7e] text-white flex items-center justify-center font-serif font-bold text-lg select-none">
            {model.organization.trim().charAt(0) || 'А'}
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-bold text-slate-900 text-base truncate">{model.organization}</div>
            <div className="text-xs text-slate-500">{model.service}</div>
          </div>
          {isMedium && ['files', 'file', 'empty'].includes(activeState) && (
            <button
              type="button"
              onClick={() => setActiveState('login')}
              className="text-xs text-slate-600 hover:text-slate-900 px-2.5 py-1 rounded border border-slate-300 hover:bg-slate-50"
            >
              Выйти
            </button>
          )}
        </header>

        {/* Decoy Body per State */}
        {/* MEDIUM: Login Screens */}
        {isMedium && ['login', 'login-error', 'expired'].includes(activeState) && (
          <div className="max-w-md mx-auto my-6 p-6 border border-slate-200 rounded-lg bg-slate-50 shadow-xs">
            <h1 className="font-serif font-bold text-2xl text-slate-900 mb-1">{model.title}</h1>
            <p className="text-xs text-slate-500 mb-6">{model.description}</p>

            <h2 className="text-sm font-bold text-slate-800 mb-4">Вход в служебный архив</h2>

            {activeState === 'login-error' && (
              <div className="mb-4 p-3 rounded bg-rose-50 border border-rose-200 text-xs text-rose-800 font-medium">
                Не удалось войти. Проверьте имя пользователя и пароль.
              </div>
            )}

            {activeState === 'expired' && (
              <div className="mb-4 p-3 rounded bg-amber-50 border border-amber-200 text-xs text-amber-800 font-medium">
                Срок сессии истёк. Для продолжения требуется повторный вход.
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Имя пользователя</label>
                <input
                  type="text"
                  disabled
                  readOnly
                  value=""
                  placeholder="Имя пользователя"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded bg-white text-slate-600 cursor-not-allowed"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Пароль</label>
                <input
                  type="password"
                  disabled
                  readOnly
                  value=""
                  placeholder="••••••••••••"
                  className="w-full px-3 py-2 text-xs border border-slate-300 rounded bg-white text-slate-600 cursor-not-allowed"
                />
              </div>

              <button
                type="button"
                disabled
                className="w-full py-2 bg-[#285d7e] text-white text-xs font-semibold rounded opacity-80 cursor-not-allowed mt-2"
              >
                Войти в систему
              </button>
            </div>

            <p className="text-[11px] text-slate-400 mt-4 text-center">
              🔒 Приманка Medium-HTTP: имитирует закрытый портал и фиксирует попытки перебора паролей (auth.attempt)
            </p>
          </div>
        )}

        {/* File View State */}
        {activeState === 'file' && currentDoc && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setActiveState(isMedium ? 'files' : 'catalog')}
                className="text-xs text-[#285d7e] hover:underline inline-flex items-center gap-1 font-semibold"
              >
                ← Вернуться в каталог
              </button>
              <span className="font-mono text-xs text-slate-500">{currentDoc.path}</span>
            </div>

            <h1 className="font-serif font-bold text-2xl text-slate-900">{currentDoc.title}</h1>
            <div className="text-xs text-slate-400 pb-2 border-b border-slate-200">
              {currentDoc.date} · Текстовый документ · Раздел: {currentDoc.section}
            </div>

            <pre className="p-4 bg-slate-50 border border-slate-200 rounded-lg text-xs font-mono text-slate-800 whitespace-pre-wrap overflow-x-auto leading-relaxed">
              {currentDoc.body}
            </pre>
          </div>
        )}

        {/* Empty State */}
        {activeState === 'empty' && (
          <div className="text-center py-16 space-y-3">
            <span className="text-4xl text-slate-300 block font-serif">—</span>
            <h2 className="text-lg font-bold text-slate-800">Каталог пока пуст</h2>
            <p className="text-xs text-slate-500 max-w-sm mx-auto">
              В текущем архиве нет опубликованных материалов. Документы появятся после согласования архивной службой.
            </p>
          </div>
        )}

        {/* Not Found State */}
        {activeState === 'not-found' && (
          <div className="text-center py-16 space-y-3">
            <span className="text-4xl text-slate-300 block font-serif">404</span>
            <h2 className="text-lg font-bold text-slate-800">Документ не найден</h2>
            <p className="text-xs text-slate-500 max-w-sm mx-auto">
              Материал отсутствует в каталоге или был перемещён. Проверьте правильность пути.
            </p>
            <button
              type="button"
              onClick={() => setActiveState('catalog')}
              className="text-xs px-3 py-1.5 bg-[#285d7e] text-white rounded font-medium"
            >
              Вернуться в каталог
            </button>
          </div>
        )}

        {/* Unavailable State */}
        {activeState === 'unavailable' && (
          <div className="text-center py-16 space-y-3">
            <span className="text-4xl text-slate-300 block font-serif">403</span>
            <h2 className="text-lg font-bold text-slate-800">Материал недоступен</h2>
            <p className="text-xs text-slate-500 max-w-sm mx-auto">
              Эта копия архива публикует только каталог. Доступ к содержимому файлов ограничен регламентом безопасности.
            </p>
            <button
              type="button"
              onClick={() => setActiveState('catalog')}
              className="text-xs px-3 py-1.5 bg-[#285d7e] text-white rounded font-medium"
            >
              Вернуться в каталог
            </button>
          </div>
        )}

        {/* Catalog List State (Low catalog or Medium authenticated files) */}
        {(activeState === 'catalog' || (isMedium && activeState === 'files')) && (
          <div className="space-y-6">
            <div>
              <h1 className="font-serif font-bold text-2xl text-slate-900 mb-1">{model.title}</h1>
              <p className="text-xs text-slate-500 leading-relaxed">{model.description}</p>
            </div>

            {model.sections.map((sec) => {
              const secDocs = model.documents.filter((d) => d.section === sec);
              return (
                <div key={sec} className="space-y-2">
                  <div className="flex items-center justify-between pb-1.5 border-b border-slate-200">
                    <h2 className="text-xs font-bold text-slate-700 tracking-wider uppercase">{sec}</h2>
                    <span className="text-[11px] text-slate-400 font-mono">{secDocs.length} док.</span>
                  </div>

                  <div className="divide-y divide-slate-100">
                    {secDocs.map((doc) => (
                      <div
                        key={doc.id}
                        className="py-2.5 flex items-center justify-between gap-4 hover:bg-slate-50/80 px-2 rounded transition-colors"
                      >
                        <div className="min-w-0">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedDocId(doc.id);
                              setActiveState('file');
                            }}
                            className="text-xs font-semibold text-[#285d7e] hover:underline text-left block truncate"
                          >
                            {doc.title}
                          </button>
                          <span className="font-mono text-[11px] text-slate-400 block truncate">{doc.path}</span>
                        </div>
                        <span className="text-[11px] text-slate-400 whitespace-nowrap">{doc.date}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Decoy Footer */}
        <footer className="mt-12 pt-4 border-t border-slate-200 text-center text-xs text-slate-400">
          Архивная служба · {model.organization}
        </footer>
      </div>

      {/* Sandbox Security Footer */}
      <div className="bg-slate-800 px-4 py-2 border-t border-slate-700 flex items-center justify-between text-[11px] text-slate-400">
        <span className="flex items-center gap-1.5">
          <Lock className="w-3.5 h-3.5 text-amber-400" />
          Изолированный предпросмотр (JS не исполняется, сетевые запросы отключены)
        </span>
        <span className="text-slate-500 font-mono">TL-01 Adapter v1.0</span>
      </div>
    </div>
  );
};
