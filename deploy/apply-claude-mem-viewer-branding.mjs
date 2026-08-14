#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const START = '/* central-memory-bridges: platform-source-icons:start */';
const END = '/* central-memory-bridges: platform-source-icons:end */';

const CSS = `
    ${START}
    /*
     * Platform badges use current, project-controlled artwork where practical.
     * If a remote image is blocked or unavailable, the text label remains usable.
     */
    .card-source {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      text-transform: none;
      letter-spacing: 0.01em;
      line-height: 1.2;
      white-space: nowrap;
    }

    .card-source::before {
      content: '';
      width: 13px;
      height: 13px;
      flex: 0 0 13px;
      display: inline-block;
      background-repeat: no-repeat;
      background-position: center;
      background-size: contain;
    }

    /* Replace normalized source text with product capitalization. */
    .source-chatgpt,
    .source-chatgpt-web,
    .source-ChatGPT,
    .source-codex,
    .source-codex-cli,
    .source-Codex,
    .source-claude,
    .source-claude-code,
    .source-Claude,
    .source-pi,
    .source-Pi,
    .source-hermes,
    .source-hermes-agent,
    .source-Hermes,
    .source-openclaw,
    .source-OpenClaw {
      font-size: 0;
    }

    .source-chatgpt::after,
    .source-chatgpt-web::after,
    .source-ChatGPT::after {
      content: 'ChatGPT';
      font-size: 10px;
    }

    .source-codex::after,
    .source-codex-cli::after,
    .source-Codex::after {
      content: 'Codex';
      font-size: 10px;
    }

    .source-claude::after,
    .source-claude-code::after,
    .source-Claude::after {
      content: 'Claude';
      font-size: 10px;
    }

    .source-pi::after,
    .source-Pi::after {
      content: 'Pi';
      font-size: 10px;
    }

    .source-hermes::after,
    .source-hermes-agent::after,
    .source-Hermes::after {
      content: 'Hermes';
      font-size: 10px;
    }

    .source-openclaw::after,
    .source-OpenClaw::after {
      content: 'OpenClaw';
      font-size: 10px;
    }

    /* ChatGPT: official ChatGPT site icon. */
    .source-chatgpt::before,
    .source-chatgpt-web::before,
    .source-ChatGPT::before {
      background-image: url('https://chatgpt.com/favicon.ico');
    }

    /*
     * Codex: current OpenAI Codex product artwork from the official get-started page.
     * The source image includes surrounding campaign art, so background sizing crops
     * the published app icon without redrawing it.
     */
    .source-codex::before,
    .source-codex-cli::before,
    .source-Codex::before {
      border-radius: 3px;
      background-image: url('https://images.ctfassets.net/8su2tbn87fck/1AFmJlFiOIpmqlLkWyw9oR/4a5d06b26c38f883e1b8f25771b7876a/image.png');
      background-size: 39px 39px;
      background-position: -13px -4px;
    }

    /* Claude: official Claude web app icon. */
    .source-claude::before,
    .source-claude-code::before,
    .source-Claude::before {
      background-image: url('https://claude.ai/favicon.ico');
    }

    /* Pi: official project logo referenced by the Pi repository README. */
    .source-pi::before,
    .source-Pi::before {
      background-image: url('https://pi.dev/logo-auto.svg');
    }

    /* Hermes: official Hermes Agent favicon from Nous Research. */
    .source-hermes::before,
    .source-hermes-agent::before,
    .source-Hermes::before {
      background-image: url('https://raw.githubusercontent.com/NousResearch/hermes-agent/main/website/static/img/favicon.svg');
    }

    /* OpenClaw: official pixel-lobster artwork from the OpenClaw repository. */
    .source-openclaw::before,
    .source-OpenClaw::before {
      background-image: url('https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/pixel-lobster.svg');
    }

    .source-chatgpt,
    .source-chatgpt-web,
    .source-ChatGPT {
      background: rgba(16, 163, 127, 0.10);
      color: #087f65;
      border-color: rgba(16, 163, 127, 0.24);
    }

    .source-pi,
    .source-Pi {
      background: rgba(124, 58, 237, 0.10);
      color: #6d28d9;
      border-color: rgba(124, 58, 237, 0.22);
    }

    .source-hermes,
    .source-hermes-agent,
    .source-Hermes {
      background: rgba(202, 138, 4, 0.10);
      color: #9a6700;
      border-color: rgba(202, 138, 4, 0.24);
    }

    .source-openclaw,
    .source-OpenClaw {
      background: rgba(225, 73, 58, 0.10);
      color: #b9382a;
      border-color: rgba(225, 73, 58, 0.24);
    }

    [data-theme='dark'] .source-chatgpt,
    [data-theme='dark'] .source-chatgpt-web,
    [data-theme='dark'] .source-ChatGPT {
      color: #72ddbf;
      border-color: rgba(114, 221, 191, 0.22);
    }

    [data-theme='dark'] .source-pi,
    [data-theme='dark'] .source-Pi {
      color: #c4b5fd;
      border-color: rgba(196, 181, 253, 0.22);
    }

    [data-theme='dark'] .source-hermes,
    [data-theme='dark'] .source-hermes-agent,
    [data-theme='dark'] .source-Hermes {
      color: #f1c75b;
      border-color: rgba(241, 199, 91, 0.22);
    }

    [data-theme='dark'] .source-openclaw,
    [data-theme='dark'] .source-OpenClaw {
      color: #ff9b8f;
      border-color: rgba(255, 155, 143, 0.22);
    }
    ${END}
`;

function usage(exitCode = 0) {
  const out = exitCode === 0 ? console.log : console.error;
  out(`Usage:
  node deploy/apply-claude-mem-viewer-branding.mjs --root <claude-mem-root>
  node deploy/apply-claude-mem-viewer-branding.mjs --root <claude-mem-root> --check

Options:
  --root <path>  claude-mem checkout/plugin root. Can also use CLAUDE_MEM_ROOT.
  --check        Verify the current branding block is present; do not modify files.
  --help         Show this help.

The script patches both source and already-built viewer HTML when present:
  src/ui/viewer-template.html
  plugin/ui/viewer.html
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const args = { root: process.env.CLAUDE_MEM_ROOT || '', check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      args.root = argv[++i] || '';
    } else if (arg === '--check') {
      args.check = true;
    } else if (arg === '--help' || arg === '-h') {
      usage(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      usage(2);
    }
  }
  if (!args.root) {
    console.error('Missing --root <claude-mem-root> (or CLAUDE_MEM_ROOT).');
    usage(2);
  }
  return args;
}

function stripExistingBlock(text) {
  const start = text.indexOf(START);
  if (start === -1) return text;
  const end = text.indexOf(END, start);
  if (end === -1) {
    throw new Error(`Found ${START} without matching ${END}`);
  }
  const after = end + END.length;
  return text.slice(0, start) + text.slice(after);
}

function hasCurrentBlock(text) {
  const start = text.indexOf(START);
  if (start === -1) return false;
  const end = text.indexOf(END, start);
  if (end === -1) return false;
  const existing = text.slice(start, end + END.length).trim();
  return existing === CSS.trim();
}

function patchHtml(text) {
  if (hasCurrentBlock(text)) return text;
  const clean = stripExistingBlock(text);
  const preferredMarker = '    .card-title {';
  const fallbackMarker = '</style>';
  const marker = clean.includes(preferredMarker) ? preferredMarker : fallbackMarker;
  const index = clean.indexOf(marker);
  if (index === -1) {
    throw new Error('Could not find a stable CSS insertion point (.card-title or </style>).');
  }
  return clean.slice(0, index) + CSS + '\n' + clean.slice(index);
}

const { root, check } = parseArgs(process.argv.slice(2));
const rootPath = path.resolve(root);
const relativeFiles = [
  'src/ui/viewer-template.html',
  'plugin/ui/viewer.html',
];
const files = relativeFiles
  .map((relativePath) => ({ relativePath, filePath: path.join(rootPath, relativePath) }))
  .filter(({ filePath }) => fs.existsSync(filePath));

if (files.length === 0) {
  console.error(`No claude-mem viewer HTML found under: ${rootPath}`);
  console.error(`Expected one of: ${relativeFiles.join(', ')}`);
  process.exit(1);
}

if (check) {
  let ok = true;
  for (const { relativePath, filePath } of files) {
    const text = fs.readFileSync(filePath, 'utf8');
    const current = hasCurrentBlock(text);
    console.log(`${current ? 'OK' : 'OUTDATED_OR_MISSING'} ${relativePath}`);
    ok &&= current;
  }
  process.exit(ok ? 0 : 1);
}

for (const { relativePath, filePath } of files) {
  const before = fs.readFileSync(filePath, 'utf8');
  const after = patchHtml(before);
  if (after === before) {
    console.log(`UNCHANGED ${relativePath}`);
    continue;
  }
  fs.writeFileSync(filePath, after, 'utf8');
  console.log(`PATCHED ${relativePath}`);
}

console.log('Platform source icon branding applied. Refresh the claude-mem viewer; a worker restart is normally not required for static viewer HTML.');
