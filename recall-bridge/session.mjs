import { createHash } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const digest = text => createHash('sha256').update(text).digest('hex');
const MAX_AGE_MS = 30 * 60 * 1000;

export function memoryFingerprint(item) {
  return digest(String(item.text).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''));
}

export function readRecallSession({ sessionId, cwd, harness, transcriptPath }) {
  if (!sessionId) return null;
  const directory = join(tmpdir(), 'central-memory-recall');
  const file = join(directory, digest(JSON.stringify([harness, cwd, sessionId])) + '.json');
  let state = { seen: [], boundary: '' };
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (Date.now() - saved.updatedAt < MAX_AGE_MS && Array.isArray(saved.seen)) state = saved;
  } catch { /* An unavailable cache must not disable recall. */ }
  if (transcriptPath) {
    try {
      const fd = openSync(transcriptPath, 'r');
      let tail;
      try {
        const size = fstatSync(fd).size;
        tail = Buffer.alloc(Math.min(size, 1024 * 1024));
        readSync(fd, tail, 0, tail.length, size - tail.length);
      } finally { closeSync(fd); }
      const lines = tail.toString('utf8').trim().split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i--) {
        let row;
        try { row = JSON.parse(lines[i]); } catch { continue; }
        if (row.type === 'compacted' || row.type === 'summary'
          || row.type === 'system' && row.subtype === 'compact_boundary') {
          const boundary = digest(lines[i]);
          if (boundary !== state.boundary) state = { seen: [], boundary };
          break;
        }
      }
    } catch { /* Expiration still bounds suppression when a transcript is unavailable. */ }
  }
  return { ...state, file, directory };
}

export function saveRecallSession(state, items) {
  const temporary = state.file + '.' + process.pid + '.tmp';
  try {
    mkdirSync(state.directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, JSON.stringify({
      seen: [...new Set([...state.seen, ...items.map(memoryFingerprint)])].slice(-256),
      boundary: state.boundary,
      updatedAt: Date.now(),
    }), { mode: 0o600 });
    renameSync(temporary, state.file);
  } catch {
    try { rmSync(temporary, { force: true }); } catch {}
  }
}
