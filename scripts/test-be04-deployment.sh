#!/bin/sh
# Run against an already provisioned secure center. Does not change user data.
set -eu
cd "$(dirname "$0")/.."
: "${HF_OPERATOR_URL:?Set the HTTPS operator origin}"
: "${HF_AGENT_URL:?Set the HTTPS agent origin}"
: "${HF_CA_FILE:?Set the trusted CA file}"
case "$HF_OPERATOR_URL $HF_AGENT_URL" in https://*' https://'*) ;; *) echo 'HTTPS origins required' >&2; exit 1;; esac
compose() { docker compose --env-file deploy/.env -f deploy/compose.yaml "$@"; }
compose config --quiet
compose ps
work=$(mktemp -d)
network="hf-be04-probe-$(date +%s)-$$"
cleanup() {
    docker network rm "$network" >/dev/null 2>&1 || true
    rm -rf "$work"
}
trap cleanup EXIT HUP INT TERM
probe() {
    origin=$1 path=$2 expected=$3
    code=$(curl --silent --show-error --cacert "$HF_CA_FILE" --max-time 15 \
        -o "$work/body" -w '%{http_code}' "${origin%/}$path")
    [ "$code" = "$expected" ] || { echo "$path: expected $expected, got $code" >&2; exit 1; }
}
probe "$HF_OPERATOR_URL" / 200
grep -q '<div id="root"' "$work/body"
probe "$HF_OPERATOR_URL" /profiles 200
probe "$HF_OPERATOR_URL" /api/v1/auth/me 401
probe "$HF_OPERATOR_URL" /agent/v1/enroll 404
for path in / /docs/ /openapi.yaml /api/v1/events /readyz /agent/v1/enroll; do
    probe "$HF_AGENT_URL" "$path" 404
    if grep -Eiq 'request_id|unauthorized|openapi|honeyforge' "$work/body"; then
        echo "Agent facade discloses service markers at $path" >&2; exit 1
    fi
done
code=$(curl --silent --show-error --cacert "$HF_CA_FILE" --max-time 15 \
    -H 'Authorization: Bearer invalid-probe-credential' -o "$work/body" \
    -w '%{http_code}' "${HF_AGENT_URL%/}/agent/v1/traps/00000000-0000-0000-0000-000000000000/config")
[ "$code" = 404 ] || { echo 'Invalid credentials exposed agent API' >&2; exit 1; }
grep -qi '<html' "$work/body"
# Wrong trust must fail before any HTTP response. Keep hostname verification on.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=untrusted-probe' \
    -keyout "$work/key" -out "$work/wrong-ca.pem" >/dev/null 2>&1
if curl --silent --cacert "$work/wrong-ca.pem" --max-time 10 "$HF_AGENT_URL" >/dev/null 2>&1; then
    echo 'Untrusted CA unexpectedly accepted' >&2; exit 1
fi
# A disposable attack-only namespace must not reach private center listeners.
# Pull before attaching to the internal network, which has no registry access.
docker pull alpine:3.22 >/dev/null
docker network create --internal "$network" >/dev/null
docker run --rm --network "$network" alpine:3.22 sh -c 'command -v nc' >/dev/null
for target in postgres:5432 control:8081 nginx:9443; do
    service=${target%:*} port=${target#*:}
    id=$(compose ps -q "$service")
    [ -n "$id" ] || { echo "$service is not running" >&2; exit 1; }
    ips=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "$id")
    [ -n "$ips" ] || exit 1
    for ip in $ips; do
        result=0
        docker run --rm --network "$network" alpine:3.22 nc -z -w 2 "$ip" "$port" || result=$?
        if [ "$result" = 0 ]; then
            echo "Attack namespace reached $service $ip:$port" >&2; exit 1
        fi
        [ "$result" = 1 ] || { echo "Probe failed to run (exit $result)" >&2; exit 1; }
    done
done
echo 'PASS: UI, unauthenticated facade, invalid credential, CA rejection, private network probes'
echo 'Still required: authenticated Low/Medium, queue replay, WS reconnect, restart and separate-host acceptance.'
