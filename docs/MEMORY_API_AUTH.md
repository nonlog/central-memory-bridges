# Central Worker remote capture and authentication (current deployment)

As of 2026-10-17 the Ubuntu-us central Worker is Claude-mem v13.41.0, with
the **official remote HTTP hook spool**. The former custom Windows spool relay,
HTTP authentication gateway, `ClaudeMemCentralSpoolRelay` task, and
`X-Claude-Mem-Key` Nginx map have been retired. Do not reinstall them.

## Windows Claude Code / Codex

Configure these in `%USERPROFILE%\.claude-mem\settings.json` and, where
relevant, in the `env` section of `%USERPROFILE%\.claude\settings.json`:

```json
{
  "CLAUDE_MEM_RUNTIME": "worker",
  "CLAUDE_MEM_WORKER_HOST": "claude-mem.414222.xyz",
  "CLAUDE_MEM_WORKER_PORT": "80",
  "CLAUDE_MEM_WORKER_AUTOSTART": "false",
  "CLAUDE_MEM_HOOK_SPOOL_TRANSPORT": "http"
}
```

`CLAUDE_MEM_WORKER_INGEST_TOKEN` must also be set to **the same secret** in
each client and the central Worker's `settings.json`, but NEVER commit it or
print it in logs. Official hook events are durably queued in the client's
`state/hook-spool` and uploaded to `POST /api/spool/ingest` with
`Authorization: Bearer <token>`. A 202 receipt only confirms handoff;
observation generation happens afterward. On failure a later hook retries.

Official clients construct Worker API URLs as
`http://<CLAUDE_MEM_WORKER_HOST>:<CLAUDE_MEM_WORKER_PORT>` in v13.41.0.
The current Windows setup therefore uses public HTTP port 80, **without an
SSH tunnel or proxy**. It does not transparently switch to HTTPS.

## What the Bearer token does and does not secure

The official ingest token authenticates **only** `POST /api/spool/ingest`.
It does NOT grant authentication to or secure other Worker HTTP endpoints,
including reads, writes, administration, deletion, context, sessions and search.
The current public machine-vhost catch-all intentionally proxies those routes
without additional authentication. The user explicitly opted for public direct
access. This also means the official ingest token crosses the network in
**unencrypted HTTP** and the exposed Worker API can reveal or modify memory.
Changing this risk profile requires separate transport and authorization work.

ChatGPT/Gemini/Claude/Grok/Muse/Executor `/chatgpt-mcp/*` routes still have
their **independent OAuth** contract. The separate
`claude-mem-admin.414222.xyz` Viewer remains protected by its Basic Auth.
These do not supply authentication for the raw public Worker API.

`CLAUDE_MEM_WORKER_TOKEN` is a legacy optional Bearer header for bespoke
admin tools. It is distinct from
`CLAUDE_MEM_WORKER_INGEST_TOKEN` and does **not** make raw Worker reads or
deletes require a token. Never reuse the ingest token for admin API calls.

## Verification

- Worker: `GET http://claude-mem.414222.xyz:80/api/health` reports
  `status:ok`, `mcpReady:true`.
- No token: `POST /api/spool/ingest` returns 401.
- Correct token + malformed spool envelope: request passes authentication and
  then returns 400. Use a safe test envelope, not production secrets.
- Real capture: invoke a valid client session-init and PostToolUse hook; verify
  the client outbox drains, a matching central `tool_uses` row appears, a
  remote receipt is stored, then wait for the async observation and check fresh
  context injection. Also exercise an interrupted upload and subsequent retry.
- Confirm Web MCP OAuth discovery and the separate admin UI still work.
- Do **not** test real deletion against production records.

## Automatic updates

The official Worker updater at `/usr/local/sbin/claude-mem-weekly-update`
must preserve `CLAUDE_MEM_WORKER_INGEST_TOKEN` whenever the installer
regenerates `settings.json`. Immediately after an upstream update, reapply
`deploy/reapply-claude-mem-platform-ui.py` and
`deploy/apply-claude-mem-viewer-branding.mjs` and verify the explicit
Claude Web, Grok Web, Muse Web and Executor identity handling.
If the critical worker platform patch cannot be reapplied, abort the
upgrade and use the updater's existing rollback path; silently losing identity
attribution is not an acceptable successful upgrade.

Historical `state/central-spool-relay-dead-letter` data may be retained for
manual review but is not processed by the official upload path.
