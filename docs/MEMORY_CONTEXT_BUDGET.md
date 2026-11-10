# Automatic memory context budget

Keep automatic recall bounded; use explicit search, timeline and selected details for deeper history. Capture, Work State tools and upstream memory ownership are unchanged.

## Shared settings

- `~/.central-memory-bridges/recall.json`: 2,500 characters, four selected candidates, four banks and six search results. `legacyContextActive` is a current-project duplicate filter, not an on/off switch for legacy hooks; keep it true while upstream startup history is active.
- `~/.hindsight/coding-agent.json`: `autoInject: "none"`, `pageRefreshEveryTurns: 10`. Preserve bank mappings, harness overrides and credentials when syncing these fields.
- Central Worker `~/.claude-mem/settings.json`: 20 observations, five sessions, zero full observations, savings statistics hidden. Remote clients receive context generated with the **Worker's** settings; editing only a client settings file is insufficient.

## Agent behavior

| Client | Automatic context behavior |
| --- | --- |
| Codex, Claude Code, Factory Droid | Skip known acknowledgments before network requests. Suppress previously emitted identical facts in the same session; changed facts remain eligible. No session ID means no deduplication. |
| Pi | Its system context is temporary. Reuse the last bounded recall block for identical prompts and acknowledgments, retaining visibility on later turns. Refresh for a different substantive prompt; clear the cache on session/branch changes. |
| Hermes | Its provider context is temporary. Fetch the recent Claude-mem timeline once per session and reuse the bounded block each turn. Failed fetches retry. Session switches clear the cache; explicit cross-project search and the independent Hindsight provider remain available. |
| Antigravity | The existing PreInvocation adapter remains installed and inherits shared budgets, empty-record filtering and acknowledgment skipping. |

Hook deduplication stores at most 256 content hashes per session under the OS temporary directory `central-memory-recall/`; it stores neither prompts nor recalled text. It expires after 30 minutes without a successful new injection. A recognized Claude `compact_boundary`, Codex `compacted`, or summary record resets suppression. Missing or unreadable caches fail open. Compaction formats without these markers rely on expiration.

Do not add a hard relevance-score cutoff based on current Hindsight scores: similarly scored unrelated records and Chinese queries need a separate relevance evaluation. Empty durable-retention requests with no payload are excluded without deleting database records.

## Deployment

Run the repository workflows before deployment. Pi's build and lifecycle tests run on GitHub Actions; do not build locally. Update its managed git package after the canonical commit is merged. Copy `core.mjs`, `session.mjs`, `hook.mjs` and `telemetry.mjs` together into the shared hook runtime, preserving the separately installed Antigravity adapter. Copy `hermes-provider/__init__.py` to the native Hermes plugin and restart the Hermes gateway after pending turns finish. Remote Worker settings require a controlled Worker restart to refresh its process configuration.
