# claude-mem Viewer platform branding

This repository carries a repeatable Viewer overlay for the central `claude-mem` deployment. It decorates the existing `platform_source` badges with recognizable product icons while leaving the Worker API, database, capture pipeline, and memory semantics unchanged.

## Supported sources

| Platform | Source aliases | Artwork source |
| --- | --- | --- |
| ChatGPT | `chatgpt`, `chatgpt-web`, `ChatGPT` | OpenAI Blossom symbol; Wikimedia is used only as a transport mirror because the direct favicon endpoints can reject anonymous cross-site image requests |
| Codex | `codex`, `codex-cli`, `Codex` | Reviewed local copy of the official Codex app asset, `codex-app-ga-logo.png`; Blossom fallback |
| Claude | `claude`, `claude-code`, `Claude` | Reviewed local copy of the official `claude.ai/favicon.ico`, served as `claude-favicon.ico`; remote official favicon fallback |
| Pi | `pi`, `Pi` | `https://pi.dev/logo-auto.svg` |
| OMP / Oh My Pi | `omp`, `oh-my-pi`, `OMP` | Current official `https://omp.sh/favicon.svg`, copied locally as `omp-favicon.svg`; official URL fallback |
| Hermes | `hermes`, `hermes-agent`, `Hermes` | Official NousResearch Hermes Agent 32×32 favicon, copied locally as `hermes-favicon-32.png` |
| OpenClaw | `openclaw`, `OpenClaw` | Current official OpenClaw Control UI favicon, copied locally as `openclaw-favicon.svg` |

Unknown sources keep the upstream text-only behavior.

## Apply and verify

Run the branding patcher against an installed, marketplace, cache, or source copy of `claude-mem`:

```bash
node deploy/apply-claude-mem-viewer-branding.mjs --root /path/to/claude-mem
node deploy/apply-claude-mem-viewer-branding.mjs --root /path/to/claude-mem --check
```

The patcher recognizes these Viewer layouts when present:

```text
src/ui/viewer-template.html
plugin/ui/viewer.html
ui/viewer.html
```

It is idempotent and replaces only the block between:

```text
/* central-memory-bridges: platform-source-icons:start */
/* central-memory-bridges: platform-source-icons:end */
```

Some `claude-mem` releases cache `viewer.html` at Worker startup. After patching, fetch the live Viewer response and restart/reload the Worker only when the served HTML is still stale.

## Local artwork

Production keeps reviewed local copies of artwork that should not depend on a cross-origin request at view time. These files live outside the public repository and are copied beside each active `viewer.html`:

```text
codex-app-ga-logo.png
claude-favicon.ico
omp-favicon.svg
hermes-favicon-32.png
openclaw-favicon.svg
```

The OMP asset is the favicon currently published by `omp.sh`. The reviewed production copy has SHA-256:

```text
9419975a0c24961341221c4cec18703db26a989fa037768f92cda74e3769fe05
```

It is a 64×64 SVG with a dark rounded square and the pink/purple/cyan gradient OMP mark. The Viewer uses the local `omp-favicon.svg` first and the official `https://omp.sh/favicon.svg` as a fallback.

## Upgrade persistence

An official `claude-mem` upgrade may replace both Viewer files and the bundled Worker. The production update flow therefore reapplies, in order:

1. the local platform-source registry/fallback overlay, including `omp`;
2. reviewed local icon assets for marketplace and active cache Viewer copies;
3. this Viewer branding patch.

The OMP Worker compatibility fallback infers `platform_source=omp` from `omp`, `oh-my-pi`, or `omp-*` project/content-session identifiers when an older caller omits an explicit source. The current OMP extension sends `platformSource: "omp"` explicitly, so the fallback is defensive compatibility rather than the primary path.

Branding/reapply failures are intentionally non-blocking relative to the official updater: an upstream layout change should be logged for repair rather than prevent the official `claude-mem` update or rollback.

## Verification checklist

1. Run the patcher with `--check` against marketplace and active cache roots.
2. Confirm the live Viewer HTML contains the branding marker and `omp-favicon.svg`.
3. Confirm local icon endpoints return HTTP 200 and match their reviewed persistent copies.
4. Confirm `/api/projects` exposes each expected `platform_source`, including `omp` when OMP has written memory.
5. Open the Viewer, hard-refresh it, and verify Prompt/Summary/Observation badges in light and dark themes.

## Production validation

The platform branding overlay was originally deployed and refined during 2026-08-14 through 2026-08-16. OMP support was added and validated on 2026-08-18.

OMP validation confirmed:

- marketplace and active versioned-cache Viewer HTML passed the branding `--check`;
- the live Viewer HTML referenced `omp-favicon.svg`;
- the live OMP icon endpoint returned HTTP 200 and matched the persistent reviewed copy byte-for-byte;
- the source registry exposed `omp` independently from `pi`;
- `/api/projects` reported `omp-AgentDock` under `projectsBySource.omp` after OMP memory traffic;
- the central Worker remained healthy on `claude-mem` 13.15.0 with MCP ready after the controlled restart.

See [`OMP_INTEGRATION.md`](OMP_INTEGRATION.md) for the OMP bridge lifecycle and end-to-end memory validation.

## Rollback

Restore the Viewer files from the installed `claude-mem` version or a deployment backup, or remove the marked branding block. If the Worker cached the old/new Viewer at startup, restart/reload it after rollback. No memory database rollback is required for a branding-only rollback.

## Trademark note

Product names and logos remain trademarks of their respective owners. The marks are used only to identify the source client in the private memory Viewer and must not imply sponsorship or endorsement. Do not assume that a publicly reachable brand asset is an unrestricted software asset; review the relevant license/trademark terms before redistributing artwork.
