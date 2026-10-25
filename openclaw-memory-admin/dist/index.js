import { Type } from 'typebox';
import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin';
import { createDeleteCoordinator } from './confirmed-delete.mjs';

const HTTP_TIMEOUT_MS = 12_000;

function resolveWorkerUrl(config) {
  const configured = String(config?.workerUrl || '').trim();
  if (configured) return configured.replace(/\/$/, '');

  const fromEnv = String(process.env.CLAUDE_MEM_WORKER_URL || '').trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');

  return 'http://127.0.0.1:37777';
}

async function requestRecord(workerUrl, type, id, signal, method = 'GET') {
  const routeType = method === 'GET' && type === 'summary' ? 'session' : type;
  const headers = { accept: 'application/json' };
  const token = String(process.env.CLAUDE_MEM_WORKER_TOKEN || '').trim();
  if (token) headers.authorization = `Bearer ${token}`;

  const timeoutSignal = AbortSignal.timeout(HTTP_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(`${workerUrl}/api/${routeType}/${id}`, {
    method,
    headers,
    signal: requestSignal,
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
  readRecord: (url,type,id,signal) => requestRecord(url,type,id,signal,'GET'),
  deleteRecord: (url,type,id,signal) => requestRecord(url,type,id,signal,'DELETE'),
});

const configSchema = Type.Object(
  {
    workerUrl: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          'claude-mem Worker base URL. Defaults to CLAUDE_MEM_WORKER_URL or http://127.0.0.1:37777.',
      }),
    ),
  },
  { additionalProperties: false },
);

const itemSchema = Type.Object(
  {
    type: Type.Union([
      Type.Literal('observation'),
      Type.Literal('summary'),
      Type.Literal('prompt'),
    ]),
    id: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export default defineToolPlugin({
  id: 'central-memory-admin',
  name: 'Central Memory Admin',
  description:
    'Adds exact-ID destructive administration for claude-mem without changing the official OpenClaw claude-mem plugin.',
  configSchema,
  tools: (tool) => [
    tool({
      name: 'claude_mem_preview_delete',
      label: 'Preview Central Memory Deletion',
      description: 'Read and preview exact record IDs without deletion. Show the result and obtain explicit user approval before using claude_mem_forget.',
      optional: true,
      parameters: Type.Object({items: Type.Array(itemSchema, {minItems:1,maxItems:50})}, {additionalProperties:false}),
      async execute({items}, config, context) {
        context.signal?.throwIfAborted();
        return coordinator.preview({items, workerUrl:resolveWorkerUrl(config), signal:context.signal});
      },
    }),
    tool({
      name: 'claude_mem_forget',
      label: 'Central Memory Forget',
      description:
        'Delete only after claude_mem_preview_delete and explicit user approval. Requires matching one-use previewToken, confirmationText and confirm=true; rejects unreviewed or changed IDs.',
      optional: true,
      parameters: Type.Object(
        {
          items: Type.Array(itemSchema, { minItems: 1, maxItems: 50 }),
          previewToken: Type.String({minLength:32,maxLength:128}),
          confirmationText: Type.String(),
          confirm: Type.Literal(true),
        },
        { additionalProperties: false },
      ),
      async execute({items,previewToken,confirmationText,confirm}, config, context) {
        context.signal?.throwIfAborted();
        return coordinator.forget({items,previewToken,confirmationText,confirm,workerUrl:resolveWorkerUrl(config),signal:context.signal});
      },
    }),
  ],
});
