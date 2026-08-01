#!/usr/bin/env bash
# Copyright (c) 2026 MT-Billing / ts0gs
# License: MIT
# Source: https://github.com/tsogs66/MT-Billing
#
# Install and run Cloudflare Tunnel (cloudflared) so subscriber payment links
# are reachable without opening router ports or using DynDNS.
#
# Cloudflare Zero Trust setup (dashboard):
#   1. Zero Trust → Networks → Tunnels → Create a tunnel (Cloudflared)
#   2. Copy the install token shown for the connector
#   3. Public Hostname → Subdomain/Domain → Service: http://localhost:80
#      (or your panel nginx / Vite port)
#
# Usage (inside the MT-Billing guest as root):
#   sudo bash /opt/mt-billing/install/mt-billing-cloudflare-tunnel.sh \
#     --token eyJh... --hostname pay.yourisp.com
#
#   sudo bash /opt/mt-billing/install/mt-billing-cloudflare-tunnel.sh --from-db
#   sudo bash /opt/mt-billing/install/mt-billing-cloudflare-tunnel.sh start
#   sudo bash /opt/mt-billing/install/mt-billing-cloudflare-tunnel.sh stop
#   sudo bash /opt/mt-billing/install/mt-billing-cloudflare-tunnel.sh status
#   sudo bash /opt/mt-billing/install/mt-billing-cloudflare-tunnel.sh uninstall
#
# Options:
#   --token TOKEN     Cloudflare tunnel connector token
#   --token-file PATH Read token from file (preferred from panel; no sqlite3 CLI)
#   --hostname HOST   Public hostname (sets pay portal URL to https://HOST)
#   --port N          Local service port cloudflared should reach (default 80)
#                     Note: hostname→service URL is configured in Cloudflare;
#                     --port is stored for panel guidance / nginx checks.
#   --from-db         Read token/hostname/port from app_settings SQLite
#   --no-start        Install/configure but do not start the service
#   -h|--help

set -euo pipefail

INSTALL_DIR="${var_install_dir:-${INSTALL_DIR:-/opt/mt-billing}}"
DB_PATH="${INSTALL_DIR}/server/data/mt-billing.db"
ENV_FILE="${INSTALL_DIR}/server/.env"
CONF_DIR="/etc/mt-billing"
TOKEN_FILE="${CONF_DIR}/cloudflared.token"
ENV_TOKEN_FILE="${CONF_DIR}/cloudflared.env"
WRAPPER="${CONF_DIR}/run-tunnel.sh"
UNIT_NAME="cloudflared-mt-billing.service"
UNIT_PATH="/etc/systemd/system/${UNIT_NAME}"

# Shared Cloudflare + Twingate LAN/DNS coexistence (no-op if Twingate absent)
COEXIST_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/mt-billing-net-coexist.sh"
if [[ -f "$COEXIST_SCRIPT" ]]; then
  # shellcheck disable=SC1090
  source "$COEXIST_SCRIPT"
fi

TOKEN=""
TOKEN_FILE_ARG=""
HOSTNAME=""
LOCAL_PORT="80"
FROM_DB=0
NO_START=0
ACTION=""

log_info() { printf '\033[1;34m[INFO]\033[0m %s\n' "$*"; }
log_ok() { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
log_err() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; }
log_warn() { printf '\033[1;33m[WARN]\033[0m %s\n' "$*"; }

usage() {
  sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token) TOKEN="${2:-}"; shift 2 ;;
    --token-file)
      TOKEN_FILE_ARG="${2:-}"
      if [[ -n "$TOKEN_FILE_ARG" && -f "$TOKEN_FILE_ARG" ]]; then
        TOKEN="$(tr -d '\r\n\t ' <"$TOKEN_FILE_ARG" || true)"
      fi
      shift 2
      ;;
    --hostname) HOSTNAME="${2:-}"; shift 2 ;;
    --port) LOCAL_PORT="${2:-80}"; shift 2 ;;
    --from-db) FROM_DB=1; shift ;;
    --no-start) NO_START=1; shift ;;
    start|stop|status|uninstall|apply)
      ACTION="$1"
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    -*)
      log_err "Unknown option: $1"
      usage
      exit 1
      ;;
    *)
      log_err "Unexpected argument: $1"
      usage
      exit 1
      ;;
  esac
done

# Default action: apply (install + configure + start)
if [[ -z "$ACTION" ]]; then
  ACTION="apply"
fi

if [[ "$(id -u)" -ne 0 ]]; then
  log_err "Run as root (e.g. sudo bash $0 --token … --hostname pay.yourisp.com)"
  exit 1
fi

# Prefer panel-supplied --token / --token-file (no sqlite3 CLI needed).
# Flash images often lack the sqlite3 package and apt mirrors 404 — that used
# to break every RPi/PC "Install tunnel" from the UI (--from-db).
# Only try apt for sqlite3 when we still need --from-db / DB status writes.
need_sqlite_cli=0
if [[ "$FROM_DB" == "1" && -z "$TOKEN" ]]; then
  need_sqlite_cli=1
fi
if ! command -v sqlite3 >/dev/null 2>&1 && [[ "$need_sqlite_cli" == "1" ]]; then
  log_info "Installing sqlite3 (CLI) for --from-db…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq || true
  apt-get install -y -qq sqlite3 || log_warn "Could not install sqlite3 — use panel apply (token-file) instead of --from-db"
fi

# DB helper: sqlite3 CLI if present, else python3 stdlib (always on flash images)
db_exec() {
  local sql="$1"
  [[ -f "$DB_PATH" ]] || return 0
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB_PATH" "$sql" 2>/dev/null || true
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    SQLITE_DB="$DB_PATH" SQLITE_SQL="$sql" python3 - <<'PY' 2>/dev/null || true
import os, sqlite3
db = sqlite3.connect(os.environ["SQLITE_DB"])
db.execute(os.environ["SQLITE_SQL"])
db.commit()
db.close()
PY
    return 0
  fi
  return 1
}

db_query() {
  local sql="$1"
  [[ -f "$DB_PATH" ]] || return 1
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 -separator '|' "$DB_PATH" "$sql" 2>/dev/null
    return $?
  fi
  if command -v python3 >/dev/null 2>&1; then
    SQLITE_DB="$DB_PATH" SQLITE_SQL="$sql" python3 - <<'PY' 2>/dev/null
import os, sqlite3
db = sqlite3.connect(os.environ["SQLITE_DB"])
cur = db.execute(os.environ["SQLITE_SQL"])
rows = cur.fetchall()
for r in rows:
    print("|".join("" if v is None else str(v) for v in r))
db.close()
PY
    return $?
  fi
  return 1
}

normalize_host() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -e 's|^https\?://||' -e 's|/.*||' -e 's|:.*||' -e 's/\.$//'
}

sanitize_token() {
  # Strip whitespace/newlines/quotes that break cloudflared JWT parsing
  printf '%s' "$1" | tr -d '\r\n\t ' | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
}

validate_token() {
  local t="$1"
  if [[ -z "$t" ]]; then
    log_err "Tunnel token is empty"
    return 1
  fi
  if [[ "$t" == *"…"* || "$t" == *"..."* || "$t" == "eyJh..."* ]]; then
    log_err "That looks like a placeholder token, not a real Cloudflare install token."
    echo "  In Zero Trust → Networks → Tunnels → your tunnel → Install connector, copy the full token" >&2
    echo "  (long string starting with eyJh…)." >&2
    return 1
  fi
  if [[ "$t" != eyJ* ]]; then
    log_err "Tunnel token should start with eyJ (Cloudflare connector token)."
    echo "  Do not use an API Token / Global API Key — use the tunnel install/connector token." >&2
    return 1
  fi
  # Typical connector tokens are long base64 JSON blobs (often without dots).
  # Older docs sometimes show JWT-shaped tokens; both are accepted if they decode.
  if [[ ${#t} -lt 80 ]]; then
    log_err "Tunnel token looks too short (${#t} chars). Paste the full connector token from Cloudflare."
    return 1
  fi
  # Prefer tokens that decode to Cloudflare's {a,t,s} connector JSON; also allow dotted JWTs.
  if [[ "$t" == *.*.* ]]; then
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    if python3 - "$t" <<'PY' 2>/dev/null
import sys, json, base64
t = sys.argv[1]
pad = "=" * ((4 - len(t) % 4) % 4)
try:
    data = json.loads(base64.urlsafe_b64decode(t + pad))
except Exception:
    sys.exit(1)
if not isinstance(data, dict):
    sys.exit(1)
# Cloudflare tunnel run tokens look like {"a": "...", "t": "<uuid>", "s": "..."}
if data.get("a") and data.get("t") and data.get("s"):
    sys.exit(0)
sys.exit(1)
PY
    then
      return 0
    fi
    log_err "Token is not a valid Cloudflare tunnel connector token."
    echo "  Expected a token from Zero Trust → Tunnels → Install connector (decodes to a/t/s)." >&2
    return 1
  fi
  # No python3 — accept long eyJ… tokens (cloudflared will validate for real)
  return 0
}

cloudflared_bin() {
  if [[ -x /usr/local/bin/cloudflared ]]; then
    echo /usr/local/bin/cloudflared
  elif [[ -x /usr/bin/cloudflared ]]; then
    echo /usr/bin/cloudflared
  elif command -v cloudflared >/dev/null 2>&1; then
    command -v cloudflared
  else
    echo cloudflared
  fi
}

probe_token() {
  # Run briefly to surface auth errors before enabling the restart loop
  local bin err
  bin="$(cloudflared_bin)"
  err="$(mktemp)"
  set +e
  timeout 8s "$bin" tunnel --no-autoupdate run --token "$TOKEN" >"$err" 2>&1
  local rc=$?
  set -e
  # timeout → 124 means it stayed up (good). Other codes → show log.
  if [[ "$rc" -eq 124 ]]; then
    rm -f "$err"
    return 0
  fi
  # Still running somehow
  if grep -qiE 'Registered tunnel connection|Connected to|connIndex=' "$err" 2>/dev/null; then
    rm -f "$err"
    return 0
  fi
  log_err "cloudflared rejected the token or could not connect:"
  sed -n '1,40p' "$err" >&2 || true
  echo >&2
  if grep -qiE 'unauthorized|invalid token|failed to parse|malformed|expired|403|401' "$err"; then
    echo "  Fix: Zero Trust → Networks → Tunnels → create/open tunnel → copy a fresh Install token." >&2
    echo "  Then re-run with --token '<paste full token>' --hostname your.real.domain" >&2
  elif grep -qiE 'network|dial|timeout|DNS|resolve' "$err"; then
    echo "  Fix: ensure this LXC has outbound HTTPS (443) to Cloudflare." >&2
  else
    echo "  Tip: hostname 'pay.yourisp.com' is only an example — use a hostname on your Cloudflare zone." >&2
  fi
  rm -f "$err"
  return 1
}

set_public_base_url() {
  local base="$1"
  # Quote for systemd EnvironmentFile so a restart never fails to parse .env
  # (unquoted edge cases after Cloudflare install were a login-outage cause).
  local safe="${base//\"/}"
  mkdir -p "$(dirname "$ENV_FILE")"
  if [[ -f "$ENV_FILE" ]]; then
    if grep -qE '^PUBLIC_BASE_URL=' "$ENV_FILE" 2>/dev/null; then
      sed -i "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=\"${safe}\"|" "$ENV_FILE"
    else
      printf '\nPUBLIC_BASE_URL="%s"\n' "$safe" >>"$ENV_FILE"
    fi
  else
    # Never create a .env that only has PUBLIC_BASE_URL — JWT lives in that file.
    log_warn "server/.env missing — skipping PUBLIC_BASE_URL env write (DB updated)"
  fi

  db_exec "UPDATE app_settings SET public_base_url = '${base//\'/\'\'}', cf_tunnel_url = '${base//\'/\'\'}', cf_tunnel_status = 'running', cf_tunnel_enabled = 1 WHERE id = 1;"
}

set_db_status() {
  local status="$1"
  local url="${2:-}"
  local enabled
  enabled="$([[ "$status" == running ]] && echo 1 || echo 0)"
  if [[ -n "$url" ]]; then
    db_exec "UPDATE app_settings SET cf_tunnel_status = '${status//\'/\'\'}', cf_tunnel_url = '${url//\'/\'\'}', cf_tunnel_enabled = ${enabled} WHERE id = 1;"
  else
    db_exec "UPDATE app_settings SET cf_tunnel_status = '${status//\'/\'\'}', cf_tunnel_enabled = ${enabled} WHERE id = 1;"
  fi
}

read_from_db() {
  if [[ ! -f "$DB_PATH" ]]; then
    log_err "Cannot read settings from DB ($DB_PATH)"
    exit 1
  fi
  local row
  row="$(db_query "SELECT IFNULL(cf_tunnel_token,''), IFNULL(cf_tunnel_hostname,''), IFNULL(cf_tunnel_port,80) FROM app_settings WHERE id = 1;" || true)"
  if [[ -z "$row" ]]; then
    log_err "No app_settings row found (need sqlite3 CLI or python3)"
    exit 1
  fi
  IFS='|' read -r TOKEN HOSTNAME LOCAL_PORT <<<"$row"
  LOCAL_PORT="${LOCAL_PORT:-80}"
}

install_cloudflared() {
  local existing
  existing="$(cloudflared_bin)"
  if [[ -x "$existing" ]] || command -v cloudflared >/dev/null 2>&1; then
    log_ok "cloudflared already installed: $($(cloudflared_bin) --version 2>/dev/null | head -1 || echo ok)"
    return 0
  fi
  log_info "Installing cloudflared"
  local sys_arch asset
  sys_arch="$(dpkg --print-architecture 2>/dev/null || uname -m)"
  case "$sys_arch" in
    amd64|x86_64) asset="amd64" ;;
    arm64|aarch64) asset="arm64" ;;
    # Debian/Armbian report armhf; Cloudflare ships cloudflared-linux-armhf.deb
    # (cloudflared-linux-arm.deb is arch "arm" and dpkg rejects it on armhf).
    armhf|armv7l|armv7*) asset="armhf" ;;
    armel|arm) asset="arm" ;;
    *)
      log_err "Unsupported architecture: $sys_arch"
      exit 1
      ;;
  esac

  local deb="/tmp/cloudflared-linux-${asset}.deb"
  local url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${asset}.deb"
  local ok=0
  local try=0
  for try in 1 2 3; do
    if curl -fsSL --connect-timeout 15 --max-time 180 "$url" -o "$deb"; then
      if DEBIAN_FRONTEND=noninteractive dpkg -i "$deb" >/dev/null 2>&1; then
        ok=1
        break
      else
        # Rare: arch tag mismatch — try force, then fall through to binary.
        DEBIAN_FRONTEND=noninteractive dpkg -i --force-architecture "$deb" >/dev/null 2>&1 && ok=1 && break || true
        apt-get install -f -y >/dev/null 2>&1 || true
      fi
    else
      log_warn "Download attempt ${try}/3 failed for cloudflared (${asset})"
      sleep 2
    fi
  done
  rm -f "$deb"

  if [[ "$ok" -ne 1 ]] || ! command -v cloudflared >/dev/null 2>&1; then
    log_info "dpkg install failed or missing; installing cloudflared binary for ${asset}"
    local bin_url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${asset}"
    local bin_tmp="/tmp/cloudflared-linux-${asset}"
    if ! curl -fsSL --connect-timeout 15 --max-time 180 "$bin_url" -o "$bin_tmp"; then
      log_err "Failed to download cloudflared from GitHub releases (${asset})"
      log_err "On RPi: check internet/DNS (ping 1.1.1.1), then retry. Prefer 64-bit image mt-billing-rpi-arm64."
      exit 1
    fi
    install -m 0755 "$bin_tmp" /usr/local/bin/cloudflared
    rm -f "$bin_tmp"
  fi

  if [[ ! -x "$(cloudflared_bin)" ]] && ! command -v cloudflared >/dev/null 2>&1; then
    log_err "cloudflared install failed"
    exit 1
  fi
  log_ok "Installed $($(cloudflared_bin) --version 2>/dev/null | head -1)"
}

write_unit() {
  local bin
  bin="$(cloudflared_bin)"
  mkdir -p "$CONF_DIR"
  chmod 750 "$CONF_DIR"
  if [[ -z "$TOKEN" ]]; then
    log_err "Tunnel token is required"
    exit 1
  fi
  TOKEN="$(sanitize_token "$TOKEN")"
  if ! validate_token "$TOKEN"; then
    exit 1
  fi

  umask 077
  # Plain token file (no newline) + env file for cloudflared TUNNEL_TOKEN
  printf '%s' "$TOKEN" >"$TOKEN_FILE"
  chmod 600 "$TOKEN_FILE"
  # Quote value so '=' padding inside JWT is safe for systemd EnvironmentFile
  printf 'TUNNEL_TOKEN=%s\n' "$TOKEN" >"$ENV_TOKEN_FILE"
  chmod 600 "$ENV_TOKEN_FILE"

  cat >"$WRAPPER" <<WRAP
#!/bin/bash
set -euo pipefail
TOKEN="\$(tr -d '\\r\\n\\t ' <'${TOKEN_FILE}')"
if [[ -z "\$TOKEN" || "\$TOKEN" != eyJ* ]]; then
  echo "cloudflared-mt-billing: missing/invalid token in ${TOKEN_FILE}" >&2
  exit 1
fi
exec '${bin}' tunnel --no-autoupdate run --token "\$TOKEN"
WRAP
  chmod 700 "$WRAPPER"

  cat >"$UNIT_PATH" <<EOF
[Unit]
Description=Cloudflare Tunnel for MT-Billing pay portal
Documentation=https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
# always: recover from crashes / StartLimitHit that otherwise leave CF at 502 Host Error
Restart=always
RestartSec=5
StartLimitIntervalSec=0
# Prefer wrapper (reads token file); EnvironmentFile is a backup for TUNNEL_TOKEN
EnvironmentFile=-${ENV_TOKEN_FILE}
ExecStart=${WRAPPER}
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "$UNIT_NAME" >/dev/null 2>&1 || true
  log_ok "systemd unit ${UNIT_NAME} installed"
}

dump_failure_logs() {
  log_err "Service failed to start — recent logs:"
  journalctl -u "$UNIT_NAME" -n 40 --no-pager -l 2>/dev/null || true
  systemctl status "$UNIT_NAME" --no-pager -l || true
  if [[ -f "$TOKEN_FILE" ]]; then
    local len
    len="$(wc -c <"$TOKEN_FILE" | tr -d ' ')"
    echo "  Token file : ${TOKEN_FILE} (${len} bytes)" >&2
  fi
  echo >&2
  echo "Common fixes:" >&2
  echo "  1. Use a REAL tunnel connector token from Cloudflare Zero Trust (not an API key)." >&2
  echo "  2. Hostname must be a domain on your Cloudflare account (not pay.yourisp.com)." >&2
  echo "  3. Re-copy the install token (they can be rotated / one-time)." >&2
  echo "  4. Test manually:" >&2
  echo "       sudo $(cloudflared_bin) tunnel run --token \"\$(cat ${TOKEN_FILE})\"" >&2
}

do_start() {
  if [[ ! -f "$UNIT_PATH" ]]; then
    log_err "Service not installed. Run apply first (with --token / --from-db)."
    exit 1
  fi
  systemctl reset-failed "$UNIT_NAME" 2>/dev/null || true
  systemctl start "$UNIT_NAME"
  # Give cloudflared a moment to auth; restart loop can look "activating"
  local i active=0
  for i in 1 2 3 4 5 6; do
    sleep 1
    if systemctl is-active --quiet "$UNIT_NAME"; then
      active=1
      break
    fi
    if systemctl is-failed --quiet "$UNIT_NAME" 2>/dev/null; then
      break
    fi
  done
  if [[ "$active" == "1" ]]; then
    local url=""
    if [[ -n "$HOSTNAME" ]]; then
      HOSTNAME="$(normalize_host "$HOSTNAME")"
      url="https://${HOSTNAME}"
      set_public_base_url "$url"
    else
      set_db_status "running"
    fi
    log_ok "Cloudflare Tunnel running"
    [[ -n "$url" ]] && echo "  Pay portal : ${url}/pay/<token>"
    # Re-assert LAN pins + coexist DNS so Twingate (if running) does not steal local/default
    if declare -F apply_net_coexist >/dev/null 2>&1; then
      apply_net_coexist || log_warn "Coexistence helper warned — LAN/DNS may need: sudo bash ${COEXIST_SCRIPT:-install/mt-billing-net-coexist.sh} apply"
    fi
  else
    set_db_status "error"
    dump_failure_logs
    exit 1
  fi
}

do_stop() {
  systemctl stop "$UNIT_NAME" 2>/dev/null || true
  set_db_status "stopped"
  log_ok "Cloudflare Tunnel stopped"
}

do_status() {
  local active="stopped"
  if systemctl is-active --quiet "$UNIT_NAME" 2>/dev/null; then
    active="running"
  elif systemctl is-failed --quiet "$UNIT_NAME" 2>/dev/null; then
    active="error"
  fi
  local url=""
  url="$(db_query "SELECT IFNULL(cf_tunnel_url,'') FROM app_settings WHERE id = 1;" 2>/dev/null || true)"
  if [[ -z "$url" ]]; then
    local h
    h="$(db_query "SELECT IFNULL(cf_tunnel_hostname,'') FROM app_settings WHERE id = 1;" 2>/dev/null || true)"
    [[ -n "$h" ]] && url="https://$(normalize_host "$h")"
  fi
  set_db_status "$active" "$url"
  echo "status=${active}"
  echo "url=${url}"
  echo "unit=${UNIT_NAME}"
  systemctl is-active "$UNIT_NAME" 2>/dev/null || true
  return 0
}

do_uninstall() {
  systemctl stop "$UNIT_NAME" 2>/dev/null || true
  systemctl disable "$UNIT_NAME" 2>/dev/null || true
  rm -f "$UNIT_PATH" "$TOKEN_FILE" "$ENV_TOKEN_FILE" "$WRAPPER"
  systemctl daemon-reload 2>/dev/null || true
  set_db_status "stopped"
  log_ok "Cloudflare Tunnel service removed (cloudflared binary left installed)"
}

do_apply() {
  if [[ "$FROM_DB" == "1" ]]; then
    read_from_db
  fi
  TOKEN="$(sanitize_token "${TOKEN}")"
  HOSTNAME="$(normalize_host "${HOSTNAME}")"
  if [[ -z "$TOKEN" ]]; then
    log_err "Missing tunnel token. Pass --token or save it in System Settings and use --from-db."
    exit 1
  fi
  if ! validate_token "$TOKEN"; then
    exit 1
  fi
  if [[ -z "$HOSTNAME" ]]; then
    log_warn "No hostname set — tunnel will run, but set hostname so pay links use https://your.domain"
  elif [[ "$HOSTNAME" == "pay.yourisp.com" || "$HOSTNAME" == "billing.yourisp.com" ]]; then
    log_err "Hostname '${HOSTNAME}' is the documentation example, not a real domain."
    echo "  Use a hostname on your Cloudflare zone (e.g. pay.yourdomain.com), then:" >&2
    echo "  1) Cloudflare → Zero Trust → Tunnels → Public Hostname → add that hostname" >&2
    echo "     Service URL: http://127.0.0.1:${LOCAL_PORT}" >&2
    echo "  2) Re-run with --hostname pay.yourdomain.com" >&2
    exit 1
  fi

  db_exec "UPDATE app_settings SET cf_tunnel_token = '${TOKEN//\'/\'\'}', cf_tunnel_hostname = '${HOSTNAME//\'/\'\'}', cf_tunnel_port = ${LOCAL_PORT:-80} WHERE id = 1;"

  install_cloudflared
  write_unit

  if [[ -n "$HOSTNAME" ]]; then
    log_info "Ensure Cloudflare Public Hostname '${HOSTNAME}' → http://127.0.0.1:${LOCAL_PORT}"
  fi

  log_info "Probing token with cloudflared (8s)…"
  if ! probe_token; then
    set_db_status "error"
    exit 1
  fi
  log_ok "Token accepted / connector can reach Cloudflare"

  if [[ "$NO_START" == "1" ]]; then
    set_db_status "stopped"
    log_ok "Configured (not started)"
    return 0
  fi
  do_start

  # Protect SSH/panel if Twingate later rewrites DNS (common on PC flash)
  if [[ -f "$(dirname "${BASH_SOURCE[0]}")/mt-billing-net-watchdog.sh" ]]; then
    bash "$(dirname "${BASH_SOURCE[0]}")/mt-billing-net-watchdog.sh" install >/dev/null 2>&1 \
      && log_ok "Network watchdog enabled (keeps SSH/panel if Twingate rewrites DNS)" \
      || true
  fi

  # Do NOT restart mt-billing-api here. Pay/public URLs are read from SQLite
  # (and the panel hot-sets process.env.PUBLIC_BASE_URL after apply). A deferred
  # restart after Cloudflare install was a common cause of "UI cannot login"
  # (API crash-loop / brief outage / EnvironmentFile parse edge cases).
  log_info "Skipping mt-billing-api restart (PUBLIC_BASE_URL is in DB; login stays on LAN)"

  echo
  log_ok "Done"
  echo "  Hostname    : ${HOSTNAME:-'(set in Cloudflare + panel)'}"
  echo "  Local port  : ${LOCAL_PORT} (must match Cloudflare service URL)"
  echo "  Pay links   : https://${HOSTNAME:-YOUR_HOST}/pay/<token>"
  echo "  Admin login : use LAN IP http://<panel-lan-ip>/login (not the Cloudflare hostname)"
  echo
  echo "Checklist:"
  echo "  1. Cloudflare Tunnel public hostname points to http://127.0.0.1:${LOCAL_PORT}"
  echo "  2. nginx (or the panel) is listening on that port"
  echo "  3. Payment Links → Active base shows https://${HOSTNAME:-YOUR_HOST}"
  echo "  4. Open a full pay link https://${HOSTNAME:-YOUR_HOST}/pay/<token> (not bare /pay/)"
  echo "  5. Do NOT enable Cloudflare Access (Zero Trust app) or Bot Fight on this hostname"
  echo "     — they block POST /api/login. Staff panel login stays on the LAN IP."
  echo "  6. If Cloudflare shows 502 Host Error: cloudflared or nginx is down — run: $0 status"
  echo "  7. If /pay/ returns 403: remove leftover dist/pay/ or re-run public-host / reinstall nginx config"
  echo "  8. If SSH/panel dies later: sudo bash /opt/mt-billing/install/mt-billing-twingate.sh emergency-restore"
}

case "$ACTION" in
  apply) do_apply ;;
  start)
    # Prefer explicit token/hostname; fall back to DB only if needed
    if [[ -z "$TOKEN" ]]; then
      if [[ "$FROM_DB" == "1" ]] || [[ -f "$DB_PATH" ]]; then
        read_from_db || true
      fi
    fi
    if [[ -z "$HOSTNAME" && -f "$DB_PATH" ]]; then
      HOSTNAME="$(db_query "SELECT IFNULL(cf_tunnel_hostname,'') FROM app_settings WHERE id = 1;" 2>/dev/null || true)"
    fi
    do_start
    ;;
  stop) do_stop ;;
  status) do_status ;;
  uninstall) do_uninstall ;;
  *)
    log_err "Unknown action: $ACTION"
    exit 1
    ;;
esac
