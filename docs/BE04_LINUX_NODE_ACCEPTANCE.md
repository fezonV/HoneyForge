# BE-04 independent Linux-engine continuation — 15 October 2026

Integrated current `dev` (`98ea569`) into this PR as `c96543115dbff8c21d3bf50cbe398cde63ffe52e`. Merge conflicts were limited to `.gitignore` and Nginx facade rules: both sets of ignore entries, the operator web service and QA's authenticated-delivery status preservation were retained. This record supplements [the initial local acceptance](BE04_ACCEPTANCE.md).

## Real ZIP installer on a separate engine

Outer host: Windows/Docker Desktop 4.95.0, Engine 29.8.2. The disposable node `hf-be04-linux-node` runs Docker 28.5.2 with overlay2, its own Unix socket and private image/volume storage. The parent Docker socket is **not mounted**. The node itself is privileged as required by this disposable DinD fixture; inner agent/decoy/visitor containers are unprivileged. Published outer visitor ports are loopback 28180/28181. This is an independent containerized engine, not a physical remote VM.

Command: set `HF_BUNDLE_NODE=hf-be04-linux-node`, `HF_VISITOR_BASE_PORT=28180`, then `node scripts/test-be04-stack.mjs` with Docker CLI in PATH. Source pin downloaded from the real center: `c96543115dbff8c21d3bf50cbe398cde63ffe52e`. Result: **passed**, run `1792074955206`.

- Genuine Low and Medium ZIPs came from the operator API; one-time enrollment tokens were supplied separately as files.
- Each unmodified `install.sh` cloned/fetched the pinned GitHub commit, built images on the new engine and started its manifest. No local-image override was used in this mode.
- Both agents enrolled over verified TLS and confirmed applied revision 1 through decoy IPC. Real visitor events reached PostgreSQL.
- Medium login, synthetic file listing and pseudo-command produced the expected persisted session timeline. Authenticated WebSocket worked through the center's real TLS Nginx.
- Management interruption followed by agent restart replayed exactly four queued HTTP events once. The test then reconciled REST history after WS reconnect.
- Stopping the Medium process produced a service error while its agent stayed online and Low remained usable.
- Restarting PostgreSQL/control/web/Nginx preserved the operator session and every saved Medium event identity; WS connected again.

Private evidence: `deploy/secrets/stack-1792074955206/result.json` and per-level `installer.log`. These files, credentials, CA material and raw traces are ignored and not included in Git.

## Egress, mounts and trace

New `restrict-egress.sh` is generated into the actual bundle ZIP. It targets that bundle's management subnet in the independent node's iptables namespace. Rules allow only the configured center TCP destination, handle both forwarded traffic and host-local INPUT, and can be applied/removed idempotently without deleting unrelated policy. It is explicitly an IPv4 iptables helper; nftables-only, IPv6, ingress ACLs and reboot persistence remain target-host administration tasks.

Command: `HF_STACK_RESULT=<private result.json> py scripts/test-be04-node-security.py`. The final run **passed**:

- Low/Medium agent/decoy/visitor run as non-root, read-only, with CPU/memory/PID bounds, ALL capabilities dropped and no-new-privileges. PID and IPC namespaces are private.
- Decoy has only internal networks, its own configuration/state and the two required IPC secrets. Visitor has no secrets; neither receives the agent credential/state volume. Secret mounts are read-only; host bundle secret directories are 0700; agent state/SQLite files are 0600.
- Secure center mounts exclude the CA private key and Docker socket. Raw control/web ports are unpublished; web joins only frontend.
- Two controlled destinations were first verified reachable from the agent: a published fixture through FORWARD and a host-local fixture through INPUT. After allowlisting, both were denied while the center TCP positive control continued to work. No production network was contacted.
- Repeated application preserved the same actual rules. Repeated removal restored the original two positive controls; policy was then reapplied and remains active for this Low fixture.
- A private tcpdump captured **8 TLS application records**. The capture contains no tested plaintext HTTP/Bearer/event-JSON markers; source/destination IPs and timing are still observable. The agent remained online with revision 1 and a running decoy after the policy test.

The first forwarding fixture used a runtime image without a working HTTP server; its positive control failed, and that attempt was not counted. The successful run uses a real Python HTTP server. Idempotence compares actual rules with duplicates retained, rather than changing iptables-save generation metadata.

The initial lab CA lacked keyUsage and failed Python 3.13's strict verifier. It was reissued with the same CA key and correct CA/leaf extensions. `openssl verify -x509_strict` passed; chain and hostname checks were not disabled. No CA private key is mounted into containers.

## Bundle download concurrency defect

A real download while heartbeat updated the trap returned 503. PostgreSQL logged `could not serialize access due to concurrent update` at `FOR SHARE` under REPEATABLE READ. The handler now uses READ COMMITTED while retaining the share lock until audit/commit; the referenced profile revision is immutable. This lets the lock wait for heartbeat without changing the pinned configuration mid-download.

`TestOperatorDownloadsAuditedTrapBundle` now holds a real update transaction, verifies the concurrent download is waiting on the PostgreSQL lock, commits heartbeat and requires HTTP 200 with the correct revision. The race run passed this regression. ZIP contract tests also require the executable egress helper and its correctly rendered center endpoint.

## QA execution and limits

The integrated source first passed full `bash scripts/test-qa.sh`: 122 tests, no skips, all 11 sentinels, then vet/build. A later full run including the concurrency fix passed that regression but failed the pre-existing `TestBE02SixtySecondOutageRestartAndLostCommitACK` on one HTTP 503 at 18.66 seconds. That failure is retained; its cause was not established, and it is not treated as a pass or hidden by excluding the test. A subsequent full gate with `GOFLAGS=-p=1` serializes packages while retaining race checks, the same timeouts and all acceptance criteria; its result is recorded in the PR once complete.

The independent engine and its firewall/packet capture are now measured. No target physical host/VM or external attack segment was supplied, so this report does not certify that host's routing, forbidden production egress, ingress firewall, reboot persistence or external MASK acceptance. Issue #4 remains open for those target-host requirements with #16/#17.
