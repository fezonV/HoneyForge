# QA-01: contract and API acceptance

QA-01 covers the HTTP boundary for FR-C1 (profiles), FR-C2 (registration and
assignments), and FR-C5 (operator access). The suite uses a disposable
PostgreSQL schema created by `setupIntegration`; migrations and cleanup are
scoped to that temporary schema, and the database itself is never truncated or
dropped.

Run the complete QA-01 package from the repository root:

```powershell
$env:TEST_DATABASE_URL = 'postgres://<test-user>:<test-password>@127.0.0.1:5432/<test-database>?sslmode=disable'
./scripts/test-qa01.ps1
```

The same checks can be run directly with Go:

```powershell
go test -race -count=1 -run 'TestOpenAPIContract|TestQA01|TestControlPostgresFoundation' ./api ./internal/control
```

`TEST_DATABASE_URL` must point to a disposable test database. Without it, the
database-backed cases are reported as skipped by Go and are not an acceptance
result.

Canonical complete Linux acceptance (no skipped tests): `scripts/test-qa.sh`.
The narrow QA-01 command also includes `TestControlPostgresFoundation`: concurrent
enrollment, expiry/cross-trap/credential boundaries, audit and CRUD negatives.

## Traceability

| Test | Requirement and evidence |
| --- | --- |
| `TestOpenAPIContractDeclaresRequiredQA01Surface` | Parses YAML and checks actual path/method/schema locations; pinned Redocly validates syntax/references. The versioned OpenAPI document declares auth, templates, profile/revision, trap assignment, enrollment, and the security fields used by clients. |
| `TestQA01ProfileAuthorizationValidationAndRevisionIsolation` | Anonymous `401`, viewer `403`, CSRF-protected operator writes, unknown-field rejection, collection limits, invalid revision rejection, optimistic revision conflict, assignment/delete rules, redacted create responses, and unchanged `applied_revision`. |
| `TestQA01RegistrationAndSecretBoundary` | Viewer cannot issue enrollment, enrollment is one-time, invalid tokens are rejected, only a hash is persisted, registration history omits tokens, logout requires CSRF, and logout/expiry invalidate sessions. |

The existing control integration tests remain responsible for the wider
profile/event/agent matrix. QA-01 adds an independently named, reviewable
acceptance slice so that a future API change can be mapped to a specific
failure without relying on UI button visibility.

## Security assertions

- Profile creation and ordinary reads redact synthetic passwords.
- Enrollment responses are the only place where a one-time token is returned;
  the database stores its hash.
- Viewer permissions are checked by direct API calls.
- CSRF and session revocation are exercised through the same HTTP handler used
  by the application.

The suite intentionally does not claim TLS/network isolation, Low/Medium
runtime behavior, delivery retries, or browser workflows. Those belong to
QA-02, QA-03, and QA-04.
