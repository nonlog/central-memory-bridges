// Central claude-mem integration for Oh My Pi (OMP).
// Uses the existing central Worker only: no local/fallback Worker or database is started.
// Automatic recall runs before substantive prompts; prompts, tool results, and summaries are
// ordered like upstream OMP hooks while preserving the central HTTPS/token transport and tools.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const WORKER_URL_FILE = process.env.CLAUDE_MEM_WORKER_URL_FILE || path.join(os.homedir(), ".omp", "agent", "claude-mem-worker-url");
const WORKER_TOKEN = process.env.CLAUDE_MEM_WORKER_TOKEN || "";

function resolveWorkerUrl(): string {
  const envUrl = String(process.env.CLAUDE_MEM_WORKER_URL || "").trim();
  if (envUrl) return envUrl.replace(/\/$/, "");
  try {
    const fileUrl = fs.readFileSync(WORKER_URL_FILE, "utf8").trim();
    if (fileUrl) return fileUrl.replace(/\/$/, "");
  } catch {}
  throw new Error(`CLAUDE_MEM_WORKER_URL is not configured and ${WORKER_URL_FILE} is unavailable`);
}
const BASE_PROJECT = "omp";
const PLATFORM_SOURCE = "omp";
const SEARCH_TIMEOUT_MS = 45_000;
const HTTP_TIMEOUT_MS = 5_000;
const SHUTDOWN_FLUSH_MS = 1_500;
const AUTO_BREAKER_FAILURES = 3;
const AUTO_BREAKER_OPEN_MS = 30_000;
const MAX_TOOL_PAYLOAD_CHARS = 16_000;
const MAX_TOOL_TEXT_CHARS = 12_000;
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

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value.trim());
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

function upstreamNativeOmpHookPaths(): string[] {
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent");
  return [
    path.join(agentDir, "hooks", "pre", "claude-mem.ts"),
    path.join(process.cwd(), ".omp", "hooks", "pre", "claude-mem.ts"),
  ];
}

function findUpstreamNativeOmpHook(): string | undefined {
  try {
    return upstreamNativeOmpHookPaths().find(candidate => fs.existsSync(candidate));
  } catch {
    return undefined;
  }
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

function sanitizeInjectedContext(text: string): string {
  return String(text || "")
    .split(/\r?\n/)
    .filter(line => !/Fetch details:.*get_observations|Access .*get_observations|mem-search skill/i.test(line))
    .join("\n")
    .trim();
}

async function request(route: string, init: RequestInit = {}, timeoutMs = HTTP_TIMEOUT_MS): Promise<any> {
  const worker = resolveWorkerUrl();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (WORKER_TOKEN) headers.authorization = `Bearer ${WORKER_TOKEN}`;
  Object.assign(headers, init.headers || {});
  const response = await fetch(`${worker}${route}`, {
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
  let activeCwd = process.cwd();
  let activeSessionId = `omp-${crypto.randomUUID()}`;
  let pendingPrompt = "";
  let pendingAssistant = "";
  let pendingCapture = false;
  let suppressCurrentCapture = false;
  let initTail: Promise<boolean> = Promise.resolve(false);
  let sessionAnchored = false;
  let sessionExcluded = false;
  let breakerFailures = 0;
  let breakerOpenUntil = 0;
  let captureQueue: Promise<void> = Promise.resolve();
  const inFlight = new Set<Promise<void>>();

  const nativeHookPath = findUpstreamNativeOmpHook();
  const allowDualCapture = parseBool(process.env.CLAUDE_MEM_CENTRAL_OMP_ALLOW_DUAL_CAPTURE, false);
  const automaticLifecycleEnabled = !nativeHookPath || allowDualCapture;
  if (nativeHookPath && !allowDualCapture) {
    console.warn(
      `[central-claude-mem] Upstream OMP hook detected at ${nativeHookPath}; ` +
      "automatic central capture/recall is disabled to prevent duplicate ingestion. " +
      "Remove that hook when using this central extension. Manual claude_mem_* tools remain available.",
    );
  }

  const resetAutomaticSession = () => {
    pendingPrompt = "";
    pendingAssistant = "";
    pendingCapture = false;
    initTail = Promise.resolve(false);
    sessionAnchored = false;
    sessionExcluded = false;
  };

  const refreshSession = (ctx: any, forceReset = false) => {
    const cwd = ctx?.sessionManager?.getCwd?.() || ctx?.cwd || process.cwd();
    const nextSessionId = contentSessionId(ctx, `omp-${crypto.randomUUID()}`);
    if (forceReset || nextSessionId !== activeSessionId) resetAutomaticSession();
    activeCwd = cwd;
    activeProject = projectForCwd(cwd);
    activeSessionId = nextSessionId;
  };

  const breakerOpen = () => Date.now() < breakerOpenUntil;
  const onAutoSuccess = () => {
    breakerFailures = 0;
    breakerOpenUntil = 0;
  };
  const onAutoFailure = () => {
    breakerFailures += 1;
    if (breakerFailures >= AUTO_BREAKER_FAILURES) {
      breakerFailures = 0;
      breakerOpenUntil = Date.now() + AUTO_BREAKER_OPEN_MS;
    }
  };

  const autoRequest = async (route: string, init: RequestInit = {}): Promise<any> => {
    if (breakerOpen()) throw new Error("central claude-mem automatic capture circuit breaker is open");
    try {
      const result = await request(route, init, HTTP_TIMEOUT_MS);
      onAutoSuccess();
      return result;
    } catch (error) {
      onAutoFailure();
      throw error;
    }
  };

  const background = (task: () => Promise<unknown>): Promise<void> => {
    const tracked = Promise.resolve()
      .then(task)
      .then(() => undefined)
      .catch(error => {
        pi.logger.debug("central claude-mem background capture failed", { error: String(error) });
      });
    inFlight.add(tracked);
    void tracked.finally(() => inFlight.delete(tracked));
    return tracked;
  };

  const flushBackground = async (timeoutMs = SHUTDOWN_FLUSH_MS) => {
    const pending = Array.from(inFlight);
    if (pending.length === 0) return;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
    ]);
  };

  const queuePromptInit = (safePrompt: string) => {
    const sid = activeSessionId;
    const project = activeProject;
    const cwd = activeCwd;
    initTail = initTail
      .catch(() => false)
      .then(async () => {
        if (sessionExcluded || breakerOpen()) return false;
        try {
          const reply = await autoRequest(
            "/api/sessions/init",
            {
              method: "POST",
              body: JSON.stringify({
                contentSessionId: sid,
                project,
                platformSource: PLATFORM_SOURCE,
                prompt: safePrompt,
                cwd,
              }),
            },
          );
          if (reply?.reason === "project_excluded") {
            sessionExcluded = true;
            return false;
          }
          sessionAnchored = true;
          return true;
        } catch {
          return false;
        }
      });
  };

  const captureTurn = async () => {
    const prompt = pendingPrompt;
    const assistant = pendingAssistant;
    const sid = activeSessionId;
    const cwd = activeCwd;
    const initForSummary = initTail;
    pendingPrompt = "";
    pendingAssistant = "";
    pendingCapture = false;
    if (suppressCurrentCapture) {
      suppressCurrentCapture = false;
      return;
    }
    if (isTrivialPrompt(prompt) || !assistant.trim()) return;

    const recorded = await initForSummary.catch(() => false);
    if (!recorded || !sessionAnchored || sessionExcluded) return;
    const safeAssistant = redactSecrets(assistant).slice(0, 24_000);
    await autoRequest(
      "/api/sessions/summarize",
      {
        method: "POST",
        body: JSON.stringify({
          contentSessionId: sid,
          platformSource: PLATFORM_SOURCE,
          last_assistant_message: safeAssistant.slice(0, 4_000),
          cwd,
        }),
      },
    );
  };

  const queueCapture = async () => {
    if (!pendingCapture || !pendingAssistant.trim()) return;
    captureQueue = captureQueue.then(captureTurn).catch(error => {
      pi.logger.debug("central claude-mem capture failed", { error: String(error) });
    });
    await captureQueue;
  };

  if (automaticLifecycleEnabled) {
    pi.on("session_start", async (_event, ctx) => {
      refreshSession(ctx, true);
    });

    pi.on("session_compact", async (_event, ctx) => {
      await queueCapture();
      const cwd = ctx?.sessionManager?.getCwd?.() || ctx?.cwd || process.cwd();
      resetAutomaticSession();
      activeCwd = cwd;
      activeProject = projectForCwd(cwd);
      activeSessionId = `omp-${crypto.randomUUID()}`;
    });

    pi.on("before_agent_start", async (event, ctx) => {
      await queueCapture();
      refreshSession(ctx);
      pendingPrompt = String(event.prompt || "");
      pendingAssistant = "";
      pendingCapture = !isTrivialPrompt(pendingPrompt);
      if (!pendingCapture) return;

      const safePrompt = redactSecrets(pendingPrompt).slice(0, 16_000);
      queuePromptInit(safePrompt);

      try {
        if (breakerOpen()) return;
        const projects = `${BASE_PROJECT},${activeProject}`;
        const context = await autoRequest(`/api/context/inject?${new URLSearchParams({ projects }).toString()}`);
        const text = sanitizeInjectedContext(extractWorkerText(context)).slice(0, MAX_CONTEXT_CHARS);
        if (!text) return;
        return {
          message: {
            customType: "central-claude-mem-context",
            content: `Central memory context for this OMP turn (past records; prefer newer verified facts when conflicts exist).\n\nOMP memory tool routing for this session is authoritative: use only claude_mem_search, claude_mem_recent, claude_mem_remember, and claude_mem_forget. Do not call legacy/raw mcp__claude_mem_* tools, get_observations, the mem-search skill, or a local claude-mem CLI unless those tools are explicitly mounted in this OMP session.\n\n${text}`,
            display: false,
          },
        };
      } catch (error) {
        pi.logger.debug("central claude-mem recall failed", { error: String(error) });
        return;
      }
    });

    pi.on("tool_result", async (event, ctx) => {
      const toolName = String((event as any)?.toolName || "");
      if (!toolName || toolName.startsWith("claude_mem_") || toolName.startsWith("memory_")) return;
      if (sessionExcluded) return;

      const sid = activeSessionId;
      const cwd = ctx?.cwd || activeCwd || process.cwd();
      const toolUseId = String((event as any)?.toolCallId || "").trim();
      const initForObservation = initTail;
      const responseText = redactSecrets(textFromContent((event as any)?.content)).slice(0, MAX_TOOL_TEXT_CHARS);
      const body = {
        contentSessionId: sid,
        platformSource: PLATFORM_SOURCE,
        tool_name: toolName,
        ...(toolUseId ? { tool_use_id: toolUseId } : {}),
        tool_input: sanitizeStructured((event as any)?.input),
        tool_response: sanitizeStructured({
          text: responseText,
          isError: Boolean((event as any)?.isError),
          details: (event as any)?.details,
        }),
        cwd,
      };

      background(async () => {
        const recorded = await initForObservation.catch(() => false);
        if (!recorded || sessionExcluded) return;
        await autoRequest("/api/sessions/observations", { method: "POST", body: JSON.stringify(body) });
      });
    });

    pi.on("message_end", async event => {
      const message = (event as any).message;
      const text = assistantMessageText(message);
      if (!text) return;
      pendingAssistant = text;
      const stopReason = String(message?.stopReason || "");
      if (stopReason === "stop" || stopReason === "end_turn" || stopReason === "length") {
        await queueCapture();
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
      await flushBackground();
    });
  }

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
              cwd: activeCwd,
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
              cwd: activeCwd,
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
              cwd: activeCwd,
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

  pi.registerTool({
    name: "claude_mem_forget",
    label: "Central Memory Forget",
    description: "Delete specific central claude-mem records by exact IDs. First identify the records with claude_mem_search/claude_mem_recent; never guess IDs. Supports observation, summary, and prompt records.",
    approval: "write",
    parameters: z.object({
      items: z
        .array(
          z.object({
            type: z.enum(["observation", "summary", "prompt"]),
            id: z.number().int().positive(),
          }),
        )
        .min(1)
        .max(50),
    }),
    async execute(_toolCallId, params) {
      // A deletion/cleanup turn should not immediately recreate a meta-memory
      // describing the deletion operation itself.
      suppressCurrentCapture = true;
      const deleted: Array<{ type: string; id: number }> = [];
      const failed: Array<{ type: string; id: number; error: string }> = [];
      for (const item of params.items) {
        try {
          await request(`/api/${item.type}/${item.id}`, { method: "DELETE" }, 12_000);
          deleted.push({ type: item.type, id: item.id });
        } catch (error: any) {
          failed.push({ type: item.type, id: item.id, error: String(error?.message || error) });
        }
      }
      const lines = [
        `Deleted ${deleted.length} central-memory record(s).`,
        ...deleted.map(item => `- ${item.type} #${item.id}`),
      ];
      if (failed.length) {
        lines.push(`Failed ${failed.length} record(s):`);
        lines.push(...failed.map(item => `- ${item.type} #${item.id}: ${item.error}`));
      }
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { deleted, failed, source: "central-claude-mem" },
      };
    },
  });
}
