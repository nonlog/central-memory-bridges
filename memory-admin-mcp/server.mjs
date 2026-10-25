import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createDeleteCoordinator } from '../shared/confirmed-delete.mjs';

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

async function requestRecord(workerUrl, type, id, method = 'GET', signal) {
  const routeType = method === 'GET' && type === 'summary' ? 'session' : type;
  const headers = { accept: 'application/json' };
  if (WORKER_TOKEN) headers.authorization = `Bearer ${WORKER_TOKEN}`;

  const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(`${workerUrl}/api/${routeType}/${id}`, {
    method, headers, signal: requestSignal,
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

const coordinator = createDeleteCoordinator({
  readRecord: (url, type, id, signal) => requestRecord(url, type, id, 'GET', signal),
  deleteRecord: (url, type, id, signal) => requestRecord(url, type, id, 'DELETE', signal),
});

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
  'claude_mem_preview_delete',
  {
    title: 'Preview Central Memory Deletion',
    description: 'Read exact existing records and generate a short-lived, one-use deletion receipt. Never deletes anything; show the listed IDs to the user and obtain explicit approval.',
    inputSchema: { items: z.array(itemSchema).min(1).max(50) },
    annotations: { readOnlyHint:true, destructiveHint:false, idempotentHint:false, openWorldHint:false },
  },
  async ({items}) => {
    const result = await coordinator.preview({items,workerUrl:resolveWorkerUrl()});
    return {content:[{type:'text',text:JSON.stringify(result,null,2)}],structuredContent:result};
  },
);

server.registerTool(
  'claude_mem_forget',
  {
    title: 'Central Memory Forget',
    description:
      'Delete previously previewed exact record IDs only. Require a matching unexpired one-use previewToken, confirmationText, confirm=true, and explicit user approval before invoking this destructive operation.',
    inputSchema: {
      items: z.array(itemSchema).min(1).max(50),
      previewToken: z.string().min(32).max(128),
      confirmationText: z.string(),
      confirm: z.literal(true),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({items, previewToken, confirmationText, confirm}) => {
    const result = await coordinator.forget({items,previewToken,confirmationText,confirm,workerUrl:resolveWorkerUrl()});
    return {content:[{type:'text',text:JSON.stringify(result,null,2)}],structuredContent:result};
  },
);

await server.connect(new StdioServerTransport());
