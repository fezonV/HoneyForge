#!/bin/sh
# Run as root on the prepared Linux Docker host. IPv4 iptables backend only.
set -eu
umask 077
cd "$(dirname "$0")"
for tool in docker iptables iptables-restore getent awk; do
    command -v "$tool" >/dev/null || { echo "Required tool missing: $tool" >&2; exit 1; }
done
[ "$(id -u)" = 0 ] || { echo 'Run this script as root on the Docker host.' >&2; exit 1; }
state=secrets/egress-policy
remove_policy() {
    [ -f "$state" ] || return 0
    IFS=' ' read -r saved_chain saved_subnet saved_bridge < "$state"
    case "$saved_chain" in HFBE04_[a-f0-9][a-f0-9]*) ;; *) echo 'Invalid saved chain' >&2; exit 1;; esac
    case "$saved_subnet" in *[!0-9./]*|'') echo 'Invalid saved subnet' >&2; exit 1;; esac
    case "$saved_bridge" in *[!a-zA-Z0-9_.-]*) echo 'Invalid saved bridge' >&2; exit 1;; esac
    for parent in DOCKER-USER INPUT; do
        if iptables -w 5 -C "$parent" -s "$saved_subnet" -j "$saved_chain" 2>/dev/null; then
            iptables -w 5 -D "$parent" -s "$saved_subnet" -j "$saved_chain"
        fi
        if [ -n "$saved_bridge" ] && iptables -w 5 -C "$parent" -i "$saved_bridge" -j "$saved_chain" 2>/dev/null; then
            iptables -w 5 -D "$parent" -i "$saved_bridge" -j "$saved_chain"
        fi
    done
    if iptables -w 5 -S "$saved_chain" >/dev/null 2>&1; then
        iptables -w 5 -F "$saved_chain"
        iptables -w 5 -X "$saved_chain"
    fi
    rm -f "$state"
}
case "${1:-apply}" in
    remove) remove_policy; echo 'Removed this bundle egress policy'; exit 0 ;;
    apply) ;;
    *) echo 'Usage: sh restrict-egress.sh [apply|remove]' >&2; exit 1 ;;
esac
iptables -w 5 -S DOCKER-USER >/dev/null 2>&1 || {
    echo 'DOCKER-USER unavailable: configure the host firewall backend before deployment.' >&2; exit 1;
}
container=$(docker compose -f compose.yaml ps -a -q agent)
[ -n "$container" ] || { echo 'Create the bundle containers first.' >&2; exit 1; }
management=
for network in $(docker inspect --format '{{range .NetworkSettings.Networks}}{{.NetworkID}} {{end}}' "$container"); do
    if [ "$(docker network inspect --format '{{index .Labels "com.docker.compose.network"}}' "$network")" = management ]; then
        management=$network
    fi
done
[ -n "$management" ] || { echo 'Bundle management network not found.' >&2; exit 1; }
[ "$(docker network inspect --format '{{.EnableIPv6}}' "$management")" = false ] || {
    echo 'IPv6 requires an equivalent reviewed IPv6 firewall policy; no policy applied.' >&2; exit 1;
}
subnet=$(docker network inspect --format '{{(index .IPAM.Config 0).Subnet}}' "$management")
case "$subnet" in *[!0-9./]*|'') echo 'Expected an IPv4 management subnet' >&2; exit 1;; esac
bridge=$(docker network inspect --format '{{index .Options "com.docker.network.bridge.name"}}' "$management")
if [ -z "$bridge" ] || [ "$bridge" = '<no value>' ]; then
    bridge="br-$(printf '%s' "$management" | cut -c 1-12)"
fi
case "$bridge" in *[!a-zA-Z0-9_.-]*|'') echo 'Invalid management bridge' >&2; exit 1;; esac
host=@@HOST@@
port=@@PORT@@
addresses=$(getent ahostsv4 "$host" | awk '$1 ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ {print $1}' | sort -u)
[ -n "$addresses" ] || { echo 'Center has no resolved IPv4 address; no policy applied.' >&2; exit 1; }
chain="HFBE04_$(printf '%s' "$management" | cut -c 1-12)"
if [ -f "$state" ] && [ "$(cat "$state")" != "$chain $subnet" ] && [ "$(cat "$state")" != "$chain $subnet $bridge" ]; then
    echo 'Network changed: run restrict-egress.sh remove before applying a new policy.' >&2; exit 1
fi
rules=$(mktemp)
trap 'rm -f "$rules"' EXIT HUP INT TERM
{
    printf '*filter\n:%s - [0:0]\n-F %s\n' "$chain" "$chain"
    for address in $addresses; do
        printf -- '-A %s -d %s/32 -p tcp --dport %s -j RETURN\n' "$chain" "$address" "$port"
    done
    printf -- '-A %s -j REJECT --reject-with icmp-admin-prohibited\nCOMMIT\n' "$chain"
} > "$rules"
# One atomic filter-table update; repeat application does not accumulate rules.
iptables-restore --wait 5 --noflush < "$rules"
mkdir -p secrets
printf '%s %s %s\n' "$chain" "$subnet" "$bridge" > "$state"
chmod 0600 "$state"
for parent in DOCKER-USER INPUT; do
    if ! iptables -w 5 -C "$parent" -s "$subnet" -j "$chain" 2>/dev/null; then
        iptables -w 5 -I "$parent" 1 -s "$subnet" -j "$chain"
    fi
    # Match the ingress bridge as well: a multihomed agent can bind a socket to
    # its IPC address while routing out through management without NET_RAW.
    if ! iptables -w 5 -C "$parent" -i "$bridge" -j "$chain" 2>/dev/null; then
        iptables -w 5 -I "$parent" 1 -i "$bridge" -j "$chain"
    fi
done
echo "Applied bundle policy: management subnet $subnet can reach only center TCP port $port"
echo 'Reapply after a center DNS change. Persist/reapply after Docker/host restart using host administration.'
echo 'Before compose down/network removal, run: sh restrict-egress.sh remove'
