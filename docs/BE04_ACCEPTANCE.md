# BE-04 continuation — 15 October 2026

Base: `b6e00b8` (`origin/dev` at start). Branch: `codex/be04-complete`.

Implemented: production web image and internal frontend network, SPA/static routing behind the operator TLS listener, agent HTML failure facade, private environment-file ignores, deployment probes and startup/recovery documentation. Existing API/WS/CSV/GeoIP implementations are retained.

## Actual checks on Windows

- `npm ci --prefix web --no-audit --no-fund`: passed. npm reported blocking esbuild's postinstall; the subsequent production build succeeded.
- `npm run build --prefix web`: passed (TypeScript and Vite, shared Low/Medium preview imports included).
- `npm run lint --prefix web`: 0 errors, 35 existing warnings.
- `go test -short ./...`: failed only at `TestQueueUsesPrivateFilesAndFullDurability`, whose Unix mode-bit assertion does not hold on Windows; PostgreSQL integration was skipped in that initial run.
- Started a new disposable PostgreSQL 17 cluster bound to `127.0.0.1:55439`, with test-created isolated schemas. With `TEST_DATABASE_URL` set, `go test -short ./... -skip TestQueueUsesPrivateFilesAndFullDurability -count=1`: passed, including control integration coverage. The excluded test and queue implementation were not changed.
- `go vet ./...`, `go build ./...`: passed.
- `go test -race ./internal/control`: unavailable because CGO is disabled and no C compiler is configured.
- `bash -n scripts/test-be04-deployment.sh`: passed using Git Bash.
- Compose YAML parsed with `js-yaml`; assertions passed that PostgreSQL/control/web publish no ports and web joins only its internal frontend network. This does not replace Docker Compose validation.
- `git diff --check`: passed. The disposable PostgreSQL cluster was stopped after verification.
- Native official Nginx 1.29.0 `-t`: both center and web configurations passed after replacing Linux file paths and Docker upstream names with temporary Windows paths/loopback addresses. This checks Nginx syntax, not Linux containers or image builds.

## Required runtime evidence not obtained here

Docker is absent; WSL reports a missing optional Windows component. Therefore no image build, `docker compose config`, full secure center startup, deployment-probe execution, Linux firewall check, separate-host installation, authenticated agent/facade test through this proxy, or full-stack restart/replay has been claimed. Follow `BE04_FOUNDATION.md` on a prepared Linux host, preserve logs and update this record with actual results. A passing local build does not close these criteria.

Issue #4 remains open until complete runtime acceptance, including real Low/Medium, network isolation and restoration, is recorded. The shell probes cover only part of that acceptance.
