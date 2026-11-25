import path from 'node:path';

const PRESERVE_PREFIXED_PROJECTS = new Set([
  'pi-coding-agent',
  'pi-bar-cursor',
  'pi-auto-session-title',
  'pi-cpa-persona-provider-fix500',
  'pi-default',
]);

const CANONICAL_ALIASES = new Map([
  ['general', 'General'],
  ['workspace', 'General'],
  ['projects', 'General'],
  ['projectless', 'General'],
  ['www', 'General'],
  ['pi', 'General'],
  ['omp', 'General'],
  ['omp2', 'General'],
  ['new-chat', 'General'],
  ['downloads', 'Downloads'],
  ['tmp', 'Temp'],
  ['temp', 'Temp'],
  ['conduit', 'Conduit'],
  ['codex', 'Codex'],
  ['agentdock', 'AgentDock'],
  ['agentdock-windows', 'AgentDock'],
  ['memory-management', 'Memory-management'],
  ['windows-management', 'Windows-Management'],
  ['windows', 'Windows-Management'],
  ['windows-log', 'Windows-log'],
  ['scoop-www', 'Scoop-www'],
  ['scoop', 'Scoop-www'],
  ['mcphub-migration', 'MCPHub-migration'],
  ['agent-config', 'agent-configs'],
  ['agent-configuration', 'agent-configs'],
  ['agent-global-config', 'agent-configs'],
  ['searchevo', 'SearchEVO'],
  ['commandcodeproxy', 'CommandCodeProxy'],
  ['oplusfluidcompat', 'OPlusFluidCompat'],
  ['recall', 'Recall'],
  ['pc-migration', 'PC-Migration'],
  ['pixel-aod-for-oplus', 'pixel-aod-xposed'],
  ['pixel-aod-coui-port', 'pixel-aod-xposed'],
  ['pixel-aod-codex', 'pixel-aod-xposed'],
  ['pixel-aod-m9-implementation', 'pixel-aod-xposed'],
]);

function extractFromPath(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';

  // Match git worktree layout: .../worktrees/<repo>/pi-worktree-<uuid>
  const wtMatch = s.match(/(?:^|[\\/])worktrees[\\/]([^\\/]+)[\\/]/i);
  if (wtMatch && wtMatch[1]) return wtMatch[1];

  // Match raw Windows or Unix path
  if (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith('/')) {
    const normalized = s.replace(/\\/g, '/').replace(/\/+$/, '');
    if (/^[A-Za-z]:\/Users\/[^/]+$/i.test(normalized)) return 'General';
    if (/^[A-Za-z]:\/Users\/[^/]+\/AppData\//i.test(normalized)) return 'General';
    if (/^[A-Za-z]:\/Workspace\/General\//i.test(normalized)) return 'General';
    const base = path.posix.basename(normalized);
    return base || 'General';
  }

  // Match flattened D-Workspace-<name> / D-Downloads
  const flatWs = s.match(/^[A-Za-z]-Workspace-(.+)$/i);
  if (flatWs && flatWs[1]) {
    if (/^General-/i.test(flatWs[1])) return 'General';
    return flatWs[1];
  }
  if (/^[A-Za-z]-Downloads$/i.test(s)) return 'Downloads';

  return s;
}

export function canonicalProjectName(value, fallback = 'General') {
  const fb = String(fallback || 'General').trim() || 'General';
  let s = extractFromPath(value);
  if (!s) return fb;

  // Strip sub-branch suffix like pixel-aod-xposed/pixel-aod-coui-port -> pixel-aod-xposed
  if (s.includes('/') && !s.startsWith('http')) {
    s = s.split('/')[0];
  }

  // Collapse repeated agent prefixes (pi-pi-..., pi-..., omp-...) unless explicitly preserved
  const lower0 = s.toLowerCase();
  if (!PRESERVE_PREFIXED_PROJECTS.has(lower0)) {
    if (/^(?:pi-)+pi-worktree-/i.test(s) || /^pi-worktree-/i.test(s)) {
      return fb;
    }
    if (/^(?:pi-|omp-)/i.test(s)) {
      const stripped = s.replace(/^(?:pi-|omp-)+/i, '');
      if (stripped) s = stripped;
    }
  }

  // Sanitize characters
  let cleaned = s
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);

  if (!cleaned) return fb;

  const lower = cleaned.toLowerCase();

  // Ephemeral thread / auto-title / hex-hash / URL-slug names fall back to General
  if (
    /^codex-auto-title-/i.test(lower) ||
    /^codex-threads-/i.test(lower) ||
    /^https?-/i.test(lower) ||
    /^[0-9a-f]{16,32}$/.test(lower)
  ) {
    return fb;
  }

  if (CANONICAL_ALIASES.has(lower)) {
    return CANONICAL_ALIASES.get(lower);
  }

  return cleaned;
}

export function projectNameForCwd(cwd, { gitProject = '', fallback = 'General' } = {}) {
  if (gitProject && String(gitProject).trim()) {
    return canonicalProjectName(gitProject, fallback);
  }
  const target = String(cwd || process.cwd() || '').trim();
  if (!target) return canonicalProjectName(fallback, 'General');
  return canonicalProjectName(target, fallback);
}
