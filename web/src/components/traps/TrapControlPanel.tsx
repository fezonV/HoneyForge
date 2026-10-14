import { useEffect, useRef, useState } from 'react';
import { api, ApiRequestError, isDevModeActive } from '../../api/client';
import { Profile, ProfileConfig, ProfileRevision, SyntheticCredential, Trap, TrapCommand } from '../../api/types';
import { useAuth } from '../../context/AuthContext';
import { Button } from '../common/Button';
import { Modal } from '../common/Modal';

type Action = 'start' | 'stop' | 'apply_profile';
type Pending = { type: Action; before: string[]; profileId: string; revision: number; commandId?: string; startedAt: number };
const labels = { start: 'Запустить', stop: 'Остановить', apply_profile: 'Применить профиль' };
const active = (command: TrapCommand) => command.status === 'queued' || command.status === 'delivered';
const uncertain = (cause: unknown) => cause instanceof ApiRequestError && (cause.isNetworkError || cause.status >= 500);
const message = (cause: unknown) => cause instanceof Error ? cause.message : 'Неизвестная ошибка';
const date = (value?: string) => value ? new Date(value).toLocaleString('ru-RU', { timeZoneName: 'short' }) : 'Нет данных';

export function TrapControlPanel({ trap, profiles, commands, updatedAt, fresh, onChanged }: {
  trap: Trap; profiles: Profile[]; commands: TrapCommand[]; updatedAt?: string; fresh: boolean; onChanged: () => void;
}) {
  const { role, user } = useAuth();
  const storageKey = `hf_command_pending:${user?.id}:${trap.id}`;
  const [pending, setPending] = useState<Pending | null>(() => {
    try {
      const value = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
      return value && ['start', 'stop', 'apply_profile'].includes(value.type) && Array.isArray(value.before) &&
        value.before.every((id: unknown) => typeof id === 'string') && typeof value.profileId === 'string' &&
        Number.isInteger(value.revision) && Number.isFinite(value.startedAt) &&
        (value.commandId === undefined || typeof value.commandId === 'string') ? value : null;
    } catch { return null; }
  });
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [ttl, setTtl] = useState(300);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const alive = useRef(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [profileId, setProfileId] = useState(trap.desired_profile_id || '');
  const [versions, setVersions] = useState<ProfileRevision[]>([]);
  const [revision, setRevision] = useState(trap.desired_revision || 0);
  const [applied, setApplied] = useState<ProfileRevision | null>(null);
  const [versionLoading, setVersionLoading] = useState(false);
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [assignmentUnknown, setAssignmentUnknown] = useState(false);
  const [rotation, setRotation] = useState<{ profile: Profile; source: ProfileRevision } | null>(null);
  const [credentials, setCredentials] = useState<SyntheticCredential[]>([]);
  const [rotationUnknown, setRotationUnknown] = useState(false);
  const catalogRevision = profiles.find((item) => item.id === profileId)?.revision;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (pending) sessionStorage.setItem(storageKey, JSON.stringify(pending));
    else sessionStorage.removeItem(storageKey);
  }, [pending, storageKey]);
  useEffect(() => {
    if (!fresh || !pending) return;
    const match = pending.commandId ? commands.find((item) => item.id === pending.commandId) : null;
    if (match) {
      setNotice(`Команда ${match.id}: ${match.status}.`);
      if (!active(match)) setPending(null);
    }
  }, [commands, fresh, pending]);
  useEffect(() => {
    let valid = true;
    setVersions([]); setVersionLoading(true); setError('');
    if (!profileId) { setVersionLoading(false); return; }
    api.profiles.revisions(profileId).then((items) => {
      if (!valid) return;
      setVersions(items);
      setRevision((current) => items.some((item) => item.revision === current) ? current : items[0]?.revision || 0);
    }).catch((cause) => { if (valid) setError(message(cause)); }).finally(() => { if (valid) setVersionLoading(false); });
    return () => { valid = false; };
  }, [profileId, catalogRevision]);
  useEffect(() => {
    let valid = true;
    setApplied(null);
    if (trap.applied_profile_id && trap.applied_revision) {
      api.profiles.revision(trap.applied_profile_id, trap.applied_revision).then((item) => { if (valid) setApplied(item); })
        .catch((cause) => { if (valid) setError(`Применённая версия недоступна: ${message(cause)}`); });
    }
    return () => { valid = false; };
  }, [trap.applied_profile_id, trap.applied_revision]);

  const chosen = versions.find((item) => item.revision === revision);
  const inflight = commands.some(active);
  // Exclude the known command IDs, then require manual reconciliation. Browser
  // and server clocks need not agree, so local timestamps cannot exclude IDs.
  const candidates = pending && !pending.commandId ? commands.filter((item) =>
    !pending.before.includes(item.id) && item.type === pending.type && item.target_profile_id === pending.profileId &&
    item.target_revision === pending.revision) : [];
  const locked = busy || !fresh || inflight || !!pending || assignmentUnknown;
  const operator = role === 'operator' && !isDevModeActive();
  const bindingIds = new Set(trap.deployment_bindings?.map((binding) => binding.service_id));
  const topologyChanged = !!chosen && !!applied && (JSON.stringify(chosen.config.services.map((s) => [s.id, s.port, s.protocol]).sort()) !==
    JSON.stringify(applied.config.services.map((s) => [s.id, s.port, s.protocol]).sort()));
  const incompatible = !!chosen && (chosen.config.services.length !== bindingIds.size || chosen.config.services.some((s) => !s.id || !bindingIds.has(s.id)));

  const submitCommand = async () => {
    if (!operator || !confirm || locked || sending.current || !trap.desired_profile_id || !trap.desired_revision) return;
    sending.current = true; setBusy(true); setError(''); setNotice('');
    const operation: Pending = { type: confirm, before: commands.map((item) => item.id), profileId: trap.desired_profile_id,
      revision: trap.desired_revision, startedAt: Date.now() };
    let submitted = false;
    try {
      const currentCommands = await api.traps.commands(trap.id);
      if (currentCommands.some(active)) throw new Error('У экземпляра уже есть команда в очереди или на исполнении. Дождитесь результата.');
      operation.before = currentCommands.map((item) => item.id);
      // Persist only public operation metadata before POST, so reload never resends it.
      sessionStorage.setItem(storageKey, JSON.stringify(operation));
      setPending(operation);
      submitted = true;
      const result = await api.traps.sendCommand(trap.id, confirm, {
        expected_profile_id: operation.profileId, expected_revision: operation.revision, ttl_seconds: ttl,
      });
      sessionStorage.setItem(storageKey, JSON.stringify({ ...operation, commandId: result.command_id }));
      if (alive.current) { setPending({ ...operation, commandId: result.command_id }); setNotice(`Команда ${result.command_id} принята: ${result.status}. Выполнение ещё не подтверждено.`); setConfirm(null); }
    } catch (cause) {
      // A definite rejection must clear persisted metadata even after the card
      // unmounts (navigation/session expiry). Unknown outcomes remain blocked.
      if (!submitted || !uncertain(cause)) sessionStorage.removeItem(storageKey);
      if (alive.current) {
        setError(submitted && uncertain(cause) ? 'Результат отправки неизвестен. Запрос не повторяется. Перечитываем историю; новая команда заблокирована до выяснения результата.' : message(cause));
        if (!submitted || !uncertain(cause)) setPending(null);
        setConfirm(null);
      }
    } finally { sending.current = false; if (alive.current) { setBusy(false); onChanged(); } }
  };

  const assign = async () => {
    if (!operator || locked || sending.current || !chosen || incompatible) return;
    sending.current = true; setBusy(true); setError('');
    let submitted = false;
    try {
      if ((await api.traps.commands(trap.id)).some(active)) throw new Error('У экземпляра есть активная команда. Дождитесь результата перед назначением.');
      submitted = true;
      await api.traps.assignProfile(trap.id, profileId, revision);
      setNotice(`Назначена desired v${revision}. Применённая версия изменится после подтверждения decoy.`);
      setAssignmentOpen(false);
    } catch (cause) {
      setError(submitted && uncertain(cause) ? 'Ответ назначения не получен. Запрос не повторяется; проверьте desired в карточке.' : message(cause));
      setAssignmentUnknown(submitted && uncertain(cause));
    } finally { sending.current = false; if (alive.current) { setBusy(false); onChanged(); } }
  };
  const reconcileAssignment = async () => {
    setBusy(true);
    try {
      await api.traps.list(); // Successful fresh read permits the operator to review and confirm a new assignment.
      setAssignmentUnknown(false); setAssignmentOpen(false); setError(''); onChanged();
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  };
  const openRotation = async () => {
    if (!operator || locked || !profileId) return;
    setBusy(true); setError(''); setRotationUnknown(false);
    try {
      const result = await api.profiles.get(profileId);
      const source = result.revision || await api.profiles.revision(profileId, result.profile.revision);
      if (source.config.level !== 'medium') throw new Error('Ротация credentials доступна только для Medium.');
      setRotation({ profile: result.profile, source });
      setCredentials(source.config.synthetic_credentials.map((item) => ({ username: item.username, password: '' })));
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  };
  const rotate = async () => {
    if (!operator || !rotation || locked || rotationUnknown || sending.current) return;
    sending.current = true; setBusy(true); setError('');
    try {
      const result = await api.profiles.rotateCredentials(profileId, rotation.source.revision, rotation.profile.name,
        rotation.profile.description, { ...rotation.source.config, synthetic_credentials: credentials });
      setVersions((items) => [result, ...items]); setRevision(result.revision);
      setRotation(null); setCredentials([]);
      setNotice(`Создана v${result.revision}. Другие экземпляры сохранили свои назначения. Подтвердите назначение выбранной ловушке.`);
    } catch (cause) {
      setRotationUnknown(uncertain(cause));
      setError(uncertain(cause) ? 'Результат создания версии неизвестен. PATCH не повторяется. Закройте диалог и перечитайте каталог версий.' : message(cause));
    } finally { sending.current = false; if (alive.current) { setBusy(false); onChanged(); } }
  };

  return <section className="bg-white border rounded-xl p-5 space-y-4" aria-label="Управление экземпляром">
    <h2 className="text-lg font-semibold">Управление: {trap.name}</h2>
    <p className="text-xs font-mono break-all">{trap.id}</p>
    <div className="grid sm:grid-cols-2 gap-3 text-sm">
      <p>Desired: {trap.desired_profile_id || '—'} / v{trap.desired_revision ?? '—'}</p>
      <p>Applied: {trap.applied_profile_id || '—'} / v{trap.applied_revision ?? '—'}</p>
      <p>Очередь событий: {trap.telemetry ? `${trap.telemetry.queue_depth} / ${trap.telemetry.queue_limit}; карантин: ${trap.telemetry.quarantined}` : 'Нет данных'}</p>
      <p>Последнее обновление агента: {date(trap.last_seen_at)}</p>
      <p>Данные API получены: {date(updatedAt)}{!fresh && ' · требуется обновление'}</p>
    </div>
    <p className="text-sm whitespace-pre-wrap break-words">Последняя ошибка: {trap.telemetry?.storage_error || trap.telemetry?.delivery_error || trap.telemetry?.quarantine_reason || (commands[0]?.status === 'failed' ? commands[0].error || 'Команда завершилась ошибкой без подробностей' : 'Нет сообщения об ошибке')}</p>
    {trap.telemetry && <div className="text-sm space-y-1"><p>Доставлено событий: {trap.telemetry.sent_events}; повторов: {trap.telemetry.delivery_retries}; ошибок доставки: {trap.telemetry.delivery_errors}</p>
      {[trap.telemetry.storage_error, trap.telemetry.delivery_error, trap.telemetry.quarantine_reason].filter(Boolean).map((text, index) => <p key={index} className="text-rose-700 whitespace-pre-wrap break-words">{text}</p>)}</div>}
    {notice && <p role="status" className="text-slate-700 whitespace-pre-wrap">{notice}</p>}
    {error && <p role="alert" className="text-rose-700">{error}</p>}
    {pending && <p className="bg-amber-50 p-3 rounded text-sm">Ожидаем результат {pending.commandId || 'отправки команды'}. Повторный POST заблокирован. <Button size="sm" variant="outline" onClick={onChanged}>Проверить статус</Button></p>}
    {operator && candidates.length > 0 && <div className="text-sm space-y-2"><p>Ответ на отправку не получен. Проверьте ID, тип и время в истории, прежде чем связать отправку с найденной командой.</p>{candidates.map((item) => <Button key={item.id} size="sm" variant="outline" onClick={() => { if (pending) setPending({ ...pending, commandId: item.id }); }}>Связать с командой {item.id}</Button>)}</div>}
    {operator && <>
      {(inflight || !fresh) && <p className="text-amber-800 text-sm">Управление заблокировано до получения актуального состояния и завершения активной команды.</p>}
      <div className="flex flex-wrap gap-2">{(['start', 'stop', 'apply_profile'] as const).map((action) => <Button key={action} variant="outline" size="sm" disabled={locked || !trap.desired_profile_id} onClick={() => { setError(''); setConfirm(action); }}>{labels[action]}</Button>)}</div>
      <label className="block text-sm">Профиль для назначения<select aria-label="Профиль для назначения" className="block w-full border rounded p-2" disabled={locked} value={profileId} onChange={(event) => { setProfileId(event.target.value); setRevision(0); }}><option value="">Выберите профиль</option>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
      <label className="block text-sm">Версия для назначения<select aria-label="Версия для назначения" className="block w-full border rounded p-2" disabled={locked || versionLoading} value={revision} onChange={(event) => setRevision(Number(event.target.value))}>{versions.map((item) => <option key={item.revision} value={item.revision}>v{item.revision}</option>)}</select></label>
      {chosen && <RevisionComparison applied={applied} chosen={chosen} />}
      {topologyChanged && <p className="text-amber-800 text-sm">Сервисы, внутренние порты или протокол отличаются от applied. Подготовьте новый deployment из выбранной версии; опубликованные host-порты не меняются горячим применением.</p>}
      {incompatible && <p role="alert" className="text-rose-700">Сервисы не соответствуют bindings экземпляра. Создайте новый экземпляр с подходящими bindings.</p>}
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={locked || !chosen || incompatible} onClick={() => setAssignmentOpen(true)}>Назначить выбранную версию</Button><Button size="sm" variant="outline" disabled={locked || chosen?.config.level !== 'medium'} onClick={openRotation}>Ротация фиктивных credentials</Button></div>
      {assignmentUnknown && <Button size="sm" variant="outline" isLoading={busy} onClick={reconcileAssignment}>Перечитать назначение</Button>}
    </>}
    {confirm && operator && <Modal isOpen title="Подтвердить команду" onClose={() => { if (!busy) setConfirm(null); }}><div className="space-y-3 text-sm"><p>{labels[confirm]} только «{trap.name}» ({trap.id})?</p><p>Целевая конфигурация: {trap.desired_profile_id}, v{trap.desired_revision}.</p><p>Агент: {trap.agent_status}. Команда ожидает доставки и подтверждения; offline не означает выполнение.</p><label>Срок действия, секунд<input aria-label="Срок действия, секунд" type="number" min={1} max={3600} value={ttl} onChange={(event) => setTtl(Number(event.target.value))} className="block border rounded p-2" /></label><Button isLoading={busy} disabled={locked || !Number.isInteger(ttl) || ttl < 1 || ttl > 3600} onClick={submitCommand}>Подтвердить {labels[confirm].toLowerCase()}</Button></div></Modal>}
    {assignmentOpen && operator && <Modal isOpen title="Подтвердить назначение" onClose={() => { if (!busy) setAssignmentOpen(false); }}><div className="space-y-3 text-sm"><p>Назначить {profiles.find((item) => item.id === profileId)?.name}, v{revision} только «{trap.name}» ({trap.id})?</p><p>Applied остаётся v{trap.applied_revision ?? '—'}. После назначения отдельно отправьте «Применить профиль».</p>{chosen && <RevisionComparison applied={applied} chosen={chosen} />}{error && <p role="alert" className="text-rose-700">{error}</p>}<Button isLoading={busy} disabled={locked || incompatible} onClick={assign}>Подтвердить назначение</Button></div></Modal>}
    {rotation && operator && <Modal isOpen title="Новая версия с фиктивными credentials" onClose={() => { if (!busy) { setRotation(null); setCredentials([]); setRotationUnknown(false); } }}><div className="space-y-3 text-sm"><p>Профиль {rotation.profile.name}, исходная v{rotation.source.revision}. Заменяются все фиктивные учётные записи. Сохранение создаёт новую revision, назначения ловушек сохраняются.</p>{credentials.map((credential, index) => <div key={index} className="space-y-1 border rounded p-2"><label>Имя пользователя {index + 1}<input aria-label={`Фиктивный пользователь ${index + 1}`} value={credential.username} onChange={(event) => setCredentials((items) => items.map((item, i) => i === index ? { ...item, username: event.target.value } : item))} className="block border rounded p-2 w-full" /></label><label>Новый фиктивный пароль {index + 1}<input aria-label={`Фиктивный пароль ${index + 1}`} type="password" autoComplete="new-password" value={credential.password} onChange={(event) => setCredentials((items) => items.map((item, i) => i === index ? { ...item, password: event.target.value } : item))} className="block border rounded p-2 w-full" /></label><Button size="sm" variant="ghost" onClick={() => setCredentials((items) => items.filter((_, i) => i !== index))}>Удалить запись {index + 1}</Button></div>)}<Button size="sm" variant="outline" onClick={() => setCredentials((items) => [...items, { username: '', password: '' }])}>Добавить фиктивную запись</Button>{error && <p role="alert" className="text-rose-700">{error}</p>}<Button isLoading={busy} disabled={locked || rotationUnknown || credentials.length === 0 || credentials.some((item) => !item.username.trim() || !item.password) || new Set(credentials.map((item) => item.username)).size !== credentials.length} onClick={rotate}>Создать новую revision</Button></div></Modal>}
  </section>;
}

function RevisionComparison({ applied, chosen }: { applied: ProfileRevision | null; chosen: ProfileRevision }) {
  const texts = (config?: ProfileConfig) => config?.visible_texts ? `Заголовок: ${config.visible_texts.title}\nПриглашение: ${config.visible_texts.login_prompt}\nУспех: ${config.visible_texts.success}\nОтказ: ${config.visible_texts.failure}` : undefined;
  const channel = (config?: ProfileConfig) => config?.channel ? `TLS: ${config.channel.tls_required ? 'обязателен' : 'не задан'}; heartbeat: ${config.channel.heartbeat_seconds} с; sync: ${config.channel.sync_seconds} с` : undefined;
  const files = (config?: ProfileConfig) => config?.fake_fs?.map((file) => `${file.path}:\n${file.content}`).join('\n\n');
  const rows = [
    ['Профиль', applied?.profile_id, chosen.profile_id],
    ['Шаблон', applied?.config.template_id, chosen.config.template_id],
    ['Уровень', applied?.config.level, chosen.config.level],
    ['Сервисы и внутренние порты', applied?.config.services.map((s) => `${s.id}:${s.port}/${s.protocol}`).join(', '), chosen.config.services.map((s) => `${s.id}:${s.port}/${s.protocol}`).join(', ')],
    ['Видимые тексты', texts(applied?.config), texts(chosen.config)],
    ['Фиктивные учётные записи', applied?.config.synthetic_credentials?.map((c) => c.username).join(', '), chosen.config.synthetic_credentials?.map((c) => c.username).join(', ')],
    ['Файлы', files(applied?.config), files(chosen.config)],
    ['Категории логирования', applied?.config.logging?.categories.join(', '), chosen.config.logging?.categories.join(', ')],
    ['Канал управления', channel(applied?.config), channel(chosen.config)],
  ];
  return <div className="overflow-x-auto"><table className="w-full text-xs text-left" aria-label="Сравнение версий"><thead><tr><th className="p-2">Параметр</th><th className="p-2">Applied v{applied?.revision ?? '—'}</th><th className="p-2">Выбрана v{chosen.revision}</th></tr></thead><tbody>{rows.map(([label, before, after]) => <tr key={label} className="border-t"><td className="p-2">{label}</td><td className="p-2 whitespace-pre-wrap break-all">{before || '—'}</td><td className="p-2 whitespace-pre-wrap break-all">{after || '—'}</td></tr>)}</tbody></table><p className="text-xs text-slate-500">Пароли скрыты. Смена пароля подтверждается новой revision и настоящим входом в Medium после применения.</p></div>;
}
