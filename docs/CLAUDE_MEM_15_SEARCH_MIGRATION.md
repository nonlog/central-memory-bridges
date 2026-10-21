# Claude-mem v15.0.1 search compatibility and upgrade hold

## Upstream release evidence

Official annotated tag `v15.0.1` resolves to
`0e7de4ee4671ff3e5c233b721904e9eac9d61792`.

At 14.0.1, `POST /api/mem-search` supports `guided`, `auto`,
`continuation` and `selectedIds`. The v15.0.1 Worker removes this route.
Its supported search surfaces are:

- `GET /api/search`: Smart **step 1**, compact index; choose relevant IDs.
- `GET /api/timeline`: Smart **step 2**, contextual chronology.
- `POST /api/observations/batch`: Smart **step 3**, selected numeric details.
- `POST /api/dumb-search`: optional shallow automated title lookup;
  accepts `query`, `project`, `limit`, `maxDetails`, `depthBefore`
  and `depthAfter`. It does **not** accept guided continuation state.

Do not mistake IDs like `S42` (session summary) or `P13` (prompt) for
numeric observation IDs. Destructive tools continue using exact numeric IDs.

## Bridge behavior

Both `chatgpt-mcp/full-memory-tools.mjs` and `pi-extension/index.ts`
detect the central Worker's version at each search call through
`GET /api/version`. The shared `shared/worker-search-compat.mjs` plans:

| Tool / Worker | 14.0.1 | 15.0.1 |
| --- | --- | --- |
| `mem_search` guided/default | legacy POST `/api/mem-search`, with continuation | GET `/api/search`, compact Smart index; follow with timeline and details |
| `mem_search` auto | legacy POST `/api/mem-search` auto | POST `/api/dumb-search`, shallow |
| `dumb_search` | legacy auto adapter | POST `/api/dumb-search` |

A v14 continuation is rejected on v15 with instructions to restart the
index/timeline/details workflow; it is never silently ignored or fabricated.
Unknown Worker versions fail closed. The v15 Smart index strips narratives,
facts, raw prompts and metadata before returning results to an agent, so
raw search rows are not accidentally included in the context.

The existing `memory_search_advanced`, `memory_timeline`,
`memory_get_observations`, `mem_timeline`, `mem_get_observations`, native
session capture, Work State, manual remember, OAuth permissions, and exact-ID
admin/delete tools keep their existing contracts.

## Automatic upgrade safety gate

`deploy/check-worker-upgrade.mjs` checks the exact npm candidate against
`deploy/worker-upgrade-policy.json` **before** backup, stopping Worker, npm
install, database operations or a restart. No version prefix, rolling "latest"
or implicitly approved new patch release is accepted. If the manifest is
missing, corrupt, or lacks the candidate, the update exits without changing
the Worker and records `COMPATIBILITY HOLD`.

**As of this change, only installed 14.0.1 is approved. v15.0.1 is
deliberately held.** This does not imply v15 is unusable: it means dual-version
bridge unit/CI tests have not yet been combined with a verified production-like
15.0.1 Worker upgrade, local identity/UI patch reapplication, rollback
dry-run and live client end-to-end checks. Never whitelist a release merely
because its latest version was published.

When ready to promote:

1. Verify GitHub Actions (search contract pinned to official v15.0.1 tag,
   Pi bundle/runtime, ChatGPT OAuth/search, legacy Worker contracts).
2. Deploy the shared adapter and ChatGPT MCP as one transaction; restart only
   ChatGPT MCP. Confirm the v14 Smart/guided/auto and OAuth flows.
3. Update Pi managed git package on Windows and verify its actual loaded
   extension, context retrieval, native prompt admission and observation
   capture. Verify all independent Bridge/agent clients as applicable.
4. Run a production-like isolated v15 Worker against a disposable database,
   **not** the central memory database. Exercise read/write, search, spool,
   direct client hooks, custom platform patches and Hermes plugin preservation.
5. Add the exact `15.0.1` to the policy only in a reviewed Git commit after
   successful tests, deploy the gate/policy together, and perform a controlled
   update with a restorable central data snapshot. Recheck worker health and
   correctness; verify rollback and disable auto-update if any failure.
6. Future 15.0.x/16.x versions remain blocked until separately approved.

We do not modify upstream CPA, NewAPI, Executor or claude-mem itself.
This deployment remains on official Worker 14.0.1 while migration is tested.
