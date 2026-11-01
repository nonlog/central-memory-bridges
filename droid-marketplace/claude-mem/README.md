# Claude-mem for Droid CLI

Native Factory Droid plugin for the shared central Claude-mem Worker.

## Features

- Session-start context injection and prompt-time recall.
- Automatic prompt and post-tool observations through the official `claude-mem` CLI hook runtime.
- Stop and cancellation summaries extracted from Droid's native JSONL transcript format.
- `claude-mem` skill describing when to use the existing central-memory MCP tools.
- Fail-open behavior: memory outages never block Droid prompts or tool execution.

## Prerequisites

- The official Windows CLI at `%LOCALAPPDATA%\claude-mem\bin\claude-mem.exe` (or set `CLAUDE_MEM_CLI` to its path).
- The user-level Droid MCP server named `claude-mem` must already be authenticated. This plugin deliberately does not declare another `mcp.json`, avoiding a duplicate connection or a second OAuth grant.
- Node.js available on `PATH`.

The plugin uses the official remote Worker configuration and token already managed by the installed Claude-mem CLI. It does not contain credentials or create a local spool relay.

## Hindsight coexistence

The plugin adds hooks from the plugin scope. It does not edit or replace `~/.factory/hooks.json`; the existing Hindsight SessionStart, UserPromptSubmit, Stop, and Notification hooks remain active.

## Manual hook test

```powershell
$hook = Get-ChildItem "$env:USERPROFILE\.factory\plugins\cache" -Recurse -Filter 'claude-mem-hook.mjs' | Select-Object -First 1
$event = '{"session_id":"test-session","transcript_path":"C:\\path\\to\\session.jsonl","cwd":"D:\\Workspace\\Projects","permission_mode":"off","hook_event_name":"SessionStart","source":"startup"}'
$event | node $hook.FullName context
```

The installed plugin cache path may vary by Droid version; `/hooks` and `/plugins` show the effective configuration.
