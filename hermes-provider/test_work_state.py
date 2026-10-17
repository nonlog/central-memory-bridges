"""No Hermes installation needed: verify the bridge's Worker field contract."""
import importlib.util
import sys
import types
import unittest
from pathlib import Path

module = types.ModuleType("agent.memory_provider")
module.MemoryProvider = object
module.is_trivial_prompt = lambda prompt: False
sys.modules.setdefault("agent", types.ModuleType("agent"))
sys.modules["agent.memory_provider"] = module

spec = importlib.util.spec_from_file_location(
    "hermes_cmem_bridge", Path(__file__).with_name("__init__.py")
)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class TestWorkStateFields(unittest.TestCase):
    def test_v1341_field_validation(self):
        check = bridge._work_state_fields_error
        self.assertIsNone(check({"task": "ok", "count": 1.5, "done": False, "skip": None}))
        self.assertIn("non-empty", check({}))
        self.assertIn("non-empty", check({"": "bad"}))
        self.assertIn("safe", check({"count": 2 ** 53}))
        self.assertIn("finite", check({"count": float('nan')}))
        self.assertIn("finite", check({"count": float('inf')}))
        self.assertIn("string", check({"nested": {"data": True}}))
        max_payload = 2000 - len('{"note":""}')
        self.assertIsNone(check({"note": "a" * max_payload}))
        self.assertIn("2000", check({"note": "a" * (max_payload + 1)}))
        self.assertIn("2000", check({"note": "😀" * 996}))


if __name__ == "__main__":
    unittest.main()
