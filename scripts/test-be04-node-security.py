"""Inspect and probe a disposable Linux Docker node from test-be04-stack.mjs.

Requires HF_STACK_RESULT pointing to its private result.json. Changes firewall
only inside that named test node; never uses the host Docker socket in a mount.
"""
import http.cookiejar
import io
import json
import os
from pathlib import Path
import ssl
import struct
import subprocess
import time
import urllib.request
import zipfile

root = Path(__file__).resolve().parent.parent
result = json.loads(Path(os.environ['HF_STACK_RESULT']).read_text())
node = result['bundle_node']
assert node, 'A separate Docker node is required'
origin = result['origin']
artifact = Path(os.environ['HF_STACK_RESULT']).parent / ('security-' + str(int(time.time())))
artifact.mkdir(mode=0o700, exist_ok=False)
report = []


def run(*args, check=True, timeout=120):
    command = [os.environ.get('HF_DOCKER', 'docker'), *args]
    proc = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    if check and proc.returncode:
        raise RuntimeError(f'Docker {args[0]} failed ({proc.returncode}): {proc.stderr[-3000:]}')
    return proc


def nested(*args, **kwargs):
    return run('exec', node, 'docker', *args, **kwargs)


def mark(message):
    report.append(message)
    print('PASS: ' + message, flush=True)


def inspect(container):
    return json.loads(nested('inspect', container).stdout)[0]


jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
    urllib.request.HTTPCookieProcessor(jar),
    urllib.request.HTTPSHandler(context=ssl.create_default_context(
        cafile=str(root / 'deploy/secrets/ca.pem'))))
credentials = json.loads((root / 'deploy/secrets/operator.json').read_text())
opener.open(urllib.request.Request(origin + '/api/v1/auth/login',
    data=json.dumps(credentials).encode(), headers={'Content-Type': 'application/json', 'Origin': origin})).read()
low = next(item for item in result['deployments'] if item['level'] == 'low')
remote = low['remote_directory']
rules = remote + '/restrict-egress.sh'
helper = zipfile.ZipFile(io.BytesIO(opener.open(
    origin + '/api/v1/traps/' + low['trap_id'] + '/bundle').read())).read('restrict-egress.sh')
assert b'@@HOST@@' not in helper and b'@@PORT@@' not in helper
(artifact / 'restrict-egress.sh').write_bytes(helper)
run('cp', str(artifact / 'restrict-egress.sh'), node + ':' + rules)

def compose(deployment, *args):
    return nested(*deployment['compose_args'], *args)


containers = {}
for deployment in result['deployments']:
    roles = {}
    for role in ['agent', 'decoy', 'visitor']:
        container = compose(deployment, 'ps', '-q', role).stdout.strip()
        assert container, f'Missing {role}'
        data = inspect(container)
        roles[role] = data
        assert nested('exec', container, 'id', '-u').stdout.strip() != '0'
        config = data['HostConfig']
        assert config['ReadonlyRootfs'] and config['Memory'] > 0 and config['PidsLimit'] > 0 and config['NanoCpus'] > 0
        assert config['PidMode'] == '' and config['IpcMode'] == 'private'
        assert 'ALL' in config['CapDrop'] and any('no-new-privileges' in item for item in config['SecurityOpt'])
        assert not config['Privileged']
        assert not any('docker.sock' in mount['Source'] or mount['Destination'].endswith('/ca.key') for mount in data['Mounts'])
        for mount in data['Mounts']:
            if mount['Destination'].startswith('/run/secrets/'):
                assert not mount['RW']
        if role != 'visitor':
            assert not any(data['NetworkSettings']['Ports'].values()), f'{role} publishes a port'
    agent_sources = {m['Source'] for m in roles['agent']['Mounts'] if m['Destination'] == '/var/lib/honeyforge'}
    for role in ['decoy', 'visitor']:
        assert not any(m['Source'] in agent_sources for m in roles[role]['Mounts'])
        allowed = {'/run/secrets/decoy_agent_ipc_token', '/run/secrets/agent_decoy_ipc_token'} if role == 'decoy' else set()
        assert all(m['Destination'] in allowed for m in roles[role]['Mounts'] if m['Destination'].startswith('/run/secrets/'))
    for network in roles['decoy']['NetworkSettings']['Networks']:
        network_config = json.loads(nested('network', 'inspect', network).stdout)[0]
        assert network_config['Internal'], 'Decoy has an external network'
    for path in ['agent-state.json', 'agent-events.sqlite']:
        assert nested('exec', roles['agent']['Id'], 'stat', '-c', '%a', '/var/lib/honeyforge/' + path).stdout.strip() == '600'
    containers[deployment['level']] = roles
    assert run('exec', node, 'stat', '-c', '%a', deployment['remote_directory'] + '/secrets').stdout.strip() == '700'
mark('Low/Medium non-root, read-only, bounded resources, dropped capabilities, isolated secrets/state and private 0600 agent files')

for role in ['control', 'web', 'nginx']:
    center_container = json.loads(run('inspect', 'honeyforge-secure-' + role + '-1').stdout)[0]
    assert center_container['HostConfig']['ReadonlyRootfs']
    assert not any('docker.sock' in m['Source'] or m['Destination'].endswith('/ca.key') for m in center_container['Mounts'])
    if role != 'nginx':
        assert not any(center_container['NetworkSettings']['Ports'].values())
    if role == 'web':
        assert set(center_container['NetworkSettings']['Networks']) == {'honeyforge-secure_frontend'}
mark('Secure center mounts exclude CA private key and Docker socket; raw control/web ports stay unpublished; web joins only frontend')

agent = containers['low']['agent']['Id']
management = next((name for name in containers['low']['agent']['NetworkSettings']['Networks'] if name.endswith('_management')))
network = json.loads(nested('network', 'inspect', management).stdout)[0]
gateway = network['IPAM']['Config'][0]['Gateway']
manifest = json.loads((Path(os.environ['HF_STACK_RESULT']).parent / 'low/manifest.json').read_text())
from urllib.parse import urlsplit
endpoint = urlsplit(manifest['agent_origin'])

ipc_address = next(value['IPAddress'] for name, value in
                   containers['low']['agent']['NetworkSettings']['Networks'].items()
                   if name.endswith('_ipc'))


def connect(address, port, source=None):
    bind = ['-s', source] if source else []
    return nested('exec', agent, 'nc', '-z', '-w', '2', *bind, address, str(port), check=False).returncode == 0

completed = False
try:
    run('exec', node, 'sh', rules, 'remove')
    nested('run', '-d', '--name', 'be04-forbidden-target', '-p', '29999:8080',
        'python:3.12-alpine', 'python', '-m', 'http.server', '8080', '--bind', '0.0.0.0')
    run('exec', node, 'sh', '-c', 'python3 -m http.server 29998 --bind 0.0.0.0 >/root/be04-input-probe.log 2>&1 & echo $! >/root/be04-input-probe.pid')
    for _ in range(10):
        if connect(gateway, 29999) and connect(gateway, 29998):
            break
        time.sleep(1)
    assert connect(gateway, 29999), 'Forbidden forwarding fixture was not reachable before policy'
    assert connect(gateway, 29998), 'Forbidden host-input fixture was not reachable before policy'
    assert connect(endpoint.hostname, endpoint.port or 443), 'Center positive control failed'
    run('exec', node, 'sh', rules)
    def policy_rules():
        # iptables-save includes changing generation timestamps and counters.
        # Compare actual ordered rules, retaining duplicates if present.
        return [line for line in run('exec', node, 'iptables-save').stdout.splitlines()
                if line.startswith('-A ') and 'HFBE04_' in line]
    first = policy_rules()
    run('exec', node, 'sh', rules)
    assert first == policy_rules(), 'Repeat application duplicated firewall rules'
    assert not connect(gateway, 29999), 'Forbidden forwarded destination is reachable'
    assert not connect(gateway, 29998), 'Forbidden host-input destination is reachable'
    assert not connect(gateway, 29999, ipc_address), 'IPC-bound socket bypasses forwarded egress policy'
    assert not connect(gateway, 29998, ipc_address), 'IPC-bound socket bypasses host-input policy'
    assert connect(endpoint.hostname, endpoint.port or 443), 'Center blocked by policy'
    mark('IPv4 allowlist denies previously reachable FORWARD and host INPUT fixtures; center TCP remains allowed; repeated apply is idempotent')
    run('exec', node, 'sh', rules, 'remove')
    run('exec', node, 'sh', rules, 'remove')
    assert connect(gateway, 29999) and connect(gateway, 29998), 'Policy removal did not restore original reachability'
    run('exec', node, 'sh', rules)
    mark('Policy removal is idempotent and restores only this bundle policy; policy reapplied afterward')
    # Capture only this node's lab TLS management traffic; retain it privately.
    capture = run('exec', node, 'timeout', '15', 'tcpdump', '-i', 'eth0', '-U', '-nn', '-s', '0', '-c', '16',
        '-w', '/root/be04-tls.pcap', 'tcp', 'port', str(endpoint.port or 443), check=False, timeout=25)
    assert capture.returncode in (0, 124), capture.stderr
    run('cp', node + ':/root/be04-tls.pcap', str(artifact / 'management.pcap'))
    raw = (artifact / 'management.pcap').read_bytes()
    assert not any(marker in raw for marker in [b'Authorization: Bearer', b'POST /agent/v1', b'"events":', b'synthetic-only'])
    order = '<' if raw[:4] in (b'\xd4\xc3\xb2\xa1', b'\x4d\x3c\xb2\xa1') else '>'
    assert struct.unpack_from(order + 'I', raw, 20)[0] == 1, 'Expected Ethernet pcap'
    offset = 24
    encrypted = 0
    while offset + 16 <= len(raw):
        size = struct.unpack_from(order + 'I', raw, offset + 8)[0]
        frame = raw[offset + 16:offset + 16 + size]
        offset += 16 + size
        if len(frame) < 54 or frame[12:14] != b'\x08\x00' or frame[23] != 6:
            continue
        tcp = 14 + (frame[14] & 15) * 4
        payload = frame[tcp + ((frame[tcp + 12] >> 4) * 4):]
        if len(payload) > 5 and payload[0] == 23 and payload[1:3] == b'\x03\x03':
            encrypted += 1
    assert encrypted > 0, 'No encrypted TLS application records captured'
    mark(f'Captured {encrypted} TLS application records; no HTTP/Bearer/event JSON plaintext in private lab pcap')
    latest = json.loads(opener.open(origin + '/api/v1/traps/' + low['trap_id']).read())
    assert latest['agent_status'] == 'online' and latest['applied_revision'] == 1
    assert latest['service_status'] == 'running', 'IPC/status failed after allowlist'
    mark('Agent remains online with IPC-confirmed revision and running decoy after allowlist')
    (artifact / 'result.json').write_text(json.dumps({'report': report, 'node': node, 'source_run': result['runID']}, indent=2))
    completed = True
finally:
    if not completed:
        run('exec', node, 'sh', rules, 'remove', check=False)
    nested('rm', '-f', '-v', 'be04-forbidden-target', check=False)
    run('exec', node, 'sh', '-c', 'if [ -f /root/be04-input-probe.pid ]; then kill "$(cat /root/be04-input-probe.pid)"; rm /root/be04-input-probe.pid; fi', check=False)
