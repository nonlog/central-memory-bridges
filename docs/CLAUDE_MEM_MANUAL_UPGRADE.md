# Claude-mem: manual updates across multiple computers

**Entry point:** UniGetUI > Software Updates > Scoop > `claude-mem-central` > **Update**.
The original npm/claude-mem package is intentionally ignored inside UniGetUI;
updating it directly would update only the local CLI and break the central pin.

`nonlog/scoop-www` exposes the separate Scoop package. Its existing Excavator
checks official npm version metadata and updates the Scoop *manifest only*;
**it never installs or upgrades Claude-mem**. UniGetUI shows an available
update when Scoop has refreshed its bucket metadata.

Clicking Update first installs the checked, commit-pinned Windows updater files
from the Scoop package into the **current user's** maintenance directory. The
central release and this computer's synchronization are separate operations:

1. Scoop runs `pre_install` before recording the new manifest version.
2. The Windows orchestrator reads the healthy central version first. If it is
   already at or above the selected version, only this computer is synchronized,
   without requiring SSH. Otherwise the existing SSH alias invokes the dispatcher.
3. The dispatcher submits the exact selected official npm version to the
   GitHub Actions compatibility workflow **on demand**. Successful tests publish
   the integrity-verified approval for the same local bridge source digest.
4. The existing updater backs up SQLite and provider settings, installs the
   official Worker, verifies readiness and rolls back after a failed upgrade.
5. Windows then synchronizes npm CLI, Marketplace, Claude Code and Codex plugin
   to the healthy central version. Failures return nonzero to Scoop so that
   the package remains retryable. Already-current versions are verified only.

The dispatcher serializes all computers with the same server-side lock. A second
request waits up to one hour, reads the version again after obtaining the lock,
and reuses the first successful upgrade. A stale request never downgrades the
central Worker. Each computer also has a local mutex. If another central upgrade
finishes during client synchronization, the client follows the newly healthy
version, with at most three attempts. A local failure never rolls back a healthy
central release or changes another computer's files.

## Retry only this computer

After a central upgrade succeeds, a failed or delayed computer can run:

```powershell
& "$env:USERPROFILE\.claude\maintenance\sync-claude-mem-central.ps1" -SyncLocal
```

This explicit action uses the live central version and never submits CI,
upgrades, restarts or downgrades the central Worker. It retries the official
capture outbox after synchronization. Restart the local Claude/Codex host to
load its new plugin. Status is stored in `claude-mem-update-status.json` with
computer name, profile path and the actual component versions; the Scoop control
package's selected metadata version can lag a central release installed by
another computer.

## New computer

Use the same `claude-mem-central` Scoop package, or run
`deploy/windows/install-central-client.ps1` from a verified repository checkout.
The installer backs up old updater files and initializes only the current user.
It respects `CLAUDE_CONFIG_DIR` and `CODEX_HOME`; it contains no IOTFRESH/Log
paths. Git, Node/npm, Bun, Claude Code and Codex must already be installed.

Configure the existing central ingest credential in that computer's
`.claude-mem/settings.json` or process environment first. The installer never
copies credentials or an entire profile from another computer. It initializes
the official marketplace, native hook launcher, and Claude/Codex registrations,
then follows the healthy central version. Local synchronization does not require
server SSH access. `-InstallOnly` installs the updater files without changing
clients; central upgrades remain a separate explicit action.

## Version skew and queued records

The V2 remote guard always lets official write handlers persist captures to the
official `state/hook-spool`. It checks health and compatibility in the separate
`upload-spool` process instead. Unknown combinations or outages hold uploads;
an exact receipt is still required before the official queue removes an event.
No second queue, background relay or scheduled updater is installed.

`central-client-compatibility.json` permits only explicitly tested **capture**
pairs. Initially 15.9.0 can upload to 15.10.0: CI checks the unchanged official
spool/ingest source contract and exercises real published clients, a version
hold, a wrong receipt and a successful retry. This is not a claim that every
read API is interchangeable. Context hooks still request local sync/restart
when versions differ. Other future pairs must pass those tests before adding
them. Known retained plugin caches receive the new guard too, so a host still
running its old plugin can preserve captures until it restarts.

The guard writes `state/central-client-status.json` per local data directory.
This reports compatibility/readiness, not proof that every queued event has
already been processed into a memory.

## Background behavior

- Ubuntu-us `claude-mem-update.timer` is disabled. The Worker service remains on.
- Windows `ClaudeMemCentralVersionSync-*` scheduled tasks were not removable
  without administrative rights, but the sync script now exits before any work
  unless `CLAUDE_MEM_MANUAL_UPDATE=1` (set by Scoop for one operation) or the
  user explicitly invokes `-SyncLocal`. No scheduled local sync is enabled.
- `claude-mem-auto-approve.yml` has no schedule and **publishes approval only
  on `workflow_dispatch`**, never on ordinary pushes or pull requests.
- The existing scoop-www Excavator updates **version metadata only** to show
  available updates in UniGetUI. It does not run any central or Windows installs.

A rejected CI test, Worker rollback, SSH error or local plugin-sync error is
reported as a failed UniGetUI operation. Retry the same Update after correcting
that failure. Do not remove the central compatibility gate or manually install
independent CLI/plugin versions. Uninstalling the Scoop control package does not
uninstall the real Worker or local memory clients.
