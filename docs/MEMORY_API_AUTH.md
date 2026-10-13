# Central Worker API authentication

The public `claude-mem.414222.xyz` worker routes MUST require a 256-bit API key in the `X-Claude-Mem-Key` HTTP header. The Worker remains bound to `127.0.0.1:37777` on the VPS. Its upstream source is not patched for authentication.

The key is randomly generated on the VPS and stored in a root-only Nginx map file (`/etc/nginx/conf.d/claude-mem-api-keys.conf`). The machine vhost's catch-all `location /` must return 401 unless the Nginx map authorizes the header. That protects both `/api/*` and any future non-OAuth routes. Use `map_hash_bucket_size 128;` for a 64-character key. Strip the header upstream with `proxy_set_header X-Claude-Mem-Key "";` after evaluating the Nginx map. Nginx `nginx -t` and an anonymous probe must pass before and after reload. Never paste a real key into code, docs, issues, command logs, or CI.

Keep the OAuth discovery paths, `/chatgpt-mcp/*` and the admin hostname's existing Basic Auth separate. The ChatGPT MCP bridge connects directly to the loopback Worker and uses its own OAuth bearer tokens, so it needs no machine API key. Hermes/OpenClaw on the VPS also use the loopback Worker.

For Windows Claude Code and Codex hooks that cannot send custom HTTP headers, use `deploy/windows-central-memory-gateway.cjs`. It listens ONLY on `127.0.0.1:37777` and adds the key while proxying to the HTTPS Worker origin. Store the key in `%USERPROFILE%\.claude-mem\central-api-key` with restrictive user-only ACLs; configure the official hook runtime and Spool Relay to use `127.0.0.1:37777`. Start the gateway as a per-user logon task before starting agents. It exposes only `/api*`; it is not a general-purpose HTTP proxy.

Pi and the two memory-admin plugins also support an optional `CLAUDE_MEM_WORKER_API_KEY` or `CLAUDE_MEM_API_KEY_FILE`; their default key-file location is the same per-user `.claude-mem/central-api-key`. They send `X-Claude-Mem-Key` only over HTTPS or loopback. `CLAUDE_MEM_WORKER_TOKEN` (Bearer) is independent and is not replaced by the API key.

Validation: anonymous GET `/api/observation/<known-id>` must return 401; incorrect API key 401; authenticated health/search 200; authorized hook init and observation POST succeed; unauthenticated POST denied; admin Basic Auth and ChatGPT MCP OAuth still work; real Pi/Hermes/OpenClaw flows remain healthy. Avoid destructive calls during smoke testing.

**Rotation:** add the new key to the map alongside the old key, roll out the new client secret file and restart long-running clients if needed, verify access, then remove the old key and reload Nginx. Never store raw API keys in version control or diagnostics. Since a shared machine key grants Worker write/delete access too, use short-lived maintenance procedures and rotate promptly if exposed; further split read/write and destructive keys if required later.
