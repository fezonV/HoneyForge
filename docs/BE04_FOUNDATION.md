commit 9c71957c0e68401902827d344cba5ac1bf6ba8f0
Author: Анна Ардышева <ardyshevaanna@gmail.com>
Date:   Wed Oct 14 12:48:08 2026 +0000

    feat(be-04): generate audited pinned trap bundles

diff --git a/docs/BE04_FOUNDATION.md b/docs/BE04_FOUNDATION.md
index fffca6b..ff98dde 100644
--- a/docs/BE04_FOUNDATION.md
+++ b/docs/BE04_FOUNDATION.md
@@ -1,6 +1,6 @@
 # BE-04 foundation
 
-This document tracks the parts of BE-04 that can be prepared before the BE-03 decoy runtime is merged. It does not claim the full deployment and end-to-end acceptance are complete.
+This document tracks the implemented BE-04 foundation and the work still needed for a complete deployment. PR #23 merged the BE-03 runtime into `dev`; issue #3 remains open for final template integration and end-to-end acceptance.
 
 ## Event query API
 
@@ -8,7 +8,7 @@ The control API now exposes authenticated event search at `GET /api/v1/events`,
 
 Ordinary event pages and details omit payloads entirely because the payload schema may contain user-entered credentials in arbitrary fields. `GET /api/v1/traps/{trap_id}/events/{event_id}/sensitive` returns the raw payload only to an operator and writes an `event.sensitive_read` audit entry before the response is sent. CSV export is operator-only, bounded to 10,000 rows, includes metadata only, and prefixes spreadsheet formula cells with an apostrophe.
 
-`GET /api/v1/ws` accepts authenticated viewer and operator sessions only when the request `Origin` exactly matches `PUBLIC_ORIGIN`. It emits committed event, session, trap status, and command changes without event payloads. Logout closes that session's WebSocket connections immediately, and active connections recheck session validity every 30 seconds. Each client has a 64-message queue; a slow client is disconnected when full. Notifications are an in-process fanout for the single-control Compose baseline. Clients should reconnect and reconcile from persisted REST event pages using event IDs to avoid duplicate rows. Durable WebSocket replay and notifications for decoy runtime status transitions remain part of BE-03 integration.
+`GET /api/v1/ws` accepts authenticated viewer and operator sessions only when the request `Origin` exactly matches `PUBLIC_ORIGIN`. It emits committed event, session, trap status, and command changes without event payloads. Logout closes that session's WebSocket connections immediately, and active connections recheck session validity every 30 seconds. Each client has a 64-message queue; a slow client is disconnected when full. Notifications are an in-process fanout for the single-control Compose baseline. Clients should reconnect and reconcile from persisted REST event pages using event IDs to avoid duplicate rows. Agent heartbeats publish online and service-state changes; offline state is derived from `last_seen`, so clients should refresh after reconnect.
 
 Local GeoIP enrichment is optional. Set `GEOIP_CITY_DB` and/or `GEOIP_ASN_DB` to paths inside the control container, and set `GEOIP_SOURCE` and `GEOIP_VERSION` to the pinned data release. Mount the database directory read-only. Country, ASN, and the pinned release are stored with each new event; private, loopback, link-local, multicast, and missing addresses have no enrichment. The database files are not included in the repository or bundle.
 
@@ -24,7 +24,7 @@ umask 077
 openssl rand -hex 32 > deploy/secrets/postgres_password
 ```
 
-Write the matching PostgreSQL URL to `deploy/secrets/control_database_url` and place the trusted certificate and private key at the paths configured in `deploy/.env`. Start the center with:
+Write the matching PostgreSQL URL to `deploy/secrets/control_database_url` and place the trusted certificate and private key at the paths configured in `deploy/.env`. Set `HF_SOURCE_REVISION` to the full Git commit SHA being deployed; the bundle pins its remote build to this revision. Start the center with:
 
 ```sh
 docker compose --env-file deploy/.env -f deploy/compose.yaml up --build -d
@@ -32,6 +32,8 @@ docker compose --env-file deploy/.env -f deploy/compose.yaml up --build -d
 
 Both published ports bind to loopback by default. For a remote host, set explicit bind addresses and restrict port 8443 to operators and 9443 to enrolled-agent networks with the host firewall. Never attach decoys to the management or backend networks. Agents use system certificate trust by default; a private CA can be added with the agent's `-ca-file` option or `HF_CA_FILE` environment variable.
 
-## Waiting for BE-03 integration
+## Remaining deployment work
 
-The secure center stack does not yet include the web UI, agent, or decoy services. The deployment bundle renderer and remote-host acceptance must use the final BE-03 runtime configuration and its IPC contract; generating a bundle before that integration would produce a manifest that cannot be run. Once BE-03 is merged, add its services on separate attack/IPC/management networks, render a bundle from a trap and immutable profile revision without enrollment credentials, then test reconnect reconciliation and committed notifications from decoy status transitions.
+`GET /api/v1/traps/{id}/bundle` now returns an operator-only, audited ZIP from the trap's desired immutable revision. It contains the decoy config, an isolated Compose layout, random local IPC secrets generated by the installer, and a pinned source checkout. The enrollment token is issued separately and entered during installation. The bundle includes synthetic visitor credentials, so protect the archive as operator data. Downloading it does not claim that an agent has enrolled or that the service is running.
+
+The secure center stack still does not include the web UI, and the generated bundle has not yet been verified on a separate prepared host. Final profile templates from #9 are still pending. Verify Low and Medium, TLS validation, network reachability, queue replay after reconnect, and status reconciliation before closing BE-04.
