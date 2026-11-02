#!/usr/bin/env python3
"""Exercise the production identity patch on a disposable official npm package."""
import hashlib
from pathlib import Path
from runpy import run_path
import sys

if len(sys.argv) != 2:
    raise SystemExit('Usage: verify-staged-worker-overlay.py <npm-unpacked-root>')
functions = run_path(str(Path(__file__).with_name('reapply-claude-mem-platform-ui.py')))
root = Path(sys.argv[1]) / 'plugin'
files = [
    (root / 'ui' / 'viewer-bundle.js', functions['patch_bundle']),
    (root / 'ui' / 'viewer.html', functions['patch_html']),
    (root / 'scripts' / 'worker-service.cjs', functions['patch_worker']),
]
for file, patch in files:
    if not file.is_file():
        raise SystemExit(f'Upstream release is missing {file}')
    patch(file)
checksums = {str(file): hashlib.sha256(file.read_bytes()).hexdigest() for file, _ in files}
for file, patch in files:
    patch(file)
    if hashlib.sha256(file.read_bytes()).hexdigest() != checksums[str(file)]:
        raise SystemExit(f'Non-idempotent source patch: {file}')
print('Worker identity, viewer bundle and HTML overlays compatible and idempotent')
