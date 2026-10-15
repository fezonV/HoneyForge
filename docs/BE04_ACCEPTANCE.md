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

## Docker runtime continuation

Docker Desktop 4.95.0 (242831) was subsequently installed and started on this Windows host. Actual server: Linux/amd64 Engine 29.8.2, Compose 5.6.0. The earlier missing-Docker/race limitations above describe the initial run, not the current environment.

The first container run found that Nginx initializes proxy/FastCGI/uWSGI/SCGI temp directories even in the static web image. Default `/var/cache/nginx` is read-only in this deployment. All temp paths are now explicitly under `/tmp` for both images. `.gitattributes` enforces LF for shell entrypoints across Windows checkouts. `AGENT_HOST` permits a separately reachable agent DNS name while retaining exact operator origin checks.

Actual runtime checks:

- `docker compose --env-file deploy/.env -f deploy/compose.yaml config --quiet`: passed.
- `docker compose --env-file deploy/.env -f deploy/compose.yaml up --build -d --wait`: passed; PostgreSQL, control, web and Nginx all healthy. Only operator/agent TLS ports are published, both on loopback (18443/19443 in this run).
- Real Docker builds passed for control, web, agent and decoy. Web build resolves the shared preview imports and strips source maps.
- `sh scripts/test-be04-deployment.sh`: passed on Git Bash against the running TLS stack. Includes UI page reload, API auth rejection, agent HTML 404, invalid Bearer, unrelated CA rejection and direct private-IP reachability probes from an isolated attack network. Invalid/malformed enrollment JSON is also covered after the enrollment-specific facade rule was added. Schannel uses best-effort revocation lookup for the private lab CA; CA/hostname validation is retained.
- Decoy/agent management reachability was tested with the **same resolved IP**, avoiding a false negative caused by missing DNS on decoy's internal network: decoy TCP connection refused, agent positive control succeeded. Authenticated agent TLS/IPC is additionally exercised by the stack test.
- `node scripts/test-be04-stack.mjs`: passed end to end, run `1792073556390`. Both downloaded bundle manifests ran with local-image overrides: Low/Medium TLS enrollment, IPC-confirmed revision 1, real visitor requests and saved events; Medium login, fake-FS list and pseudo-command with session timeline; live authenticated WS; management outage and agent restart followed by exactly four queued HTTP events without duplicates; Medium process failure reported as service error with agent still online and Low unaffected; restart of PostgreSQL/control/web/Nginx preserving session and all saved Medium event identities, followed by WS reconnect. Private IDs/Compose arguments are in `deploy/secrets/stack-1792073556390/result.json`. The final passing run corrected test assertions for direct `/auth/me` fields and physical process-failure status; no application code was changed to satisfy those expectations.
- A separate internal-network PostgreSQL 17.11 container and a Go 1.27.2 Alpine image with build-base were used for `HF_DECOY_PROCESS_TEST=1 go test -short -race ./...`, followed by `go vet ./...` and `go build ./...`: all passed, no test exclusions. The temporary test-image Docker ignore retained the legacy embedded HTML files required by the root Go package; production images continue to exclude those demo pages.

Image IDs for this local runtime (not registry release digests):

| Image | ID |
|---|---|
| control | `sha256:1cd3637bba5c3d2b7cc610a4ece766818f80a737057dd0d6e6da5a755f4c8ca2` |
| web | `sha256:8b8c632af691731355e2703ea285b584d9c5ece8be4bb909fc5aa41c6a11f1dc` |
| agent | `sha256:5a63aa03e036aaa010010a7e08819707b840b5dc9a840775c469d3b913e0bcc7` |
| decoy | `sha256:d2a2a3e16671c2b749e13decd6212292087a9ae58fad26fabce874e21e4d499e` |

The control binary identifies its pinned bundle source as `8090aa8`; runtime configuration and entrypoint normalization include the subsequent continuation changes. Secrets, certificates, generated bundles and private per-run IDs/results remain ignored under `deploy/secrets`; no permanent agent or operator credential is committed.

Repeated partial test runs initially exhausted Docker's default subnet pool. Only those two earlier runs' known Compose projects were brought down, without `-v`; this freed their networks while preserving volumes. Failure cleanup in the regression now uses project-scoped `down` rather than leaving stopped containers/networks behind. The successful sample deployments and secure center remain running; the isolated race-test PostgreSQL container and network were removed after completion.

## Remaining acceptance boundary

Subsequent continuation integrated the latest QA/dev changes, ran the real pinned-source installer on an independent Docker Engine and added measured IPv4 egress, mounts and TLS-capture evidence. See [BE04_LINUX_NODE_ACCEPTANCE.md](BE04_LINUX_NODE_ACCEPTANCE.md) for the newer results and the remaining target-host boundary; the paragraph below describes the earlier local-image run.

Docker Desktop's Linux engine and local generated-bundle manifests are tested here. This is not a new execution of the pinned-source `install.sh` on a separate physical/remote Linux host; prior installer evidence is recorded in [FE2-01 acceptance](FE201_ACCEPTANCE.md). Production firewall probes from the actual attack segment, target host TLS/network configuration and full external MASK/QA acceptance remain separate. The wrong-CA probe is not evidence of an expired-certificate or packet-capture test on the target host.

Local Low/Medium, isolation and restoration evidence is now recorded. Issue #4 remains open for acceptance on the intended target hosts and external attack segment, together with #16/#17. The shell probes and local stack test do not replace that external acceptance.
