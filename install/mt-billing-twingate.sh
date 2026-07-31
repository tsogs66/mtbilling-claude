#!/usr/bin/env bash
# Copyright (c) 2026 MT-Billing / ts0gs
# License: MIT
# Source: https://github.com/tsogs66/MT-Billing
#
# Install and run the Twingate Linux Client (headless) so MT-Billing can reach
# OLTs / routers / switches on remote or different subnets via Twingate ZTNA.
#
# Twingate Admin Console prerequisites:
#   1. Remote Network + Connector online inside the target LAN
#   2. Resources (CIDRs / device IPs) on that remote network
#   3. Services → create Service Account → generate Service Key (JSON)
#   4. Grant the Service Account access to those Resources
#
# Usage (inside the MT-Billing guest as root):
#   sudo bash /opt/mt-billing/install/mt-billing-twingate.sh --from-db apply
#   sudo bash /opt/mt-billing/install/mt-billing-twingate.sh --key-file /path/key.json apply
#   sudo bash /opt/mt-billing/install/mt-billing-twingate.sh start
#   sudo bash /opt/mt-billing/install/mt-billing-twingate.sh stop
#   sudo bash /opt/mt-billing/install/mt-billing-twingate.sh status
#   sudo bash /opt/mt-billing/install/mt-billing-twingate.sh uninstall
#
# Options:
#   --from-db         Read Service Key JSON from app_settings.twingate_service_key
#   --key-file PATH   Use Service Key JSON from a file
#   --no-start        Install/configure but do not start
#   -h|--help

set -euo pipefail

INSTALL_DIR="${var_install_dir:-${INSTALL_DIR:-/opt/mt-billing}}"
DB_PATH="${INSTALL_DIR}/server/data/mt-billing.db"
CONF_DIR="/etc/twingate"
KEY_FILE="${CONF_DIR}/service_key.json"
UNIT_NAME="twingate.service"

FROM_DB=0
KEY_PATH=""
NO_START=0
ACTION=""

log_info() { printf '\033[1;34m[INFO]\033[0m %s\n' "$*"; }
log_ok() { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
log_err() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; }
log_warn() { printf '\033[1;33m[WARN]\033[0m %s\n' "$*"; }

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-db) FROM_DB=1; shift ;;
    --key-file) KEY_PATH="${2:-}"; shift 2 ;;
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

if [[ -z "$ACTION" ]]; then
  ACTION="apply"
fi

if [[ "$(id -u)" -ne 0 ]]; then
  log_err "Run as root (e.g. sudo bash $0 --from-db apply)"
  exit 1
fi

ensure_sqlite3() {
  if command -v sqlite3 >/dev/null 2>&1; then
    return 0
  fi
  log_info "Installing sqlite3 CLI (needed to read/write app_settings)"
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sqlite3 >/dev/null || true
  fi
  command -v sqlite3 >/dev/null 2>&1
}

set_db_status() {
  local status="$1"
  local network="${2:-}"
  ensure_sqlite3 || return 0
  [[ -f "$DB_PATH" ]] || return 0
  # Ensure columns exist (idempotent for older DBs before panel migrate)
  sqlite3 "$DB_PATH" "ALTER TABLE app_settings ADD COLUMN twingate_status TEXT;" 2>/dev/null || true
  sqlite3 "$DB_PATH" "ALTER TABLE app_settings ADD COLUMN twingate_network TEXT;" 2>/dev/null || true
  sqlite3 "$DB_PATH" "ALTER TABLE app_settings ADD COLUMN twingate_enabled INTEGER DEFAULT 0;" 2>/dev/null || true
  if [[ -n "$network" ]]; then
    sqlite3 "$DB_PATH" "UPDATE app_settings SET twingate_status = '${status//\'/\'\'}', twingate_network = '${network//\'/\'\'}', twingate_enabled = $([[ "$status" == online ]] && echo 1 || echo 0) WHERE id = 1;" 2>/dev/null || true
  else
    sqlite3 "$DB_PATH" "UPDATE app_settings SET twingate_status = '${status//\'/\'\'}', twingate_enabled = $([[ "$status" == online ]] && echo 1 || echo 0) WHERE id = 1;" 2>/dev/null || true
  fi
}

read_key_from_db() {
  ensure_sqlite3 || {
    log_err "sqlite3 CLI required for --from-db"
    exit 1
  }
  [[ -f "$DB_PATH" ]] || {
    log_err "Database not found: $DB_PATH"
    exit 1
  }
  local key
  key="$(sqlite3 "$DB_PATH" "SELECT IFNULL(twingate_service_key,'') FROM app_settings WHERE id = 1;" 2>/dev/null || true)"
  if [[ -z "$key" ]]; then
    log_err "No Twingate Service Key in app_settings — paste it in Network → Twingate first."
    exit 1
  fi
  mkdir -p "$CONF_DIR"
  printf '%s' "$key" >"$KEY_FILE"
  chmod 600 "$KEY_FILE"
  log_ok "Wrote Service Key to $KEY_FILE"
}

install_twingate_client() {
  if command -v twingate >/dev/null 2>&1 && [[ -x /usr/sbin/twingated ]]; then
    log_ok "Twingate client already installed: $(twingate version 2>/dev/null | head -1 || echo ok)"
    return 0
  fi
  log_info "Installing Twingate Linux Client"
  if ! curl -fsSL https://binaries.twingate.com/client/linux/install.sh | bash; then
    log_err "Twingate install script failed"
    exit 1
  fi
  if ! command -v twingate >/dev/null 2>&1; then
    log_err "twingate binary missing after install"
    exit 1
  fi
  log_ok "Installed $(twingate version 2>/dev/null | head -1 || echo twingate)"
}

configure_headless() {
  if [[ ! -f "$KEY_FILE" ]]; then
    log_err "Service Key file missing: $KEY_FILE"
    exit 1
  fi
  # Basic JSON sanity
  if ! grep -q '"network"' "$KEY_FILE" || ! grep -q '"private_key"' "$KEY_FILE"; then
    log_err "Service Key JSON looks invalid (missing network / private_key)"
    exit 1
  fi
  log_info "Configuring Twingate headless client"
  twingate setup --headless "$KEY_FILE"
  log_ok "Headless setup complete"
}

network_from_key() {
  if [[ -f "$KEY_FILE" ]]; then
    # Prefer python if present; else sed-ish extract
    if command -v python3 >/dev/null 2>&1; then
      python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("network",""))' "$KEY_FILE" 2>/dev/null || true
      return 0
    fi
    sed -n 's/.*"network"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$KEY_FILE" | head -1
  fi
}

do_start() {
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    systemctl enable "$UNIT_NAME" >/dev/null 2>&1 || true
    systemctl restart "$UNIT_NAME" || twingate start || true
    sleep 2
    if systemctl is-active --quiet "$UNIT_NAME" 2>/dev/null || [[ "$(twingate status 2>/dev/null || true)" == "online" ]]; then
      local net
      net="$(network_from_key)"
      set_db_status online "$net"
      log_ok "Twingate is online"
      return 0
    fi
    log_err "Twingate failed to come online — check: journalctl -u twingate -n 50"
    set_db_status offline
    return 1
  fi
  # Non-systemd (dev / containers): start daemon directly
  mkdir -p /var/lib/twingate /run/twingate
  chmod 711 /var/lib/twingate
  chmod 755 /run/twingate
  pkill -9 twingated 2>/dev/null || true
  sleep 1
  (cd /var/lib/twingate && /usr/sbin/twingated >/var/log/twingated.log 2>&1 &) || true
  sleep 3
  if [[ "$(twingate status 2>/dev/null || true)" == "online" ]]; then
    set_db_status online "$(network_from_key)"
    log_ok "Twingate is online (direct daemon)"
    return 0
  fi
  log_warn "Twingate status: $(twingate status 2>/dev/null || echo unknown)"
  set_db_status offline
  return 1
}

do_stop() {
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    systemctl stop "$UNIT_NAME" 2>/dev/null || true
    twingate stop 2>/dev/null || true
  else
    twingate stop 2>/dev/null || true
    pkill -9 twingated 2>/dev/null || true
  fi
  set_db_status stopped
  log_ok "Twingate stopped"
}

do_status() {
  local installed=no
  local st=not-configured
  local net=""
  local resources=0
  if command -v twingate >/dev/null 2>&1; then
    installed=yes
    st="$(twingate status 2>/dev/null || echo offline)"
    net="$(network_from_key)"
    if [[ "$st" == "online" ]]; then
      resources="$(twingate resources 2>/dev/null | grep -cve '^\s*$' || true)"
      # Header line often present — clamp
      if [[ "$resources" -gt 0 ]]; then
        resources=$((resources > 1 ? resources - 1 : resources))
      fi
    fi
  fi
  # Prefer live status; fall back to DB
  if [[ "$st" == "online" ]]; then
    set_db_status online "$net"
  elif [[ "$installed" == "yes" ]]; then
    set_db_status offline "$net"
  fi
  echo "status=${st}"
  echo "installed=${installed}"
  echo "network=${net}"
  echo "resources=${resources}"
}

do_uninstall() {
  do_stop || true
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable "$UNIT_NAME" 2>/dev/null || true
  fi
  if command -v apt-get >/dev/null 2>&1 && dpkg -l twingate >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get remove -y -qq twingate >/dev/null || true
  fi
  rm -f "$KEY_FILE"
  set_db_status uninstalled
  log_ok "Twingate client removed (Service Key cleared from disk; DB key kept)"
}

do_apply() {
  if [[ "$FROM_DB" -eq 1 ]]; then
    read_key_from_db
  elif [[ -n "$KEY_PATH" ]]; then
    [[ -f "$KEY_PATH" ]] || {
      log_err "Key file not found: $KEY_PATH"
      exit 1
    }
    mkdir -p "$CONF_DIR"
    cp -f "$KEY_PATH" "$KEY_FILE"
    chmod 600 "$KEY_FILE"
  elif [[ ! -f "$KEY_FILE" ]]; then
    log_err "Provide --from-db or --key-file PATH"
    exit 1
  fi

  install_twingate_client
  configure_headless
  if [[ "$NO_START" -eq 1 ]]; then
    set_db_status configured "$(network_from_key)"
    log_ok "Configured (not started)"
    return 0
  fi
  do_start
}

case "$ACTION" in
  apply) do_apply ;;
  start) do_start ;;
  stop) do_stop ;;
  status) do_status ;;
  uninstall) do_uninstall ;;
  *)
    log_err "Unknown action: $ACTION"
    exit 1
    ;;
esac
