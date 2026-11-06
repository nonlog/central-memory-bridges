"""Run the real dispatcher with isolated services and concurrent client processes."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest


@unittest.skipUnless(os.name == 'posix' and shutil.which('flock'), 'Linux flock required')
class MultiClientDispatch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='central-dispatch-')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.worker = self.root / 'worker.json'
        self.worker.write_text(json.dumps({'version': '15.9.0'}))
        self.dispatches = self.root / 'dispatches'
        self.updates = self.root / 'updates'
        self.executable('npm', '#!/bin/sh\necho \'"sha512-fixture"\'\n')
        self.executable('gh', f'''#!/bin/sh
if [ "$1 $2" = "workflow run" ]; then echo run >> '{self.dispatches}';
elif [ "$1 $2" = "run list" ]; then echo 123;
elif [ "$1 $2" = "run watch" ]; then sleep 0.5; exit "${{FAIL_CI:-0}}"; fi
''')
        self.executable('curl', f'''#!/bin/sh
case "$*" in
  *api/health*) node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1]));console.log(JSON.stringify({{version:p.version,status:"ok",mcpReady:true}}))' '{self.worker}';;
  *) echo '{{"status":"ready"}}';;
esac
''')
        self.updater = self.executable('updater', f'''#!/bin/sh
echo update >> '{self.updates}'
printf '{{"version":"%s"}}' "$CLAUDE_MEM_TARGET_VERSION" > '{self.worker}'
''')
        source = Path(__file__).with_name('claude-mem-manual-upgrade.sh').read_text()
        source = source.replace('export PATH=/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/bin:/bin', 'export PATH="$TEST_PATH"')
        source = source.replace('/root/.claude/plugins/marketplaces/thedotmack/plugin/package.json', str(self.worker))
        source = source.replace('/usr/local/sbin/claude-mem-weekly-update', str(self.updater))
        source = source.replace('/run/claude-mem-manual-upgrade.lock', str(self.root / 'upgrade.lock'))
        self.script = self.root / 'dispatch.sh'
        self.script.write_text(source)
        self.env = {**os.environ, 'TEST_PATH': str(self.bin) + ':' + os.environ['PATH']}

    def executable(self, name, text):
        p = self.bin / name
        p.write_text(text)
        p.chmod(0o755)
        return p

    def start(self, version='15.10.0', **env):
        return subprocess.Popen(['bash', str(self.script), version], env={**self.env, **env}, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    def test_two_computers_share_one_upgrade(self):
        first = self.start()
        deadline = time.monotonic() + 10
        while not self.dispatches.exists() and time.monotonic() < deadline:
            time.sleep(.01)
        second = self.start()
        a = first.communicate(timeout=15)[0]
        b = second.communicate(timeout=15)[0]
        self.assertEqual(first.returncode, 0, a)
        self.assertEqual(second.returncode, 0, b)
        self.assertEqual(self.dispatches.read_text().splitlines(), ['run'])
        self.assertEqual(self.updates.read_text().splitlines(), ['update'])
        self.assertIn('waiting for its result', b)

    def test_stale_manifest_follows_newer_healthy_central_without_downgrade(self):
        self.worker.write_text('{"version":"15.10.0"}')
        process = self.start('15.9.0')
        output = process.communicate(timeout=10)[0]
        self.assertEqual(process.returncode, 0, output)
        self.assertIn('synchronize this computer to 15.10.0', output)
        self.assertFalse(self.dispatches.exists())
        self.assertFalse(self.updates.exists())

    def test_failed_ci_keeps_central_unchanged(self):
        process = self.start(FAIL_CI='1')
        output = process.communicate(timeout=10)[0]
        self.assertNotEqual(process.returncode, 0, output)
        self.assertEqual(json.loads(self.worker.read_text())['version'], '15.9.0')
        self.assertFalse(self.updates.exists())


if __name__ == '__main__':
    unittest.main()
