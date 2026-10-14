#!/bin/sh
set -eu

config_path="${HF_DECOY_CONFIG:-/var/lib/honeyforge/decoy-config.json}"
bootstrap_path="${HF_DECOY_BOOTSTRAP_CONFIG:-/etc/honeyforge/decoy-config.json}"

if [ ! -s "$config_path" ]; then
	install -m 0600 "$bootstrap_path" "$config_path"
fi

exec /usr/local/bin/honeyforge-decoy -config "$config_path" "$@"
