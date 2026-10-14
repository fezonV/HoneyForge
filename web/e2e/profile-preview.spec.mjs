import { test, expect } from '@playwright/test';

const profileId = '22222222-2222-4222-8222-222222222222';
const attack = '<img src="https://preview-invalid.example/leak" onerror="parent.previewEscaped=true">';
const secret = 'preview-must-never-receive-this-password';
const configuration = (level = 'medium', files = [{ path: 'reports/empty.txt', content: '' }, { path: 'reports/payload.txt', content: attack }]) => ({
  template_id: `${level}-http`, level,
  services: [{ id: 'web', name: 'Preview service', protocol: 'http', port: 18080, banner: 'Configured service banner' }],
  visible_texts: { title: attack, login_prompt: 'Configured login prompt', failure: 'Configured login failure', success: 'Configured success' },
  fake_fs: files, synthetic_credentials: level === 'medium' ? [{ username: 'synthetic-user', password: secret }] : [],
  logging: { categories: ['connection.opened', 'http.request', 'auth.attempt', 'session.started', 'session.ended'] },
  channel: { tls_required: true, heartbeat_seconds: 15, sync_seconds: 30 },
});

async function setup(page, config, role = 'operator') {
  const mutations = [], frameRequests = [], errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.frame().parentFrame()) frameRequests.push(request.url());
  });
  await page.routeWebSocket('**/api/v1/ws', () => {});
  await page.route('**/api/v1/**', async (route) => {
    if (route.request().method() !== 'GET') mutations.push(route.request().url());
    const path = new URL(route.request().url()).pathname;
    let body;
    if (path === '/api/v1/auth/me') body = { id: 'preview-user', username: 'preview', role };
    else if (path === '/api/v1/profiles') body = { items: [{ id: profileId, name: 'Preview profile', current_revision: 3, created_at: '2026-10-14T00:00:00Z' }] };
    else if (path.endsWith('/revisions/3')) body = { profile_id: profileId, revision: 3, config };
    else return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Unexpected API request' } } });
    return route.fulfill({ json: body });
  });
  await page.goto('/#profiles');
  await expect(page.getByRole('heading', { name: 'Preview profile', exact: true })).toBeVisible();
  return { mutations, frameRequests, errors };
}

async function openPreview(page) {
  await page.getByRole('button', { name: 'Предпросмотр', exact: true }).click();
  return page.frameLocator('iframe[title="Decoy Template Live Preview"]');
}

test('Medium preview reflects saved revision without leaking credentials, executing HTML or making requests', async ({ page }) => {
  const { mutations, frameRequests, errors } = await setup(page, configuration());
  const frame = await openPreview(page);
  await expect(frame.getByRole('heading', { name: attack, exact: true })).toBeVisible();
  await expect(frame.getByRole('heading', { name: 'Configured login prompt', exact: true })).toBeVisible();
  await expect(frame.locator('.description')).toContainText('Configured service banner');
  await expect(frame.getByRole('button', { name: 'Войти', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Ошибка входа', exact: true }).click();
  await expect(frame.getByRole('alert')).toHaveText('Configured login failure');
  await page.getByRole('button', { name: 'Файлы', exact: true }).click();
  await expect(frame.getByText('Configured success', { exact: true })).toBeVisible();
  await expect(frame.locator('.document-row')).toHaveCount(2);
  await expect(frame.locator('time')).toHaveCount(0);
  await frame.getByRole('button', { name: 'Empty', exact: true }).click();
  await expect(frame.locator('pre')).toHaveText('');
  await expect(frame.locator('.file-meta')).toHaveText('TXT · 0 Б');
  await frame.getByRole('button', { name: 'К списку файлов' }).click();
  await frame.getByRole('button', { name: 'Payload', exact: true }).click();
  await expect(frame.locator('pre')).toHaveText(attack);
  await expect(frame.locator('img, script')).toHaveCount(0);
  expect(await page.locator('iframe').evaluate((iframe) => iframe.contentDocument.documentElement.outerHTML)).not.toContain(secret);
  expect(await page.locator('iframe').getAttribute('sandbox')).toBe('allow-same-origin');
  await frame.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(frame.getByLabel('Пароль', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Истекла сессия', exact: true }).click();
  await expect(frame.getByRole('alert')).toContainText('Срок сессии истёк');
  expect(await page.evaluate(() => window.previewEscaped)).toBeUndefined();
  expect(mutations).toEqual([]);
  expect(frameRequests).toEqual([]);
  expect(errors).toEqual([]);
});

test('empty Low preview and viewer preview do not invent fixture documents', async ({ page }) => {
  const { mutations, frameRequests } = await setup(page, configuration('low', []), 'viewer');
  const frame = await openPreview(page);
  await expect(frame.getByRole('heading', { name: 'Архив пока пуст' })).toBeVisible();
  await expect(frame.locator('.document-row')).toHaveCount(0);
  await frame.getByRole('button', { name: 'Вернуться в каталог' }).click();
  await expect(frame.getByRole('heading', { name: 'Архив пока пуст' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Конструктор профиля (Мастер)' })).toHaveCount(0);
  expect(mutations).toEqual([]);
  expect(frameRequests).toEqual([]);
});

test('wizard preview follows form edits and reset without saving or deploying', async ({ page }) => {
  const { mutations, errors } = await setup(page, configuration());
  await page.getByRole('button', { name: 'Конструктор профиля (Мастер)' }).click();
  await page.getByPlaceholder('например: Корпоративный веб-архив Ubuntu 24.04 (Low HTTP)').fill('Unsaved profile');
  await page.getByRole('heading', { name: 'Medium HTTP — Служебный портал архива' }).click();
  await page.getByRole('button', { name: 'Далее', exact: true }).click();
  await page.getByRole('button', { name: 'Далее', exact: true }).click();
  await page.getByPlaceholder('Городской электронный архив').fill('Unsaved title');
  await page.getByPlaceholder('Вход в закрытый контур архива').fill('Unsaved login prompt');
  await page.getByRole('button', { name: 'Далее', exact: true }).click();
  await page.getByRole('button', { name: 'Далее', exact: true }).click();
  const frame = page.frameLocator('iframe[title="Decoy Template Live Preview"]');
  await expect(frame.getByRole('heading', { name: 'Unsaved title', exact: true })).toBeVisible();
  await expect(frame.getByRole('heading', { name: 'Unsaved login prompt', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Файлы', exact: true }).click();
  await expect(frame.locator('.document-row')).toHaveCount(3);
  await page.getByRole('button', { name: 'Сбросить состояние', exact: true }).click();
  await expect(frame.getByRole('button', { name: 'Войти', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  await page.getByRole('button', { name: 'Назад', exact: true }).click();
  await page.getByPlaceholder('Городской электронный архив').fill('Edited title');
  await page.getByRole('button', { name: 'Далее', exact: true }).click();
  await page.getByRole('button', { name: 'Далее', exact: true }).click();
  await expect(frame.getByRole('heading', { name: 'Edited title', exact: true })).toBeVisible();
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
});

test('standalone TL-01 preview keeps its dated fixtures and navigation', async ({ page }) => {
  const { spawn } = await import('node:child_process');
  const { resolve } = await import('node:path');
  const server = spawn('python3', ['-u', '-m', 'http.server', '0', '--bind', '127.0.0.1', '--directory', resolve(import.meta.dirname, '../../tools/decoy-lab')], { stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const port = await new Promise((done, reject) => {
      server.once('error', reject);
      server.once('exit', () => reject(new Error('Static lab server exited before ready')));
      server.stdout.on('data', (data) => { const match = data.toString().match(/port (\d+)/); if (match) done(Number(match[1])); });
    });
    await page.goto(`http://127.0.0.1:${port}/`);
    const frame = page.frameLocator('iframe#preview');
    await expect(frame.locator('.document-row')).toHaveCount(6);
    await expect(frame.locator('time').first()).toHaveText('01.09.2026');
    await page.locator('input[name="level"][value="medium"]').check();
    await expect(frame.getByRole('button', { name: 'Войти', exact: true })).toBeDisabled();
    await page.getByLabel('Состояние', { exact: true }).selectOption('files');
    await frame.getByRole('button', { name: 'Порядок ведения архива', exact: true }).click();
    await expect(frame.locator('pre')).toContainText('Вереск · Регламент Р-01');
    await frame.getByRole('button', { name: 'К списку файлов' }).click();
    await expect(frame.locator('.document-row')).toHaveCount(6);
  } finally {
    server.kill('SIGTERM');
  }
});
