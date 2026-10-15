import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const trapId = '11111111-1111-4111-8111-111111111111';
const profileId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
const commandId = '44444444-4444-4444-8444-444444444444';
const period = { from: '2026-10-15T10:00:00.000Z', to: '2026-10-15T11:00:00.000Z' };
const query = new URLSearchParams(period);
const id = (n) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
async function setup(page, role = 'operator', route = `/#overview?${query}`) {
  const state = { requests: [], fail: '', csvStatus: 200, csvHold: null, releaseCSV: null, summaryCount: 130 };
  const trap = { id: trapId, name: 'Low actual', agent_status: 'online', service_status: 'running', desired_profile_id: null, desired_revision: null,
    applied_profile_id: null, applied_revision: null, deployment_bindings: [], created_at: period.from, last_seen: period.to };
  const events = Array.from({ length: 130 }, (_, n) => ({ event_id: id(n), trap_id: trapId, event_type: 'http.request', protocol: 'http',
    timestamp: new Date(Date.parse(period.from) + (129 - n) * 1000).toISOString(), source_ip: '198.51.100.8', payload: {}, payload_redacted: true }));
  const audits = Array.from({ length: 130 }, (_, n) => ({ id: id(n), actor_id: actorId, action: 'profile.revision_created', entity_type: 'profile', entity_id: profileId,
    created_at: new Date(Date.parse(period.from) + (129 - n) * 1000).toISOString(), details: { revision: 2 } }));
  audits[0] = { ...audits[0], action: 'command.queued', entity_type: 'command', entity_id: commandId, details: { trap_id: trapId, type: 'stop' } };
  audits[1] = { ...audits[1], action: 'auth.login_failed', actor_id: null, entity_type: 'user', details: { outcome: '<img src=x onerror="window.pwned=1">' } };
  await page.routeWebSocket('**/api/v1/ws', () => {});
  await page.route('**/api/v1/**', async (request) => {
    const url = new URL(request.request().url()), path = url.pathname, q = url.searchParams;
    state.requests.push(path + url.search);
    if (path === '/api/v1/auth/me') return request.fulfill({ json: { id: actorId, username: role, role } });
    if (path === '/api/v1/auth/logout') return request.fulfill({ status: 204 });
    if (state.fail === path) return request.fulfill({ status: 503, json: { error: { code: 'not_ready', message: 'Виджет временно недоступен' } } });
    if (path === '/api/v1/traps') return request.fulfill({ json: { items: [trap, { ...trap, id: profileId, name: 'Offline actual', agent_status: 'offline', service_status: 'error' }] } });
    if (path === '/api/v1/profiles') return request.fulfill({ json: { items: [] } });
    if (path.endsWith('/commands')) return request.fulfill({ json: { items: [{ id: commandId, trap_id: trapId, type: 'stop', status: 'failed', error: 'decoy rejected <script>window.pwned=1</script>', created_at: period.from, expires_at: period.to }] } });
    if (path === '/api/v1/events/summary') return request.fulfill({ json: { from: q.get('from'), to: q.get('to'), total_events: q.get('from') === period.from ? state.summaryCount : 20,
      unique_sources: state.summaryCount ? 1 : 0, by_event_type: state.summaryCount ? [{ event_type: 'http.request', count: state.summaryCount }] : [], top_sources: state.summaryCount ? [{ source_ip: '198.51.100.8/32', count: state.summaryCount }] : [] } });
    if (path === '/api/v1/events/export.csv') {
      if (state.csvHold) await new Promise((resolve) => { state.releaseCSV = resolve; });
      if (state.csvStatus !== 200) return request.fulfill({ status: state.csvStatus, json: { error: { code: 'export_limit_exceeded', message: 'Сузьте фильтры для экспорта' } } });
      return request.fulfill({ contentType: 'text/csv; charset=utf-8', body: 'event_id,trap_id\n' + events.map((event) => `${event.event_id},${trapId}`).join('\n') });
    }
    if (path === '/api/v1/events') {
      const offset = Number(q.get('cursor') || 0), limit = Number(q.get('limit') || 50);
      return request.fulfill({ json: { items: state.summaryCount ? events.slice(offset, offset + limit) : [], next_cursor: state.summaryCount && offset + limit < events.length ? String(offset + limit) : '' } });
    }
    if (path === '/api/v1/audit') {
      let items = audits;
      if (q.get('action')) items = items.filter((item) => item.action === q.get('action'));
      if (q.get('actor_id')) items = items.filter((item) => item.actor_id === q.get('actor_id'));
      if (q.get('from')) items = items.filter((item) => item.created_at >= q.get('from'));
      if (q.get('to')) items = items.filter((item) => item.created_at <= q.get('to'));
      const offset = Number(q.get('cursor') || 0);
      return request.fulfill({ json: { items: items.slice(offset, offset + 50), next_cursor: offset + 50 < items.length ? String(offset + 50) : '' } });
    }
    return request.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Не найдено' } } });
  });
  await page.goto(route);
  return state;
}

for (const width of [1280, 1440]) test(`dashboard real contracts, period drilldown and keyboard at ${width}`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const state = await setup(page);
  await expect(page.getByRole('link', { name: 'Все события периода: 130' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Динамика событий' })).toContainText('Изменение: 110');
  await expect(page.getByRole('link', { name: 'online: 1' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'offline: 1' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'degraded: 1' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Парк ловушек' })).toContainText('Очередь: Неизвестно');
  await expect(page.getByRole('region', { name: 'Top источников' })).toContainText('ASN: Неизвестно');
  await page.screenshot({ path: info.outputPath(`dashboard-${width}.png`), fullPage: true });
  const top = page.getByRole('link', { name: '198.51.100.8/32 — 130 событий' });
  await top.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Журнал событий атак' })).toBeVisible();
  await expect(page.getByLabel('IP источника', { exact: true })).toHaveValue('198.51.100.8');
  const request = state.requests.filter((item) => item.startsWith('/api/v1/events?')).at(-1);
  const params = new URL(`http://test${request}`).searchParams;
  expect(params.get('from')).toBe(period.from); expect(params.get('to')).toBe(period.to);
  await page.goBack();
  await expect(page.getByRole('link', { name: 'Все события периода: 130' })).toBeVisible();
  await page.getByRole('link', { name: 'degraded: 1' }).click();
  await expect(page.getByLabel('Состояние', { exact: true })).toHaveValue('degraded');
});

test('widgets fail independently, retain stale snapshots and clear data for new period', async ({ page }) => {
  const state = await setup(page);
  await expect(page.getByRole('link', { name: 'Все события периода: 130' })).toBeVisible();
  state.fail = '/api/v1/events/summary';
  await page.getByRole('button', { name: 'Обновить сводку' }).click();
  await expect(page.getByRole('region', { name: 'События за период' }).getByRole('alert')).toContainText('Снимок устарел');
  await expect(page.getByRole('region', { name: 'Последние события периода' }).getByRole('table')).toBeVisible();
  await expect(page.getByRole('link', { name: 'online: 1' })).toBeVisible();
  await page.getByRole('button', { name: '1 ч', exact: true }).click();
  await expect(page.getByRole('region', { name: 'События за период' }).getByRole('alert')).toContainText('Данные недоступны');
  await expect(page.getByRole('link', { name: 'Все события периода: 130' })).toHaveCount(0);
});

test('an empty period displays confirmed zero and empty widgets without inventing queue metrics', async ({ page }) => {
  const state = await setup(page);
  await expect(page.getByRole('link', { name: 'Все события периода: 130' })).toBeVisible();
  state.summaryCount = 0;
  await page.getByRole('button', { name: 'Обновить сводку' }).click();
  await expect(page.getByRole('link', { name: 'Все события периода: 0' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Top источников' })).toContainText('IP источников за период не зарегистрированы');
  await expect(page.getByRole('region', { name: 'Последние события периода' })).toContainText('Событий нет.');
  await expect(page.getByRole('region', { name: 'Парк ловушек' })).toContainText('Очередь: Неизвестно');
});

test('audit filters and cursor survive reload, queued differs from actual command failure', async ({ page }, info) => {
  const state = await setup(page, 'operator', '/#audit');
  const table = page.getByRole('table', { name: 'Таблица аудита' });
  await expect(table).toContainText('queued — поставлена в очередь');
  await page.getByRole('button', { name: 'Проверить результат команды' }).click();
  await expect(table).toContainText('Текущее состояние: failed');
  await expect(table).toContainText('Отказ');
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  await expect(table.getByRole('link', { name: `profile: ${profileId}` }).first()).toHaveAttribute('href', `#profiles?profile_id=${profileId}`);
  await page.getByLabel('Действие', { exact: true }).fill('profile.revision_created');
  await page.getByLabel('Оператор (actor_id)').fill(actorId);
  await page.getByLabel('Начало периода (UTC)').fill('2026-10-15T10:00');
  await page.getByLabel('Окончание периода (UTC)').fill('2026-10-15T11:00');
  await page.getByRole('button', { name: 'Применить фильтры' }).click();
  await expect(table.locator('tbody tr')).toHaveCount(50);
  await page.getByRole('button', { name: 'Более ранние записи' }).click();
  await expect(page).toHaveURL(/cursor=50/);
  await expect(table.locator('tbody tr').first()).toContainText('2026-10-15T10:01:17.000Z');
  await page.getByRole('button', { name: 'Более ранние записи' }).click();
  await expect(table.locator('tbody tr')).toHaveCount(28);
  await page.reload();
  await expect(table.locator('tbody tr')).toHaveCount(28);
  const params = new URL(`http://test${state.requests.filter((item) => item.startsWith('/api/v1/audit?')).at(-1)}`).searchParams;
  for (const key of ['action', 'actor_id', 'from', 'to', 'cursor']) expect(params.has(key)).toBe(true);
  await page.screenshot({ path: info.outputPath('audit.png'), fullPage: true });
});

test('CSV uses server selection beyond the page and prevents duplicate downloads', async ({ page }) => {
  const state = await setup(page, 'operator', `/#events?${query}&trap_id=${trapId}&source_ip=198.51.100.8&event_type=http.request&session_id=${actorId}&cursor=50`);
  await expect(page.getByRole('table')).toBeVisible();
  state.csvHold = true;
  await page.getByRole('button', { name: 'Скачать CSV выборки' }).click();
  await expect(page.getByRole('button', { name: 'Выгрузка CSV…' })).toBeDisabled();
  await expect.poll(() => !!state.releaseCSV).toBe(true);
  const download = page.waitForEvent('download'); state.releaseCSV();
  const artifact = await download;
  const csv = readFileSync(await artifact.path(), 'utf8');
  expect(csv.split('\n')).toHaveLength(131);
  expect(csv).toContain(id(129));
  const calls = state.requests.filter((item) => item.startsWith('/api/v1/events/export.csv?'));
  expect(calls).toHaveLength(1);
  const params = new URL(`http://test${calls[0]}`).searchParams;
  expect(params.has('cursor')).toBe(false); expect(params.get('limit')).toBe('10000');
  for (const key of ['trap_id', 'source_ip', 'event_type', 'session_id', 'from', 'to']) expect(params.has(key)).toBe(true);
});

test('CSV errors remain visible; viewer never requests audit or CSV', async ({ page, browser }) => {
  const state = await setup(page, 'operator', '/#events');
  state.csvStatus = 413;
  await page.getByRole('button', { name: 'Скачать CSV выборки' }).click();
  await expect(page.getByRole('region', { name: 'Выгрузка CSV' }).getByRole('alert')).toContainText('Сузьте фильтры');
  const context = await browser.newContext(), viewer = await context.newPage();
  const readOnly = await setup(viewer, 'viewer', 'http://127.0.0.1:5173/#audit');
  await expect(viewer.getByRole('alert')).toContainText('Аудит доступен только оператору');
  expect(readOnly.requests.some((item) => item.startsWith('/api/v1/audit'))).toBe(false);
  await viewer.goto('http://127.0.0.1:5173/#events');
  await expect(viewer.getByText('CSV доступен только оператору.')).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Скачать CSV выборки' })).toHaveCount(0);
  expect(readOnly.requests.some((item) => item.includes('export.csv'))).toBe(false);
  await context.close();
});
