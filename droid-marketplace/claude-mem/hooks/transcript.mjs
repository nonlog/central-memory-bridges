import { readFileSync } from 'node:fs';

const INJECTED_MEMORY_TAGS = [
  'hook_prompt',
  'task-notification',
  'system-reminder',
  'hindsight_memory',
  'hindsight_memories',
  'hindsight_bank',
  'relevant_memories',
  'user_feedback',
  'hindsight_knowledge',
  'hindsight_knowledge_refresh',
];
const INJECTED_MEMORY_RE = new RegExp(
  `<(${INJECTED_MEMORY_TAGS.join('|')})\\b[\\s\\S]*?<\\/\\1>`,
  'g',
);

function cleanText(value) {
  return value.replace(INJECTED_MEMORY_RE, '').trim();
}

export function extractLastAssistantMessage(transcriptText) {
  const lines = String(transcriptText || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    const message = line?.type === 'message' ? line.message : undefined;
    if (!message || message.role !== 'assistant') continue;
    if (message.visibility === 'user_only' || message.visibility === 'llm_only') continue;
    const content = typeof message.content === 'string'
      ? [message.content]
      : Array.isArray(message.content)
        ? message.content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text)
        : [];
    const text = cleanText(content.join('\n'));
    if (text) return text.slice(0, 24000);
  }
  return '';
}

export function readLastAssistantMessage(transcriptPath) {
  if (!transcriptPath) return '';
  try {
    return extractLastAssistantMessage(readFileSync(transcriptPath, 'utf8'));
  } catch {
    return '';
  }
}
