# Unified Memory Recall Bridge

## Windows: official Hindsight MCP authentication

The official Hindsight Coding Agents MCP reads the bearer credential from
`apiToken` in its JSON config or `HINDSIGHT_API_TOKEN` in the process
environment. Codex/Claude Code sessions started **before** the Windows User
environment variable was set may launch MCP subprocesses without that
credential, causing `401 Invalid API key (no apiToken is configured)`.
Changing the Windows User environment does not retroactively update an
already-running terminal or agent process.

The user-owned `hindsight-mcp-bootstrap.cjs` avoids writing the token into
either agent's configuration. On each MCP launch it reads
`HINDSIGHT_API_TOKEN` from the current user's Windows registry
(`HKCU\\Environment`), falls back to `HINDSIGHT_API_KEY` or the process
environment, then starts the **unmodified official** MCP server in a separate
Node process with stdio forwarded unchanged. It does not log the credential.

After `node recall-bridge/install.mjs install` stages the bootstrap in
`~/.central-memory-bridges/runtime/`, the native `hindsight` MCP
registration in both `~/.codex/config.toml` and `~/.claude.json` can
point to that file instead of
`~/.hindsight/coding-agents/dist/mcp-server.js`; keep the existing
`HINDSIGHT_MCP_HARNESS` environment setting for each client.
Back up these settings before changing them.

The direct `hindsight-global` HTTP MCP registration is separate: it still
uses its own configured bearer token environment variable. This bootstrap
does not silently alter that HTTP registration.

Re-registering the official plugin may reset the native MCP executable path.
Check the MCP registration after an explicit reinstall. Existing running MCP
processes must be restarted for a changed executable path to take effect.

This is a **read-only** search fan-out for self-hosted Hindsight and upstream
Claude-mem, with no fork or changes to either upstream service.

## Ownership and integration

| Component | Continues to own |
| --- | --- |
| Claude-mem hooks / Pi extension | Original sessions, tool observations, summaries, work state, raw timeline |
| Hindsight Coding Agents | Project Bank routing, Git ingest, knowledge pages, mental models |
| This bridge | Per-prompt search, bank selection, deduplication, bounded context assembly |

On Windows:

1. Install in your *own checked-out repository* with
   `node recall-bridge/install.mjs install`. This stages three source files
   under `~/.central-memory-bridges/runtime` and merges one
   `UserPromptSubmit` hook each into `~/.codex/hooks.json` and
   `~/.claude/settings.json`. It backs up touched config first.
2. For Pi, install/update the *user-owned* `central-memory-bridges` package.
   Its existing extension contains the adapter.
3. The initial mode is **shadow**. Requests are made but output is not
   injected into the Agent. No files in upstream plugins are edited.
4. Read `~/.central-memory-bridges/recall-bridge.jsonl` for counts, latency
   and failure counts only. Queries, memory bodies, paths and tokens are NOT
   logged. Even in shadow mode, Claude-mem/Hindsight receive the queried
   prompt, which can consume their normal API budgets.

The `~/.central-memory-bridges/recall.json` config can include:

```json
{
  "mode": "shadow",
  "modes": {"codex": "shadow", "claude-code": "shadow", "pi": "shadow"},
  "timeoutMs": 8000,
  "maxChars": 8000,
  "maxCandidates": 12,
  "maxBanks": 5,
  "searchLimit": 8,
  "workerUrl": "https://claude-mem.414222.xyz",
  "hindsightUrl": "https://hindsight.414222.xyz",
  "hindsightTokenEnv": "HINDSIGHT_API_TOKEN"
}
```

The key is read from a **user environment variable** and never embedded in
the JSON config or log. With no Hindsight token, Claude-mem search still works.
Both APIs have an 8-second *total* time budget; an unavailable service is not
allowed to block the coding agent.

## Bank selection and dedup

The bridge resolves the canonical Git root (including linked worktrees) and
the official Hindsight `mapPathToBank` config. It always searches the current
project and `agent-central`; additional banks are chosen by names appearing
in the prompt and by project names from Claude-mem's global search results.
When only a few project banks exist, it searches all of them.

The `maxBanks` cap matters: **this is not an unbounded search across every
Bank when the number of projects exceeds the configured limit**. Expand
the cap only after checking latency and server cost. The global Claude-mem
index helps route vague, cross-project prompts.

The migration produced Hindsight document IDs such as
`cm-observation-00037438`. These are paired with the original Claude-mem
observation `37438` and deduplicated *without deleting either copy*.
Remaining similar content is deduplicated by normalized text.

Hindsight already uses its configured reranker inside each Bank. Cross-bank
ranking then combines those scores with token overlap and a current-project
boost. There is no additional reranking paid API call at this stage.

## Promotion from shadow to injection

`"mode": "inject"` (or a per-agent `modes` override) injects the tagged, sanitized cross-project memory
context on `UserPromptSubmit` for Codex and Claude Code, and on Pi's
`context_with_system` event. **Do not flip the switch before removing
the competing automatic history injection** or some history may appear twice.

* Hindsight can independently set `autoInject: "none"` while retaining
  `retainSessions: false`, Git history, pages, and MCP.
* The Pi adapter knows how to suppress only the original *history context*,
  while keeping Claude-mem's capture and Work State.
* The upstream Claude-mem Claude Code/Codex plugins automatically inject
  current-project history at SessionStart. This bridge intentionally does
  **not** edit either plugin. In inject mode, the bridge filters out
  migrated current-project history to avoid repeating that data; it still
  injects relevant cross-project history and Hindsight-only knowledge.
  Exact duplicate detection against another hook's hidden output is not
  possible, so review actual session logs before calling this duplicate-free.
* Codex plugin hook review/trust may be required for new hooks.

Use `node recall-bridge/install.mjs remove` to remove only the two
user-owned hooks and set mode to off. It leaves both official memory
products untouched. Backups are under
`~/.central-memory-bridges/backups`.

## Validation

```sh
node --test recall-bridge/core.test.mjs
node --check recall-bridge/hook.mjs
node recall-bridge/install.mjs status
```
