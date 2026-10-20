#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

export HOME=/root
export PATH=/root/.bun/bin:/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

SERVICE=claude-mem.service
DEPENDENT_SERVICE=central-memory-chatgpt-mcp.service
DATA=/srv/storage/shared/us-migrated/claude-mem
PLUGIN=/root/.claude/plugins/marketplaces/thedotmack
BACKUP_ROOT=/srv/backups/claude-mem
LOCK=/run/claude-mem-weekly-update.lock
CACHE=""
LOCAL_ROLLBACK=""
BACKUP=""
CURRENT=""
LATEST=""
ROLLBACK_ARMED=0
PLUGIN_MAY_HAVE_CHANGED=0
DEPENDENT_WAS_ACTIVE=0

log() { printf '[%s] %s\n' "$(date --iso-8601=seconds)" "$*"; }

cleanup() {
  if [[ -n "${CACHE:-}" && -d "$CACHE" ]]; then rm -rf -- "$CACHE"; fi
  if [[ -n "${LOCAL_ROLLBACK:-}" && -d "$LOCAL_ROLLBACK" ]]; then rm -rf -- "$LOCAL_ROLLBACK"; fi
}

health_version() {
  local expected="$1" body got
  for _ in $(seq 1 90); do
    if body=$(curl -fsS --max-time 3 http://127.0.0.1:37777/api/health 2>/dev/null); then
      got=$(printf '%s' "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).version||""))}catch{process.exit(1)}})' 2>/dev/null || true)
      if [[ "$got" == "$expected" ]] && curl -fsS --max-time 3 http://127.0.0.1:37777/api/readiness >/dev/null 2>&1; then
        return 0
      fi
    fi
    sleep 2
  done
  return 1
}

restore_dependent_service() {
  if [[ "$DEPENDENT_WAS_ACTIVE" -ne 1 ]]; then
    return 0
  fi
  systemctl start "$DEPENDENT_SERVICE"
  if systemctl is-active --quiet "$DEPENDENT_SERVICE"; then
    log "Restored dependent service $DEPENDENT_SERVICE"
    return 0
  fi
  log "ERROR: dependent service $DEPENDENT_SERVICE failed to start"
  return 1
}

restore_after_failure() {
  local rc="$1"
  trap - ERR INT TERM
  set +e
  log "Update failed (rc=$rc); restoring claude-mem $CURRENT"
  systemctl stop "$SERVICE" >/dev/null 2>&1

  if [[ "$PLUGIN_MAY_HAVE_CHANGED" -eq 1 && -n "$LOCAL_ROLLBACK" && -d "$LOCAL_ROLLBACK/marketplace" ]]; then
    rm -rf -- "$PLUGIN"
    mkdir -p -- "$(dirname "$PLUGIN")"
    cp -a -- "$LOCAL_ROLLBACK/marketplace" "$PLUGIN"
    log "Restored previous official marketplace runtime from local snapshot"
  fi

  if [[ -n "$BACKUP" && -d "$BACKUP/data" ]]; then
    rm -rf -- "$DATA"
    mkdir -p -- "$DATA"
    cp -a -- "$BACKUP/data/." "$DATA/"
    log "Restored pre-update central data snapshot"
  fi

  # A future official Hermes installer must not replace our independent
  # production MemoryProvider, even when the Worker upgrade itself fails.
  if [[ -n "$BACKUP" && -f "$BACKUP/hermes-provider.py" ]]; then
    install -d -m 0755 /root/.hermes/plugins/claude-mem
    cp -a -- "$BACKUP/hermes-provider.py" /root/.hermes/plugins/claude-mem/__init__.py
    log "Restored independent Hermes provider"
  fi

  systemctl start "$SERVICE"
  if health_version "$CURRENT"; then
    log "Rollback healthy on version $CURRENT"
    restore_dependent_service || log "CRITICAL: dependent service $DEPENDENT_SERVICE did not recover after rollback"
  else
    log "CRITICAL: rollback did not restore a healthy $CURRENT worker"
  fi
  cleanup
  exit "$rc"
}

trap cleanup EXIT
trap 'rc=$?; if [[ "$ROLLBACK_ARMED" -eq 1 ]]; then restore_after_failure "$rc"; else exit "$rc"; fi' ERR
trap 'if [[ "$ROLLBACK_ARMED" -eq 1 ]]; then restore_after_failure 130; else exit 130; fi' INT
trap 'if [[ "$ROLLBACK_ARMED" -eq 1 ]]; then restore_after_failure 143; else exit 143; fi' TERM

exec 9>"$LOCK"
if ! flock -n 9; then
  log "Another update check is already running; skipping"
  exit 0
fi

[[ -d /srv/storage/shared ]]
[[ -d "$DATA" ]]
[[ -f "$DATA/settings.json" ]]
[[ -f "$PLUGIN/package.json" ]]

CURRENT=$(node -e 'console.log(require(process.argv[1]).version)' "$PLUGIN/package.json")
CACHE=$(mktemp -d /tmp/claude-mem-update-npm.XXXXXX)
export NPM_CONFIG_CACHE="$CACHE"
export npm_config_cache="$CACHE"

LATEST=$(npm view claude-mem version --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v=JSON.parse(s); if(Array.isArray(v)) v=v.at(-1); process.stdout.write(String(v||""))})')
[[ -n "$LATEST" ]]
log "Installed=$CURRENT npm-latest=$LATEST"

if [[ "$CURRENT" == "$LATEST" ]]; then
  # Also repair a missing UI overlay when the official version has not changed.
  # Do not restart the Worker or touch the database on an up-to-date run.
  BRANDING_PATCHER=/root/apps/central-memory-bridges/deploy/apply-claude-mem-viewer-branding.mjs
  if [[ -f "$BRANDING_PATCHER" ]]; then
    if node "$BRANDING_PATCHER" --root "$PLUGIN" --check >/dev/null 2>&1; then
      log "Already current; Viewer and My Work icon overlays verified"
    elif node "$BRANDING_PATCHER" --root "$PLUGIN" && node "$BRANDING_PATCHER" --root "$PLUGIN" --check; then
      log "Already current; repaired and verified Viewer/My Work icon overlays without restart"
    else
      log "WARNING: Viewer/My Work icon overlay requires manual compatibility review"
    fi
  else
    log "WARNING: branding patcher is missing from the bridge deployment"
  fi
  exit 0
fi

stamp=$(date +%Y%m%d-%H%M%S)
BACKUP="$BACKUP_ROOT/claude-mem-auto-update-$stamp"
mkdir -p -- "$BACKUP"
printf '%s\n' "$CURRENT" > "$BACKUP/from-version"
printf '%s\n' "$LATEST" > "$BACKUP/to-version"

# Pre-download the current official package before any downtime so rollback does not
# depend on the old version still resolving from npm after the update begins.
npm pack "claude-mem@$CURRENT" --silent --pack-destination "$BACKUP" >/dev/null

# Keep a transient local byte-for-byte copy of the installed marketplace runtime.
# It is deleted after a successful update; this is the primary fast rollback path.
LOCAL_ROLLBACK=$(mktemp -d /root/.cache/claude-mem-update-rollback.XXXXXX)
cp -a --reflink=auto -- "$PLUGIN" "$LOCAL_ROLLBACK/marketplace"

# The independent Hermes bridge is never installed by this update command.
# Snapshot its production implementation so any future installer side effect
# cannot quietly replace lean capture, Work State, or its tool contracts.
HERMES_PROVIDER=/root/.hermes/plugins/claude-mem/__init__.py
if [[ -f "$HERMES_PROVIDER" ]]; then
  cp -a -- "$HERMES_PROVIDER" "$BACKUP/hermes-provider.py"
fi

if systemctl is-active --quiet "$DEPENDENT_SERVICE"; then
  DEPENDENT_WAS_ACTIVE=1
  log "Dependent service $DEPENDENT_SERVICE is active and will be restored after the worker update"
fi

ROLLBACK_ARMED=1
log "Stopping $SERVICE for consistent backup and official update"
systemctl stop "$SERVICE"

mkdir -p -- "$BACKUP/data.tmp"
cp -a -- "$DATA/." "$BACKUP/data.tmp/"
mv -- "$BACKUP/data.tmp" "$BACKUP/data"
python3 - "$BACKUP/data/claude-mem.db" <<'PY'
import sqlite3, sys
p=sys.argv[1]
c=sqlite3.connect(f"file:{p}?mode=ro", uri=True)
r=c.execute("pragma integrity_check").fetchone()[0]
c.close()
if r != "ok": raise SystemExit(f"backup integrity_check={r}")
print("backup integrity_check=ok")
PY

PLUGIN_MAY_HAVE_CHANGED=1
log "Installing official claude-mem $LATEST with npx"
export CI=1
export CLAUDE_MEM_DATA_DIR="$DATA"
export CLAUDE_MEM_WORKER_HOST=127.0.0.1
export CLAUDE_MEM_WORKER_PORT=37777
npx --yes "claude-mem@$LATEST" install --provider claude --ide claude-code --runtime worker --no-auto-start

if [[ -f "$BACKUP/hermes-provider.py" ]] && ! cmp -s "$BACKUP/hermes-provider.py" "$HERMES_PROVIDER"; then
  log "ERROR: official upgrade altered independent Hermes plugin; aborting and restoring snapshot"
  cp -a -- "$BACKUP/hermes-provider.py" "$HERMES_PROVIDER"
  false
fi
# A new upstream Hermes package is not automatically installed. Explicitly
# reconcile the two providers in a separate review before changing installer IDE.
for hermes_candidate in "$PLUGIN/hermes/claude-mem/plugin.yaml" "$PLUGIN/plugin/hermes/claude-mem/plugin.yaml"; do
  if [[ -f "$hermes_candidate" ]]; then
    log "NOTE: upstream now bundles a Hermes integration; local Hermes plugin remains independent"
  fi
done

# Source attribution is a data-integrity requirement. If a new upstream
# bundle invalidates the patch contract, fail the update so the ERR trap
# restores the previous Worker and its intact platform identifiers.
python3 /root/apps/central-memory-bridges/deploy/reapply-claude-mem-platform-ui.py
log "Reapplied and verified local platform identity Worker/Viewer overlay"

# Reapply the icon/name branding layer after the identity/source patch. This is
# intentionally non-blocking so an upstream UI change cannot break the official
# claude-mem update/rollback path.
CODEX_ICON_SRC=/srv/storage/shared/us-migrated/claude-mem/ui-overlays/codex-app-ga-logo.png
OPENCLAW_ICON_SRC=/srv/storage/shared/us-migrated/claude-mem/ui-overlays/openclaw-favicon.svg
HERMES_ICON_SRC=/srv/storage/shared/us-migrated/claude-mem/ui-overlays/hermes-favicon-32.png
CLAUDE_ICON_SRC=/srv/storage/shared/us-migrated/claude-mem/ui-overlays/claude-favicon.ico
OMP_ICON_SRC=/srv/storage/shared/us-migrated/claude-mem/ui-overlays/omp-favicon.svg
if [[ -f "$CODEX_ICON_SRC" ]]; then
  install -m 0644 "$CODEX_ICON_SRC" "$PLUGIN/plugin/ui/codex-app-ga-logo.png"
else
  log "WARNING: local Codex icon asset is missing; Viewer will use the OpenAI Blossom fallback"
fi
if [[ -f "$OPENCLAW_ICON_SRC" ]]; then
  install -m 0644 "$OPENCLAW_ICON_SRC" "$PLUGIN/plugin/ui/openclaw-favicon.svg"
else
  log "WARNING: local OpenClaw favicon asset is missing; Viewer will show the text label without the mascot"
fi
if [[ -f "$HERMES_ICON_SRC" ]]; then
  install -m 0644 "$HERMES_ICON_SRC" "$PLUGIN/plugin/ui/hermes-favicon-32.png"
else
  log "WARNING: local Hermes favicon asset is missing; Viewer will use the official remote PNG fallback"
fi
if [[ -f "$CLAUDE_ICON_SRC" ]]; then
  install -m 0644 "$CLAUDE_ICON_SRC" "$PLUGIN/plugin/ui/claude-favicon.ico"
else
  log "WARNING: local Claude favicon asset is missing; Viewer will use the official remote favicon fallback"
fi
if [[ -f "$OMP_ICON_SRC" ]]; then
  install -m 0644 "$OMP_ICON_SRC" "$PLUGIN/plugin/ui/omp-favicon.svg"
else
  log "WARNING: local OMP favicon asset is missing; Viewer will use the official omp.sh fallback"
fi

BRANDING_PATCHER=/root/apps/central-memory-bridges/deploy/apply-claude-mem-viewer-branding.mjs
if node "$BRANDING_PATCHER" --root "$PLUGIN" && node "$BRANDING_PATCHER" --root "$PLUGIN" --check; then
  log "Reapplied claude-mem platform icon branding"
else
  log "WARNING: platform icon branding could not be reapplied to marketplace UI; continuing official update"
fi
for cache_root in /root/.claude/plugins/cache/thedotmack/claude-mem/*; do
  [[ -f "$cache_root/ui/viewer.html" ]] || continue
  if [[ -f "$CODEX_ICON_SRC" ]]; then install -m 0644 "$CODEX_ICON_SRC" "$cache_root/ui/codex-app-ga-logo.png"; fi
  if [[ -f "$OPENCLAW_ICON_SRC" ]]; then install -m 0644 "$OPENCLAW_ICON_SRC" "$cache_root/ui/openclaw-favicon.svg"; fi
  if [[ -f "$HERMES_ICON_SRC" ]]; then install -m 0644 "$HERMES_ICON_SRC" "$cache_root/ui/hermes-favicon-32.png"; fi
  if [[ -f "$CLAUDE_ICON_SRC" ]]; then install -m 0644 "$CLAUDE_ICON_SRC" "$cache_root/ui/claude-favicon.ico"; fi
  if [[ -f "$OMP_ICON_SRC" ]]; then install -m 0644 "$OMP_ICON_SRC" "$cache_root/ui/omp-favicon.svg"; fi
  tmp_brand=$(mktemp -d /tmp/claude-mem-brand-cache.XXXXXX)
  mkdir -p "$tmp_brand/plugin"
  ln -s "$cache_root/ui" "$tmp_brand/plugin/ui"
  if node "$BRANDING_PATCHER" --root "$tmp_brand" && node "$BRANDING_PATCHER" --root "$tmp_brand" --check; then
    log "Reapplied platform icon branding to cache $(basename "$cache_root")"
  else
    log "WARNING: platform icon branding could not be reapplied to cache $(basename "$cache_root")"
  fi
  rm -rf -- "$tmp_brand"
done

# Reassert production endpoint/path invariants and preserve the pre-update
# provider configuration. claude-mem 13.21+ requires an explicit provider for
# non-interactive install; we use --provider claude only to satisfy the installer
# contract, then restore the central worker's configured OpenRouter/provider keys.
python3 - "$DATA/settings.json" "$BACKUP/data/settings.json" <<'PY'
import json, os, sys
p, oldp = sys.argv[1], sys.argv[2]
with open(p, encoding="utf-8") as f: d=json.load(f)
with open(oldp, encoding="utf-8") as f: old=json.load(f)
prefixes=(
    "CLAUDE_MEM_OPENROUTER_", "CLAUDE_MEM_GEMINI_", "CLAUDE_MEM_CLAUDE_",
    "CLAUDE_MEM_CLOUD_SYNC_", "CLAUDE_MEM_PRO_",
)
# The official remote hook clients share this bearer secret with the Worker.
# The upstream installer can rewrite settings.json; dropping this field would
# silently turn every post-upgrade /api/spool/ingest request into HTTP 503.
exact={
    "CLAUDE_MEM_PROVIDER", "CLAUDE_MEM_MODEL", "CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER",
    "CLAUDE_MEM_WORKER_INGEST_TOKEN", "CLAUDE_MEM_HOOK_SPOOL_TRANSPORT",
}
for k,v in old.items():
    if k in exact or any(k.startswith(pre) for pre in prefixes):
        d[k]=v
d["CLAUDE_MEM_DATA_DIR"]="/srv/storage/shared/us-migrated/claude-mem"
d["CLAUDE_MEM_WORKER_HOST"]="127.0.0.1"
d["CLAUDE_MEM_WORKER_PORT"]=37777
d["CLAUDE_MEM_ALLOWED_ORIGINS"]="https://claude-mem.414222.xyz,https://claude-mem-admin.414222.xyz,https://claude-mem.us-next.nolog.eu.org,https://claude-mem-admin.us-next.nolog.eu.org"
d["CLAUDE_MEM_WORKER_AUTOSTART"]="false"
d["CLAUDE_MEM_RUNTIME"]="worker"
t=p+".tmp"
with open(t,"w",encoding="utf-8") as f:
    json.dump(d,f,indent=2,ensure_ascii=False); f.write("\n")
os.chmod(t,0o600)
os.replace(t,p)
PY

python3 - "$DATA/claude-mem.db" <<'PY'
import sqlite3, sys
p=sys.argv[1]
c=sqlite3.connect(f"file:{p}?mode=ro", uri=True)
r=c.execute("pragma integrity_check").fetchone()[0]
c.close()
if r != "ok": raise SystemExit(f"post-install integrity_check={r}")
print("post-install integrity_check=ok")
PY

systemctl start "$SERVICE"
health_version "$LATEST"
restore_dependent_service
log "Official update succeeded: $CURRENT -> $LATEST"
printf 'success %s -> %s at %s\n' "$CURRENT" "$LATEST" "$(date --iso-8601=seconds)" > "$BACKUP/result.txt"
# Launch one isolated, read-only AI compatibility review only after a real
# successful version change. No update means this branch is never reached.
review_unit="claude-mem-bridge-review-${CURRENT//./-}-${LATEST//./-}"
systemd-run --quiet --collect --no-block \
  --unit="$review_unit" \
  --property=Type=oneshot \
  --property=TimeoutStartSec=35min \
  /usr/local/sbin/claude-mem-bridge-review "$CURRENT" "$LATEST" \
  >/dev/null 2>&1 || log "WARNING: could not launch bridge compatibility review"
ROLLBACK_ARMED=0
PLUGIN_MAY_HAVE_CHANGED=0

# Retain only the two newest successful/attempted auto-update snapshots.
mapfile -t stale < <(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -name 'claude-mem-auto-update-*' -printf '%T@ %p\n' | sort -nr | awk 'NR>2{$1=""; sub(/^ /,""); print}')
for d in "${stale[@]:-}"; do [[ -n "$d" ]] && rm -rf -- "$d"; done

exit 0
