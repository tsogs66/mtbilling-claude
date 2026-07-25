#!/usr/bin/env bash
# Copyright (c) 2026 MT-Billing / Pa-North
# License: MIT
# Source: https://github.com/tsogs66/MT-Billing
#
# Proxmox VE helper — creates an Ubuntu LXC and installs MT-Billing.
#
# System requirements (host):
#   Proxmox VE 7.4+ (8.x recommended), root shell, ≥32 GB free storage,
#   network bridge, outbound internet. Defaults: 2 vCPU / 4096 MB / 32 GB /
#   Ubuntu 24.04. Full table: SYSTEM_REQUIREMENTS.md
#
# One-liner (Proxmox host, root) — requires a PUBLIC repo on main:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/tsogs66/MT-Billing/main/ct/mt-billing.sh)"
#
# Unattended:
#   mode=default bash -c "$(curl -fsSL https://raw.githubusercontent.com/tsogs66/MT-Billing/main/ct/mt-billing.sh)"
#
# Private repo or local copy:
#   git clone https://github.com/tsogs66/MT-Billing.git && cd MT-Billing && sudo bash ct/mt-billing.sh
#   # or: sudo bash scripts/proxmox-install.sh

set -eo pipefail

MT_BILLING_RAW_URL="${MT_BILLING_RAW_URL:-https://raw.githubusercontent.com/tsogs66/MT-Billing/main/ct/mt-billing.sh}"

# bash -c "$(curl ...)" has no real file path — save to a temp copy for embedded-install extraction.
resolve_script_path() {
  local src="${BASH_SOURCE[0]:-}"
  if [[ -n "$src" && -f "$src" ]]; then
    while [[ -L "$src" ]]; do
      src="$(readlink -f "$src")"
    done
    printf '%s' "$src"
    return
  fi
  local tmp
  tmp="$(mktemp /tmp/mt-billing-ct.XXXXXX.sh)"
  curl -fsSL "$MT_BILLING_RAW_URL" -o "$tmp"
  chmod 755 "$tmp"
  printf '%s' "$tmp"
}

SCRIPT_PATH="$(resolve_script_path)"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"

# Do not enable `set -u` in this script — optional env defaults are set above instead.

# Embed guest install script so build.func never curls GitHub for install/*.sh
extract_install_script() {
  local dest="/usr/local/share/mt-billing/mt-billing-install.sh"
  mkdir -p "$(dirname "$dest")"
  awk '/^# @@INSTALL_BEGIN@@$/{flag=1;next}/^# @@INSTALL_END@@$/{flag=0}flag' "$SCRIPT_PATH" >"$dest"
  chmod 755 "$dest"
  printf '%s' "$dest"
}

INSTALL_CACHE="$(extract_install_script)"

# community-scripts core.func ssh_check() reads $SSH_CLIENT; catch_errors may enable
# set -u (STRICT_UNSET=1). On the Proxmox local console SSH_CLIENT is unset → crash.
: "${SSH_CLIENT:=}"
: "${SSH_CONNECTION:=}"

# Patch community-scripts build.func: route install fetch to embedded script
BUILD_FUNC="$(
  curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/misc/build.func | \
    sed "s|_install_script=\"\$(curl -fsSL \"https://raw.githubusercontent.com/[^\"]*/install/\${var_install}\\.sh\")\"|_install_script=\"\$(cat '${INSTALL_CACHE}')\"|g"
)"

source <(echo "$BUILD_FUNC")

APP="MT-Billing"
var_tags="${var_tags:-billing;network;mikrotik}"
var_cpu="${var_cpu:-2}"
var_ram="${var_ram:-4096}"
var_disk="${var_disk:-32}"
var_os="${var_os:-ubuntu}"
var_version="${var_version:-24}"
var_arm64="${var_arm64:-yes}"
var_unprivileged="${var_unprivileged:-1}"
var_nesting="${var_nesting:-0}"

export var_repo_url="${var_repo_url:-https://github.com/tsogs66/MT-Billing.git}"
export var_repo_branch="${var_repo_branch:-main}"
export var_install_dir="${var_install_dir:-/opt/mt-billing}"
export var_admin_user="${var_admin_user:-admin}"
export var_admin_pass="${var_admin_pass:-admin123}"
export var_api_port="${var_api_port:-4000}"
export var_panel_port="${var_panel_port:-80}"

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info
  check_container_storage
  check_container_resources

  local dir="${var_install_dir:-/opt/mt-billing}"
  local updater="$dir/install/mt-billing-update.sh"
  if [[ -f "$updater" ]]; then
    msg_info "Running MT-Billing update script"
    MT_BILLING_AUTO_ONLY=0 bash "$updater"
    msg_ok "Updated successfully!"
    exit
  fi

  if [[ ! -f /etc/systemd/system/mt-billing-api.service ]]; then
    msg_error "No ${APP} installation found!"
    exit 1
  fi

  msg_info "Stopping MT-Billing API"
  systemctl stop mt-billing-api
  msg_ok "Stopped MT-Billing API"

  NODE_VERSION="22" setup_nodejs

  local branch="${var_repo_branch:-main}"
  msg_info "Updating application from ${var_repo_url} (${branch})"
  if [[ -d "$dir/.git" ]]; then
    git -C "$dir" fetch origin
    git -C "$dir" checkout "$branch"
    $STD git -C "$dir" pull --ff-only origin "$branch" || true
  else
    $STD git clone --branch "$branch" --depth 1 "${var_repo_url}" "$dir"
  fi

  local svc_user
  svc_user="$(grep '^User=' /etc/systemd/system/mt-billing-api.service | cut -d= -f2)"
  svc_user="${svc_user:-mtbilling}"

  msg_info "Building application"
  $STD sudo -u "$svc_user" bash -c "cd '$dir' && npm install && npm run build && npm --prefix server run build"
  msg_ok "Built application"

  msg_info "Starting services"
  systemctl start mt-billing-api
  systemctl reload nginx 2>/dev/null || true
  msg_ok "Started services"
  msg_ok "Updated successfully!"
  exit
}

description() {
  IP=$(pct exec "$CTID" ip a s dev eth0 2>/dev/null | awk '/inet / {print $2}' | cut -d/ -f1 | head -1)
  DESCRIPTION=$(
    cat <<EOF
<div align='center'>
  <a href='https://github.com/tsogs66/MT-Billing' target='_blank'>
    <img src='https://img.shields.io/badge/GitHub-MT--Billing-blue?style=for-the-badge&logo=github&logoColor=white' alt='GitHub'/>
  </a>
</div>
<div align='center'>${APP} — MikroTik billing &amp; PPPoE/IPoE panel (Pa-North)</div>
EOF
  )
  pct set "$CTID" -description "$DESCRIPTION" >/dev/null 2>&1 || true

  if [[ -f /etc/systemd/system/ping-instances.service ]]; then
    systemctl start ping-instances.service 2>/dev/null || true
  fi

  msg_ok "Completed successfully!\n"
  echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
  echo -e "${INFO}${YW}Access the panel:${CL}"
  echo -e "${TAB}${GATEWAY}${BGN}http://${IP:-<container-ip>}${CL}"
  echo -e "${INFO}${YW}Default login: ${var_admin_user:-admin} / ${var_admin_pass:-admin123} — change immediately${CL}"
  echo -e "${INFO}${YW}Service: systemctl status mt-billing-api${CL}"
}

start
build_container
description

exit 0

# @@INSTALL_BEGIN@@
# @@INSTALL_BEGIN@@
source /dev/stdin <<<"$FUNCTIONS_FILE_PATH"
color
verb_ip6
catch_errors
setting_up_container
network_check
update_os

INSTALL_DIR="${var_install_dir:-/opt/mt-billing}"
REPO_URL="${var_repo_url:-https://github.com/tsogs66/MT-Billing.git}"
REPO_BRANCH="${var_repo_branch:-main}"
SERVICE_USER="${var_service_user:-mtbilling}"
API_PORT="${var_api_port:-4000}"
PANEL_PORT="${var_panel_port:-80}"
ADMIN_USER="${var_admin_user:-admin}"
ADMIN_PASS="${var_admin_pass:-admin123}"

msg_info "Installing Dependencies"
$STD apt-get install -y \
  curl \
  git \
  ca-certificates \
  openssl \
  build-essential \
  python3 \
  libsqlite3-dev \
  nginx
msg_ok "Installed Dependencies"

NODE_VERSION="22" setup_nodejs

if ! id "$SERVICE_USER" &>/dev/null; then
  msg_info "Creating service user ${SERVICE_USER}"
  $STD useradd --system --home "$INSTALL_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
  msg_ok "Created service user"
fi

msg_info "Cloning MT-Billing (${REPO_BRANCH})"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  $STD git -C "$INSTALL_DIR" fetch origin
  $STD git -C "$INSTALL_DIR" checkout "$REPO_BRANCH"
  $STD git -C "$INSTALL_DIR" pull --ff-only origin "$REPO_BRANCH" || true
else
  $STD mkdir -p "$(dirname "$INSTALL_DIR")"
  $STD git clone --branch "$REPO_BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
msg_ok "Cloned MT-Billing"

msg_info "Building application (npm install + production build)"
$STD chown -R "${SERVICE_USER}:${SERVICE_USER}" "$INSTALL_DIR"
$STD sudo -u "$SERVICE_USER" bash -c "cd '$INSTALL_DIR' && npm install && npm run build && npm --prefix server run build"
msg_ok "Built application"

msg_info "Writing server environment"
JWT_SECRET="${var_jwt_secret:-}"
if [[ -z "$JWT_SECRET" ]]; then
  JWT_SECRET="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 64)"
fi
$STD mkdir -p "$INSTALL_DIR/server/data"
cat >"$INSTALL_DIR/server/.env" <<EOF
PORT=${API_PORT}
JWT_SECRET=${JWT_SECRET}
ADMIN_USER=${ADMIN_USER}
ADMIN_PASS=${ADMIN_PASS}
EOF
$STD chmod 600 "$INSTALL_DIR/server/.env"
$STD chown "${SERVICE_USER}:${SERVICE_USER}" "$INSTALL_DIR/server/.env" "$INSTALL_DIR/server/data"
msg_ok "Wrote server environment"

msg_info "Creating systemd service (mt-billing-api)"
cat >/etc/systemd/system/mt-billing-api.service <<EOF
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
$STD systemctl daemon-reload
$STD systemctl enable mt-billing-api
$STD systemctl restart mt-billing-api
msg_ok "Created systemd service"

msg_info "Configuring nginx (port ${PANEL_PORT})"
cat >/etc/nginx/sites-available/mt-billing <<EOF
server {
    listen ${PANEL_PORT};
    listen [::]:${PANEL_PORT};
    server_name _;

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

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
EOF
$STD ln -sf /etc/nginx/sites-available/mt-billing /etc/nginx/sites-enabled/mt-billing
$STD rm -f /etc/nginx/sites-enabled/default
$STD nginx -t
$STD systemctl enable nginx
$STD systemctl reload nginx
msg_ok "Configured nginx"

msg_info "Installing update scripts"
$STD chmod +x "$INSTALL_DIR/install/mt-billing-update.sh"
$STD chmod +x "$INSTALL_DIR/install/mt-billing-reinstall.sh" 2>/dev/null || true
msg_ok "Update script ready at install/mt-billing-update.sh"

AUTO_UPDATE="${var_auto_update:-1}"
if [[ "$AUTO_UPDATE" == "1" ]]; then
  msg_info "Enabling auto-update timer (checks GitHub every 10 minutes)"
  sed "s|var_repo_branch=main|var_repo_branch=${REPO_BRANCH}|g" \
    "$INSTALL_DIR/install/mt-billing-auto-update.service" \
    >/etc/systemd/system/mt-billing-auto-update.service
  $STD install -m 644 "$INSTALL_DIR/install/mt-billing-auto-update.timer" /etc/systemd/system/
  $STD systemctl daemon-reload
  $STD systemctl enable --now mt-billing-auto-update.timer
  msg_ok "Auto-update enabled (systemctl status mt-billing-auto-update.timer)"
else
  msg_info "Auto-update disabled (set var_auto_update=1 to enable)"
fi

motd_ssh
customize
cleanup_lxc
# @@INSTALL_END@@
