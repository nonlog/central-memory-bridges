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
  let activeSessionId = "pi-" + crypto.randomUUID();
  let startupContext = "";
  let startupContextDelivered = false;
  let pendingPrompt = "";
  let pendingAssistant = "";
  let pendingSummary = false;
  const inFlight = new Set<Promise<void>>();

  const refreshSession = (ctx: any, cwd?: string) => {
    const resolvedCwd = cwd || ctx?.cwd || process.cwd();
    activeProject = projectForCwd(resolvedCwd);
    activeSessionId = contentSessionId(ctx, "pi-" + crypto.randomUUID());
  };

  const background = (task: () => Promise<unknown>) => {
    let tracked: Promise<void>;
    tracked = Promise.resolve()
      .then(task)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => inFlight.delete(tracked));
    inFlight.add(tracked);
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
      startupContext = extractWorkerText(raw).trim().slice(0, MAX_CONTEXT_CHARS);
    } catch {
      startupContext = "";
    }
  };

  const queueSummary = () => {
    if (!pendingSummary) return;
    const assistant = pendingAssistant.trim();
    const sid = activeSessionId;
    pendingPrompt = "";
    pendingAssistant = "";
    pendingSummary = false;
    if (!assistant) return;

    const safeAssistant = redactSecrets(assistant).slice(0, MAX_ASSISTANT_CHARS);
    background(() =>
      request(
        "/api/sessions/summarize",
        {
          method: "POST",
          body: JSON.stringify({
            contentSessionId: sid,
            last_assistant_message: safeAssistant,
            platformSource: PLATFORM_SOURCE,
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
    if (!toolName || toolName.startsWith("claude_mem_")) return;

    const sid = activeSessionId;
    const cwd = ctx.cwd || process.cwd();
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
    queueSummary();
  });

  pi.on("session_shutdown", async () => {
    queueSummary();
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
