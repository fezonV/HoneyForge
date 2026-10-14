import React from 'react';
import {
  Shield,
  Activity,
  Layers,
  Radio,
  FileText,
  UserCheck,
  LogOut,
  SlidersHorizontal,
  WifiOff,
} from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { RoleBadge } from './Badge';

export type NavTab = 'overview' | 'profiles' | 'traps' | 'events' | 'audit';

interface HeaderProps {
  currentTab: NavTab;
  onSelectTab: (tab: NavTab) => void;
  wsStatus?: 'connected' | 'connecting' | 'disconnected';
}

export const Header: React.FC<HeaderProps> = ({
  currentTab,
  onSelectTab,
  wsStatus = 'connected',
}) => {
  const { user, role, logout, isDevMode, toggleDevMode, switchDevRole } = useAuth();

  const navItems: Array<{ id: NavTab; label: string; icon: React.ReactNode }> = [
    { id: 'overview', label: 'Обзор', icon: <Activity className="w-4 h-4" /> },
    { id: 'profiles', label: 'Профили', icon: <Layers className="w-4 h-4" /> },
    { id: 'traps', label: 'Ловушки', icon: <Radio className="w-4 h-4" /> },
    { id: 'events', label: 'События', icon: <FileText className="w-4 h-4" /> },
    { id: 'audit', label: 'Аудит', icon: <UserCheck className="w-4 h-4" /> },
  ];

  return (
    <header className="sticky top-0 z-40 bg-white border-b border-slate-200 shadow-xs">
      {/* Top utility bar */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo & Brand: только название проекта слева */}
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-md bg-brand-600 flex items-center justify-center text-white shadow-xs">
              <Shield className="w-4.5 h-4.5" />
            </div>
            <span className="font-bold text-lg text-slate-900 tracking-tight">HoneyForge</span>
          </div>

          {/* Center Navigation */}
          <nav className="flex space-x-1" aria-label="Основная навигация">
            {navItems.map((item) => {
              const isActive = currentTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => onSelectTab(item.id)}
                  className={`flex items-center gap-2 px-3.5 py-2 rounded-md text-sm font-medium transition-all ${
                    isActive
                      ? 'bg-brand-50 text-brand-700 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                  }`}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <span className={isActive ? 'text-brand-600' : 'text-slate-400'}>{item.icon}</span>
                  <span>{item.label}</span>
                  {isActive && (
                    <span className="w-1.5 h-1.5 rounded-full bg-brand-600 ml-0.5" />
                  )}
                </button>
              );
            })}
          </nav>

          {/* Right section: WebSocket pill, DevMode, Role, Profile */}
          <div className="flex items-center gap-2.5">
            {/* Realtime WebSocket indicator: rounded-md */}
            <div
              className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border ${
                wsStatus === 'connected'
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  : wsStatus === 'connecting'
                  ? 'bg-amber-50 text-amber-700 border-amber-200'
                  : 'bg-rose-50 text-rose-700 border-rose-200'
              }`}
              title={
                wsStatus === 'connected'
                  ? 'WebSocket подключен (Realtime поток событий активен)'
                  : 'WebSocket переподключается...'
              }
            >
              {wsStatus === 'connected' ? (
                <>
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                  </span>
                  <span>Live WS</span>
                </>
              ) : (
                <>
                  <WifiOff className="w-3.5 h-3.5" />
                  <span>WS Офлайн</span>
                </>
              )}
            </div>

            {/* Dev mode switch badge: rounded-md */}
            {import.meta.env.DEV && <button
              onClick={toggleDevMode}
              className={`text-xs px-2.5 py-1.5 rounded-md font-medium border transition-colors ${
                isDevMode
                  ? 'bg-amber-50 text-amber-800 border-amber-300 hover:bg-amber-100'
                  : 'bg-slate-100 text-slate-600 border-slate-300 hover:bg-slate-200'
              }`}
              title="Нажмите для переключения между фикстурами и реальным API"
            >
              {isDevMode ? '⚠️ Фикстуры BE-01' : 'Боевой API'}
            </button>}

            {/* Role indicator: rounded-md */}
            {role && (
              <div className="flex items-center gap-1.5">
                <RoleBadge role={role} />
                {isDevMode && (
                  <button
                    onClick={() => switchDevRole(role === 'operator' ? 'viewer' : 'operator')}
                    className="p-1.5 text-slate-400 hover:text-slate-600 rounded-md hover:bg-slate-100 border border-transparent hover:border-slate-200 transition-colors"
                    title={`Переключить роль на ${role === 'operator' ? 'Viewer' : 'Operator'}`}
                  >
                    <SlidersHorizontal className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            )}

            {/* User display & Logout */}
            <div className="flex items-center gap-2 pl-2 border-l border-slate-200">
              <span className="text-xs text-slate-600 font-medium hidden md:inline-block">
                {user?.display_name || user?.username}
              </span>
              <button
                onClick={logout}
                className="p-1.5 text-slate-400 hover:text-rose-600 rounded-md hover:bg-rose-50 transition-colors"
                title="Выйти из системы"
                aria-label="Выйти из системы"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};
