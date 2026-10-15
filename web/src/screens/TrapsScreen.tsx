import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Plus, RefreshCw } from 'lucide-react';
import { DeploymentBinding, Profile, ProfileRevision, Trap, TrapCommand, RegistrationAttempt } from '../api/types';
import { api, isDevModeActive } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useNotification } from '../context/NotificationContext';
import { LevelBadge, StatusBadge } from '../components/common/Badge';
import { Button } from '../components/common/Button';
import { Modal } from '../components/common/Modal';
import { EmptyState, ErrorState, LoadingSkeleton } from '../components/common/StateViews';
import { TrapControlPanel } from '../components/traps/TrapControlPanel';

const dateText = (value?: string) => value ? new Date(value).toLocaleString('ru-RU', { timeZoneName: 'short' }) : 'Никогда';
const serviceText = (value?: string) => ({ running: 'Работает', stopped: 'Остановлен', degraded: 'Работает с ошибками', error: 'Ошибка', unknown: 'Неизвестно' }[value || 'unknown'] || 'Неизвестно');

function progress(trap: Trap): string {
  if (trap.registration_status === 'rejected') return 'Отказ регистрации';
  if (!trap.last_seen_at) return trap.registration_status === 'registered' ? 'Агент зарегистрирован · ожидает связи' : 'Ожидает регистрации';
  if (trap.agent_status !== 'online') return 'Агент offline';
  if (!trap.applied_revision || trap.applied_profile_id !== trap.desired_profile_id || trap.applied_revision !== trap.desired_revision) return 'Агент зарегистрирован · ожидает применения';
  if (trap.service_status === 'running') return 'Сервис работает';
  if (trap.service_status === 'stopped') return 'Сервис остановлен';
  if (trap.service_status === 'error') return 'Ошибка сервиса';
  return 'Конфигурация применена';
}

export const TrapsScreen: React.FC<{ realtimeRevision?: number }> = ({ realtimeRevision = 0 }) => {
  const { role, user } = useAuth();
  const { notify } = useNotification();
  const [traps, setTraps] = useState<Trap[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string>();
  const [step, setStep] = useState<number | null>(null);
  const [profileId, setProfileId] = useState('');
  const [revision, setRevision] = useState(0);
  const [requestedRevision, setRequestedRevision] = useState<number | null>(null);
  const [revisions, setRevisions] = useState<ProfileRevision[]>([]);
  const [revisionError, setRevisionError] = useState('');
  const [name, setName] = useState('');
  const [node, setNode] = useState('');
  const [registrationAttempts, setRegistrationAttempts] = useState<RegistrationAttempt[]>([]);
  const [registrationError, setRegistrationError] = useState('');
  const [bindings, setBindings] = useState<DeploymentBinding[]>([]);
  const [created, setCreated] = useState<Trap | null>(null);
  const [submitError, setSubmitError] = useState('');
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<{ trapId: string; value: string; expiresAt: number } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [levelFilter, setLevelFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [profileFilter, setProfileFilter] = useState('all');
  const [tick, setTick] = useState(Date.now());
  const [revisionLoading, setRevisionLoading] = useState(false);
  const [bundleTrap, setBundleTrap] = useState<Trap | null>(null);
  const [bundleError, setBundleError] = useState('');
  const [commands, setCommands] = useState<TrapCommand[]>([]);
  const [commandsError, setCommandsError] = useState('');
  const [commandsLoading, setCommandsLoading] = useState(false);
  const [commandRevision, setCommandRevision] = useState(0);
  const refreshing = useRef(false);
  const refreshPending = useRef(false);
  const currentRole = useRef(role);
  currentRole.current = role;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    if (!token) return;
    const timeout = window.setTimeout(() => {
      setToken(null);
      notify('warning', 'Токен истёк', 'Выдайте новый токен регистрации.');
    }, Math.max(0, token.expiresAt - Date.now()));
    return () => window.clearTimeout(timeout);
  }, [token, notify]);

  useEffect(() => {
    if (role !== 'operator') { setToken(null); setStep(null); setBundleTrap(null); }
  }, [role]);

  const refresh = useCallback(async (showLoading = false) => {
    if (refreshing.current) { refreshPending.current = true; return; }
    refreshing.current = true;
    if (showLoading) setLoading(true);
    try {
      const [items, nextProfiles] = await Promise.all([api.traps.list(), api.profiles.list()]);
      const byId = new Map(nextProfiles.map((p) => [p.id, p]));
      const enriched = await Promise.all(items.map(async (trap) => {
        const profile = byId.get(trap.desired_profile_id || trap.profile_id || '');
        const assigned = trap.profile_id && trap.desired_revision
          ? await api.profiles.revision(trap.profile_id, trap.desired_revision) : null;
        return { ...trap, level: assigned?.config.level as Trap['level'] || trap.level, profile_name: profile?.name || (trap.profile_id ? 'Профиль недоступен' : 'Не назначен') };
      }));
      if (!mounted.current) return;
      setTraps(enriched);
      setProfiles(nextProfiles);
      setError(null);
      setRefreshedAt(new Date().toISOString());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Не удалось загрузить парк ловушек');
    } finally {
      refreshing.current = false;
      if (showLoading) setLoading(false);
      if (refreshPending.current && mounted.current) {
        refreshPending.current = false;
        void refresh();
      }
    }
  }, []);

  useEffect(() => {
    refresh(true);
    const timer = window.setInterval(() => { refresh(); setTick(Date.now()); }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => { if (realtimeRevision) void refresh(); }, [realtimeRevision, refresh]);

  useEffect(() => {
    setCommands([]);
    setCommandsError('');
    setCommandsLoading(!!selectedId);
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    api.traps.commands(selectedId).then((items) => {
      if (active) { setCommands(items); setCommandsError(''); }
    }).catch((cause) => {
      if (active) setCommandsError(cause instanceof Error ? cause.message : 'Не удалось загрузить команды');
    }).finally(() => { if (active) setCommandsLoading(false); });
    return () => { active = false; };
  }, [selectedId, realtimeRevision, tick, commandRevision]);

  useEffect(() => {
    setRegistrationAttempts([]); setRegistrationError('');
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    api.traps.registrationAttempts(selectedId).then((items) => {
      if (active) { setRegistrationAttempts(items); setRegistrationError(''); }
    }).catch((cause) => { if (active) setRegistrationError(cause instanceof Error ? cause.message : 'История регистраций недоступна'); });
    return () => { active = false; };
  }, [selectedId, realtimeRevision, tick]);

  useEffect(() => {
    const id = sessionStorage.getItem('hf_deploy_profile_id');
    if (id) {
      const requested = Number(sessionStorage.getItem('hf_deploy_profile_revision'));
      sessionStorage.removeItem('hf_deploy_profile_id');
      sessionStorage.removeItem('hf_deploy_profile_name');
      sessionStorage.removeItem('hf_deploy_profile_revision');
      setProfileId(id);
      setRequestedRevision(requested > 0 ? requested : null);
      setStep(0);
    }
    const onDeploy = (event: Event) => {
      const detail = (event as CustomEvent<{ profileId?: string; revision?: number }>).detail;
      if (detail?.profileId) { setProfileId(detail.profileId); setRequestedRevision(detail.revision || null); setStep(0); }
    };
    window.addEventListener('honeyforge-deploy-profile', onDeploy);
    return () => window.removeEventListener('honeyforge-deploy-profile', onDeploy);
  }, []);

  useEffect(() => {
    if (!profileId) { setRevisions([]); setRevision(0); return; }
    let active = true;
    setRevisionError('');
    setRevisions([]);
    setRevision(0);
    setRevisionLoading(true);
    api.profiles.revisions(profileId).then((items) => {
      if (active) {
        setRevisions(items);
        const target = requestedRevision ? items.find((item) => item.revision === requestedRevision) : items[0];
        setRevision(target?.revision || 0);
        if (!target) setRevisionError('Выбранная версия недоступна. Выберите профиль и существующую версию.');
      }
    }).catch((cause) => { if (active) setRevisionError(cause.message); }).finally(() => { if (active) setRevisionLoading(false); });
    return () => { active = false; };
  }, [profileId, requestedRevision]);

  const chosenRevision = revisions.find((item) => item.revision === revision);
  useEffect(() => {
    setBindings((chosenRevision?.config?.services || []).map((service) => ({ service_id: service.id || '', host_port: service.port, bind_address: '0.0.0.0' })));
  }, [chosenRevision]);

  useEffect(() => {
    const sync = () => {
      setSelectedId(window.location.hash.match(/^#traps\/([a-f0-9-]{36})$/i)?.[1] || null);
      const status = new URLSearchParams(window.location.hash.split('?')[1] || '').get('status');
      if (status && ['online', 'offline', 'degraded'].includes(status)) setStatusFilter(status);
      else setStatusFilter('all');
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const selected = traps.find((trap) => trap.id === selectedId);
  const filtered = useMemo(() => traps.filter((trap) =>
    (levelFilter === 'all' || trap.level === levelFilter) &&
    (profileFilter === 'all' || trap.profile_id === profileFilter) &&
    (statusFilter === 'all' || (statusFilter === 'degraded' ? trap.service_status === 'degraded' || trap.service_status === 'error' || trap.telemetry?.degraded === true : statusFilter === 'registration_failed' ? trap.registration_status === 'rejected' : statusFilter === 'unregistered' ? !trap.last_seen_at && trap.registration_status !== 'registered' && trap.registration_status !== 'rejected' : ['online', 'offline'].includes(statusFilter) ? trap.agent_status === statusFilter : trap.service_status === statusFilter))
  ), [traps, levelFilter, profileFilter, statusFilter]);

  const create = async () => {
    if (role !== 'operator' || busy || !chosenRevision || !name.trim()) return;
    setBusy(true);
    setSubmitError('');
    let trap: Trap | null = created;
    try {
      if (!trap) trap = await api.traps.create({ name: name.trim(), deployment_node: node.trim(), deployment_bindings: bindings });
      if (!mounted.current || currentRole.current !== 'operator') return;
      setCreated(trap);
      const assigned = await api.traps.assignProfile(trap.id, profileId, revision);
      if (!mounted.current || currentRole.current !== 'operator') return;
      setCreated(assigned);
      setStep(2);
      await refresh();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Ошибка создания';
      setSubmitError(trap ? `Запись ${trap.id} создана, но профиль не назначен: ${message}. Повторите назначение для этой записи; второй экземпляр создаваться не будет.` : message);
      await refresh();
    } finally { setBusy(false); }
  };

  const issueToken = async (trap: Trap) => {
    if (role !== 'operator' || busy) return;
    setToken(null);
    setBusy(true);
    try {
      const result = await api.traps.generateToken(trap.id);
      if (!mounted.current || currentRole.current !== 'operator') return;
      setTick(Date.now());
      setToken({ trapId: trap.id, value: result.token, expiresAt: Date.now() + result.expires_in_seconds * 1000 });
    } catch (cause) {
      notify('error', 'Отказ выдачи токена', cause instanceof Error ? cause.message : 'Неизвестная ошибка');
    } finally { setBusy(false); }
  };

  const closeWizard = () => {
    if (busy) return;
    setStep(null); setToken(null); setCreated(null); setSubmitError(''); setBundleError(''); setName(''); setNode('');
    setProfileId(''); setRequestedRevision(null); setBindings([]);
  };
  const downloadBundle = async (trap: Trap) => {
    if (role !== 'operator' || busy) return;
    setBusy(true); setBundleError('');
    try {
      await api.traps.downloadBundle(trap.id);
      notify('info', 'Комплект скачан', 'Запустите install.sh на подготовленном узле и проверьте регистрацию агента.');
    } catch (cause) { setBundleError(cause instanceof Error ? cause.message : 'Ошибка скачивания'); }
    finally { setBusy(false); }
  };
  const tokenValid = token && tick < token.expiresAt;

  return <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div><h1 className="text-2xl font-bold text-slate-900">Парк ловушек</h1><p className="text-sm text-slate-500 mt-1">Регистрация агентов и фактическое состояние сервисов</p></div>
      <div className="flex gap-2">
        {role === 'operator' && <Button size="sm" leftIcon={<Plus size={16} />} onClick={() => setStep(0)}>Создать экземпляр</Button>}
        <Button size="sm" variant="outline" leftIcon={<RefreshCw size={16} />} onClick={() => refresh(true)}>Обновить</Button>
      </div>
    </div>
    <div className="bg-white border rounded-xl p-4 flex flex-wrap gap-3 text-sm">
      <label>Уровень <select className="border rounded ml-2 p-1" value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)}><option value="all">Все</option><option value="low">Low</option><option value="medium">Medium</option></select></label>
      <label>Состояние <select aria-label="Состояние" className="border rounded ml-2 p-1" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}><option value="all">Все</option><option value="unregistered">Ожидает регистрации</option><option value="registration_failed">Отказ регистрации</option><option value="online">Агент online</option><option value="offline">Агент offline</option><option value="degraded">Degraded (сервис/телеметрия)</option><option value="running">Сервис работает</option><option value="stopped">Сервис остановлен</option><option value="error">Ошибка сервиса</option></select></label>
      <label>Профиль <select className="border rounded ml-2 p-1" value={profileFilter} onChange={(e) => setProfileFilter(e.target.value)}><option value="all">Все</option>{profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
    </div>
    {loading ? <LoadingSkeleton rows={4} /> : error ? <ErrorState message={error} onRetry={() => refresh(true)} /> : traps.length === 0 ? <EmptyState title="Ловушек пока нет" description="Создайте экземпляр из профиля" /> : <div className="bg-white border rounded-xl overflow-x-auto"><table className="w-full text-sm text-left"><thead className="bg-slate-50 text-slate-600"><tr><th className="p-3">Экземпляр</th><th className="p-3">Уровень и профиль</th><th className="p-3">Revision</th><th className="p-3">Узел / Bindings</th><th className="p-3">Агент / сервис</th><th className="p-3">Last seen</th><th className="p-3">Ссылки</th></tr></thead><tbody>{filtered.map((trap) => <tr key={trap.id} className="border-t align-top"><td className="p-3"><strong>{trap.name}</strong><div className="font-mono text-xs break-all">{trap.id}</div></td><td className="p-3">{trap.profile_id ? <LevelBadge level={trap.level} /> : '—'}<div className="mt-1">{trap.profile_name}</div></td><td className="p-3">Желаемая: {trap.desired_revision ?? '—'}<br />Применена: {trap.applied_revision ?? '—'}</td><td className="p-3 font-mono text-xs"><div>{trap.deployment_node || 'Узел не указан'}</div>{trap.deployment_bindings?.map((binding) => <div key={binding.service_id}>{binding.bind_address || '*'}:{binding.host_port} ({binding.service_id})</div>)}</td><td className="p-3"><StatusBadge status={trap.status} /><div className="mt-1">Сервис: {serviceText(trap.service_status)}</div><div className="text-xs text-slate-500">{progress(trap)}</div></td><td className="p-3">{dateText(trap.last_seen_at)}</td><td className="p-3"><a className="text-brand-700 underline block" href={`#traps/${trap.id}`}>Карточка</a><a className="text-brand-700 underline block" href={`#events?trap_id=${encodeURIComponent(trap.id)}`}>События</a></td></tr>)}</tbody></table>{filtered.length === 0 && <p className="p-4 text-slate-500">Нет ловушек с такими фильтрами.</p>}</div>}
    {selected && <section className="bg-white border rounded-xl p-5 space-y-3" aria-label="Карточка ловушки"><h2 className="text-lg font-semibold">{selected.name}</h2><p className="font-mono text-xs">trap_id: {selected.id}</p><p>Узел запуска: {selected.deployment_node || 'Не указан'}</p>{selected.agent_id && <p className="font-mono text-xs">agent_id: {selected.agent_id}</p>}<p>{progress(selected)} · агент: {selected.agent_status === 'online' ? 'в сети' : 'не в сети'} · сервис: {serviceText(selected.service_status)}</p><p>Профиль: {selected.profile_name}, назначенная версия {selected.desired_revision ?? '—'}, применённая {selected.applied_revision ?? '—'}</p><p>Последняя связь: {dateText(selected.last_seen_at)}</p><p className="text-xs text-slate-600">Изменение опубликованного порта узла требует пересоздания комплекта на узле.</p>{role === 'operator' && <div className="flex flex-wrap gap-2">{selected.registration_status !== 'registered' && !selected.last_seen_at && <Button size="sm" disabled={busy} onClick={() => issueToken(selected)}>Выдать токен регистрации</Button>}<Button size="sm" variant="outline" disabled={busy || !selected.profile_id} onClick={() => { setBundleError(''); setBundleTrap(selected); }}>Комплект запуска</Button></div>}</section>}
    {selected && <RegistrationHistory attempts={registrationAttempts} error={registrationError} />}
    {selected && <TrapControlPanel key={`${selected.id}:${user?.id}:${role}`} trap={selected} profiles={profiles} commands={commands} updatedAt={refreshedAt} fresh={!loading && !error && !commandsError && !commandsLoading} onChanged={() => { setCommandRevision((value) => value + 1); void refresh(); }} />}
    {selected && <CommandHistory commands={commands} error={commandsError} loading={commandsLoading} />}
    {step !== null && role === 'operator' && <Modal isOpen onClose={closeWizard} title="Новый экземпляр" description={`Шаг ${step + 1} из 4`} maxWidth="xl"><div className="space-y-4 text-sm">
      {step === 0 && <><label className="block">Профиль<select className="block w-full border rounded p-2 mt-1" aria-label="Профиль" value={profileId} onChange={(e) => { setProfileId(e.target.value); setRequestedRevision(null); }}><option value="">Выберите профиль</option>{profiles.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.level})</option>)}</select></label>{revisionError && <p role="alert" className="text-rose-700">{revisionError}</p>}<label className="block">Версия<select className="block w-full border rounded p-2 mt-1" aria-label="Версия" value={revision} onChange={(e) => setRevision(Number(e.target.value))}>{revisions.map((r) => <option key={r.revision} value={r.revision}>Revision {r.revision}</option>)}</select></label><Button disabled={revisionLoading || !chosenRevision} onClick={() => setStep(1)}>Далее</Button></>}
      {step === 1 && <><label className="block">Имя экземпляра<input className="block w-full border rounded p-2 mt-1" maxLength={120} required disabled={!!created} value={name} onChange={(e) => setName(e.target.value)} /></label><label className="block">Узел запуска<input className="block w-full border rounded p-2 mt-1" maxLength={253} value={node} disabled={!!created} onChange={(e) => setNode(e.target.value)} placeholder="linux-node-01" /></label><p className="text-xs text-slate-600">Сохранённое имя подготовленного узла; запуск комплекта на нём выполняется оператором.</p>{new TextEncoder().encode(node.trim()).length > 253 && <p role="alert">Имя узла не должно превышать 253 байта UTF-8.</p>}{bindings.map((binding, index) => <div key={binding.service_id} className="grid grid-cols-2 gap-2"><label>Порт {binding.service_id}<input type="number" min={1} max={65535} className="block w-full border rounded p-2" disabled={!!created} value={binding.host_port} onChange={(e) => setBindings(bindings.map((b, i) => i === index ? { ...b, host_port: Number(e.target.value) } : b))} /></label><label>Bind IP<input className="block w-full border rounded p-2" disabled={!!created} value={binding.bind_address || ''} onChange={(e) => setBindings(bindings.map((b, i) => i === index ? { ...b, bind_address: e.target.value } : b))} /></label></div>)}<p className="bg-amber-50 border border-amber-200 p-3 rounded">Проверьте свободные порты и доступность интерфейса на подготовленном узле. Изменение host port после запуска требует пересоздания deployment.</p>{submitError && <p role="alert" className="text-rose-700">{submitError}</p>}<div className="flex gap-2"><Button variant="outline" disabled={!!created || busy} onClick={() => setStep(0)}>Назад</Button><Button disabled={!name.trim() || new TextEncoder().encode(node.trim()).length > 253 || bindings.some((b) => !b.service_id || !Number.isInteger(b.host_port) || b.host_port < 1 || b.host_port > 65535)} isLoading={busy} onClick={create}>{created ? 'Повторить назначение профиля' : 'Создать и назначить профиль'}</Button></div></>}
      {step === 2 && created && <><p>Запись <strong>{created.name}</strong> создана. Агент ещё не зарегистрирован.</p><p className="font-mono text-xs break-all">trap_id: {created.id}</p><Button isLoading={busy} onClick={() => issueToken(created)}>Выдать одноразовый токен</Button>{token?.trapId === created.id && tokenValid && <TokenView token={token.value} expiresAt={token.expiresAt} />}{token?.trapId === created.id && !tokenValid && <p role="alert">Токен истёк. Выдайте новый; прежний будет отозван.</p>}<Button variant="outline" onClick={() => setStep(3)}>Комплект запуска</Button></>}
      {step === 3 && created && <><p>Комплект должен содержать агент, конфигурацию и инструкцию для подготовленного Linux-узла.</p><p className="font-mono text-xs">trap_id: {created.id}</p><p>После скачивания статус остаётся «Ожидает регистрации». Проверяйте регистрацию и сервис по данным сервера.</p><BundleInstructions /><Button isLoading={busy} onClick={() => downloadBundle(created)}>Скачать ZIP-комплект</Button>{bundleError && <p role="alert" className="text-rose-700">{bundleError}</p>}<Button variant="outline" onClick={closeWizard}>Закрыть</Button></>}
    </div></Modal>}
    {bundleTrap && role === 'operator' && <Modal isOpen onClose={() => { if (!busy) setBundleTrap(null); }} title="Комплект запуска"><div className="space-y-4 text-sm"><p>{bundleTrap.name}</p><BundleInstructions /><Button isLoading={busy} onClick={() => downloadBundle(bundleTrap)}>Скачать ZIP-комплект</Button>{bundleError && <p role="alert" className="text-rose-700">{bundleError}</p>}</div></Modal>}
    {token && step === null && role === 'operator' && <Modal isOpen onClose={() => setToken(null)} title="Одноразовый токен"><div className="space-y-3">{tokenValid ? <TokenView token={token.value} expiresAt={token.expiresAt} /> : <p role="alert">Токен истёк. Выдайте новый в карточке.</p>}<p className="text-xs">При повторной выдаче предыдущий токен аннулируется. Сохраните новый только на защищённом узле.</p></div></Modal>}
    {isDevModeActive() && <p className="text-xs text-amber-700">Демо-режим: состояния фиктивные. Для проверки реальной регистрации переключитесь на API.</p>}
  </div>;
};

const TokenView: React.FC<{ token: string; expiresAt: number }> = ({ token, expiresAt }) => <div className="space-y-2"><p>Скопируйте сейчас. Повторно посмотреть токен нельзя.</p><div className="flex gap-2"><code className="bg-slate-100 p-2 rounded break-all flex-1">{token}</code><button type="button" title="Копировать токен" onClick={() => navigator.clipboard.writeText(token)}><Copy size={18} /></button></div><p className="text-xs">Истекает: {dateText(new Date(expiresAt).toISOString())}</p></div>;

const CommandHistory: React.FC<{ commands: TrapCommand[]; error: string; loading: boolean }> = ({ commands, error, loading }) => {
  const actions = { start: 'Запуск', stop: 'Остановка', apply_profile: 'Применение профиля' };
  const states = { queued: 'В очереди', delivered: 'Доставлена агенту', applied: 'Выполнена', failed: 'Ошибка выполнения', expired: 'Срок истёк' };
  return <section className="bg-white border rounded-xl p-5 space-y-3" aria-label="Результаты команд">
    <h2 className="text-lg font-semibold">Последние команды</h2>
    <p className="text-xs text-slate-600">Доставка агенту и выполнение показываются по подтверждениям сервера. Текущее состояние сервиса указано в карточке.</p>
    {error && <p role="alert" className="text-rose-700">{error}. Результаты ниже могут быть устаревшими.</p>}
    {loading ? <p>Загрузка команд…</p> : commands.length === 0 && !error ? <p className="text-sm text-slate-500">Команды ещё не отправлены.</p> : null}
    {commands.length > 0 && <div className="overflow-x-auto"><table className="w-full text-sm text-left" aria-label="Последние команды ловушки">
      <thead className="text-slate-600"><tr><th className="p-2">Команда</th><th className="p-2">Версия</th><th className="p-2">Результат</th><th className="p-2">Создана / срок действия</th></tr></thead>
      <tbody>{commands.slice(0, 10).map((command) => <tr key={command.id} className="border-t align-top">
        <td className="p-2">{actions[command.type] || command.type}<div className="text-xs font-mono break-all">{command.id}</div></td>
        <td className="p-2">{command.target_revision ?? '—'}</td>
        <td className={`p-2 ${command.status === 'applied' ? 'text-emerald-700' : command.status === 'failed' ? 'text-rose-700' : 'text-slate-700'}`}>{states[command.status] || command.status}{command.status === 'expired' && <p>Команда не выполнена до истечения срока и больше не должна исполняться.</p>}{command.error && <p className="text-rose-700 whitespace-pre-wrap break-words">{command.error}</p>}</td>
        <td className="p-2">{dateText(command.created_at)}<br />до {dateText(command.expires_at)}</td>
      </tr>)}</tbody>
    </table></div>}
  </section>;
};

const BundleInstructions = () => <div className="space-y-2"><p>На подготовленном Linux-узле нужны Docker Compose, git, openssl и исходящий HTTPS к центру. Разрешите только опубликованные порты приманки.</p><p>Распакуйте ZIP, прочитайте README.txt и запустите <code>./install.sh</code>. Введите свежий enrollment-токен по запросу установщика. Токен в архив не включён.</p><p>После регистрации поставьте «Применить профиль» и проверьте применённую версию и состояние сервиса в карточке. Скачивание комплекта не запускает ловушку.</p></div>;

const registrationReason: Record<RegistrationAttempt['reason'], string> = {
  registered: 'Агент зарегистрирован', invalid_token: 'Неверный токен', expired_token: 'Срок токена истёк',
  inactive_token: 'Токен уже использован или отозван', already_enrolled: 'У экземпляра уже есть агент',
};
const RegistrationHistory: React.FC<{ attempts: RegistrationAttempt[]; error: string }> = ({ attempts, error }) => <section className="bg-white border rounded-xl p-5 space-y-3" aria-label="История регистрации">
  <h2 className="text-lg font-semibold">История регистрации</h2>
  <p className="text-xs text-slate-600">Последние 100 попыток, полученных центром. Ошибки сети и TLS до обращения к API здесь не фиксируются.</p>
  {error && <p role="alert" className="text-rose-700">{error}. Показанные записи могут быть устаревшими.</p>}
  {!error && attempts.length === 0 && <p>Попыток регистрации пока нет.</p>}
  <ol className="max-h-64 overflow-y-auto space-y-2">{attempts.map((attempt) => <li key={attempt.id} className="border-t pt-2 text-sm"><time>{dateText(attempt.created_at)}</time> · {attempt.outcome === 'rejected' ? 'Отказ регистрации: ' : ''}{registrationReason[attempt.reason] || attempt.reason}</li>)}</ol>
</section>;
