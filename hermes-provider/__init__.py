"""Hermes MemoryProvider bridge to an existing claude-mem Worker."""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider, is_trivial_prompt

logger = logging.getLogger(__name__)

_DEFAULT_HOST = "127.0.0.1"
_DEFAULT_PORT = 37777
_DEFAULT_BASE_PROJECT = "hermes"
_DEFAULT_SEARCH_LIMIT = 10
_DEFAULT_MAX_CONTEXT_CHARS = 8000
_HTTP_TIMEOUT = 4.0
_SUMMARY_TIMEOUT = 8.0
_SEARCH_TIMEOUT = 40.0

RECENT_SCHEMA = {
    "name": "claude_mem_recent",
    "description": (
        "Read recent central claude-mem context for a known project without semantic search. "
        "Useful for inspecting history written by Claude Code, Codex, OpenClaw, or Hermes."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "project": {"type": "string", "description": "Exact central memory project name."},
            "limit": {"type": "integer", "description": "Recent session count, 1-10. Default 3."},
        },
        "required": ["project"],
    },
}

SEARCH_SCHEMA = {
    "name": "claude_mem_search",
    "description": (
        "Search the shared central claude-mem memory pool across Hermes, Claude Code, "
        "Codex, OpenClaw, and other projects. Use this when past work or context from "
        "another project may help."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "What to search for."},
            "limit": {
                "type": "integer",
                "description": "Maximum result count, 1-20. Default 10.",
            },
        },
        "required": ["query"],
    },
}


def _as_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        text = value.strip().lower()
        if text in {"1", "true", "yes", "on"}:
            return True
        if text in {"0", "false", "no", "off"}:
            return False
    return default


def _as_int(value: Any, default: int, low: int, high: int) -> int:
    try:
        return max(low, min(high, int(value)))
    except Exception:
        return default


def _safe_project(value: str, fallback: str) -> str:
    text = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value or "").strip())
    text = re.sub(r"-+", "-", text).strip("-._")
    return text or fallback


def _load_config() -> Dict[str, Any]:
    try:
        from hermes_cli.config import load_config_readonly

        cfg = load_config_readonly()
        memory = cfg.get("memory", {}) if isinstance(cfg, dict) else {}
        if not isinstance(memory, dict):
            return {}
        block = memory.get("claude-mem", {})
        if not isinstance(block, dict) or not block:
            block = memory.get("claude_mem", {})
        return dict(block) if isinstance(block, dict) else {}
    except Exception:
        return {}


def _extract_mcp_text(raw: str) -> str:
    try:
        data = json.loads(raw)
    except Exception:
        return raw.strip()
    if not isinstance(data, dict):
        return raw.strip()
    content = data.get("content")
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str):
                parts.append(item["text"])
        if parts:
            return "\n".join(parts).strip()
    return raw.strip()


class ClaudeMemMemoryProvider(MemoryProvider):
    def __init__(self, config: Optional[Dict[str, Any]] = None):
        cfg = dict(config) if config is not None else _load_config()
        self._host = str(cfg.get("worker_host", _DEFAULT_HOST)).strip() or _DEFAULT_HOST
        self._port = _as_int(cfg.get("worker_port"), _DEFAULT_PORT, 1, 65535)
        self._base_project = _safe_project(str(cfg.get("base_project", _DEFAULT_BASE_PROJECT)), _DEFAULT_BASE_PROJECT)
        self._auto_recall = _as_bool(cfg.get("auto_recall"), True)
        self._auto_capture = _as_bool(cfg.get("auto_capture"), True)
        self._search_limit = _as_int(cfg.get("search_limit"), _DEFAULT_SEARCH_LIMIT, 1, 20)
        self._max_context_chars = _as_int(
            cfg.get("max_context_chars"), _DEFAULT_MAX_CONTEXT_CHARS, 1000, 20000
        )
        self._session_id = ""
        self._content_session_id = ""
        self._profile = "default"
        self._project = f"{self._base_project}-default"
        self._projects = [self._base_project, self._project]
        self._last_prompt = ""
        self._last_prompt_at = 0.0
        self._lock = threading.RLock()
        self._hermes_home = ""

    @property
    def name(self) -> str:
        return "claude-mem"

    def is_available(self) -> bool:
        return bool(self._host) and 1 <= self._port <= 65535

    def get_config_schema(self):
        return [
            {
                "key": "worker_host",
                "description": "Existing claude-mem Worker host. Keep 127.0.0.1 on the US host.",
                "default": _DEFAULT_HOST,
            },
            {
                "key": "worker_port",
                "description": "Existing claude-mem Worker port.",
                "default": str(_DEFAULT_PORT),
            },
            {
                "key": "base_project",
                "description": "Base claude-mem project prefix for Hermes profiles.",
                "default": _DEFAULT_BASE_PROJECT,
            },
            {
                "key": "auto_recall",
                "description": "Inject recent central Hermes memory before substantive turns.",
                "default": "true",
                "choices": ["true", "false"],
            },
            {
                "key": "auto_capture",
                "description": "Write completed Hermes turns to the central claude-mem session store.",
                "default": "true",
                "choices": ["true", "false"],
            },
            {
                "key": "search_limit",
                "description": "Default maximum results for claude_mem_search.",
                "default": str(_DEFAULT_SEARCH_LIMIT),
            },
            {
                "key": "max_context_chars",
                "description": "Maximum characters of automatic central memory context injected per turn.",
                "default": str(_DEFAULT_MAX_CONTEXT_CHARS),
            },
        ]

    def initialize(self, session_id: str, **kwargs) -> None:
        with self._lock:
            self._hermes_home = str(kwargs.get("hermes_home") or "")
            self._profile = _safe_project(str(kwargs.get("agent_identity") or "default"), "default")
            self._project = f"{self._base_project}-{self._profile}"
            self._projects = [self._base_project, self._project]
            self._switch_session(session_id)
        health = self._get_text("/api/health", timeout=1.5)
        if health:
            logger.info(
                "claude-mem provider initialized: worker=%s:%s project=%s",
                self._host,
                self._port,
                self._project,
            )
        else:
            logger.warning(
                "claude-mem provider initialized but Worker is not reachable at %s:%s",
                self._host,
                self._port,
            )

    def system_prompt_block(self) -> str:
        return (
            "# Claude-Mem Central Memory\n"
            "Persistent cross-session memory is backed by the shared central claude-mem Worker. "
            "Relevant Hermes context is recalled automatically. Use claude_mem_search when past "
            "work from another project or client may be relevant."
        )

    def on_turn_start(self, turn_number: int, message: str, **kwargs) -> None:
        if not self._auto_capture or is_trivial_prompt(message):
            return
        self._record_prompt(message)

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        if not self._auto_recall or is_trivial_prompt(query):
            return ""
        if session_id and session_id != self._session_id:
            with self._lock:
                self._switch_session(session_id)
        projects = ",".join(self._projects)
        path = "/api/context/inject?" + urllib.parse.urlencode({"projects": projects})
        text = self._get_text(path, timeout=_HTTP_TIMEOUT)
        if not text:
            return ""
        lowered = text.lower()
        if "has no memory yet" in lowered or "this project has no memory yet" in lowered:
            return ""
        text = text.strip()
        if len(text) > self._max_context_chars:
            text = text[: self._max_context_chars].rstrip() + "\n[central memory context truncated]"
        return "## Claude-Mem Central Context\n" + text

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        return None

    def sync_turn(
        self,
        user_content: str,
        assistant_content: str,
        *,
        session_id: str = "",
        messages: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        if not self._auto_capture or is_trivial_prompt(user_content):
            return
        if session_id and session_id != self._session_id:
            with self._lock:
                self._switch_session(session_id)
        if not self._same_recent_prompt(user_content):
            self._record_prompt(user_content)
        assistant = (assistant_content or "").strip()
        if assistant:
            self._post_json(
                "/api/sessions/observations",
                {
                    "contentSessionId": self._content_session_id,
                    "tool_name": "assistant_message",
                    "tool_input": {"source": "hermes"},
                    "tool_response": assistant[:1000],
                    "cwd": os.getcwd(),
                },
                timeout=_HTTP_TIMEOUT,
            )
        self._post_json(
            "/api/sessions/summarize",
            {
                "contentSessionId": self._content_session_id,
                "last_assistant_message": assistant[:4000],
            },
            timeout=_SUMMARY_TIMEOUT,
        )

    def on_session_switch(
        self,
        new_session_id: str,
        *,
        parent_session_id: str = "",
        reset: bool = False,
        rewound: bool = False,
        **kwargs,
    ) -> None:
        with self._lock:
            self._switch_session(new_session_id)

    def on_memory_write(
        self,
        action: str,
        target: str,
        content: str,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        if not self._auto_capture or not str(content or "").strip():
            return
        self._post_json(
            "/api/sessions/observations",
            {
                "contentSessionId": self._content_session_id,
                "tool_name": f"hermes_memory_{action}",
                "tool_input": {
                    "target": target,
                    "metadata": metadata or {},
                },
                "tool_response": str(content)[:1000],
                "cwd": os.getcwd(),
            },
            timeout=_HTTP_TIMEOUT,
        )

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [SEARCH_SCHEMA, RECENT_SCHEMA]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        if tool_name == "claude_mem_search":
            query = str(args.get("query") or "").strip()
            if not query:
                return json.dumps({"ok": False, "error": "query is required"})
            limit = _as_int(args.get("limit"), self._search_limit, 1, 20)
            path = "/api/search/observations?" + urllib.parse.urlencode(
                {"query": query, "limit": limit}
            )
            raw = self._get_text(path, timeout=_SEARCH_TIMEOUT)
            if not raw:
                return json.dumps({"ok": False, "error": "central claude-mem search unavailable"})
            return json.dumps(
                {"ok": True, "query": query, "result": _extract_mcp_text(raw)},
                ensure_ascii=False,
            )
        if tool_name == "claude_mem_recent":
            project = str(args.get("project") or "").strip()
            if not project:
                return json.dumps({"ok": False, "error": "project is required"})
            limit = _as_int(args.get("limit"), 3, 1, 10)
            path = "/api/context/recent?" + urllib.parse.urlencode(
                {"project": project, "limit": limit}
            )
            raw = self._get_text(path, timeout=_HTTP_TIMEOUT)
            if not raw:
                return json.dumps({"ok": False, "error": "central claude-mem recent context unavailable"})
            return json.dumps(
                {"ok": True, "project": project, "result": _extract_mcp_text(raw)},
                ensure_ascii=False,
            )
        return json.dumps({"ok": False, "error": f"unknown tool: {tool_name}"})

    def shutdown(self) -> None:
        return None

    def backup_paths(self) -> List[str]:
        return []

    def _switch_session(self, session_id: str) -> None:
        self._session_id = str(session_id or uuid.uuid4().hex)
        self._content_session_id = (
            f"hermes-{self._profile}-{self._session_id}-{uuid.uuid4().hex[:8]}"
        )
        self._last_prompt = ""
        self._last_prompt_at = 0.0

    def _same_recent_prompt(self, prompt: str) -> bool:
        return (
            prompt == self._last_prompt
            and self._last_prompt_at > 0
            and (time.monotonic() - self._last_prompt_at) < 30.0
        )

    def _record_prompt(self, prompt: str) -> None:
        text = str(prompt or "").strip()
        if not text:
            return
        self._post_json(
            "/api/sessions/init",
            {
                "contentSessionId": self._content_session_id,
                "project": self._project,
                "prompt": text[:8000],
            },
            timeout=_HTTP_TIMEOUT,
        )
        self._last_prompt = text
        self._last_prompt_at = time.monotonic()

    def _base_url(self) -> str:
        host = self._host
        if ":" in host and not host.startswith("["):
            host = f"[{host}]"
        return f"http://{host}:{self._port}"

    def _get_text(self, path: str, *, timeout: float) -> Optional[str]:
        try:
            request = urllib.request.Request(
                self._base_url() + path,
                headers={"Accept": "application/json, text/plain;q=0.9"},
                method="GET",
            )
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read().decode("utf-8", "replace")
        except Exception as exc:
            logger.debug("claude-mem GET %s failed: %s", path, exc)
            return None

    def _post_json(self, path: str, payload: Dict[str, Any], *, timeout: float) -> Optional[str]:
        try:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            request = urllib.request.Request(
                self._base_url() + path,
                data=body,
                headers={"Content-Type": "application/json", "Accept": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read().decode("utf-8", "replace")
        except Exception as exc:
            logger.warning("claude-mem POST %s failed: %s", path, exc)
            return None
