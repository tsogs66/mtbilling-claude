#!/usr/bin/env bash
# Copyright (c) 2026 MT-Billing / ts0gs
# License: MIT
#
# Keep the panel reachable when Twingate rewrites DNS/routes.
# Twingate periodically puts 100.95.* first in resolv.conf; if the client is
# offline/authenticating (or TUN missing), SSH/panel login die "after a while".
#
# Install (root):
#   sudo bash /opt/mt-billing/install/mt-billing-net-watchdog.sh install
# Manual check:
#   sudo bash /opt/mt-billing/install/mt-billing-net-watchdog.sh once
#
# Runs via systemd timer every 60s when installed.

set -euo pipefail

INSTALL_DIR="${var_install_dir:-${INSTALL_DIR:-/opt/mt-billing}}"
MT_CONF="${MT_CONF:-/etc/mt-billing}"
RESOLV_BAK="${MT_CONF}/resolv.conf.twingate-bak"
COEXIST_STATE="${MT_CONF}/net-coexist.state"
LOG="${MT_CONF}/net-watchdog.log"
AUTH_STAMP="${MT_CONF}/twingate-authenticating.since"
UNIT_NAME="twingate.service"
WATCH_UNIT="mt-billing-net-watchdog.service"
WATCH_TIMER="mt-billing-net-watchdog.timer"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TG_SCRIPT="${SCRIPT_DIR}/mt-billing-twingate.sh"
COEXIST_SCRIPT="${SCRIPT_DIR}/mt-billing-net-coexist.sh"

mkdir -p "$MT_CONF"
exec >>"$LOG" 2>&1 || true

log() { printf '%s %s\n' "$(date -Is)" "$*"; }

tg_status() {
  if ! command -v twingate >/dev/null 2>&1; then
    echo "not-installed"
    return 0
  fi
  # Bare `twingate status` can hang forever on flash images — never block the watchdog
  if command -v timeout >/dev/null 2>&1; then
    timeout --signal=KILL 3s twingate status 2>/dev/null || echo offline
  else
    twingate status 2>/dev/null || echo offline
  fi
}

first_nameserver() {
  grep -E '^\s*nameserver\s+' /etc/resolv.conf 2>/dev/null | head -1 | awk '{print $2}'
}

dns_ok() {
  getent hosts cloudflare.com >/dev/null 2>&1 && return 0
  getent hosts 1.1.1.1 >/dev/null 2>&1 && return 0
  timeout 3 bash -c 'echo >/dev/tcp/1.1.1.1/443' 2>/dev/null && return 0
  return 1
}

gateway_ok() {
  local gw
  gw="$(ip route show default 2>/dev/null | awk '/default/ {print $3; exit}')"
  [[ -n "$gw" ]] || return 1
  ping -c1 -W2 "$gw" >/dev/null 2>&1 && return 0
  return 0 # route exists even if ICMP blocked
}

default_via_sdwan() {
  local def_dev
  def_dev="$(ip route show default 2>/dev/null | awk '/default/ {print $5; exit}')"
  [[ "$def_dev" == "sdwan0" ]]
}

rewrite_safe_dns() {
  if [[ -f "$COEXIST_SCRIPT" ]]; then
    # shellcheck disable=SC1090
    source "$COEXIST_SCRIPT"
    if declare -F write_coexist_resolv >/dev/null 2>&1; then
      write_coexist_resolv
      return 0
    fi
  fi
  {
    echo "# MT-Billing net-watchdog safe DNS"
    if [[ -f "$RESOLV_BAK" ]]; then
      grep -E '^\s*nameserver\s+' "$RESOLV_BAK" || true
    fi
    echo "nameserver 8.8.8.8"
    echo "nameserver 1.1.1.1"
    echo "nameserver 9.9.9.9"
  } >/etc/resolv.conf
}

restore_uplink() {
  if [[ -f "$COEXIST_STATE" ]]; then
    # shellcheck disable=SC1090
    source "$COEXIST_STATE" 2>/dev/null || true
    if [[ -n "${COEXIST_DEFAULT_GW:-}" && -n "${COEXIST_DEFAULT_DEV:-}" ]]; then
      ip route del default dev sdwan0 2>/dev/null || true
      ip route replace default via "$COEXIST_DEFAULT_GW" dev "$COEXIST_DEFAULT_DEV" 2>/dev/null || true
      return 0
    fi
  fi
  ip route del default dev sdwan0 2>/dev/null || true
}

emergency_stop_twingate() {
  log "WATCHDOG: stopping Twingate to restore panel connectivity"
  if [[ -f "$TG_SCRIPT" ]]; then
    bash "$TG_SCRIPT" emergency-restore || true
  else
    systemctl mask "$UNIT_NAME" 2>/dev/null || true
    systemctl stop "$UNIT_NAME" 2>/dev/null || true
    pkill -9 twingated 2>/dev/null || true
    ip link delete sdwan0 2>/dev/null || true
    rewrite_safe_dns
    restore_uplink
  fi
  rm -f "$AUTH_STAMP"
}

run_once() {
  local st ns
  st="$(tg_status)"
  ns="$(first_nameserver)"

  # Always reclaim DNS if Twingate shoved 100.95.* to the front
  if [[ "${ns:-}" == 100.95.* ]]; then
    log "WATCHDOG: first DNS is ${ns} (Twingate) — rewriting public/local first"
    rewrite_safe_dns
  fi

  if default_via_sdwan; then
    log "WATCHDOG: default route via sdwan0 — restoring uplink"
    restore_uplink
  fi

  # Client unhealthy for too long while DNS/gateway broken → full restore
  case "$st" in
    online)
      rm -f "$AUTH_STAMP"
      # Keep coexist DNS while online (Twingate may rewrite again)
      if [[ "$(first_nameserver)" == 100.95.* ]]; then
        rewrite_safe_dns
      fi
      ;;
    authenticating)
      if [[ ! -f "$AUTH_STAMP" ]]; then
        date +%s >"$AUTH_STAMP"
      fi
      local since now age
      since="$(cat "$AUTH_STAMP" 2>/dev/null || echo 0)"
      now="$(date +%s)"
      age=$((now - since))
      # Keep safe DNS while authenticating
      rewrite_safe_dns
      if [[ "$age" -gt 120 ]] && ! dns_ok; then
        log "WATCHDOG: authenticating >2m and DNS broken — emergency restore"
        emergency_stop_twingate
      elif [[ "$age" -gt 180 ]]; then
        # Even if DNS looks OK briefly, stuck authenticating on PC/RPi usually
        # means Twingate will rewrite resolv.conf again and kill SSH/panel.
        log "WATCHDOG: authenticating >3m — emergency restore (prevent disconnect loop)"
        emergency_stop_twingate
      fi
      ;;
    not-running|offline|error|not-installed|not-configured|"")
      rm -f "$AUTH_STAMP"
      if [[ -c /dev/net/tun ]] || command -v twingate >/dev/null 2>&1; then
        # Twingate present but not healthy: if DNS broken or still Twingate-first, stop it
        if ! dns_ok || [[ "$(first_nameserver)" == 100.95.* ]] || default_via_sdwan; then
          if systemctl is-active --quiet "$UNIT_NAME" 2>/dev/null \
            || systemctl is-enabled --quiet "$UNIT_NAME" 2>/dev/null \
            || pgrep -x twingated >/dev/null 2>&1; then
            log "WATCHDOG: status=${st} and network unhealthy — emergency restore"
            emergency_stop_twingate
          else
            rewrite_safe_dns
            restore_uplink
          fi
        fi
      fi
      ;;
    *)
      rewrite_safe_dns
      ;;
  esac

  # Last resort: DNS still broken
  if ! dns_ok; then
    log "WATCHDOG: DNS still failing — writing public resolvers + stopping Twingate if present"
    {
      echo "nameserver 8.8.8.8"
      echo "nameserver 1.1.1.1"
      echo "nameserver 9.9.9.9"
    } >/etc/resolv.conf
    restore_uplink
    if pgrep -x twingated >/dev/null 2>&1 || systemctl is-active --quiet "$UNIT_NAME" 2>/dev/null; then
      emergency_stop_twingate
    fi
  fi

  # Keep local panel + Cloudflare tunnel up (502 Bad gateway = host side dead)
  ensure_local_panel
}

FAIL_FILE="${MT_CONF}/watchdog-panel-fail.count"
REBOOT_STAMP="${MT_CONF}/watchdog-last-reboot"

panel_local_ok() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --connect-timeout 2 --max-time 4 -o /dev/null http://127.0.0.1/login 2>/dev/null && return 0
  fi
  timeout 2 bash -c 'echo >/dev/tcp/127.0.0.1/80' 2>/dev/null && return 0
  return 1
}

ensure_local_panel() {
  if panel_local_ok; then
    rm -f "$FAIL_FILE"
    return 0
  fi

  local fails=0
  fails="$(cat "$FAIL_FILE" 2>/dev/null || echo 0)"
  fails=$((fails + 1))
  echo "$fails" >"$FAIL_FILE"
  log "WATCHDOG: local panel :80 not OK (fail #${fails}) — restarting nginx/api/cloudflared"

  systemctl reset-failed nginx mt-billing-api cloudflared-mt-billing 2>/dev/null || true
  systemctl try-restart nginx 2>/dev/null || systemctl start nginx 2>/dev/null || true
  systemctl try-restart mt-billing-api 2>/dev/null || systemctl start mt-billing-api 2>/dev/null || true
  if systemctl list-unit-files cloudflared-mt-billing.service >/dev/null 2>&1; then
    systemctl try-restart cloudflared-mt-billing 2>/dev/null || systemctl start cloudflared-mt-billing 2>/dev/null || true
  fi

  # After ~5 minutes of continuous failure (10 x 30s), soft-reboot once/hour
  # so RPi recovers without a hard power-off.
  if [[ "$fails" -ge 10 ]]; then
    local last now
    last="$(cat "$REBOOT_STAMP" 2>/dev/null || echo 0)"
    now="$(date +%s)"
    if [[ $((now - last)) -gt 3600 ]]; then
      log "WATCHDOG: panel still down after ${fails} checks — soft reboot (avoid power-cycle)"
      date +%s >"$REBOOT_STAMP"
      rm -f "$FAIL_FILE"
      # Prefer orderly reboot; flash appliances often only recover this way
      systemctl reboot || /sbin/reboot || true
    else
      log "WATCHDOG: soft-reboot skipped (already rebooted within 1h)"
    fi
  fi
}

install_timer() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "Run as root" >&2
    exit 1
  fi
  local self
  self="$(readlink -f "$0" 2>/dev/null || echo "$0")"

  cat >"/etc/systemd/system/${WATCH_UNIT}" <<EOF
[Unit]
Description=MT-Billing network watchdog (Twingate DNS/route protection)
After=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash ${self} once
Nice=10
EOF

  cat >"/etc/systemd/system/${WATCH_TIMER}" <<EOF
[Unit]
Description=Run MT-Billing network watchdog every minute

[Timer]
OnBootSec=30s
OnUnitActiveSec=30s
AccuracySec=10s
Persistent=true

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable --now "$WATCH_TIMER"
  log "Installed and started ${WATCH_TIMER}"
  echo "OK: ${WATCH_TIMER} enabled (every 60s). Log: ${LOG}"
}

uninstall_timer() {
  systemctl disable --now "$WATCH_TIMER" 2>/dev/null || true
  rm -f "/etc/systemd/system/${WATCH_TIMER}" "/etc/systemd/system/${WATCH_UNIT}"
  systemctl daemon-reload 2>/dev/null || true
  echo "OK: watchdog timer removed"
}

ACTION="${1:-once}"
case "$ACTION" in
  once) run_once ;;
  install) install_timer ;;
  uninstall) uninstall_timer ;;
  *)
    echo "Usage: $0 once|install|uninstall" >&2
    exit 1
    ;;
esac
