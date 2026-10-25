# OpenClaw Central Memory Admin

A small tool-only OpenClaw plugin that adds `claude_mem_preview_delete` and `claude_mem_forget` beside the official OpenClaw/`claude-mem` integration. It does not patch or replace the official memory plugin.

The tool is marked `optional: true`, so enable/allowlist it only for agents that should be able to delete central-memory records.

## Worker endpoint

Resolution order:

1. plugin config `workerUrl`;
2. `CLAUDE_MEM_WORKER_URL`;
3. `http://127.0.0.1:37777`.

If the Worker requires bearer authentication, provide `CLAUDE_MEM_WORKER_TOKEN` through the OpenClaw process environment or secret-management layer. Do not put tokens in this repository.

## Install

Install/link this package with the normal OpenClaw plugin workflow, then restart or reload the Gateway and explicitly allow the optional `claude_mem_preview_delete` and `claude_mem_forget` tools for the desired agent.

First call `claude_mem_preview_delete` with exact IDs:

```json
{
  "items": [
    { "type": "observation", "id": 8564 },
    { "type": "summary", "id": 1865 },
    { "type": "prompt", "id": 2038 }
  ]
}
```

Use the official `claude-mem` search/recent/timeline facilities first. Never guess IDs or perform fuzzy destructive deletion.

See [`../docs/MEMORY_ADMIN.md`](../docs/MEMORY_ADMIN.md) for the shared architecture and limitations.

Then show the exact preview to the user. Only after explicit approval, call `claude_mem_forget` with the same `items` and returned `previewToken` and `confirmationText`, plus `confirm: true`. Tokens expire after five minutes, are one-use, and are bound to the exact Worker and IDs. No free-text or bulk deletion is allowed.
