# Official Claude-mem: CI-approved central Worker updates

Central Worker on Ubuntu-us is the only version authority. Windows Claude Code,
Codex, npm CLI and marketplaces follow its healthy version. Do not independently
upgrade `npm/claude-mem` from UniGetUI.

## Automatic process

1. `.github/workflows/claude-mem-auto-approve.yml` checks npm's official latest
   release every 4 hours (also runs on relevant code changes or manual dispatch).
2. For a not-yet-approved release, Actions downloads the exact npm tarball,
   checks its published sha512 integrity and packaged Worker HTTP/MCP/Spool
   interfaces, runs bridge/API/admin/hook/upgrade tests, and exercises both
   production UI overlays on the actual release. Any failure **blocks** approval.
3. A successful master job writes the release, exact npm integrity, CI run ID
   and source digest to `deploy/worker-upgrade-approvals.json` using
   `Codex <codex@openai.com>` as author and committer.
4. Ubuntu-us `claude-mem-update.timer` checks daily. It fetches the CI approvals
   without pulling new executable code, verifies npm integrity and equality
   of local deployment source to CI-tested source, and upgrades only then.
   The existing snapshot, SQLite integrity check, startup/readiness check and
   rollback remain in the production update script.
5. After the central version is healthy, Windows scheduled tasks synchronize
   its npm CLI, Claude Code and Codex plugins; they never run a local Worker.

The historical fallback list `deploy/worker-upgrade-policy.json` is deliberately
small and is *not* the ongoing approval mechanism. If the CI job fails or the
VPS deploy code differs, the current healthy Worker keeps running; fix the
failing contract or deploy the tested bridge code before the next check.

## Inspect / repair

- Actions: `Claude-mem official release CI approval` workflow.
- Server: `systemctl status claude-mem-update.timer`,
  `journalctl -u claude-mem-update.service -n 50 --no-pager`, and
  `curl http://127.0.0.1:37777/api/health`.
- After validating CI and deployed source code, trigger a re-check with
  `systemctl start claude-mem-update.service` (never invoke `npx install`
  directly on production).
- On Windows: `~/.claude/maintenance/claude-mem-update-status.json` and
  `pwsh -NoLogo -NoProfile -File "$HOME/.claude/maintenance/sync-claude-mem-central.ps1"`.
  Add `-UpdateCentral` to request a server compatibility-gated check first.
- UniGetUI: enable Npm under package managers, then ignore only
  package `npm/claude-mem` for updates, not the entire Npm manager.

CI source checks cannot guarantee all real-world client behaviors. Production
still retains fail-closed compatibility verification and automatic rollback;
newly incompatible package layouts must be adapted in the bridge repository.
