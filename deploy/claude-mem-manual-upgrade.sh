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
STATE_DIR=/run/claude-mem-manual-upgrade
STATE_FILE="$STATE_DIR/state.json"
LOG_FILE="$STATE_DIR/upgrade.log"
UNIT_NAME=claude-mem-manual-upgrade.service
SELF_SCRIPT=$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")

verify_health() {
  local expected="${1:-$TARGET}"
  curl -fsS --max-time 8 http://127.0.0.1:37777/api/health | \
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=JSON.parse(s),target=process.argv[1];if(a.version!==target||a.status!=="ok"||a.mcpReady!==true||a.dependencies?.degraded)process.exit(1);console.log(`Central Worker ${a.version}: healthy, MCP ready`)})' "$expected"
  curl -fsS --max-time 8 http://127.0.0.1:37777/api/readiness >/dev/null
}

write_state() {
  local job_id="$1" target="$2" state="$3" exit_code="$4" current_ver="${5:-}"
  mkdir -p "$STATE_DIR"
  node -e '
const fs = require("fs");
const [file, jobId, target, state, exitCodeRaw, currentVersion] = process.argv.slice(1);
let prev = {};
try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
const now = new Date().toISOString();
const next = {
  jobId,
  target,
  state,
  exitCode: exitCodeRaw === "" ? null : Number(exitCodeRaw),
  currentVersion: currentVersion || prev.currentVersion || null,
  startedAt: prev.jobId === jobId && prev.startedAt ? prev.startedAt : now,
  updatedAt: now,
  finishedAt: state === "running" ? null : now,
};
const tmp = `${file}.tmp.${process.pid}`;
fs.writeFileSync(tmp, JSON.stringify(next) + "\n", { mode: 0o600 });
fs.renameSync(tmp, file);
' "$STATE_FILE" "$job_id" "$target" "$state" "$exit_code" "$current_ver"
}

run_upgrade() {
  local TARGET="$1"
  [[ "$TARGET" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Expected an exact stable version, e.g. 15.8.3' >&2; exit 64; }
  [[ -f "$WORKER" && -x "$UPDATER" ]] || { echo 'Central Worker updater is missing' >&2; exit 1; }
  exec 8>/run/claude-mem-manual-upgrade.lock
  if ! flock -n 8; then
    echo 'Another computer is upgrading the central Worker; waiting for its result.'
    flock -w 3600 8 || { echo 'Timed out waiting for the central upgrade; retry later.' >&2; exit 75; }
  fi
  local CURRENT
  CURRENT=$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$WORKER")
  if dpkg --compare-versions "$CURRENT" ge "$TARGET"; then
    echo "Central Worker is already $CURRENT (requested $TARGET); synchronize this computer to $CURRENT."
    verify_health "$CURRENT"
    return 0
  fi
  command -v gh >/dev/null || { echo 'GitHub CLI unavailable on Ubuntu-us' >&2; exit 1; }
  # Ensure the selected version actually exists before submitting a CI run.
  npm view "claude-mem@$TARGET" dist.integrity --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{if(!/^sha512-/.test(String(JSON.parse(s))))process.exit(1)})'
  local NONCE RUN_ID
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
  verify_health "$TARGET" || {
    echo "Worker did not converge to $TARGET; inspect claude-mem updater logs" >&2
    exit 1
  }
  echo "Worker ready at $TARGET. Continue with Windows CLI/Claude/Codex sync."
}

start_async_job() {
  local TARGET="${1:-}"
  [[ "$TARGET" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Expected an exact stable version, e.g. 15.8.3' >&2; exit 64; }
  [[ -f "$WORKER" && -x "$UPDATER" ]] || { echo 'Central Worker updater is missing' >&2; exit 1; }
  local CURRENT
  CURRENT=$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$WORKER")
  if dpkg --compare-versions "$CURRENT" ge "$TARGET" && verify_health "$CURRENT" >/dev/null 2>&1; then
    node -e 'console.log(JSON.stringify({state:"already_satisfied",target:process.argv[1],current:process.argv[2],message:`Central Worker is already ${process.argv[2]} (requested ${process.argv[1]}); synchronize this computer to ${process.argv[2]}.`}))' "$TARGET" "$CURRENT"
    exit 0
  fi

  mkdir -p "$STATE_DIR"
  if systemctl is-active --quiet "$UNIT_NAME" 2>/dev/null && [[ -f "$STATE_FILE" ]]; then
    node -e '
const fs = require("fs");
const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
console.log(JSON.stringify({ state: "running", jobId: s.jobId || "", target: s.target || process.argv[2], reused: true }));
' "$STATE_FILE" "$TARGET"
    exit 0
  fi

  local JOB_ID
  JOB_ID=$(openssl rand -hex 8)
  : > "$LOG_FILE"
  chmod 600 "$LOG_FILE"
  write_state "$JOB_ID" "$TARGET" "running" "" "$CURRENT"
  systemctl reset-failed "$UNIT_NAME" 2>/dev/null || true
  systemd-run \
    --unit="$UNIT_NAME" \
    --description="Claude-mem manual central upgrade to $TARGET" \
    --collect \
    "$SELF_SCRIPT" --run-job "$JOB_ID" "$TARGET" >/dev/null 2>&1

  node -e 'console.log(JSON.stringify({state:"started",jobId:process.argv[1],target:process.argv[2]}))' "$JOB_ID" "$TARGET"
}

run_async_job() {
  local JOB_ID="${1:-}" TARGET="${2:-}"
  [[ -n "$JOB_ID" && "$TARGET" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || exit 64
  mkdir -p "$STATE_DIR"
  exec >>"$LOG_FILE" 2>&1
  on_job_exit() {
    local rc=$?
    local ver=''
    ver=$(node -e 'process.stdout.write(require(process.argv[1]).version)' "$WORKER" 2>/dev/null || true)
    if [[ $rc -eq 0 ]]; then
      write_state "$JOB_ID" "$TARGET" "succeeded" "0" "$ver"
    else
      write_state "$JOB_ID" "$TARGET" "failed" "$rc" "$ver"
    fi
  }
  trap on_job_exit EXIT
  run_upgrade "$TARGET"
}

show_async_status() {
  local JOB_ID="${1:-}" OFFSET="${2:-0}"
  [[ "$OFFSET" =~ ^[0-9]+$ ]] || OFFSET=0
  local UNIT_STATE
  UNIT_STATE=$(systemctl is-active "$UNIT_NAME" 2>/dev/null || true)
  node -e '
const fs = require("fs");
const [stateFile, logFile, reqJobId, offsetStr, unitState] = process.argv.slice(1);
const offset = Number(offsetStr) || 0;
let state = { jobId: reqJobId, target: "", state: "unknown", exitCode: null };
try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch {}
let lines = [];
let nextOffset = offset;
try {
  const raw = fs.readFileSync(logFile, "utf8");
  const all = raw === "" ? [] : raw.replace(/\r\n/g, "\n").split("\n");
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  const slice = all.slice(offset, offset + 200);
  lines = slice;
  nextOffset = offset + slice.length;
} catch {}
let effectiveState = state.state || "unknown";
let exitCode = state.exitCode ?? null;
if (effectiveState === "running" && unitState !== "active" && unitState !== "activating") {
  effectiveState = "failed";
  if (exitCode === null) exitCode = 1;
}
console.log(JSON.stringify({
  jobId: state.jobId || reqJobId,
  target: state.target || "",
  state: effectiveState,
  exitCode,
  currentVersion: state.currentVersion || null,
  nextOffset,
  lines,
}));
' "$STATE_FILE" "$LOG_FILE" "$JOB_ID" "$OFFSET" "$UNIT_STATE"
}

case "${1:-}" in
  --start)
    shift
    start_async_job "${1:-}"
    ;;
  --run-job)
    shift
    run_async_job "${1:-}" "${2:-}"
    ;;
  --status)
    shift
    show_async_status "${1:-}" "${2:-0}"
    ;;
  *)
    TARGET="${1:-}"
    run_upgrade "$TARGET"
    ;;
esac
