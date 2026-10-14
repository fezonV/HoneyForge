commit 9c71957c0e68401902827d344cba5ac1bf6ba8f0
Author: Анна Ардышева <ardyshevaanna@gmail.com>
Date:   Wed Oct 14 12:48:08 2026 +0000

    feat(be-04): generate audited pinned trap bundles

diff --git a/scripts/decoy-entrypoint.sh b/scripts/decoy-entrypoint.sh
new file mode 100644
index 0000000..ca35ec8
--- /dev/null
+++ b/scripts/decoy-entrypoint.sh
@@ -0,0 +1,11 @@
+#!/bin/sh
+set -eu
+
+config_path="${HF_DECOY_CONFIG:-/var/lib/honeyforge/decoy-config.json}"
+bootstrap_path="${HF_DECOY_BOOTSTRAP_CONFIG:-/etc/honeyforge/decoy-config.json}"
+
+if [ ! -s "$config_path" ]; then
+	install -m 0600 "$bootstrap_path" "$config_path"
+fi
+
+exec /usr/local/bin/honeyforge-decoy -config "$config_path" "$@"
