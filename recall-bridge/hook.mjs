#!/usr/bin/env node
/**
 * User-owned UserPromptSubmit hook for Codex / Claude Code.
 * Keeps upstream Claude-mem capture and Hindsight git/page hooks untouched.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { modeFor, readConfig, unifiedRecall } from './core.mjs';
import { recordRecallDiagnostic } from './telemetry.mjs';

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk.toString();
    if (text.length > 1024 * 1024) throw new Error('hook input too large');
  }
  return JSON.parse(text || '{}');
}

async function main() {
  const harness = process.argv[2] === 'claude-code' ? 'claude-code' : 'codex';
  const payload = await readStdin();
  const prompt = String(payload.prompt || payload.user_prompt || '');
  const cwd = String(payload.cwd || process.cwd());
  const config = readConfig();
  const mode = modeFor(config,harness);
  if (mode === 'off' || !prompt.trim()) return;
  const userConfigFile = join(homedir(), '.hindsight', 'coding-agent.json');
  let hindsightConfig;
  try { hindsightConfig = JSON.parse(readFileSync(userConfigFile, 'utf8')); } catch {}
  const result = await unifiedRecall({ prompt, cwd, harness }, { config, hindsightConfig });
  recordRecallDiagnostic(result.diagnostic);
  if (mode !== 'inject' || !result.context) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: result.context },
  }) + '\n');
}

main().catch(error => {
  recordRecallDiagnostic({ mode: 'error', harness: process.argv[2] || 'codex' });
  // Fail open: memory problems must not block coding.
});
