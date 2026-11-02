# Claude-mem central release: UniGetUI manual updates only

**Entry point:** UniGetUI > Software Updates > Scoop > `claude-mem-central` > **Update**.
The original npm/claude-mem package is intentionally ignored inside UniGetUI;
updating it directly would update only the local CLI and break the central pin.

`nonlog/scoop-www` exposes the separate Scoop package. Its existing Excavator
checks official npm version metadata and updates the Scoop *manifest only*;
**it never installs or upgrades Claude-mem**. UniGetUI shows an available
update when Scoop has refreshed its bucket metadata.

Clicking Update performs one explicit transaction:

1. Scoop runs `pre_install` before recording the new manifest version.
2. The Windows orchestrator calls the Ubuntu-us manual dispatcher via the
   existing SSH alias. Scheduled-task invocation without this opt-in is inert.
3. The dispatcher submits the exact selected official npm version to the
   GitHub Actions compatibility workflow **on demand**. Successful tests publish
   the integrity-verified approval for the same local bridge source digest.
4. The existing updater backs up SQLite and provider settings, installs the
   official Worker, verifies readiness and rolls back after a failed upgrade.
5. Windows then synchronizes npm CLI, Marketplace, Claude Code and Codex plugin
   to the healthy central version. Failures return nonzero to Scoop so that
   the package remains retryable. Already-current versions are verified only.

## Background behavior

- Ubuntu-us `claude-mem-update.timer` is disabled. The Worker service remains on.
- Windows `ClaudeMemCentralVersionSync-*` scheduled tasks were not removable
  without administrative rights, but the sync script now exits before any work
  unless `CLAUDE_MEM_MANUAL_UPDATE=1`, which Scoop sets solely for one operation.
- `claude-mem-auto-approve.yml` has no schedule and **publishes approval only
  on `workflow_dispatch`**, never on ordinary pushes or pull requests.
- The existing scoop-www Excavator updates **version metadata only** to show
  available updates in UniGetUI. It does not run any central or Windows installs.

A rejected CI test, Worker rollback, SSH error or local plugin-sync error is
reported as a failed UniGetUI operation. Retry the same Update after correcting
that failure. Do not remove the central compatibility gate or manually install
independent CLI/plugin versions. Uninstalling the Scoop control package does not
uninstall the real Worker or local memory clients.
