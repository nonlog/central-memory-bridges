# Central-memory exact-ID administration

This repository adds a small destructive administration layer **beside** the official `claude-mem` integrations. The goal is to let supported agents delete specific unwanted/test records without forking or patching the official Claude Code, Codex, or OpenClaw memory integrations.

## Why this is separate

`claude-mem` already exposes production DELETE routes in its Worker:

```text
DELETE /api/observation/:id
DELETE /api/summary/:id
DELETE /api/prompt/:id
```

Upstream implementation: <https://github.com/thedotmack/claude-mem/blob/main/src/services/worker/http/routes/DataRoutes.ts>

The upstream delete path is sync-aware: it validates canonical positive IDs, deletes only the local-origin row through the supported Worker surface, and queues a cloud-sync tombstone when cloud sync is configured. It can refuse a delete when sync identity is unavailable rather than silently stranding replicas. For that reason these bridges call the Worker API and never edit SQLite directly.

The official memory integrations do not currently expose these DELETE routes as normal agent tools. Rather than patching upstream packages, this repository adds one stable tool contract:

```text
claude_mem_forget
```

with exact records only:

```json
{
  "items": [
    { "type": "observation", "id": 8564 },
    { "type": "summary", "id": 1865 },
    { "type": "prompt", "id": 2038 }
  ]
}
```

## Safety contract

The administration layer intentionally does **not** implement fuzzy deletion, project wipe, date-range deletion, or free-text bulk deletion.

Required workflow:

```text
official claude-mem search / recent / timeline
                    ↓
          enumerate exact records
                    ↓
       user intent is unambiguous
                    ↓
 claude_mem_forget(type + numeric id)
                    ↓
       Worker official DELETE route
```

The tool accepts at most 50 exact records per call and de-duplicates repeated `type:id` pairs before sending requests.

## Claude Code

Keep the official `claude-mem` plugin unchanged. Register `memory-admin-mcp/server.mjs` as an additional stdio MCP server using your normal Claude Code user/project MCP configuration.

Server process:

```text
command: node
args: [/absolute/path/to/central-memory-bridges/memory-admin-mcp/server.mjs]
```

Set the Worker endpoint in the process environment:

```text
CLAUDE_MEM_WORKER_URL=https://your-central-worker.example
```

Optional bearer authentication uses `CLAUDE_MEM_WORKER_TOKEN`. The server also supports a non-secret URL file at `~/.central-memory/worker-url` or `CLAUDE_MEM_WORKER_URL_FILE` when long-running terminals have an old environment snapshot.

Claude Code supports independently configured MCP servers, including stdio servers, so this administration server can coexist with the official `claude-mem` plugin without changing its files. See the Claude Code MCP integration reference in the Anthropic repository: <https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/mcp-integration/SKILL.md>.

## Codex

Keep the official Codex/`claude-mem` hooks and MCP integration unchanged. Add the same stdio server as a second MCP server:

```bash
codex mcp add central-memory-admin -- node /absolute/path/to/central-memory-bridges/memory-admin-mcp/server.mjs
```

Codex's current MCP CLI supports independent `add`, `remove`, `login`, and `logout` operations and stdio launchers. Upstream implementation: <https://github.com/openai/codex/blob/main/codex-rs/cli/src/mcp_cmd.rs>.

Provide `CLAUDE_MEM_WORKER_URL` (and, when needed, `CLAUDE_MEM_WORKER_TOKEN`) in the environment inherited by Codex/the MCP child process.

## OpenClaw

Keep the official OpenClaw `claude-mem` plugin unchanged. Install/link the package:

```text
openclaw-memory-admin/
```

It is a tool-only plugin built on OpenClaw's `defineToolPlugin` API and registers only:

```text
claude_mem_forget
```

The tool is intentionally marked `optional: true`; explicitly allowlist it only for agents that should have destructive memory administration.

Worker URL resolution order:

1. plugin config `workerUrl`;
2. `CLAUDE_MEM_WORKER_URL`;
3. loopback `http://127.0.0.1:37777`.

The loopback default is appropriate when OpenClaw and the central Worker run on the same host and avoids routing a destructive request through the public endpoint. OpenClaw's official tool-plugin SDK supports independently registered agent tools without modifying another plugin: <https://github.com/openclaw/openclaw/blob/main/docs/plugins/tool-plugins.md>.

## OMP

OMP is maintained by this repository rather than by upstream `claude-mem`, so its native bridge exposes the same `claude_mem_forget` contract directly in `omp-extension/index.ts`.

OMP additionally suppresses automatic capture of the cleanup turn once after `claude_mem_forget`, preventing a deletion request from immediately generating a replacement meta-memory such as “deleted test memory #123”.

## Capture limitation for official integrations

The standalone admin MCP and OpenClaw admin plugin deliberately do not intercept the lifecycle of the official Claude Code/Codex/OpenClaw `claude-mem` integrations. Therefore a successful deletion can still be followed by normal upstream capture of the conversational statement describing that deletion.

That does not restore the deleted record, but it can produce a new, separate meta-memory. Avoid patching upstream capture only to suppress this edge case; if it becomes noisy in practice, handle the new record through the same exact-ID cleanup workflow.

## Failure behavior

A deletion can fail with:

- `404` — the exact record does not exist (or was already deleted);
- `400` — the ID is not a canonical positive decimal;
- `503` — upstream cloud-sync safety refused an unreplicated delete;
- network/authentication errors — the admin client cannot reach or authenticate to the central Worker.

Partial batches return both `deleted` and `failed` arrays. Successful records are not rolled back when another item in the same request fails.

## Security

- Treat `claude_mem_forget` as a destructive write tool.
- Use exact IDs and inspect records before deletion.
- Do not add fuzzy/project-wide deletion shortcuts.
- Prefer loopback access for same-host OpenClaw deployments.
- Keep Worker bearer tokens in environment/secret storage, never in Git.
- Do not expose the raw Worker admin surface to untrusted agents merely to gain deletion capability; expose this narrow exact-ID tool instead.
