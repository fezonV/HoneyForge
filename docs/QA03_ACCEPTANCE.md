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
| Partial MASK-2: decoy responses have no management markers | `TestPublicResponsesDoNotExposeManagementMarkers`, `TestAdminHandlerRequiresToken`, `TestHandlerNeverReturnsSyntheticPasswordInResponse` |
| Partial MASK-3: API credential separation | `TestQA03SensitiveDataAndManagementBoundary`, `TestIPCHandlerRejectsUnauthorizedAndUnavailableQueue`, `TestBundleRejectsIncompleteBindingsAndUnpinnedSource` |
| Partial MASK-4: fake-FS and private file permissions | `TestQA03SensitiveDataAndManagementBoundary`, `TestFakeFileRejectsEncodedAndAbsoluteHostPaths`, `TestQueueUsesPrivateFilesAndFullDurability`, `TestSaveAndLoadState`, `TestLoadStateRejectsBroadPermissions` |
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

## Integrated checks and remaining deployment gate

`TestQA03TLSValidityAndHostname` additionally exercises valid, expired and
wrong-host certificates using the real agent TLS verifier. The CSV API test now
places a formula in an exported ASN field and parses the CSV to check the
neutralizing apostrophe. A formula in omitted payload alone was insufficient.

Run `tests/security/run.sh` for separate local Docker attack/management probes
with positive controls; see its README. The initial deployment exposed an anonymous agent-facade disclosure (401 JSON).
The integrated nginx fix hides unauthenticated GET/POST and malformed enrollment
behind an ordinary 404 while preserving authenticated delivery validation
status codes. Real one-time enrollment and heartbeat are positive controls.
No full MASK claim follows from passing API tests. Packet capture, real target
VM/firewall/forbidden-egress and final bundle mount inspection remain open #16
criteria. TLS does not hide destination IPs; host root is outside this isolation
claim. See the concrete execution report for pass/fail/blocked results.

The segment run exposed a separate startup defect: read-only nginx attempted
to create FastCGI/uWSGI/SCGI temporary directories under /var/cache/nginx. Those
paths are now explicitly under the existing /tmp tmpfs. This narrow runtime fix
does not implement #4's remaining deployment or the proposed #36 web service.
