# QA-03: MASK-1–4 and interface security

QA-03 covers the mandatory security checks for TLS, public decoy responses,
management boundaries, secrets, and untrusted data. The API scenario uses a
disposable PostgreSQL schema and synthetic credentials only. Network claims
that require attack and management segments must be run on the isolated
Compose/VM stand described in [BE-04 foundation](BE04_FOUNDATION.md).

Run the local security suite with:

```powershell
$env:TEST_DATABASE_URL = 'postgres://<test-user>:<test-password>@127.0.0.1:5432/<test-database>?sslmode=disable'
./scripts/test-qa03.ps1
```

## Traceability

| Control | Evidence |
| --- | --- |
| MASK-1: TLS and no plaintext fallback | `TestNewClientRequiresHTTPSOrigin`, `TestNewClientWithCAValidatesPrivateCenterCertificate`, `TestNewClientWithCARejectsMalformedBundle`, `TestManagementRedirectCannotDowngradeTLS` |
| MASK-2: ordinary web facade has no management surface | `TestPublicResponsesDoNotExposeManagementMarkers`, `TestAdminHandlerRequiresToken`, `TestHandlerNeverReturnsSyntheticPasswordInResponse` |
| MASK-3: management path requires the agent credential | `TestQA03SensitiveDataAndManagementBoundary`, `TestIPCHandlerRejectsUnauthorizedAndUnavailableQueue`, `TestBundleRejectsIncompleteBindingsAndUnpinnedSource` |
| MASK-4: secrets and host paths are not visible to the decoy | `TestQA03SensitiveDataAndManagementBoundary`, `TestFakeFileRejectsEncodedAndAbsoluteHostPaths`, `TestQueueUsesPrivateFilesAndFullDurability`, `TestSaveAndLoadState`, `TestLoadStateRejectsBroadPermissions` |
| Viewer/API and untrusted data | `TestQA03SensitiveDataAndManagementBoundary`, `TestSafeCSVCellNeutralizesFormulaPrefixes`, `TestEventMetadataScanNeverLoadsRawPayload`, `TestSensitiveEventScanReturnsPayloadForAuditedHandler` |

`TestQA03SensitiveDataAndManagementBoundary` inserts one synthetic event with
credentials, HTML, and a formula-like value, then checks operator/viewer API
responses, CSV, audit, and an unauthenticated agent request. Viewer access is
tested by direct HTTP calls; hidden UI controls are not used as evidence.

## Network acceptance and limits

- A real attack-segment run must show operator API, agent API, PostgreSQL, and
  internal decoy listeners as unreachable, while the allowed agent path still
  works. A local host-only test cannot satisfy this item.
- TLS protects management traffic in transit but does not hide the endpoint IP
  or provide invisibility against a privileged observer of the host.
- The tests use only synthetic passwords and temporary files. Reports must not
  include bearer tokens, cookies, private keys, or raw sensitive payloads.
- MASK-5–7 (jitter, anti-fingerprinting, and mTLS/pinning rotation) are bonus
  requirements and are outside this acceptance package.
