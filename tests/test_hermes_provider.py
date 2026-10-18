import importlib.util
import json
import pathlib
import sys
import types
import unittest


class FakeMemoryProvider:
    name = "claude-mem"


class FakeMemoryManager:
    def __init__(self, providers):
        self.providers = providers

    def sync_all(self, **kwargs):
        return kwargs


# Hermes is an optional host dependency, and is not installed on the CI runner.
agent = types.ModuleType("agent")
memory_provider = types.ModuleType("agent.memory_provider")
memory_provider.MemoryProvider = FakeMemoryProvider
memory_provider.is_trivial_prompt = lambda prompt: not str(prompt).strip()
memory_manager = types.ModuleType("agent.memory_manager")
memory_manager.MemoryManager = FakeMemoryManager
agent.memory_provider = memory_provider
agent.memory_manager = memory_manager
sys.modules.update({
    "agent": agent,
    "agent.memory_provider": memory_provider,
    "agent.memory_manager": memory_manager,
})
path = pathlib.Path(__file__).resolve().parents[1] / "hermes-provider" / "__init__.py"
spec = importlib.util.spec_from_file_location("central_memory_hermes", path)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class HermesBridgeContractTests(unittest.TestCase):
    def test_lean_fastpath_only_when_all_providers_are_claude_mem(self):
        bridge._install_lean_capture_fastpath()
        first = FakeMemoryManager.sync_all
        bridge._install_lean_capture_fastpath()
        self.assertIs(FakeMemoryManager.sync_all, first)
        self.assertEqual(
            FakeMemoryManager([FakeMemoryProvider()]).sync_all(messages=[{"content": "secret"}], assistant_content="safe"),
            {"assistant_content": "safe"},
        )
        other = types.SimpleNamespace(name="another-provider")
        self.assertIn(
            "messages",
            FakeMemoryManager([FakeMemoryProvider(), other]).sync_all(messages=[{"content": "keep"}]),
        )
        self.assertIn("messages", FakeMemoryManager([]).sync_all(messages=[]))

    def test_work_state_primitive_contract(self):
        self.assertIsNone(bridge._work_state_fields_error({"task": "ship", "done": True, "count": 2}))
        for bad in (None, {}, {"x": {}}, {"x": []}, {"x": float("nan")},
                    {"x": 2**54}, {"x": "a" * 3000}):
            with self.subTest(bad=str(bad)[:12]):
                self.assertIsNotNone(bridge._work_state_fields_error(bad))

    def test_work_state_isolated_from_memory_context(self):
        src = ("# Work state: your to-do lists and working state\n"
               "- Read every list, closed items included: work_state_read with includeClosed=true\n"
               "\n# [central memory]\nSome durable observation")
        had, memory = bridge._strip_work_state_context(src)
        self.assertTrue(had)
        self.assertIn("Some durable observation", memory)
        self.assertEqual(bridge._strip_work_state_context("Ordinary context"), (False, "Ordinary context"))

    def test_tools_and_platform_source_are_preserved(self):
        provider = bridge.ClaudeMemMemoryProvider(config={})
        names = [tool["name"] for tool in provider.get_tool_schemas()]
        self.assertEqual(names, ["claude_mem_search", "claude_mem_recent", "work_state_write", "work_state_read"])
        self.assertIn('"platformSource": "hermes"', path.read_text())


if __name__ == "__main__":
    unittest.main()
