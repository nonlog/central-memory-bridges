"""Contract fixtures for claude-mem's minified Viewer source registry."""
import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("reapply-claude-mem-platform-ui.py")
spec = importlib.util.spec_from_file_location("platform_ui_patcher", SCRIPT)
patcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patcher)

OLD = (
    'function A(e){return e.includes("claude")?"claude":e.includes("codex")?"codex":e[0]||null}'
    'function B(e){let t=["claude","codex",...e];return Array.from(new Set(t))}'
)
NEW = (
    'function A(e){let t=e.sources.filter(n=>(e.projectsBySource[n]?.length??0)>0);'
    'return t.includes("claude")?"claude":t.includes("codex")?"codex":t[0]||null}'
    'function B(e){let t=["claude","codex",...e];return Array.from(new Set(t))}'
)
UI = (
    'function unused(){return E.default.createElement("label",{className:"preview-selector"},'
    '"Source:",E.default.createElement("select",{value:p||"",onChange:_=>f(_.target.value),'
    'disabled:L.length===0},E.default.createElement("option",{value:""},"All sources"),'
    'L.map(_=>E.default.createElement("option",{key:_,value:_},_))))}'
    'function badge(e){return Z.default.createElement("span",'
    '{className:BACKTICKcard-source source-DOLLARBRACEe.platform_source||"claude"}BACKTICK},e.platform_source||"claude")}'
).replace("BACKTICK", chr(96)).replace("DOLLARBRACE", "$" + "{")


class TestViewerRegistry(unittest.TestCase):
    def test_source_registry_old_and_new_versions(self):
        for name, selector in [("legacy", OLD), ("project-filtered-13.37", NEW)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as folder:
                path = Path(folder) / "viewer-bundle.js"
                path.write_text(selector + UI, encoding="utf-8")
                patcher.patch_bundle(path)
                result = path.read_text(encoding="utf-8")
                self.assertIn(patcher.LABEL_FUNC, result)
                self.assertIn('AgentDockSourceLabel(_)', result)
                self.assertIn('AgentDockSourceLabel(e.platform_source||"claude")', result)
                self.assertIn('"chatgpt","pi","omp","hermes","openclaw"', result)
                patcher.patch_bundle(path)
                self.assertEqual(result, path.read_text(encoding="utf-8"))
                node_test = (
                    '\nconst assert=require("node:assert/strict");'
                    '\nassert.equal(B(["pi"]).includes("hermes"),true);'
                )
                if name == "legacy":
                    node_test += '\nassert.equal(A(["hermes"]),"hermes");'
                else:
                    node_test += (
                        '\nassert.equal(A({sources:["claude","pi"],'
                        'projectsBySource:{claude:[],pi:["my-project"]}}),"pi");'
                        '\nassert.equal(A({sources:["codex","hermes"],'
                        'projectsBySource:{codex:["x"],hermes:["y"]}}),"codex");'
                    )
                proc = subprocess.run(
                    ["node", "-e", result + node_test],
                    capture_output=True, text=True, check=False,
                )
                self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_unknown_registry_fails_closed_without_modifying_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "viewer-bundle.js"
            path.write_text('function unrecognized(e){return "claude"}', encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "registry pattern changed"):
                patcher.patch_bundle(path)
            self.assertEqual(path.read_text(), 'function unrecognized(e){return "claude"}')


if __name__ == "__main__":
    unittest.main()
