#!/usr/bin/env bash
# Copyright (c) 2026 MT-Billing / Pa-North
# License: MIT
# Source: https://github.com/tsogs66/MT-Billing
#
# Guest install script — executed inside the LXC by community-scripts build.func
# Keep in sync with the embedded block in ct/mt-billing.sh (run scripts/sync-proxmox-embed.sh).

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

msg_info "Allowing panel UI to trigger updates (sudoers + oneshot)"
SVC_USER_FOR_SUDO="${SERVICE_USER:-mtbilling}"
cat >/etc/systemd/system/mt-billing-panel-update.service <<EOF
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
# Prefer shared template when present (keeps restart + tunnel privileges)
if [[ -f "${INSTALL_DIR}/install/mt-billing-sudoers" ]]; then
  sed -e "s|__SVC_USER__|${SVC_USER_FOR_SUDO}|g" -e "s|__INSTALL_DIR__|${INSTALL_DIR}|g" \
    -e "s|^Defaults:mtbilling |Defaults:${SVC_USER_FOR_SUDO} |g" \
    -e "s|^mtbilling ALL=|${SVC_USER_FOR_SUDO} ALL=|g" \
    -e "s|/opt/mt-billing|${INSTALL_DIR}|g" \
    "${INSTALL_DIR}/install/mt-billing-sudoers" >/etc/sudoers.d/mt-billing
else
  cat >/etc/sudoers.d/mt-billing <<EOF
Defaults:${SVC_USER_FOR_SUDO} !requiretty
${SVC_USER_FOR_SUDO} ALL=(root) NOPASSWD: /bin/true
${SVC_USER_FOR_SUDO} ALL=(root) NOPASSWD: /usr/bin/true
${SVC_USER_FOR_SUDO} ALL=(root) NOPASSWD: /bin/systemctl start mt-billing-panel-update.service
${SVC_USER_FOR_SUDO} ALL=(root) NOPASSWD: /bin/systemctl start --no-block mt-billing-panel-update.service
${SVC_USER_FOR_SUDO} ALL=(root) NOPASSWD: /usr/bin/systemctl start mt-billing-panel-update.service
${SVC_USER_FOR_SUDO} ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block mt-billing-panel-update.service
${SVC_USER_FOR_SUDO} ALL=(root) NOPASSWD: /bin/systemctl restart mt-billing-api.service
${SVC_USER_FOR_SUDO} ALL=(root) NOPASSWD: /bin/systemctl restart mt-billing-api
${SVC_USER_FOR_SUDO} ALL=(root) NOPASSWD: /usr/bin/systemctl restart mt-billing-api.service
${SVC_USER_FOR_SUDO} ALL=(root) NOPASSWD: /usr/bin/systemctl restart mt-billing-api
${SVC_USER_FOR_SUDO} ALL=(root) NOPASSWD: /bin/bash ${INSTALL_DIR}/install/mt-billing-update.sh
${SVC_USER_FOR_SUDO} ALL=(root) NOPASSWD: /usr/bin/bash ${INSTALL_DIR}/install/mt-billing-update.sh
${SVC_USER_FOR_SUDO} ALL=(root) NOPASSWD: /bin/bash ${INSTALL_DIR}/install/mt-billing-self-update.sh
${SVC_USER_FOR_SUDO} ALL=(root) NOPASSWD: /usr/bin/bash ${INSTALL_DIR}/install/mt-billing-self-update.sh
EOF
fi
chmod 440 /etc/sudoers.d/mt-billing
if command -v visudo >/dev/null 2>&1; then
  visudo -cf /etc/sudoers.d/mt-billing >/dev/null || msg_error "sudoers validation failed"
fi
$STD systemctl daemon-reload
msg_ok "Panel updater privileges ready"

msg_info "Configuring nginx (port ${PANEL_PORT})"
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
