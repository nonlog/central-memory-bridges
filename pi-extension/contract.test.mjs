import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

const requireText = (value, message) => assert.ok(source.includes(value), message);

requireText('on("context_with_system"', "native request-time context hook is required");
requireText('/api/sessions/native-prompt-capability', "native prompt capability probe is required");
requireText('nativePromptId: entry.id', "persisted Pi entry.id must be forwarded");
requireText('nativePromptCurrent === true', "stale branch suppression must use nativePromptCurrent");
requireText('ctx?.sessionManager?.getBranch', "active branch lookup is required");
requireText('session.anchored', "capture must be gated on an admitted prompt");
requireText('session.excluded', "excluded/private turns must be gated");
requireText('name: "mem_search"', "upstream-compatible progressive search must be present");
requireText('name: "mem_timeline"', "upstream-compatible timeline must be present");
requireText('name: "mem_get_observations"', "upstream-compatible observation fetch must be present");
requireText('CLAUDE_MEM_WORKER_URL', "remote central Worker URL support must remain");
requireText('name: "work_state_read"', "custom Work State support must remain");
requireText('name: "work_state_write"', "custom Work State support must remain");
requireText('name: "claude_mem_recent"', "custom recent-memory tool must remain");
requireText('name: "claude_mem_remember"', "custom durable remember tool must remain");
requireText('redactSecrets', "client-side secret redaction must remain");

const beforeStart = source.slice(
  source.indexOf('on("before_agent_start"'),
  source.indexOf('on("context_with_system"'),
);
assert.ok(!beforeStart.includes('/api/sessions/init'), "before_agent_start must never initialize a prompt");

const contextHook = source.slice(
  source.indexOf('on("context_with_system"'),
  source.indexOf('on("tool_result"'),
);
assert.ok(
  contextHook.indexOf('/api/sessions/init') < contextHook.indexOf('<claude-mem-context>'),
  "Worker prompt admission must precede memory injection",
);
assert.ok(
  contextHook.includes('result?.skipped === true && result?.reason !== "duplicate"'),
  "Worker privacy/project exclusion must suppress injection and capture",
);

const toolHook = source.slice(
  source.indexOf('on("tool_result"'),
  source.indexOf('const captureAssistant'),
);
assert.ok(toolHook.includes('!session.anchored'), "tool capture must reject unanchored turns");
assert.ok(toolHook.includes('session.excluded'), "tool capture must reject excluded turns");
assert.ok(toolHook.includes('tool_use_id'), "Pi toolCallId must remain Worker tool_use_id");
assert.ok(toolHook.includes('void enqueue'), "remote observation writes should stay off the Pi tool-result critical path");

console.log("Pi extension native-capture contract checks passed.");
