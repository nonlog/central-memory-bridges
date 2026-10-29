// Central claude-mem integration for Pi Coding Agent.
// Lifecycle is intentionally aligned with upstream claude-mem's Claude Code/Codex hooks:
// session-start context once, per-prompt session init, async tool observations, and async summaries.
// Semantic per-prompt injection is optional and disabled by default, matching upstream defaults.

import crypto from "node:crypto";
import path from "node:path";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { modeFor, readConfig, unifiedRecall } from "../recall-bridge/core.mjs";
import { recordRecallDiagnostic } from "../recall-bridge/telemetry.mjs";
import { workerSearchMajor, planMemorySearch, planDumbSearch, formatWorkerSearchResult, compactSmartSearchIndex } from "../shared/worker-search-compat.mjs";

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
  type SessionState = {
    id: string;
    cwd: string;
    project: string;
    memory: string;
    semanticContext: string;
    unifiedContext: string;
    unifiedEntryId?: string;
    entryId?: string;
    initialized: boolean;
    anchored: boolean;
    excluded: boolean;
    needsSummary: boolean;
    lastAssistant: string;
    observedModel: string;
    queue: Promise<void>;
  };

  let current: SessionState | undefined;
  let notificationShown = false;
  const on = (event: string, handler: (event: any, ctx: any) => unknown) => (pi as any).on(event, handler);

  const extractTextContent = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter((part: any) => part && part.type === "text" && typeof part.text === "string")
      .map((part: any) => part.text)
      .join("\n");
  };

  const assistantText = (message: any): string => {
    if (!message || message.role !== "assistant") return "";
    return extractTextContent(message.content).trim();
  };

  const sessionId = (ctx: any): string => {
    try {
      const value = ctx?.sessionManager?.getSessionId?.();
      return typeof value === "string" ? value.trim() : "";
    } catch {
      return "";
    }
  };

  const sameSession = (session: SessionState, ctx: any): boolean => {
    const id = sessionId(ctx);
    const cwd = String(ctx?.cwd || session.cwd);
    return Boolean(id) && id === session.id && cwd === session.cwd;
  };

  const disarmTurn = (session: SessionState, keepEntry = false) => {
    if (!keepEntry) session.entryId = undefined;
    session.initialized = false;
    session.anchored = false;
    session.excluded = true;
    session.needsSummary = false;
    session.lastAssistant = "";
    session.semanticContext = "";
    session.unifiedContext = "";
    session.unifiedEntryId = undefined;
    session.observedModel = "";
  };

  const warn = (ctx: any, error: unknown) => {
    if (notificationShown || !ctx?.hasUI || !ctx?.ui?.notify) return;
    notificationShown = true;
    try {
      ctx.ui.notify("Central Claude-Mem is unavailable; Pi will continue without memory capture. " + String(error), "warning");
    } catch {}
  };

  const enqueue = (session: SessionState, ctx: any, task: () => Promise<void>): Promise<void> => {
    const next = session.queue
      .then(task, task)
      .catch((error) => {
        warn(ctx, error);
      });
    session.queue = next;
    return next;
  };

  const flushSession = async (session: SessionState, timeoutMs = SHUTDOWN_FLUSH_MS) => {
    await Promise.race([
      session.queue.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  };

  const loadSessionContext = async (session: SessionState) => {
    session.memory = "";
    if (modeFor(readConfig(), "pi") === "inject") {
      // Do not inject Claude-mem's historical session context twice. Retain
      // its separately managed Work State guidance and *all capture hooks*.
      try {
        const q = new URLSearchParams({ cwd: session.cwd });
        const raw = await request("/api/work-state?" + q.toString(), {}, HTTP_TIMEOUT_MS);
        const state = extractWorkerText(raw).trim();
        if (state) session.memory = (WORK_STATE_GUIDANCE + "\n" + state).slice(0, MAX_CONTEXT_CHARS);
      } catch {}
      return;
    }
    try {
      const projects = BASE_PROJECT + "," + session.project;
      const query = new URLSearchParams({ projects });
      const raw = await request("/api/context/inject?" + query.toString(), {}, SESSION_CONTEXT_TIMEOUT_MS);
      const stripped = stripWorkStateContext(extractWorkerText(raw));
      const blocks: string[] = [];

      if (stripped.hadWorkState) {
        try {
          const q = new URLSearchParams({ cwd: session.cwd });
          const state = await request("/api/work-state?" + q.toString(), {}, HTTP_TIMEOUT_MS);
          const stateText = extractWorkerText(state).trim();
          if (stateText) blocks.push(WORK_STATE_GUIDANCE + "\n" + stateText);
        } catch {}
      }

      if (stripped.text.trim()) blocks.push(stripped.text.trim());
      session.memory = blocks.join("\n\n").slice(0, MAX_CONTEXT_CHARS);
    } catch {
      session.memory = "";
    }
  };

  const beginSession = async (_event: any, ctx: any) => {
    const id = sessionId(ctx);
    const cwd = String(ctx?.cwd || process.cwd());
    if (!id || !cwd) {
      current = undefined;
      return;
    }

    const session: SessionState = {
      id,
      cwd,
      project: projectForCwd(cwd),
      memory: "",
      semanticContext: "",
      unifiedContext: "",
      initialized: false,
      anchored: false,
      excluded: true,
      needsSummary: false,
      lastAssistant: "",
      observedModel: "",
      queue: Promise.resolve(),
    };
    current = session;
    notificationShown = false;
    await loadSessionContext(session);
  };

  const resetTurn = async (_event: any, ctx: any) => {
    if (!current || !sameSession(current, ctx)) await beginSession(_event, ctx);
    const session = current;
    if (!session) return;
    disarmTurn(session);
    session.observedModel = String(ctx?.model?.id || "");
  };

  const selectEntry = (session: SessionState, ctx: any, messages: any[]): { entry: any; prompt: string } | undefined => {
    try {
      if (current !== session || !sameSession(session, ctx) || typeof ctx?.sessionManager?.getBranch !== "function") return;
      const branch = ctx.sessionManager.getBranch();
      if (!Array.isArray(branch)) return;
      const entry = [...branch].reverse().find(
        (item: any) => item?.type === "message" && item?.message?.role === "user",
      );
      if (!entry || typeof entry.id !== "string" || !/^[^\s\x00-\x1f\x7f]{1,256}$/.test(entry.id)) return;
      const timestamp = entry.message?.timestamp;
      if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return;
      // The stored Pi branch is authoritative. Request-time extensions may add
      // another user message or append context to the real user's text.
      const prompt = extractTextContent(entry.message?.content);
      const user = [...messages].reverse().find((message: any) =>
        message?.role === "user" && message.timestamp === timestamp &&
        extractTextContent(message.content).startsWith(prompt));
      if (!user) return;
      return { entry, prompt };
    } catch {
      return;
    }
  };

  const loadSemanticContext = async (session: SessionState, prompt: string) => {
    session.semanticContext = "";
    if (modeFor(readConfig(), "pi") === "inject") return;
    if (!SEMANTIC_INJECT || prompt.length < 20) return;
    try {
      const semantic = await request(
        "/api/context/semantic",
        {
          method: "POST",
          body: JSON.stringify({
            q: prompt,
            project: session.project,
            limit: SEMANTIC_INJECT_LIMIT,
            platformSource: PLATFORM_SOURCE,
          }),
        },
        HTTP_TIMEOUT_MS,
      );
      session.semanticContext = String(semantic?.context || "").trim().slice(0, MAX_CONTEXT_CHARS);
    } catch {
      session.semanticContext = "";
    }
  };

  const queueSummary = (session: SessionState | undefined, ctx: any): Promise<void> => {
    if (!session || !session.anchored || session.excluded || !session.needsSummary) return Promise.resolve();
    const entryId = session.entryId;
    const assistant = session.lastAssistant.trim();
    if (!assistant) return Promise.resolve();

    const body = {
      contentSessionId: session.id,
      last_assistant_message: redactSecrets(assistant).slice(0, MAX_ASSISTANT_CHARS),
      platformSource: PLATFORM_SOURCE,
      observedModel: session.observedModel || undefined,
      cwd: session.cwd,
    };

    return enqueue(session, ctx, async () => {
      if (!entryId || session.entryId !== entryId || !session.anchored || session.excluded || !session.needsSummary) return;
      await request(
        "/api/sessions/summarize",
        { method: "POST", body: JSON.stringify(body) },
        HTTP_TIMEOUT_MS,
      );
      if (session.entryId === entryId) session.needsSummary = false;
    });
  };

  on("session_start", beginSession);
  // Older Pi releases emitted switch/fork separately; current Pi emits session_start.
  on("session_switch", beginSession);
  on("session_fork", beginSession);

  on("before_agent_start", resetTurn);
  on("session_tree", resetTurn);

  // Pi persists the user SessionEntry before context_with_system. This is the
  // first lifecycle point where the real persisted entry.id can safely become
  // Worker nativePromptId. before_agent_start is intentionally admission-free.
  on("context_with_system", async (event: any, ctx: any) => {
    if (!current || !sameSession(current, ctx)) await beginSession(event, ctx);
    const session = current;
    const messages = event?.messages;
    if (!session) return;

    const systemIndex = Array.isArray(messages)
      ? messages.findIndex((message: any) => message?.role === "system" && typeof message.content === "string") : -1;
    if (systemIndex < 0) {
      disarmTurn(session);
      return;
    }
    const baseSystem = messages[systemIndex].content;

    await enqueue(session, ctx, async () => {
      try {
        const selected = selectEntry(session, ctx, messages);
        if (!selected || !selected.prompt.trim()) {
          disarmTurn(session);
          return;
        }
        const { entry, prompt } = selected;

        if (session.entryId !== entry.id) {
          disarmTurn(session);
          session.entryId = entry.id;
          session.observedModel = String(ctx?.model?.id || "");
        }

        if (!session.initialized) {
          // Do not fall back to legacy text identity. A capability probe is
          // read-only and prevents silently attaching tools to the wrong turn.
          const capability = await request("/api/sessions/native-prompt-capability", {}, HTTP_TIMEOUT_MS);
          if (capability?.nativePromptId !== 1) {
            throw new Error("Worker does not support native Pi prompt identity.");
          }

          if (selectEntry(session, ctx, messages)?.entry.id !== entry.id) {
            disarmTurn(session, true);
            return;
          }

          const safePrompt = redactSecrets(prompt).slice(0, MAX_PROMPT_CHARS);
          const result = await request(
            "/api/sessions/init",
            {
              method: "POST",
              body: JSON.stringify({
                contentSessionId: session.id,
                project: session.project,
                prompt: safePrompt,
                platformSource: PLATFORM_SOURCE,
                cwd: session.cwd,
                nativePromptId: entry.id,
              }),
            },
            HTTP_TIMEOUT_MS,
          );

          if (selectEntry(session, ctx, messages)?.entry.id !== entry.id) {
            disarmTurn(session, true);
            return;
          }

          if (result?.skipped === true && result?.reason !== "duplicate") {
            session.initialized = true;
            session.anchored = false;
            session.excluded = true;
            session.needsSummary = false;
            return;
          }

          if (result?.nativePromptId !== entry.id || typeof result?.sessionDbId !== "number") {
            throw new Error("Worker did not acknowledge the persisted Pi user-entry ID.");
          }

          session.initialized = true;
          session.anchored = result?.nativePromptCurrent === true;
          session.excluded = !session.anchored;
          session.needsSummary = session.anchored;

          if (session.anchored) await loadSemanticContext(session, safePrompt);
        }
      } catch (error) {
        disarmTurn(session, true);
        throw error;
      }
    });

    if (current !== session || !session.anchored || session.excluded) return;
    // Collect once per real, persisted Pi user entry. A shadow lookup must
    // never change what the model sees, and must not block its first token.
    const selected = selectEntry(session, ctx, messages);
    if (selected && selected.prompt.trim() && session.unifiedEntryId !== selected.entry.id) {
      session.unifiedEntryId = selected.entry.id;
      const config = readConfig();
      const mode = modeFor(config, "pi");
      if (mode !== "off") {
        const cwd = session.cwd;
        const prompt = selected.prompt;
        let hindsightConfig: any = undefined;
        try {
          hindsightConfig = JSON.parse(readFileSync(path.join(homedir(), ".hindsight", "coding-agent.json"), "utf8"));
        } catch {}
        const lookUp = async () => {
          const result = await unifiedRecall({ prompt, cwd, harness: "pi" }, { config, hindsightConfig });
          recordRecallDiagnostic(result.diagnostic);
          return result.context;
        };
        if (mode === "shadow") {
          void lookUp().catch(() => recordRecallDiagnostic({ mode: "error", harness: "pi" }));
        } else {
          try { session.unifiedContext = await lookUp(); } catch {
            recordRecallDiagnostic({ mode: "error", harness: "pi" });
          }
        }
      }
    }
    const blocks = [session.memory, session.semanticContext, session.unifiedContext]
      .filter((value) => Boolean(value && value.trim()));
    const additionalContext = blocks.join("\n\n").trim();
    if (!additionalContext) return;

    const injected = [...messages];
    injected[systemIndex] = {
      ...messages[systemIndex],
      content: baseSystem + "\n\n<claude-mem-context>\n" + additionalContext + "\n</claude-mem-context>",
    };
    return { messages: injected };
  });

  on("tool_result", (event: any, ctx: any) => {
    const session = current;
    const toolName = String(event?.toolName || "");
    if (
      !session ||
      !toolName ||
      toolName.startsWith("claude_mem_") ||
      toolName.startsWith("work_state_") ||
      toolName.startsWith("mem_") ||
      SKIP_TOOLS.has(toolName.toLowerCase()) ||
      !session.anchored ||
      session.excluded
    ) return;

    const entryId = session.entryId;
    const body = {
      contentSessionId: session.id,
      platformSource: PLATFORM_SOURCE,
      tool_name: toolName,
      ...(String(event?.toolCallId || "").trim() ? { tool_use_id: String(event.toolCallId).trim() } : {}),
      tool_input: sanitizeStructured(event?.input),
      tool_response: serializeToolResponse(event),
      cwd: session.cwd,
    };

    // Preserve upstream prompt -> tool -> summary ordering without adding the
    // remote HTTPS round-trip to Pi's tool-result critical path.
    void enqueue(session, ctx, async () => {
      if (!entryId || session.entryId !== entryId) return;
      await request(
        "/api/sessions/observations",
        { method: "POST", body: JSON.stringify(body) },
        HTTP_TIMEOUT_MS,
      );
    });
  });

  const captureAssistant = (message: any) => {
    const text = assistantText(message);
    if (current && text) current.lastAssistant = text;
  };

  on("message_end", (event: any) => captureAssistant(event?.message));
  on("turn_end", (event: any) => captureAssistant(event?.message));

  on("agent_end", async (event: any, ctx: any) => {
    if (current && Array.isArray(event?.messages)) {
      for (let i = event.messages.length - 1; i >= 0; i--) {
        const text = assistantText(event.messages[i]);
        if (text) {
          current.lastAssistant = text;
          break;
        }
      }
    }
    await queueSummary(current, ctx);
  });

  // Keep compatibility with Pi builds that expose agent_settled; queueSummary
  // is idempotent after a successful summary.
  on("agent_settled", async (_event: any, ctx: any) => {
    await queueSummary(current, ctx);
  });

  on("session_before_compact", async (_event: any, ctx: any) => {
    await queueSummary(current, ctx);
  });

  on("session_compact", async (_event: any, ctx: any) => {
    const session = current;
    if (!session || !sameSession(session, ctx)) return;
    await loadSessionContext(session);
  });

  on("session_shutdown", async (_event: any, ctx: any) => {
    const session = current;
    await queueSummary(session, ctx);
    if (session) await flushSession(session);
  });

  const toolResult = (text: string, details: Record<string, unknown> = {}) => ({
    content: [{ type: "text" as const, text }],
    details,
  });

  const executeRead = async (route: string, timeoutMs = SEARCH_TIMEOUT_MS) => {
    const raw = await request(route, {}, timeoutMs);
    return extractWorkerText(raw);
  };

  // Preserve the existing cross-client search tool name for compatibility.
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
        return toolResult(await executeRead("/api/search/observations?" + q.toString()), { source: "central-claude-mem" });
      } catch (error: any) {
        return toolResult("Central memory search failed: " + error.message, { error: true });
      }
    },
  });

  // The Worker 14 guided workflow uses /api/mem-search; Worker 15 deleted that
  // endpoint. Keep mem_search as a compatibility name: on 15 it provides the
  // first Smart-search index, followed by mem_timeline and mem_get_observations.
  pi.registerTool({
    name: "mem_search",
    label: "Memory Search",
    description: "Smart memory search. On Worker 15 use mem_search({query}) for index, then mem_timeline and mem_get_observations. mode=auto is optional shallow dumb search. On Worker 14 the guided continuation protocol still works.",
    promptSnippet: "Search memory with progressive disclosure",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      mode: Type.Optional(Type.String({ pattern: "^(guided|auto)$" })),
      project: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      maxDetails: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
      depthBefore: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
      depthAfter: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
      continuation: Type.Optional(Type.String({ pattern: "^ms_[A-Za-z0-9_-]{24}$" })),
      selectedIds: Type.Optional(
        Type.Array(
          Type.Union([
            Type.String({ minLength: 1, maxLength: 128 }),
            Type.Integer(),
          ]),
          { maxItems: 5 },
        ),
      ),
    }),
    async execute(_toolCallId, params) {
      const mode = params.mode === undefined ? "guided" : String(params.mode);
      if (mode !== "guided" && mode !== "auto") {
        return toolResult("mode must be guided or auto.", { error: true });
      }

      const continuation = typeof params.continuation === "string" ? params.continuation.trim() : "";
      const query = typeof params.query === "string" ? params.query.trim() : "";

      if (!continuation) {
        if (!query) return toolResult("Start mem_search with a query.", { error: true });
        if (Buffer.byteLength(query, "utf8") > 1024) {
          return toolResult("query must be at most 1024 UTF-8 bytes.", { error: true });
        }
        if (params.selectedIds !== undefined) {
          return toolResult("selectedIds requires the preceding step's continuation.", { error: true });
        }
      } else {
        if (mode !== "guided") {
          return toolResult("Continuations use guided mode.", { error: true });
        }
        if (!Array.isArray(params.selectedIds)) {
          return toolResult("Choose selectedIds from the preceding mem-search step; [] ends the search.", { error: true });
        }
      }

      const body: Record<string, unknown> = { mode };
      if (query) body.query = query;
      if (params.project !== undefined) {
        const project = String(params.project).trim();
        if (!project || Buffer.byteLength(project, "utf8") > 256) {
          return toolResult("project must be nonempty and at most 256 UTF-8 bytes.", { error: true });
        }
        body.project = project;
      }
      if (params.limit !== undefined) body.limit = params.limit;
      if (params.maxDetails !== undefined) body.maxDetails = params.maxDetails;
      if (params.depthBefore !== undefined) body.depthBefore = params.depthBefore;
      if (params.depthAfter !== undefined) body.depthAfter = params.depthAfter;
      if (continuation) body.continuation = continuation;
      if (params.selectedIds !== undefined) body.selectedIds = params.selectedIds;

      try {
        const major = workerSearchMajor(await request("/api/version", {}, HTTP_TIMEOUT_MS));
        const plan = planMemorySearch(major, body);
        const raw = await request(
          plan.route,
          plan.method === "POST" ? { method: "POST", body: JSON.stringify(plan.body) } : {},
          SEARCH_TIMEOUT_MS,
        );
        const mcp = formatWorkerSearchResult(raw);
        const display = plan.step === "smart-index"
          ? compactSmartSearchIndex(raw, body) : (mcp || raw);
        return toolResult(extractWorkerText(display), {
          source: "central-claude-mem",
          progressive: true,
          mode,
          searchStep: plan.step,
          ...(mcp?.isError ? { error: true } : {}),
        });
      } catch (error: any) {
        return toolResult("Memory search failed: " + error.message, { error: true });
      }
    },
  });

  pi.registerTool({
    name: "dumb_search",
    label: "Dumb Memory Search",
    description: "Optional shallow one-call memory lookup. On Worker 15 uses /api/dumb-search; on Worker 14 falls back to legacy auto mode. Prefer Smart mem_search → mem_timeline → mem_get_observations.",
    promptSnippet: "Optional shallow memory lookup",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500 }),
      project: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
      maxDetails: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
      depthBefore: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
      depthAfter: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
    }),
    async execute(_toolCallId, params) {
      try {
        const major = workerSearchMajor(await request("/api/version", {}, HTTP_TIMEOUT_MS));
        const plan = planDumbSearch(major, params);
        const raw = await request(plan.route,
          { method: "POST", body: JSON.stringify(plan.body) }, SEARCH_TIMEOUT_MS);
        const mcp = formatWorkerSearchResult(raw);
        return toolResult(extractWorkerText(mcp || raw), {
          source: "central-claude-mem", searchStep: plan.step,
          ...(mcp?.isError ? { error: true } : {}),
        });
      } catch (error: any) {
        return toolResult("Dumb search failed: " + error.message, { error: true });
      }
    },
  });

  pi.registerTool({
    name: "mem_timeline",
    label: "Memory Timeline",
    description: "Inspect the neighborhood of an observation ID or search query. Supply exactly one of anchor or query.",
    promptSnippet: "Inspect nearby memory context",
    parameters: Type.Object({
      anchor: Type.Optional(Type.Union([Type.Number(), Type.String()])),
      query: Type.Optional(Type.String()),
      depth_before: Type.Optional(Type.Number({ minimum: 0, maximum: 50 })),
      depth_after: Type.Optional(Type.Number({ minimum: 0, maximum: 50 })),
      project: Type.Optional(Type.String({ maxLength: 96 })),
    }),
    async execute(_toolCallId, params) {
      if ((params.anchor === undefined) === (params.query === undefined)) {
        return toolResult("Supply exactly one of anchor or query.", { error: true });
      }
      const q = new URLSearchParams();
      if (params.anchor !== undefined) q.set("anchor", String(params.anchor));
      if (params.query !== undefined) q.set("query", String(params.query));
      if (params.depth_before !== undefined) q.set("depth_before", String(params.depth_before));
      if (params.depth_after !== undefined) q.set("depth_after", String(params.depth_after));
      if (params.project) q.set("project", safeProject(String(params.project)));
      try {
        return toolResult(await executeRead("/api/timeline?" + q.toString()), { source: "central-claude-mem" });
      } catch (error: any) {
        return toolResult("Memory timeline failed: " + error.message, { error: true });
      }
    },
  });

  pi.registerTool({
    name: "mem_get_observations",
    label: "Memory Observations",
    description: "Fetch full observation records by numeric IDs selected from Smart mem_search and mem_timeline. Summary IDs (S...) and prompt IDs (P...) are not observation IDs.",
    promptSnippet: "Fetch selected memory observations",
    parameters: Type.Object({
      ids: Type.Array(Type.Number({ minimum: 1 }), { minItems: 1, maxItems: 100 }),
    }),
    async execute(_toolCallId, params) {
      try {
        const raw = await request(
          "/api/observations/batch",
          { method: "POST", body: JSON.stringify({ ids: params.ids }) },
          SEARCH_TIMEOUT_MS,
        );
        return toolResult(extractWorkerText(raw), { source: "central-claude-mem" });
      } catch (error: any) {
        return toolResult("Memory observation fetch failed: " + error.message, { error: true });
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
        return toolResult(await executeRead("/api/context/recent?" + q.toString(), 10_000), { source: "central-claude-mem" });
      } catch (error: any) {
        return toolResult("Central recent memory failed: " + error.message, { error: true });
      }
    },
  });

  pi.registerTool({
    name: "work_state_write",
    label: "Work State Write",
    description: "Append one update to this checkout's canonical cross-session to-do list or working state. Use when Work State context is present (Worker 13.29+).",
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
      const cwd = ctx?.cwd || current?.cwd || process.cwd();
      if (!params.fields || Object.keys(params.fields).length === 0) {
        return toolResult("fields must be a non-empty object", { error: true });
      }
      if (Object.entries(params.fields).some(([key, value]) =>
        !key || (typeof value === "number" &&
          (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))))
      )) {
        return toolResult("fields must use non-empty names and safe finite numeric values", { error: true });
      }
      if (JSON.stringify(params.fields).length > 2_000) {
        return toolResult("fields must be at most 2000 characters as JSON", { error: true });
      }
      try {
        const raw = await request(
          "/api/work-state/entries",
          { method: "POST", body: JSON.stringify({ cwd, list: String(params.list), fields: params.fields }) },
          HTTP_TIMEOUT_MS,
        );
        return toolResult(extractWorkerText(raw), { source: "central-claude-mem" });
      } catch (error: any) {
        return toolResult("Work state write unavailable: " + error.message, { error: true });
      }
    },
  });

  pi.registerTool({
    name: "work_state_read",
    label: "Work State Read",
    description: "Read this checkout's canonical cross-session to-do lists and working state. Use when Work State context is present (Worker 13.29+).",
    promptSnippet: "Read canonical cross-session work state",
    parameters: Type.Object({
      list: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      includeClosed: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const cwd = ctx?.cwd || current?.cwd || process.cwd();
      const q = new URLSearchParams({ cwd });
      if (params.list) q.set("list", String(params.list));
      if (params.includeClosed) q.set("includeClosed", "true");
      try {
        return toolResult(await executeRead("/api/work-state?" + q.toString(), HTTP_TIMEOUT_MS), { source: "central-claude-mem" });
      } catch (error: any) {
        return toolResult("Work state read unavailable: " + error.message, { error: true });
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
      const cwd = String(ctx?.cwd || current?.cwd || process.cwd());
      const project = safeProject(String(params.project || current?.project || projectForCwd(cwd)));
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
              cwd,
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
              cwd,
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
              cwd,
            }),
          },
          HTTP_TIMEOUT_MS,
        );
        return toolResult("Stored in central memory project " + project + ".", { project, session_id: sid });
      } catch (error: any) {
        return toolResult("Central memory write failed: " + error.message, { error: true });
      }
    },
  });
}
