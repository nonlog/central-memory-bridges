# Central Memory Bridges

Integration source for connecting multiple AI clients to one central `claude-mem` Worker without creating additional active databases or Workers. The repository may be public; production credentials and runtime secrets are never part of the source tree.

## Components

- `hermes-provider/` — Hermes native `MemoryProvider` adapter. Automatic project-scoped recall and automatic turn capture; explicit cross-project search/recent tools.
- `pi-extension/` — Pi Coding Agent extension. `before_agent_start` automatic context injection, automatic post-run capture, and explicit search/recent/remember tools.
- `omp-extension/` — Oh My Pi (OMP) extension. Uses OMP's native extension lifecycle for automatic recall/final-turn capture plus explicit search/recent/remember/forget tools, with `platform_source=omp` kept distinct from Pi.
- `chatgpt-mcp/` — least-privilege remote MCP/OAuth bridge for ChatGPT Business. Exposes only central-memory operations, not host administration.
- `memory-admin-mcp/` — standalone stdio MCP for Claude Code and Codex that adds only exact-ID `claude_mem_forget` beside their official `claude-mem` integrations.
- `openclaw-memory-admin/` — optional OpenClaw tool-only plugin exposing the same exact-ID `claude_mem_forget` contract without modifying the official OpenClaw `claude-mem` plugin.
- `deploy/` — sanitized deployment examples plus repeatable local deployment helpers. Real credentials and runtime token state are intentionally excluded.
- `deploy/apply-claude-mem-viewer-branding.mjs` — idempotent CSS-only overlay that adds recognizable platform icons to `claude-mem` Viewer source badges without changing Worker/database behavior.

## Production model

One central `claude-mem` Worker remains the source of truth. Client adapters call its HTTP API; they must never start a fallback Worker or create a second active database.

Typical project scopes:

- Hermes: `hermes`, `hermes-<profile>`
- Pi: `pi`, `pi-<cwd basename>`
- OMP: `omp`, `omp-<cwd basename>`
- ChatGPT Web: `chatgpt`, `chatgpt-web`

Claude Code, Codex, and OpenClaw continue to use their official `claude-mem` integrations for recall/capture/search. This repository adds only a narrow optional deletion layer beside them; it does not patch or fork the official integrations.

See [`docs/OMP_INTEGRATION.md`](docs/OMP_INTEGRATION.md) for OMP installation, lifecycle mapping, source identity, validation, and upgrade behavior.

## Exact-ID memory deletion

The central Worker already exposes official production DELETE routes for observations, summaries, and prompts. `memory-admin-mcp/`, `openclaw-memory-admin/`, and the OMP-native `claude_mem_forget` tool expose that capability through one constrained contract:

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

See [`docs/MEMORY_ADMIN.md`](docs/MEMORY_ADMIN.md) for Claude Code, Codex, OpenClaw, and OMP setup, sync-aware Worker behavior, failure modes, and security rules.

## claude-mem Viewer platform branding

The Viewer branding overlay keeps the upstream card/data model intact and decorates existing `platform_source` badges for ChatGPT, Codex, Claude, Pi, OMP, Hermes, and OpenClaw. It supports source templates, installed/marketplace Viewer HTML, and versioned cache Viewer HTML.

Apply it from this repository with:

```bash
node deploy/apply-claude-mem-viewer-branding.mjs --root /path/to/claude-mem
node deploy/apply-claude-mem-viewer-branding.mjs --root /path/to/claude-mem --check
```

Reapply it after `claude-mem` upgrades. The current patch is idempotent and replaces its own marked CSS block rather than accumulating duplicate overrides. Some `claude-mem` versions cache Viewer HTML at Worker startup, so verify the live response and restart/reload the Worker only when the served HTML remains stale.

See [`docs/CLAUDE_MEM_VIEWER_BRANDING.md`](docs/CLAUDE_MEM_VIEWER_BRANDING.md) for icon provenance, deployment behavior, verification, upgrade handling, rollback, external-asset behavior, and trademark notes.

## Security

- This source repository may be public; treat every committed file as world-readable.
- Never commit `.env`, OAuth secrets/tokens, Cloudflare credentials, htpasswd files, provider API keys, private keys, or exported conversations containing secrets.
- The ChatGPT bridge is loopback-only behind the existing reverse proxy/tunnel and has no shell/filesystem/Docker/AgentDock tools.
- Pi and OMP perform best-effort secret redaction before central persistence; this is defense in depth, not a substitute for credential hygiene.
- Treat `claude_mem_forget` as a destructive write tool. Require exact IDs, inspect records first, and do not add fuzzy/project-wide deletion shortcuts.
- Prefer loopback Worker access for the OpenClaw admin plugin when OpenClaw and `claude-mem` run on the same host.
- Viewer branding contains no runtime credentials. It changes only Viewer HTML/CSS and does not alter the central-memory API or database.

## Validation baseline

Production integration was validated on 2026-08-14 and extended with OMP on 2026-08-18:

- Hermes: real write + fresh-session auto-recall already verified.
- Pi: real write to `pi-AgentDock`, then fresh session with all tools disabled recalled the previous marker using automatic context injection only; normal Pi continued central writes after `pi-hermes-memory` was removed.
- OMP: OMP 0.53.2 loaded the dedicated extension and created `omp-AgentDock` sessions with `platform_source=omp`; the full extension lifecycle was exercised against the real central Worker, automatic context injection returned data, marker `OMP_CMEM_BRIDGE_E2E_20260818_1149` produced central observation `#8454`, and the Viewer source/icon layer was deployed with the official `omp.sh` favicon. Exact-ID observation/summary/prompt cleanup was later verified through the Worker's official DELETE routes.
- ChatGPT MCP: server-side OAuth registration/PKCE/refresh-capable token flow, MCP initialize/tools-list, central-memory read, and real write were verified. Final write marker `CHATGPT_MCP_FINAL_E2E_20260814_0957` returned `commit_status=committed` with a central observation; a second fresh OAuth/MCP client read the marker back, and the async claude-mem summary completed. A real ChatGPT Web conversation subsequently validated automatic Claude-mem recall after the custom MCP App was published in the Business workspace.
- Viewer branding: the patcher passed Node syntax/idempotence checks, was deployed to the central `claude-mem` 13.15.0 marketplace and active cache Viewer, and the live Worker response was verified after controlled restarts. The existing weekly official-update flow now reapplies the platform identity layer and icon branding non-blockingly after upstream replacement, including OMP's source identity and favicon.
- Memory administration: the shared design uses only upstream Worker DELETE endpoints; Claude Code/Codex receive the capability through a separate stdio MCP and OpenClaw through an optional tool-only plugin, leaving all official memory integrations untouched.
