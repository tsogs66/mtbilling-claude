#!/usr/bin/env bash
# Copyright (c) 2026 MT-Billing / ts0gs
# License: MIT
# Source: https://github.com/tsogs66/MT-Billing
#
# One-shot workaround: grant updater root privilege AND pull/build/restart now.
# Use this when the panel "Update from GitHub" button still fails.
#
# On the LXC/VM (as root):
#   curl -fsSL https://raw.githubusercontent.com/tsogs66/MT-Billing/main/install/mt-billing-fix-now.sh | sudo bash
#
# Or locally:
#   sudo bash /opt/mt-billing/install/mt-billing-fix-now.sh

set -euo pipefail

INSTALL_DIR="${var_install_dir:-${INSTALL_DIR:-/opt/mt-billing}}"
REPO_BRANCH="${var_repo_branch:-${REPO_BRANCH:-main}}"
REPO_URL="${var_repo_url:-${REPO_URL:-https://github.com/tsogs66/MT-Billing.git}}"
RAW_BASE="https://raw.githubusercontent.com/tsogs66/MT-Billing/${REPO_BRANCH}/install"

log_info() { printf '\033[1;34m[INFO]\033[0m %s\n' "$*"; }
log_ok() { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
log_err() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; }

if [[ "$(id -u)" -ne 0 ]]; then
  log_err "A password was required / not root."
  log_err "Use one of these (no panel password — you must already be root or have sudo):"
  log_err "  Pi SSH:     sudo -i   # password is mtbilling if prompted, then re-run the curl|bash"
  log_err "  Proxmox:    pct enter <CTID>   # already root inside — run curl|bash without sudo"
  log_err "  Or:         curl -fsSL ${RAW_BASE}/mt-billing-fix-now.sh | sudo -n bash"
  exit 1
fi

mkdir -p "${INSTALL_DIR}/install"

fetch() {
  local name="$1"
  local dest="${INSTALL_DIR}/install/${name}"
  log_info "Fetching ${name}"
  curl -fsSL "${RAW_BASE}/${name}" -o "${dest}.tmp"
  mv -f "${dest}.tmp" "${dest}"
  chmod 755 "${dest}"
}

# Prefer scripts already on disk; refresh from GitHub so we get the latest grant/update logic.
if [[ -d "${INSTALL_DIR}/.git" ]]; then
  log_info "Refreshing install helpers from origin/${REPO_BRANCH}"
  git -C "$INSTALL_DIR" remote set-url origin "$REPO_URL" 2>/dev/null || true
  git -C "$INSTALL_DIR" fetch -q origin "$REPO_BRANCH" 2>/dev/null || true
  for name in mt-billing-grant-updater-root.sh mt-billing-update.sh mt-billing-self-update.sh mt-billing-sudoers mt-billing-panel-update.service; do
    if git -C "$INSTALL_DIR" show "origin/${REPO_BRANCH}:install/${name}" >/dev/null 2>&1; then
      git -C "$INSTALL_DIR" show "origin/${REPO_BRANCH}:install/${name}" \
        >"${INSTALL_DIR}/install/${name}"
      if [[ "$name" == *.sh ]]; then
        chmod 755 "${INSTALL_DIR}/install/${name}"
      else
        chmod 644 "${INSTALL_DIR}/install/${name}"
      fi
    else
      fetch "$name" || true
    fi
  done
else
  fetch mt-billing-grant-updater-root.sh
  fetch mt-billing-update.sh
  fetch mt-billing-self-update.sh || true
  fetch mt-billing-sudoers || true
fi

export var_install_dir="$INSTALL_DIR"
export var_repo_branch="$REPO_BRANCH"
export var_repo_url="$REPO_URL"
export INSTALL_DIR REPO_BRANCH REPO_URL

log_info "Step 1/2 — grant panel updater root privilege"
bash "${INSTALL_DIR}/install/mt-billing-grant-updater-root.sh"

log_info "Step 2/2 — pull, build, restart"
bash "${INSTALL_DIR}/install/mt-billing-update.sh"

log_ok "Done. Open the panel Updater page — it should show the new commit."
echo
echo "If the UI still looks old, hard-refresh the browser (Ctrl+Shift+R)."
echo
