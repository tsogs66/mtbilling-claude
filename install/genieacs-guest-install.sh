#!/usr/bin/env bash
# Copyright (c) 2026 MT-Billing / Pa-North
# License: MIT
#
# Guest install — MongoDB + GenieACS 1.2.x (systemd). Run inside the GenieACS LXC as root.
# Invoked by scripts/proxmox-genieacs.sh (pct exec).

set -euo pipefail

GENIEACS_VERSION="${GENIEACS_VERSION:-1.2.16}"
NODE_MAJOR="${NODE_MAJOR:-20}"
BILLING_IP="${BILLING_IP:-}"

log() { echo "[genieacs-guest] $*"; }

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root inside the LXC." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

log "Updating package index"
apt-get update -qq

log "Installing prerequisites"
apt-get install -y -qq curl ca-certificates gnupg openssl

if ! command -v mongod >/dev/null 2>&1; then
  log "Installing MongoDB 7.0"
  curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor --yes
  echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" \
    >/etc/apt/sources.list.d/mongodb-org-7.0.list
  apt-get update -qq
  apt-get install -y -qq mongodb-org
fi
systemctl enable mongod
systemctl start mongod

if ! command -v node >/dev/null 2>&1 || [[ "$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)" -lt "$NODE_MAJOR" ]]; then
  log "Installing Node.js ${NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi

log "Installing GenieACS ${GENIEACS_VERSION} (npm global)"
npm install -g "genieacs@${GENIEACS_VERSION}"

if ! id genieacs &>/dev/null; then
  useradd --system --no-create-home --user-group genieacs
fi

mkdir -p /opt/genieacs/ext /var/log/genieacs
chown -R genieacs:genieacs /opt/genieacs/ext /var/log/genieacs

if [[ ! -f /opt/genieacs/genieacs.env ]]; then
  cat >/opt/genieacs/genieacs.env <<'EOF'
GENIEACS_MONGODB_CONNECTION_URL=mongodb://127.0.0.1/genieacs
GENIEACS_CWMP_INTERFACE=0.0.0.0
GENIEACS_CWMP_PORT=7547
GENIEACS_NBI_INTERFACE=0.0.0.0
GENIEACS_NBI_PORT=7557
GENIEACS_FS_INTERFACE=0.0.0.0
GENIEACS_FS_PORT=7567
GENIEACS_UI_INTERFACE=0.0.0.0
GENIEACS_UI_PORT=3000
GENIEACS_CWMP_ACCESS_LOG_FILE=/var/log/genieacs/genieacs-cwmp-access.log
GENIEACS_NBI_ACCESS_LOG_FILE=/var/log/genieacs/genieacs-nbi-access.log
GENIEACS_FS_ACCESS_LOG_FILE=/var/log/genieacs/genieacs-fs-access.log
GENIEACS_UI_ACCESS_LOG_FILE=/var/log/genieacs/genieacs-ui-access.log
GENIEACS_DEBUG_FILE=/var/log/genieacs/genieacs-debug.yaml
NODE_OPTIONS=--enable-source-maps
GENIEACS_EXT_DIR=/opt/genieacs/ext
EOF
  node -e "console.log('GENIEACS_UI_JWT_SECRET=' + require('crypto').randomBytes(128).toString('hex'))" >>/opt/genieacs/genieacs.env
fi
chown genieacs:genieacs /opt/genieacs/genieacs.env
chmod 600 /opt/genieacs/genieacs.env

write_unit() {
  local name="$1"
  local bin="$2"
  cat >/etc/systemd/system/"${name}".service <<EOF
[Unit]
Description=GenieACS ${name#genieacs-}
After=network.target mongod.service
Wants=mongod.service

[Service]
User=genieacs
EnvironmentFile=/opt/genieacs/genieacs.env
ExecStart=${bin}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
}

BIN_DIR="$(dirname "$(command -v genieacs-cwmp)")"
write_unit genieacs-cwmp "${BIN_DIR}/genieacs-cwmp"
write_unit genieacs-nbi "${BIN_DIR}/genieacs-nbi"
write_unit genieacs-fs "${BIN_DIR}/genieacs-fs"
write_unit genieacs-ui "${BIN_DIR}/genieacs-ui"

systemctl daemon-reload
for u in genieacs-cwmp genieacs-nbi genieacs-fs genieacs-ui; do
  systemctl enable "$u"
  systemctl restart "$u"
done

# Restrict NBI to billing host when BILLING_IP is known (CWMP stays open for CPEs).
if [[ -n "$BILLING_IP" ]] && command -v ufw >/dev/null 2>&1; then
  apt-get install -y -qq ufw || true
  ufw --force reset >/dev/null 2>&1 || true
  ufw default deny incoming >/dev/null 2>&1 || true
  ufw default allow outgoing >/dev/null 2>&1 || true
  ufw allow 7547/tcp comment 'GenieACS CWMP' >/dev/null 2>&1 || true
  ufw allow 3000/tcp comment 'GenieACS UI' >/dev/null 2>&1 || true
  ufw allow from "$BILLING_IP" to any port 7557 proto tcp comment 'GenieACS NBI MT-Billing' >/dev/null 2>&1 || true
  ufw --force enable >/dev/null 2>&1 || true
fi

log "GenieACS services:"
systemctl is-active genieacs-cwmp genieacs-nbi genieacs-fs genieacs-ui | paste - - - - || true
log "Done."
