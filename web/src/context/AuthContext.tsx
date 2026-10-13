import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { User, UserRole } from '../api/types';
import { api, isDevModeActive, setDevModeActive } from '../api/client';
import { useNotification } from './NotificationContext';

interface AuthContextType {
  user: User | null;
  role: UserRole | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isDevMode: boolean;
  login: (username: string, password: string) => Promise<{ success: boolean; error?: string; isBackendUnavailable?: boolean }>;
  logout: () => Promise<void>;
  switchDevRole: (role: UserRole) => Promise<void>;
  toggleDevMode: () => void;
  checkSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isDevMode, setIsDevMode] = useState<boolean>(isDevModeActive());
  const { notify } = useNotification();

  const checkSession = useCallback(async () => {
    setIsLoading(true);
    try {
      const session = await api.auth.getMe();
      if (session.authenticated && session.user) {
        setUser(session.user);
      } else {
        setUser(null);
      }
    } catch (err: any) {
      setUser(null);
      if (err.status !== 401 && !err.isNetworkError) {
        notify('error', 'Ошибка проверки сессии', err.message);
      }
    } finally {
      setIsLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    checkSession();

    const handleDevModeChange = () => {
      setIsDevMode(isDevModeActive());
      checkSession();
    };

    const handleSessionExpired = () => {
      setUser(null);
      notify('warning', 'Сессия истекла', 'Время сессии истекло. Пожалуйста, выполните вход повторно.');
    };

    window.addEventListener('honeyforge-devmode-changed', handleDevModeChange);
    window.addEventListener('honeyforge-session-expired', handleSessionExpired);
    return () => {
      window.removeEventListener('honeyforge-devmode-changed', handleDevModeChange);
      window.removeEventListener('honeyforge-session-expired', handleSessionExpired);
    };
  }, [checkSession, notify]);

  const login = async (
    username: string,
    password: string
  ): Promise<{ success: boolean; error?: string; isBackendUnavailable?: boolean }> => {
    try {
      const session = await api.auth.login(username, password);
      if (session.authenticated && session.user) {
        setUser(session.user);
        notify('success', 'Авторизация успешна', `Добро пожаловать, ${session.user.display_name}`);
        return { success: true };
      }
      return { success: false, error: 'Сервер вернул пустую сессию' };
    } catch (err: any) {
      const isUnavailable = err.status >= 500 || err.status === 0 || err.isNetworkError;
      const errorMsg = isUnavailable
        ? `Сервер бэкенда недоступен (${err.message || err.status || '500'})`
        : err.message || 'Неверное имя пользователя или пароль';

      notify('error', 'Ошибка авторизации', errorMsg);
      return { success: false, error: errorMsg, isBackendUnavailable: isUnavailable };
    }
  };

  const logout = async () => {
    try {
      await api.auth.logout();
      setUser(null);
      notify('info', 'Сессия завершена', 'Вы успешно вышли из системы управления');
    } catch {
      setUser(null);
      notify('warning', 'Завершение сессии', 'Локальная сессия очищена');
    }
  };

  const switchDevRole = async (newRole: UserRole) => {
    const updatedUser = await api.auth.switchDevRole(newRole);
    setUser(updatedUser);
    notify('info', 'Роль переключена (тестовый режим)', `Текущая роль: ${newRole.toUpperCase()}`);
  };

  const toggleDevMode = () => {
    const nextState = !isDevMode;
    setDevModeActive(nextState);
    notify(
      nextState ? 'warning' : 'info',
      nextState ? 'Включен режим фикстур BE-01' : 'Включен боевой режим API (/api)'
    );
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        role: user ? user.role : null,
        isAuthenticated: !!user,
        isLoading,
        isDevMode,
        login,
        logout,
        switchDevRole,
        toggleDevMode,
        checkSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};
