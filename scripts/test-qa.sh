#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${TEST_DATABASE_URL:?Set TEST_DATABASE_URL to a disposable PostgreSQL database}"
export HF_DECOY_PROCESS_TEST=1
qa_results="$(mktemp)"
trap 'rm -f "$qa_results"' EXIT
# No -short: crash/restart and the 60-second outage are acceptance gates.
mapfile -t qa_packages < <(go list ./... | python3 -c 'import sys; print("".join(p for p in sys.stdin if "/web/node_modules/" not in p), end="")' )
go test -json -race -count=1 -timeout=15m "${qa_packages[@]}" | tee "$qa_results"
python3 scripts/check-go-results.py "$qa_results"
go vet "${qa_packages[@]}"
go build "${qa_packages[@]}"
