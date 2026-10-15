// Real secure center + downloaded bundles. Requires prebuilt agent/decoy images,
// npm ci --prefix web, Python 3, and a disposable running secure center.
// Credentials and generated bundles stay in the ignored deploy/secrets folder.
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ws as WebSocket } from '../web/node_modules/playwright-core/lib/utilsBundle.js';

const root = resolve(import.meta.dirname, '..');
const origin = process.env.HF_OPERATOR_URL || 'https://localhost:18443';
const ca = readFileSync(process.env.HF_CA_FILE || join(root, 'deploy/secrets/ca.pem'));
const credentials = JSON.parse(readFileSync(process.env.HF_OPERATOR_CREDENTIALS_FILE || join(root, 'deploy/secrets/operator.json')));
const python = process.env.HF_PYTHON || (process.platform === 'win32' ? 'py' : 'python3');
const docker = process.env.HF_DOCKER || 'docker';
const runID = `${Date.now()}`;
const artifacts = join(root, 'deploy/secrets', `stack-${runID}`);
mkdirSync(artifacts, { mode: 0o700 });
const report = [];
const pass = (message) => { report.push(message); console.log(`PASS: ${message}`); };
const run = (binary, args) => new Promise((done, reject) => {
  const child = spawn(binary, args, { cwd: root, windowsHide: true });
  let output = '';
  child.stdout.on('data', d => { output = (output + d).slice(-8000); });
  child.stderr.on('data', d => { output = (output + d).slice(-8000); });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? done(output.trim()) : reject(new Error(`${binary} ${args[0]} failed (${code}): ${output}`)));
});
const center = (...args) => run(docker, ['compose', '--env-file', 'deploy/.env', '-f', 'deploy/compose.yaml', ...args]);
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function wait(probe, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await probe()) return; } catch { /* service recovering */ }
    await sleep(500);
  }
  throw new Error('Timed out waiting for live state');
}
let cookies = '', csrf = '';
function request(url, method = 'GET', data, headers = {}) {
  const target = new URL(url);
  const body = data === undefined ? undefined : typeof data === 'string' ? data : JSON.stringify(data);
  return new Promise((done, reject) => {
    const req = (target.protocol === 'https:' ? https : http).request(target, {
      method, ca, headers: { ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...headers },
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(15000, () => req.destroy(new Error('HTTP timeout')));
    req.on('error', reject);
    req.end(body);
  });
}
async function api(path, method = 'GET', data) {
  const result = await request(origin + path, method, data, { Cookie: cookies, Origin: origin, 'X-CSRF-Token': csrf });
  assert.ok(result.status >= 200 && result.status < 300, `${method} ${path}: HTTP ${result.status} ${result.body.toString().slice(0, 500)}`);
  return JSON.parse(result.body);
}
const events = async (trap, type = '') => (await api(`/api/v1/events?trap_id=${trap}&limit=100${type ? `&event_type=${type}` : ''}`)).items;
const notices = [];
let socket;
async function connectWS() {
  socket = new WebSocket(origin.replace('https:', 'wss:') + '/api/v1/ws', { ca, origin, headers: { Cookie: cookies } });
  socket.on('message', data => notices.push(JSON.parse(data.toString())));
  await new Promise((done, reject) => { socket.once('open', done); socket.once('error', reject); });
}
const deployments = [];
let nginxStopped = false;
let completed = false;
try {
  const login = await request(origin + '/api/v1/auth/login', 'POST', credentials, { Origin: origin });
  assert.equal(login.status, 200);
  cookies = login.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
  csrf = decodeURIComponent(cookies.match(/csrf_token=([^;]+)/)[1]);
  await connectWS();
  pass('operator login and authorized WebSocket through real TLS Nginx');
  for (const [index, level] of ['low', 'medium'].entries()) {
    const config = {
      template_id: `${level}-http`, level,
      services: [{ id: 'web', name: 'Archive', protocol: 'http', port: 8080, banner: 'Synthetic archive' }],
      visible_texts: { title: `Acceptance ${level}`, login_prompt: 'Sign in', success: 'Welcome', failure: 'Denied' },
      synthetic_credentials: level === 'medium' ? [{ username: 'reader', password: 'synthetic-only' }] : [],
      fake_fs: [{ path: 'reports/summary.txt', content: 'Synthetic acceptance report' }],
      logging: { categories: ['http.request', 'auth.attempt', 'session.started', 'session.ended', 'file.listed', 'file.read', 'file.downloaded', 'command.received'] },
      channel: { tls_required: true, heartbeat_seconds: 5, sync_seconds: 2 },
    };
    const { profile } = await api('/api/v1/profiles', 'POST', { name: `BE04 ${level} ${runID}`, config });
    const port = Number(process.env.HF_VISITOR_BASE_PORT || 28080) + index;
    const trap = await api('/api/v1/traps', 'POST', { name: `BE04 ${level} ${runID}`, deployment_node: 'Docker Desktop Linux acceptance', deployment_bindings: [{ service_id: 'web', host_port: port, bind_address: '127.0.0.1' }] });
    await api(`/api/v1/traps/${trap.id}/profile`, 'PUT', { profile_id: profile.id, revision: 1 });
    const enrollment = await api(`/api/v1/traps/${trap.id}/enrollment-token`, 'POST', {});
    const bundle = await request(`${origin}/api/v1/traps/${trap.id}/bundle`, 'GET', undefined, { Cookie: cookies });
    assert.equal(bundle.status, 200);
    const dir = join(artifacts, level);
    mkdirSync(dir, { mode: 0o700 });
    const archive = join(dir, 'bundle.zip');
    writeFileSync(archive, bundle.body, { mode: 0o600 });
    await run(python, ['-c', 'import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', archive, dir]);
    const secrets = join(dir, 'secrets');
    mkdirSync(secrets, { mode: 0o700 });
    writeFileSync(join(secrets, 'enrollment_token'), enrollment.token, { mode: 0o600 });
    writeFileSync(join(secrets, 'center_ca.pem'), ca);
    for (const name of ['decoy_agent_ipc_token', 'agent_decoy_ipc_token']) writeFileSync(join(secrets, name), randomBytes(32).toString('hex'), { mode: 0o600 });
    const override = join(dir, 'local-images.json');
    writeFileSync(override, JSON.stringify({ services: { agent: { image: 'honeyforge-agent:be04' }, decoy: { image: 'honeyforge-decoy:be04' }, visitor: { image: 'honeyforge-decoy:be04' } } }));
    const args = ['compose', '-p', `be04-${level}-${runID}`, '-f', join(dir, 'compose.yaml'), '-f', override];
    const deployment = { level, trap, profile, port, dir, args };
    deployments.push(deployment);
    await run(docker, [...args, 'up', '-d', '--no-build', '--wait']);
    await wait(async () => (await api(`/api/v1/traps/${trap.id}`)).agent_status === 'online');
    await api(`/api/v1/traps/${trap.id}/commands`, 'POST', { type: 'apply_profile', expected_profile_id: profile.id, expected_revision: 1, ttl_seconds: 120 });
    await wait(async () => (await api(`/api/v1/traps/${trap.id}`)).applied_revision === 1);
    const visit = await request(`http://127.0.0.1:${port}/`);
    assert.ok(visit.status < 400);
    await wait(async () => (await events(trap.id, 'http.request')).length > 0);
    pass(`${level}: downloaded bundle Compose, real TLS enrollment, IPC apply and persisted visitor event`);
  }
  const [low, medium] = deployments;
  const mediumURL = `http://127.0.0.1:${medium.port}`;
  const visitorLogin = await request(mediumURL + '/login', 'POST', 'username=reader&password=synthetic-only', { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.equal(visitorLogin.status, 303);
  const visitorCookie = visitorLogin.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
  assert.equal((await request(mediumURL + '/files', 'GET', undefined, { Cookie: visitorCookie })).status, 200);
  assert.equal((await request(mediumURL + '/console', 'POST', 'command=ls', { Cookie: visitorCookie, 'Content-Type': 'application/x-www-form-urlencoded' })).status, 200);
  await wait(async () => (await events(medium.trap.id, 'command.received')).length > 0);
  const session = (await events(medium.trap.id, 'command.received'))[0].session_id;
  assert.ok(session);
  const timeline = await api(`/api/v1/sessions/${session}/timeline?limit=100`);
  assert.ok(JSON.stringify(timeline).includes('command.received'));
  pass('Medium login, fake-FS, pseudo-command and persisted session timeline');
  assert.ok(notices.length > 0);
  pass('WebSocket receives live committed changes');
  socket.close();
  await sleep(1000);
  const before = await events(low.trap.id, 'http.request');
  await center('stop', 'nginx'); nginxStopped = true;
  for (let i = 0; i < 4; i++) assert.ok((await request(`http://127.0.0.1:${low.port}/offline-${i}`)).status < 500);
  await run(docker, [...low.args, 'restart', 'agent']);
  await sleep(2000);
  await center('up', '-d', '--wait', 'nginx'); nginxStopped = false;
  await connectWS();
  await wait(async () => (await events(low.trap.id, 'http.request')).length === before.length + 4);
  await sleep(3000);
  const replayed = await events(low.trap.id, 'http.request');
  assert.equal(replayed.length, before.length + 4);
  assert.equal(new Set(replayed.map(e => `${e.agent_id}/${e.event_id}`)).size, replayed.length);
  pass('management outage + agent restart: four queued HTTP events replayed exactly once; WS reconnect and REST reconciliation');
  await run(docker, [...medium.args, 'stop', 'decoy']);
  assert.ok((await request(`http://127.0.0.1:${low.port}/`)).status < 400);
  await wait(async () => (await api(`/api/v1/traps/${medium.trap.id}`)).service_status === 'error');
  assert.equal((await api(`/api/v1/traps/${medium.trap.id}`)).agent_status, 'online');
  await run(docker, [...medium.args, 'up', '-d', '--no-build', '--wait']);
  pass('stopping Medium reports service error, leaves its agent online and Low serving requests');
  const saved = await events(medium.trap.id);
  socket.close();
  await center('restart', 'postgres', 'control', 'web', 'nginx');
  await wait(async () => (await api('/api/v1/auth/me')).id);
  const restored = await events(medium.trap.id);
  for (const e of saved) assert.ok(restored.some(v => v.event_id === e.event_id && v.agent_id === e.agent_id));
  await connectWS();
  pass('center/PostgreSQL restart preserves operator session and all saved Medium event identities; WS reconnects');
  writeFileSync(join(artifacts, 'result.json'), JSON.stringify({ runID, origin, report, deployments: deployments.map(({ level, trap, profile, port, args }) => ({ level, trap_id: trap.id, profile_id: profile.id, port, compose_args: args })) }, null, 2));
  console.log(`Evidence: ${artifacts}`);
  console.log('Local prebuilt images used; this test does not claim running install.sh on a separate Linux host.');
  completed = true;
} finally {
  socket?.terminate();
  if (nginxStopped) await center('up', '-d', '--wait', 'nginx');
  if (!completed) {
    writeFileSync(join(artifacts, 'partial-result.json'), JSON.stringify({ runID, report }, null, 2));
    for (const deployment of deployments) await run(docker, [...deployment.args, 'down']);
  }
}
