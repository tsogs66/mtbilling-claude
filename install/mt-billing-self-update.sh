#!/usr/bin/env bash
# Copyright (c) 2026 MT-Billing / ts0gs
# License: MIT
#
# Unprivileged self-update for the API service user (mtbilling).
# Pulls/builds in INSTALL_DIR, then restarts the API via passwordless sudo
# (or exits 0 after build if restart is unavailable — next service start picks up code).
#
# Invoked by the panel updater when root oneshot is not available.

set -euo pipefail

INSTALL_DIR="${var_install_dir:-${INSTALL_DIR:-/opt/mt-billing}}"
REPO_BRANCH="${var_repo_branch:-${REPO_BRANCH:-main}}"
REPO_URL="${var_repo_url:-${REPO_URL:-https://github.com/tsogs66/MT-Billing.git}}"
STATE_DIR="${INSTALL_DIR}/server/data"
STATE_FILE="${STATE_DIR}/.last-update.json"
LOG_FILE="${STATE_DIR}/update-ui.log"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG_FILE"; }
fail() {
  local msg="$1"
  log "ERROR: $msg"
  python3 - <<PY
import json, datetime
p=${STATE_FILE@Q}
msg=${msg@Q}
now=datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
try:
  cur=json.load(open(p))
except Exception:
  cur={}
cur.update({"status":"failed","at":now,"finishedAt":now,"message":msg})
open(p,"w").write(json.dumps(cur,separators=(",",":")))
PY
  exit 1
}

mkdir -p "$STATE_DIR"
touch "$LOG_FILE"

[[ -d "${INSTALL_DIR}/.git" ]] || fail "No git checkout at ${INSTALL_DIR}"

cd "$INSTALL_DIR"
git config --global --add safe.directory "$INSTALL_DIR" 2>/dev/null || true
git config --global --add safe.directory '*' 2>/dev/null || true
BEFORE="$(git -c safe.directory="$INSTALL_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
STARTED="${UPDATE_STARTED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

python3 - <<PY
import json
p=${STATE_FILE@Q}
open(p,"w").write(json.dumps({
  "status":"running","branch":"${REPO_BRANCH}","from":"${BEFORE}",
  "to":null,"at":"${STARTED}","startedAt":"${STARTED}","finishedAt":None,
  "message":"Self-update: syncing from GitHub…"
},separators=(",",":")))
PY

log "Self-update starting in ${INSTALL_DIR} (${BEFORE:0:12})"

# Preserve live data
PRESERVE="$(mktemp -d /tmp/mt-self-preserve.XXXXXX)"
for p in server/data/mt-billing.db server/data/mt-billing.db-wal server/data/mt-billing.db-shm server/.env; do
  if [[ -e "${INSTALL_DIR}/${p}" ]]; then
    mkdir -p "${PRESERVE}/$(dirname "$p")"
    cp -a "${INSTALL_DIR}/${p}" "${PRESERVE}/${p}" || true
  fi
done

git -c safe.directory="$INSTALL_DIR" remote set-url origin "$REPO_URL" || true
git -c safe.directory="$INSTALL_DIR" fetch origin "$REPO_BRANCH" || fail "git fetch failed — check network / GitHub access"
git -c safe.directory="$INSTALL_DIR" checkout -f -B "$REPO_BRANCH" "origin/${REPO_BRANCH}" || fail "git checkout failed"
git -c safe.directory="$INSTALL_DIR" reset --hard "origin/${REPO_BRANCH}" || fail "git reset failed"

for p in server/data/mt-billing.db server/data/mt-billing.db-wal server/data/mt-billing.db-shm server/.env; do
  if [[ -e "${PRESERVE}/${p}" ]]; then
    mkdir -p "$(dirname "${INSTALL_DIR}/${p}")"
    cp -a "${PRESERVE}/${p}" "${INSTALL_DIR}/${p}" || true
  fi
done
rm -rf "$PRESERVE"

AFTER="$(git rev-parse HEAD)"
log "Checked out ${AFTER:0:12}"

if [[ "$BEFORE" == "$AFTER" ]]; then
  python3 - <<PY
import json, datetime
p=${STATE_FILE@Q}
now=datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
open(p,"w").write(json.dumps({
  "status":"current","branch":"${REPO_BRANCH}","from":"${BEFORE}","to":"${AFTER}",
  "at":now,"startedAt":"${STARTED}","finishedAt":now,"message":"Already up to date."
},separators=(",",":")))
PY
  log "Already up to date"
  exit 0
fi

log "npm install + build"
npm install || fail "npm install failed"
npm run build || fail "client build failed"
npm --prefix server run build || fail "server build failed"
log "Build complete"

RESTARTED=0
for cmd in \
  "sudo -n systemctl restart mt-billing-api.service" \
  "sudo -n /bin/systemctl restart mt-billing-api.service" \
  "sudo -n /usr/bin/systemctl restart mt-billing-api.service" \
  "sudo -n systemctl restart mt-billing-api" \
  "sudo -n systemctl start --no-block mt-billing-panel-update.service"
do
  if eval "$cmd" >>"$LOG_FILE" 2>&1; then
    RESTARTED=1
    log "Restarted via: $cmd"
    break
  fi
done

MSG="Self-update complete (${BEFORE:0:7} → ${AFTER:0:7})."
if [[ "$RESTARTED" -eq 0 ]]; then
  MSG="${MSG} Restart API manually: sudo systemctl restart mt-billing-api"
  log "WARNING: could not restart API via sudo — code is updated on disk"
fi

python3 - <<PY
import json, datetime
p=${STATE_FILE@Q}
now=datetime.datetime.utcnow().strftime('%Y-%m-%dT%H:%M:%SZ')
open(p,"w").write(json.dumps({
  "status":"updated","branch":"${REPO_BRANCH}","from":"${BEFORE}","to":"${AFTER}",
  "at":now,"startedAt":"${STARTED}","finishedAt":now,"message":${MSG@Q}
},separators=(",",":")))
PY

log "$MSG"
# Soft-restart this Node process if we couldn't systemctl (parent may watch exit)
if [[ "$RESTARTED" -eq 0 ]] && [[ -n "${MT_SELF_UPDATE_EXIT:-}" ]]; then
  exit 42
fi
exit 0
