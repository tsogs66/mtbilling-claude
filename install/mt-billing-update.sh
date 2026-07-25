#!/usr/bin/env bash
# Copyright (c) 2026 MT-Billing / ts0gs
# License: MIT
# Source: https://github.com/tsogs66/MT-Billing
#
# Guest update script — run inside the MT-Billing LXC/VM (or via Proxmox pct exec).
# Pulls the configured branch from GitHub, rebuilds, and restarts services.
#
# Usage:
#   sudo bash /opt/mt-billing/install/mt-billing-update.sh
#   MT_BILLING_AUTO_ONLY=1 bash install/mt-billing-update.sh   # skip if already up to date
#   bash install/mt-billing-update.sh --check                  # exit 0 if update available
#
# Environment:
#   var_install_dir / INSTALL_DIR   default /opt/mt-billing
#   var_repo_url    / REPO_URL      default https://github.com/tsogs66/MT-Billing.git
#   var_repo_branch / REPO_BRANCH   default main
#   MT_BILLING_AUTO_ONLY=1          only apply when origin is ahead of HEAD
#   MT_BILLING_SKIP_BUILD=1         pull only (not recommended)

set -euo pipefail

INSTALL_DIR="${var_install_dir:-${INSTALL_DIR:-/opt/mt-billing}}"
REPO_URL="${var_repo_url:-${REPO_URL:-https://github.com/tsogs66/MT-Billing.git}}"
REPO_BRANCH="${var_repo_branch:-${REPO_BRANCH:-main}}"
AUTO_ONLY="${MT_BILLING_AUTO_ONLY:-0}"
SKIP_BUILD="${MT_BILLING_SKIP_BUILD:-0}"
CHECK_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    --auto) AUTO_ONLY=1 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
  esac
done

# community-scripts / Proxmox helper logging (optional)
if [[ -n "${FUNCTIONS_FILE_PATH:-}" && -f "${FUNCTIONS_FILE_PATH}" ]]; then
  # shellcheck disable=SC1090
  source "$FUNCTIONS_FILE_PATH"
  color 2>/dev/null || true
elif ! declare -F msg_info &>/dev/null; then
  msg_info() { printf '\033[1;34m[INFO]\033[0m %s\n' "$*"; }
  msg_ok() { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
  msg_error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; }
  STD=""
fi

log_info() { if declare -F msg_info &>/dev/null; then msg_info "$@"; else echo "[INFO] $*"; fi; }
log_ok() { if declare -F msg_ok &>/dev/null; then msg_ok "$@"; else echo "[OK] $*"; fi; }
log_err() { if declare -F msg_error &>/dev/null; then msg_error "$@"; else echo "[ERROR] $*" >&2; fi; }
run() { if [[ -n "${STD:-}" ]]; then $STD "$@"; else "$@"; fi; }

SERVICE_UNIT="/etc/systemd/system/mt-billing-api.service"
STATE_DIR="${INSTALL_DIR}/server/data"
STATE_FILE="${STATE_DIR}/.last-update.json"
PANEL_UPDATE_UNIT="/etc/systemd/system/mt-billing-panel-update.service"
SUDOERS_FILE="/etc/sudoers.d/mt-billing"

service_user() {
  if [[ -f "$SERVICE_UNIT" ]]; then
    grep '^User=' "$SERVICE_UNIT" | cut -d= -f2
  else
    echo "${var_service_user:-mtbilling}"
  fi
}

# Install full passwordless sudoers (must stay in sync with install/mt-billing-sudoers).
install_sudoers_for_updater() {
  local svc_user="$1"
  local install_dir="$2"
  local template="${install_dir}/install/mt-billing-sudoers"
  local tmp
  tmp="$(mktemp)"
  if [[ -f "$template" ]]; then
    sed -e "s|__SVC_USER__|${svc_user}|g" -e "s|__INSTALL_DIR__|${install_dir}|g" \
      -e "s|^Defaults:mtbilling |Defaults:${svc_user} |g" \
      -e "s|^mtbilling ALL=|${svc_user} ALL=|g" \
      -e "s|/opt/mt-billing|${install_dir}|g" \
      "$template" >"$tmp"
  else
    cat >"$tmp" <<EOF
# MT-Billing — allow panel service user to start the root update oneshot
Defaults:${svc_user} !requiretty
${svc_user} ALL=(root) NOPASSWD: /bin/true
${svc_user} ALL=(root) NOPASSWD: /usr/bin/true
${svc_user} ALL=(root) NOPASSWD: /bin/systemctl start mt-billing-panel-update.service
${svc_user} ALL=(root) NOPASSWD: /bin/systemctl start --no-block mt-billing-panel-update.service
${svc_user} ALL=(root) NOPASSWD: /usr/bin/systemctl start mt-billing-panel-update.service
${svc_user} ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block mt-billing-panel-update.service
${svc_user} ALL=(root) NOPASSWD: /bin/systemctl restart mt-billing-api.service
${svc_user} ALL=(root) NOPASSWD: /bin/systemctl restart mt-billing-api
${svc_user} ALL=(root) NOPASSWD: /usr/bin/systemctl restart mt-billing-api.service
${svc_user} ALL=(root) NOPASSWD: /usr/bin/systemctl restart mt-billing-api
${svc_user} ALL=(root) NOPASSWD: /bin/bash ${install_dir}/install/mt-billing-update.sh
${svc_user} ALL=(root) NOPASSWD: /usr/bin/bash ${install_dir}/install/mt-billing-update.sh
${svc_user} ALL=(root) NOPASSWD: /bin/bash ${install_dir}/install/mt-billing-self-update.sh
${svc_user} ALL=(root) NOPASSWD: /usr/bin/bash ${install_dir}/install/mt-billing-self-update.sh
${svc_user} ALL=(root) NOPASSWD: /bin/bash ${install_dir}/install/mt-billing-cloudflare-tunnel.sh
${svc_user} ALL=(root) NOPASSWD: /usr/bin/bash ${install_dir}/install/mt-billing-cloudflare-tunnel.sh
${svc_user} ALL=(root) NOPASSWD: /bin/systemctl start cloudflared-mt-billing.service
${svc_user} ALL=(root) NOPASSWD: /bin/systemctl stop cloudflared-mt-billing.service
${svc_user} ALL=(root) NOPASSWD: /bin/systemctl restart cloudflared-mt-billing.service
${svc_user} ALL=(root) NOPASSWD: /bin/systemctl is-active cloudflared-mt-billing.service
${svc_user} ALL=(root) NOPASSWD: /usr/bin/systemctl start cloudflared-mt-billing.service
${svc_user} ALL=(root) NOPASSWD: /usr/bin/systemctl stop cloudflared-mt-billing.service
${svc_user} ALL=(root) NOPASSWD: /usr/bin/systemctl restart cloudflared-mt-billing.service
${svc_user} ALL=(root) NOPASSWD: /usr/bin/systemctl is-active cloudflared-mt-billing.service
EOF
  fi
  install -m 440 "$tmp" "$SUDOERS_FILE"
  rm -f "$tmp"
  if command -v visudo >/dev/null 2>&1; then
    if ! visudo -cf "$SUDOERS_FILE" >/dev/null 2>&1; then
      log_err "Invalid sudoers file — removing ${SUDOERS_FILE}"
      rm -f "$SUDOERS_FILE"
      return 1
    fi
  fi
  return 0
}

# Allow the API service user to trigger updates from the panel UI.
install_panel_update_privs() {
  local svc_user
  svc_user="$(service_user)"
  svc_user="${svc_user:-mtbilling}"

  if [[ -f "${INSTALL_DIR}/install/mt-billing-panel-update.service" ]]; then
    sed "s|/opt/mt-billing|${INSTALL_DIR}|g" \
      "${INSTALL_DIR}/install/mt-billing-panel-update.service" >"${PANEL_UPDATE_UNIT}"
  else
    cat >"${PANEL_UPDATE_UNIT}" <<EOF
[Unit]
Description=MT-Billing panel update (triggered from Application Updater UI)
After=network-online.target

[Service]
Type=oneshot
Nice=5
Environment=var_install_dir=${INSTALL_DIR}
Environment=var_repo_branch=${REPO_BRANCH}
Environment=INSTALL_DIR=${INSTALL_DIR}
Environment=REPO_BRANCH=${REPO_BRANCH}
Environment=MT_BILLING_AUTO_ONLY=0
ExecStart=/bin/bash ${INSTALL_DIR}/install/mt-billing-update.sh
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
  fi

  install_sudoers_for_updater "$svc_user" "$INSTALL_DIR" || return 1
  systemctl daemon-reload 2>/dev/null || true
  log_ok "Panel updater privileges installed (${svc_user} → ${PANEL_UPDATE_UNIT})"
}

git_safe() {
  git -c safe.directory="$INSTALL_DIR" -c safe.directory='*' "$@"
}

remote_sha() {
  git_safe -C "$INSTALL_DIR" fetch -q origin "$REPO_BRANCH"
  git_safe -C "$INSTALL_DIR" rev-parse "origin/${REPO_BRANCH}"
}

local_sha() {
  git_safe -C "$INSTALL_DIR" rev-parse HEAD
}

write_state() {
  local status="$1"
  local from="$2"
  local to="$3"
  local message="${4:-}"
  mkdir -p "$STATE_DIR"
  local finished_json="null"
  if [[ "$status" != "running" ]]; then
    finished_json="\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
  fi
  local started="${UPDATE_STARTED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
  local msg_json
  msg_json=$(printf '%s' "$message" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '""')
  cat >"$STATE_FILE" <<EOF
{"status":"${status}","branch":"${REPO_BRANCH}","from":"${from}","to":"${to}","at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","startedAt":"${started}","finishedAt":${finished_json},"message":${msg_json}}
EOF
}

# Keep live panel data across hard resets (DB may be tracked in older checkouts).
# Do NOT preserve .last-update.json — restore would overwrite "updated" with stale "running".
PRESERVE_PATHS=(
  "server/data/mt-billing.db"
  "server/data/mt-billing.db-wal"
  "server/data/mt-billing.db-shm"
  "server/.env"
)

backup_preserve() {
  PRESERVE_BACKUP="$(mktemp -d /tmp/mt-billing-preserve.XXXXXX)"
  local p
  for p in "${PRESERVE_PATHS[@]}"; do
    if [[ -e "${INSTALL_DIR}/${p}" ]]; then
      mkdir -p "${PRESERVE_BACKUP}/$(dirname "$p")"
      cp -a "${INSTALL_DIR}/${p}" "${PRESERVE_BACKUP}/${p}"
    fi
  done
}

restore_preserve() {
  local p
  [[ -n "${PRESERVE_BACKUP:-}" && -d "${PRESERVE_BACKUP}" ]] || return 0
  for p in "${PRESERVE_PATHS[@]}"; do
    if [[ -e "${PRESERVE_BACKUP}/${p}" ]]; then
      mkdir -p "${INSTALL_DIR}/$(dirname "$p")"
      cp -a "${PRESERVE_BACKUP}/${p}" "${INSTALL_DIR}/${p}"
    fi
  done
  rm -rf "${PRESERVE_BACKUP}"
  PRESERVE_BACKUP=""
}

# Appliance update: match origin exactly. Local edits to install scripts / tree must not block pull.
sync_to_origin() {
  log_info "Syncing to origin/${REPO_BRANCH} (keeping local DB and .env)"
  backup_preserve
  # Root/service-user ownership mismatch → "dubious ownership" without this.
  git config --global --add safe.directory "$INSTALL_DIR" 2>/dev/null || true
  git config --system --add safe.directory "$INSTALL_DIR" 2>/dev/null || true
  git -c safe.directory='*' -C "$INSTALL_DIR" status >/dev/null 2>&1 || true
  run git_safe -C "$INSTALL_DIR" remote set-url origin "$REPO_URL" || true
  run git_safe -C "$INSTALL_DIR" fetch origin "$REPO_BRANCH"
  # Discard dirty working tree so fast-forward / reset cannot abort
  run git_safe -C "$INSTALL_DIR" checkout -f -B "$REPO_BRANCH" "origin/${REPO_BRANCH}"
  run git_safe -C "$INSTALL_DIR" reset --hard "origin/${REPO_BRANCH}"
  restore_preserve
}

if [[ ! -d "$INSTALL_DIR/.git" ]]; then
  log_err "No git checkout at ${INSTALL_DIR}"
  exit 1
fi

if [[ ! -f "$SERVICE_UNIT" ]]; then
  log_err "mt-billing-api.service not found — is MT-Billing installed?"
  exit 1
fi

SVC_USER="$(service_user)"
SVC_USER="${SVC_USER:-mtbilling}"
UPDATE_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PRESERVE_BACKUP=""

log_info "Checking ${REPO_URL} (${REPO_BRANCH})"
BEFORE="$(local_sha)"
REMOTE="$(remote_sha)"

if [[ "$BEFORE" == "$REMOTE" ]]; then
  log_ok "Already up to date (${BEFORE:0:12})"
  write_state "current" "$BEFORE" "$REMOTE" "Already up to date."
  if [[ "$CHECK_ONLY" == "1" ]]; then
    exit 1
  fi
  exit 0
fi

if [[ "$CHECK_ONLY" == "1" ]]; then
  log_info "Update available: ${BEFORE:0:12} → ${REMOTE:0:12}"
  exit 0
fi

if [[ "$AUTO_ONLY" == "1" ]]; then
  log_info "New commits on origin — applying update ${BEFORE:0:12} → ${REMOTE:0:12}"
fi

write_state "running" "$BEFORE" "$REMOTE" "Update in progress…"
trap 'restore_preserve; write_state "failed" "${BEFORE:-}" "${AFTER:-${REMOTE:-}}" "Update failed."; systemctl start mt-billing-api 2>/dev/null || true' ERR

log_info "Stopping MT-Billing API"
run systemctl stop mt-billing-api
log_ok "Stopped MT-Billing API"

if declare -F setup_nodejs &>/dev/null; then
  NODE_VERSION="22" setup_nodejs
fi

log_info "Pulling latest code"
sync_to_origin
AFTER="$(local_sha)"
log_ok "Checked out ${AFTER:0:12}"

if [[ "$SKIP_BUILD" != "1" ]]; then
  log_info "Installing dependencies and building"
  run chown -R "${SVC_USER}:${SVC_USER}" "$INSTALL_DIR"
  run sudo -u "$SVC_USER" bash -c "cd '$INSTALL_DIR' && npm install && npm run build && npm --prefix server run build"
  log_ok "Build complete"
fi

log_info "Starting services"
run systemctl start mt-billing-api

# Allow DB restore / logo / QR uploads (nginx defaults to 1m → HTTP 413)
NGINX_SITE="/etc/nginx/sites-available/mt-billing"
if [[ -f "$NGINX_SITE" ]]; then
  log_info "Ensuring nginx client_max_body_size 100m (DB restore / uploads)"
  if grep -q 'client_max_body_size' "$NGINX_SITE"; then
    sed -i 's/client_max_body_size[[:space:]]*[0-9]*m;/client_max_body_size 100m;/g' "$NGINX_SITE" || true
  else
    sed -i 's/server {/server {\n    client_max_body_size 100m;/' "$NGINX_SITE" || true
  fi
fi
if nginx -t 2>/dev/null; then
  run systemctl reload nginx 2>/dev/null || true
fi
log_ok "Services started"

trap - ERR
write_state "updated" "$BEFORE" "$AFTER" "Update complete."

# Ensure UI-triggered updates work after this pull (sudoers + oneshot unit)
if [[ "$(id -u)" -eq 0 ]]; then
  install_panel_update_privs || true
fi

log_ok "Update complete (${BEFORE:0:12} → ${AFTER:0:12})"
