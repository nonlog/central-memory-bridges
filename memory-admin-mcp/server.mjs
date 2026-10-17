import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const DEFAULT_URL_FILE = path.join(os.homedir(), '.central-memory', 'worker-url');
const WORKER_URL_FILE = process.env.CLAUDE_MEM_WORKER_URL_FILE || DEFAULT_URL_FILE;
const WORKER_TOKEN = String(process.env.CLAUDE_MEM_WORKER_TOKEN || '').trim();
const HTTP_TIMEOUT_MS = 12_000;

function resolveWorkerUrl() {
  const fromEnv = String(process.env.CLAUDE_MEM_WORKER_URL || '').trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');

  try {
    const fromFile = fs.readFileSync(WORKER_URL_FILE, 'utf8').trim();
    if (fromFile) return fromFile.replace(/\/$/, '');
  } catch {}

  throw new Error(
    `CLAUDE_MEM_WORKER_URL is not configured and ${WORKER_URL_FILE} is unavailable`,
  );
}

async function deleteRecord(type, id) {
  const workerUrl = resolveWorkerUrl();
  const headers = { accept: 'application/json' };
  if (WORKER_TOKEN) headers.authorization = `Bearer ${WORKER_TOKEN}`;

  const response = await fetch(`${workerUrl}/api/${type}/${id}`, {
    method: 'DELETE',
    headers,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {}

  if (!response.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    throw new Error(`claude-mem ${response.status}: ${detail.slice(0, 500)}`);
  }

  return body;
}

const itemSchema = z.object({
  type: z.enum(['observation', 'summary', 'prompt']),
  id: z.number().int().positive(),
});

const server = new McpServer(
  { name: 'central-memory-admin', version: '0.1.0' },
  {
    instructions: [
      'This MCP adds only destructive administration for an existing claude-mem integration.',
      'Use the official claude-mem search/recent/timeline tools first and delete only exact numeric IDs the user intends to remove.',
      'Never guess IDs and never translate a fuzzy request into bulk deletion without first enumerating exact records.',
    ].join(' '),
  },
);

server.registerTool(
  'claude_mem_forget',
  {
    title: 'Central Memory Forget',
    description:
      'Delete exact claude-mem observation, summary, or prompt IDs through the Worker official DELETE routes. First identify exact IDs with the existing claude-mem tools; never guess IDs or perform fuzzy deletion.',
    inputSchema: {
      items: z.array(itemSchema).min(1).max(50),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ items }) => {
    const unique = [];
    const seen = new Set();
    for (const item of items) {
      const key = `${item.type}:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(item);
    }

    const deleted = [];
    const failed = [];
    for (const item of unique) {
      try {
        const result = await deleteRecord(item.type, item.id);
        deleted.push({ type: item.type, id: item.id, result });
      } catch (error) {
        failed.push({
          type: item.type,
          id: item.id,
          error: String(error?.message || error),
        });
      }
    }

    const result = {
      ok: failed.length === 0,
      deleted: deleted.map(({ type, id }) => ({ type, id })),
      failed,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  },
);

await server.connect(new StdioServerTransport());
