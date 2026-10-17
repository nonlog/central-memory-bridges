import { Type } from 'typebox';
import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin';

const HTTP_TIMEOUT_MS = 12_000;

function resolveWorkerUrl(config) {
  const configured = String(config?.workerUrl || '').trim();
  if (configured) return configured.replace(/\/$/, '');

  const fromEnv = String(process.env.CLAUDE_MEM_WORKER_URL || '').trim();
  if (fromEnv) return fromEnv.replace(/\/$/, '');

  return 'http://127.0.0.1:37777';
}

async function deleteRecord(workerUrl, type, id, signal) {
  const headers = { accept: 'application/json' };
  const token = String(process.env.CLAUDE_MEM_WORKER_TOKEN || '').trim();
  if (token) headers.authorization = `Bearer ${token}`;

  const timeoutSignal = AbortSignal.timeout(HTTP_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(`${workerUrl}/api/${type}/${id}`, {
    method: 'DELETE',
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
      name: 'claude_mem_forget',
      label: 'Central Memory Forget',
      description:
        'Delete exact claude-mem observation, summary, or prompt IDs through the Worker official DELETE routes. First identify exact IDs with the existing claude-mem tools; never guess IDs or perform fuzzy deletion.',
      optional: true,
      parameters: Type.Object(
        {
          items: Type.Array(itemSchema, { minItems: 1, maxItems: 50 }),
        },
        { additionalProperties: false },
      ),
      async execute({ items }, config, context) {
        context.signal?.throwIfAborted();
        const workerUrl = resolveWorkerUrl(config);
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
          context.signal?.throwIfAborted();
          try {
            await deleteRecord(workerUrl, item.type, item.id, context.signal);
            deleted.push({ type: item.type, id: item.id });
          } catch (error) {
            failed.push({
              type: item.type,
              id: item.id,
              error: String(error?.message || error),
            });
          }
        }

        return {
          ok: failed.length === 0,
          deleted,
          failed,
        };
      },
    }),
  ],
});
