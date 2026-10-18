import importlib.util
import pathlib
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("worker_identity_patch", ROOT / "deploy/reapply-claude-mem-platform-ui.py")
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)

ORIGINAL_WORKER = (
    'function normalizePlatformSource(e){let t=(e||"").toLowerCase();'
    'return t?t.includes("claude")?"claude":t:"claude"}'
    'function next(){}'
    'class P{static rawPlatformSourceFromRequest(e){return e.headers?.["x-platform-source"]}'
    'static firstString(e){return typeof e==="string"?e:null}'
    'getPlatformSourceFromRequest(e){return normalizePlatformSource(P.rawPlatformSourceFromRequest(e))}}'
)


class WorkerIdentityTests(unittest.TestCase):
    def test_patch_preserves_web_platforms_and_idempotence(self):
        with tempfile.TemporaryDirectory() as tmp:
            worker = pathlib.Path(tmp) / "worker-service.cjs"
            worker.write_text(ORIGINAL_WORKER)
            identity.patch_worker(worker)
            once = worker.read_text()
            identity.patch_worker(worker)
            self.assertEqual(worker.read_text(), once)
            self.assertIn('i==="muse-web"', once)
            self.assertIn('i==="executor"', once)
            self.assertIn('t==="claude-web"||t==="grok-web"', once)
            identity.verify_worker_patch(worker)

    def test_unknown_upstream_contract_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            worker = pathlib.Path(tmp) / "worker-service.cjs"
            worker.write_text("function newPlatformResolver(x) {return x}")
            before = worker.read_text()
            with self.assertRaises(RuntimeError):
                identity.patch_worker(worker)
            self.assertEqual(worker.read_text(), before)


if __name__ == "__main__":
    unittest.main()
