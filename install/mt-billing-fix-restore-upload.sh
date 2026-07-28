#!/usr/bin/env bash
# Copyright (c) 2026 MT-Billing / ts0gs
# License: MIT
# Source: https://github.com/tsogs66/MT-Billing
#
# Diagnose/fix "Database restore" uploads that get stuck partway (e.g.
# stuck at 1%) or fail with "Upload rejected (file too large)". Both are
# caused by the reverse-proxy/API upload limit being smaller than the
# backup file — this script reports the checked-out commit (so you can
# tell whether the panel actually has the raw-upload fix), forces nginx's
# client_max_body_size to 300m, and restarts the API so the fix (if
# already pulled) is actually running rather than a stale process.
#
# On the LXC/VM (as root):
#   curl -fsSL https://raw.githubusercontent.com/tsogs66/MT-Billing/main/install/mt-billing-fix-restore-upload.sh | sudo bash
#
# Or locally:
#   sudo bash /opt/mt-billing/install/mt-billing-fix-restore-upload.sh

set -euo pipefail

INSTALL_DIR="${var_install_dir:-${INSTALL_DIR:-/opt/mt-billing}}"
NGINX_SITE="/etc/nginx/sites-available/mt-billing"

log_info() { printf '\033[1;34m[INFO]\033[0m %s\n' "$*"; }
log_ok() { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
log_err() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; }

if [[ "$(id -u)" -ne 0 ]]; then
  log_err "Run this as root (sudo bash ...) or inside the LXC as root (pct enter <CTID>)."
  exit 1
fi

if [[ ! -d "$INSTALL_DIR" ]]; then
  log_err "Install dir not found: $INSTALL_DIR (set INSTALL_DIR=/path/to/mt-billing if it's not /opt/mt-billing)"
  exit 1
fi

log_info "Checked-out commit:"
git -C "$INSTALL_DIR" log -1 --oneline 2>/dev/null || log_err "  (not a git checkout — can't confirm the fix is pulled)"

if [[ -f "$NGINX_SITE" ]]; then
  CURRENT=$(grep -o 'client_max_body_size[[:space:]]*[0-9]*m' "$NGINX_SITE" | head -1 || true)
  log_info "nginx client_max_body_size: ${CURRENT:-not set}"
  if grep -q 'client_max_body_size' "$NGINX_SITE"; then
    sed -i 's/client_max_body_size[[:space:]]*[0-9]*m;/client_max_body_size 300m;/g' "$NGINX_SITE"
  else
    sed -i 's/server {/server {\n    client_max_body_size 300m;/' "$NGINX_SITE"
  fi
  if nginx -t; then
    systemctl reload nginx
    log_ok "nginx client_max_body_size set to 300m and reloaded"
  else
    log_err "nginx config test failed after edit — check $NGINX_SITE manually"
    exit 1
  fi
else
  log_err "nginx site file not found at $NGINX_SITE"
  log_err "If you're behind a different reverse proxy (Cloudflare Tunnel, Caddy, ...), raise its upload size limit to 300m manually."
fi

log_info "Restarting mt-billing-api"
systemctl restart mt-billing-api
log_ok "mt-billing-api restarted"

echo
log_info "If 'git log -1' above doesn't mention the DB restore upload fix, pull it first:"
log_info "  sudo bash ${INSTALL_DIR}/install/mt-billing-update.sh"
log_info "If the panel error text still says '100m' after that, your browser is showing a cached old bundle:"
log_info "  hard-refresh the tab (Ctrl/Cmd+Shift+R) before retrying the restore."
