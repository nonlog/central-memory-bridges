"""Static, non-destructive contracts for the production-facing worker proxies."""
import re
import unittest
from pathlib import Path

DEPLOY = Path(__file__).resolve().parent
MACHINE = (DEPLOY / "nginx-claude-mem-machine.conf.example").read_text()
ADMIN = (DEPLOY / "nginx-claude-mem-admin.conf.example").read_text()


def block(source, anchor):
    start = source.index(anchor)
    beginning = source.index("{", start)
    depth = 0
    for i in range(beginning, len(source)):
        if source[i] == "{":
            depth += 1
        elif source[i] == "}":
            depth -= 1
            if depth == 0:
                return source[beginning + 1:i]
    raise AssertionError(f"Missing closing block: {anchor}")


class PublicProxyContractTests(unittest.TestCase):
    def test_oauth_routes_keep_independent_proxies(self):
        self.assertIn("location ^~ /chatgpt-mcp/", MACHINE)
        self.assertIn("proxy_pass http://127.0.0.1:18790/;", block(MACHINE, "location ^~ /chatgpt-mcp/ {"))
        oauth = block(MACHINE, "location ^~ /chatgpt-mcp/oauth/authorize")
        self.assertIn('auth_basic "Central Memory MCP";', oauth)
        self.assertIn("auth_basic_user_file /etc/nginx/.claude-mem-admin.htpasswd;", oauth)

    def test_ingest_keeps_official_bearer_contract(self):
        ingest = block(MACHINE, "location = /api/spool/ingest")
        self.assertIn("if ($request_method != POST) { return 405; }", ingest)
        self.assertIn("proxy_set_header Authorization $http_authorization;", ingest)
        self.assertIn("proxy_pass http://127.0.0.1:37777;", ingest)
        self.assertNotIn("auth_basic ", ingest)

    def test_public_browser_is_not_a_data_leak(self):
        self.assertRegex(MACHINE, r'location = / \{\s*return 302 https://claude-mem-admin')
        self.assertIn("location = /viewer", MACHINE)
        self.assertIn("location = /stream { return 403; }", MACHINE)
        self.assertIn("location ^~ /api/work-view", MACHINE)
        self.assertIn("return 403;", block(MACHINE, "location ^~ /api/work-view"))
        management = re.search(r'location ~ \^/api/\((.*?)\)', MACHINE)
        self.assertIsNotNone(management)
        for name in ("settings", "admin", "logs", "mcp", "import", "export"):
            self.assertIn(name, management.group(1))
        self.assertIn('if ($request_method ~ ^(DELETE|PATCH|PUT)$) { return 403; }',
                      block(MACHINE, "location /"))

    def test_admin_work_view_is_authenticated_and_read_only(self):
        self.assertIn('auth_basic "claude-mem admin";', ADMIN)
        self.assertIn("auth_basic_user_file /etc/nginx/.claude-mem-admin.htpasswd;", ADMIN)
        b = block(ADMIN, "location ^~ /api/work-view")
        self.assertIn("if ($request_method !~ ^(GET|HEAD)$) { return 405; }", b)
        self.assertIn("proxy_set_header Host 127.0.0.1:37777;", b)
        for name in ("Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Real-IP"):
            self.assertIn(f'proxy_set_header {name} "";', b)
        self.assertIn('add_header Cache-Control "private, no-store" always;', b)
        self.assertIn("proxy_buffering off;", b)


if __name__ == "__main__":
    unittest.main()
