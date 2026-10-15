# Disposable network acceptance

Run `tests/security/run.sh` from a Linux Docker host. It creates a uniquely
named Compose project from `deploy/compose.yaml`, a separate attack client,
a reachable control target in the attack segment, ephemeral certificates and
credentials. The authorized agent heartbeat crosses real TLS/nginx/control/
PostgreSQL. Negative probes target only this project's containers. Cleanup
removes only this project's containers, networks and volumes.

`qa-security.log` contains safe outcomes and service logs. Credentials, private
keys and private response bodies are never copied to the report. File-secret
sources are readable by the service UIDs inside a private temporary directory.
The optional managed-environment CA is supplied via a BuildKit secret. The
public nginx configuration is copied with explicit service-readable permissions;
the local healthcheck uses wget -Y off for loopback because BusyBox ignores
NO_PROXY. External build/runtime traffic still uses the configured proxy.

The command fails when any measured criterion fails. It is a separate deployment
acceptance gate, not part of the passing API/unit CI gate. On the integrated dev
baseline it is expected to expose #4's unresolved MASK-2: the agent listener
returns a distinguishable 401 JSON API error without credentials. PR #36 proposes
a facade fix and the web service; neither is silently included in QA integration.

These are local Docker bridge measurements. They do not establish a target VM's
firewall rules, absence of a route to a real production network, packet-capture
properties, or invisibility to host root. No production host is contacted.
