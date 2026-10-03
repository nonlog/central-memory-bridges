// Central claude-mem integration for Pi Coding Agent.
// Lifecycle is intentionally aligned with upstream claude-mem's Claude Code/Codex hooks:
// session-start context once, per-prompt session init, async tool observations, and async summaries.
// Semantic per-prompt injection is optional and disabled by default, matching upstream defaults.

import crypto from "node:crypto";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WORKER = (process.env.CLAUDE_MEM_WORKER_URL || "https://claude-mem.414222.xyz").replace(/\/$/, "");
const BASE_PROJECT = "pi";
const PLATFORM_SOURCE = "pi";
const HTTP_TIMEOUT_MS = 5_000;
const SEARCH_TIMEOUT_MS = 45_000;
const SESSION_CONTEXT_TIMEOUT_MS = 10_000;
const SHUTDOWN_FLUSH_MS = 1_500;
const MAX_CONTEXT_CHARS = clampInt(process.env.CLAUDE_MEM_CONTEXT_MAX_CHARS, 16_000, 2_000, 64_000);
const MAX_PROMPT_CHARS = 16_000;
const MAX_ASSISTANT_CHARS = 24_000;
const MAX_TOOL_PAYLOAD_CHARS = 16_000;
const MAX_TOOL_TEXT_CHARS = 12_000;
const SEMANTIC_INJECT = parseBool(process.env.CLAUDE_MEM_SEMANTIC_INJECT, false);
const SEMANTIC_INJECT_LIMIT = clampInt(process.env.CLAUDE_MEM_SEMANTIC_INJECT_LIMIT, 5, 1, 20);
const WORK_STATE_CONTEXT_HEADER = "# Work state: your to-do lists and working state";
const WORK_STATE_RULE_END = "- Read every list, closed items included: work_state_read with includeClosed=true";
const WORK_STATE_GUIDANCE = `${WORK_STATE_CONTEXT_HEADER}\nUse work_state_write as the canonical cross-session to-do/state tool for this checkout; use work_state_read to inspect it, including closed items when needed.`;
const DEFAULT_SKIP_TOOLS = [
  "ListMcpResourcesTool",
  "SlashCommand",
  "Skill",
  "TodoWrite",
  "AskUserQuestion",
  "todo",
  "ask_user_question",
];
const SKIP_TOOLS = new Set(
  (process.env.CLAUDE_MEM_SKIP_TOOLS || DEFAULT_SKIP_TOOLS.join(","))
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean),
);

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}\b/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password)\s*[:=]\s*[^\s,;]{8,}/gi,
];

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function redactSecrets(value: unknown): string {
  let text = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[REDACTED_SECRET]");
  return text;
}

function safeProject(value: string, fallback = BASE_PROJECT): string {
  const cleaned = String(value || fallback)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return cleaned || fallback;
}

function projectForCwd(cwd?: string): string {
  const base = path.basename(cwd || process.cwd()) || "default";
  return safeProject(BASE_PROJECT + "-" + base, "pi-default");
}

function isTrivialPrompt(prompt: string): boolean {
  const text = String(prompt || "").trim();
  return !text || text.length < 3 || /^\/(help|quit|exit|clear|reload)(\s|$)/i.test(text);
}

function messageText(message: any): string {
  if (!message || message.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part: any) => part && part.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
    .trim();
}

function extractWorkerText(raw: any): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw?.content)) {
    return raw.content
      .filter((item: any) => item?.type === "text")
      .map((item: any) => String(item.text || ""))
      .join("\n");
  }
  return JSON.stringify(raw);
}

function stripWorkStateContext(text: string): { hadWorkState: boolean; text: string } {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trimStart();
  if (!normalized.startsWith(WORK_STATE_CONTEXT_HEADER)) return { hadWorkState: false, text: String(text || "") };
  const ruleEnd = normalized.indexOf(WORK_STATE_RULE_END);
  const tail = ruleEnd >= 0 ? normalized.slice(ruleEnd + WORK_STATE_RULE_END.length) : normalized.slice(WORK_STATE_CONTEXT_HEADER.length);
  const match = tail.match(/\n\n(?=# (?:\[|claude-mem status))/);
  if (!match || match.index === undefined) return { hadWorkState: true, text: "" };
  return { hadWorkState: true, text: tail.slice(match.index + match[0].length).trimStart() };
}

function sanitizeStructured(value: unknown, maxChars = MAX_TOOL_PAYLOAD_CHARS): unknown {
  try {
    const json = redactSecrets(JSON.stringify(value));
    if (json.length <= maxChars) return JSON.parse(json);
    return { truncated: true, preview: json.slice(0, maxChars) };
  } catch {
    return { text: redactSecrets(value).slice(0, maxChars) };
  }
}

function serializeToolResponse(event: any): unknown {
  const content = Array.isArray(event?.content)
    ? event.content.map((part: any) => {
        if (part?.type === "text") {
          return { type: "text", text: redactSecrets(part.text).slice(0, MAX_TOOL_TEXT_CHARS) };
        }
        if (part?.type === "image") {
          return { type: "image", mimeType: String(part.mimeType || "image/*"), omitted: true };
        }
        return { type: String(part?.type || "unknown"), omitted: true };
      })
    : [];

  return sanitizeStructured(
    {
      content,
      isError: Boolean(event?.isError),
      details: event?.details,
      usage: event?.usage,
    },
    MAX_TOOL_PAYLOAD_CHARS,
  );
}

async function request(route: string, init: RequestInit = {}, timeoutMs = HTTP_TIMEOUT_MS): Promise<any> {
  const response = await fetch(WORKER + route, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new Error("claude-mem " + response.status + ": " + text.slice(0, 500));
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function contentSessionId(ctx: any, fallback: string): string {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (typeof id === "string" && id.trim()) return "pi-" + safeProject(id, fallback);
  } catch {}
  return fallback;
}

export default function centralClaudeMem(pi: ExtensionAPI) {
  let activeProject = projectForCwd();
  let activeCwd = process.cwd();
  let activeSessionId = "pi-" + crypto.randomUUID();
  let startupContext = "";
  let startupContextDelivered = false;
  let pendingPrompt = "";
  let pendingAssistant = "";
  let pendingSummary = false;
  let observedModel = "";
  const inFlight = new Set<Promise<void>>();
  let backgroundTail: Promise<void> = Promise.resolve();

  const refreshSession = (ctx: any, cwd?: string) => {
    const resolvedCwd = cwd || ctx?.cwd || process.cwd();
    activeCwd = resolvedCwd;
    activeProject = projectForCwd(resolvedCwd);
    activeSessionId = contentSessionId(ctx, "pi-" + crypto.randomUUID());
  };

  const background = (task: () => Promise<unknown>): Promise<void> => {
    const tracked = backgroundTail
      .then(task, task)
      .then(() => undefined)
      .catch(() => undefined);
    backgroundTail = tracked;
    inFlight.add(tracked);
    void tracked.then(() => inFlight.delete(tracked));
    return tracked;
  };

  const flushBackground = async (timeoutMs = SHUTDOWN_FLUSH_MS) => {
    const pending = Array.from(inFlight);
    if (pending.length === 0) return;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  };

  const loadSessionContext = async () => {
    startupContext = "";
    startupContextDelivered = false;
    try {
      const projects = BASE_PROJECT + "," + activeProject;
      const query = new URLSearchParams({ projects });
      const raw = await request("/api/context/inject?" + query.toString(), {}, SESSION_CONTEXT_TIMEOUT_MS);
      const stripped = stripWorkStateContext(extractWorkerText(raw));
      const blocks: string[] = [];
      if (stripped.hadWorkState) {
        try {
          const q = new URLSearchParams({ cwd: activeCwd });
          const state = await request("/api/work-state?" + q.toString(), {}, HTTP_TIMEOUT_MS);
          const stateText = extractWorkerText(state).trim();
          if (stateText) blocks.push(WORK_STATE_GUIDANCE + "\n" + stateText);
        } catch {}
      }
      if (stripped.text.trim()) blocks.push(stripped.text.trim());
      startupContext = blocks.join("\n\n").slice(0, MAX_CONTEXT_CHARS);
    } catch {
      startupContext = "";
    }
  };

  const queueSummary = (): Promise<void> => {
    if (!pendingSummary) return Promise.resolve();
    const assistant = pendingAssistant.trim();
    const sid = activeSessionId;
    const model = observedModel;
    pendingPrompt = "";
    pendingAssistant = "";
    pendingSummary = false;
    observedModel = "";
    if (!assistant) return Promise.resolve();

    const safeAssistant = redactSecrets(assistant).slice(0, MAX_ASSISTANT_CHARS);
    return background(() =>
      request(
        "/api/sessions/summarize",
        {
          method: "POST",
          body: JSON.stringify({
            contentSessionId: sid,
            last_assistant_message: safeAssistant,
            platformSource: PLATFORM_SOURCE,
            observedModel: model || undefined,
            cwd: activeCwd,
          }),
        },
        HTTP_TIMEOUT_MS,
      ),
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    refreshSession(ctx);
    pendingPrompt = "";
    pendingAssistant = "";
    pendingSummary = false;
    observedModel = "";
    await loadSessionContext();
  });

  pi.on("session_compact", async (_event, ctx) => {
    refreshSession(ctx);
    await loadSessionContext();
  });

  pi.on("before_agent_start", async (event, ctx) => {
    refreshSession(ctx, event.systemPromptOptions?.cwd || ctx.cwd);
    pendingPrompt = String(event.prompt || "");
    pendingAssistant = "";
    pendingSummary = !isTrivialPrompt(pendingPrompt);
    observedModel = pendingSummary ? String(ctx.model?.id || "") : "";
    if (!pendingSummary) return;

    const safePrompt = redactSecrets(pendingPrompt).slice(0, MAX_PROMPT_CHARS);
    const contexts: string[] = [];

    if (!startupContextDelivered) {
      startupContextDelivered = true;
      if (startupContext) contexts.push(startupContext);
    }

    try {
      await request(
        "/api/sessions/init",
        {
          method: "POST",
          body: JSON.stringify({
            contentSessionId: activeSessionId,
            project: activeProject,
            prompt: safePrompt,
            platformSource: PLATFORM_SOURCE,
            cwd: activeCwd,
          }),
        },
        HTTP_TIMEOUT_MS,
      );
    } catch {
      // Memory must never prevent Pi from starting the agent turn.
    }

    if (SEMANTIC_INJECT && safePrompt.length >= 20) {
      try {
        const semantic = await request(
          "/api/context/semantic",
          {
            method: "POST",
            body: JSON.stringify({
              q: safePrompt,
              project: activeProject,
              limit: SEMANTIC_INJECT_LIMIT,
              platformSource: PLATFORM_SOURCE,
            }),
          },
          HTTP_TIMEOUT_MS,
        );
        const semanticContext = String(semantic?.context || "").trim();
        if (semanticContext) contexts.push(semanticContext.slice(0, MAX_CONTEXT_CHARS));
      } catch {
        // Optional semantic memory degrades silently, matching upstream hooks.
      }
    }

    const additionalContext = contexts.filter(Boolean).join("\n\n").trim();
    if (!additionalContext) return;

    return {
      message: {
        customType: "central-claude-mem-context",
        content: additionalContext,
        display: false,
      },
    };
  });

  pi.on("tool_result", async (event, ctx) => {
    const toolName = String((event as any).toolName || "");
    if (!toolName || toolName.startsWith("claude_mem_") || toolName.startsWith("work_state_") || SKIP_TOOLS.has(toolName.toLowerCase())) return;

    const sid = activeSessionId;
    const cwd = ctx.cwd || process.cwd();
    const toolUseId = String((event as any).toolCallId || "").trim();
    const toolInput = sanitizeStructured((event as any).input);
    const toolResponse = serializeToolResponse(event);

    background(() =>
      request(
        "/api/sessions/observations",
        {
          method: "POST",
          body: JSON.stringify({
            contentSessionId: sid,
            platformSource: PLATFORM_SOURCE,
            tool_name: toolName,
            ...(toolUseId ? { tool_use_id: toolUseId } : {}),
            tool_input: toolInput,
            tool_response: toolResponse,
            cwd,
          }),
        },
        HTTP_TIMEOUT_MS,
      ),
    );
  });

  pi.on("turn_end", async (event) => {
    const text = messageText((event as any).message);
    if (text) pendingAssistant = text;
  });

  pi.on("agent_end", async (event) => {
    for (let i = (event as any).messages?.length - 1; i >= 0; i--) {
      const text = messageText((event as any).messages[i]);
      if (text) {
        pendingAssistant = text;
        break;
      }
    }
  });

  pi.on("agent_settled", async () => {
    // Match upstream Stop-hook semantics: wait only until all observations and
    // the summary request have reached the Worker's queue. The expensive AI
    // summarization remains asynchronous inside claude-mem. This ordering also
    // prevents the next /sessions/init from advancing promptNumber first.
    await queueSummary();
  });

  pi.on("session_shutdown", async () => {
    await queueSummary();
    await flushBackground();
  });

  pi.registerTool({
    name: "claude_mem_search",
    label: "Central Memory Search",
    description: "Search the shared central claude-mem pool across Pi, Claude Code, Codex, OpenClaw, Hermes, ChatGPT, and other projects.",
    promptSnippet: "Search shared cross-client memory",
    promptGuidelines: [
      "Use claude_mem_search when prior work, decisions, preferences, deployments, or context from another client may be relevant.",
    ],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 1000 }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, params) {
      const q = new URLSearchParams({ query: String(params.query), limit: String(params.limit || 8) });
      try {
        const raw = await request("/api/search/observations?" + q.toString(), {}, SEARCH_TIMEOUT_MS);
        return { content: [{ type: "text", text: extractWorkerText(raw) }], details: { source: "central-claude-mem" } };
      } catch (error: any) {
        return { content: [{ type: "text", text: "Central memory search failed: " + error.message }], details: { error: true } };
      }
    },
  });

  pi.registerTool({
    name: "claude_mem_recent",
    label: "Central Memory Recent",
    description: "Read recent central claude-mem context for a known project.",
    promptSnippet: "Read recent memory from a known project",
    parameters: Type.Object({
      project: Type.String({ minLength: 1, maxLength: 96 }),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, params) {
      const q = new URLSearchParams({ project: safeProject(String(params.project)), limit: String(params.limit || 5) });
      try {
        const raw = await request("/api/context/recent?" + q.toString(), {}, 10_000);
        return { content: [{ type: "text", text: extractWorkerText(raw) }], details: { source: "central-claude-mem" } };
      } catch (error: any) {
        return { content: [{ type: "text", text: "Central recent memory failed: " + error.message }], details: { error: true } };
      }
    },
  });

  pi.registerTool({
    name: "work_state_write",
    label: "Work State Write",
    description: "Append one update to this checkout's canonical cross-session to-do list or working state.",
    promptSnippet: "Update canonical cross-session work state",
    parameters: Type.Object({
      list: Type.String({ minLength: 1, maxLength: 200 }),
      fields: Type.Record(
        Type.String({ minLength: 1 }),
        Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
        { minProperties: 1 },
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx?.cwd || activeCwd || process.cwd();
      if (!params.fields || Object.keys(params.fields).length === 0) {
        return { content: [{ type: "text", text: "fields must be a non-empty object" }], details: { error: true } };
      }
      if (JSON.stringify(params.fields).length > 2_000) {
        return { content: [{ type: "text", text: "fields must be at most 2000 characters as JSON" }], details: { error: true } };
      }
      try {
        const raw = await request("/api/work-state/entries", {
          method: "POST",
          body: JSON.stringify({ cwd, list: String(params.list), fields: params.fields }),
        }, HTTP_TIMEOUT_MS);
        return { content: [{ type: "text", text: extractWorkerText(raw) }], details: { source: "central-claude-mem" } };
      } catch (error: any) {
        return { content: [{ type: "text", text: "Work state write unavailable: " + error.message }], details: { error: true } };
      }
    },
  });

  pi.registerTool({
    name: "work_state_read",
    label: "Work State Read",
    description: "Read this checkout's canonical cross-session to-do lists and working state.",
    promptSnippet: "Read canonical cross-session work state",
    parameters: Type.Object({
      list: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      includeClosed: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx?.cwd || activeCwd || process.cwd();
      const q = new URLSearchParams({ cwd });
      if (params.list) q.set("list", String(params.list));
      if (params.includeClosed) q.set("includeClosed", "true");
      try {
        const raw = await request("/api/work-state?" + q.toString(), {}, HTTP_TIMEOUT_MS);
        return { content: [{ type: "text", text: extractWorkerText(raw) }], details: { source: "central-claude-mem" } };
      } catch (error: any) {
        return { content: [{ type: "text", text: "Work state read unavailable: " + error.message }], details: { error: true } };
      }
    },
  });

  pi.registerTool({
    name: "claude_mem_remember",
    label: "Central Memory Remember",
    description: "Explicitly write a durable fact, decision, preference, or work result into the shared central claude-mem pool. Common secret formats are redacted before storage.",
    promptSnippet: "Store durable information in shared memory",
    parameters: Type.Object({
      content: Type.String({ minLength: 1, maxLength: 20_000 }),
      project: Type.Optional(Type.String({ maxLength: 96 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      refreshSession(ctx);
      const project = safeProject(String(params.project || activeProject));
      const sid = "pi-remember-" + crypto.randomUUID();
      const content = redactSecrets(params.content).slice(0, 20_000);
      try {
        await request(
          "/api/sessions/init",
          {
            method: "POST",
            body: JSON.stringify({
              contentSessionId: sid,
              project,
              prompt: "Remember this durable information for future sessions.",
              platformSource: PLATFORM_SOURCE,
              cwd: activeCwd,
            }),
          },
          HTTP_TIMEOUT_MS,
        );
        await request(
          "/api/sessions/observations",
          {
            method: "POST",
            body: JSON.stringify({
              contentSessionId: sid,
              platformSource: PLATFORM_SOURCE,
              tool_name: "pi_memory_remember",
              tool_input: { source: "pi", kind: "explicit_remember" },
              tool_response: content,
              cwd: ctx.cwd || process.cwd(),
            }),
          },
          HTTP_TIMEOUT_MS,
        );
        await request(
          "/api/sessions/summarize",
          {
            method: "POST",
            body: JSON.stringify({
              contentSessionId: sid,
              last_assistant_message: content.slice(0, MAX_ASSISTANT_CHARS),
              platformSource: PLATFORM_SOURCE,
              cwd: activeCwd,
            }),
          },
          HTTP_TIMEOUT_MS,
        );
        return { content: [{ type: "text", text: "Stored in central memory project " + project + "." }], details: { project, session_id: sid } };
      } catch (error: any) {
        return { content: [{ type: "text", text: "Central memory write failed: " + error.message }], details: { error: true } };
      }
    },
  });
}
