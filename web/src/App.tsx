import React, { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { NotificationProvider } from './context/NotificationContext';
import { Header, NavTab } from './components/common/Header';
import { ViewerReadOnlyBanner } from './components/common/StateViews';
import { OverviewScreen } from './screens/OverviewScreen';
import { ProfilesScreen } from './screens/ProfilesScreen';
import { TrapsScreen } from './screens/TrapsScreen';
import { EventsScreen } from './screens/EventsScreen';
import { AuditScreen } from './screens/AuditScreen';
import { LoginScreen } from './screens/LoginScreen';
import { Loader2 } from 'lucide-react';

const MainLayout: React.FC = () => {
  const { isAuthenticated, isLoading, role } = useAuth();
  const [currentTab, setCurrentTab] = useState<NavTab>('overview');
  const [wsStatus] = useState<'connected' | 'connecting' | 'disconnected'>('connected');

  // URL hash sync for browser back/forward and direct tab links
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.replace('#', '') as NavTab;
      if (['overview', 'profiles', 'traps', 'events', 'audit'].includes(hash)) {
        setCurrentTab(hash);
      }
    };

    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const handleSelectTab = (tab: NavTab) => {
    setCurrentTab(tab);
    window.location.hash = tab;
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-brand-600 animate-spin" />
          <span className="text-sm font-medium text-slate-600">Проверка сессии оператора...</span>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginScreen />;
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans">
      {/* Top Header */}
      <Header
        currentTab={currentTab}
        onSelectTab={handleSelectTab}
        wsStatus={wsStatus}
      />

      {/* Viewer read-only warning bar if viewer role */}
      {role === 'viewer' && <ViewerReadOnlyBanner />}

      {/* Main Content View */}
      <main className="flex-1">
        {currentTab === 'overview' && <OverviewScreen />}
        {currentTab === 'profiles' && <ProfilesScreen />}
        {currentTab === 'traps' && <TrapsScreen />}
        {currentTab === 'events' && <EventsScreen />}
        {currentTab === 'audit' && <AuditScreen />}
      </main>

      {/* Standard Footer */}
      <footer className="bg-white border-t border-slate-200 py-4 mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex flex-wrap items-center justify-between text-xs text-slate-500 gap-2">
          <div className="flex items-center gap-2">
            <span>HoneyForge C2 Platform · Мадригал (Хакатон UmirHack)</span>
            <span className="text-slate-300">|</span>
            <span>Контур управления: Изолирован</span>
          </div>
          <div className="flex items-center gap-4">
            <span>Версия API: v1.0-contract</span>
            <span>Статус: Готов к интеграции BE-01/BE-04</span>
          </div>
        </div>
      </footer>
    </div>
  );
};

export function App() {
  return (
    <NotificationProvider>
      <AuthProvider>
        <MainLayout />
      </AuthProvider>
    </NotificationProvider>
  );
}

export default App;
