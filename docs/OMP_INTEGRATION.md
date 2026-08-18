# Oh My Pi (OMP) central-memory integration

`omp-extension/index.ts` connects Oh My Pi (`@oh-my-pi/pi-coding-agent`) to the same central `claude-mem` Worker used by the other bridges in this repository. It never starts a fallback Worker and never creates a second memory database.

## Tested baseline

The integration was implemented and validated with OMP 0.53.2 on 2026-08-18.

OMP's extension API differs from the older Pi Coding Agent API, so this is a separate extension rather than a copy of `pi-extension/`. In particular, OMP exposes `agent_end` with `willContinue` instead of the legacy Pi `agent_settled` event.

## Install

Set the central Worker endpoint in the environment:

```powershell
[Environment]::SetEnvironmentVariable(
  'CLAUDE_MEM_WORKER_URL',
  'https://your-central-worker.example',
  'User'
)
```

If the Worker requires a bearer token, set `CLAUDE_MEM_WORKER_TOKEN` through the host's secret-management mechanism. Do not commit it to this repository.

Copy the extension into OMP's user extension directory:

```text
~/.omp/agent/extensions/central-claude-mem.ts
```

Source file:

```text
omp-extension/index.ts
```

Restart OMP after installing the extension or changing user-level environment variables.

## Memory lifecycle

The bridge deliberately captures only the durable conversational boundary, not every tool event:

- `session_start` — resolves the OMP session/project identity.
- `before_agent_start` — initializes the central session, fetches project-scoped context, and injects it as a hidden OMP custom message.
- `turn_end` — remembers the latest assistant text for the current run.
- `agent_end` — when `willContinue` is false, writes the final assistant observation and queues central summarization.
- `session_shutdown` — best-effort final flush if a completed turn is still pending.

Automatic capture excludes tool outputs. This keeps the central memory pool focused on user intent, final work results, decisions, and summaries while OMP retains its own local transcript/tool history.

## Source and project identity

OMP is intentionally distinct from Pi:

```text
platform_source = omp
project         = omp-<cwd basename>
content session = omp-<OMP session id>
```

This prevents OMP sessions from being grouped under `pi` in the central Viewer or source filters.

The bridge always sends explicit `platformSource: "omp"`. The central deployment also has a compatibility fallback that infers `omp` from `omp` / `oh-my-pi` / `omp-*` project or content-session prefixes if an older caller omits the explicit source.

## Tools

The extension registers three OMP tools:

- `claude_mem_search` — cross-project central-memory search (`read`).
- `claude_mem_recent` — recent memory for one known project (`read`).
- `claude_mem_remember` — explicit durable-memory write (`write`).

The extension also performs best-effort secret redaction before sending captured text to the central Worker. This is defense in depth, not a substitute for keeping credentials out of prompts.

## Viewer identity and icon

The central Viewer renders OMP as its own source badge:

```text
OMP
```

The artwork is the current official OMP favicon published by `https://omp.sh/favicon.svg`: a dark rounded square with a pink/purple/cyan gradient pi-like mark. Production keeps a reviewed local copy beside the Viewer as:

```text
omp-favicon.svg
```

`deploy/apply-claude-mem-viewer-branding.mjs` uses the local file first and the official `omp.sh` favicon as a network fallback.

## Upgrade persistence

A `claude-mem` upgrade can replace the bundled Viewer and Worker files. Production therefore reapplies two local overlays after upstream replacement:

1. platform-source registry/fallback logic, including `omp`;
2. Viewer icon/name branding, including the local `omp-favicon.svg` asset.

The overlay is intentionally non-blocking relative to the official `claude-mem` updater: an upstream UI-layout change should produce a warning rather than prevent the official upgrade or rollback.

## Validation

The 2026-08-18 production validation confirmed:

- a real OMP process loaded the extension and created central sessions under project `omp-AgentDock` with `platform_source=omp` before provider execution;
- an extension lifecycle harness exercised OMP's `before_agent_start`, `turn_end`, final `agent_end`, and `session_shutdown` path against the real central Worker;
- automatic context injection returned non-empty central context;
- the test marker `OMP_CMEM_BRIDGE_E2E_20260818_1149` produced central observation `#8454` under `platform_source=omp` and was searchable through the central observation-search API;
- `/api/projects` listed `omp` as an independent source with `omp-AgentDock` in `projectsBySource`;
- the live `omp-favicon.svg` endpoint returned HTTP 200 and matched the persistent reviewed copy byte-for-byte;
- marketplace and active versioned-cache Viewer copies passed the branding check after deployment.

The OMP model/provider configured on that Windows installation returned an unrelated provider `401 Invalid token` during the real model-generation smoke test. That did not affect extension loading, central session initialization, source attribution, the separately exercised capture path, or Viewer deployment; provider authentication is outside this bridge.
