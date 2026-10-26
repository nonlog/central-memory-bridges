# Independent memory organizer

A Python standard-library sidecar, not a Claude-mem fork. The original database is opened with SQLite `mode=ro` and `query_only=ON`. Original record IDs, text, session identity, timestamps and platform identity are never rewritten by this service.

## Storage and operation

The sidecar's `organizer/catalog.sqlite` holds reversible project/category assignments, confidence, redacted snippets and source fingerprints. Explicit checkout paths and aliases have priority. Mixed `General`/client buckets are classified per record, never globally merged. Low-confidence items stay under `unclassified`.

`scan` covers observations, summaries, prompts and sessions and is idempotent. `classify` uses only the already configured NewAPI HTTPS endpoint with bounded, secret-redacted excerpts, fixed allowed project IDs and strict output scope checks. Model output cannot execute tools, delete rows, or make upstream changes. `merge --apply` uses only the official loopback project merge API for explicit, deterministic aliases and logs the result. It preserves original projects and stamps upstream aliases; it is not a raw SQLite update. Source database/ledger/settings backups are required before the first apply.

`group` uses the shipped upstream request-progress script. The model only suggests request groups; the official validator must accept them. It does not invent completion/progress or change memory content. Disable the upstream auto-refresh CLI poller after enabling the independent timer to prevent competing ledger writers.

## User interface

`/organizer/` browses by category/project, searches Chinese/English snippets and reads original records by exact ID. The existing Classic viewer's list endpoints can use the same classified view via a narrowly scoped authenticated Nginx proxy; this changes only the admin display, not the Worker API used by agents. All HTTP endpoints are read-only. Never put the proxy snippet in the unauthenticated public machine vhost.

My Work's display-only overlay stops calling unknown activity `Working`, labels remaining states as recorded rather than real-time, and calls its duration elapsed time. This does not falsely mark idle tasks completed.

## Deployment

Use the provided service/timer and authenticated Nginx snippet. The API binds only to 127.0.0.1:38179. `MEMORY_ORGANIZER_STATE` overrides index location; `CLAUDE_MEM_DATA_DIR` selects source data. AI, grouping and deterministic alias application have separate environment toggles. There are no repository secrets. Formal tests and upstream bundle checks run in GitHub Actions.

## Rollback

Disable the refresh timer, remove the organizer-specific admin proxy routes and navigation injection, and restore the backed-up Viewer bundle. Remove/rebuild only the sidecar index to discard inferred classifications. Do not restore the whole original memory database over newer captures: upstream merge rollback requires a reviewed, targeted metadata migration (or the consistent snapshot during a controlled maintenance window).
