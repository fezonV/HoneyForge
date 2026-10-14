import { test, expect } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { readFileSync } from 'node:fs';

// Deliberately requires a separate disposable database. No API or agent mocks.
test.skip(!process.env.TEST_DATABASE_URL, 'Set TEST_DATABASE_URL to a disposable PostgreSQL database');
const root = resolve(import.meta.dirname, '../..');
const dockerNode = process.env.HF_BUNDLE_DOCKER_NODE;
const agentHost = dockerNode ? execFileSync('docker', ['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}'], { encoding: 'utf8' }).trim() : '127.0.0.1';
const publicHost = dockerNode ? execFileSync('docker', ['inspect', dockerNode, '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'], { encoding: 'utf8' }).trim() : '127.0.0.1';
const dockerBundles = [];
const visitorForwards = [];
// Keep browser traffic to this disposable local Docker node on loopback; the
// browser's inherited Internet proxy cannot route private Docker addresses.
async function visitorURL(port) {
  if (!dockerNode) return `http://127.0.0.1:${port}`;
  const sockets = new Set();
  const forward = net.createServer((incoming) => {
    const upstream = net.connect(port, publicHost);
    for (const socket of [incoming, upstream]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => { incoming.destroy(); upstream.destroy(); });
    }
    incoming.pipe(upstream).pipe(incoming);
  });
  await new Promise((done) => forward.listen(0, '127.0.0.1', done));
  visitorForwards.push({ forward, sockets });
  return `http://127.0.0.1:${forward.address().port}`;
}
const run = (command, args) => new Promise((done, reject) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => { output = (output + data).slice(-5000); });
  child.stderr.on('data', (data) => { output = (output + data).slice(-5000); });
  child.once('error', reject);
  child.once('exit', (code) => code === 0 ? done(output) : reject(new Error(`${command} exited ${code}: ${output}`)));
});
const username = `fe2_${Date.now()}`;
const password = 'Local-e2e-only-password!';
let dir, tlsServer, center;
const children = [];

const freePort = async () => {
  const server = net.createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
};
const waitFor = async (probe, timeout = 15000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await probe()) return; } catch { /* service still starting */ }
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error('Live service did not become ready');
};
const launch = (binary, args, env = process.env) => {
  const child = spawn(binary, args, { cwd: dir, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  child.stderr.on('data', (data) => { log = (log + data.toString()).slice(-2000); });
  child.on('error', () => {});
  child.diagnostic = () => log;
  children.push(child);
  return child;
};
const stop = async (child) => {
  if (child?.bundleDirectory) {
    await run('docker', ['exec', dockerNode, 'docker', 'compose', '-f', `${child.bundleDirectory}/compose.yaml`, 'stop', child.service]);
    return;
  }
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((done) => child.once('exit', done)),
    new Promise((done) => setTimeout(() => { child.kill('SIGKILL'); done(); }, 2000)),
  ]);
};

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'honeyforge-fe2-'));
  for (const component of ['control', 'agent', 'decoy']) {
    execFileSync('go', ['build', '-o', join(dir, component), `./cmd/${component}`], { cwd: root });
  }
  const env = { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL,
    PUBLIC_ORIGIN: 'http://127.0.0.1:5173', COOKIE_SECURE: 'false', LISTEN_ADDR: '127.0.0.1:8081' };
  for (const role of ['operator', 'viewer']) {
    execFileSync(join(dir, 'control'), ['-create-user'], {
      env: { ...env, HF_USERNAME: `${username}_${role}`, HF_PASSWORD: password, HF_ROLE: role },
      stdio: 'pipe',
    });
  }
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'ca.pem'), '-subj', '/CN=localhost',
    '-addext', `subjectAltName=IP:127.0.0.1,IP:${agentHost}`], { stdio: 'pipe' });
  tlsServer = https.createServer({ key: readFileSync(join(dir, 'key.pem')), cert: readFileSync(join(dir, 'ca.pem')) }, (req, res) => {
    const upstream = http.request({ hostname: '127.0.0.1', port: 8081, path: req.url, method: req.method, headers: req.headers }, (response) => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { res.writeHead(503); res.end(); });
    req.pipe(upstream);
  });
  await new Promise((done) => tlsServer.listen(0, dockerNode ? '0.0.0.0' : '127.0.0.1', done));
  center = launch(join(dir, 'control'), [], { ...env,
    AGENT_ORIGIN: `https://${agentHost}:${tlsServer.address().port}`,
    HF_SOURCE_REVISION: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  });
  await waitFor(async () => (await fetch('http://127.0.0.1:8081/readyz')).ok);
});

test.afterAll(async () => {
  for (const { forward, sockets } of visitorForwards) {
    for (const socket of sockets) socket.destroy();
    await new Promise((done) => forward.close(done));
  }
  for (const bundleDirectory of dockerBundles) {
    await run('docker', ['exec', dockerNode, 'sh', '-c', 'set -e; if [ -f "$1/compose.yaml" ]; then docker compose -f "$1/compose.yaml" down -v --remove-orphans; fi; rm -rf "$1"', 'cleanup', bundleDirectory]);
  }
  await Promise.all(children.map(stop));
  if (tlsServer) { tlsServer.closeAllConnections(); await new Promise((done) => tlsServer.close(done)); }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function login(page, role = 'operator') {
  await page.goto('/#traps');
  await page.getByLabel('Имя пользователя (Логин)', { exact: true }).fill(`${username}_${role}`);
  await page.getByLabel('Пароль доступа', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти в консоль' }).click();
  await expect(page.getByRole('heading', { name: 'Парк ловушек' })).toBeVisible();
  await expect(page.getByText('Live WS', { exact: true })).toBeVisible();
}
async function headers(page) {
  const cookies = await page.context().cookies();
  return { Origin: 'http://127.0.0.1:5173', 'X-CSRF-Token': cookies.find((cookie) => cookie.name === 'csrf_token').value };
}
async function profile(page, level) {
  const port = await freePort();
  const config = {
    template_id: `${level}-http`, level,
    services: [{ id: 'web', name: 'Архив', protocol: 'http', port, banner: 'Документы организации' }],
    visible_texts: { title: 'Корпоративный архив', login_prompt: 'Вход в архив', success: 'Добро пожаловать', failure: 'Неверные данные' },
    synthetic_credentials: level === 'medium' ? [{ username: 'reader', password: 'synthetic-only' }] : [],
    fake_fs: [{ path: 'reports/summary.txt', content: 'Synthetic report from applied profile' }],
    logging: { categories: ['http.request', 'connection.opened', 'auth.attempt', 'session.started', 'file.listed', 'file.read', 'file.downloaded', 'session.ended', 'command.received'] },
    channel: { tls_required: true, heartbeat_seconds: 5, sync_seconds: 2 },
  };
  const response = await page.request.post('/api/v1/profiles', { headers: await headers(page), data: { name: `E2E ${level} ${username}`, config } });
  expect(response.ok()).toBeTruthy();
  const result = await response.json();
  return { ...result.profile, config };
}
async function createTrap(page, selected, name) {
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await page.getByRole('button', { name: 'Создать экземпляр' }).click();
  const dialog = page.getByRole('dialog', { name: 'Новый экземпляр' });
  await dialog.getByLabel('Профиль', { exact: true }).selectOption(selected.id);
  await dialog.getByRole('button', { name: 'Далее' }).click();
  await dialog.getByLabel('Имя экземпляра').fill(name);
  await dialog.getByLabel('Узел запуска', { exact: true }).fill(dockerNode || 'local-e2e-node');
  const response = page.waitForResponse((res) => res.url().endsWith('/api/v1/traps') && res.request().method() === 'POST');
  await dialog.getByRole('button', { name: 'Создать и назначить профиль' }).click();
  const trap = await (await response).json();
  await expect(dialog.getByRole('button', { name: 'Выдать одноразовый токен' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Выдать одноразовый токен' }).click();
  await expect(dialog.locator('code')).toBeVisible();
  const token = await dialog.locator('code').innerText();
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(token);
  await dialog.getByRole('button', { name: 'Комплект запуска' }).click();
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Скачать ZIP-комплект' }).click();
  const artifact = await download;
  const config = JSON.parse(execFileSync('python3', ['-c', 'import sys,zipfile; print(zipfile.ZipFile(sys.argv[1]).read("decoy-config.json").decode())', await artifact.path()], { encoding: 'utf8' }));
  expect(config.trap_id).toBe(trap.id);
  expect(config.profile_id).toBe(selected.id);
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
  const artifactPath = join(dir, `${trap.id}.zip`);
  await artifact.saveAs(artifactPath);
  expect((await getTrap(page, trap.id)).deployment_node).toBe(dockerNode || 'local-e2e-node');
  return { trap, token, config, artifactPath };
}
async function startRuntime({ trap, token, config, artifactPath }) {
  if (dockerNode) {
    const bundleDirectory = `/root/hf-bundle-${trap.id}`;
    dockerBundles.push(bundleDirectory);
    const tokenPath = join(dir, `${trap.id}.enrollment`);
    writeFileSync(tokenPath, token, { mode: 0o600 });
    await run('docker', ['exec', dockerNode, 'mkdir', '-m', '700', '-p', bundleDirectory]);
    await run('docker', ['cp', artifactPath, `${dockerNode}:${bundleDirectory}/bundle.zip`]);
    await run('docker', ['cp', tokenPath, `${dockerNode}:${bundleDirectory}/enrollment-input`]);
    await run('docker', ['cp', join(dir, 'ca.pem'), `${dockerNode}:${bundleDirectory}/trusted-center-ca.pem`]);
    await run('docker', ['exec', dockerNode, 'unzip', '-q', `${bundleDirectory}/bundle.zip`, '-d', bundleDirectory]);
    await run('docker', ['exec', dockerNode, `${bundleDirectory}/install.sh`,
      '--ca-file', `${bundleDirectory}/trusted-center-ca.pem`, '--enrollment-token-file', `${bundleDirectory}/enrollment-input`,
      '--build-ca-file', '/etc/ssl/certs/ca-certificates.crt']);
    return { agent: { bundleDirectory, service: 'agent' }, decoy: { bundleDirectory, service: 'decoy' } };
  }
  const runtimeDir = join(dir, trap.id);
  // All files remain under the disposable temporary directory.
  const { mkdirSync } = await import('node:fs');
  mkdirSync(runtimeDir, { mode: 0o700 });
  const files = { 'config.json': JSON.stringify(config), enrollment: token, intake: 'test-intake-secret', admin: 'test-admin-secret' };
  for (const [name, value] of Object.entries(files)) writeFileSync(join(runtimeDir, name), value, { mode: 0o600 });
  const ipcPort = await freePort(), adminPort = await freePort();
  const decoy = launch(join(dir, 'decoy'), ['-config', join(runtimeDir, 'config.json'), '-admin-listen', `127.0.0.1:${adminPort}`,
    '-admin-token-file', join(runtimeDir, 'admin'), '-agent-url', `http://127.0.0.1:${ipcPort}`, '-agent-token-file', join(runtimeDir, 'intake')]);
  const agent = launch(join(dir, 'agent'), ['-center', `https://127.0.0.1:${tlsServer.address().port}`, '-ca-file', join(dir, 'ca.pem'),
    '-trap', trap.id, '-enrollment-token-file', join(runtimeDir, 'enrollment'), '-state', join(runtimeDir, 'state.json'), '-queue', join(runtimeDir, 'events.sqlite'),
    '-ipc-listen', `127.0.0.1:${ipcPort}`, '-ipc-token-file', join(runtimeDir, 'intake'), '-decoy-admin', `http://127.0.0.1:${adminPort}`, '-decoy-token-file', join(runtimeDir, 'admin')]);
  try {
    await waitFor(async () => (await fetch(`http://127.0.0.1:${config.config.services[0].port}/`, { redirect: 'manual' })).status < 500);
  } catch {
    throw new Error(`Runtime failed: decoy=${decoy.diagnostic()} agent=${agent.diagnostic()}`);
  }
  return { agent, decoy };
}
const getTrap = async (page, id) => (await page.request.get(`/api/v1/traps/${id}`)).json();

test('real Low/Medium creation, bundles, agents, applied revision, stopped and offline', async ({ page, browser }) => {
  if (dockerNode) test.setTimeout(900000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  const low = await profile(page, 'low'), medium = await profile(page, 'medium');
  const one = await createTrap(page, low, `Low one ${username}`);
  const two = await createTrap(page, medium, `Medium ${username}`);
  const three = await createTrap(page, low, `Low two ${username}`);
  expect(three.trap.id).not.toBe(one.trap.id);
  const rejected = await page.request.post('http://127.0.0.1:8081/agent/v1/enroll', { data: { trap_id: two.trap.id, token: 'invalid-enrollment-token-for-browser-check' } });
  expect(rejected.status()).toBe(401);
  await page.goto(`/#traps/${two.trap.id}`);
  await expect(page.getByRole('region', { name: 'Карточка ловушки' })).toContainText('Отказ регистрации');
  await expect(page.getByRole('region', { name: 'История регистрации' })).toContainText('Неверный токен');
  await page.reload();
  await expect(page.getByRole('region', { name: 'История регистрации' })).toContainText('Неверный токен');
  const lowRuntime = await startRuntime(one), mediumRuntime = await startRuntime(two);
  await expect.poll(async () => (await getTrap(page, two.trap.id)).agent_status).toBe('online');
  await page.goto(`/#traps/${two.trap.id}`);
  const card = page.getByRole('region', { name: 'Карточка ловушки' });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Применить профиль' }).click();
  await expect.poll(async () => (await getTrap(page, two.trap.id)).applied_revision).toBe(1);
  await expect(card).toContainText('Сервис работает');
  const visitor = await browser.newContext();
  const visit = await visitor.newPage();
  const publicURL = await visitorURL(medium.config.services[0].port);
  await visit.goto(publicURL);
  await visit.getByLabel('Имя пользователя').fill('reader');
  await visit.getByLabel('Пароль', { exact: true }).fill('synthetic-only');
  await visit.getByRole('button', { name: 'Войти' }).click();
  await visit.getByRole('link', { name: 'reports/summary.txt', exact: true }).click();
  await expect(visit.locator('pre')).toContainText('Synthetic report from applied profile');
  await visit.getByRole('link', { name: 'Консоль', exact: true }).click();
  await visit.getByLabel('Команда').fill('cat reports/summary.txt');
  await visit.getByRole('button', { name: 'Выполнить' }).click();
  await expect(visit.locator('pre')).toContainText('Synthetic report from applied profile');
  await visit.getByRole('button', { name: 'Выйти' }).click();
  await visitor.close();
  await expect.poll(async () => (await (await page.request.get(`/api/v1/events?trap_id=${two.trap.id}`)).json()).items.some((event) => event.event_type === 'command.received')).toBe(true);
  await card.getByRole('button', { name: 'Остановить', exact: true }).click();
  await expect.poll(async () => (await getTrap(page, two.trap.id)).service_status).toBe('stopped');
  expect((await getTrap(page, two.trap.id)).agent_status).toBe('online');
  await expect(card).toContainText('Сервис остановлен');
  expect((await fetch(await visitorURL(low.config.services[0].port))).status).toBe(200);
  await page.reload();
  await expect(card).toContainText('Сервис остановлен');
  await stop(mediumRuntime.agent);
  await expect.poll(async () => (await getTrap(page, two.trap.id)).agent_status, { timeout: 35000 }).toBe('offline');
  await expect(card).toContainText('Агент offline');
  await page.goto(`/#events?trap_id=${two.trap.id}`);
  await expect(page.getByRole('table')).toBeVisible();
  expect(errors).toEqual([]);
  await stop(lowRuntime.agent);
});

test('viewer has read-only UI and direct API denies enrollment and bundle', async ({ page }) => {
  await login(page, 'viewer');
  await expect(page.getByRole('button', { name: 'Создать экземпляр' })).toHaveCount(0);
  const traps = await (await page.request.get('/api/v1/traps')).json();
  const trap = traps.items.find((item) => item.desired_profile_id);
  await page.goto(`/#traps/${trap.id}`);
  await expect(page.getByRole('region', { name: 'Карточка ловушки' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Комплект запуска' })).toHaveCount(0);
  expect((await page.request.get(`/api/v1/traps/${trap.id}/bundle`)).status()).toBe(403);
  expect((await page.request.post(`/api/v1/traps/${trap.id}/enrollment-token`, { headers: await headers(page) })).status()).toBe(403);
  expect((await page.request.post('/api/v1/traps', { headers: await headers(page), data: { name: 'Forbidden', deployment_bindings: [] } })).status()).toBe(403);
});

test('assignment retry reuses the trap; bundle errors and token expiry stay visible', async ({ page }) => {
  await login(page);
  const selected = await profile(page, 'low');
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  let creates = 0;
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().endsWith('/api/v1/traps')) creates++; });
  await page.route('**/api/v1/traps/*/profile', async (route) => {
    await route.fulfill({ status: 503, json: { error: { code: 'not_ready', message: 'Временный отказ назначения' } } });
    await page.unroute('**/api/v1/traps/*/profile');
  });
  await page.getByRole('button', { name: 'Создать экземпляр' }).click();
  const dialog = page.getByRole('dialog', { name: 'Новый экземпляр' });
  await dialog.getByLabel('Профиль', { exact: true }).selectOption(selected.id);
  await dialog.getByRole('button', { name: 'Далее' }).click();
  await dialog.getByLabel('Имя экземпляра').fill(`Retry ${username}`);
  await dialog.getByRole('button', { name: 'Создать и назначить профиль' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Временный отказ назначения');
  await dialog.getByRole('button', { name: 'Повторить назначение профиля' }).click();
  await expect(dialog.getByRole('button', { name: 'Выдать одноразовый токен' })).toBeVisible();
  expect(creates).toBe(1);
  await page.route('**/enrollment-token', async (route) => {
    const result = await route.fetch();
    const body = await result.json();
    await route.fulfill({ response: result, json: { ...body, expires_in_seconds: 1 } });
  });
  await dialog.getByRole('button', { name: 'Выдать одноразовый токен' }).click();
  await expect(dialog.locator('code')).toBeVisible();
  await expect(dialog.locator('code')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Комплект запуска' }).click();
  await page.route('**/bundle', (route) => route.fulfill({ status: 503, json: { error: { code: 'bundle_unavailable', message: 'Комплект временно недоступен' } } }));
  await dialog.getByRole('button', { name: 'Скачать ZIP-комплект' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Комплект временно недоступен');
});
