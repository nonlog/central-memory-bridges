// Central claude-mem integration for Oh My Pi (OMP).
// Uses the existing central Worker only: no local/fallback Worker or database is started.
// Automatic recall runs before substantive prompts; final user/assistant turns are captured
// after the OMP agent loop settles. Tool outputs are intentionally not persisted here.

import crypto from "node:crypto";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const WORKER = (process.env.CLAUDE_MEM_WORKER_URL || "").replace(/\/$/, "");
const WORKER_TOKEN = process.env.CLAUDE_MEM_WORKER_TOKEN || "";
const BASE_PROJECT = "omp";
const PLATFORM_SOURCE = "omp";
const SEARCH_TIMEOUT_MS = 45_000;
const HTTP_TIMEOUT_MS = 12_000;
const MAX_CONTEXT_CHARS = 8_000;

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}\b/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\b(api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password)\s*[:=]\s*[^\s,;]{8,}/gi,
];

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
  return safeProject(`${BASE_PROJECT}-${base}`, "omp-default");
}

function isTrivialPrompt(prompt: string): boolean {
  const text = String(prompt || "").trim();
  return !text || text.length < 3 || /^\/(help|quit|exit|clear|reload)(\s|$)/i.test(text);
}

function assistantMessageText(message: any): string {
  if (!message || message.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part: any) => part && part.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text)
    .join("\n")
    .trim();
}

function lastAssistantText(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = assistantMessageText(messages[i]);
    if (text) return text;
  }
  return "";
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

async function request(route: string, init: RequestInit = {}, timeoutMs = HTTP_TIMEOUT_MS): Promise<any> {
  if (!WORKER) throw new Error("CLAUDE_MEM_WORKER_URL is not configured");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (WORKER_TOKEN) headers.authorization = `Bearer ${WORKER_TOKEN}`;
  Object.assign(headers, init.headers || {});
  const response = await fetch(`${WORKER}${route}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`claude-mem ${response.status}: ${text.slice(0, 500)}`);
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
    if (typeof id === "string" && id.trim()) return `omp-${safeProject(id, fallback)}`;
  } catch {}
  return fallback;
}

export default function centralClaudeMem(pi: ExtensionAPI) {
  const z = pi.zod;
  let activeProject = projectForCwd();
  let activeSessionId = `omp-${crypto.randomUUID()}`;
  let pendingPrompt = "";
  let pendingAssistant = "";
  let pendingCapture = false;
  let captureQueue: Promise<void> = Promise.resolve();

  const refreshSession = (ctx: any) => {
    const cwd = ctx?.sessionManager?.getCwd?.() || process.cwd();
    activeProject = projectForCwd(cwd);
    activeSessionId = contentSessionId(ctx, `omp-${crypto.randomUUID()}`);
  };

  const captureTurn = async () => {
    const prompt = pendingPrompt;
    const assistant = pendingAssistant;
    const sid = activeSessionId;
    pendingPrompt = "";
    pendingAssistant = "";
    pendingCapture = false;
    if (isTrivialPrompt(prompt) || !assistant.trim()) return;

    const safeAssistant = redactSecrets(assistant).slice(0, 24_000);
    await request(
      "/api/sessions/observations",
      {
        method: "POST",
        body: JSON.stringify({
          contentSessionId: sid,
          platformSource: PLATFORM_SOURCE,
          tool_name: "assistant_message",
          tool_input: { source: PLATFORM_SOURCE },
          tool_response: safeAssistant.slice(0, 1000),
          cwd: process.cwd(),
        }),
      },
      15_000,
    );
    await request(
      "/api/sessions/summarize",
      {
        method: "POST",
        body: JSON.stringify({
          contentSessionId: sid,
          platformSource: PLATFORM_SOURCE,
          last_assistant_message: safeAssistant.slice(0, 4_000),
        }),
      },
      SEARCH_TIMEOUT_MS,
    );
  };

  const queueCapture = async () => {
    if (!pendingCapture || !pendingAssistant.trim()) return;
    captureQueue = captureQueue.then(captureTurn).catch(error => {
      pi.logger.debug("central claude-mem capture failed", { error: String(error) });
    });
    await captureQueue;
  };

  pi.on("session_start", async (_event, ctx) => {
    refreshSession(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await queueCapture();
    refreshSession(ctx);
    pendingPrompt = String(event.prompt || "");
    pendingAssistant = "";
    pendingCapture = !isTrivialPrompt(pendingPrompt);
    if (!pendingCapture) return;

    const safePrompt = redactSecrets(pendingPrompt).slice(0, 16_000);
    try {
      await request(
        "/api/sessions/init",
        {
          method: "POST",
          body: JSON.stringify({
            contentSessionId: activeSessionId,
            project: activeProject,
            platformSource: PLATFORM_SOURCE,
            prompt: safePrompt,
          }),
        },
        8_000,
      );
      const projects = `${BASE_PROJECT},${activeProject}`;
      const context = await request(`/api/context/inject?${new URLSearchParams({ projects }).toString()}`, {}, 10_000);
      const text = extractWorkerText(context).trim().slice(0, MAX_CONTEXT_CHARS);
      if (!text) return;
      return {
        message: {
          customType: "central-claude-mem-context",
          content: `Central memory context for this OMP turn (past records; prefer newer verified facts when conflicts exist):\n\n${text}`,
          display: false,
        },
      };
    } catch (error) {
      pi.logger.debug("central claude-mem recall failed", { error: String(error) });
      return;
    }
  });

  pi.on("turn_end", async event => {
    const text = assistantMessageText((event as any).message);
    if (text) pendingAssistant = text;
  });

  pi.on("agent_end", async event => {
    const text = lastAssistantText((event as any).messages || []);
    if (text) pendingAssistant = text;
    if ((event as any).willContinue) return;
    await queueCapture();
  });

  pi.on("session_shutdown", async () => {
    await queueCapture();
  });

  pi.registerTool({
    name: "claude_mem_search",
    label: "Central Memory Search",
    description: "Search the shared central claude-mem pool across OMP, Pi, Claude Code, Codex, OpenClaw, Hermes, ChatGPT, and other projects.",
    approval: "read",
    parameters: z.object({
      query: z.string().min(1).max(1000),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    async execute(_toolCallId, params) {
      const q = new URLSearchParams({ query: String(params.query), limit: String(params.limit || 8) });
      try {
        const raw = await request(`/api/search/observations?${q.toString()}`, {}, SEARCH_TIMEOUT_MS);
        return { content: [{ type: "text", text: extractWorkerText(raw) }], details: { source: "central-claude-mem" } };
      } catch (error: any) {
        return { content: [{ type: "text", text: `Central memory search failed: ${error.message}` }], details: { error: true } };
      }
    },
  });

  pi.registerTool({
    name: "claude_mem_recent",
    label: "Central Memory Recent",
    description: "Read recent central claude-mem context for a known project.",
    approval: "read",
    parameters: z.object({
      project: z.string().min(1).max(96),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    async execute(_toolCallId, params) {
      const q = new URLSearchParams({ project: safeProject(String(params.project)), limit: String(params.limit || 5) });
      try {
        const raw = await request(`/api/context/recent?${q.toString()}`, {}, 10_000);
        return { content: [{ type: "text", text: extractWorkerText(raw) }], details: { source: "central-claude-mem" } };
      } catch (error: any) {
        return { content: [{ type: "text", text: `Central recent memory failed: ${error.message}` }], details: { error: true } };
      }
    },
  });

  pi.registerTool({
    name: "claude_mem_remember",
    label: "Central Memory Remember",
    description: "Explicitly store a durable fact, decision, preference, or work result in the shared central claude-mem pool. Common secret formats are redacted before storage.",
    approval: "write",
    parameters: z.object({
      content: z.string().min(1).max(20_000),
      project: z.string().max(96).optional(),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      refreshSession(ctx);
      const project = safeProject(String(params.project || activeProject));
      const sid = `omp-remember-${crypto.randomUUID()}`;
      const content = redactSecrets(params.content).slice(0, 20_000);
      try {
        await request(
          "/api/sessions/init",
          {
            method: "POST",
            body: JSON.stringify({
              contentSessionId: sid,
              project,
              platformSource: PLATFORM_SOURCE,
              prompt: "Remember this durable information for future sessions.",
            }),
          },
          8_000,
        );
        await request(
          "/api/sessions/observations",
          {
            method: "POST",
            body: JSON.stringify({
              contentSessionId: sid,
              platformSource: PLATFORM_SOURCE,
              tool_name: "omp_memory_remember",
              tool_input: { source: PLATFORM_SOURCE, kind: "explicit_remember" },
              tool_response: content.slice(0, 1000),
              cwd: process.cwd(),
            }),
          },
          15_000,
        );
        await request(
          "/api/sessions/summarize",
          {
            method: "POST",
            body: JSON.stringify({
              contentSessionId: sid,
              platformSource: PLATFORM_SOURCE,
              last_assistant_message: content.slice(0, 4_000),
            }),
          },
          SEARCH_TIMEOUT_MS,
        );
        return {
          content: [{ type: "text", text: `Stored in central memory project ${project}.` }],
          details: { project, session_id: sid, platform_source: PLATFORM_SOURCE },
        };
      } catch (error: any) {
        return { content: [{ type: "text", text: `Central memory write failed: ${error.message}` }], details: { error: true } };
      }
    },
  });
}
