import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function recordRecallDiagnostic(data) {
  try {
    const filename = join(homedir(), '.central-memory-bridges', 'recall-bridge.jsonl');
    mkdirSync(dirname(filename), { recursive: true });
    // Keep only a non-sensitive allowlist, not query text, paths or memory contents.
    const record = {
      time: new Date().toISOString(),
      harness: String(data.harness || '').slice(0, 24),
      mode: String(data.mode || '').slice(0, 20),
      banks: Array.isArray(data.banks) ? data.banks.length : 0,
      perSource: {
        claudeMem: Number(data.perSource?.['claude-mem']) || 0,
        hindsight: Object.entries(data.perSource || {})
          .filter(([k]) => k !== 'claude-mem')
          .reduce((sum, [,count]) => sum + (Number(count) || 0), 0),
      },
      failures: Array.isArray(data.failures) ? data.failures.length : 0,
      candidates: Number(data.candidates) || 0,
      selected: Number(data.selected) || 0,
      elapsedMs: Number(data.elapsedMs) || 0,
    };
    appendFileSync(filename, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
  } catch { /* no log error may interrupt an agent */ }
}
