# Oh My Pi (OMP) central-memory integration

`omp-extension/index.ts` connects Oh My Pi (`@oh-my-pi/pi-coding-agent`) to the same central `claude-mem` Worker used by the other bridges in this repository. It never starts a fallback Worker and never creates a second memory database.

## Tested baseline

The integration was implemented and validated with OMP 0.53.2 on 2026-08-18.

OMP's extension API differs from the older Pi Coding Agent API, so this is a separate extension rather than a copy of `pi-extension/`. In particular, OMP exposes `agent_end` with `willContinue` instead of the legacy Pi `agent_settled` event, and its settled `agent_end` notification can be detached from the main event path. The bridge therefore commits terminal assistant text from the awaited `message_end` event and keeps `turn_end`, `agent_end`, and `session_shutdown` as fallback/flush paths.

## Install

Set the central Worker endpoint in the environment:

```powershell
[Environment]::SetEnvironmentVariable(
  'CLAUDE_MEM_WORKER_URL',
  'https://your-central-worker.example',
  'User'
)
```

A long-running terminal can retain the environment snapshot from before that user variable was created. To avoid making memory availability depend on terminal restart timing, the extension also supports a non-secret URL file. When `CLAUDE_MEM_WORKER_URL` is absent from the OMP process, it reads:

```text
~/.omp/agent/claude-mem-worker-url
```

or the path named by `CLAUDE_MEM_WORKER_URL_FILE`. The file should contain only the central Worker base URL and a trailing newline is optional. Environment configuration wins when both are present.

If the Worker requires a bearer token, set `CLAUDE_MEM_WORKER_TOKEN` through the host's secret-management mechanism. Do not store a bearer token in the URL file and do not commit it to this repository.

Copy the extension into OMP's user extension directory:

```text
~/.omp/agent/extensions/central-claude-mem.ts
```

Source file:

```text
omp-extension/index.ts
```

Reload OMP extensions or restart OMP after installing/changing the extension. A newly opened process will also inherit updated user-level environment variables.

## Memory lifecycle

The bridge deliberately captures only the durable conversational boundary, not every tool event:

- `session_start` — resolves the OMP session/project identity.
- `before_agent_start` — initializes the central session, fetches project-scoped context, and injects it as a hidden OMP custom message.
- `message_end` — records assistant text; when the assistant message has a terminal stop reason (`stop`, `end_turn`, or `length`), the bridge immediately writes the final assistant observation and queues central summarization on OMP's awaited event path.
- `turn_end` — fallback tracking for the latest assistant text.
- `agent_end` — final fallback/flush when `willContinue` is false.
- `session_shutdown` — final best-effort flush if a completed turn is still pending.

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

The OMP extension itself lives under the OMP user extension directory and is not replaced by a `claude-mem` Worker upgrade. Keep its source synchronized with this repository when deploying bridge fixes.

The overlay is intentionally non-blocking relative to the official `claude-mem` updater: an upstream UI-layout change should produce a warning rather than prevent the official upgrade or rollback.

## Validation

The 2026-08-18 production validation confirmed:

- a real OMP process loaded the extension and created central sessions with `platform_source=omp` before provider execution;
- an extension lifecycle harness exercised OMP recall/capture against the real central Worker;
- automatic context injection returned non-empty central context;
- the original integration marker `OMP_CMEM_BRIDGE_E2E_20260818_1149` produced central observation `#8454` under `platform_source=omp`;
- a later real OMP session exposed an endpoint-resolution bug: the OMP process had inherited an older environment snapshot and logged `CLAUDE_MEM_WORKER_URL is not configured` even though the Windows user environment had subsequently been updated;
- the production fix added the URL-file fallback described above and moved terminal automatic capture onto `message_end`, which OMP awaits before the process can exit;
- with `CLAUDE_MEM_WORKER_URL` deliberately removed from the test process, a real OMP run successfully resolved the URL file, generated normally, automatically captured the terminal answer, and used the explicit remember tool in the same run;
- marker `OMP_AUTO_MEMORY_WRITE_OK_20260818_1440` produced central observations `#8487`, `#8488`, and `#8489`, all attributable to `platform_source=omp`; `#8487`/`#8489` were under `omp-general` and `#8488` was the explicit remember record;
- `/api/projects` exposes `omp` independently from Pi;
- the live `omp-favicon.svg` endpoint returned HTTP 200 and matched the persistent reviewed copy byte-for-byte;
- marketplace and active versioned-cache Viewer copies passed the branding check after deployment.

## Troubleshooting

If OMP can read memory through an MCP search tool but automatic recall/capture logs `CLAUDE_MEM_WORKER_URL is not configured`, the two paths are different integrations: MCP read availability does not prove that the OMP central-memory extension has a Worker endpoint. Check the OMP log under `~/.omp/logs`, verify the environment or `~/.omp/agent/claude-mem-worker-url`, then reload extensions/restart OMP.

`get_observations` accepts numeric observation IDs only. Search results prefixed with `P` are prompt IDs and cannot be passed to `get_observations`; this validation error is unrelated to OMP automatic memory capture.
