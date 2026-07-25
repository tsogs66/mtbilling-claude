#!/usr/bin/env bash
# Copyright (c) 2026 MT-Billing / ts0gs
# License: MIT
# Source: https://github.com/tsogs66/MT-Billing
#
# Configure this LXC/VM to host subscriber payment links on a DynDNS (or any)
# public hostname — or bind pay links to this host's LAN IP.
# Sets nginx (hostname mode) + PUBLIC_BASE_URL / panel public_base_url.
#
# Usage (inside the MT-Billing guest as root):
#   sudo bash /opt/mt-billing/install/mt-billing-public-host.sh yourname.duckdns.org
#   sudo bash /opt/mt-billing/install/mt-billing-public-host.sh billing.yourisp.dyndns.org --https
#   sudo bash /opt/mt-billing/install/mt-billing-public-host.sh yourname.duckdns.org --pay-only
#   sudo bash /opt/mt-billing/install/mt-billing-public-host.sh --local-ip
#
# Prerequisites (DynDNS mode):
#   1. DynDNS hostname points at your public IP
#   2. Router port-forwards TCP 80 (and 443 if --https) → this LXC
#   3. Outbound DNS works from the LXC
#
# Options:
#   --local-ip    Detect this host's LAN IPv4 and set pay links to http://IP
#                 (no nginx/DynDNS changes — for LAN/VPN collectors)
#   --https       Obtain/renew Let's Encrypt cert via certbot (needs port 80 open)
#   --pay-only    Public vhost only serves /pay/* and /api/public/* (safer)
#   --http-only   Force http:// links (default unless --https succeeds)
#   --port N      HTTP listen port (default 80)
#   --email ADDR  Certbot email (optional)
#   -h|--help     Show help

set -euo pipefail

INSTALL_DIR="${var_install_dir:-${INSTALL_DIR:-/opt/mt-billing}}"
API_PORT="${var_api_port:-${API_PORT:-4000}}"
PANEL_PORT="${var_panel_port:-${PANEL_PORT:-80}}"
HOSTNAME=""
DO_HTTPS=0
PAY_ONLY=0
FORCE_HTTP=0
USE_LOCAL_IP=0
CERTBOT_EMAIL=""

log_info() { printf '\033[1;34m[INFO]\033[0m %s\n' "$*"; }
log_ok() { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
log_err() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; }
log_warn() { printf '\033[1;33m[WARN]\033[0m %s\n' "$*"; }

usage() {
  sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local-ip) USE_LOCAL_IP=1; shift ;;
    --https) DO_HTTPS=1; shift ;;
    --pay-only) PAY_ONLY=1; shift ;;
    --http-only) FORCE_HTTP=1; shift ;;
    --port) PANEL_PORT="${2:-80}"; shift 2 ;;
    --email) CERTBOT_EMAIL="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    -*)
      log_err "Unknown option: $1"
      usage
      exit 1
      ;;
    *)
      if [[ -z "$HOSTNAME" ]]; then
        HOSTNAME="$1"
        shift
      else
        log_err "Unexpected argument: $1"
        exit 1
      fi
      ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  log_err "Run as root (e.g. sudo bash $0 --local-ip)"
  exit 1
fi

if [[ ! -d "$INSTALL_DIR" ]]; then
  log_err "Install dir not found: $INSTALL_DIR"
  exit 1
fi

DB_PATH="${INSTALL_DIR}/server/data/mt-billing.db"
ENV_FILE="${INSTALL_DIR}/server/.env"
SITE_AVAIL="/etc/nginx/sites-available/mt-billing"
SITE_ENABLED="/etc/nginx/sites-enabled/mt-billing"

detect_lan_ip() {
  local ip=""
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [[ -z "$ip" ]] && command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
  fi
  printf '%s' "$ip"
}

set_public_base_url() {
  local base="$1"
  mkdir -p "$(dirname "$ENV_FILE")"
  if [[ -f "$ENV_FILE" ]]; then
    if grep -q '^PUBLIC_BASE_URL=' "$ENV_FILE" 2>/dev/null; then
      sed -i "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=${base}|" "$ENV_FILE"
    else
      printf '\nPUBLIC_BASE_URL=%s\n' "$base" >>"$ENV_FILE"
    fi
  else
    printf 'PUBLIC_BASE_URL=%s\n' "$base" >"$ENV_FILE"
  fi

  if [[ -f "$DB_PATH" ]] && command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB_PATH" "UPDATE app_settings SET public_base_url = '${base//\'/\'\'}' WHERE id = 1;" 2>/dev/null || true
    # Clear non-running Cloudflare placeholder URL so LAN wins for copied links
    sqlite3 "$DB_PATH" "UPDATE app_settings SET cf_tunnel_url = NULL, cf_tunnel_status = 'stopped', cf_tunnel_enabled = 0 WHERE id = 1 AND IFNULL(cf_tunnel_status,'') != 'running';" 2>/dev/null || true
  fi
}

# ---- LAN IP mode (no nginx / DynDNS) ----
if [[ "$USE_LOCAL_IP" == "1" ]]; then
  LAN_IP="$(detect_lan_ip)"
  if [[ -z "$LAN_IP" ]]; then
    log_err "Could not detect a LAN IPv4 address (hostname -I empty)"
    exit 1
  fi
  if [[ "$PANEL_PORT" != "80" ]]; then
    PUBLIC_BASE="http://${LAN_IP}:${PANEL_PORT}"
  else
    PUBLIC_BASE="http://${LAN_IP}"
  fi
  set_public_base_url "$PUBLIC_BASE"
  log_ok "Pay portal URL → ${PUBLIC_BASE}"
  if systemctl is-active --quiet mt-billing-api 2>/dev/null; then
    log_info "Restarting mt-billing-api to load PUBLIC_BASE_URL"
    systemctl restart mt-billing-api || true
  fi
  echo
  log_ok "Done (LAN mode)"
  echo "  LAN IP      : ${LAN_IP}"
  echo "  Pay links   : ${PUBLIC_BASE}/pay/<token>"
  echo "  Reachable from devices on the same LAN/VPN as this LXC."
  echo
  echo "In the panel: Payment Links → Active base should show ${PUBLIC_BASE}"
  exit 0
fi

HOSTNAME="$(printf '%s' "$HOSTNAME" | tr '[:upper:]' '[:lower:]' | sed -e 's|^https\?://||' -e 's|/.*||' -e 's|:.*||' -e 's/\.$//')"
if [[ -z "$HOSTNAME" || "$HOSTNAME" == *' '* ]]; then
  log_err "Pass your DynDNS hostname, or use --local-ip."
  echo "Example: sudo bash $0 myisp.duckdns.org --https" >&2
  echo "     or: sudo bash $0 --local-ip" >&2
  exit 1
fi

if ! command -v nginx >/dev/null 2>&1; then
  log_err "nginx is not installed"
  exit 1
fi

write_nginx_full_locations() {
  cat <<EOF
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

    # Pay SPA routes — never directory-index (a leftover dist/pay/ causes 403)
    location = /pay {
        try_files /index.html =404;
    }
    location ^~ /pay/ {
        try_files \$uri /index.html;
    }

    location / {
        try_files \$uri \$uri/ /index.html;
    }
EOF
}

write_nginx_payonly_locations() {
  cat <<EOF
    # Public payment portal only (DynDNS / internet / Cloudflare Tunnel)
    # Important: omit \$uri/ so nginx does not 403 on a real dist/pay/ directory.
    location = /pay {
        try_files /index.html =404;
    }
    location ^~ /pay/ {
        try_files \$uri /index.html;
    }
    location ^~ /api/public/ {
        proxy_pass http://127.0.0.1:${API_PORT}/api/public/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
    location ^~ /assets/ {
        try_files \$uri =404;
    }
    location ^~ /wallets/ {
        try_files \$uri =404;
    }
    location = /index.html {
        try_files /index.html =404;
    }
    location = /favicon.ico {
        try_files /favicon.ico =404;
    }
    location / {
        return 404;
    }
EOF
}

write_nginx_http() {
  local lan_ip
  lan_ip="$(detect_lan_ip)"
  local full_locs pay_locs
  full_locs="$(write_nginx_full_locations)"
  pay_locs="$(write_nginx_payonly_locations)"

  if [[ "$PAY_ONLY" == "1" ]]; then
    # Two vhosts: DynDNS = pay-only; LAN IP / default = full admin panel
    cat >"$SITE_AVAIL" <<EOF
# MT-Billing — public DynDNS (pay portal only)
server {
    listen ${PANEL_PORT};
    listen [::]:${PANEL_PORT};
    server_name ${HOSTNAME};
    client_max_body_size 100m;

    root ${INSTALL_DIR}/client/dist;
    index index.html;

${pay_locs}
}

# MT-Billing — LAN / IP access (full panel)
server {
    listen ${PANEL_PORT} default_server;
    listen [::]:${PANEL_PORT} default_server;
    server_name ${lan_ip:-_} localhost;
    client_max_body_size 100m;

    root ${INSTALL_DIR}/client/dist;
    index index.html;

${full_locs}
}
EOF
  else
    cat >"$SITE_AVAIL" <<EOF
server {
    listen ${PANEL_PORT} default_server;
    listen [::]:${PANEL_PORT} default_server;
    server_name ${HOSTNAME} ${lan_ip} _;
    client_max_body_size 100m;

    root ${INSTALL_DIR}/client/dist;
    index index.html;

${full_locs}
}
EOF
  fi
}

log_info "Configuring public pay host for ${HOSTNAME}"
write_nginx_http
ln -sf "$SITE_AVAIL" "$SITE_ENABLED"
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx >/dev/null 2>&1 || true
systemctl reload nginx
log_ok "nginx listening on :${PANEL_PORT} for ${HOSTNAME}"

SCHEME="http"
if [[ "$DO_HTTPS" == "1" && "$FORCE_HTTP" != "1" ]]; then
  if ! command -v certbot >/dev/null 2>&1; then
    log_info "Installing certbot"
    apt-get update -y >/dev/null
    DEBIAN_FRONTEND=noninteractive apt-get install -y certbot python3-certbot-nginx >/dev/null
  fi
  log_info "Requesting Let's Encrypt certificate (port 80 must reach this host)"
  CERTBOT_ARGS=(--nginx -d "$HOSTNAME" --non-interactive --agree-tos --redirect)
  if [[ -n "$CERTBOT_EMAIL" ]]; then
    CERTBOT_ARGS+=(--email "$CERTBOT_EMAIL")
  else
    CERTBOT_ARGS+=(--register-unsafely-without-email)
  fi
  if certbot "${CERTBOT_ARGS[@]}"; then
    SCHEME="https"
    log_ok "HTTPS enabled for ${HOSTNAME}"
  else
    log_warn "certbot failed — keeping HTTP. Fix DNS/port-forward, then re-run with --https"
  fi
fi

PUBLIC_BASE="${SCHEME}://${HOSTNAME}"
set_public_base_url "$PUBLIC_BASE"
log_ok "Public pay portal URL → ${PUBLIC_BASE}"

if systemctl is-active --quiet mt-billing-api 2>/dev/null; then
  log_info "Restarting mt-billing-api to load PUBLIC_BASE_URL"
  systemctl restart mt-billing-api || true
fi

echo
log_ok "Done"
echo "  DynDNS host : ${HOSTNAME}"
echo "  Pay links   : ${PUBLIC_BASE}/pay/<token>"
echo "  Mode        : $([[ "$PAY_ONLY" == "1" ]] && echo 'pay-only on DynDNS + full panel on LAN IP' || echo 'full panel')"
LAN_IP_NOW="$(detect_lan_ip)"
if [[ -n "$LAN_IP_NOW" ]]; then
  echo "  LAN panel   : http://${LAN_IP_NOW}/  (admin UI)"
fi
echo
echo "Checklist:"
echo "  1. DynDNS A/AAAA record → your public IP"
echo "  2. pfSense + ER7206 forward TCP ${PANEL_PORT}$([[ "$SCHEME" == https ]] && echo '/443') → this LXC (${LAN_IP_NOW:-192.168.x.x})"
echo "  3. LAN: open http://${LAN_IP_NOW:-THIS_LXC_IP}/ for the full panel"
echo "  4. Internet: only /pay/... works when using --pay-only"
echo "  5. Payment Links → Active base = ${PUBLIC_BASE}"
echo
if [[ "$PAY_ONLY" != "1" ]]; then
  log_warn "Full panel is exposed on DynDNS. Prefer --pay-only for subscriber links, and keep admin on LAN."
fi
