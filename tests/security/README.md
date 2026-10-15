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

The command fails when any measured criterion fails and runs as the mandatory
`security-segments` CI job. It checks anonymous GET and POST facades, real
one-time enrollment, authorized heartbeat, rejection of untrusted TLS and
unreachability from the attack client with a working same-segment control.
Authorized event validation must retain HTTP 422 so permanent bad events can
still be quarantined by the agent.

The first successful stand startup exposed #4's anonymous 401 JSON disclosure.
The integrated nginx fix masks unauthorized agent responses and malformed
enrollment as the same ordinary 404 page. The basic interception pattern follows
PR #36; enrollment-specific handling preserves authenticated delivery errors.
PR #36's web service and the rest of #4 are not included here.

These are local Docker bridge measurements. They do not establish a target VM's
firewall rules, absence of a route to a real production network, packet-capture
properties, or invisibility to host root. No production host is contacted.
