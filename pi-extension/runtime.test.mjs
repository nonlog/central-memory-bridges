import assert from "node:assert/strict";

process.env.CLAUDE_MEM_WORKER_URL = "https://worker.test";
process.env.CLAUDE_MEM_SEMANTIC_INJECT = "false";

const calls = [];
let initMode = "normal";
let nativePromptCurrent = true;

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
  calls.push({ route: url.pathname, method: String(init.method || "GET"), body });

  if (url.pathname === "/api/context/inject") return new Response("Useful project memory");
  if (url.pathname === "/api/sessions/native-prompt-capability") {
    return Response.json({ nativePromptId: 1 });
  }
  if (url.pathname === "/api/sessions/init") {
    if (initMode === "private") return Response.json({ sessionDbId: 42, skipped: true, reason: "private" });
    if (initMode === "error") return new Response("unavailable", { status: 503 });
    return Response.json({
      sessionDbId: 42,
      nativePromptId: body.nativePromptId,
      nativePromptCurrent,
      ...(initMode === "duplicate" ? { skipped: true, reason: "duplicate" } : {}),
    });
  }
  if (url.pathname === "/api/sessions/observations") return Response.json({ ok: true });
  if (url.pathname === "/api/sessions/summarize") return Response.json({ ok: true });
  if (url.pathname === "/api/mem-search") {
    return Response.json({
      content: [{
        type: "text",
        text: body?.continuation
          ? "mem-search step 2 of 3 — context"
          : "mem-search step 3 of 3 — selected details",
      }],
    });
  }
  if (url.pathname === "/api/search") return new Response("search index");
  if (url.pathname === "/api/timeline") return new Response("timeline");
  if (url.pathname === "/api/observations/batch") return Response.json({ content: [{ type: "text", text: "observation" }] });
  return Response.json({ ok: true });
};

const { default: extension } = await import("./.ci/index.mjs");

const handlers = new Map();
const tools = new Map();
const pi = {
  on(name, handler) {
    handlers.set(name, handler);
  },
  registerTool(tool) {
    tools.set(tool.name, tool);
  },
};

extension(pi);

let branch = [];
let timestamp = 100;
const ctx = {
  cwd: "/work/project",
  model: { id: "test-model" },
  sessionManager: {
    getSessionId: () => "real-pi-session",
    getBranch: () => branch,
  },
};

const emit = async (name, event = {}) => handlers.get(name)?.(event, ctx);

const ask = async (text, id) => {
  await emit("before_agent_start", { prompt: text });
  const user = {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: ++timestamp,
  };
  branch.push({ type: "message", id, message: user });
  const messages = [{ role: "system", content: "Base system", toolsAdded: [{ name: "read" }] }, user];
  return {
    user,
    result: await emit("context_with_system", { messages }),
  };
};

await emit("session_start", { reason: "new" });
assert.equal(calls[0].route, "/api/context/inject");

const first = await ask("Fix the parser", "entry-a");
const firstInit = calls.find((call) => call.route === "/api/sessions/init");
assert.deepEqual(
  {
    contentSessionId: firstInit.body.contentSessionId,
    nativePromptId: firstInit.body.nativePromptId,
    platformSource: firstInit.body.platformSource,
  },
  {
    contentSessionId: "real-pi-session",
    nativePromptId: "entry-a",
    platformSource: "pi",
  },
);
assert.match(first.result.messages[0].content, /Useful project memory/);
assert.deepEqual(first.result.messages[0].toolsAdded, [{ name: "read" }]);

await emit("tool_result", {
  toolName: "read",
  toolCallId: "tool-1",
  input: { path: "a.ts" },
  content: [{ type: "text", text: "file text" }],
});
await emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: "Fixed." }] } });
await emit("agent_end", { messages: [{ role: "assistant", content: "Fixed." }] });

const firstWriteOrder = calls
  .filter((call) => call.body)
  .slice(0, 3)
  .map((call) => call.route);
assert.deepEqual(firstWriteOrder, [
  "/api/sessions/init",
  "/api/sessions/observations",
  "/api/sessions/summarize",
]);
const observation = calls.find((call) => call.route === "/api/sessions/observations");
assert.equal(observation.body.tool_use_id, "tool-1");

// Equal text in a distinct persisted Pi entry must be a distinct Worker prompt.
const second = await ask("Fix the parser", "entry-b");
assert.match(second.result.messages[0].content, /Useful project memory/);
await emit("message_end", { message: { role: "assistant", content: "Second." } });
await emit("agent_end", { messages: [{ role: "assistant", content: "Second." }] });
assert.deepEqual(
  calls.filter((call) => call.route === "/api/sessions/init").map((call) => call.body.nativePromptId),
  ["entry-a", "entry-b"],
);

// Worker privacy/project admission must block memory injection and all capture.
initMode = "private";
const writesBeforePrivate = calls.filter((call) =>
  ["/api/sessions/observations", "/api/sessions/summarize"].includes(call.route),
).length;
const privateTurn = await ask("<private>secret</private>", "entry-private");
assert.equal(privateTurn.result, undefined);
await emit("tool_result", {
  toolName: "read",
  toolCallId: "private-tool",
  input: {},
  content: [{ type: "text", text: "private result" }],
});
await emit("message_end", { message: { role: "assistant", content: "Private." } });
await emit("agent_end", { messages: [{ role: "assistant", content: "Private." }] });
const writesAfterPrivate = calls.filter((call) =>
  ["/api/sessions/observations", "/api/sessions/summarize"].includes(call.route),
).length;
assert.equal(writesAfterPrivate, writesBeforePrivate);

// A duplicate that is not the Worker's current prompt must remain unanchored.
initMode = "duplicate";
nativePromptCurrent = false;
const writesBeforeStale = calls.filter((call) => call.route === "/api/sessions/observations").length;
const stale = await ask("Old branch retry", "entry-old");
assert.equal(stale.result, undefined);
await emit("tool_result", {
  toolName: "read",
  toolCallId: "stale-tool",
  input: {},
  content: [{ type: "text", text: "must not persist" }],
});
await emit("agent_end", { messages: [{ role: "assistant", content: "Old." }] });
assert.equal(
  calls.filter((call) => call.route === "/api/sessions/observations").length,
  writesBeforeStale,
);

// Init failure must fail open for Pi while leaving the turn unanchored.
initMode = "error";
nativePromptCurrent = true;
const failed = await ask("Worker outage", "entry-error");
assert.equal(failed.result, undefined);
const writesBeforeFailureTool = calls.filter((call) => call.route === "/api/sessions/observations").length;
await emit("tool_result", {
  toolName: "read",
  toolCallId: "failure-tool",
  input: {},
  content: [{ type: "text", text: "must not persist" }],
});
assert.equal(
  calls.filter((call) => call.route === "/api/sessions/observations").length,
  writesBeforeFailureTool,
);

const autoSearch = await tools.get("mem_search").execute("mem-auto", {
  query: "parser fix",
  mode: "auto",
  project: "pi-project",
  limit: 8,
  maxDetails: 2,
  depthBefore: 1,
  depthAfter: 1,
});
const autoCall = [...calls].reverse().find((call) => call.route === "/api/mem-search");
assert.equal(autoCall.method, "POST");
assert.deepEqual(autoCall.body, {
  mode: "auto",
  query: "parser fix",
  project: "pi-project",
  limit: 8,
  maxDetails: 2,
  depthBefore: 1,
  depthAfter: 1,
});
assert.match(autoSearch.content[0].text, /mem-search step 3 of 3/);

const continuation = "ms_123456789012345678901234";
const guidedSearch = await tools.get("mem_search").execute("mem-guided", {
  mode: "guided",
  continuation,
  selectedIds: ["S10", 20],
});
const guidedCall = [...calls].reverse().find((call) =>
  call.route === "/api/mem-search" && call.body?.continuation === continuation
);
assert.equal(guidedCall.method, "POST");
assert.deepEqual(guidedCall.body, {
  mode: "guided",
  continuation,
  selectedIds: ["S10", 20],
});
assert.match(guidedSearch.content[0].text, /mem-search step 2 of 3/);

assert.ok(tools.has("mem_search"));
assert.ok(tools.has("mem_timeline"));
assert.ok(tools.has("mem_get_observations"));
assert.ok(tools.has("claude_mem_search"));
assert.ok(tools.has("claude_mem_recent"));
assert.ok(tools.has("claude_mem_remember"));
assert.ok(tools.has("work_state_read"));
assert.ok(tools.has("work_state_write"));

// The official Worker rejects non-finite/unsafe numeric values, and the Pi
// bridge must refuse those before issuing an HTTP write.
const wsBefore = calls.filter((call) => call.route === "/api/work-state/entries").length;
const invalidWs = await tools.get("work_state_write").execute(
  "ws-invalid-number",
  {list: "tasks", fields: {count: Number.MAX_SAFE_INTEGER + 1}},
  undefined, undefined, ctx,
);
assert.match(invalidWs.content[0].text, /safe finite numeric/);
const oversizedWs = await tools.get("work_state_write").execute(
  "ws-too-large",
  {list: "tasks", fields: {note: "x".repeat(2100)}},
  undefined, undefined, ctx,
);
assert.match(oversizedWs.content[0].text, /2000/);
assert.equal(
  calls.filter((call) => call.route === "/api/work-state/entries").length,
  wsBefore,
  "invalid Work State requests must not reach the Worker",
);

console.log("Pi extension runtime lifecycle tests passed.");
