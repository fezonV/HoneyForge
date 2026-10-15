# QA-01–04 integration execution report — 2026-10-15 UTC

Integration: [PR #38](https://github.com/fezonV/HoneyForge/pull/38), branch
`codex/integrate-qa-ci`, based on dev `b6e00b835a5ec45e3097e2f8aec13e3a3e34f9da`
(after merged PR #34). Final source revision:
`136e522ce0937eacd64e1d1dca02a67408df6692`. Subsequent report-only commits do
not change source. The final tested PR/merge SHA and Actions run are recorded in
PR #38 and the linked issues after the last CI gate; this report is not a claim
that every constructor acceptance criterion is complete.

The original commits are ancestors of the integration branch, preserving authors:

| PR | Original head |
| --- | --- |
| #31 / QA-01 | `c6b320e1036ab39228b010097bf62ab526d46b89` |
| #32 / QA-02 | `d2a5b03095ca816d8dff9fc3a6a23b5a6302d10b` |
| #33 / QA-03 | `4d9c5d061345c0d78c89ae5d77efdb0190273567` |
| #35 / QA-04 | `d19dac9809b88b8596820ab456bc3e1f628644a1` |

No force push or rewriting of the QA branches was used. PR #36/#37 were not
merged. The generic facade interception pattern from #36 is attributed in the
security fix commit; enrollment-specific handling and authenticated error
preservation are independently checked here.

## Environment and isolation

Local: disposable Debian 13 linux/amd64 managed container, 3 CPUs, 8 GiB cgroup
memory, Go 1.27.2, Node 24.19.0, Chromium 156.0.8078.4, Docker 28.4.0,
Compose 2.40.3, PostgreSQL 17.11. CI: ubuntu-latest, Go 1.27.2, Node 22.22.0,
PostgreSQL 17.11-alpine, npm lockfile and Redocly CLI 2.32.2.

Only lab resources were contacted: a loopback PostgreSQL fixture, random Go/
Playwright schemas, uniquely named Compose projects and a temporary Linux
Docker-in-Docker node. Production was not contacted. Project-scoped cleanup
removes schemas, files, containers/networks/volumes. The Docker bundle run briefly
exhausted shared disposable disk during a concurrent segment startup; that setup
attempt failed and is not counted as acceptance. Removing this task's build cache
and rerunning the segment stand produced the passing results below.

## Commands and observed results

| Check | Exact command / result | Revision evidence |
| --- | --- | --- |
| Full Go acceptance | `TEST_DATABASE_URL=… scripts/test-qa.sh` — race, PostgreSQL, processes, 60s outage/load, vet and build; **122 passed including subtests, zero test skips, all 11 sentinels passed**. No `-short`. | Local `21a74d9`; [CI `44a74bf`](https://github.com/fezonV/HoneyForge/actions/runs/38725880927), artifact `qa-backend` independently read. Later source changes affect Compose/nginx, not Go. |
| Formatting/static | `gofmt -l $(git ls-files '*.go')`, `git diff --check`, `go vet`, `go build` — passed. | `44a74bf` and the final mandatory CI |
| OpenAPI | `npm --prefix web ci`; `npm --prefix web run lint:api` — valid, **12 warnings**, no errors. YAML structure and actual operation/schema locations also checked in Go. | `21a74d9`, `44a74bf` CI |
| Frontend | `npm --prefix web run build`; `npm --prefix web run lint` — build passed; lint **0 errors / 35 warnings**. | `21a74d9`, `44a74bf` CI |
| Browser | `TEST_DATABASE_URL=… npm --prefix web run test:e2e` — **28 passed**: 22 controlled API/preview/commands/WS cases and 6 live API/PostgreSQL/process cases. CI includes every spec added by #34. | Local `21a74d9`, CI `44a74bf` and `59ccde0` |
| Real HTTP outage | `go test -race -count=1 -run TestBE02SixtySecondOutageRestartAndLostCommitACK -v ./internal/control` — 100 real HTTP actions over 60s, queue reopened at 30s, management 503, post-commit ACK loss, exact 100-ID recovery, no duplicates; **65.82s test elapsed**. | `44a74bf`, included in full CI |
| Clean Compose / actual DB outage | `scripts/test-compose.sh` — fresh volume, migrations/readiness, 125 filtered/cursor IDs and 132 timeline IDs; stop PostgreSQL with live control, no telemetry ACK, restore PostgreSQL/control, exact mixed accepted/duplicate IDs and idempotent replay; history and revision 1 survive after profile revision 2. **Passed**. | `59ccde0` source / final CI |
| Container-host ZIP installation | `TEST_DATABASE_URL=… scripts/test-fe2-bundle.sh` — downloaded ZIP → installer → separate Docker Engine → real Low/Medium, enrollment, events, commands, changed behavior and decoy→management prohibition. **1 passed, 4.3m**. | `21a74d9`; runtime/bundle source unchanged by later fixes (nginx center is checked separately). |
| Local network/TLS facade | `tests/security/run.sh` — anonymous GET/POST become ordinary 404; real enrollment/heartbeat work; authenticated invalid events retain 422; untrusted TLS rejected; attack client can reach its control target, cannot reach PostgreSQL/raw control/operator/agent ports. **Passed, exit 0**. | Final source `136e522`; mandatory fifth CI job `security-segments` |
| TLS/security API | Real trusted/untrusted/expired/wrong-host certificates; credential roles, viewer sensitive reads, private queue/state files, IPC/payload bounds, fake-FS traversal/session isolation and parsed CSV formula neutralization. **Passed** in full race gate. | `44a74bf` CI |
| Negative gate controls | Missing TEST_DATABASE_URL fails before tests; an injected test skip fails the result checker even when every required sentinel is present. **Passed**. | Local gate checker in final source |

CI evidence: [first full integrated run](https://github.com/fezonV/HoneyForge/actions/runs/38725376522),
[real HTTP outage/full QA run](https://github.com/fezonV/HoneyForge/actions/runs/38725880927),
[DB recovery/nginx startup run](https://github.com/fezonV/HoneyForge/actions/runs/38726425294).
The final PR comment links the run containing all five jobs. Artifacts are
`qa-backend`, `qa-compose`, `qa-security`, `qa04-browser-smoke` and
`qa04-live-e2e`. Browser HTML reports are always emitted; traces/screenshots are
retained on failure. Only synthetic lab data is used.

## Measured load, separate from targets

Target: nominal 50 HTTP actions/s for 60s, p95 ≤3s to the final UI. The current
load test measures event creation → committed PostgreSQL observation/ACK, not UI.

| Run | Actions | Elapsed / achieved rate | Committed-event p95 |
| --- | --- | --- | --- |
| Dedicated local load | 3000 | 60.024s / 49.98/s | 57ms |
| Local full race with concurrent Docker builds | 3000 | 63.524s / 47.23/s | 299ms |
| CI `44a74bf`, downloaded backend artifact | 3000 | 60.004s / 50.00/s | 274ms |

All compare locally acknowledged and committed ID sets and reject missing/
duplicate events. The slower local run does not establish strict 50/s sustained
throughput. UI p95 remains **not measured**; #15 stays open pending the final
#12/#13 UI. The 60s management fault is controlled HTTP 503/ACK loss, not a claim
of a physical external network partition. SQLite disk-full tests use deliberate
storage fault injection; they do not promise infinite retention on a full disk.

## Review corrections and defects

- Replaced substring-only OpenAPI checks with parsed paths/methods/properties and
  pinned syntax/reference validation. Added Low/category/type/limit negatives,
  independent copies and log-secret checks; QA-01 includes the wider foundation
  registration/expiry/identity/role/audit matrix.
- Replaced row-count delivery claims with exact ID comparison. Fixed closing the
  stale queue handle after reopen. The long outage now generates real decoy HTTP
  actions; the process crash test remains distinct from queue reopen.
- Fixed a 30s cold child-build timeout; runtime deadlines remain separate and
  real Low/Medium processes still must satisfy behavioral assertions.
- CSV formerly tested a formula only in omitted payload. It now exports a
  formula-bearing ASN cell, parses CSV and checks the neutralizing apostrophe.
- Added expired and wrong-host TLS rejection. Fixed read-only nginx temporary
  paths and unauthenticated facade disclosure; preserved quarantine status codes.
- Removed silent acceptance skips, enabled process gates, added missing #34
  browser specs, random live schemas/cleanup, explicit PowerShell exit checks,
  locked tooling and meaningful artifact settings.

## Issue decisions and open limits

**#14:** FR-C1/C2/C5 positive/negative API, separate entities and desired/applied,
role enforcement, secret boundaries and one-command execution are confirmed.
Closure requires these commits to be in dev; integration/closure evidence is
published in #14 after merging PR #38.

**#15 remains open:** final UI latency is unmeasured and depends on #12/#13.
Backend load/reliability, process scenarios, actual DB restart and filtered
history are confirmed only within the stated local/CI models.

**#16 remains open:** no independent prepared host/VM or external attack/management
stand is attached to this task. Target firewall/forbidden-egress, packet capture
on that final management path and complete deployed secret/mount inspection are
not accepted. Local bridge probes, TLS tests and the container-host bundle are
partial evidence only. TLS does not hide destination IPs; host root is outside
the claimed isolation model.

**#4/#12/#13/#17 remain open:** full secure web deployment/target-host recovery,
full event realtime/filter/detail/timeline UI, dashboard/audit/server CSV flows,
all-Must integration and the final delivery/demo/backup recording package still
need their own acceptance. No full implementation of these issues was started.
Bonus FR-C6/C7/A5/A6 and MASK-5–7 are not claimed. The demonstration uses
synthetic lab traffic, never a claimed external attack recording.
