#!/usr/bin/env python3
from pathlib import Path
import glob
import re
import sys

SOURCES = ["claude", "codex", "chatgpt", "gemini", "claude-web", "grok-web", "muse-web", "executor", "pi", "omp", "hermes", "openclaw"]
LABELS = {
    "claude": "✳ Claude",
    "codex": "⌘ Codex",
    "chatgpt": "◎ ChatGPT",
    "gemini": "✦ Gemini",
    "claude-web": "✳ Claude Web",
    "grok-web": "◈ Grok Web",
    "muse-web": "◈ Muse Web",
    "executor": "⌘ Executor",
    "pi": "π Pi",
    "omp": "π OMP",
    "hermes": "☤ Hermes",
    "openclaw": "⌁ OpenClaw",
    "cursor": "◫ Cursor",
}

# Minified function names can change between upstream releases, so match the
# semantics of the two source-registry functions rather than fixed identifiers.
# Match the legacy array selector and the new project-filtered selector in 13.37+.
BASE_REGISTRY_RE = re.compile(
    r'function (?P<select>[A-Za-z_$][\w$]*)\((?P<select_arg>[A-Za-z_$][\w$]*)\)\{'
    r'(?P<prelude>let (?P<active>[A-Za-z_$][\w$]*)=(?P=select_arg)\.sources\.filter\([^;]+\);)?'
    r'return (?P<chosen>[A-Za-z_$][\w$]*)\.includes\("claude"\)\?"claude":(?P=chosen)\.includes\("codex"\)\?"codex":(?P=chosen)\[0\]\|\|null\}'
    r'function (?P<registry>[A-Za-z_$][\w$]*)\((?P<registry_arg>[A-Za-z_$][\w$]*)\)\{let (?P<items>[A-Za-z_$][\w$]*)=\["claude","codex",\.\.\.(?P=registry_arg)\];return Array\.from\(new Set\((?P=items)\)\)\}'
)

OLD_PS_LABEL = 'function PS(e){return{claude:"✳ Claude",codex:"⌘ Codex",chatgpt:"◎ ChatGPT",pi:"π Pi",omp:"π OMP",hermes:"☤ Hermes",openclaw:"⌁ OpenClaw",cursor:"◫ Cursor"}[e]||e}'
OLD_PS_LABEL_NO_OMP = 'function PS(e){return{claude:"✳ Claude",codex:"⌘ Codex",chatgpt:"◎ ChatGPT",pi:"π Pi",hermes:"☤ Hermes",openclaw:"⌁ OpenClaw",cursor:"◫ Cursor"}[e]||e}'
LABEL_FN = "AgentDockSourceLabel"
LABEL_FUNC = 'function AgentDockSourceLabel(e){return{claude:"✳ Claude",codex:"⌘ Codex",chatgpt:"◎ ChatGPT",gemini:"✦ Gemini","claude-web":"✳ Claude Web","grok-web":"◈ Grok Web","muse-web":"◈ Muse Web",executor:"⌘ Executor",pi:"π Pi",omp:"π OMP",hermes:"☤ Hermes",openclaw:"⌁ OpenClaw",cursor:"◫ Cursor"}[e]||e}'
OLD_GENERATED_LABEL_FUNC = 'function AgentDockSourceLabel(e){return{claude:"✳ Claude",codex:"⌘ Codex",chatgpt:"◎ ChatGPT",gemini:"✦ Gemini","claude-web":"✳ Claude Web","grok-web":"◈ Grok Web",pi:"π Pi",omp:"π OMP",hermes:"☤ Hermes",openclaw:"⌁ OpenClaw",cursor:"◫ Cursor"}[e]||e}'

OLD_OPT = 'p.map(m=>S.default.createElement("option",{key:m,value:m},m))'
SOURCE_OPT_RE = re.compile(
    r'(?P<prefix>"Source:",(?P<react>[A-Za-z_$][\w$]*)\.default\.createElement\("select",\{[^{}]*\},'
    r'(?:(?P=react)\.default\.createElement\("option",\{value:""\},"All sources"\),)?)'
    r'(?P<items>[A-Za-z_$][\w$]*)\.map\((?P<item>[A-Za-z_$][\w$]*)=>(?P=react)\.default\.createElement\("option",\{key:(?P=item),value:(?P=item)\},(?P=item)\)\)\)'
)
BADGE_RE = re.compile(r'className:`card-source source-\$\{(?P<v>[A-Za-z_$][\w$]*)\.platform_source\|\|"claude"\}`},(?P=v)\.platform_source\|\|"claude"\)')
MARKER = '/* AgentDock platform identities BEGIN */'
CSS = '''    /* AgentDock platform identities BEGIN */
    .source-claude,
    .source-codex,
    .source-chatgpt,
    .source-gemini,
    .source-claude-web,
    .source-grok-web,
    .source-muse-web,
    .source-executor,
    .source-pi,
    .source-omp,
    .source-hermes,
    .source-openclaw {
      text-transform: none;
    }

    .source-chatgpt { background: rgba(16, 163, 127, 0.12); color: #08785d; border-color: rgba(16, 163, 127, 0.26); }
    .source-gemini { background: rgba(66, 133, 244, 0.12); color: #2563eb; border-color: rgba(66, 133, 244, 0.26); }
    .source-claude-web { background: rgba(217, 119, 87, 0.12); color: #aa573c; border-color: rgba(217, 119, 87, 0.28); }
    .source-grok-web { background: rgba(100, 116, 139, 0.12); color: #475569; border-color: rgba(100, 116, 139, 0.28); }
    .source-muse-web { background: rgba(100, 116, 139, 0.10); color: #475569; border-color: rgba(100, 116, 139, 0.24); }
    .source-executor { background: rgba(14, 116, 144, 0.10); color: #0e7490; border-color: rgba(14, 116, 144, 0.24); }
    .source-pi { background: rgba(124, 58, 237, 0.12); color: #6d28d9; border-color: rgba(124, 58, 237, 0.26); }
    .source-omp { background: rgba(99, 102, 241, 0.12); color: #4f46e5; border-color: rgba(99, 102, 241, 0.26); }
    .source-hermes { background: rgba(202, 138, 4, 0.12); color: #9a6700; border-color: rgba(202, 138, 4, 0.28); }
    .source-openclaw { background: rgba(239, 68, 68, 0.12); color: #b42318; border-color: rgba(239, 68, 68, 0.26); }
    [data-theme="dark"] .source-chatgpt { color: #6ee7b7; border-color: rgba(110, 231, 183, 0.24); }
    [data-theme="dark"] .source-gemini { color: #93c5fd; border-color: rgba(147, 197, 253, 0.24); }
    [data-theme="dark"] .source-claude-web { color: #f1b39f; border-color: rgba(241, 179, 159, 0.27); }
    [data-theme="dark"] .source-grok-web { color: #cbd5e1; border-color: rgba(203, 213, 225, 0.27); }
    [data-theme="dark"] .source-muse-web { color: #cbd5e1; border-color: rgba(203, 213, 225, 0.24); }
    [data-theme="dark"] .source-executor { color: #67e8f9; border-color: rgba(103, 232, 249, 0.24); }
    [data-theme="dark"] .source-pi { color: #c4b5fd; border-color: rgba(196, 181, 253, 0.24); }
    [data-theme="dark"] .source-omp { color: #a5b4fc; border-color: rgba(165, 180, 252, 0.24); }
    [data-theme="dark"] .source-hermes { color: #fcd34d; border-color: rgba(252, 211, 77, 0.24); }
    [data-theme="dark"] .source-openclaw { color: #fca5a5; border-color: rgba(252, 165, 165, 0.24); }
    /* AgentDock platform identities END */

'''


def custom_registry(select_name: str, registry_name: str, arg: str, active: str, prelude: str) -> str:
    # Preserve upstream's projectsBySource filtering, rather than selecting a
    # source that has no project. Only expand priority among eligible sources.
    source_json = ','.join(f'"{x}"' for x in SOURCES)
    return (
        f'function {select_name}({arg}){{{prelude}for(let _adSource of [{source_json}])'
        f'if({active}.includes(_adSource))return _adSource;return {active}[0]||null}}'
        f'function {registry_name}(e){{let t=[{source_json},...e];return Array.from(new Set(t))}}'
        f'{LABEL_FUNC}'
    )


def patch_bundle(p: Path):
    s = p.read_text(encoding='utf-8')
    changed = False

    # Normalize our older exact-name label helper if present.
    if OLD_PS_LABEL in s:
        s = s.replace(OLD_PS_LABEL, LABEL_FUNC, 1).replace('PS(m)', f'{LABEL_FN}(m)').replace('PS(e.platform_source||"claude")', f'{LABEL_FN}(e.platform_source||"claude")')
        changed = True
    elif OLD_PS_LABEL_NO_OMP in s:
        s = s.replace(OLD_PS_LABEL_NO_OMP, LABEL_FUNC, 1).replace('PS(m)', f'{LABEL_FN}(m)').replace('PS(e.platform_source||"claude")', f'{LABEL_FN}(e.platform_source||"claude")')
        changed = True

    # Update bundles already patched by our older source registry overlay.
    if OLD_GENERATED_LABEL_FUNC in s:
        s = s.replace(OLD_GENERATED_LABEL_FUNC, LABEL_FUNC, 1)
        changed = True
    old_sources = '["claude","codex","chatgpt","gemini","claude-web","grok-web","pi","omp","hermes","openclaw"]'
    new_sources = '["claude","codex","chatgpt","gemini","claude-web","grok-web","muse-web","executor","pi","omp","hermes","openclaw"]'
    if old_sources in s:
        s = s.replace(old_sources, new_sources)
        changed = True

    if LABEL_FUNC not in s:
        m = BASE_REGISTRY_RE.search(s)
        if not m:
            raise RuntimeError(f'viewer registry pattern changed: {p}')
        active = m.group('active') or m.group('select_arg')
        if m.group('chosen') != active:
            raise RuntimeError(f'viewer source selector variables changed: {p}')
        s = s[:m.start()] + custom_registry(m.group('select'), m.group('registry'), m.group('select_arg'), active, m.group('prelude') or '') + s[m.end():]
        changed = True

    if OLD_OPT in s:
        s = s.replace(OLD_OPT, f'p.map(m=>S.default.createElement("option",{{key:m,value:m}},{LABEL_FN}(m)))', 1)
        changed = True
    else:
        def source_opt_repl(m: re.Match) -> str:
            react = m.group('react')
            items = m.group('items')
            item = m.group('item')
            return (
                f'{m.group("prefix")}{items}.map({item}=>{react}.default.createElement('
                f'"option",{{key:{item},value:{item}}},{LABEL_FN}({item}))))'
            )

        s2, n = SOURCE_OPT_RE.subn(source_opt_repl, s, count=1)
        if n:
            s = s2
            changed = True

    def badge_repl(m: re.Match) -> str:
        v = m.group('v')
        return f'className:`card-source source-${{{v}.platform_source||"claude"}}`}},AgentDockSourceLabel({v}.platform_source||"claude"))'

    s2, n = BADGE_RE.subn(badge_repl, s)
    if n:
        s = s2
        changed = True

    if changed:
        p.write_text(s, encoding='utf-8')
        print('patched bundle', p)
    else:
        print('bundle already patched', p)


def patch_html(p: Path):
    s = p.read_text(encoding='utf-8')
    if MARKER in s:
        # Replace stale overlay blocks, including pre-Gemini versions.
        block = s[s.index(MARKER):s.index('/* AgentDock platform identities END */', s.index(MARKER))]
        if '.source-muse-web' not in block or '.source-executor' not in block:
            begin = s.index(MARKER)
            end_marker = '/* AgentDock platform identities END */'
            end = s.index(end_marker, begin) + len(end_marker)
            replacement = CSS.rstrip('\n')
            s = s[:begin] + replacement + s[end:]
            p.write_text(s, encoding='utf-8')
            print('updated html overlay', p)
        else:
            print('html already patched', p)
        return
    anchor = '    .card-title {'
    if anchor not in s:
        raise RuntimeError(f'viewer CSS anchor changed: {p}')
    p.write_text(s.replace(anchor, CSS + anchor, 1), encoding='utf-8')
    print('patched html', p)


# AgentDock platform source fallback BEGIN
# Preserve explicit x-platform-source/platformSource values. Only infer a source
# from the project/content-session prefix when the caller did not provide one.
WORKER_CUSTOM_RE = re.compile(
    r'getPlatformSourceFromRequest\((?P<arg>[A-Za-z_$][\w$]*)\)\{let (?P<raw>[A-Za-z_$][\w$]*)=(?P<cls>[A-Za-z_$][\w$]*)\.rawPlatformSourceFromRequest\((?P=arg)\);if\((?P=raw)\)return (?P<norm>[A-Za-z_$][\w$]*)\((?P=raw)\);.*?return (?P=norm)\((?P=raw)\)\}'
)
WORKER_BASE_RE = re.compile(
    r'getPlatformSourceFromRequest\((?P<arg>[A-Za-z_$][\w$]*)\)\{return (?P<norm>[A-Za-z_$][\w$]*)\((?P<cls>[A-Za-z_$][\w$]*)\.rawPlatformSourceFromRequest\((?P=arg)\)\)\}'
)


def worker_custom(arg: str, norm: str, cls: str) -> str:
    return (
        f'getPlatformSourceFromRequest({arg}){{let r={cls}.rawPlatformSourceFromRequest({arg});if(r)return {norm}(r);'
        f'let n={arg}.body&&typeof {arg}.body=="object"?{arg}.body:{{}},s={cls}.firstString(n.project)??{cls}.firstString(n.contentSessionId);'
        'if(s){let i=s.trim().toLowerCase();'
        'if(i==="chatgpt"||i==="chatgpt-web"||i.startsWith("chatgpt-"))return"chatgpt";'
        'if(i==="gemini"||i==="gemini-web"||i.startsWith("gemini-"))return"gemini";'
        'if(i==="claude-web"||i.startsWith("claude-web-"))return"claude-web";'
        'if(i==="grok-web"||i.startsWith("grok-web-"))return"grok-web";'
        'if(i==="muse-web"||i.startsWith("muse-web-"))return"muse-web";'
        'if(i==="executor"||i.startsWith("executor-"))return"executor";'
        'if(i==="pi"||i.startsWith("pi-"))return"pi";'
        'if(i==="omp"||i==="oh-my-pi"||i.startsWith("omp-"))return"omp";'
        'if(i==="hermes"||i.startsWith("hermes-"))return"hermes";'
        'if(i==="openclaw"||i.startsWith("openclaw-"))return"openclaw"}'
        f'return {norm}(r)}}'
    )


def preserve_web_platform_names(source: str, norm: str) -> str:
    # Official normalizePlatformSource() maps any value containing "claude"
    # to "claude". Preserve the explicit Web app identity before that branch.
    marker = 'function ' + norm + '('
    pos = source.find(marker)
    if pos == -1:
        raise RuntimeError('Worker normalization function not found: ' + norm)
    end = source.find('}function ', pos)
    if end == -1 or end > pos + 700:
        raise RuntimeError('Worker source normalization function changed shape')
    segment = source[pos:end]
    if '"claude-web"' in segment and '"grok-web"' in segment:
        return source
    match = re.search(r'let (?P<value>[A-Za-z_$][\\w$]*)=[^;]+;return (?P=value)\\?', segment)
    if not match:
        raise RuntimeError('Worker normalizePlatformSource expression changed')
    value = match.group('value')
    before = 'return ' + value + '?'
    after = 'return ' + value + '==="claude-web"||' + value + '==="grok-web"?' + value + ':' + value + '?'
    segment = segment.replace(before, after, 1)
    return source[:pos] + segment + source[end:]


def patch_worker(path: Path):
    before = path.read_text(encoding='utf-8')
    s = before
    m = WORKER_CUSTOM_RE.search(s)
    if m:
        norm = m.group('norm')
        if 'i==="muse-web"' not in m.group(0) or 'i==="executor"' not in m.group(0):
            replacement = worker_custom(m.group('arg'), norm, m.group('cls'))
            s = s[:m.start()] + replacement + s[m.end():]
    else:
        m = WORKER_BASE_RE.search(s)
        if not m:
            raise RuntimeError(f'worker platform-source pattern changed: {path}')
        norm = m.group('norm')
        replacement = worker_custom(m.group('arg'), norm, m.group('cls'))
        s = s[:m.start()] + replacement + s[m.end():]
    s = preserve_web_platform_names(s, norm)
    if s != before:
        path.write_text(s, encoding='utf-8')
        print('patched worker', path)
    else:
        print('worker already patched', path)
    verify_worker_patch(path)


def verify_worker_patch(path: Path):
    """Fail the official updater if identity capture silently regresses."""
    source = path.read_text(encoding='utf-8')
    match = WORKER_CUSTOM_RE.search(source)
    if not match:
        raise RuntimeError(f'worker platform-source fallback missing: {path}')
    custom = match.group(0)
    if any(marker not in custom for marker in (
        'i==="claude-web"', 'i==="grok-web"',
        'i==="muse-web"', 'i==="executor"',
    )):
        raise RuntimeError(f'worker platform-source identity missing: {path}')
    norm = match.group('norm')
    norm_marker = f'function {norm}('
    begin = source.find(norm_marker)
    end = source.find('}function ', begin)
    if begin < 0 or end < 0 or end > begin + 700:
        raise RuntimeError(f'worker platform-source normalization changed: {path}')
    segment = source[begin:end]
    if '==="claude-web"' not in segment or '==="grok-web"' not in segment:
        raise RuntimeError(f'worker web source name preservation missing: {path}')


# AgentDock platform source fallback END


def run_patch(label: str, paths, func):
    errors = []
    for p in paths:
        if not p.exists():
            continue
        try:
            func(p)
        except Exception as exc:
            errors.append((p, exc))
            print(f'WARNING: {label} patch failed for {p}: {exc}', file=sys.stderr)
    return errors


def main() -> int:
    bundles = [Path('/root/.claude/plugins/marketplaces/thedotmack/plugin/ui/viewer-bundle.js')]
    bundles += [Path(x) for x in glob.glob('/root/.claude/plugins/cache/thedotmack/claude-mem/*/ui/viewer-bundle.js')]
    htmls = [Path('/root/.claude/plugins/marketplaces/thedotmack/plugin/ui/viewer.html')]
    htmls += [Path(x) for x in glob.glob('/root/.claude/plugins/cache/thedotmack/claude-mem/*/ui/viewer.html')]
    workers = [Path('/root/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs')]
    workers += [Path(x) for x in glob.glob('/root/.claude/plugins/cache/thedotmack/claude-mem/*/scripts/worker-service.cjs')]

    if not workers[0].is_file():
        print(f'ERROR: official active worker is missing: {workers[0]}', file=sys.stderr)
        return 1

    errors = []
    errors += run_patch('viewer bundle', bundles, patch_bundle)
    errors += run_patch('viewer html', htmls, patch_html)
    errors += run_patch('worker source fallback', workers, patch_worker)
    return 1 if errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
