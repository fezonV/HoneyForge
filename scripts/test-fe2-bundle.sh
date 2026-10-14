#!/bin/sh
set -eu

# Disposable prepared Linux node with its own Docker Engine, not the host socket.
: "${TEST_DATABASE_URL:?Set TEST_DATABASE_URL to a disposable PostgreSQL database}"
cd "$(dirname "$0")/.."
command -v docker >/dev/null
command -v npm >/dev/null
command -v go >/dev/null
docker info >/dev/null
node_name="hf-fe2-bundle-node-$$"
cleanup() { docker rm -f -v "$node_name" >/dev/null 2>&1 || true; }
trap cleanup EXIT HUP INT TERM

docker run -d --privileged --name "$node_name" \
  docker:28-dind dockerd --storage-driver=vfs --host=unix:///var/run/docker.sock >/dev/null
attempt=0
until docker exec "$node_name" docker info >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 60 ] || { docker logs "$node_name"; exit 1; }
  sleep 1
done
# Public trust bundle, supplied only to this temporary host. Never added to images.
ca_bundle="${HF_TEST_PROXY_CA_FILE:-/etc/ssl/certs/ca-certificates.crt}"
docker cp "$ca_bundle" "$node_name:/etc/ssl/certs/ca-certificates.crt"
HF_BUNDLE_DOCKER_NODE="$node_name" npm --prefix web run test:e2e -- --grep 'real Low'
