# Central Memory Admin MCP

A deliberately small stdio MCP server that adds a two-stage `claude_mem_preview_delete` / `claude_mem_forget` workflow, alongside an existing official `claude-mem` integration.

It is intended for Claude Code and Codex. It does **not** replace or patch the official `claude-mem` plugin/hooks/MCP; those integrations continue to own recall, capture, search, and summarization.

## Install

```bash
cd memory-admin-mcp
npm install
```

Configure the Worker endpoint through the environment:

```text
CLAUDE_MEM_WORKER_URL=https://your-central-worker.example
```

Optional bearer authentication uses `CLAUDE_MEM_WORKER_TOKEN`. If the URL is not present in the process environment, the server also reads a non-secret URL from `~/.central-memory/worker-url`, or the file named by `CLAUDE_MEM_WORKER_URL_FILE`.

Register this script as a stdio MCP server in Claude Code or Codex:

```text
command: node
args: [/absolute/path/to/central-memory-bridges/memory-admin-mcp/server.mjs]
```

First call `claude_mem_preview_delete` with exact record identifiers:

```json
{
  "items": [
    { "type": "observation", "id": 8564 },
    { "type": "summary", "id": 1865 },
    { "type": "prompt", "id": 2038 }
  ]
}
```

Always identify the records with the normal `claude-mem` search/recent/timeline tools before deleting them. Do not guess IDs and do not treat free-text deletion requests as permission for fuzzy bulk deletion.

See [`../docs/MEMORY_ADMIN.md`](../docs/MEMORY_ADMIN.md) for architecture, client setup, limitations, and security behavior.

Then show the exact preview to the user. Only after explicit approval, call `claude_mem_forget` with the same `items` and returned `previewToken` and `confirmationText`, plus `confirm: true`. Tokens expire after five minutes, are one-use, and are bound to the exact Worker and IDs. No free-text or bulk deletion is allowed.
