# Central Memory Bridges

Integration source for connecting multiple AI clients to one central `claude-mem` Worker without creating additional active databases or Workers. The repository may be public; production credentials and runtime secrets are never part of the source tree.

## Components

- `hermes-provider/` — Hermes native `MemoryProvider` adapter. Automatic project-scoped recall and automatic turn capture; explicit cross-project search/recent plus cwd-scoped Work State tools (Worker 13.29+).
- `pi-extension/` — Pi Coding Agent extension aligned to upstream Claude-mem 13.34+ native prompt capture: persisted Pi `SessionEntry.id` identity, branch/retry-safe admission, privacy-gated context injection, ordered tool/summary capture, progressive recall (`mem_search` / `mem_timeline` / `mem_get_observations`), plus central-only search/recent/remember, optional semantic recall and cwd-scoped Work State tools.
- `chatgpt-mcp/` — least-privilege remote MCP/OAuth bridge for ChatGPT Business. Exposes only central-memory operations, not host administration; because ChatGPT has no real checkout cwd, it filters upstream cwd-bound Work State instructions instead of misrouting them to the bridge host.
- `memory-admin-mcp/` — standalone stdio MCP for Claude Code and Codex that adds only exact-ID `claude_mem_forget` beside their official `claude-mem` integrations.
- `openclaw-memory-admin/` — optional OpenClaw tool-only plugin exposing the same exact-ID `claude_mem_forget` contract without modifying the official OpenClaw `claude-mem` plugin.
- `deploy/` — sanitized deployment examples plus repeatable local deployment helpers. Real credentials and runtime token state are intentionally excluded.
- `deploy/apply-claude-mem-viewer-branding.mjs` — idempotent legacy Viewer badge CSS plus v14 My Work SVG identity overlay; official SVG mappings and Worker/database behavior stay unchanged.

## Production model

One central `claude-mem` Worker remains the source of truth. Client adapters call its HTTP API; they must never start a fallback Worker or create a second active database. ChatGPT Web and Gemini Web share the existing `/chatgpt-mcp/mcp` URL; OAuth client redirect origins distinguish their writes.

Typical project scopes:

- Hermes: `hermes`, `hermes-<profile>`
- Pi: `pi`, `pi-<cwd basename>`
- ChatGPT Web: `chatgpt`, `chatgpt-web`
- Gemini Web: `gemini`, `gemini-web`
- Claude Web: `claude-web` (distinct from Claude Code)
- Grok Web: `grok-web`
- Muse Web: `muse-web`
- Executor (default when Agent is not selected): `executor`

Claude Code, Codex, and OpenClaw continue to use their official `claude-mem` integrations for recall/capture/search. This repository adds only a narrow optional deletion layer beside them; it does not patch or fork the official integrations.

The custom OMP bridge was retired on 2026-10-06 and is no longer shipped or supported by this repository. Viewer/source-label compatibility for historical `platform_source=omp` records is retained.

Pi follows the upstream 13.34+ native-capture lifecycle instead of deriving turn identity from prompt text. `before_agent_start` only resets turn state; the awaited `context_with_system` phase validates the active persisted user entry from `sessionManager.getBranch()`, probes `/api/sessions/native-prompt-capability`, and sends that entry's real ID as `nativePromptId`. Context, tool observations and summaries are admitted only after the Worker acknowledges the current native prompt, so private/excluded turns, stale branches and failed init requests cannot inherit memory or create orphan captures. The remote central Worker transport (`CLAUDE_MEM_WORKER_URL`), client-side secret redaction, optional semantic injection, Work State and explicit cross-client tools remain custom extensions. `CLAUDE_MEM_SEMANTIC_INJECT` defaults to `false` with `CLAUDE_MEM_SEMANTIC_INJECT_LIMIT=5`.

## Pi installation

The Pi bridge is a standard Pi git package. Install it globally with:

```bash
pi install git:https://github.com/nonlog/central-memory-bridges
```

It then appears in `pi list` and is stored under Pi's managed git package directory instead of `~/.pi/agent/extensions/`.

Update it with either:

```bash
pi update git:https://github.com/nonlog/central-memory-bridges
# or update all managed Pi packages
pi update
```

If migrating from the legacy loose extension, remove `~/.pi/agent/extensions/central-claude-mem.ts` after the managed package is installed. Do not keep both copies enabled because both would register the same lifecycle handlers and tools.

## Claude-mem v15 search migration (pre-upgrade)

The Worker 15.0.1 release replaces guided `POST /api/mem-search` with
Smart index/timeline/detail retrieval and an optional `POST /api/dumb-search`.
Our ChatGPT MCP and Pi clients now select the correct 14.x/15.x contract at
runtime, retain the existing `mem_search` tool name, expose `dumb_search`
and refuse obsolete continuation tokens. Before upgrading a central Worker,
the unattended updater uses an **exact-version compatibility allowlist** to
hold unapproved releases without stopping any service. **15.0.1 remains held
until staged Worker/real-client verification is complete.** See
[`docs/CLAUDE_MEM_15_SEARCH_MIGRATION.md`](docs/CLAUDE_MEM_15_SEARCH_MIGRATION.md).

## Public Worker security and authenticated My Work

The official remote HTTP Spool transport is retained; its Bearer token protects
**Spool ingestion only**, not raw Worker API calls. The machine proxy now
blocks destructive and credential-bearing routes, moves the browser UI to
our existing Basic-Auth admin hostname, and exposes an authenticated
**read-only** My Work view without modifying upstream. See
[`docs/REMOTE_WORKER_SURFACE.md`](docs/REMOTE_WORKER_SURFACE.md) for the
remaining public context/search exposure, HTTP transport limitations,
rollback plan, and the coordinated client migration needed for full API auth.

## Exact-ID memory deletion

The central Worker already exposes official production DELETE routes for observations, summaries, and prompts. `memory-admin-mcp/` and `openclaw-memory-admin/` expose that capability through one constrained contract:

```json
{
  "items": [
    { "type": "observation", "id": 8564 },
    { "type": "summary", "id": 1865 },
    { "type": "prompt", "id": 2038 }
  ]
}
```

The administration layer deliberately does not implement fuzzy deletion, project wipes, or date-range bulk deletion. Use the normal `claude-mem` search/recent/timeline tools first, identify exact records, then delete by `type + numeric id`.

See [`docs/MEMORY_ADMIN.md`](docs/MEMORY_ADMIN.md) for Claude Code, Codex, and OpenClaw setup, sync-aware Worker behavior, failure modes, and security rules.

## claude-mem Viewer and My Work platform branding

The Viewer branding overlay keeps the upstream card/data model intact and decorates existing `platform_source` badges for ChatGPT, Gemini, Codex, Claude, Pi, Hermes, OpenClaw, and legacy OMP records. It supports source templates, installed/marketplace Viewer HTML, and versioned cache Viewer HTML.

Apply it from this repository with:

```bash
node deploy/apply-claude-mem-viewer-branding.mjs --root /path/to/claude-mem
node deploy/apply-claude-mem-viewer-branding.mjs --root /path/to/claude-mem --check
```

Reapply it after `claude-mem` upgrades. The patcher keeps official `agentIcon()` mappings and SVGs in My Work, adds missing Web/Pi/Hermes/Executor/OpenClaw identities with `bridge-*.svg` files, and checks both UIs without rewriting upstream behavior. It is idempotent; unknown upstream Work View function shapes fail closed. Automated upgrades apply and verify the overlay, while an already-current update check also verifies and repairs missing branding without restarting the Worker. Some `claude-mem` versions cache Viewer HTML at Worker startup, so verify the live response and restart/reload the Worker only when the served HTML remains stale.

See [`docs/CLAUDE_MEM_VIEWER_BRANDING.md`](docs/CLAUDE_MEM_VIEWER_BRANDING.md) for icon provenance, deployment behavior, verification, upgrade handling, rollback, external-asset behavior, and trademark notes.

## Web MCP memory capability matrix

ChatGPT Web, Gemini Web, Claude Web, Grok Web, Muse Web, and Executor can share the same `https://claude-mem.414222.xyz/chatgpt-mcp/mcp` Streamable HTTP endpoint and central Worker. OAuth client registration/callback determines platform_source. The original seven tools remain unchanged. Web MCP additionally exposes progressive search, durable manual notes, advanced search filters, timelines, observation/tool-use batches, exact record/list/project/stats retrieval, Work State read/write (stable virtual project cwd), TeamBrain query/brief, full session-start context, and Worker-supported deletion. Server-runtime-only `/v1/*` and filesystem/host admin capabilities are not routed to the central Worker.

Deletion tools `claude_mem_forget` and `memory_delete_session` require the separately requested OAuth `memory:delete` scope and explicit exact IDs with `confirm: true`. Existing grants remain read/write; reconnect and authorize that scope before using deletion. The Worker handles sync-safe deletion; no SQL or arbitrary Worker endpoint is exposed. The `memory_admin_permissions` tool reports the granted scopes. Some Web providers may not offer a scope selection UI; in that case deletion remains unavailable until the OAuth client requests the new scope.

### Executor agent-selected identity

The existing `claude_mem.user.sharedCentralMemory` connection is classified as `executor` based on its registered OAuth redirect URI (`executor.414222.xyz/api/oauth/callback`). It defaults to project `executor`, and memory writes without an explicit source use the `executor` Viewer icon. No fork or modification of Executor is necessary.

When connected through Executor, `memory_capture`, `memory_remember` and `save_memory` expose an optional enumerated `agent_identity` argument. Supported choices: `executor`, `claude` (Claude Code), `codex`, `chatgpt`, `gemini`, `claude-web`, `grok-web`, `muse-web`, `pi`, `omp`, `hermes`, `openclaw`. The Agent selects its own identity if known; if unsure, leave the field empty to use `executor`. Non-Executor OAuth clients cannot override the source. The selected source drives `platformSource` / Viewer icon, while the observation tool input or manual-memory metadata records that Executor was the transport.

**Important:** this is a self-declared Agent label. The existing Executor build does not cryptographically verify or forward the calling Agent's identity; do not treat `agent_identity` as an access-control claim. Actual authorization continues to use the existing OAuth scopes; delete tools retain separate `memory:delete` and Executor approval policies.

Muse Web maps its registered OAuth callback (`agent.meta.ai/api/hatch/oauth/callback`) to `muse-web`. The Viewer uses the official Muse SVG; Executor uses the official executor.sh favicon. Both are cached alongside the Viewer with the publisher URL as fallback.

## Security

- This source repository may be public; treat every committed file as world-readable.
- Never commit `.env`, OAuth secrets/tokens, Cloudflare credentials, htpasswd files, provider API keys, private keys, or exported conversations containing secrets.
- The ChatGPT bridge is loopback-only behind the existing reverse proxy/tunnel and has no shell/filesystem/Docker/AgentDock tools. OAuth `memory:read` permits recall/search only; `memory_capture` and `memory_remember` additionally require `memory:write` at tool execution time.
- Pi performs best-effort secret redaction before central persistence; this is defense in depth, not a substitute for credential hygiene.
- Treat `claude_mem_forget` as a destructive write tool. Require exact IDs, inspect records first, and do not add fuzzy/project-wide deletion shortcuts.
- Prefer loopback Worker access for the OpenClaw admin plugin when OpenClaw and `claude-mem` run on the same host.
- Official v13.41 remote Hook Spool replaces the custom Windows relay. Windows Claude Code/Codex use `CLAUDE_MEM_WORKER_HOST=claude-mem.414222.xyz`, port `80`, `CLAUDE_MEM_HOOK_SPOOL_TRANSPORT=http` and an ingest Bearer token. This token protects only the ingest route; the raw public Worker API is unauthenticated and HTTP is not encrypted. See [remote capture/auth documentation](docs/MEMORY_API_AUTH.md).
- Viewer branding contains no runtime credentials. It changes only Viewer HTML/CSS and does not alter the central-memory API or database.

## Validation baseline

Production integration was validated beginning on 2026-08-14:

- Hermes: real write + fresh-session auto-recall already verified.
- Pi: real write to `pi-AgentDock`, then fresh session with all tools disabled recalled the previous marker using automatic context injection only; normal Pi continued central writes after `pi-hermes-memory` was removed.
- ChatGPT MCP: server-side OAuth registration/PKCE/refresh-capable token flow, MCP initialize/tools-list, central-memory read, and real write were verified. Final write marker `CHATGPT_MCP_FINAL_E2E_20260814_0957` returned `commit_status=committed` with a central observation; a second fresh OAuth/MCP client read the marker back, and the async claude-mem summary completed. A real ChatGPT Web conversation subsequently validated automatic Claude-mem recall after the custom MCP App was published in the Business workspace.
- Viewer branding: the patcher passed Node syntax/idempotence checks, was deployed to the central `claude-mem` marketplace and active cache Viewer, and the live Worker response was verified after controlled restarts. The official-update flow must fail and roll back if the Worker platform identity patch cannot be reapplied; icon branding can still fail non-fatally. Legacy OMP source branding remains only to identify historical records.
- Memory administration: the shared design uses only upstream Worker DELETE endpoints; Claude Code/Codex receive the capability through a separate stdio MCP and OpenClaw through an optional tool-only plugin, leaving all official memory integrations untouched.
# Unified cross-project recall

The optional **Unified Memory Recall Bridge** integrates Claude-mem's global
operation history with Hindsight's per-project and central Banks. It preserves
upstream capture, Git ingest, and Knowledge Pages, and runs read-only queries
with bounded budgets, source-ID deduplication, and failure fallback.

Install in safe shadow mode and see the testing/rollout instructions in
[`recall-bridge/README.md`](recall-bridge/README.md). The bridge does not
change either upstream plugin, and it never stores API tokens in its config.
