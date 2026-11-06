'use strict';
// Windows-only PATH correction for the upstream SessionStart ensure-launcher.
// It is intentionally external to the installed claude-mem plugin and survives
// npm/Scoop updates. Other hook commands use the official exe directly.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const exe = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'claude-mem', 'bin', 'claude-mem.exe');
const upstream = process.argv[2];
if (!fs.existsSync(exe)) {
  console.error('claude-mem: official native hook launcher is missing: ' + exe);
  process.exit(1);
}
if (!upstream || path.basename(upstream).toLowerCase() !== 'ensure-launcher.cjs' || !fs.existsSync(upstream)) {
  console.error('claude-mem: expected upstream ensure-launcher.cjs argument');
  process.exit(1);
}
const launcherDir = path.dirname(exe);
const normalized = value => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
const current = (process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
process.env.PATH = [launcherDir, ...current.filter(value => normalized(value) !== normalized(launcherDir))].join(path.delimiter);
require(path.resolve(upstream));