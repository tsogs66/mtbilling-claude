#!/usr/bin/env bash
# Copyright (c) 2026 MT-Billing / ts0gs
# License: MIT
#
# Boot / soft recovery for flash appliances (RPi / PC).
# When Twingate or a hung tunnel wedges DNS, operators often hard power-off.
# This script restores LAN DNS/routes and restarts the local panel stack so a
# normal reboot (or the watchdog) is enough — no power-cycle required.
#
# Manual (console when SSH is dead):
#   sudo bash /opt/mt-billing/install/mt-billing-boot-heal.sh
#   sudo bash /opt/mt-billing/install/mt-billing-boot-heal.sh install   # enable on every boot
#
# systemd: mt-billing-boot-heal.service (oneshot, every boot)

set -euo pipefail

INSTALL_DIR="${var_install_dir:-${INSTALL_DIR:-/opt/mt-billing}}"
MT_CONF="${MT_CONF:-/etc/mt-billing}"
LOG="${MT_CONF}/boot-heal.log"
UNIT="mt-billing-boot-heal.service"
TG="${INSTALL_DIR}/install/mt-billing-twingate.sh"
WD="${INSTALL_DIR}/install/mt-billing-net-watchdog.sh"

mkdir -p "$MT_CONF"
exec >>"$LOG" 2>&1 || true

log() { printf '%s %s\n' "$(date -Is)" "$*"; }

safe_dns() {
  {
    echo "# MT-Billing boot-heal safe DNS"
    echo "nameserver 8.8.8.8"
    echo "nameserver 1.1.1.1"
    echo "nameserver 9.9.9.9"
  } >/etc/resolv.conf
}

stop_twingate_hard() {
  if [[ -f "$TG" ]]; then
    bash "$TG" emergency-restore >/dev/null 2>&1 || true
  fi
  systemctl mask twingate.service 2>/dev/null || true
  systemctl stop twingate.service 2>/dev/null || true
  systemctl kill -s SIGKILL twingate.service 2>/dev/null || true
  pkill -9 twingated 2>/dev/null || true
  pkill -9 -f 'twingate status' 2>/dev/null || true
  pkill -9 -f 'twingate start' 2>/dev/null || true
  ip link delete sdwan0 2>/dev/null || true
  ip route del default dev sdwan0 2>/dev/null || true
}

harden_cloudflared_unit() {
  local unit_path="/etc/systemd/system/cloudflared-mt-billing.service"
  [[ -f "$unit_path" ]] || return 0
  local changed=0
  if grep -qE '^\s*Restart=on-failure' "$unit_path" 2>/dev/null; then
    sed -i 's/^\s*Restart=on-failure/Restart=always/' "$unit_path"
    changed=1
  fi
  if ! grep -qE '^\s*StartLimitIntervalSec=' "$unit_path" 2>/dev/null; then
    if grep -qE '^\s*\[Service\]' "$unit_path" 2>/dev/null; then
      sed -i '/^\s*\[Service\]/a StartLimitIntervalSec=0' "$unit_path"
      changed=1
    fi
  fi
  if ! grep -qE '^\s*TimeoutStopSec=' "$unit_path" 2>/dev/null; then
    if grep -qE '^\s*\[Service\]' "$unit_path" 2>/dev/null; then
      sed -i '/^\s*\[Service\]/a TimeoutStopSec=8' "$unit_path"
      changed=1
    fi
  fi
  if ! grep -qE '^\s*KillMode=' "$unit_path" 2>/dev/null; then
    if grep -qE '^\s*\[Service\]' "$unit_path" 2>/dev/null; then
      sed -i '/^\s*\[Service\]/a KillMode=mixed' "$unit_path"
      changed=1
    fi
  fi
  if [[ "$changed" == "1" ]]; then
    log "Hardened cloudflared-mt-billing.service (Restart=always, fast stop)"
    systemctl daemon-reload 2>/dev/null || true
  fi
}

heal_local_stack() {
  # Keep Cloudflare + panel alive on LAN even if public tunnel was 502
  harden_cloudflared_unit
  systemctl reset-failed nginx mt-billing-api cloudflared-mt-billing 2>/dev/null || true
  systemctl try-restart nginx 2>/dev/null || systemctl start nginx 2>/dev/null || true
  systemctl try-restart mt-billing-api 2>/dev/null || systemctl start mt-billing-api 2>/dev/null || true
  if systemctl cat cloudflared-mt-billing.service >/dev/null 2>&1 \
    || [[ -s /etc/mt-billing/cloudflared.token ]]; then
    systemctl reset-failed cloudflared-mt-billing 2>/dev/null || true
    systemctl try-restart cloudflared-mt-billing 2>/dev/null \
      || systemctl start cloudflared-mt-billing 2>/dev/null \
      || systemctl restart cloudflared-mt-billing 2>/dev/null \
      || true
  fi
}

panel_ok() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --connect-timeout 2 --max-time 4 -o /dev/null http://127.0.0.1/login && return 0
    curl -fsS --connect-timeout 2 --max-time 4 -o /dev/null http://127.0.0.1:80/ && return 0
  fi
  timeout 2 bash -c 'echo >/dev/tcp/127.0.0.1/80' 2>/dev/null && return 0
  return 1
}

dns_twingate_first() {
  local ns
  ns="$(grep -E '^\s*nameserver\s+' /etc/resolv.conf 2>/dev/null | head -1 | awk '{print $2}')"
  [[ "${ns:-}" == 100.95.* ]]
}

run_heal() {
  log "=== boot-heal start ==="
  # Always reclaim DNS if Twingate took over (this is what forces power-cycles on RPi)
  if dns_twingate_first || ! getent hosts 1.1.1.1 >/dev/null 2>&1; then
    log "DNS unhealthy or Twingate-first — emergency stop Twingate + safe DNS"
    stop_twingate_hard
    safe_dns
  fi

  # Default via sdwan0 kills LAN
  local def_dev
  def_dev="$(ip route show default 2>/dev/null | awk '/default/ {print $5; exit}')"
  if [[ "$def_dev" == "sdwan0" ]]; then
    log "Default route via sdwan0 — restoring"
    stop_twingate_hard
    safe_dns
  fi

  heal_local_stack

  if [[ -f "$WD" ]]; then
    bash "$WD" install >/dev/null 2>&1 || true
  fi

  if panel_ok; then
    log "Local panel OK on :80"
  else
    log "WARN: local panel still not answering on :80 — retry stack"
    sleep 2
    heal_local_stack
  fi

  # Show LAN IP on console for operators who lost Cloudflare/SSH hostname
  local ip
  ip="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1 || true)"
  if [[ -n "$ip" ]]; then
    log "Admin login: http://${ip}/login"
    echo "MT-Billing: use http://${ip}/login (LAN). Cloudflare 502 = local host down — this heal restarts it." >/dev/tty1 2>/dev/null || true
  fi
  log "=== boot-heal done ==="
}

install_unit() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "Run as root" >&2
    exit 1
  fi
  local self
  self="$(readlink -f "$0" 2>/dev/null || echo "$0")"
  cat >"/etc/systemd/system/${UNIT}" <<EOF
[Unit]
Description=MT-Billing boot network heal (RPi/PC — avoid power-cycle recovery)
DefaultDependencies=no
After=network-pre.target
Before=network-online.target cloudflared-mt-billing.service mt-billing-api.service nginx.service
Wants=network-pre.target

[Service]
Type=oneshot
ExecStart=/bin/bash ${self} once
RemainAfterExit=yes
TimeoutStartSec=60
Nice=0

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$UNIT"
  # Also run once now
  systemctl start "$UNIT" || bash "$self" once || true
  echo "OK: ${UNIT} enabled (runs every boot). Log: ${LOG}"
  log "Installed ${UNIT}"
}

ACTION="${1:-once}"
case "$ACTION" in
  once|heal) run_heal ;;
  install) install_unit ;;
  uninstall)
    systemctl disable --now "$UNIT" 2>/dev/null || true
    rm -f "/etc/systemd/system/${UNIT}"
    systemctl daemon-reload 2>/dev/null || true
    echo "OK: boot-heal removed"
    ;;
  *)
    echo "Usage: $0 once|install|uninstall" >&2
    exit 1
    ;;
esac
