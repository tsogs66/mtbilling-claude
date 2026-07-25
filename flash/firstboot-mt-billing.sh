#!/usr/bin/env bash
# Copyright (c) 2026 MT-Billing / Pa-North
# License: MIT
# Source: https://github.com/tsogs66/MT-Billing
#
# First-boot installer for Raspberry Pi / Orange Pi / PC flash images.
# Runs once via systemd, installs Node.js + MT-Billing, configures nginx.

set -euo pipefail

INSTALL_DIR="${MT_INSTALL_DIR:-/opt/mt-billing}"
REPO_URL="${MT_REPO_URL:-https://github.com/tsogs66/MT-Billing.git}"
REPO_BRANCH="${MT_REPO_BRANCH:-main}"
SERVICE_USER="${MT_SERVICE_USER:-mtbilling}"
API_PORT="${MT_API_PORT:-4000}"
PANEL_PORT="${MT_PANEL_PORT:-80}"
ADMIN_USER="${MT_ADMIN_USER:-admin}"
ADMIN_PASS="${MT_ADMIN_PASS:-admin123}"
LOG="${MT_FIRSTBOOT_LOG:-/var/log/mt-billing-firstboot.log}"

exec > >(tee -a "$LOG") 2>&1
echo "==== MT-Billing first-boot $(date -Is) ===="
echo "Arch: $(uname -m)  Kernel: $(uname -r)"

export DEBIAN_FRONTEND=noninteractive

detect_board() {
  local model="" arch
  arch="$(uname -m)"
  [[ -f /proc/device-tree/model ]] && model="$(tr -d '\0' </proc/device-tree/model)"
  if [[ -f /etc/mt-billing-image.json ]]; then
    echo "Image marker: $(cat /etc/mt-billing-image.json)"
  fi
  echo "Board model: ${model:-unknown} (${arch})"
  if echo "$model" | grep -qiE 'raspberry|bcm27|bcm28'; then
    echo "Detected: Raspberry Pi"
  elif echo "$model" | grep -qiE 'orange.?pi.?one|sun8i|h3'; then
    echo "Detected: Orange Pi One (H3)"
  elif echo "$model" | grep -qiE 'orange|sun|rockchip|xunlong'; then
    echo "Detected: Orange Pi / Armbian SBC"
  elif [[ "$arch" == "x86_64" || "$arch" == "amd64" ]]; then
    echo "Detected: PC / x86_64"
  else
    echo "Detected: generic Linux host"
  fi
}

ensure_swap_if_low_ram() {
  # Pi 3 / Orange Pi One (≤2 GB) OOMs during Vite/tsc without swap.
  local mem_kb
  mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)"
  if [[ "${mem_kb:-0}" -ge 1900000 ]]; then
    return 0
  fi
  if swapon --show 2>/dev/null | grep -q .; then
    echo "Low RAM (${mem_kb} kB); swap already active."
    return 0
  fi
  echo "Low RAM (${mem_kb} kB); creating 2G swapfile…"
  if [[ ! -f /swapfile ]]; then
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile || true
  grep -q '^/swapfile' /etc/fstab 2>/dev/null || echo '/swapfile none swap sw 0 0' >>/etc/fstab
}

install_nodejs() {
  local major arch
  if command -v node >/dev/null 2>&1; then
    major="$(node -v 2>/dev/null | tr -d v | cut -d. -f1 || echo 0)"
    if [[ "${major:-0}" -ge 20 ]]; then
      echo "[2/7] Node.js already present: $(node -v)"
      return 0
    fi
  fi

  arch="$(dpkg --print-architecture 2>/dev/null || uname -m)"
  echo "[2/7] Installing Node.js (arch=${arch})…"

  # Prefer distro packages on armhf (NodeSource armhf support is unreliable).
  if [[ "$arch" == "armhf" || "$arch" == "armel" || "$arch" == "armv7l" ]]; then
    apt-get install -y nodejs npm || true
    major="$(node -v 2>/dev/null | tr -d v | cut -d. -f1 || echo 0)"
    if [[ "${major:-0}" -ge 20 ]]; then
      echo "Using distro Node.js: $(node -v)"
      return 0
    fi
    echo "Distro Node.js too old or missing; trying NodeSource 20.x…"
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - || true
    apt-get install -y nodejs || true
  else
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi

  major="$(node -v 2>/dev/null | tr -d v | cut -d. -f1 || echo 0)"
  if [[ "${major:-0}" -lt 20 ]]; then
    echo "ERROR: Node.js 20+ is required (found: $(node -v 2>/dev/null || echo none))" >&2
    exit 1
  fi
  echo "Node.js ready: $(node -v)"
}

ensure_console_user() {
  # Console / SSH login for appliance images (not the web panel admin).
  local user="mtadmin" pass="mtbilling"
  if ! id "$user" &>/dev/null; then
    echo "Creating console user ${user}…"
    useradd -m -s /bin/bash -G sudo,adm "$user" 2>/dev/null || useradd -m -s /bin/bash "$user"
  fi
  echo "${user}:${pass}" | chpasswd
  # Passwordless sudo helps headless recovery on small boards.
  echo "${user} ALL=(ALL) NOPASSWD:ALL" >"/etc/sudoers.d/010-${user}"
  chmod 440 "/etc/sudoers.d/010-${user}"
  # Raspberry Pi OS: keep SSH enabled on bootfs.
  for d in /boot/firmware /boot; do
    if [[ -d "$d" && -w "$d" ]]; then
      touch "$d/ssh" 2>/dev/null || true
    fi
  done
}

detect_board
ensure_swap_if_low_ram
ensure_console_user

# Wait briefly for DHCP / cloud-init networking on appliance images.
for _i in $(seq 1 30); do
  if ping -c1 -W2 1.1.1.1 >/dev/null 2>&1 || ping -c1 -W2 8.8.8.8 >/dev/null 2>&1; then
    break
  fi
  sleep 2
done

# Ensure SSH is available for headless access (RPi/OPi/PC).
systemctl enable --now ssh 2>/dev/null || systemctl enable --now sshd 2>/dev/null || true
# Raspberry Pi OS: also drop the boot marker when the firmware partition is mounted.
for d in /boot/firmware /boot; do
  if [[ -d "$d" && -w "$d" ]]; then
    touch "$d/ssh" 2>/dev/null || true
  fi
done

echo "[1/7] Installing OS packages…"
apt-get update -y
apt-get install -y \
  curl git ca-certificates openssl build-essential python3 \
  libsqlite3-dev nginx xz-utils

install_nodejs

if ! id "$SERVICE_USER" &>/dev/null; then
  useradd --system --home "$INSTALL_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

echo "[3/7] Cloning MT-Billing (${REPO_BRANCH})…"
mkdir -p "$(dirname "$INSTALL_DIR")"
# Always bypass dubious-ownership checks (root vs service-user chown).
git_safe() { git -c safe.directory='*' -c safe.directory="$INSTALL_DIR" "$@"; }
git config --global --add safe.directory "$INSTALL_DIR" 2>/dev/null || true
git config --global --add safe.directory '*' 2>/dev/null || true
git config --system --add safe.directory "$INSTALL_DIR" 2>/dev/null || true
git config --system --add safe.directory '*' 2>/dev/null || true
if [[ -d "$INSTALL_DIR/.git" ]]; then
  # Partial installs often leave the tree owned by the service user — reset and update.
  chown -R root:root "$INSTALL_DIR" 2>/dev/null || true
  git_safe -C "$INSTALL_DIR" fetch origin
  git_safe -C "$INSTALL_DIR" checkout "$REPO_BRANCH"
  git_safe -C "$INSTALL_DIR" pull --ff-only origin "$REPO_BRANCH" || true
else
  rm -rf "$INSTALL_DIR"
  git_safe clone --branch "$REPO_BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi
chown -R "${SERVICE_USER}:${SERVICE_USER}" "$INSTALL_DIR"
sudo -u "$SERVICE_USER" git config --global --add safe.directory "$INSTALL_DIR" 2>/dev/null || true
sudo -u "$SERVICE_USER" git config --global --add safe.directory '*' 2>/dev/null || true

echo "[4/7] Building application…"
# Cap Node heap on small boards so the Vite/tsc build survives 1 GB RAM + swap.
sudo -u "$SERVICE_USER" bash -c "cd '$INSTALL_DIR' && NODE_OPTIONS='--max-old-space-size=768' npm install && NODE_OPTIONS='--max-old-space-size=768' npm run build && NODE_OPTIONS='--max-old-space-size=768' npm --prefix server run build"

echo "[5/7] Writing environment…"
JWT_SECRET="$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 64)"
mkdir -p "$INSTALL_DIR/server/data"
cat >"$INSTALL_DIR/server/.env" <<EOF
PORT=${API_PORT}
JWT_SECRET=${JWT_SECRET}
ADMIN_USER=${ADMIN_USER}
ADMIN_PASS=${ADMIN_PASS}
EOF
chmod 600 "$INSTALL_DIR/server/.env"
chown "${SERVICE_USER}:${SERVICE_USER}" "$INSTALL_DIR/server/.env" "$INSTALL_DIR/server/data"

echo "[6/7] Enabling systemd + nginx…"
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

cat >/etc/nginx/sites-available/mt-billing <<EOF
server {
    listen ${PANEL_PORT};
    listen [::]:${PANEL_PORT};
    server_name _;
    root ${INSTALL_DIR}/client/dist;
    index index.html;
    # DB restore / logo / QR uploads (nginx default 1m rejects most .db backups)
    client_max_body_size 100m;

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
        client_max_body_size 100m;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }
}
EOF
ln -sf /etc/nginx/sites-available/mt-billing /etc/nginx/sites-enabled/mt-billing
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl daemon-reload
systemctl enable --now mt-billing-api
systemctl enable nginx
systemctl reload nginx

echo "[6b/7] Granting panel passwordless sudo (Cloudflare Tunnel + Updater)…"
# One-time: lets Cloudflare Access / Application Updater work from the UI without SSH.
if [[ -x "${INSTALL_DIR}/install/mt-billing-grant-updater-root.sh" ]]; then
  bash "${INSTALL_DIR}/install/mt-billing-grant-updater-root.sh" || true
elif [[ -f "${INSTALL_DIR}/install/mt-billing-sudoers" ]]; then
  sed -e "s|__SVC_USER__|${SERVICE_USER}|g" -e "s|__INSTALL_DIR__|${INSTALL_DIR}|g" \
    -e "s|^Defaults:mtbilling |Defaults:${SERVICE_USER} |g" \
    -e "s|^mtbilling ALL=|${SERVICE_USER} ALL=|g" \
    -e "s|/opt/mt-billing|${INSTALL_DIR}|g" \
    "${INSTALL_DIR}/install/mt-billing-sudoers" >/etc/sudoers.d/mt-billing
  chmod 440 /etc/sudoers.d/mt-billing
  visudo -cf /etc/sudoers.d/mt-billing >/dev/null 2>&1 || rm -f /etc/sudoers.d/mt-billing
fi

echo "[7/7] Disabling first-boot unit…"
systemctl disable mt-billing-firstboot.service 2>/dev/null || true
rm -f /etc/systemd/system/mt-billing-firstboot.service
systemctl daemon-reload

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "==== MT-Billing first-boot complete ===="
echo "Panel: http://${IP:-<device-ip>}/"
echo "Login: ${ADMIN_USER} / ${ADMIN_PASS}  (change immediately)"
echo "Panel UI can manage Cloudflare Tunnel / updates (no SSH needed after this)."
