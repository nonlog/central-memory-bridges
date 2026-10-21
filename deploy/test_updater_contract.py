"""Static tests for the deployed Ubuntu-us official-update wrapper."""
import unittest
from pathlib import Path

UPDATE = Path(__file__).with_name("claude-mem-weekly-update.sh").read_text(encoding="utf-8")


class TestAutomaticUpgradeContract(unittest.TestCase):
    def test_official_remote_spool_token_is_preserved(self):
        self.assertIn('"CLAUDE_MEM_WORKER_INGEST_TOKEN"', UPDATE)
        self.assertIn('for k,v in old.items():', UPDATE)
        self.assertIn('d[k]=v', UPDATE)

    def test_identity_patch_failure_aborts_update_before_worker_restart(self):
        call = 'python3 /root/apps/central-memory-bridges/deploy/reapply-claude-mem-platform-ui.py'
        self.assertIn(call, UPDATE)
        self.assertNotIn('WARNING: platform identity UI overlay could not be reapplied', UPDATE)
        self.assertIn('trap \'rc=$?;', UPDATE)
        self.assertLess(UPDATE.index(call), UPDATE.index('systemctl start "$SERVICE"', UPDATE.index('npx --yes')))

    def test_work_view_branding_self_heals_without_a_worker_restart(self):
        self.assertIn('Already current; Viewer and My Work icon overlays verified', UPDATE)
        self.assertIn('node "$BRANDING_PATCHER" --root "$PLUGIN" --check', UPDATE)
        self.assertIn('&& node "$BRANDING_PATCHER" --root "$PLUGIN" --check', UPDATE)
        self.assertIn('&& node "$BRANDING_PATCHER" --root "$tmp_brand" --check', UPDATE)

    def test_independent_hermes_provider_survives_official_installer(self):
        self.assertIn('HERMES_PROVIDER=/root/.hermes/plugins/claude-mem/__init__.py', UPDATE)
        self.assertIn('"$BACKUP/hermes-provider.py"', UPDATE)
        self.assertIn('! cmp -s "$BACKUP/hermes-provider.py" "$HERMES_PROVIDER"', UPDATE)
        self.assertIn('cp -a -- "$BACKUP/hermes-provider.py" "$HERMES_PROVIDER"', UPDATE)
        self.assertIn('--ide claude-code', UPDATE)
        self.assertIn('upstream now bundles a Hermes integration', UPDATE)

    def test_upstream_upgrade_is_blocked_before_worker_changes(self):
        gate = 'node "$COMPATIBILITY_GATE" --installed "$CURRENT" --candidate "$LATEST"'
        self.assertIn(gate, UPDATE)
        self.assertIn('COMPATIBILITY HOLD: $LATEST not approved', UPDATE)
        self.assertLess(UPDATE.index(gate), UPDATE.index('stamp=$(date'))
        self.assertLess(UPDATE.index(gate), UPDATE.index('log "Stopping $SERVICE for consistent backup and official update"'))

    def test_existing_update_lifecycle_and_backup_retention_remain(self):
        self.assertIn('health_version "$LATEST"', UPDATE)
        self.assertIn('restore_dependent_service', UPDATE)
        self.assertIn('NR>2', UPDATE)


if __name__ == "__main__":
    unittest.main()
