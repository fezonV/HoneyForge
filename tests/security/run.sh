#!/usr/bin/env bash
# Local Docker segment checks. This does not certify a remote VM/firewall.
set -euo pipefail
cd "$(dirname "$0")/../.."
qa_dir="$(mktemp -d)"
qa_project="hf-sec-${RANDOM}-$$"
qa_ports="$(python3 - <<'PY'
import socket
sockets=[socket.socket(),socket.socket()]
for s in sockets: s.bind(('127.0.0.1',0))
print(*(s.getsockname()[1] for s in sockets))
PY
)"
read -r qa_operator_port qa_agent_port <<< "$qa_ports"
qa_password="$(openssl rand -hex 16)"
qa_token="$(openssl rand -hex 24)"
printf '%s' "$qa_password" > "$qa_dir/postgres_password"
printf 'postgres://honeyforge:%s@postgres:5432/honeyforge?sslmode=disable' "$qa_password" > "$qa_dir/database_url"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout "$qa_dir/tls.key" -out "$qa_dir/tls.crt" -subj /CN=localhost -addext subjectAltName=IP:127.0.0.1 > /dev/null 2>&1
# File-secret mounts use the nginx UID 101; parent temporary directory stays 0700.
chmod 444 "$qa_dir/tls.key" "$qa_dir/tls.crt" "$qa_dir/postgres_password" "$qa_dir/database_url"
cat > "$qa_dir/env" <<EOF
PUBLIC_HOST=127.0.0.1
MANAGEMENT_PORT=$qa_operator_port
AGENT_PORT=$qa_agent_port
POSTGRES_PASSWORD_FILE=$qa_dir/postgres_password
CONTROL_DATABASE_URL_FILE=$qa_dir/database_url
TLS_CERT_FILE=$qa_dir/tls.crt
TLS_KEY_FILE=$qa_dir/tls.key
GEOIP_DATA_DIR=$qa_dir/geoip
EOF
cat > "$qa_dir/overlay.yaml" <<'EOF'
services:
  control:
    environment:
      NO_PROXY: 127.0.0.1,localhost,postgres,control,nginx
      no_proxy: 127.0.0.1,localhost,postgres,control,nginx
  attack-client:
    image: python:3.12-alpine
    command: [python, -c, 'import time; time.sleep(600)']
    user: '65534:65534'
    read_only: true
    cap_drop: [ALL]
    networks: [attack]
  attack-target:
    image: python:3.12-alpine
    command: [python, -m, http.server, '8080']
    user: '65534:65534'
    read_only: true
    cap_drop: [ALL]
    networks: [attack]
EOF
mkdir "$qa_dir/geoip"
qa_compose=(docker compose -p "$qa_project" --env-file "$qa_dir/env" -f deploy/compose.yaml -f "$qa_dir/overlay.yaml")
if [[ -n "${CODEX_PROXY_CERT:-}" ]]; then
 cat > "$qa_dir/ca.yaml" <<EOF
services:
  control:
    build:
      secrets: [proxy_ca]
secrets:
  proxy_ca:
    file: $CODEX_PROXY_CERT
EOF
 qa_compose+=(-f "$qa_dir/ca.yaml")
fi
cleanup() {
 "${qa_compose[@]}" logs --no-color >> qa-security.log 2>&1 || true
 "${qa_compose[@]}" down -v --remove-orphans >> qa-security.log 2>&1 || true
 rm -rf "$qa_dir"
}
trap cleanup EXIT
: > qa-security.log
if ! "${qa_compose[@]}" up -d --build --wait --wait-timeout 120 >> qa-security.log 2>&1; then
 for qa_id in $("${qa_compose[@]}" ps -q); do
  docker inspect "$qa_id" --format '{{json .State.Health}}' >> qa-security.log
 done
 exit 1
fi
qa_failures=0
record() { echo "$*" | tee -a qa-security.log; }
# Only public safe response bodies are retained. No private payloads/cookies/keys.
qa_status="$(curl --silent --show-error --cacert "$qa_dir/tls.crt" -o "$qa_dir/facade" -w '%{http_code}' "https://127.0.0.1:$qa_agent_port/agent/v1/traps/11111111-1111-4111-8111-111111111111/config")"
if [[ "$qa_status" == 404 ]] && ! rg -qi 'agent|token|request_id|unauthorized' "$qa_dir/facade"; then
 record 'PASS MASK-2 anonymous agent facade'
else
 record "FAIL MASK-2 anonymous agent facade: HTTP $qa_status; backend error is publicly distinguishable (see #4 / PR #36)"
 qa_failures=$((qa_failures+1))
fi
qa_hash="$(printf '%s' "$qa_token" | openssl dgst -sha256 -r | cut -d ' ' -f1)"
"${qa_compose[@]}" exec -T postgres psql -U honeyforge -d honeyforge -v ON_ERROR_STOP=1 >/dev/null <<EOF
INSERT INTO traps(id,name,deployment_bindings) VALUES('11111111-1111-4111-8111-111111111111','segment-probe','[]');
INSERT INTO agents(id,trap_id,token_hash) VALUES('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111',decode('$qa_hash','hex'));
EOF
printf 'header = "Authorization: Bearer %s"\n' "$qa_token" > "$qa_dir/curl-auth"
qa_status="$(curl --silent --show-error --cacert "$qa_dir/tls.crt" --config "$qa_dir/curl-auth" -H 'Content-Type: application/json' -d '{"service_state":"running"}' -o /dev/null -w '%{http_code}' "https://127.0.0.1:$qa_agent_port/agent/v1/traps/11111111-1111-4111-8111-111111111111/heartbeat")"
[[ "$qa_status" == 200 ]] || { record "FAIL authorized agent heartbeat: HTTP $qa_status"; exit 1; }
record 'PASS authorized agent heartbeat through real TLS nginx/control/PostgreSQL'
if curl --silent --show-error -o /dev/null "https://127.0.0.1:$qa_agent_port/" 2>/dev/null; then record 'FAIL untrusted TLS accepted'; exit 1; fi
record 'PASS untrusted TLS refused'
"${qa_compose[@]}" exec -T attack-client python -c 'import socket; socket.create_connection(("attack-target",8080),2).close()' 
record 'PASS attack-segment positive control'
for qa_service in postgres control nginx; do
 qa_id="$("${qa_compose[@]}" ps -q "$qa_service")"
 read -ra qa_ips <<< "$(docker inspect "$qa_id" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}')"
 case "$qa_service" in postgres) qa_check_ports='5432';; control) qa_check_ports='8081';; nginx) qa_check_ports='8443 9443';; esac
 for qa_ip in "${qa_ips[@]}"; do
  for qa_port in $qa_check_ports; do
   if "${qa_compose[@]}" exec -T attack-client python -c 'import socket,sys; socket.create_connection((sys.argv[1],int(sys.argv[2])),2).close()' "$qa_ip" "$qa_port" 2>/dev/null; then
    record "FAIL attack-client reached $qa_service:$qa_port"; qa_failures=$((qa_failures+1))
   else record "PASS attack-client cannot reach $qa_service:$qa_port"; fi
  done
 done
done
record 'LIMIT: local Docker bridges only; remote host/VM firewall, packet capture and bundle mounts require separate evidence; no production destinations contacted'
[[ "$qa_failures" == 0 ]]
