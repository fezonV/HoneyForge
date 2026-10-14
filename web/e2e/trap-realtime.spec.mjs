import { test, expect } from '@playwright/test';

// Controlled API/WS failures exercise reconciliation in the browser, independent
// of the live-runtime acceptance suite in trap-park.spec.mjs.
const trapId = '11111111-1111-4111-8111-111111111111';
const profileId = '22222222-2222-4222-8222-222222222222';
const commandId = '33333333-3333-4333-8333-333333333333';

async function setup(page) {
  const connections = [];
  const now = new Date().toISOString();
  const config = { level: 'low', services: [{ id: 'web', port: 18080, protocol: 'http', name: 'Архив' }] };
  const state = {
    trap: { id: trapId, name: 'Realtime trap', desired_profile_id: profileId, desired_revision: 1,
      applied_profile_id: null, applied_revision: null, agent_status: 'online', service_status: 'unknown',
      last_seen: now, created_at: now, deployment_bindings: [{ service_id: 'web', host_port: 18080 }] },
    commands: [{ id: commandId, trap_id: trapId, type: 'apply_profile', target_profile_id: profileId,
      target_revision: 1, status: 'queued', created_at: now, expires_at: now }],
    commandError: false,
    trapReads: 0,
  };
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body;
    if (path === '/api/v1/auth/me') body = { id: 'operator-1', username: 'operator', role: 'operator' };
    else if (path === '/api/v1/traps') { state.trapReads++; body = { items: [state.trap] }; }
    else if (path === '/api/v1/profiles') body = { items: [{ id: profileId, name: 'Low profile', current_revision: 1, created_at: now, updated_at: now }] };
    else if (path.endsWith('/revisions/1')) body = { profile_id: profileId, revision: 1, config, created_at: now };
    else if (path.endsWith('/commands')) {
      if (state.commandError) return route.fulfill({ status: 503, json: { error: { code: 'not_ready', message: 'Команды недоступны' } } });
      body = { items: state.commands };
    } else return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Unexpected API request' } } });
    await route.fulfill({ json: body });
  });
  await page.routeWebSocket('**/api/v1/ws', (socket) => connections.push(socket));
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.goto(`/#traps/${trapId}`);
  await expect(page.getByText('Live WS', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Карточка ловушки' })).toContainText('ожидает применения');
  await expect(page.getByRole('region', { name: 'Результаты команд' })).toContainText('В очереди');
  await page.clock.runFor(200); // Flush initial reconciliation, without the five-second polling timer.
  await expect.poll(() => connections.length).toBe(1);
  return { state, connections };
}

test('trap and command notifications reconcile REST; reconnect catches missed updates', async ({ page }) => {
  const { state, connections } = await setup(page);
  const card = page.getByRole('region', { name: 'Карточка ловушки' });
  const history = page.getByRole('region', { name: 'Результаты команд' });
  state.trap.applied_profile_id = profileId;
  state.trap.applied_revision = 1;
  state.trap.service_status = 'running';
  state.commands[0].status = 'applied';
  // Notification data is only an invalidation signal, never authoritative state.
  connections[0].send(JSON.stringify({ type: 'trap.status_changed', data: { service_status: 'error' } }));
  await page.clock.runFor(250);
  await expect(card).toContainText('Сервис работает');
  await expect(history).toContainText('Выполнена');

  connections[0].close({ code: 1012, reason: 'test disconnect' });
  await expect(page.getByText('WS Офлайн', { exact: true })).toBeVisible();
  state.trap.service_status = 'stopped';
  state.commands[0].status = 'failed';
  state.commands[0].error = '<img src=x onerror=alert(1)>';
  await page.clock.runFor(1100);
  await expect.poll(() => connections.length).toBe(2);
  await expect(page.getByText('Live WS', { exact: true })).toBeVisible();
  await page.clock.runFor(250);
  await expect(card).toContainText('Сервис остановлен');
  await expect(history).toContainText('Ошибка выполнения');
  await expect(history).toContainText('<img src=x onerror=alert(1)>');
  await expect(history.locator('img')).toHaveCount(0);
  expect(state.trapReads).toBeGreaterThan(2);
});

test('command failure stays visible and polling recovers when WS is unavailable', async ({ page }) => {
  const { state, connections } = await setup(page);
  const history = page.getByRole('region', { name: 'Результаты команд' });
  state.commandError = true;
  connections[0].send(JSON.stringify({ type: 'command.updated' }));
  await page.clock.runFor(250);
  await expect(history.getByRole('alert')).toContainText('Команды недоступны');
  await expect(history).toContainText('В очереди');
  await page.context().setOffline(true);
  state.commandError = false;
  state.commands[0].status = 'expired';
  await page.context().setOffline(false);
  await page.clock.runFor(5000);
  await expect(history).toContainText('Срок истёк');
  await expect(history.getByRole('alert')).toHaveCount(0);
});
