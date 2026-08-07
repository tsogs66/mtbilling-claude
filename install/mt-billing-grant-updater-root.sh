#!/usr/bin/env bash
# Copyright (c) 2026 MT-Billing / ts0gs
# License: MIT
# Source: https://github.com/tsogs66/MT-Billing
#
# Grant the Application Updater root privilege so "Update from GitHub" works
# from the panel UI (API runs as the mtbilling service user).
#
# Run once on the LXC/VM as root:
#   curl -fsSL https://raw.githubusercontent.com/tsogs66/MT-Billing/main/install/mt-billing-grant-updater-root.sh | sudo bash
#
# Or locally:
#   sudo bash /opt/mt-billing/install/mt-billing-grant-updater-root.sh
#
# Then optionally pull latest:
#   sudo bash /opt/mt-billing/install/mt-billing-update.sh

set -euo pipefail

INSTALL_DIR="${var_install_dir:-${INSTALL_DIR:-/opt/mt-billing}}"
REPO_BRANCH="${var_repo_branch:-${REPO_BRANCH:-main}}"
REPO_URL="${var_repo_url:-${REPO_URL:-https://github.com/tsogs66/MT-Billing.git}}"
SERVICE_UNIT="/etc/systemd/system/mt-billing-api.service"
PANEL_UPDATE_UNIT="/etc/systemd/system/mt-billing-panel-update.service"
SUDOERS_FILE="/etc/sudoers.d/mt-billing"
UPDATE_SCRIPT="${INSTALL_DIR}/install/mt-billing-update.sh"
SELF_UPDATE_SCRIPT="${INSTALL_DIR}/install/mt-billing-self-update.sh"
RAW_BASE="https://raw.githubusercontent.com/tsogs66/MT-Billing/${REPO_BRANCH}/install"

log_info() { printf '\033[1;34m[INFO]\033[0m %s\n' "$*"; }
log_ok() { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
log_err() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; }

if [[ "$(id -u)" -ne 0 ]]; then
  log_err "Run as root: sudo bash $0"
  exit 1
fi

if [[ ! -d "$INSTALL_DIR" ]]; then
  log_err "Install dir not found: $INSTALL_DIR"
  exit 1
fi

svc_user="mtbilling"
if [[ -f "$SERVICE_UNIT" ]]; then
  detected="$(grep '^User=' "$SERVICE_UNIT" | cut -d= -f2 || true)"
  [[ -n "$detected" ]] && svc_user="$detected"
fi
svc_user="${var_service_user:-${SERVICE_USER:-$svc_user}}"

log_info "Granting updater root privilege to service user: ${svc_user}"

fetch_helper() {
  local name="$1"
  local dest="${INSTALL_DIR}/install/${name}"
  local mode="${2:-755}"
  mkdir -p "$(dirname "$dest")"
  # Always refresh from GitHub when possible so LXC gets the latest fix
  if curl -fsSL "${RAW_BASE}/${name}" -o "${dest}.tmp" 2>/dev/null; then
    mv -f "${dest}.tmp" "$dest"
    log_ok "Refreshed ${name} from GitHub"
  elif [[ -d "${INSTALL_DIR}/.git" ]] && git -C "$INSTALL_DIR" show "origin/${REPO_BRANCH}:install/${name}" >"${dest}.tmp" 2>/dev/null; then
    mv -f "${dest}.tmp" "$dest"
    log_ok "Refreshed ${name} from origin/${REPO_BRANCH}"
  elif [[ -f "$dest" ]]; then
    log_info "Keeping existing ${name} (could not refresh)"
  else
    log_err "Missing ${name} and could not download it"
    return 1
  fi
  chmod "$mode" "$dest"
}

# Best-effort fetch of latest helpers
if [[ -d "${INSTALL_DIR}/.git" ]]; then
  git -C "$INSTALL_DIR" remote set-url origin "$REPO_URL" 2>/dev/null || true
  git -C "$INSTALL_DIR" fetch -q origin "$REPO_BRANCH" 2>/dev/null || true
fi

fetch_helper mt-billing-update.sh
fetch_helper mt-billing-self-update.sh
fetch_helper mt-billing-sudoers 644 || true
fetch_helper mt-billing-panel-update.service 644 || true

# Panel-triggered oneshot (runs update as root under systemd)
cat >"$PANEL_UPDATE_UNIT" <<EOF
[Unit]
Description=MT-Billing panel update (triggered from Application Updater UI)
Documentation=https://github.com/tsogs66/MT-Billing
After=network-online.target

[Service]
Type=oneshot
Nice=5
Environment=var_install_dir=${INSTALL_DIR}
Environment=var_repo_branch=${REPO_BRANCH}
Environment=INSTALL_DIR=${INSTALL_DIR}
Environment=REPO_BRANCH=${REPO_BRANCH}
Environment=MT_BILLING_AUTO_ONLY=0
ExecStart=/bin/bash ${UPDATE_SCRIPT}
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# Passwordless sudo from shared template (full privileges)
TEMPLATE="${INSTALL_DIR}/install/mt-billing-sudoers"
TMP_SUDOERS="$(mktemp)"
if [[ -f "$TEMPLATE" ]]; then
  sed -e "s|__SVC_USER__|${svc_user}|g" -e "s|__INSTALL_DIR__|${INSTALL_DIR}|g" \
    -e "s|^Defaults:mtbilling |Defaults:${svc_user} |g" \
    -e "s|^mtbilling ALL=|${svc_user} ALL=|g" \
    -e "s|/opt/mt-billing|${INSTALL_DIR}|g" \
    "$TEMPLATE" >"$TMP_SUDOERS"
else
  cat >"$TMP_SUDOERS" <<EOF
# MT-Billing — Application Updater root privilege
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
${svc_user} ALL=(root) NOPASSWD: /bin/bash ${UPDATE_SCRIPT}
${svc_user} ALL=(root) NOPASSWD: /usr/bin/bash ${UPDATE_SCRIPT}
${svc_user} ALL=(root) NOPASSWD: /bin/bash ${SELF_UPDATE_SCRIPT}
${svc_user} ALL=(root) NOPASSWD: /usr/bin/bash ${SELF_UPDATE_SCRIPT}
EOF
fi
install -m 440 "$TMP_SUDOERS" "$SUDOERS_FILE"
rm -f "$TMP_SUDOERS"

if command -v visudo >/dev/null 2>&1; then
  if ! visudo -cf "$SUDOERS_FILE" >/dev/null 2>&1; then
    log_err "sudoers validation failed — removing $SUDOERS_FILE"
    rm -f "$SUDOERS_FILE"
    exit 1
  fi
fi

# Also let the console SSH user (mtadmin) run the one-shot fix without a password.
# Flash images create mtadmin; without this, `curl … | sudo bash` asks for a password.
for console_user in mtadmin ubuntu debian pi; do
  if id "$console_user" >/dev/null 2>&1; then
    cat >"/etc/sudoers.d/mt-billing-${console_user}" <<EOF
Defaults:${console_user} !requiretty
${console_user} ALL=(root) NOPASSWD:ALL
EOF
    chmod 440 "/etc/sudoers.d/mt-billing-${console_user}"
    if command -v visudo >/dev/null 2>&1 && ! visudo -cf "/etc/sudoers.d/mt-billing-${console_user}" >/dev/null 2>&1; then
      rm -f "/etc/sudoers.d/mt-billing-${console_user}"
    else
      log_ok "Console user ${console_user}: passwordless sudo enabled"
    fi
  fi
done

systemctl daemon-reload
log_ok "Installed ${PANEL_UPDATE_UNIT}"
log_ok "Installed ${SUDOERS_FILE} for ${svc_user}"

# Verify passwordless sudo for the service user (same style the panel uses: sudo -n + full paths).
if id "$svc_user" >/dev/null 2>&1; then
  if sudo -u "$svc_user" sudo -n /bin/true 2>/dev/null \
    || sudo -u "$svc_user" sudo -n /usr/bin/true 2>/dev/null; then
    log_ok "Verified: ${svc_user} passwordless sudo works (sudo -n /bin/true)"
  else
    log_err "Passwordless sudo NOT working for ${svc_user} (got: sudo: a password is required)."
    log_err "Debug: sudo -u ${svc_user} sudo -n -l"
    log_err "File:  cat ${SUDOERS_FILE}"
    # Do not abort the whole grant — rules are installed; operator can inspect.
  fi
  if sudo -u "$svc_user" sudo -n -l 2>/dev/null | grep -q 'mt-billing-panel-update\|mt-billing-update'; then
    log_ok "Verified: ${svc_user} sudoers lists panel update commands"
  else
    log_info "Could not list sudo rules for ${svc_user} (may still work). Check: sudo -u ${svc_user} sudo -n -l"
  fi
fi

# Clear stuck "running" job marker so UI can retry
STATE_FILE="${INSTALL_DIR}/server/data/.last-update.json"
if [[ -f "$STATE_FILE" ]]; then
  if grep -q '"status":"running"' "$STATE_FILE" 2>/dev/null; then
    printf '{"status":"failed","branch":"%s","from":null,"to":null,"at":"%s","message":"Cleared after granting updater root privilege. Try Update from GitHub again."}\n' \
      "$REPO_BRANCH" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$STATE_FILE"
    log_ok "Cleared stuck updater job state"
  fi
fi

echo
log_ok "Updater root privilege granted"
echo "  Service user : ${svc_user}"
echo "  Oneshot unit : mt-billing-panel-update.service"
echo "  Sudoers      : ${SUDOERS_FILE}"
echo
echo "Next:"
echo "  1) Refresh the Application Updater page"
echo "  2) Click Update from GitHub"
echo "  Or pull now: sudo bash ${UPDATE_SCRIPT}"
echo "  Full workaround (grant + update): curl -fsSL https://raw.githubusercontent.com/tsogs66/MT-Billing/main/install/mt-billing-fix-now.sh | sudo bash"
echo
