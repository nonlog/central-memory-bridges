import assert from 'node:assert/strict';
import test from 'node:test';
import { extractLastAssistantMessage } from './transcript.mjs';

function line(message, extra = {}) {
  return JSON.stringify({ type: 'message', timestamp: '2026-11-01T00:00:00.000Z', message, ...extra });
}

test('reads the latest visible assistant text from a Droid JSONL transcript', () => {
  const transcript = [
    line({ role: 'user', content: [{ type: 'text', text: 'Fix the bug' }] }),
    line({ role: 'assistant', content: [{ type: 'text', text: 'I found the cause.' }] }),
    line({ role: 'assistant', content: [{ type: 'tool_use', name: 'Execute', input: { command: 'npm test' } }] }),
    line({ role: 'assistant', content: [{ type: 'text', text: 'The fix is complete.' }] }),
  ].join('\n');
  assert.equal(extractLastAssistantMessage(transcript), 'The fix is complete.');
});

test('does not retain hidden messages or tool-only assistant entries', () => {
  const transcript = [
    line({ role: 'assistant', content: [{ type: 'text', text: 'Visible answer' }] }),
    line({ role: 'assistant', visibility: 'llm_only', content: [{ type: 'text', text: 'Private reasoning' }] }),
    line({ role: 'assistant', visibility: 'user_only', content: [{ type: 'text', text: 'UI-only content' }] }),
    line({ role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'secret.txt' } }] }),
  ].join('\n');
  assert.equal(extractLastAssistantMessage(transcript), 'Visible answer');
});

test('strips injected memory blocks before retaining the final answer', () => {
  const transcript = line({
    role: 'assistant',
    content: [{ type: 'text', text: '<hindsight_memory>old context</hindsight_memory>Actual response' }],
  });
  assert.equal(extractLastAssistantMessage(transcript), 'Actual response');
});

test('skips malformed and empty transcripts safely', () => {
  assert.equal(extractLastAssistantMessage('not-json\n{}\n'), '');
  assert.equal(extractLastAssistantMessage(''), '');
});
