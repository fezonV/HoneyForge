import { test, expect } from '@playwright/test';

async function setup(page, response = { items: [] }, status = 200) {
  const writes = [];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.routeWebSocket('**/api/v1/ws', () => {});
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET') writes.push(path);
    if (path === '/api/v1/auth/me') return route.fulfill({ json: { id: 'contract-user', username: 'contract', role: 'operator' } });
    if (path === '/api/v1/profiles') return route.fulfill({ status, json: response });
    if (path === '/api/v1/traps') return route.fulfill({ json: { items: [] } });
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Unexpected request' } } });
  });
  await page.goto('/#profiles');
  return { writes, errors };
}

test('FE1 invalid successful JSON becomes an explicit contract error without fixture fallback', async ({ page }) => {
  const { writes, errors } = await setup(page, { items: 'not-an-array' });
  await expect(page.getByText('Сервер вернул ответ, не соответствующий контракту API', { exact: true })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(0);
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('honeyforge_dev_fixtures_enabled'))).not.toBe('true');
});

for (const status of [400, 403, 409, 503]) {
  test(`FE1 API ${status} keeps the server error and does not retry a mutation`, async ({ page }) => {
    const { writes } = await setup(page, { error: { code: `test_${status}`, message: `contract-${status}` } }, status);
    await expect(page.getByText(`contract-${status}`, { exact: true })).toBeVisible();
    expect(writes).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('honeyforge_dev_fixtures_enabled'))).not.toBe('true');
  });
}

test('FE1 expired operator session returns to login and preserves the requested route', async ({ page }) => {
  await setup(page, { error: { code: 'unauthorized', message: 'Session expired' } }, 401);
  await expect(page.getByRole('button', { name: 'Войти в консоль' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('#profiles');
  expect(await page.evaluate(() => localStorage.getItem('honeyforge_dev_fixtures_enabled'))).not.toBe('true');
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }]) {
  test(`FE1 wizard validation and keyboard focus at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const { writes, errors } = await setup(page);
    const open = page.getByRole('button', { name: 'Конструктор профиля (Мастер)' });
    await open.focus(); await page.keyboard.press('Enter');
    const wizard = page.getByRole('dialog', { name: 'Конструктор профиля поведения (Profile Wizard)' });
    await expect(wizard).toBeVisible();
    await expect.poll(() => wizard.evaluate((root) => root.contains(document.activeElement))).toBeTruthy();
    await wizard.getByPlaceholder('например: Корпоративный веб-архив Ubuntu 24.04 (Low HTTP)').fill('Keyboard profile');
    const medium = wizard.getByRole('button', { name: /Medium HTTP —/ });
    await medium.focus(); await page.keyboard.press('Enter');
    await expect(medium).toHaveAttribute('aria-pressed', 'true');
    await wizard.getByRole('button', { name: 'Далее', exact: true }).click();
    await wizard.locator('input[type="number"]').fill('80.5');
    await wizard.getByRole('button', { name: 'Далее', exact: true }).click();
    await expect(wizard.getByRole('alert')).toContainText('целый порт');
    await wizard.locator('input[type="number"]').fill('18080');
    await wizard.getByRole('button', { name: 'Далее', exact: true }).click();
    await wizard.getByLabel('Путь файла 1').fill('../host-secret');
    await wizard.getByRole('button', { name: 'Далее', exact: true }).click();
    await expect(wizard.getByRole('alert')).toContainText('относительный путь');
    await wizard.getByLabel('Путь файла 1').fill('reports/safe.txt');
    await wizard.getByRole('button', { name: 'Далее', exact: true }).click();
    await expect(wizard.getByRole('checkbox', { name: 'TLS обязателен' })).toBeDisabled();
    await expect(wizard.getByRole('checkbox', { name: 'TLS обязателен' })).toBeChecked();
    const last = wizard.getByRole('button', { name: 'Далее', exact: true });
    await last.focus(); await page.keyboard.press('Tab');
    await expect.poll(() => wizard.evaluate((root) => root.contains(document.activeElement))).toBeTruthy();
    await page.screenshot({ path: `test-results/fe1-wizard-${viewport.width}.png`, fullPage: true });
    await page.keyboard.press('Escape');
    await expect(wizard).toHaveCount(0);
    await expect(open).toBeFocused();
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });
}


test('FE1 unexpected empty success is a contract error rather than an empty catalog', async ({ page }) => {
  await setup(page);
  await page.route('**/api/v1/profiles?**', (route) => route.fulfill({ status: 204 }));
  await page.reload();
  await expect(page.getByText('Сервер вернул пустой ответ вместо данных', { exact: true })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(0);
});
