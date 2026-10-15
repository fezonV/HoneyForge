"""Run the real bundle firewall script against disposable command fixtures.

No Docker daemon, root privileges, or host firewall changes are involved.
Live packet filtering remains covered by test-be04-node-security.py.
"""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / 'internal/control/bundle-egress.sh'
FIXTURES = r'''
id() { echo 0; }
docker() {
    case "$*" in
        compose*) echo container ;;
        inspect*) echo abcdef1234567890 ;;
        *com.docker.compose.network*) echo management ;;
        *EnableIPv6*) echo false ;;
        *Subnet*) echo 172.30.0.0/16 ;;
        *com.docker.network.bridge.name*) echo "${CUSTOM_BRIDGE:-}" ;;
        *) return 1 ;;
    esac
}
getent() {
    case "$1" in
        hosts) echo '2001:db8::1 center.example.org' ;;
        ahostsv4)
            printf '192.0.2.10 STREAM center.example.org\n192.0.2.10 DGRAM\n192.0.2.11 STREAM\n'
            ;;
        *) return 1 ;;
    esac
}
iptables-restore() { cat > restored; }
iptables() {
    shift 2 # -w 5
    operation=$1; shift
    parent=$1; shift
    case "$operation" in
        -S|-F|-X) return 0 ;;
        -I) shift; printf '%s %s\n' "$parent" "$*" >> installed ;;
        -C) grep -Fx -- "$parent $*" installed >/dev/null 2>&1 ;;
        -D) grep -Fxv -- "$parent $*" installed > remaining || true
            mv remaining installed ;;
        *) return 1 ;;
    esac
}
. ./restrict-egress.sh
'''


class BundleEgressTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        script = SCRIPT.read_text().replace('@@HOST@@', "'center.example.org'").replace('@@PORT@@', "'9443'")
        (self.directory / 'restrict-egress.sh').write_text(script, newline='\n')
        (self.directory / 'fixture.sh').write_text(FIXTURES, newline='\n')

    def run_policy(self, action='apply', bridge=''):
        shell = os.environ.get('HF_TEST_SH') or shutil.which('sh')
        self.assertTrue(shell, 'A POSIX shell is required')
        result = subprocess.run([shell, 'fixture.sh', action], cwd=self.directory,
                                env={**os.environ, 'CUSTOM_BRIDGE': bridge}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_dual_stack_resolution_and_bridge_rules_are_idempotent(self):
        for bridge in ['', 'custom-mgmt']:
            with self.subTest(bridge=bridge):
                self.run_policy(bridge=bridge)
                rules = (self.directory / 'restored').read_text()
                self.assertEqual(rules.count('-d 192.0.2.10/32'), 1)
                self.assertEqual(rules.count('-d 192.0.2.11/32'), 1)
                self.assertIn('-j REJECT', rules)
                installed = (self.directory / 'installed').read_text()
                for parent in ['DOCKER-USER', 'INPUT']:
                    self.assertIn(f'{parent} -i {bridge or "br-abcdef123456"} -j HFBE04_abcdef123456', installed)
                self.run_policy(bridge=bridge)
                self.assertEqual((self.directory / 'installed').read_text(), installed)
                self.run_policy('remove')
                self.run_policy('remove')
                self.assertEqual((self.directory / 'installed').read_text(), '')
                self.assertFalse((self.directory / 'secrets/egress-policy').exists())

    def test_existing_subnet_policy_can_upgrade_and_remove(self):
        (self.directory / 'secrets').mkdir()
        (self.directory / 'secrets/egress-policy').write_text('HFBE04_abcdef123456 172.30.0.0/16\n')
        (self.directory / 'installed').write_text('DOCKER-USER -s 172.30.0.0/16 -j HFBE04_abcdef123456\n')
        self.run_policy()
        self.run_policy('remove')
        self.assertEqual((self.directory / 'installed').read_text(), '')


if __name__ == '__main__':
    unittest.main()
