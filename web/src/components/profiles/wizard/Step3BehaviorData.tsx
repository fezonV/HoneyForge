import React from 'react';
import { Plus, Trash2, Key, FolderTree, Sparkles, Sliders } from 'lucide-react';
import { VisibleTexts, SyntheticCredential, FakeFile, MaskingConfig } from '../../../api/types';

interface Step3Props {
  level: 'low' | 'medium';
  visibleTexts: VisibleTexts;
  setVisibleTexts: (texts: VisibleTexts) => void;
  credentials: SyntheticCredential[];
  setCredentials: (creds: SyntheticCredential[]) => void;
  fakeFs: FakeFile[];
  setFakeFs: (files: FakeFile[]) => void;
  masking: MaskingConfig;
  setMasking: (masking: MaskingConfig) => void;
  errors: Record<string, string>;
}

export const Step3BehaviorData: React.FC<Step3Props> = ({
  level,
  visibleTexts,
  setVisibleTexts,
  credentials,
  setCredentials,
  fakeFs,
  setFakeFs,
  masking,
  setMasking,
  errors,
}) => {
  const isMedium = level === 'medium';

  // Credentials Handlers
  const handleAddCredential = () => {
    if (credentials.length >= 100) return;
    setCredentials([
      ...credentials,
      { username: `user_${credentials.length + 1}`, password: 'Password2026!' },
    ]);
  };

  const handleGenerateSampleCreds = () => {
    setCredentials([
      { username: 'admin', password: 'AdminPassword2026!' },
      { username: 'operator', password: 'Operator#Secure99' },
      { username: 'archivist', password: 'ArchiveMasterPass!1' },
    ]);
  };

  const handleRemoveCredential = (index: number) => {
    setCredentials(credentials.filter((_, idx) => idx !== index));
  };

  const handleUpdateCredential = (index: number, patch: Partial<SyntheticCredential>) => {
    setCredentials(
      credentials.map((c, idx) => (idx === index ? { ...c, ...patch } : c))
    );
  };

  // Fake Filesystem Handlers
  const handleAddFile = () => {
    if (fakeFs.length >= 200) return;
    const idx = fakeFs.length + 1;
    setFakeFs([
      ...fakeFs,
      {
        path: `/documents/notes/catalog-note-${idx}.txt`,
        content: `Служебная записка архива #${idx}. Документ зарегистрирован в реестре фонда.`,
      },
    ]);
  };

  const handleGenerateSampleFs = () => {
    setFakeFs([
      {
        path: '/regulations/archive-rules.txt',
        content: 'Регламент доступа к архивному фонду. Утверждён приказом № 42-А.\nВсе действия пользователей логируются.',
      },
      {
        path: '/reports/quarterly-review-q3.txt',
        content: 'Квартальный отчёт инвентаризации документов.\nВсего проверено: 154 дела.\nНарушений не выявлено.',
      },
      {
        path: '/notes/reader-guide.txt',
        content: 'Инструкция для исследователей по заказу архивных описей и электронных копий.',
      },
    ]);
  };

  const handleRemoveFile = (index: number) => {
    setFakeFs(fakeFs.filter((_, idx) => idx !== index));
  };

  const handleUpdateFile = (index: number, patch: Partial<FakeFile>) => {
    setFakeFs(
      fakeFs.map((f, idx) => (idx === index ? { ...f, ...patch } : f))
    );
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-base font-bold text-slate-900">Шаг 3: Поведение, тексты и фиктивные данные</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          {isMedium
            ? 'Настройте тексты портала, синтетические пароли и эмулируемую файловую систему (Fake-FS)'
            : 'Настройте видимые тексты каталога архива и параметры маскировки процессов'}
        </p>
      </div>

      {/* Visible Texts Section */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-4">
        <div className="flex items-center gap-2 pb-2 border-b border-slate-100">
          <Sliders className="w-4 h-4 text-brand-600" />
          <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wide">
            Видимые тексты приманки (Visible Texts)
          </h3>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-[11px] font-semibold text-slate-700 mb-1">
              Заголовок сервиса (Title) <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              maxLength={4096}
              value={visibleTexts.title}
              onChange={(e) => setVisibleTexts({ ...visibleTexts, title: e.target.value })}
              placeholder="Городской электронный архив"
              className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-700 mb-1">
              {isMedium ? 'Приглашение ко входу (Login Prompt)' : 'Описание каталога (Description)'}
            </label>
            <input
              type="text"
              maxLength={4096}
              value={visibleTexts.login_prompt}
              onChange={(e) => setVisibleTexts({ ...visibleTexts, login_prompt: e.target.value })}
              placeholder={isMedium ? 'Вход в закрытый контур архива' : 'Каталог открытых фондов'}
              className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-700 mb-1">
              Сообщение успеха (Success)
            </label>
            <input
              type="text"
              maxLength={4096}
              value={visibleTexts.success}
              onChange={(e) => setVisibleTexts({ ...visibleTexts, success: e.target.value })}
              placeholder="Доступ разрешён. Загрузка фонда..."
              className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-700 mb-1">
              Сообщение об ошибке (Failure)
            </label>
            <input
              type="text"
              maxLength={4096}
              value={visibleTexts.failure}
              onChange={(e) => setVisibleTexts({ ...visibleTexts, failure: e.target.value })}
              placeholder="Неверное имя пользователя или пароль"
              className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
        </div>
      </div>

      {/* MEDIUM: Synthetic Credentials Section */}
      {isMedium && (
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-2 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <Key className="w-4 h-4 text-amber-600" />
              <div>
                <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wide">
                  Синтетические учётные данные (Synthetic Credentials)
                </h3>
                <span className="text-[11px] text-slate-500">
                  Фиксация атак перебора паролей (до 100 записей). На сервере пароли маскируются для наблюдателей.
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleGenerateSampleCreds}
                className="text-[11px] text-brand-700 hover:text-brand-900 font-semibold px-2 py-1 rounded border border-brand-200 bg-brand-50 hover:bg-brand-100 transition-colors inline-flex items-center gap-1"
              >
                <Sparkles className="w-3 h-3" /> Сгенерировать примеры
              </button>
              <button
                type="button"
                onClick={handleAddCredential}
                disabled={credentials.length >= 100}
                className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg text-xs font-semibold transition-colors"
              >
                <Plus className="w-3 h-3" /> Добавить учётку ({credentials.length}/100)
              </button>
            </div>
          </div>

          {errors.synthetic_credentials && (
            <p className="text-xs text-rose-600 font-medium">{errors.synthetic_credentials}</p>
          )}

          {credentials.length === 0 ? (
            <div className="text-center py-6 text-slate-400 text-xs border border-dashed border-slate-200 rounded-lg">
              Нет добавленных учётных записей. Нажмите «Сгенерировать примеры» или добавьте вручную.
            </div>
          ) : (
            <div className="space-y-2.5 max-h-60 overflow-y-auto pr-1">
              {credentials.map((cred, idx) => (
                <div key={idx} className="flex items-center gap-3 bg-slate-50 p-2.5 rounded-lg border border-slate-200">
                  <span className="text-[11px] font-mono text-slate-400 w-6 text-center">{idx + 1}</span>

                  <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <input
                      type="text"
                      maxLength={128}
                      required
                      value={cred.username}
                      onChange={(e) => handleUpdateCredential(idx, { username: e.target.value })}
                      placeholder="Имя пользователя (username)"
                      className="px-2.5 py-1 text-xs border border-slate-300 rounded bg-white font-mono"
                    />

                    <input
                      type="text"
                      maxLength={256}
                      value={cred.password || ''}
                      onChange={(e) => handleUpdateCredential(idx, { password: e.target.value })}
                      placeholder="Пароль (password)"
                      className="px-2.5 py-1 text-xs border border-slate-300 rounded bg-white font-mono"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={() => handleRemoveCredential(idx)}
                    className="p-1 text-slate-400 hover:text-rose-600 rounded"
                    title="Удалить"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* MEDIUM: Fake Filesystem Section */}
      {isMedium && (
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-2 border-b border-slate-100">
            <div className="flex items-center gap-2">
              <FolderTree className="w-4 h-4 text-sky-600" />
              <div>
                <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wide">
                  Фиктивная файловая система (Fake Filesystem)
                </h3>
                <span className="text-[11px] text-slate-500">
                  Эмуляция файлов и структуры каталогов архива для исследования злоумышленником (до 200 файлов)
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleGenerateSampleFs}
                className="text-[11px] text-sky-700 hover:text-sky-900 font-semibold px-2 py-1 rounded border border-sky-200 bg-sky-50 hover:bg-sky-100 transition-colors inline-flex items-center gap-1"
              >
                <Sparkles className="w-3 h-3" /> Примеры файлов
              </button>
              <button
                type="button"
                onClick={handleAddFile}
                disabled={fakeFs.length >= 200}
                className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg text-xs font-semibold transition-colors"
              >
                <Plus className="w-3 h-3" /> Добавить файл ({fakeFs.length}/200)
              </button>
            </div>
          </div>

          {errors.fake_fs && (
            <p className="text-xs text-rose-600 font-medium">{errors.fake_fs}</p>
          )}

          {fakeFs.length === 0 ? (
            <div className="text-center py-6 text-slate-400 text-xs border border-dashed border-slate-200 rounded-lg">
              Файлы не настроены. Добавьте файлы или нажмите «Примеры файлов» для быстрой загрузки.
            </div>
          ) : (
            <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
              {fakeFs.map((file, idx) => (
                <div key={idx} className="bg-slate-50 p-3 rounded-lg border border-slate-200 space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <input
                      type="text"
                      maxLength={256}
                      required
                      value={file.path}
                      onChange={(e) => handleUpdateFile(idx, { path: e.target.value })}
                      placeholder="/documents/regulations/rules.txt"
                      className="flex-1 px-2.5 py-1 text-xs font-mono border border-slate-300 rounded bg-white"
                    />
                    <button
                      type="button"
                      onClick={() => handleRemoveFile(idx)}
                      className="p-1 text-slate-400 hover:text-rose-600 rounded"
                      title="Удалить файл"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <textarea
                    rows={2}
                    value={file.content}
                    onChange={(e) => handleUpdateFile(idx, { content: e.target.value })}
                    placeholder="Содержимое эмулируемого документа..."
                    className="w-full px-2.5 py-1 text-xs font-mono border border-slate-300 rounded bg-white"
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Masking Configuration Section */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs space-y-4">
        <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wide pb-2 border-b border-slate-100">
          Параметры маскировки хоста (Host Masking & Deception)
        </h3>

        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <label className="block text-[11px] font-semibold text-slate-700 mb-1">
              Дрожание задержки (Jitter)
            </label>
            <label className="flex items-center gap-2 cursor-pointer mt-1">
              <input
                type="checkbox"
                checked={masking.jitter_enabled}
                onChange={(e) => setMasking({ ...masking, jitter_enabled: e.target.checked })}
                className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              <span className="text-xs text-slate-700">Включить джиттер</span>
            </label>
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-700 mb-1">
              Мин. задержка (сек)
            </label>
            <input
              type="number"
              min={1}
              max={60}
              value={masking.min_jitter_sec}
              onChange={(e) => setMasking({ ...masking, min_jitter_sec: Number(e.target.value) })}
              className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-lg"
            />
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-700 mb-1">
              Макс. задержка (сек)
            </label>
            <input
              type="number"
              min={1}
              max={120}
              value={masking.max_jitter_sec}
              onChange={(e) => setMasking({ ...masking, max_jitter_sec: Number(e.target.value) })}
              className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-lg"
            />
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-700 mb-1">
              Имя процесса в ОС
            </label>
            <input
              type="text"
              value={masking.hidden_service_name}
              onChange={(e) => setMasking({ ...masking, hidden_service_name: e.target.value })}
              placeholder="systemd-timesyncd-worker"
              className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-lg"
            />
          </div>
        </div>
      </div>
    </div>
  );
};
