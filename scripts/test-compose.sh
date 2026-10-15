#!/usr/bin/env bash
# Clean local Compose acceptance. All resources belong to this unique project.
set -euo pipefail
cd "$(dirname "$0")/.."
qa_dir="$(mktemp -d)"
qa_project="hf-qa-${RANDOM}-$$"
qa_port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
qa_pg_port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
qa_password="$(openssl rand -hex 16)"
cat > "$qa_dir/env" <<EOF
POSTGRES_PASSWORD=$qa_password
POSTGRES_PORT=$qa_pg_port
CONTROL_PORT=$qa_port
GEOIP_DATA_DIR=$qa_dir/geoip
EOF
mkdir "$qa_dir/geoip"
qa_compose=(docker compose -p "$qa_project" --env-file "$qa_dir/env" -f compose.yaml)
# Session-specific public CA stays in a BuildKit secret, never in an image layer.
if [[ -n "${CODEX_PROXY_CERT:-}" ]]; then
  cat > "$qa_dir/build.yaml" <<EOF
services:
  control:
    build:
      secrets: [proxy_ca]
secrets:
  proxy_ca:
    file: $CODEX_PROXY_CERT
EOF
  qa_compose+=(-f "$qa_dir/build.yaml")
fi
cleanup() {
  "${qa_compose[@]}" logs --no-color >> qa-compose.log 2>&1 || true
  "${qa_compose[@]}" down -v --remove-orphans >> qa-compose.log 2>&1 || true
  rm -rf "$qa_dir"
}
trap cleanup EXIT
: > qa-compose.log
"${qa_compose[@]}" config -q
"${qa_compose[@]}" up -d --build >> qa-compose.log 2>&1
curl --fail --silent --show-error --retry 30 --retry-delay 2 --retry-connrefused --retry-all-errors "http://127.0.0.1:$qa_port/readyz"
export HF_USERNAME=qa-compose-operator
export HF_PASSWORD="$qa_password"
"${qa_compose[@]}" exec -T -e HF_USERNAME -e HF_PASSWORD -e HF_ROLE=operator control honeyforge-control -create-user >> qa-compose.log 2>&1
python3 tests/integration/compose-history.py seed "http://127.0.0.1:$qa_port" "$qa_dir/history.json" | tee -a qa-compose.log
"${qa_compose[@]}" stop postgres >> qa-compose.log 2>&1
python3 tests/integration/compose-history.py outage "http://127.0.0.1:$qa_port" "$qa_dir/history.json" | tee -a qa-compose.log
"${qa_compose[@]}" up -d --wait postgres >> qa-compose.log 2>&1
"${qa_compose[@]}" restart control >> qa-compose.log 2>&1
curl --fail --silent --show-error --retry 30 --retry-delay 2 --retry-connrefused --retry-all-errors "http://127.0.0.1:$qa_port/readyz"
python3 tests/integration/compose-history.py verify "http://127.0.0.1:$qa_port" "$qa_dir/history.json" | tee -a qa-compose.log

echo 'PASS: fresh Compose, migrations, readiness and PostgreSQL volume after restart' | tee -a qa-compose.log
