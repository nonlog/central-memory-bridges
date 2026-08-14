# Central Memory Bridges

Integration source for connecting multiple AI clients to one central `claude-mem` Worker without creating additional active databases or Workers. The repository may be public; production credentials and runtime secrets are never part of the source tree.

## Components

- `hermes-provider/` — Hermes native `MemoryProvider` adapter. Automatic project-scoped recall and automatic turn capture; explicit cross-project search/recent tools.
- `pi-extension/` — Pi Coding Agent extension. `before_agent_start` automatic context injection, automatic post-run capture, and explicit search/recent/remember tools.
- `chatgpt-mcp/` — least-privilege remote MCP/OAuth bridge for ChatGPT Business. Exposes only central-memory operations, not host administration.
- `deploy/` — sanitized deployment examples plus repeatable local deployment helpers. Real credentials and runtime token state are intentionally excluded.
- `deploy/apply-claude-mem-viewer-branding.mjs` — idempotent CSS-only overlay that adds recognizable platform icons to `claude-mem` Viewer source badges without changing Worker/database behavior.

## Production model

One central `claude-mem` Worker remains the source of truth. Client adapters call its HTTP API; they must never start a fallback Worker or create a second active database.

Typical project scopes:

- Hermes: `hermes`, `hermes-<profile>`
- Pi: `pi`, `pi-<cwd basename>`
- ChatGPT Web: `chatgpt`, `chatgpt-web`

Claude Code/Codex and OpenClaw use their existing integrations and are not duplicated in this repository.

## claude-mem Viewer platform branding

The Viewer branding overlay keeps the upstream card/data model intact and decorates existing `platform_source` badges for ChatGPT, Codex, Claude, Pi, Hermes, and OpenClaw. It patches both the source Viewer template and the already-built Viewer HTML when those files are present.

Apply it from this repository with:

```bash
node deploy/apply-claude-mem-viewer-branding.mjs --root /path/to/claude-mem
node deploy/apply-claude-mem-viewer-branding.mjs --root /path/to/claude-mem --check
```

Reapply it after `claude-mem` upgrades. The current patch is idempotent and replaces its own marked CSS block rather than accumulating duplicate overrides.

See [`docs/CLAUDE_MEM_VIEWER_BRANDING.md`](docs/CLAUDE_MEM_VIEWER_BRANDING.md) for icon provenance, deployment behavior, verification, upgrade handling, rollback, external-asset behavior, and trademark notes.

## Security

- This source repository may be public; treat every committed file as world-readable.
- Never commit `.env`, OAuth secrets/tokens, Cloudflare credentials, htpasswd files, provider API keys, private keys, or exported conversations containing secrets.
- The ChatGPT bridge is loopback-only behind the existing reverse proxy/tunnel and has no shell/filesystem/Docker/AgentDock tools.
- Pi performs best-effort secret redaction before central persistence; this is defense in depth, not a substitute for credential hygiene.
- Viewer branding contains no runtime credentials. It changes only Viewer HTML/CSS and does not alter the central-memory API or database.

## Validation baseline

Production integration was validated on 2026-08-14:

- Hermes: real write + fresh-session auto-recall already verified.
- Pi: real write to `pi-AgentDock`, then fresh session with all tools disabled recalled the previous marker using automatic context injection only; normal Pi continued central writes after `pi-hermes-memory` was removed.
- ChatGPT MCP: server-side OAuth registration/PKCE/refresh-capable token flow, MCP initialize/tools-list, central-memory read, and real write were verified. Final write marker `CHATGPT_MCP_FINAL_E2E_20260814_0957` returned `commit_status=committed` with a central observation; a second fresh OAuth/MCP client read the marker back, and the async claude-mem summary completed. A real ChatGPT Web conversation remains the final client-side validation after registering the custom MCP App in the Business workspace.
- Viewer branding patcher: Node syntax validation, source/live Viewer fixture patching, exact `--check` validation, and repeat-apply idempotence were verified on 2026-08-14. Production-host visual verification is tracked separately from the memory-pipeline validation above.
