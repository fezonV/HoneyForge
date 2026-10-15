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
import { useTrapRealtime } from './api/realtime';

const MainLayout: React.FC = () => {
  const { isAuthenticated, isLoading, role, isDevMode, user } = useAuth();
  const [currentTab, setCurrentTab] = useState<NavTab>('overview');
  const realtime = useTrapRealtime(isAuthenticated && !isLoading && !isDevMode, user?.id);

  // URL hash sync for browser back/forward and direct tab links
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.replace('#', '').split(/[/?]/)[0] as NavTab;
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
        wsStatus={realtime.status}
      />

      {/* Viewer read-only warning bar if viewer role */}
      {role === 'viewer' && <ViewerReadOnlyBanner />}

      {/* Main Content View */}
      <main className="flex-1">
        {currentTab === 'overview' && <OverviewScreen key={`${user?.id}:${role}:${isDevMode}`} connectionStatus={realtime.status} />}
        {currentTab === 'profiles' && <ProfilesScreen />}
        {currentTab === 'traps' && <TrapsScreen realtimeRevision={realtime.revision} />}
        {currentTab === 'events' && <EventsScreen key={`${user?.id}:${role}:${isDevMode}`} eventRevision={realtime.eventRevision} connectionStatus={realtime.status} />}
        {currentTab === 'audit' && <AuditScreen />}
      </main>

      {/* Footer */}
      <footer className="bg-white border-t border-slate-200 py-3 mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex items-center justify-center text-xs text-slate-500">
          <span>HoneyForge · Проект разработан для хакатона UmirHack (III Межрегиональный Хакатон)</span>
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
