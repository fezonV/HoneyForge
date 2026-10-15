# HoneyForge acceptance runbook

Use a clean checkout and a disposable PostgreSQL database. No default operator
exists. All traffic below is synthetic lab traffic. CI uses isolated service
containers; the Go tests create random schemas and live Playwright creates and
drops its own schema. Never point TEST_DATABASE_URL at a user/production database.

On Linux with Go 1.27.2, Node.js 22+, Python 3, OpenSSL and Docker Compose:

```sh
export TEST_DATABASE_URL='postgres://<test-user>:<test-password>@127.0.0.1:5432/<test-database>?sslmode=disable'
scripts/test-qa.sh
npm --prefix web ci
npm --prefix web run lint:api
npm --prefix web run build
npm --prefix web run lint
(cd web && npx playwright install --with-deps chromium)
npm --prefix web run test:e2e
scripts/test-compose.sh
tests/security/run.sh
```

`scripts/test-qa.sh` runs full race tests, including the 60-second outage,
process crash/restart and 60-second HTTP load; it rejects test skips and missing
acceptance tests, then runs vet/build. Packages without test files are not test
skips. Missing TEST_DATABASE_URL fails before testing; live Playwright also fails
instead of skipping. All 28 Playwright cases must run in the full browser command.
OpenAPI tooling is pinned in web/package-lock.json. ESLint/OpenAPI warnings are
reported separately from errors.

Compose starts a new project/volume, checks migrations/readiness, restarts
PostgreSQL/control and verifies persistence. Cleanup is scoped to its project.
The security command is a required local deployment gate in CI. Its nonzero
result must never be counted as acceptance; a passing Docker-segment run does
not close the external VM/firewall criteria.
See [security harness](../tests/security/README.md).

`scripts/test-fe2-bundle.sh` creates its own disposable Docker-in-Docker Linux
node and runs the downloaded ZIP installer there. This is container-host bundle
evidence, not an independent VM/firewall qualification. On a managed proxy host,
its public CA is copied only into the temporary node's trust bundle.

Record the exact SHA, environment, commands, outcomes and limitations in
[QA04_REPORT.md](QA04_REPORT.md). Full acceptance remains open while #4, #12,
#13, the external MASK stand and final delivery materials are incomplete.
