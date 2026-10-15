# HoneyForge acceptance runbook

Use a disposable PostgreSQL database and a clean checkout. Copy `.env.example`
to `.env`, set a random URI-safe password, and keep all runtime files under a
temporary directory. Create operator and viewer accounts with the documented
`go run ./cmd/control -create-user` command; no default account exists.

The acceptance order is:

1. Run the backend, schema, security, and queue checks from QA-01–03.
2. Run the Playwright mock smoke to verify reconnect, viewer, form conflicts,
   session expiry, and safe rendering.
3. Run `trap-park.spec.mjs` with `TEST_DATABASE_URL` to verify the live API and
   Low/Medium runtime.
4. Run `scripts/test-fe2-bundle.sh` only on the prepared Linux Docker host when
   remote bundle acceptance is required.

Record the commit SHA and environment before running. Save Playwright artifacts
and the command output. A skipped database test is a missing prerequisite, not a
pass.
