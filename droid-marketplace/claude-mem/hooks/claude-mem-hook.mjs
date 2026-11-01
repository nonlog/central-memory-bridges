import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readLastAssistantMessage } from './transcript.mjs';

const mode = process.argv[2];
const allowedModes = new Set(['start', 'context', 'session-init', 'observation', 'summarize']);
const MAX_INPUT_BYTES = 8 * 1024 * 1024;

function failOpen(message) {
  process.stderr.write(`claude-mem Droid hook: ${message}; continuing without memory hook\n`);
  process.exit(0);
}

function cliPath() {
  if (process.env.CLAUDE_MEM_CLI) return process.env.CLAUDE_MEM_CLI;
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  return join(localAppData, 'claude-mem', 'bin', 'claude-mem.exe');
}

function readEvent() {
  const raw = readFileSync(0, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_INPUT_BYTES) throw new Error('hook input exceeded 8 MiB');
  const event = JSON.parse(raw);
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('hook input must be a JSON object');
  return event;
}

function prepareEvent(event) {
  if (mode !== 'summarize') return event;
  if (event.hook_event_name === 'Notification' && event.notification_type !== 'idle_prompt') return null;
  const lastAssistantMessage = typeof event.last_assistant_message === 'string' && event.last_assistant_message.trim()
    ? event.last_assistant_message.trim()
    : readLastAssistantMessage(event.transcript_path);
  if (!lastAssistantMessage) return null;
  return { ...event, last_assistant_message: lastAssistantMessage };
}

function main() {
  if (!allowedModes.has(mode)) failOpen(`unsupported mode ${JSON.stringify(mode || '')}`);
  const executable = cliPath();
  if (!existsSync(executable)) failOpen(`official CLI not found at ${executable}`);

  let input;
  if (mode !== 'start') {
    let event;
    try {
      event = prepareEvent(readEvent());
    } catch (error) {
      failOpen(error instanceof Error ? error.message : String(error));
    }
    if (!event) process.exit(0);
    input = JSON.stringify(event);
  }

  const args = mode === 'start' ? ['start'] : ['hook', 'droid', mode];
  const timeout = mode === 'start' || mode === 'context' ? 55000 : (mode === 'summarize' ? 85000 : 25000);
  const result = spawnSync(executable, args, {
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) failOpen(result.error.message);
  // A memory integration must never block the user's prompt or tool execution.
  if (result.status !== 0) process.exit(1);
}

main();
