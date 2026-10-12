import React, { useState } from 'react';
import { Shield, Lock, User, ArrowRight, AlertCircle, Info } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Button } from '../components/common/Button';

export const LoginScreen: React.FC = () => {
  const { login, isLoading } = useAuth();
  const [username, setUsername] = useState<string>('soc_operator');
  const [password, setPassword] = useState<string>('HoneyForge2026!');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;

    setIsSubmitting(true);
    setErrorMessage(null);

    const success = await login(username.trim(), password);
    if (!success) {
      setErrorMessage('Неверное имя пользователя или пароль. Проверьте введенные данные.');
    }
    setIsSubmitting(false);
  };

  const setPreset = (u: string, p: string) => {
    setUsername(u);
    setPassword(p);
    setErrorMessage(null);
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

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md px-4 sm:px-0">
        <div className="bg-white py-8 px-6 shadow-sm rounded-xl border border-slate-200 sm:px-10">
          <form className="space-y-5" onSubmit={handleSubmit}>
            {errorMessage && (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-xs text-rose-800 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-rose-600 flex-shrink-0" />
                <span>{errorMessage}</span>
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
              className="w-full"
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
                className="p-2 border border-slate-200 rounded-lg text-left hover:bg-slate-50 transition-colors"
              >
                <div className="font-semibold text-slate-800">soc_operator</div>
                <div className="text-[11px] text-brand-600">Роль: Operator (полный)</div>
              </button>
              <button
                type="button"
                onClick={() => setPreset('soc_viewer', 'ViewerPass2026!')}
                className="p-2 border border-slate-200 rounded-lg text-left hover:bg-slate-50 transition-colors"
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
