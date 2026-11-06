#!/usr/bin/env bash
# Triggered only by an explicit UniGetUI / Scoop update on Windows.
# Heavy candidate compatibility tests run in GitHub Actions, not on this VPS.
set -Eeuo pipefail
umask 077
export PATH=/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/bin:/bin
REPO=nonlog/central-memory-bridges
WORKFLOW=claude-mem-auto-approve.yml
WORKER=/root/.claude/plugins/marketplaces/thedotmack/plugin/package.json
UPDATER=/usr/local/sbin/claude-mem-weekly-update
TARGET=${1:-}
[[ "$TARGET" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Expected an exact stable version, e.g. 15.8.3' >&2; exit 64; }
[[ -f "$WORKER" && -x "$UPDATER" ]] || { echo 'Central Worker updater is missing' >&2; exit 1; }
exec 8>/run/claude-mem-manual-upgrade.lock
if ! flock -n 8; then
  echo 'Another computer is upgrading the central Worker; waiting for its result.'
  flock -w 3600 8 || { echo 'Timed out waiting for the central upgrade; retry later.' >&2; exit 75; }
fi
CURRENT=$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$WORKER")
verify_health() {
  local expected="${1:-$TARGET}"
  curl -fsS --max-time 8 http://127.0.0.1:37777/api/health | \
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s),target=process.argv[1];if(a.version!==target||a.status!=="ok"||a.mcpReady!==true||a.dependencies?.degraded)process.exit(1);console.log(`Central Worker ${a.version}: healthy, MCP ready`)})' "$expected"
  curl -fsS --max-time 8 http://127.0.0.1:37777/api/readiness >/dev/null
}
if dpkg --compare-versions "$CURRENT" ge "$TARGET"; then
  echo "Central Worker is already $CURRENT (requested $TARGET); synchronize this computer to $CURRENT."
  verify_health "$CURRENT"
  exit 0
fi
command -v gh >/dev/null || { echo 'GitHub CLI unavailable on Ubuntu-us' >&2; exit 1; }
# Ensure the selected version actually exists before submitting a CI run.
npm view "claude-mem@$TARGET" dist.integrity --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{if(!/^sha512-/.test(String(JSON.parse(s))))process.exit(1)})'
NONCE=$(openssl rand -hex 12)
echo "Testing official claude-mem $TARGET through GitHub Actions (request $NONCE)"
gh workflow run "$WORKFLOW" -R "$REPO" --ref master -f "version=$TARGET" -f "request_id=$NONCE"
RUN_ID=''
for _ in $(seq 1 45); do
  RUN_ID=$(gh run list -R "$REPO" --workflow "$WORKFLOW" --event workflow_dispatch --limit 60 \
    --json databaseId,displayTitle \
    --jq ".[] | select(.displayTitle | contains(\"$NONCE\")) | .databaseId" | head -n 1)
  [[ -n "$RUN_ID" ]] && break
  sleep 3
done
[[ -n "$RUN_ID" && "$RUN_ID" =~ ^[0-9]+$ ]] || { echo 'Unable to find the exact dispatched GitHub Actions run' >&2; exit 1; }
echo "CI run: https://github.com/$REPO/actions/runs/$RUN_ID"
timeout 1800 gh run watch "$RUN_ID" -R "$REPO" --exit-status || {
  echo 'Compatibility tests did not pass; Worker left unchanged.' >&2
  exit 1
}
# The existing updater enforces CI approval, npm integrity, exact deployment
# digest, SQLite backups and rollback. It is never invoked on a CI failure.
echo "Compatibility approved; upgrading central Worker to $TARGET"
CLAUDE_MEM_TARGET_VERSION="$TARGET" "$UPDATER"
verify_health || {
  echo "Worker did not converge to $TARGET; inspect claude-mem updater logs" >&2
  exit 1
}
echo "Worker ready at $TARGET. Continue with Windows CLI/Claude/Codex sync."
