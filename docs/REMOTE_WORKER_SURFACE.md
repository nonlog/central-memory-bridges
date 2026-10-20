# Claude-mem central Worker: external HTTP exposure and authenticated UI

The deployed central Worker is intentionally bound to `127.0.0.1:37777`.
Its public machine vhost is a compatibility gateway for official remote
clients that use the current `CLAUDE_MEM_WORKER_HOST`/`WORKER_PORT` HTTP
contract. The Worker has no general API authorization contract in 14.0.1.
`CLAUDE_MEM_WORKER_INGEST_TOKEN` authenticates **only**
`POST /api/spool/ingest`. Do not mistake a successful OAuth MCP login or
Spool Bearer authentication for general Worker API protection.

## What is protected now

- The public browser root, legacy Viewer, My Work static assets, TV and
  restart links redirect to the existing Basic-Auth admin origin.
- The public live observation stream, Work View data, provider settings,
  logs, Worker administration, MCP and diagnostic management routes are
  denied by Nginx. Public DELETE/PATCH/PUT are denied.
- `POST /api/spool/ingest` stays available on the public machine hostname,
  preserves its `Authorization` header, and is authenticated by upstream.
- The OAuth MCP discovery, authorization and `/chatgpt-mcp/*` routes are
  unchanged; `memory:delete` remains a separate OAuth scope.
- On the admin vhost, GET/HEAD `/api/work-view*` is explicitly proxied to a
  loopback Host with the four forwarded-client headers stripped. This is an
  **authenticated read-only bridge** for the local-only Work View. POST review
  is refused; do not bypass the Worker origin verification for reviews.
- The admin vhost's existing Basic Auth continues to protect every route.

## Residual risk and why full raw API lockdown is deferred

The user previously selected official HTTP remote clients without an SSH
or Windows gateway. Their API URL is constructed as
`http://<CLAUDE_MEM_WORKER_HOST>:<CLAUDE_MEM_WORKER_PORT>`; Web/MCP bridge
clients can also call context/search/session APIs directly. Blocking **all**
`/api/*` on the public machine host without changing their transport would
silently break remote memory recall, native MCP tools and work-state writes.
For compatibility, non-admin legacy GET context/search/observation routes and
some POST memory routes remain publicly exposed without authentication.
This is a real remaining privacy and write-integrity risk, not a fix. The
Bearer token on port 80 is also exposed to network observers without transport
TLS (unless a separate secure tunnel is in use). Do not publish provider
credentials or sensitive memories through this endpoint on an untrusted
network.

Full remediation requires a deliberately coordinated client migration:
place non-Spool Worker API traffic behind a private authenticated transport
(e.g., a trusted encrypted overlay/private network or local gateway), verify
Claude Code/Codex official hooks and MCP tools, Pi `CLAUDE_MEM_WORKER_URL`,
Hermes and the Web OAuth bridge, then make the public default `location /`
return 403. Do not install an untested blanket deny or repurpose the Spool
Bearer as a universal Worker token; upstream does not provide that contract.
Only perform the final cutover with end-to-end client tests and an explicit
rollback to the prior proxy config.

## Deployment

The sanitized examples are:

- `deploy/nginx-claude-mem-machine.conf.example`
- `deploy/nginx-claude-mem-admin.conf.example`

Copy to the corresponding VPS `sites-available` files only after backing up
both production configs. Verify with `nginx -t`, then reload Nginx (not the
Worker). Keep the production credential file and OAuth state unchanged.
Do not claim that a 401 from the OAuth bridge or the Spool endpoint
protects arbitrary `/api/*` paths.

## Non-destructive checks

- Unauthenticated machine `/` -> 302 to Basic-Auth admin origin.
- Unauthenticated machine `/api/settings`, `/stream`, `/api/work-view` -> 403.
- Unauthenticated machine DELETE of a harmless invalid-record URL -> 403
  **before** reaching the Worker; do not send a real deletion.
- Unauthenticated Spool POST with empty JSON -> 401 from upstream.
- `/api/health` and OAuth discovery remain available.
- Unauthenticated admin `/api/work-view` -> 401, and GET under an authorized
  browser session renders My Work and events; remote POST review -> 405.
- If relevant, verify actual remote client context injection and outbox
  acknowledgments before and after applying routing changes.
