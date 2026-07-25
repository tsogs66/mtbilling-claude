#!/usr/bin/env bash
# Copyright (c) 2026 MT-Billing / ts0gs
# License: MIT
# Source: https://github.com/tsogs66/MT-Billing
#
# Guest reinstall script — run inside the MT-Billing LXC/VM (or via Proxmox pct exec).
# Use after a large GitHub update when a normal pull/build is not enough: wipes the
# app tree, reclones the branch, rebuilds, and optionally resets the SQLite DB to
# factory defaults (seeded admin + empty operational data).
#
# Usage (inside the LXC):
#   sudo bash /opt/mt-billing/install/mt-billing-reinstall.sh --yes
#   sudo bash install/mt-billing-reinstall.sh --yes --reset-db
#   sudo bash install/mt-billing-reinstall.sh --yes --keep-db
#
# Proxmox host:
#   sudo bash scripts/proxmox-reinstall.sh
#   CTID=101 sudo bash scripts/proxmox-reinstall.sh --reset-db
#
# Options:
#   --yes / -y       skip confirmation prompt
#   --reset-db       wipe SQLite and re-seed defaults (default for "to default")
#   --keep-db        preserve server/data/*.db* across reinstall
#   --keep-env       preserve server/.env (JWT + admin credentials)
#   --no-backup      skip tarball backup under /var/backups/mt-billing/
#   --branch NAME    git branch to clone (default: main)
#
# Environment:
#   var_install_dir / INSTALL_DIR   default /opt/mt-billing
#   var_repo_url    / REPO_URL      default https://github.com/tsogs66/MT-Billing.git
#   var_repo_branch / REPO_BRANCH   default main
#   var_service_user / SERVICE_USER default mtbilling
#   var_api_port / API_PORT         default 4000
#   var_panel_port / PANEL_PORT     default 80
#   var_admin_user / ADMIN_USER     default admin (only when regenerating .env)
#   var_admin_pass / ADMIN_PASS     default admin123
#   var_auto_update                 default 1 (re-enable auto-update timer)

set -euo pipefail

INSTALL_DIR="${var_install_dir:-${INSTALL_DIR:-/opt/mt-billing}}"
REPO_URL="${var_repo_url:-${REPO_URL:-https://github.com/tsogs66/MT-Billing.git}}"
REPO_BRANCH="${var_repo_branch:-${REPO_BRANCH:-main}}"
SERVICE_USER="${var_service_user:-${SERVICE_USER:-mtbilling}}"
API_PORT="${var_api_port:-${API_PORT:-4000}}"
PANEL_PORT="${var_panel_port:-${PANEL_PORT:-80}}"
ADMIN_USER="${var_admin_user:-${ADMIN_USER:-admin}}"
ADMIN_PASS="${var_admin_pass:-${ADMIN_PASS:-admin123}}"
AUTO_UPDATE="${var_auto_update:-1}"

ASSUME_YES=0
RESET_DB=1
KEEP_ENV=1
DO_BACKUP=1

for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    --reset-db) RESET_DB=1 ;;
    --keep-db) RESET_DB=0 ;;
    --keep-env) KEEP_ENV=1 ;;
    --fresh-env) KEEP_ENV=0 ;;
    --no-backup) DO_BACKUP=0 ;;
    --branch)
      # handled below with shift-style parse
      ;;
    -h|--help)
      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
  esac
done

# Allow --branch <name>
prev=""
for arg in "$@"; do
  if [[ "$prev" == "--branch" ]]; then
    REPO_BRANCH="$arg"
  fi
  prev="$arg"
done

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

if [[ "$(id -u)" -ne 0 ]]; then
  log_err "Run as root (e.g. sudo bash $0 --yes)"
  exit 1
fi

SERVICE_UNIT="/etc/systemd/system/mt-billing-api.service"
DATA_DIR="${INSTALL_DIR}/server/data"
ENV_FILE="${INSTALL_DIR}/server/.env"
BACKUP_ROOT="/var/backups/mt-billing"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
STAGING="/tmp/mt-billing-reinstall-${STAMP}"

if [[ -f "$SERVICE_UNIT" ]]; then
  detected="$(grep '^User=' "$SERVICE_UNIT" | cut -d= -f2 || true)"
  [[ -n "$detected" ]] && SERVICE_USER="$detected"
fi

echo
echo "MT-Billing reinstall (big-update / factory reset)"
echo "  Install dir : ${INSTALL_DIR}"
echo "  Repo        : ${REPO_URL} (${REPO_BRANCH})"
echo "  Service user: ${SERVICE_USER}"
echo "  Database    : $([[ "$RESET_DB" == "1" ]] && echo 'RESET to defaults' || echo 'KEEP existing')"
echo "  .env        : $([[ "$KEEP_ENV" == "1" ]] && echo 'KEEP' || echo 'REGENERATE')"
echo "  Backup      : $([[ "$DO_BACKUP" == "1" ]] && echo "yes → ${BACKUP_ROOT}" || echo 'no')"
echo

if [[ "$ASSUME_YES" != "1" ]]; then
  read -r -p "This replaces the app under ${INSTALL_DIR}. Continue? [y/N] " ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

mkdir -p "$STAGING" "$BACKUP_ROOT"

# ---- Stop services ----
log_info "Stopping MT-Billing services"
systemctl stop mt-billing-api 2>/dev/null || true
systemctl stop mt-billing-auto-update.timer 2>/dev/null || true
log_ok "Services stopped"

# ---- Backup ----
if [[ "$DO_BACKUP" == "1" ]]; then
  log_info "Backing up data and config"
  BACKUP_TAR="${BACKUP_ROOT}/pre-reinstall-${STAMP}.tar.gz"
  BACKUP_STAGE="${STAGING}/backup-pack"
  mkdir -p "${BACKUP_STAGE}/server"
  [[ -d "$DATA_DIR" ]] && cp -a "$DATA_DIR" "${BACKUP_STAGE}/server/data" || true
  [[ -f "$ENV_FILE" ]] && cp -a "$ENV_FILE" "${BACKUP_STAGE}/server/.env" || true
  if [[ -d "${BACKUP_STAGE}/server/data" || -f "${BACKUP_STAGE}/server/.env" ]]; then
    tar -czf "$BACKUP_TAR" -C "$BACKUP_STAGE" .
    log_ok "Backup saved: ${BACKUP_TAR}"
  else
    log_info "No existing data to backup (fresh or empty install)"
  fi
fi

# ---- Stash keepers ----
if [[ "$KEEP_ENV" == "1" && -f "$ENV_FILE" ]]; then
  cp -a "$ENV_FILE" "${STAGING}/.env"
  log_ok "Stashed server/.env"
fi
if [[ "$RESET_DB" != "1" && -d "$DATA_DIR" ]]; then
  mkdir -p "${STAGING}/data"
  cp -a "$DATA_DIR"/. "${STAGING}/data/" 2>/dev/null || true
  log_ok "Stashed SQLite database"
fi

# ---- Wipe + fresh clone ----
log_info "Removing old install at ${INSTALL_DIR}"
rm -rf "$INSTALL_DIR"
mkdir -p "$(dirname "$INSTALL_DIR")"

log_info "Cloning ${REPO_URL} (${REPO_BRANCH})"
run git clone --branch "$REPO_BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
log_ok "Cloned $(git -C "$INSTALL_DIR" rev-parse --short HEAD)"

# ---- Restore keepers ----
mkdir -p "$DATA_DIR"
if [[ "$KEEP_ENV" == "1" && -f "${STAGING}/.env" ]]; then
  cp -a "${STAGING}/.env" "$ENV_FILE"
  log_ok "Restored server/.env"
else
  log_info "Writing fresh server/.env"
  JWT_SECRET="${var_jwt_secret:-}"
  if [[ -z "$JWT_SECRET" ]]; then
    JWT_SECRET="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 64)"
  fi
  cat >"$ENV_FILE" <<EOF
PORT=${API_PORT}
JWT_SECRET=${JWT_SECRET}
ADMIN_USER=${ADMIN_USER}
ADMIN_PASS=${ADMIN_PASS}
EOF
  chmod 600 "$ENV_FILE"
  log_ok "Wrote server/.env (login ${ADMIN_USER} / ${ADMIN_PASS})"
fi

if [[ "$RESET_DB" != "1" && -d "${STAGING}/data" ]]; then
  cp -a "${STAGING}/data"/. "$DATA_DIR/"
  log_ok "Restored SQLite database"
else
  # Ensure empty data dir so the API seeds defaults on first boot
  rm -f "$DATA_DIR"/*.db "$DATA_DIR"/*.db-* 2>/dev/null || true
  log_ok "Database will be re-seeded to defaults on first start"
fi

# ---- Service user ----
if ! id "$SERVICE_USER" &>/dev/null; then
  log_info "Creating service user ${SERVICE_USER}"
  useradd --system --home "$INSTALL_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
chown -R "${SERVICE_USER}:${SERVICE_USER}" "$INSTALL_DIR"

# ---- Build ----
if declare -F setup_nodejs &>/dev/null; then
  NODE_VERSION="22" setup_nodejs
elif ! command -v node >/dev/null 2>&1; then
  log_err "Node.js is required. Install Node 22+ then re-run."
  exit 1
fi

log_info "Installing dependencies and building"
run sudo -u "$SERVICE_USER" bash -c "cd '$INSTALL_DIR' && npm install && npm run build && npm --prefix server run build"
log_ok "Build complete"

# ---- systemd unit ----
log_info "Writing systemd service"
cat >"$SERVICE_UNIT" <<EOF
[Unit]
Description=MT-Billing API (MikroTik billing panel)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}/server
EnvironmentFile=${INSTALL_DIR}/server/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable mt-billing-api
log_ok "systemd unit ready"

# ---- nginx ----
if command -v nginx >/dev/null 2>&1; then
  log_info "Refreshing nginx site config"
  cat >/etc/nginx/sites-available/mt-billing <<EOF
server {
    listen ${PANEL_PORT};
    listen [::]:${PANEL_PORT};
    server_name _;
    client_max_body_size 100m;

    root ${INSTALL_DIR}/client/dist;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:${API_PORT}/api/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }

    # Pay SPA — avoid 403 when dist/pay/ exists as a static directory
    location = /pay {
        try_files /index.html =404;
    }
    location ^~ /pay/ {
        try_files \$uri /index.html;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
EOF
  ln -sf /etc/nginx/sites-available/mt-billing /etc/nginx/sites-enabled/mt-billing
  rm -f /etc/nginx/sites-enabled/default
  nginx -t
  systemctl enable nginx
  systemctl reload nginx
  log_ok "nginx refreshed"
fi

# ---- Auto-update timer ----
chmod +x "$INSTALL_DIR/install/mt-billing-update.sh" "$INSTALL_DIR/install/mt-billing-reinstall.sh" 2>/dev/null || true
if [[ "$AUTO_UPDATE" == "1" && -f "$INSTALL_DIR/install/mt-billing-auto-update.timer" ]]; then
  log_info "Re-enabling auto-update timer"
  sed "s|var_repo_branch=main|var_repo_branch=${REPO_BRANCH}|g" \
    "$INSTALL_DIR/install/mt-billing-auto-update.service" \
    >/etc/systemd/system/mt-billing-auto-update.service
  install -m 644 "$INSTALL_DIR/install/mt-billing-auto-update.timer" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now mt-billing-auto-update.timer
  log_ok "Auto-update enabled"
fi

# ---- Start ----
log_info "Starting MT-Billing API"
systemctl restart mt-billing-api
sleep 2
if systemctl is-active --quiet mt-billing-api; then
  log_ok "mt-billing-api is running"
else
  log_err "mt-billing-api failed to start — check: journalctl -u mt-billing-api -n 50"
  exit 1
fi

# Cleanup staging
rm -rf "$STAGING"

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
log_ok "Reinstall complete ($(git -C "$INSTALL_DIR" rev-parse --short HEAD) on ${REPO_BRANCH})"
echo "  Panel : http://${IP:-<container-ip>}"
if [[ "$RESET_DB" == "1" ]]; then
  # Prefer credentials from restored/generated .env
  u="$(grep -E '^ADMIN_USER=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || echo "$ADMIN_USER")"
  echo "  Login : ${u} / (see server/.env ADMIN_PASS — default admin123 if freshly generated)"
  echo "  Note  : SQLite was reset; routers/clients must be re-added."
fi
if [[ "$DO_BACKUP" == "1" ]]; then
  echo "  Backup: ${BACKUP_ROOT}/pre-reinstall-${STAMP}.tar.gz"
fi
echo
