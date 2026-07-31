#!/usr/bin/env bash
# Copyright (c) 2026 MT-Billing / ts0gs
# License: MIT
# Source: https://github.com/tsogs66/MT-Billing
#
# Install and run the Twingate Linux Client (headless) so MT-Billing can reach
# OLTs / routers / switches on remote or different subnets via Twingate ZTNA.
#
# IMPORTANT — network safety:
#   Twingate rewrites /etc/resolv.conf to 100.95.0.251–254. If the Connector is
#   offline, that DNS path fails and the whole host looks "disconnected"
#   (panel updater, Cloudflare, apt, outbound API). This script:
#     • backs up resolv.conf before start
#     • appends public/local DNS fallbacks after start
#     • health-checks connectivity and auto-rolls back on failure
#     • always restores DNS on stop / uninstall / emergency-restore
#
# Twingate Admin Console prerequisites:
#   1. Remote Network + Connector online inside the target LAN
#   2. Resources (prefer specific device IPs — avoid broad CIDRs that overlap
#      this panel's own LAN or you will blackhole local traffic)
#   3. Services → Service Account → Service Key (JSON)
#   4. Grant the Service Account access to those Resources
#
# Usage (inside the MT-Billing guest as root):
#   # Panel Install & connect writes a key file and calls --key-file (no sqlite3 CLI):
#   sudo bash /opt/mt-billing/install/mt-billing-twingate.sh --key-file /path/key.json apply
#   # Manual / SSH (optional; needs sqlite3 CLI or python3):
#   sudo bash /opt/mt-billing/install/mt-billing-twingate.sh --from-db apply
#   sudo bash /opt/mt-billing/install/mt-billing-twingate.sh start
#   sudo bash /opt/mt-billing/install/mt-billing-twingate.sh stop
#   sudo bash /opt/mt-billing/install/mt-billing-twingate.sh status
#   sudo bash /opt/mt-billing/install/mt-billing-twingate.sh emergency-restore
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
MT_CONF="/etc/mt-billing"
KEY_FILE="${CONF_DIR}/service_key.json"
RESOLV_BAK="${MT_CONF}/resolv.conf.twingate-bak"
UNIT_NAME="twingate.service"

# Shared Cloudflare + Twingate LAN/DNS coexistence helpers
COEXIST_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/mt-billing-net-coexist.sh"
if [[ -f "$COEXIST_SCRIPT" ]]; then
  # shellcheck disable=SC1090
  source "$COEXIST_SCRIPT"
else
  for p in \
    "${INSTALL_DIR}/install/mt-billing-net-coexist.sh" \
    /opt/mt-billing/install/mt-billing-net-coexist.sh; do
    if [[ -f "$p" ]]; then
      # shellcheck disable=SC1090
      source "$p"
      break
    fi
  done
fi

FROM_DB=0
KEY_PATH=""
NO_START=0
ACTION=""

log_info() { printf '\033[1;34m[INFO]\033[0m %s\n' "$*"; }
log_ok() { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
log_err() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; }
log_warn() { printf '\033[1;33m[WARN]\033[0m %s\n' "$*"; }

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from-db) FROM_DB=1; shift ;;
    --key-file) KEY_PATH="${2:-}"; shift 2 ;;
    --no-start) NO_START=1; shift ;;
    start|stop|status|uninstall|apply|emergency-restore)
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

# The Node panel talks to SQLite via better-sqlite3 and passes --key-file for
# apply/start — it never needs the sqlite3 CLI. CLI is only for manual
# --from-db / best-effort set_db_status when operators run the script by hand.
ensure_sqlite3() {
  if command -v sqlite3 >/dev/null 2>&1; then
    return 0
  fi
  log_info "Installing sqlite3 CLI (needed for --from-db / optional status writes)"
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null 2>&1 || true
    apt-get install -y -qq sqlite3 >/dev/null 2>&1 || log_warn "apt could not install sqlite3 (stale index/404?) — will try python3 fallback"
  fi
  command -v sqlite3 >/dev/null 2>&1
}

# Run a SQL statement against DB_PATH. Prefers sqlite3 CLI; falls back to python3.
# Prints first column of first row when the statement returns rows.
sqlite3_q() {
  local sql="$1"
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB_PATH" "$sql"
    return $?
  fi
  if command -v python3 >/dev/null 2>&1; then
    SQLITE_DB="$DB_PATH" SQLITE_SQL="$sql" python3 - <<'PY'
import os, sqlite3, sys
db, sql = os.environ["SQLITE_DB"], os.environ["SQLITE_SQL"]
con = sqlite3.connect(db)
try:
    cur = con.execute(sql)
    con.commit()
    row = cur.fetchone()
    if row is not None and len(row) > 0:
        print("" if row[0] is None else row[0])
except Exception:
    sys.exit(1)
finally:
    con.close()
PY
    return $?
  fi
  return 1
}

set_db_status() {
  local status="$1"
  local network="${2:-}"
  [[ -f "$DB_PATH" ]] || return 0
  ensure_sqlite3 || true
  sqlite3_q "ALTER TABLE app_settings ADD COLUMN twingate_status TEXT;" 2>/dev/null || true
  sqlite3_q "ALTER TABLE app_settings ADD COLUMN twingate_network TEXT;" 2>/dev/null || true
  sqlite3_q "ALTER TABLE app_settings ADD COLUMN twingate_enabled INTEGER DEFAULT 0;" 2>/dev/null || true
  if [[ -n "$network" ]]; then
    sqlite3_q "UPDATE app_settings SET twingate_status = '${status//\'/\'\'}', twingate_network = '${network//\'/\'\'}', twingate_enabled = $([[ "$status" == online || "$status" == authenticating ]] && echo 1 || echo 0) WHERE id = 1;" 2>/dev/null || true
  else
    sqlite3_q "UPDATE app_settings SET twingate_status = '${status//\'/\'\'}', twingate_enabled = $([[ "$status" == online || "$status" == authenticating ]] && echo 1 || echo 0) WHERE id = 1;" 2>/dev/null || true
  fi
}

backup_resolv() {
  mkdir -p "$MT_CONF"
  # Only snapshot non-Twingate resolv.conf so we don't "backup" the broken one
  if [[ -f /etc/resolv.conf ]] && ! grep -qE 'managed by twingate|100\.95\.0\.25' /etc/resolv.conf 2>/dev/null; then
    cp -a /etc/resolv.conf "$RESOLV_BAK"
    log_ok "Backed up DNS config → $RESOLV_BAK"
  elif [[ ! -f "$RESOLV_BAK" ]]; then
    # Invent a sane fallback backup
    {
      echo "nameserver 8.8.8.8"
      echo "nameserver 1.1.1.1"
      echo "nameserver 9.9.9.9"
    } >"$RESOLV_BAK"
    log_warn "No clean resolv.conf to back up — wrote public DNS fallback to $RESOLV_BAK"
  fi
}

restore_resolv() {
  if [[ -f "$RESOLV_BAK" ]]; then
    cp -a "$RESOLV_BAK" /etc/resolv.conf
    log_ok "Restored DNS from $RESOLV_BAK"
  else
    {
      echo "nameserver 8.8.8.8"
      echo "nameserver 1.1.1.1"
      echo "nameserver 9.9.9.9"
    } >/etc/resolv.conf
    log_warn "No DNS backup found — wrote public DNS resolvers"
  fi
}

# Twingate replaces resolv.conf with ONLY 100.95.* nameservers. Prefer the
# shared coexist DNS writer (local/public first, Twingate last) so Cloudflare
# Tunnel and LAN keep working. Fall back to appending public DNS if the helper
# is unavailable.
augment_resolv_fallbacks() {
  if declare -F write_coexist_resolv >/dev/null 2>&1; then
    write_coexist_resolv
    return 0
  fi
  local tmp
  tmp="$(mktemp)"
  if [[ -f /etc/resolv.conf ]]; then
    cat /etc/resolv.conf >"$tmp"
  fi
  {
    echo ""
    echo "# MT-Billing: DNS fallbacks so the panel stays reachable if Twingate DNS is down"
    if [[ -f "$RESOLV_BAK" ]]; then
      grep -E '^\s*nameserver\s+' "$RESOLV_BAK" || true
    fi
    echo "nameserver 8.8.8.8"
    echo "nameserver 1.1.1.1"
  } >>"$tmp"
  awk '
    /^[[:space:]]*nameserver[[:space:]]+/ {
      if (!seen[$0]++) print
      next
    }
    { print }
  ' "$tmp" >/etc/resolv.conf
  rm -f "$tmp"
  log_ok "Added DNS fallbacks to /etc/resolv.conf"
}

apply_coexist_after_twingate() {
  if declare -F apply_net_coexist >/dev/null 2>&1; then
    apply_net_coexist || log_warn "Coexistence helper reported a warning — check LAN/DNS"
  else
    augment_resolv_fallbacks
    log_warn "mt-billing-net-coexist.sh missing — applied DNS fallbacks only"
  fi
  install_net_watchdog || true
}

install_net_watchdog() {
  local wd
  wd="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/mt-billing-net-watchdog.sh"
  if [[ ! -f "$wd" ]]; then
    wd="${INSTALL_DIR}/install/mt-billing-net-watchdog.sh"
  fi
  if [[ -f "$wd" ]]; then
    bash "$wd" install >/dev/null 2>&1 || bash "$wd" install || true
    log_ok "Network watchdog timer enabled (protects SSH/panel if Twingate rewrites DNS)"
  fi
}

cleanup_sdwan() {
  ip link delete sdwan0 2>/dev/null || true
  # Drop host-scope Twingate routes that may linger after a hard kill
  ip route show | awk '/dev sdwan0/ {print $0}' | while read -r line; do
    # shellcheck disable=SC2086
    ip route del $line 2>/dev/null || true
  done
}

kill_daemon_hard() {
  # Mask first so Restart=on-failure cannot crash-loop and keep rewriting DNS/routes
  # (that is what kills SSH on RPi/Wyse during a bad apply).
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    systemctl mask "$UNIT_NAME" 2>/dev/null || true
    systemctl stop "$UNIT_NAME" 2>/dev/null || true
    systemctl disable "$UNIT_NAME" 2>/dev/null || true
    systemctl reset-failed "$UNIT_NAME" 2>/dev/null || true
  fi
  twingate stop 2>/dev/null || true
  pkill -9 twingated 2>/dev/null || true
  pkill -9 -f '/usr/sbin/twingated' 2>/dev/null || true
  sleep 1
  cleanup_sdwan
}

# Allow start again after emergency-restore / successful configure
unmask_twingate_unit() {
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    systemctl unmask "$UNIT_NAME" 2>/dev/null || true
    # Prevent crash-loops from taking down SSH while we try to come online
    mkdir -p /etc/systemd/system/twingate.service.d
    cat >/etc/systemd/system/twingate.service.d/mt-billing-restart.conf <<'EOF'
# MT-Billing: do not auto-restart on failure — crash-loops rewrite DNS and kill SSH.
[Service]
Restart=no
EOF
    systemctl daemon-reload 2>/dev/null || true
  fi
}

restore_default_route() {
  local state="${MT_CONF}/net-coexist.state"
  if [[ -f "$state" ]]; then
    # shellcheck disable=SC1090
    source "$state" 2>/dev/null || true
    if [[ -n "${COEXIST_DEFAULT_GW:-}" && -n "${COEXIST_DEFAULT_DEV:-}" ]]; then
      ip route del default dev sdwan0 2>/dev/null || true
      ip route replace default via "$COEXIST_DEFAULT_GW" dev "$COEXIST_DEFAULT_DEV" 2>/dev/null \
        || ip route add default via "$COEXIST_DEFAULT_GW" dev "$COEXIST_DEFAULT_DEV" 2>/dev/null \
        || true
      log_ok "Restored default route via ${COEXIST_DEFAULT_GW} dev ${COEXIST_DEFAULT_DEV}"
      return 0
    fi
  fi
  # Drop Twingate default if it stole the uplink
  local def_dev
  def_dev="$(ip route show default 2>/dev/null | awk '/default/ {print $5; exit}')"
  if [[ "$def_dev" == "sdwan0" ]]; then
    ip route del default dev sdwan0 2>/dev/null || true
    log_warn "Removed default route via sdwan0 — run DHCP renew if still offline: dhclient -v || networkctl reconfigure"
  fi
}

gateway_reachable() {
  local gw
  gw="$(ip route show default 2>/dev/null | awk '/default/ {print $3; exit}')"
  [[ -n "$gw" ]] || return 1
  # ICMP may be blocked — also accept ARP/neigh presence via ping -c1 -W2
  ping -c1 -W2 "$gw" >/dev/null 2>&1 && return 0
  # Fallback: can we open a TCP connection to a well-known public IP?
  timeout 3 bash -c 'echo >/dev/tcp/1.1.1.1/443' 2>/dev/null && return 0
  return 1
}

dns_works() {
  # Prefer getent; fall back to python
  if getent hosts github.com >/dev/null 2>&1; then
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY' >/dev/null 2>&1
import socket
socket.getaddrinfo("github.com", 443, proto=socket.IPPROTO_TCP)
PY
    return $?
  fi
  return 1
}

health_check_or_rollback() {
  local i
  log_info "Health-checking network after Twingate start (up to 20s)…"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if gateway_reachable && dns_works; then
      log_ok "Network health OK (gateway + DNS)"
      return 0
    fi
    sleep 2
  done
  log_err "Network unhealthy after Twingate start — rolling back to restore panel connectivity"
  kill_daemon_hard
  restore_resolv
  set_db_status error
  log_err "Twingate was stopped and DNS restored. Fix Connector / Resources in Twingate Admin, then retry."
  log_err "Common cause: Twingate DNS (100.95.*) with offline Connector, or a Resource CIDR overlapping this host's LAN."
  return 1
}

read_key_from_db() {
  [[ -f "$DB_PATH" ]] || {
    log_err "Database not found: $DB_PATH"
    exit 1
  }
  ensure_sqlite3 || true
  local key=""
  key="$(sqlite3_q "SELECT IFNULL(twingate_service_key,'') FROM app_settings WHERE id = 1;" 2>/dev/null || true)"
  if [[ -z "$key" ]]; then
    if ! command -v sqlite3 >/dev/null 2>&1 && ! command -v python3 >/dev/null 2>&1; then
      log_err "Cannot read Service Key from DB (need sqlite3 CLI or python3). Prefer: --key-file PATH"
    else
      log_err "No Twingate Service Key in app_settings — paste it in Network → Twingate first."
    fi
    exit 1
  fi
  mkdir -p "$CONF_DIR"
  printf '%s' "$key" >"$KEY_FILE"
  chmod 600 "$KEY_FILE"
  log_ok "Wrote Service Key to $KEY_FILE"
}

install_twingate_client() {
  ensure_supported_arch || exit 1
  if command -v twingate >/dev/null 2>&1 && [[ -x /usr/sbin/twingated ]]; then
    log_ok "Twingate client already installed: $(twingate version 2>/dev/null | head -1 || echo ok)"
    return 0
  fi
  log_info "Installing Twingate Linux Client (arch=$(host_arch))"
  if ! curl -fsSL https://binaries.twingate.com/client/linux/install.sh | bash; then
    log_err "Twingate install script failed"
    log_err "Supported: Ubuntu/Debian on amd64 or arm64. RPi3 needs mt-billing-rpi-arm64 (64-bit)."
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
    if command -v python3 >/dev/null 2>&1; then
      python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("network",""))' "$KEY_FILE" 2>/dev/null || true
      return 0
    fi
    sed -n 's/.*"network"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$KEY_FILE" | head -1
  fi
}

# Prefer systemd-resolved when present — Twingate integrates cleanly with it
# and is less likely to leave a hard-coded broken resolv.conf behind.
prefer_resolved() {
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    if systemctl list-unit-files systemd-resolved.service >/dev/null 2>&1; then
      systemctl enable --now systemd-resolved 2>/dev/null || true
      if [[ ! -L /etc/resolv.conf ]] && [[ -f /run/systemd/resolve/stub-resolv.conf ]]; then
        backup_resolv
        ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf 2>/dev/null || true
        log_ok "Pointed /etc/resolv.conf at systemd-resolved stub"
      fi
    fi
  fi
}

# Twingate needs /dev/net/tun (creates sdwan0).
# - Proxmox unprivileged LXC: host must passthrough TUN (proxmox-enable-twingate-tun.sh)
# - Bare metal (RPi / Wyse / PC flash): usually just needs `modprobe tun`
print_tun_fix() {
  local in_lxc=0
  if [[ -f /proc/1/environ ]] && tr '\0' '\n' </proc/1/environ 2>/dev/null | grep -q container=lxc; then
    in_lxc=1
  elif [[ -f /run/systemd/container ]] && grep -qi lxc /run/systemd/container 2>/dev/null; then
    in_lxc=1
  elif grep -qaE 'container=lxc|/lxc/' /proc/1/cgroup 2>/dev/null; then
    in_lxc=1
  fi

  log_err "Missing /dev/net/tun — Twingate client cannot create its VPN interface (sdwan0)."
  if [[ "$in_lxc" -eq 1 ]]; then
    log_err "This looks like a Proxmox/LXC guest. Fix on the Proxmox HOST:"
    log_err "  sudo bash scripts/proxmox-enable-twingate-tun.sh <CTID>"
    log_err "  # or:"
    log_err "  echo 'lxc.cgroup2.devices.allow: c 10:200 rwm' >> /etc/pve/lxc/<CTID>.conf"
    log_err "  echo 'lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file' >> /etc/pve/lxc/<CTID>.conf"
    log_err "  pct reboot <CTID>"
  else
    log_err "Bare metal / VM (RPi, Dell Wyse, PC flash image) — try:"
    log_err "  sudo modprobe tun"
    log_err "  ls -l /dev/net/tun"
    log_err "  echo tun | sudo tee /etc/modules-load.d/tun.conf"
    log_err "Then retry Install & connect. If modprobe fails, the kernel lacks TUN support."
  fi
  log_err "Docs: https://www.twingate.com/docs/linux-headless/ (needs /dev/net/tun + NET_ADMIN)"
}

ensure_tun_device() {
  if [[ -c /dev/net/tun ]]; then
    return 0
  fi

  log_warn "/dev/net/tun missing — loading TUN module / creating device node"
  # Bare-metal flash images often ship without tun loaded at boot
  if command -v modprobe >/dev/null 2>&1; then
    modprobe tun 2>/dev/null || true
  fi
  mkdir -p /etc/modules-load.d 2>/dev/null || true
  if [[ ! -f /etc/modules-load.d/tun.conf ]]; then
    echo tun >/etc/modules-load.d/tun.conf 2>/dev/null || true
  fi

  mkdir -p /dev/net 2>/dev/null || true
  if [[ ! -e /dev/net/tun ]]; then
    mknod /dev/net/tun c 10 200 2>/dev/null || true
  fi
  chmod 666 /dev/net/tun 2>/dev/null || true

  # udev sometimes creates it after modprobe
  sleep 1
  if [[ -c /dev/net/tun ]]; then
    log_ok "TUN device ready (/dev/net/tun)"
    return 0
  fi
  print_tun_fix
  return 1
}

host_arch() {
  uname -m 2>/dev/null || echo unknown
}

# Twingate Client packages: amd64 + arm64 only (NOT 32-bit armhf).
ensure_supported_arch() {
  local a
  a="$(host_arch)"
  case "$a" in
    x86_64|amd64|aarch64|arm64)
      return 0
      ;;
    armv7l|armhf|armv6l|armel)
      log_err "Twingate Linux Client does not support 32-bit ARM ($a)."
      log_err "Raspberry Pi 3 must use the 64-bit image: mt-billing-rpi-arm64.img.xz"
      log_err "  (not a 32-bit / armhf OS). Twingate supports amd64 + arm64 only."
      return 1
      ;;
    *)
      log_warn "Unfamiliar CPU arch ($a) — Twingate may not have a package for this board"
      return 0
      ;;
  esac
}

tg_client_status() {
  if ! command -v twingate >/dev/null 2>&1; then
    echo "not-installed"
    return 0
  fi
  # twingate status can hang like "Waiting for status…" — never block the panel
  if command -v timeout >/dev/null 2>&1; then
    timeout --signal=KILL 5s twingate status 2>/dev/null || echo offline
  else
    twingate status 2>/dev/null || echo offline
  fi
}

dump_twingate_logs() {
  log_warn "Recent twingate service logs:"
  if command -v journalctl >/dev/null 2>&1; then
    journalctl -u "$UNIT_NAME" -n 40 --no-pager 2>/dev/null | sed 's/^/  /' || true
  fi
  if [[ -f /var/log/twingated.log ]]; then
    log_warn "Tail of /var/log/twingated.log:"
    tail -n 20 /var/log/twingated.log 2>/dev/null | sed 's/^/  /' || true
  fi
}

# twingate start can hang forever printing "Waiting for status..." when TUN
# is missing or the daemon never becomes ready — always bound it.
run_timeout() {
  local secs="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout --signal=KILL "${secs}s" "$@" 2>/dev/null || return $?
  else
    "$@"
  fi
}

tg_cli_start() {
  log_info "Starting Twingate daemon (timeout 25s — will not hang on 'Waiting for status…')"
  # Prefer systemd; fall back to CLI. Both can block — wrap with timeout.
  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    run_timeout 20 systemctl restart "$UNIT_NAME" || true
    # If still activating/stuck, force-kill and try once more briefly
    if ! systemctl is-active --quiet "$UNIT_NAME" 2>/dev/null; then
      systemctl kill -s SIGKILL "$UNIT_NAME" 2>/dev/null || true
      run_timeout 15 systemctl start "$UNIT_NAME" || true
    fi
  fi
  # CLI start often prints "Waiting for status..." and never exits on flash images
  run_timeout 20 twingate start || log_warn "twingate start timed out or failed (status=$(tg_client_status))"
  sleep 2
}

ensure_client_started() {
  local st
  st="$(tg_client_status)"
  if [[ "$st" == "online" || "$st" == "authenticating" ]]; then
    return 0
  fi
  log_info "Client status is ${st} — starting Twingate daemon"
  # Headless clients have no browser "Accept" step. Service Key auth is automatic
  # once twingated is running and the key + Connector + Resource grants are valid.
  tg_cli_start
  st="$(tg_client_status)"
  if [[ "$st" == "not-running" || "$st" == "offline" || "$st" == "not-installed" ]]; then
    # Re-apply headless setup in case key/config was incomplete
    if [[ -f "$KEY_FILE" ]]; then
      log_info "Re-running headless setup from $KEY_FILE"
      run_timeout 45 twingate setup --headless "$KEY_FILE" || true
      tg_cli_start
    fi
  fi
  st="$(tg_client_status)"
  log_info "Client status after start attempts: ${st}"
  [[ "$st" != "not-running" && "$st" != "not-installed" ]]
}

# Wait until `twingate status` reports online.
# Note: Service Account / headless mode has NO interactive "Accept auth" in Twingate Admin.
wait_for_client_online() {
  local timeout="${1:-60}"
  local i=0
  local st
  local retried_start=0
  log_info "Waiting for Twingate client to reach online (up to ${timeout}s)…"
  while [[ $i -lt $timeout ]]; do
    st="$(tg_client_status)"
    if [[ "$st" == "online" ]]; then
      log_ok "Twingate client status: online"
      return 0
    fi
    if [[ "$st" == "not-running" ]]; then
      log_warn "Client is not-running — daemon did not stay up"
      if [[ "$retried_start" -eq 0 ]]; then
        retried_start=1
        ensure_client_started || true
        st="$(tg_client_status)"
      fi
      if [[ "$st" == "not-running" ]]; then
        return 1
      fi
    fi
    if [[ $((i % 10)) -eq 0 ]]; then
      case "$st" in
        authenticating)
          log_info "Client status: authenticating (Service Key auth is automatic — check Connector Online + Resource grants)"
          ;;
        *)
          log_info "Client status: ${st}"
          ;;
      esac
    fi
    sleep 2
    i=$((i + 2))
  done
  st="$(tg_client_status)"
  log_warn "Timed out waiting for online — current status: ${st}"
  [[ "$st" == "online" ]]
}

do_start() {
  if ! ensure_tun_device; then
    set_db_status error
    return 1
  fi
  backup_resolv
  if declare -F snapshot_default_route >/dev/null 2>&1; then
    snapshot_default_route
  fi
  prefer_resolved
  unmask_twingate_unit

  if command -v systemctl >/dev/null 2>&1 && [[ -d /run/systemd/system ]]; then
    systemctl enable "$UNIT_NAME" >/dev/null 2>&1 || true
    tg_cli_start
    ensure_client_started || true
    apply_coexist_after_twingate

    local unit_ok=0
    systemctl is-active --quiet "$UNIT_NAME" 2>/dev/null && unit_ok=1
    local st
    st="$(tg_client_status)"

    if [[ "$st" == "not-running" ]]; then
      log_err "Twingate client is not-running after start attempts"
      if [[ ! -c /dev/net/tun ]]; then
        print_tun_fix
      else
        log_err "TUN is present but daemon still not-running — see journal below."
        log_err "Common on flash images: run sudo modprobe tun; check journalctl -u twingate -n 50"
        dump_twingate_logs
      fi
      kill_daemon_hard
      restore_resolv
      set_db_status offline
      return 1
    fi

    if [[ "$unit_ok" -ne 1 && "$st" != "online" && "$st" != "authenticating" ]]; then
      log_err "Twingate failed to start (status=${st}) — restoring DNS"
      dump_twingate_logs
      kill_daemon_hard
      restore_resolv
      set_db_status offline
      return 1
    fi

    if ! health_check_or_rollback; then
      return 1
    fi

    if wait_for_client_online 60; then
      set_db_status online "$(network_from_key)"
      log_ok "Twingate is online (Cloudflare + local LAN coexistence applied)"
      return 0
    fi

    st="$(tg_client_status)"
    if [[ "$st" == "not-running" ]]; then
      log_err "Client stayed not-running — daemon crashed or never started"
      dump_twingate_logs
      kill_daemon_hard
      restore_resolv
      set_db_status offline
      return 1
    fi

    # Host DNS/LAN still healthy (coexist). Leave client running so it can finish auth.
    if [[ "$st" == "authenticating" ]] || [[ "$unit_ok" -eq 1 && "$st" != "offline" ]]; then
      set_db_status authenticating "$(network_from_key)"
      log_warn "Client is still authenticating — no Admin 'Accept' click for Service Keys."
      log_warn "  Twingate Admin: Connector Online + grant this Service Account Resources (specific remote IPs)."
      log_warn "Host network is OK (coexistence kept). Re-check status in a minute."
      return 0
    fi

    log_err "Twingate failed to come online (status=${st}) — restoring DNS"
    dump_twingate_logs
    kill_daemon_hard
    restore_resolv
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
  apply_coexist_after_twingate
  if ! health_check_or_rollback; then
    return 1
  fi
  if wait_for_client_online 90; then
    set_db_status online "$(network_from_key)"
    log_ok "Twingate is online (direct daemon, coexistence applied)"
    return 0
  fi
  local st
  st="$(tg_client_status)"
  if [[ "$st" == "authenticating" ]]; then
    set_db_status authenticating "$(network_from_key)"
    log_warn "Client still authenticating — check Connector Online + Resource grants (no Accept click)"
    return 0
  fi
  log_warn "Twingate status: ${st} — restoring DNS"
  dump_twingate_logs
  kill_daemon_hard
  restore_resolv
  set_db_status offline
  return 1
}

do_stop() {
  kill_daemon_hard
  restore_resolv
  set_db_status stopped
  log_ok "Twingate stopped and DNS restored"
}

do_emergency_restore() {
  log_warn "Emergency restore: stopping Twingate and restoring host DNS/routes"
  kill_daemon_hard
  restore_resolv
  restore_default_route
  set_db_status stopped
  install_net_watchdog || true
  # Quick verify
  if dns_works || gateway_reachable; then
    log_ok "Emergency restore complete — network should be usable again"
    log_ok "SSH tip: connect by LAN IP (not hostname) if DNS is still settling"
    return 0
  fi
  # Last resort public DNS
  {
    echo "nameserver 8.8.8.8"
    echo "nameserver 1.1.1.1"
    echo "nameserver 9.9.9.9"
  } >/etc/resolv.conf
  restore_default_route
  # Try DHCP renew on common interfaces
  if command -v dhclient >/dev/null 2>&1; then
    dhclient -r 2>/dev/null || true
    dhclient 2>/dev/null || true
  elif command -v networkctl >/dev/null 2>&1; then
    networkctl reconfigure eth0 enp1s0 wlan0 2>/dev/null || true
  fi
  log_ok "Wrote public DNS fallbacks. Retry SSH by LAN IP."
}

do_status() {
  local installed=no
  local st=not-configured
  local net=""
  local resources=0
  if command -v twingate >/dev/null 2>&1; then
    installed=yes
    st="$(tg_client_status)"
    net="$(network_from_key)"
    if [[ "$st" == "online" ]]; then
      if command -v timeout >/dev/null 2>&1; then
        resources="$(timeout --signal=KILL 5s twingate resources 2>/dev/null | grep -cve '^\s*$' || true)"
      else
        resources="$(twingate resources 2>/dev/null | grep -cve '^\s*$' || true)"
      fi
      if [[ "$resources" -gt 0 ]]; then
        resources=$((resources > 1 ? resources - 1 : resources))
      fi
    fi
  fi
  if [[ "$st" == "online" ]]; then
    set_db_status online "$net"
  elif [[ "$st" == "authenticating" ]]; then
    set_db_status authenticating "$net"
  elif [[ "$installed" == "yes" ]]; then
    set_db_status offline "$net"
  fi
  echo "status=${st}"
  echo "installed=${installed}"
  echo "network=${net}"
  echo "resources=${resources}"
  if [[ -c /dev/net/tun ]]; then
    echo "tun=yes"
  else
    echo "tun=no"
  fi
  echo "arch=$(host_arch)"
  if grep -qE '100\.95\.0\.25' /etc/resolv.conf 2>/dev/null; then
    first_ns="$(grep -E '^\s*nameserver\s+' /etc/resolv.conf | head -1 | awk '{print $2}')"
    if [[ "$first_ns" == 100.95.* ]]; then
      echo "dns=twingate-first"
    else
      echo "dns=coexist"
    fi
  else
    echo "dns=system"
  fi
  if declare -F status_net_coexist >/dev/null 2>&1; then
    status_net_coexist | sed 's/^/coexist_/'
  fi
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
  emergency-restore) do_emergency_restore ;;
  uninstall) do_uninstall ;;
  *)
    log_err "Unknown action: $ACTION"
    exit 1
    ;;
esac
