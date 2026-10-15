import { test, expect } from '@playwright/test';

const trapId = '11111111-1111-4111-8111-111111111111';
const profileId = '22222222-2222-4222-8222-222222222222';
const commandId = '33333333-3333-4333-8333-333333333333';

async function setup(page, role = 'operator') {
  const config = {
    template_id: 'medium-http', level: 'medium', services: [{ id: 'web', name: 'Архив', port: 18080, protocol: 'http' }],
    visible_texts: { title: 'Архив', login_prompt: 'Вход', success: 'ОК', failure: 'Отказ' },
    synthetic_credentials: [{ username: 'reader', password: '' }], fake_fs: [{ path: 'report.txt', content: 'Synthetic file' }],
    logging: { categories: ['auth.attempt'] }, channel: { tls_required: true, heartbeat_seconds: 5, sync_seconds: 2 },
  };
  const now = new Date().toISOString();
  const state = {
    trap: { id: trapId, name: 'Trap A', desired_profile_id: profileId, desired_revision: 1, applied_profile_id: profileId,
      applied_revision: 1, agent_status: 'online', service_status: 'running', last_seen: now, created_at: now,
      deployment_bindings: [{ service_id: 'web', host_port: 18080 }],
      telemetry: { queue_depth: 4, queue_limit: 100, quarantined: 0, sent_events: 20, delivery_errors: 1, delivery_retries: 2, storage_errors: 0, degraded: false } },
    versions: [1, 2].map((revision) => ({ profile_id: profileId, revision, config: { ...config, visible_texts: { ...config.visible_texts, title: `Архив v${revision}` } }, created_at: now })),
    commands: [], posts: [], assignments: [], patches: [], timeout: false, sessionExpired: false, patchConflict: false, socket: null,
  };
  await page.routeWebSocket('**/api/v1/ws', (socket) => { state.socket = socket; });
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let json;
    const profile = { id: profileId, name: 'Medium profile', description: 'Synthetic profile', current_revision: state.versions.length, created_at: now, updated_at: now };
    if (path === '/api/v1/auth/me') json = { id: `${role}-1`, username: role, role };
    else if (path === '/api/v1/traps') json = { items: [state.trap] };
    else if (path === '/api/v1/profiles') json = { items: [profile] };
    else if (path === `/api/v1/profiles/${profileId}`) {
      if (request.method() === 'PATCH') {
        const body = request.postDataJSON(); state.patches.push(body);
        if (state.patchConflict) return route.fulfill({ status: 409, json: { error: { code: 'revision_conflict', message: 'Профиль изменён другим оператором' } } });
        const created = { profile_id: profileId, revision: state.versions.length + 1, config: body.config, created_at: now };
        state.versions.push(created); json = { profile, revision: created };
      } else json = { profile, revision: state.versions.at(-1) };
    } else if (path.endsWith('/revisions')) json = { items: [...state.versions].reverse() };
    else if (path.includes('/revisions/')) json = state.versions.find((item) => item.revision === Number(path.split('/').at(-1)));
    else if (path.endsWith('/profile')) {
      const body = request.postDataJSON(); state.assignments.push(body);
      state.trap.desired_revision = body.revision; state.trap.desired_profile_id = body.profile_id;
      json = state.trap;
    } else if (path.endsWith('/commands')) {
      if (request.method() === 'POST') {
        const body = request.postDataJSON(); state.posts.push({ path, body });
        if (state.sessionExpired) return route.fulfill({ status: 401, json: { error: { code: 'unauthorized', message: 'Сессия истекла' } } });
        const command = { id: commandId, trap_id: trapId, type: body.type, target_profile_id: profileId,
          target_revision: body.expected_revision, status: 'queued', created_at: state.commandTime || new Date().toISOString(), expires_at: new Date(Date.now() + 300000).toISOString() };
        state.commands.push(command);
        if (state.timeout) return route.abort('failed');
        json = command;
      } else json = { items: state.commands };
    } else return route.fulfill({ status: 404, json: { error: { message: `Unexpected ${path}` } } });
    await route.fulfill({ json });
  });
  await page.goto(`/#traps/${trapId}`);
  await expect(page.getByRole('region', { name: 'Управление экземпляром' })).toBeVisible();
  return state;
}
const update = (state) => state.socket.send(JSON.stringify({ type: 'command.updated' }));
const panel = (page) => page.getByRole('region', { name: 'Управление экземпляром' });

test('stop requires confirmation, is scoped to A, and success waits for applied', async ({ page }) => {
  const state = await setup(page);
  const controls = panel(page);
  await expect(controls).toContainText('Очередь событий: 4 / 100');
  await controls.getByRole('button', { name: 'Остановить', exact: true }).click();
  expect(state.posts).toHaveLength(0);
  const confirm = page.getByRole('dialog', { name: 'Подтвердить команду' });
  await expect(confirm).toContainText(`Trap A» (${trapId})`);
  await page.screenshot({ path: 'test-results/fe2-command-confirmation.png', fullPage: true });
  await confirm.getByRole('button', { name: 'Подтвердить остановить' }).click();
  await expect.poll(() => state.posts.length).toBe(1);
  expect(state.posts[0].path).toBe(`/api/v1/traps/${trapId}/commands`);
  const history = page.getByRole('region', { name: 'Результаты команд' });
  await expect(history).toContainText('В очереди');
  await expect(controls.getByRole('button', { name: 'Запустить', exact: true })).toBeDisabled();
  await expect(page.getByRole('region', { name: 'Карточка ловушки' })).toContainText('Сервис работает');
  state.commands[0].status = 'delivered'; update(state);
  await expect(history).toContainText('Доставлена агенту');
  await expect(history.getByText('Выполнена', { exact: true })).toHaveCount(0);
  state.commands[0].status = 'applied'; state.trap.service_status = 'stopped'; update(state);
  await expect(history).toContainText('Выполнена');
  await expect(controls.getByRole('button', { name: 'Запустить', exact: true })).toBeEnabled();
  await expect(page.getByRole('region', { name: 'Карточка ловушки' })).toContainText('Сервис остановлен');
  await page.screenshot({ path: 'test-results/fe2-control.png', fullPage: true });
});

test('lost command response is reconciled without a duplicate POST despite clock skew and reload', async ({ page }) => {
  const state = await setup(page);
  state.timeout = true;
  state.commandTime = new Date(Date.now() - 60000).toISOString();
  await panel(page).getByRole('button', { name: 'Остановить', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить остановить' }).click();
  await expect(panel(page)).toContainText('Результат отправки неизвестен');
  await expect(panel(page)).toContainText(commandId);
  await page.reload();
  await expect(panel(page).getByRole('button', { name: 'Остановить', exact: true })).toBeDisabled();
  expect(state.posts).toHaveLength(1);
  state.commands[0].status = 'failed'; state.commands[0].error = 'decoy rejected config'; update(state);
  await expect(page.getByRole('region', { name: 'Результаты команд' })).toContainText('decoy rejected config');
  await expect(panel(page).getByRole('button', { name: 'Остановить', exact: true })).toBeDisabled();
  await panel(page).getByRole('button', { name: `Связать с командой ${commandId}` }).click();
  await expect(panel(page).getByRole('button', { name: 'Остановить', exact: true })).toBeEnabled();
  expect(state.trap.applied_revision).toBe(1);
});

test('assign v2 preserves applied v1; credential rotation creates v3 without mass assignment', async ({ page }) => {
  const state = await setup(page);
  const controls = panel(page);
  await controls.getByLabel('Версия для назначения').selectOption('2');
  await expect(controls.getByRole('table', { name: 'Сравнение версий' })).toContainText('Архив v2');
  await controls.getByRole('button', { name: 'Назначить выбранную версию' }).click();
  await page.getByRole('button', { name: 'Подтвердить назначение' }).click();
  await expect(controls).toContainText('Назначена desired v2');
  expect(state.trap.applied_revision).toBe(1);
  expect(state.assignments).toHaveLength(1);
  await controls.getByRole('button', { name: 'Ротация фиктивных credentials' }).click();
  const dialog = page.getByRole('dialog', { name: 'Новая версия с фиктивными credentials' });
  await dialog.getByLabel('Фиктивный пароль 1').fill('Synthetic-New-Password!');
  await dialog.getByRole('button', { name: 'Создать новую revision' }).click();
  await expect(controls).toContainText('Создана v3');
  expect(state.patches).toHaveLength(1);
  expect(state.patches[0].base_revision).toBe(2);
  expect(state.patches[0].config.synthetic_credentials[0].password).toBe('Synthetic-New-Password!');
  expect(state.assignments).toHaveLength(1);
  expect(state.trap.desired_revision).toBe(2);
  expect(await page.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }))).not.toContain('Synthetic-New-Password!');
});

test('offline and expired stay distinct; viewer cannot send actions', async ({ page }) => {
  const state = await setup(page, 'viewer');
  state.trap.agent_status = 'offline';
  state.commands = [{ id: commandId, trap_id: trapId, type: 'start', status: 'expired', created_at: new Date().toISOString(), expires_at: new Date().toISOString() }];
  update(state);
  await expect(page.getByRole('region', { name: 'Карточка ловушки' })).toContainText('Агент offline');
  await expect(page.getByRole('region', { name: 'Результаты команд' })).toContainText('Команда не выполнена до истечения срока');
  await expect(panel(page).getByRole('button')).toHaveCount(0);
  expect(state.posts).toHaveLength(0);
});

test('session expiry on POST returns to login and never replays the command', async ({ page }) => {
  const state = await setup(page);
  state.sessionExpired = true;
  await panel(page).getByRole('button', { name: 'Остановить', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить остановить' }).click();
  await expect(page.getByRole('button', { name: 'Войти в консоль' })).toBeVisible();
  expect(state.posts).toHaveLength(1);
});

test('incompatible service bindings block assignment; stale rotation fails without switching the trap', async ({ page }) => {
  const state = await setup(page);
  const controls = panel(page);
  state.versions[1].config = { ...state.versions[1].config, services: [{ ...state.versions[1].config.services[0], id: 'other', port: 18081 }] };
  // Reload causes a new revision read, rather than changing cached immutable data in the UI.
  await page.reload();
  await controls.getByLabel('Версия для назначения').selectOption('2');
  await expect(controls).toContainText('Сервисы не соответствуют bindings');
  await expect(controls.getByRole('button', { name: 'Назначить выбранную версию' })).toBeDisabled();
  expect(state.assignments).toHaveLength(0);
  state.patchConflict = true;
  await controls.getByRole('button', { name: 'Ротация фиктивных credentials' }).click();
  const dialog = page.getByRole('dialog', { name: 'Новая версия с фиктивными credentials' });
  await dialog.getByLabel('Фиктивный пароль 1').fill('Synthetic-New-Password!');
  await dialog.getByRole('button', { name: 'Создать новую revision' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Профиль изменён другим оператором');
  expect(state.versions).toHaveLength(2);
  expect(state.trap.desired_revision).toBe(1);
  expect(state.trap.applied_revision).toBe(1);
});

test('a definite rejection after leaving the card does not leave a permanent pending command', async ({ page }) => {
  const state = await setup(page);
  let release;
  const responseGate = new Promise((done) => { release = done; });
  let started;
  const requestStarted = new Promise((done) => { started = done; });
  await page.route(`**/api/v1/traps/${trapId}/commands`, async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    state.posts.push({ body: route.request().postDataJSON() });
    started();
    await responseGate;
    await route.fulfill({ status: 409, json: { error: { code: 'profile_conflict', message: 'Назначение изменилось' } } });
  });
  await panel(page).getByRole('button', { name: 'Остановить', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить остановить' }).click();
  await requestStarted;
  await page.evaluate(() => { location.hash = 'profiles'; });
  await expect(panel(page)).toHaveCount(0);
  release();
  await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('hf_command_pending:')).length)).toBe(0);
  await page.evaluate((id) => { location.hash = `traps/${id}`; }, trapId);
  await expect(panel(page).getByRole('button', { name: 'Остановить', exact: true })).toBeEnabled();
  expect(state.posts).toHaveLength(1);
});
