import { test, expect } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { randomUUID } from 'node:crypto';

// Deliberately requires a separate disposable database. No API or agent mocks.
if (!process.env.TEST_DATABASE_URL) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database; live acceptance cannot be skipped');
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
let database, schema;
const children = [];
const binaryPath = (component) => join(dir, `${component}${process.platform === 'win32' ? '.exe' : ''}`);

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
  database = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await database.connect();
  schema = `qa_live_${process.pid}_${Date.now()}`;
  await database.query(`CREATE SCHEMA "${schema}"`);
  const isolatedDSN = new URL(process.env.TEST_DATABASE_URL);
  isolatedDSN.searchParams.set('search_path', schema);
  for (const component of ['control', 'agent', 'decoy']) {
    execFileSync('go', ['build', '-o', binaryPath(component), `./cmd/${component}`], { cwd: root });
  }
  const env = { ...process.env, DATABASE_URL: isolatedDSN.toString(),
    PUBLIC_ORIGIN: 'http://127.0.0.1:5173', COOKIE_SECURE: 'false', LISTEN_ADDR: '127.0.0.1:8081' };
  for (const role of ['operator', 'viewer']) {
    execFileSync(binaryPath('control'), ['-create-user'], {
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
  center = launch(binaryPath('control'), [], { ...env,
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
  if (database) {
    try { if (schema) await database.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await database.end(); }
  }
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
  const config = JSON.parse(execFileSync(process.env.HF_TEST_PYTHON || 'python3', ['-X', 'utf8', '-c', 'import sys,zipfile; print(zipfile.ZipFile(sys.argv[1]).read("decoy-config.json").decode())', await artifact.path()], { encoding: 'utf8' }));
  expect(config.trap_id).toBe(trap.id);
  expect(config.profile_id).toBe(selected.id);
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click();
  const artifactPath = join(dir, `${trap.id}.zip`);
  await artifact.saveAs(artifactPath);
  expect((await getTrap(page, trap.id)).deployment_node).toBe(dockerNode || 'local-e2e-node');
  return { trap, token, config, artifactPath };
}
async function startRuntime({ trap, token, config, artifactPath, bindAddress = '127.0.0.1' }) {
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
    // The visitor gateway must not give the decoy an outbound management route.
    await run('docker', ['exec', dockerNode, 'docker', 'compose', '-f', `${bundleDirectory}/compose.yaml`,
      'exec', '-T', 'decoy', 'sh', '-c', 'if nc -z -w 2 "$1" "$2"; then exit 1; fi',
      'isolation-check', agentHost, String(tlsServer.address().port)]);
    return { agent: { bundleDirectory, service: 'agent' }, decoy: { bundleDirectory, service: 'decoy' } };
  }
  const runtimeDir = join(dir, trap.id);
  // All files remain under the disposable temporary directory.
  const { mkdirSync } = await import('node:fs');
  mkdirSync(runtimeDir, { mode: 0o700 });
  const files = { 'config.json': JSON.stringify(config), enrollment: token, intake: 'test-intake-secret', admin: 'test-admin-secret' };
  for (const [name, value] of Object.entries(files)) writeFileSync(join(runtimeDir, name), value, { mode: 0o600 });
  const ipcPort = await freePort(), adminPort = await freePort();
  const decoy = launch(binaryPath('decoy'), ['-config', join(runtimeDir, 'config.json'), '-bind', bindAddress, '-admin-listen', `127.0.0.1:${adminPort}`,
    '-admin-token-file', join(runtimeDir, 'admin'), '-agent-url', `http://127.0.0.1:${ipcPort}`, '-agent-token-file', join(runtimeDir, 'intake')]);
  const agent = launch(binaryPath('agent'), ['-center', `https://127.0.0.1:${tlsServer.address().port}`, '-ca-file', join(dir, 'ca.pem'),
    '-trap', trap.id, '-enrollment-token-file', join(runtimeDir, 'enrollment'), '-state', join(runtimeDir, 'state.json'), '-queue', join(runtimeDir, 'events.sqlite'),
    '-ipc-listen', `127.0.0.1:${ipcPort}`, '-ipc-token-file', join(runtimeDir, 'intake'), '-decoy-admin', `http://127.0.0.1:${adminPort}`, '-decoy-token-file', join(runtimeDir, 'admin')]);
  try {
    await waitFor(async () => (await fetch(`http://${bindAddress}:${config.config.services[0].port}/`, { redirect: 'manual' })).status < 500);
  } catch {
    throw new Error(`Runtime failed: decoy=${decoy.diagnostic()} agent=${agent.diagnostic()}`);
  }
  return { agent, decoy };
}
const getTrap = async (page, id) => (await page.request.get(`/api/v1/traps/${id}`)).json();

test('real Low/Medium creation, bundles, agents, applied revision, stopped and offline', async ({ page, browser }) => {
  test.setTimeout(180000);
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
  const controls = page.getByRole('region', { name: 'Управление экземпляром' });
  await expect(card).toBeVisible();
  await controls.getByRole('button', { name: 'Применить профиль', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить применить профиль' }).click();
  try {
    await expect.poll(async () => (await getTrap(page, two.trap.id)).applied_revision).toBe(1);
  } catch (error) {
    const commands = await (await page.request.get(`/api/v1/traps/${two.trap.id}/commands`)).json();
    throw new Error(`${error.message}; commands=${JSON.stringify(commands)}; agent=${mediumRuntime.agent.diagnostic?.()}; decoy=${mediumRuntime.decoy.diagnostic?.()}`);
  }
  await expect(card).toContainText('Сервис работает');
  const journal = await page.context().newPage();
  await journal.goto(`/#events?trap_id=${two.trap.id}`);
  await expect(journal.getByRole('heading', { name: 'Журнал событий атак' })).toBeVisible();
  const visitor = await browser.newContext();
  const visit = await visitor.newPage();
  const publicURL = await visitorURL(medium.config.services[0].port);
  await visit.goto(publicURL);
  await visit.getByLabel('Имя пользователя').fill('reader');
  await visit.getByLabel('Пароль', { exact: true }).fill('synthetic-only');
  await visit.getByRole('button', { name: 'Войти' }).click();
  await visit.getByRole('link', { name: 'reports/summary.txt', exact: true }).click();
  await expect(visit.locator('pre')).toContainText('Synthetic report from applied profile');
  await expect(visit.locator('.file-meta')).toHaveText(`TXT · ${Buffer.byteLength(medium.config.fake_fs[0].content)} Б`);
  await expect(visit.getByRole('link', { name: 'К списку файлов', exact: true })).toHaveAttribute('href', '/files');
  await visit.getByRole('link', { name: 'Консоль', exact: true }).click();
  await visit.getByLabel('Команда').fill('cat reports/summary.txt');
  await visit.getByRole('button', { name: 'Выполнить' }).click();
  await expect(visit.locator('pre')).toContainText('Synthetic report from applied profile');
  await visit.getByRole('button', { name: 'Выйти' }).click();
  await visitor.close();
  await expect.poll(async () => {
    const items = (await (await page.request.get(`/api/v1/events?trap_id=${two.trap.id}`)).json()).items;
    return items.some((event) => event.event_type === 'command.received') && items.some((event) => event.event_type === 'session.ended');
  }).toBe(true);
  // The real decoy's telemetry must reach the already-open UI through WS + REST.
  await expect(journal.getByRole('table').getByText('command.received', { exact: true })).toBeVisible({ timeout: 15000 });
  const realEvents = (await (await page.request.get(`/api/v1/events?trap_id=${two.trap.id}`)).json()).items;
  const commandEvent = realEvents.find((event) => event.event_type === 'command.received');
  await journal.getByRole('button', { name: `Открыть событие ${commandEvent.event_id}`, exact: true }).click();
  const eventDetails = journal.getByRole('dialog', { name: 'Детали события' });
  await expect(eventDetails).toContainText(two.trap.id);
  await expect(eventDetails).toContainText('Историческая revision');
  await expect(eventDetails.locator('pre')).toHaveCount(0);
  await eventDetails.getByRole('button', { name: 'Открыть timeline сессии' }).click();
  const timeline = journal.getByRole('dialog', { name: 'Timeline сессии' });
  await expect(timeline.getByText('auth.attempt', { exact: true })).toBeVisible();
  await expect(timeline.getByText('file.read', { exact: true })).toBeVisible();
  await expect(timeline.getByText('command.received', { exact: true })).toBeVisible();
  const sessionEvents = realEvents.filter((event) => event.session_id === commandEvent.session_id);
  const rows = timeline.locator('tbody tr');
  await expect(rows).toHaveCount(sessionEvents.length);
  expect(await rows.allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining(two.trap.id)]));
  await timeline.getByRole('button', { name: 'Закрыть диалоговое окно', exact: true }).click();
  await journal.goto(`/#events?trap_id=${one.trap.id}`);
  await fetch(await visitorURL(low.config.services[0].port));
  await expect(journal.getByRole('table').getByText('http.request', { exact: true }).first()).toBeVisible({ timeout: 15000 });
  for (const row of await journal.locator('tbody tr').allTextContents()) {
    expect(row).toContain(one.trap.id);
    expect(row).not.toContain(two.trap.id);
  }
  await journal.close();
  if (dockerNode) {
    const events = (await (await page.request.get(`/api/v1/events?trap_id=${two.trap.id}`)).json()).items;
    // PostgreSQL inet serialization can include the host mask (/32 or /128).
    expect(events.filter((event) => event.event_type === 'command.received').every((event) => event.source_ip?.split('/')[0] === agentHost)).toBe(true);
  }
  await controls.getByRole('button', { name: 'Ротация фиктивных credentials' }).click();
  const rotation = page.getByRole('dialog', { name: 'Новая версия с фиктивными credentials' });
  await rotation.getByLabel('Фиктивный пароль 1').fill('synthetic-rotated-only');
  await rotation.getByRole('button', { name: 'Создать новую revision' }).click();
  await expect(controls).toContainText('Создана v2');
  expect((await getTrap(page, two.trap.id)).desired_revision).toBe(1);
  await controls.getByRole('button', { name: 'Назначить выбранную версию' }).click();
  await page.getByRole('button', { name: 'Подтвердить назначение' }).click();
  await expect.poll(async () => (await getTrap(page, two.trap.id)).desired_revision).toBe(2);
  expect((await getTrap(page, two.trap.id)).applied_revision).toBe(1);
  await controls.getByRole('button', { name: 'Применить профиль', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить применить профиль' }).click();
  await expect.poll(async () => (await getTrap(page, two.trap.id)).applied_revision).toBe(2);
  const rotatedVisitor = await browser.newContext();
  const rotatedPage = await rotatedVisitor.newPage();
  await rotatedPage.goto(publicURL);
  await rotatedPage.getByLabel('Имя пользователя').fill('reader');
  await rotatedPage.getByLabel('Пароль', { exact: true }).fill('synthetic-only');
  await rotatedPage.getByRole('button', { name: 'Войти' }).click();
  await expect(rotatedPage.getByLabel('Пароль', { exact: true })).toBeVisible();
  await rotatedPage.getByLabel('Имя пользователя').fill('reader');
  await rotatedPage.getByLabel('Пароль', { exact: true }).fill('synthetic-rotated-only');
  await rotatedPage.getByRole('button', { name: 'Войти' }).click();
  await expect(rotatedPage.getByRole('link', { name: 'reports/summary.txt', exact: true })).toBeVisible();
  await rotatedVisitor.close();
  expect((await getTrap(page, one.trap.id)).desired_revision).toBe(1);
  await controls.getByRole('button', { name: 'Остановить', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить остановить' }).click();
  await expect.poll(async () => (await getTrap(page, two.trap.id)).service_status).toBe('stopped');
  expect((await getTrap(page, two.trap.id)).agent_status).toBe('online');
  await expect(card).toContainText('Сервис остановлен');
  expect((await fetch(await visitorURL(low.config.services[0].port))).status).toBe(200);
  await controls.getByRole('button', { name: 'Запустить', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить запустить' }).click();
  await expect.poll(async () => (await getTrap(page, two.trap.id)).service_status).toBe('running');
  await expect(card).toContainText('Сервис работает');
  expect((await fetch(publicURL)).status).toBe(200);
  expect((await getTrap(page, one.trap.id)).agent_status).toBe('online');
  await controls.getByRole('button', { name: 'Остановить', exact: true }).click();
  await page.getByRole('button', { name: 'Подтвердить остановить' }).click();
  await expect.poll(async () => (await getTrap(page, two.trap.id)).service_status).toBe('stopped');
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

test('FE2-03/FE2-04 PostgreSQL history, dashboard, actual audit and full server CSV', async ({ page, browser }, testInfo) => {
  await login(page);
  const selected = await profile(page, 'medium');
  const created = await page.request.post('/api/v1/traps', { headers: await headers(page), data: { name: 'Historical query fixture', deployment_bindings: [{ service_id: 'web', host_port: selected.config.services[0].port }] } });
  expect(created.ok()).toBeTruthy();
  const trap = await created.json(), agentId = randomUUID(), sessionId = randomUUID();
  // Stored historical fixtures exercise the real query path; live visitor telemetry is tested above.
  await database.query(`INSERT INTO "${schema}".agents(id,trap_id,token_hash) VALUES($1,$2,$3)`, [agentId, trap.id, Buffer.from(randomUUID())]);
  await database.query(`INSERT INTO "${schema}".visitor_sessions(id,trap_id,started_at) VALUES($1,$2,'2026-01-01T00:00:00Z')`, [sessionId, trap.id]);
  await database.query(`INSERT INTO "${schema}".events(id,trap_id,agent_id,service_id,session_id,profile_id,applied_revision,event_type,occurred_at,source_ip,source_port,destination_port,protocol,payload,source_asn_org)
    SELECT gen_random_uuid(),$2::uuid,$3::uuid,'web',$1::uuid,$4::uuid,1,'file.read', '2026-01-01T00:00:00Z'::timestamptz + i * interval '1 second','198.51.100.82'::inet,42100,18080,'http',
    '{"password":"historical-sensitive-only","path":"<script>window.pwned=1</script>"}'::jsonb,'=1+1' FROM generate_series(0,129) AS i`, [sessionId, trap.id, agentId, selected.id]);
  const query = new URLSearchParams({ trap_id: trap.id, from: '2026-01-01T00:00:00Z', to: '2026-01-01T00:03:00Z', source_ip: '198.51.100.82', event_type: 'file.read', session_id: sessionId });
  await page.goto(`/#events?${query}`);
  await expect(page.locator('tbody tr')).toHaveCount(50);
  await page.getByRole('button', { name: 'Более ранние события' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(50);
  await page.getByRole('button', { name: 'Более ранние события' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(30);
  await page.reload();
  await expect(page.locator('tbody tr')).toHaveCount(30);
  await page.screenshot({ path: testInfo.outputPath('events-postgres.png'), fullPage: true });
  const detailButton = page.locator('tbody tr').first().getByRole('button');
  const eventId = (await detailButton.getAttribute('aria-label')).replace('Открыть событие ', '');
  const endpoint = `/api/v1/traps/${trap.id}/events/${eventId}`;
  const metadata = await (await page.request.get(endpoint)).text();
  expect(metadata).not.toContain('historical-sensitive-only');
  await detailButton.click();
  const detail = page.getByRole('dialog', { name: 'Детали события' });
  await expect(detail.locator('pre')).toHaveCount(0);
  await detail.getByRole('button', { name: 'Запросить payload с аудитом' }).click();
  await expect(detail.locator('pre')).toContainText('historical-sensitive-only');
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
  const audit = await database.query(`SELECT count(*) FROM "${schema}".audit_log WHERE action='event.sensitive_read' AND entity_id=$1`, [`${trap.id}/${eventId}`]);
  expect(Number(audit.rows[0].count)).toBe(1);
  const viewer = await browser.newContext();
  const readOnly = await viewer.newPage();
  await login(readOnly, 'viewer');
  await readOnly.goto(`/#events?${query}&event_id=${eventId}&event_trap=${trap.id}`);
  await expect(readOnly.getByRole('dialog', { name: 'Детали события' })).toBeVisible();
  await expect(readOnly.getByRole('button', { name: 'Запросить payload с аудитом' })).toHaveCount(0);
  expect((await readOnly.request.get(`${endpoint}/sensitive`)).status()).toBe(403);
  expect(await (await readOnly.request.get(endpoint)).text()).not.toContain('historical-sensitive-only');
  expect((await readOnly.request.get('/api/v1/audit')).status()).toBe(403);
  expect((await readOnly.request.get(`/api/v1/events/export.csv?${query}`)).status()).toBe(403);
  await readOnly.goto('/#audit');
  await expect(readOnly.getByRole('alert').filter({ hasText: 'Аудит доступен только оператору' })).toBeVisible();
  await viewer.close();

  // Dashboard must agree with the full PostgreSQL selection, not the loaded page.
  const from = query.get('from'), to = query.get('to');
  const summary = await (await page.request.get(`/api/v1/events/summary?from=${from}&to=${to}`)).json();
  expect(summary.total_events).toBe(130);
  await page.goto(`/#overview?${new URLSearchParams({ from, to })}`);
  await expect(page.getByRole('link', { name: 'Все события периода: 130' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'События за период' })).toContainText('Уникальных IP: 1');
  await expect(page.getByRole('region', { name: 'Динамика событий' })).toContainText('Предыдущий период: 0');
  await page.screenshot({ path: testInfo.outputPath('dashboard-postgres.png'), fullPage: true });
  await page.getByRole('link', { name: 'Все события периода: 130' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(50);
  const csvDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать CSV выборки' }).click();
  const csv = readFileSync(await (await csvDownload).path(), 'utf8');
  expect(csv.trim().split('\n')).toHaveLength(131);
  expect(csv).not.toContain('historical-sensitive-only');
  expect(csv).not.toContain('<script>');
  expect(csv).toContain("'=1+1");

  // Real profile revision/assignment/command API writes produce real audit rows.
  const patch = await page.request.patch(`/api/v1/profiles/${selected.id}`, { headers: await headers(page), data: { base_revision: 1, name: 'FE2-04 revised profile', config: selected.config } });
  expect(patch.ok()).toBeTruthy();
  expect((await page.request.put(`/api/v1/traps/${trap.id}/profile`, { headers: await headers(page), data: { profile_id: selected.id, revision: 2 } })).ok()).toBeTruthy();
  const queued = await page.request.post(`/api/v1/traps/${trap.id}/commands`, { headers: await headers(page), data: { type: 'stop', expected_profile_id: selected.id, expected_revision: 2, ttl_seconds: 1 } });
  expect(queued.ok()).toBeTruthy();
  const command = await queued.json();
  await expect.poll(async () => (await (await page.request.get(`/api/v1/traps/${trap.id}/commands`)).json()).items.find((item) => item.id === command.id)?.status).toBe('expired');
  const actor = await (await page.request.get('/api/v1/auth/me')).json();
  await page.goto(`/#audit?actor_id=${actor.id}&action=profile.revision_created`);
  await expect(page.getByRole('table')).toContainText(selected.id);
  await page.getByRole('link', { name: `profile: ${selected.id}` }).click();
  await expect(page.getByRole('dialog', { name: 'Профиль: FE2-04 revised profile (rev 2)' })).toBeVisible();
  await page.goto(`/#audit?actor_id=${actor.id}&action=trap.profile_assigned`);
  await expect(page.getByRole('table')).toContainText(trap.id);
  await page.goto(`/#audit?actor_id=${actor.id}&action=command.queued`);
  const commandRow = page.getByRole('row').filter({ hasText: command.id });
  await expect(commandRow).toContainText('queued — поставлена в очередь');
  await commandRow.getByRole('button', { name: 'Проверить результат команды' }).click();
  await expect(commandRow).toContainText('Текущее состояние: expired');
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

// FE1-01/02/03 acceptance: actual form -> API -> PostgreSQL, with no API mocks.
async function wizardProfile(page, name, level = 'medium') {
  await page.goto('/#profiles');
  await page.getByRole('button', { name: 'Конструктор профиля (Мастер)' }).click();
  const wizard = page.getByRole('dialog', { name: 'Конструктор профиля поведения (Profile Wizard)' });
  await wizard.getByPlaceholder('например: Корпоративный веб-архив Ubuntu 24.04 (Low HTTP)').fill(name);
  if (level === 'medium') await wizard.getByRole('heading', { name: 'Medium HTTP — Служебный портал архива' }).click();
  await wizard.getByRole('button', { name: 'Далее', exact: true }).click();
  await wizard.locator('input[type="number"]').first().fill(String(await freePort()));
  await wizard.getByRole('button', { name: 'Далее', exact: true }).click();
  await wizard.getByRole('button', { name: 'Далее', exact: true }).click();
  await expect(wizard.getByRole('checkbox', { name: 'TLS обязателен' })).toBeDisabled();
  await wizard.locator('input[type="number"]').nth(0).fill('5');
  await wizard.locator('input[type="number"]').nth(1).fill('2');
  await wizard.getByRole('button', { name: 'Далее', exact: true }).click();
  const response = page.waitForResponse((res) => res.url().endsWith('/api/v1/profiles') && res.request().method() === 'POST');
  await wizard.getByRole('button', { name: 'Сохранить профиль', exact: true }).click();
  const result = await (await response).json();
  expect(result.profile?.id).toBeTruthy();
  await wizard.getByRole('button', { name: 'Вернуться к каталогу' }).click();
  return { ...result.profile, config: result.revision.config };
}
const profileCard = (page, name) => page.getByRole('article', { name, exact: true });
async function editWizard(page, selected) {
  await page.goto('/#profiles');
  await profileCard(page, selected.name).getByTitle('Редактировать профиль (создать новую ревизию)').click();
  return page.getByRole('dialog', { name: /Редактирование профиля:/ });
}
async function finishWizard(wizard) {
  for (let i = 0; i < 4; i++) await wizard.getByRole('button', { name: 'Далее', exact: true }).click();
}

test('FE1 wizard creates Medium and copy/edit preserve credentials, files and independent instances', async ({ page }) => {
  test.setTimeout(180000);
  await login(page);
  const before = (await (await page.request.get('/api/v1/traps')).json()).items.length;
  const selected = await wizardProfile(page, `FE1 Medium ${username}`);
  expect((await (await page.request.get('/api/v1/traps')).json()).items).toHaveLength(before);
  expect(selected.config.fake_fs.every((file) => !file.path.startsWith('/'))).toBeTruthy();
  expect(selected.config.synthetic_credentials.every((item) => item.password === '')).toBeTruthy();
  await page.reload();
  const card = profileCard(page, selected.name);
  await card.getByTitle('Создать независимую копию профиля (v1)').click();
  const copyCard = profileCard(page, `${Array.from(selected.name).slice(0, 24).join('')} (копия)`);
  await expect(copyCard).toBeVisible();
  const items = (await (await page.request.get('/api/v1/profiles?limit=100')).json()).items;
  const copy = items.find((item) => item.name.endsWith('(копия)') && item.name.startsWith('FE1 Medium'));
  expect(copy.id).not.toBe(selected.id);
  expect(copy.current_revision).toBe(1);
  const copySecret = await (await page.request.get(`/api/v1/profiles/${copy.id}/revisions/1/sensitive`)).json();
  expect(copySecret.config.synthetic_credentials[0].password).toBe('AdminPassword2026!');
  // Create two actual processes using one profile, and change only A to v2.
  await page.goto('/#traps');
  const one = await createTrap(page, selected, 'FE1 A');
  const two = await createTrap(page, selected, 'FE1 B');
  const a = await startRuntime(one), b = await startRuntime({ ...two, bindAddress: '127.0.0.2' });
  const command = async (id, type, revision = 1) => {
    const response = await page.request.post(`/api/v1/traps/${id}/commands`, { headers: await headers(page), data: { type, ttl_seconds: 60, expected_profile_id: selected.id, expected_revision: revision } });
    expect(response.ok()).toBeTruthy();
    const created = await response.json();
    await expect.poll(async () => (await (await page.request.get(`/api/v1/traps/${id}/commands`)).json()).items.find((item) => item.id === created.id)?.status).toBe('applied');
  };
  await command(one.trap.id, 'apply_profile');
  await command(two.trap.id, 'apply_profile');
  const wizard = await editWizard(page, selected);
  await wizard.getByRole('button', { name: 'Далее', exact: true }).click();
  await wizard.getByRole('button', { name: 'Далее', exact: true }).click();
  await wizard.getByLabel('Содержимое файла 1').fill('Changed synthetic document in revision two');
  await wizard.getByRole('button', { name: 'Далее', exact: true }).click();
  await wizard.getByRole('button', { name: 'Далее', exact: true }).click();
  await wizard.getByRole('button', { name: 'Сохранить новую ревизию' }).click();
  await wizard.getByRole('button', { name: 'Вернуться к каталогу' }).click();
  const v2 = await (await page.request.get(`/api/v1/profiles/${selected.id}/revisions/2/sensitive`)).json();
  expect(v2.config.synthetic_credentials[0].password).toBe('AdminPassword2026!');
  const unchangedCopy = await (await page.request.get(`/api/v1/profiles/${copy.id}/revisions/1`)).json();
  expect(unchangedCopy.config.fake_fs[0].content).toBe(selected.config.fake_fs[0].content);
  expect((await getTrap(page, one.trap.id)).desired_revision).toBe(1);
  expect((await getTrap(page, two.trap.id)).desired_revision).toBe(1);
  await profileCard(page, selected.name).getByRole('button', { name: 'Предпросмотр', exact: true }).click();
  const details = page.getByRole('dialog', { name: `Профиль: ${selected.name} (rev 2)` });
  await details.getByRole('button', { name: /История версий/ }).click();
  await expect(details.getByRole('table', { name: 'Различия версий профиля' })).toContainText('Changed synthetic document in revision two');
  await details.getByRole('button', { name: 'Ревизия v1', exact: true }).click();
  await details.getByRole('button', { name: 'Создать экземпляр (v1)', exact: true }).click();
  const deploy = page.getByRole('dialog', { name: 'Новый экземпляр' });
  await expect(deploy.getByLabel('Версия', { exact: true })).toHaveValue('1');
  await deploy.getByRole('button', { name: 'Закрыть диалоговое окно' }).click();
  expect((await page.request.put(`/api/v1/traps/${one.trap.id}/profile`, { headers: await headers(page), data: { profile_id: selected.id, revision: 2 } })).ok()).toBeTruthy();
  await command(one.trap.id, 'apply_profile', 2);
  expect((await getTrap(page, one.trap.id)).applied_revision).toBe(2);
  expect((await getTrap(page, two.trap.id)).desired_revision).toBe(1);
  for (const [host, port, content] of [['127.0.0.1', one.config.config.services[0].port, 'Changed synthetic document in revision two'], ['127.0.0.2', two.config.config.services[0].port, 'Регламент доступа']]) {
    const visitor = await fetch(`http://${host}:${port}/login`, { method: 'POST', body: new URLSearchParams({ username: 'admin', password: 'AdminPassword2026!' }), redirect: 'manual' });
    expect(visitor.status).toBe(303);
    const cookie = visitor.headers.get('set-cookie').split(';')[0];
    const file = await fetch(`http://${host}:${port}/files?path=regulations/archive-rules.txt`, { headers: { Cookie: cookie } });
    expect(await file.text()).toContain(content);
  }
  await expect.poll(async () => (await (await page.request.get(`/api/v1/events?trap_id=${one.trap.id}`)).json()).items.some((event) => event.event_type === 'file.read' && event.applied_revision === 2)).toBeTruthy();
  const timeline = await page.evaluate(async (trapId) => {
    const { api } = await import('/src/api/client.ts');
    const events = await api.events.page({ trap_id: trapId, event_type: 'file.read' });
    const event = events.items.find((item) => item.session_id);
    const detail = await api.events.detail(trapId, event.event_id);
    const history = await api.events.timeline(event.session_id);
    const exported = await api.events.exportCsv({ trap_id: trapId });
    return { eventId: detail.event_id, count: history.items.length, csv: await exported.text() };
  }, one.trap.id);
  expect(timeline.eventId).toBeTruthy(); expect(timeline.count).toBeGreaterThan(1); expect(timeline.csv).toContain(one.trap.id);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('AdminPassword2026!');
  await stop(a.agent); await stop(a.decoy); await stop(b.agent); await stop(b.decoy);
});

test('FE1 concurrent editing keeps the draft and requires explicit rebase after real 409', async ({ page }) => {
  await login(page);
  const selected = await wizardProfile(page, `FE1 Conflict ${username}`, 'low');
  const wizard = await editWizard(page, selected);
  await wizard.getByPlaceholder('например: Корпоративный веб-архив Ubuntu 24.04 (Low HTTP)').fill('Local draft retained');
  await finishWizard(wizard);
  const update = await page.request.patch(`/api/v1/profiles/${selected.id}`, { headers: await headers(page), data: { name: 'Other editor version', description: '', base_revision: 1, config: selected.config } });
  expect(update.ok()).toBeTruthy();
  await wizard.getByRole('button', { name: 'Сохранить новую ревизию' }).click();
  const conflict = page.getByRole('dialog', { name: 'Конфликт одновременного редактирования (HTTP 409)' });
  await expect(conflict).toContainText('Ваш черновик не потерян');
  expect((await (await page.request.get(`/api/v1/profiles/${selected.id}`)).json()).profile.current_revision).toBe(2);
  await conflict.getByRole('button', { name: 'Вернуться к редактированию черновика' }).click();
  await wizard.getByRole('button', { name: 'Назад', exact: true }).click();
  await wizard.getByRole('button', { name: 'Назад', exact: true }).click();
  await wizard.getByRole('button', { name: 'Назад', exact: true }).click();
  await wizard.getByRole('button', { name: 'Назад', exact: true }).click();
  await expect(wizard.getByPlaceholder('например: Корпоративный веб-архив Ubuntu 24.04 (Low HTTP)')).toHaveValue('Local draft retained');
  await finishWizard(wizard);
  await wizard.getByRole('button', { name: 'Сохранить новую ревизию' }).click();
  await conflict.getByRole('button', { name: 'Перенести правки' }).click();
  await wizard.getByRole('button', { name: 'Вернуться к каталогу' }).click();
  const final = await (await page.request.get(`/api/v1/profiles/${selected.id}`)).json();
  expect(final.profile.name).toBe('Local draft retained');
  expect(final.profile.current_revision).toBe(3);
});

test('FE1 occupied profile deletion is blocked, free deletion retains revision history and viewer is read-only', async ({ page, browser }) => {
  await login(page);
  const selected = await wizardProfile(page, `FE1 Delete ${username}`, 'low');
  const created = await page.request.post('/api/v1/traps', { headers: await headers(page), data: { name: 'Deletion guard', deployment_bindings: [{ service_id: selected.config.services[0].id, host_port: await freePort() }] } });
  const trap = await created.json();
  expect((await page.request.put(`/api/v1/traps/${trap.id}/profile`, { headers: await headers(page), data: { profile_id: selected.id, revision: 1 } })).ok()).toBeTruthy();
  await page.reload();
  await profileCard(page, selected.name).getByTitle('Удалить профиль').click();
  await expect(page.getByRole('dialog', { name: 'Удаление профиля заблокировано' })).toContainText('Deletion guard');
  expect((await page.request.delete(`/api/v1/profiles/${selected.id}`, { headers: await headers(page) })).status()).toBe(409);
  await page.getByRole('dialog').getByRole('button', { name: 'Закрыть', exact: true }).click();
  expect((await page.request.delete(`/api/v1/traps/${trap.id}/profile`, { headers: await headers(page) })).ok()).toBeTruthy();
  await page.reload();
  await profileCard(page, selected.name).getByTitle('Удалить профиль').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Удалить профиль', exact: true }).click();
  await expect(profileCard(page, selected.name)).toHaveCount(0);
  expect((await page.request.get(`/api/v1/profiles/${selected.id}/revisions/1`)).ok()).toBeTruthy();
  const context = await browser.newContext();
  const viewer = await context.newPage();
  await login(viewer, 'viewer'); await viewer.goto('/#profiles');
  await expect(viewer.getByRole('button', { name: 'Конструктор профиля (Мастер)' })).toHaveCount(0);
  await expect(viewer.getByTitle('Редактировать профиль (создать новую ревизию)')).toHaveCount(0);
  await expect(viewer.getByTitle('Создать независимую копию профиля (v1)')).toHaveCount(0);
  expect((await viewer.request.get(`/api/v1/profiles/${selected.id}/revisions/1/sensitive`)).status()).toBe(403);
  expect((await viewer.request.post('/api/v1/profiles', { headers: await headers(viewer), data: { name: 'Forbidden', config: selected.config } })).status()).toBe(403);
  await context.close();
});
