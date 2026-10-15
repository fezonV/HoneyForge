import { test, expect } from '@playwright/test';

const trapA = '11111111-1111-4111-8111-111111111111';
const trapB = '22222222-2222-4222-8222-222222222222';
const sessionA = '33333333-3333-4333-8333-333333333333';
const sessionB = '44444444-4444-4444-8444-444444444444';
const profile = '55555555-5555-4555-8555-555555555555';
const id = (n) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
function event(n, extra = {}) {
  return { event_id: id(n), trap_id: trapA, agent_id: '66666666-6666-4666-8666-666666666666', service_id: 'archive',
    event_type: 'http.request', timestamp: new Date(Date.parse('2026-10-15T12:00:00Z') - n * 1000).toISOString(),
    received_at: '2026-10-15T12:10:00Z', protocol: 'http', source_ip: '198.51.100.1', source_port: 43210, destination_port: 18080,
    session_id: sessionA, profile_id: profile, applied_revision: 2, payload: {}, payload_redacted: true, ...extra };
}

async function setup(page, role = 'operator') {
  const state = { events: Array.from({ length: 130 }, (_, n) => event(n)), requests: [], sockets: [],
    sensitiveReads: 0, sensitiveStatus: 200, payload: { username: 'reader', password: 'Only-after-explicit-read', path: '<img src=x onerror="window.pwned=1">' },
    oversized: false, timelineWrongTrap: false, slowIP: null, release: null };
  await page.routeWebSocket('**/api/v1/ws', (socket) => state.sockets.push(socket));
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname, q = url.searchParams;
    state.requests.push(url.pathname + url.search);
    if (path === '/api/v1/auth/me') return route.fulfill({ json: { id: 'events-user', username: role, role } });
    if (path === '/api/v1/auth/logout') return route.fulfill({ status: 204 });
    if (path === '/api/v1/traps') return route.fulfill({ json: { items: [] } });
    if (path === '/api/v1/events') {
      let events = [...state.events];
      for (const key of ['trap_id', 'source_ip', 'event_type', 'session_id']) if (q.get(key)) events = events.filter((item) => item[key] === q.get(key));
      if (q.get('from')) events = events.filter((item) => Date.parse(item.timestamp) >= Date.parse(q.get('from')));
      if (q.get('to')) events = events.filter((item) => Date.parse(item.timestamp) <= Date.parse(q.get('to')));
      events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      const offset = Number(q.get('cursor')?.replace('page-', '') || 0);
      const limit = Number(q.get('limit') || 50);
      const json = { items: events.slice(offset, offset + limit), next_cursor: offset + limit < events.length ? `page-${offset + limit}` : '' };
      if (state.slowIP && q.get('source_ip') === state.slowIP) await new Promise((resolve) => { state.release = resolve; });
      return route.fulfill({ json }).catch(() => {});
    }
    if (path.includes('/sessions/')) {
      const sessionId = path.split('/')[4];
      const all = state.events.filter((item) => item.session_id === sessionId).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const offset = Number(q.get('cursor')?.replace('timeline-', '') || 0);
      const items = all.slice(offset, offset + 50);
      if (state.timelineWrongTrap && items.length) items[0] = { ...items[0], trap_id: trapB };
      return route.fulfill({ json: { session: { id: sessionId, trap_id: trapA, started_at: '2026-10-15T00:00:00Z' }, items,
        next_cursor: offset + 50 < all.length ? `timeline-${offset + 50}` : '' } });
    }
    if (path.includes('/events/')) {
      const eventId = path.split('/')[6];
      const selected = state.events.find((item) => item.event_id === eventId && item.trap_id === path.split('/')[4]);
      if (!selected) return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Событие отсутствует' } } });
      if (path.endsWith('/sensitive')) {
        state.sensitiveReads++;
        if (state.sensitiveStatus !== 200) return route.fulfill({ status: state.sensitiveStatus, json: { error: { code: 'forbidden', message: 'Раскрытие запрещено сервером' } } });
        return route.fulfill({ json: { ...selected, payload_redacted: false, payload: state.oversized ? { raw: 'z'.repeat(300000) } : state.payload } });
      }
      return route.fulfill({ json: selected });
    }
    return route.fulfill({ status: 404, json: { error: { message: 'Unexpected API request' } } });
  });
  await page.goto('/#events');
  await expect(page.getByRole('table', { name: 'Журнал событий атак' })).toBeVisible();
  await expect(page.getByText('Live WS', { exact: true })).toBeVisible();
  return state;
}
const table = (page) => page.getByRole('table', { name: 'Журнал событий атак' });
const notify = (state, item = state.events[0]) => state.sockets.at(-1).send(JSON.stringify({ type: 'event.created', id: item.event_id, data: { event_id: item.event_id, trap_id: item.trap_id } }));

test('cursor pages reach history past 100; every filter is sent to the server and survives reload', async ({ page }, testInfo) => {
  const state = await setup(page);
  await expect(table(page).getByRole('row')).toHaveCount(51);
  await page.getByRole('button', { name: 'Более ранние события' }).click();
  await expect(table(page)).toContainText(id(50));
  await page.getByRole('button', { name: 'Более ранние события' }).click();
  await expect(table(page)).toContainText(id(125));
  expect(new URL(page.url()).hash).toContain('cursor=page-100');
  const target = event(125, { trap_id: trapB, source_ip: '203.0.113.9', event_type: 'file.read', session_id: sessionB, applied_revision: 1 });
  state.events[125] = target;
  await page.getByLabel('Ловушка (trap_id)', { exact: true }).fill(trapB);
  await page.getByLabel('IP источника', { exact: true }).fill(target.source_ip);
  await page.getByLabel('Тип события', { exact: true }).fill('file.read');
  await page.getByLabel('Сессия (session_id)', { exact: true }).fill(sessionB);
  await page.getByLabel('Начало периода (UTC)').fill('2026-10-15T00:00');
  await page.getByLabel('Окончание периода (UTC)').fill('2026-10-15T23:59');
  await page.getByRole('button', { name: 'Применить фильтры' }).click();
  await expect(table(page).getByRole('row')).toHaveCount(2);
  await expect(table(page)).toContainText(target.event_id);
  const params = new URLSearchParams(new URL(page.url()).hash.split('?')[1]);
  expect(params.get('cursor')).toBeNull();
  for (const key of ['trap_id', 'source_ip', 'event_type', 'session_id', 'from', 'to']) expect(params.has(key)).toBeTruthy();
  const query = new URL(`http://test${state.requests.filter((request) => request.startsWith('/api/v1/events?')).at(-1)}`).searchParams;
  expect(query.get('source_ip')).toBe(target.source_ip);
  expect(query.get('from')).toBe('2026-10-15T00:00:00.000Z');
  await page.reload();
  await expect(table(page).getByRole('row')).toHaveCount(2);
  await expect(page.getByLabel('IP источника', { exact: true })).toHaveValue(target.source_ip);
  await page.screenshot({ path: testInfo.outputPath('event-filters.png'), fullPage: true });
});

test('an old filter response cannot overwrite the new filter', async ({ page }) => {
  const state = await setup(page);
  state.events.push(event(200, { source_ip: '203.0.113.7' }));
  state.slowIP = '198.51.100.1';
  await page.getByLabel('IP источника', { exact: true }).fill(state.slowIP);
  await page.getByRole('button', { name: 'Применить фильтры' }).click();
  await expect.poll(() => !!state.release).toBe(true);
  await page.getByLabel('IP источника', { exact: true }).fill('203.0.113.7');
  await page.getByRole('button', { name: 'Применить фильтры' }).click();
  await expect(table(page)).toContainText(id(200));
  state.release();
  await expect(table(page).getByRole('row')).toHaveCount(2);
  await expect(table(page)).not.toContainText(id(0));
});

test('live REST reconciliation deduplicates notifications; pause and old pages keep their snapshot', async ({ page }) => {
  const state = await setup(page);
  const next = event(900, { timestamp: '2026-10-15T12:01:00Z' }); state.events.unshift(next);
  notify(state, next); notify(state, next);
  await expect(table(page)).toContainText(next.event_id);
  await expect(table(page).getByRole('row')).toHaveCount(51);
  await expect(table(page).getByRole('button', { name: `Открыть событие ${next.event_id}`, exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Пауза ленты' }).click();
  const paused = event(901, { timestamp: '2026-10-15T12:02:00Z' }); state.events.unshift(paused); notify(state, paused);
  await expect(page.getByText(/Новых событий в начале выборки: 1\./)).toBeVisible();
  await expect(table(page)).not.toContainText(paused.event_id);
  await page.getByRole('button', { name: 'Показать новые события' }).click();
  await expect(table(page)).toContainText(paused.event_id);
  await page.getByRole('button', { name: 'Более ранние события' }).click();
  const first = await table(page).getByRole('row').nth(1).innerText();
  const newest = event(902, { timestamp: '2026-10-15T12:03:00Z' }); state.events.unshift(newest); notify(state, newest);
  await expect(page.getByText(/Новых событий в начале выборки: 1\./)).toBeVisible();
  expect(await table(page).getByRole('row').nth(1).innerText()).toBe(first);
  await expect(table(page)).not.toContainText(newest.event_id);
});

test('reconnect reloads REST with active filters and details keep the list still', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('button', { name: `Открыть событие ${id(0)}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Детали события' });
  await expect(dialog).toContainText('Историческая revision');
  const added = event(910, { timestamp: '2026-10-15T12:10:00Z' }); state.events.unshift(added);
  notify(state, added);
  await expect(page.getByText(/Новых событий в начале выборки: 1\./)).toBeAttached();
  await expect(table(page)).not.toContainText(added.event_id);
  await dialog.getByRole('button', { name: 'Закрыть диалоговое окно' }).click();
  state.sockets[0].close({ code: 1012, reason: 'test restart' });
  await expect.poll(() => state.sockets.length).toBe(2);
  await expect(table(page)).toContainText(added.event_id);
  expect(state.sensitiveReads).toBe(0);
});

test('separate sensitive GET is explicit, audited by server contract, bounded and text-only', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('button', { name: `Открыть событие ${id(0)}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Детали события' });
  await expect(dialog.getByText('Payload', { exact: true })).toBeVisible();
  expect(state.sensitiveReads).toBe(0);
  await expect(page.getByText('Only-after-explicit-read', { exact: false })).toHaveCount(0);
  state.payload.large = 'y'.repeat(20000);
  await dialog.getByRole('button', { name: 'Запросить payload с аудитом' }).click();
  await expect(dialog.locator('pre')).toContainText('Only-after-explicit-read');
  await expect(dialog).toContainText('Остальная часть payload пропущена');
  await expect(dialog.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  expect(state.sensitiveReads).toBe(1);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('Only-after-explicit-read');
  await dialog.getByRole('button', { name: 'Убрать payload из просмотра' }).click();
  state.oversized = true;
  await dialog.getByRole('button', { name: 'Запросить payload с аудитом' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Payload пропущен');
  await expect(dialog.locator('pre')).toHaveCount(0);
  await expect(dialog).toContainText('IP источника');
});

test('viewer never fetches sensitive data; operator denial stays explicit', async ({ page, browser }) => {
  const state = await setup(page, 'viewer');
  await page.getByRole('button', { name: `Открыть событие ${id(0)}`, exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Детали события' })).toContainText('только оператору');
  await expect(page.getByRole('button', { name: 'Запросить payload с аудитом' })).toHaveCount(0);
  expect(state.sensitiveReads).toBe(0);
  const other = await browser.newPage({ baseURL: 'http://127.0.0.1:5173' });
  const operator = await setup(other);
  operator.sensitiveStatus = 403;
  await other.getByRole('button', { name: `Открыть событие ${id(0)}`, exact: true }).click();
  await other.getByRole('button', { name: 'Запросить payload с аудитом' }).click();
  await expect(other.getByRole('alert')).toContainText('Раскрытие запрещено сервером');
  await expect(other.locator('pre')).toHaveCount(0);
  await other.close();
});

test('timeline is chronological, paginated, historical and rejects a different trap', async ({ page }) => {
  const state = await setup(page);
  state.events[0].applied_revision = 1;
  state.events[1].event_type = 'auth.attempt'; state.events[2].event_type = 'file.read'; state.events[3].event_type = 'command.received';
  state.events.push(event(300, { session_id: sessionB, trap_id: trapB }));
  await page.getByRole('button', { name: `Открыть событие ${id(0)}`, exact: true }).click();
  await page.getByRole('button', { name: 'Открыть timeline сессии' }).click();
  const dialog = page.getByRole('dialog', { name: 'Timeline сессии' });
  await expect(dialog).toContainText(id(129));
  await expect(dialog).not.toContainText(id(300));
  await dialog.getByRole('button', { name: 'Следующая страница timeline' }).click();
  await expect(dialog).toContainText(id(79));
  await dialog.getByRole('button', { name: 'Следующая страница timeline' }).click();
  await expect(dialog).toContainText('auth.attempt');
  await expect(dialog).toContainText('file.read');
  await expect(dialog).toContainText('command.received');
  await expect(dialog).toContainText('v1');
  const rows = await dialog.getByRole('table').getByRole('row').allInnerTexts();
  expect(rows.at(-1)).toContain(id(0));
  state.timelineWrongTrap = true;
  await dialog.getByRole('button', { name: 'Обновить timeline' }).click();
  await expect(dialog.getByRole('alert')).toContainText('другой сессии или ловушки');
  await expect(dialog.getByRole('table')).toHaveCount(0);
});

test('disconnected/error/empty states are explicit; logout closes the WebSocket', async ({ page }) => {
  const state = await setup(page);
  let closed = false;
  state.sockets[0].onClose(() => { closed = true; });
  await page.getByLabel('IP источника', { exact: true }).fill('192.0.2.200');
  await page.getByRole('button', { name: 'Применить фильтры' }).click();
  await expect(page.getByText('События не найдены.', { exact: false })).toBeVisible();
  await page.route('**/api/v1/events?**', (route) => route.fulfill({ status: 503, json: { error: { code: 'not_ready', message: 'История временно недоступна' } } }));
  await page.getByRole('button', { name: 'Обновить события' }).click();
  await expect(page.getByRole('alert')).toContainText('История временно недоступна');
  await page.getByRole('button', { name: 'Выйти из системы' }).click();
  await expect(page.getByRole('button', { name: 'Войти в консоль' })).toBeVisible();
  await expect.poll(() => closed).toBe(true);
});
