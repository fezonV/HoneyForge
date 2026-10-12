import React, { useState } from 'react';
import {
  Shield,
  Lock,
  User,
  ArrowRight,
  AlertCircle,
  Info,
  Server,
  Zap,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Button } from '../components/common/Button';

export const LoginScreen: React.FC = () => {
  const { login, isLoading, isDevMode, toggleDevMode } = useAuth();
  const [username, setUsername] = useState<string>('soc_operator');
  const [password, setPassword] = useState<string>('HoneyForge2026!');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isBackendError, setIsBackendError] = useState<boolean>(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;

    setIsSubmitting(true);
    setErrorMessage(null);
    setIsBackendError(false);

    const res = await login(username.trim(), password);
    if (!res.success) {
      setErrorMessage(res.error || 'Неверное имя пользователя или пароль.');
      if (res.isBackendUnavailable) {
        setIsBackendError(true);
      }
    }
    setIsSubmitting(false);
  };

  const setPreset = async (u: string, p: string) => {
    setUsername(u);
    setPassword(p);
    setErrorMessage(null);
    setIsBackendError(false);

    // If currently in real API mode, clicking a demo credential automatically activates dev fixtures
    if (!isDevMode) {
      toggleDevMode();
    }
  };

  const handleSwitchToFixturesAndLogin = async () => {
    if (!isDevMode) {
      toggleDevMode();
    }
    setErrorMessage(null);
    setIsBackendError(false);
    setIsSubmitting(true);
    await login(username.trim() || 'soc_operator', password || 'HoneyForge2026!');
    setIsSubmitting(false);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-brand-600 text-white shadow-md mb-4">
          <Shield className="w-8 h-8" />
        </div>
        <h2 className="text-2xl font-extrabold text-slate-900 tracking-tight">HoneyForge C2 Core</h2>
        <p className="mt-1 text-sm text-slate-500">
          Вход в центр управления ловушками-приманками (FR-C5)
        </p>
      </div>

      <div className="mt-6 sm:mx-auto sm:w-full sm:max-w-md px-4 sm:px-0">
        <div className="bg-white py-8 px-6 shadow-sm rounded-xl border border-slate-200 sm:px-10">
          {/* Mode Switcher Bar */}
          <div className="mb-5 p-3 rounded-lg border flex items-center justify-between text-xs transition-colors bg-slate-50 border-slate-200">
            <div className="flex items-center gap-2">
              <Server className="w-4 h-4 text-slate-500" />
              <div>
                <span className="text-slate-500 block text-[11px]">Режим источника:</span>
                <span className="font-semibold text-slate-800">
                  {isDevMode ? '⚠️ Фикстуры BE-01 (Автономный)' : 'Боевой сервер API (/api)'}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={toggleDevMode}
              className={`px-2.5 py-1 rounded text-xs font-medium border transition-colors ${
                isDevMode
                  ? 'bg-amber-100/70 text-amber-900 border-amber-300 hover:bg-amber-200/70'
                  : 'bg-white text-brand-700 border-brand-300 hover:bg-brand-50'
              }`}
            >
              {isDevMode ? 'Переключить на API' : 'Включить фикстуры'}
            </button>
          </div>

          <form className="space-y-4" onSubmit={handleSubmit}>
            {errorMessage && (
              <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-900 space-y-2">
                <div className="flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0 mt-0.5" />
                  <span className="font-medium">{errorMessage}</span>
                </div>

                {isBackendError && (
                  <div className="pt-2 border-t border-rose-200/80">
                    <p className="text-[11px] text-rose-700 mb-2">
                      Бэкенд-сервер на <code>127.0.0.1:8000</code> пока не запущен. Для автономной проверки интерфейса включите фикстуры:
                    </p>
                    <button
                      type="button"
                      onClick={handleSwitchToFixturesAndLogin}
                      className="w-full py-1.5 px-3 bg-rose-600 hover:bg-rose-700 text-white rounded font-medium text-xs transition-colors flex items-center justify-center gap-1.5"
                    >
                      <Zap className="w-3.5 h-3.5" /> Включить фикстуры BE-01 и войти
                    </button>
                  </div>
                )}
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Имя пользователя (Логин)
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                  <User className="w-4 h-4" />
                </div>
                <input
                  type="text"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="soc_operator"
                  className="block w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Пароль доступа
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                  <Lock className="w-4 h-4" />
                </div>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="block w-full pl-9 pr-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-brand-500 focus:outline-none"
                />
              </div>
            </div>

            <Button
              type="submit"
              variant="primary"
              size="md"
              className="w-full mt-2"
              isLoading={isSubmitting || isLoading}
              rightIcon={<ArrowRight className="w-4 h-4" />}
            >
              Войти в консоль
            </Button>
          </form>

          {/* Quick preset credentials for demo & evaluation */}
          <div className="mt-6 pt-5 border-t border-slate-100">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block mb-2 text-center">
              Демо-учётные записи хакатона:
            </span>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <button
                type="button"
                onClick={() => setPreset('soc_operator', 'HoneyForge2026!')}
                className="p-2 border border-slate-200 rounded-lg text-left hover:bg-slate-50 transition-colors focus:ring-2 focus:ring-brand-500"
              >
                <div className="font-semibold text-slate-800">soc_operator</div>
                <div className="text-[11px] text-brand-600">Роль: Operator (полный)</div>
              </button>
              <button
                type="button"
                onClick={() => setPreset('soc_viewer', 'ViewerPass2026!')}
                className="p-2 border border-slate-200 rounded-lg text-left hover:bg-slate-50 transition-colors focus:ring-2 focus:ring-brand-500"
              >
                <div className="font-semibold text-slate-800">soc_viewer</div>
                <div className="text-[11px] text-slate-500">Роль: Viewer (аудит)</div>
              </button>
            </div>
          </div>

          <div className="mt-5 text-[11px] text-slate-400 text-center flex items-center justify-center gap-1">
            <Info className="w-3.5 h-3.5 text-slate-400" />
            <span>Сессия защищена HttpOnly Cookie и CSRF-токеном</span>
          </div>
        </div>
      </div>
    </div>
  );
};
