#!/usr/bin/env bash
# Copyright (c) 2026 MT-Billing / ts0gs
# License: MIT
#
# Console network rescue — run on the machine's keyboard/monitor when SSH dies
# after a Twingate Install & connect attempt.
#
#   sudo bash /opt/mt-billing/install/mt-billing-net-rescue.sh
#
# Or copy-paste the body if the script is not updated yet.

set -euo pipefail

INSTALL_DIR="${var_install_dir:-${INSTALL_DIR:-/opt/mt-billing}}"
TG="${INSTALL_DIR}/install/mt-billing-twingate.sh"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

echo "=== MT-Billing network rescue ==="

if [[ -x "$TG" ]] || [[ -f "$TG" ]]; then
  bash "$TG" emergency-restore || true
else
  echo "Twingate helper missing — applying manual rescue"
  systemctl mask twingate.service 2>/dev/null || true
  systemctl stop twingate.service 2>/dev/null || true
  pkill -9 twingated 2>/dev/null || true
  ip link delete sdwan0 2>/dev/null || true
  if [[ -f /etc/mt-billing/resolv.conf.twingate-bak ]]; then
    cp -a /etc/mt-billing/resolv.conf.twingate-bak /etc/resolv.conf
  else
    printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\nnameserver 9.9.9.9\n' >/etc/resolv.conf
  fi
  ip route del default dev sdwan0 2>/dev/null || true
  if [[ -f /etc/mt-billing/net-coexist.state ]]; then
    # shellcheck disable=SC1091
    source /etc/mt-billing/net-coexist.state 2>/dev/null || true
    if [[ -n "${COEXIST_DEFAULT_GW:-}" && -n "${COEXIST_DEFAULT_DEV:-}" ]]; then
      ip route replace default via "$COEXIST_DEFAULT_GW" dev "$COEXIST_DEFAULT_DEV" 2>/dev/null || true
    fi
  fi
fi

WD="${INSTALL_DIR}/install/mt-billing-net-watchdog.sh"
if [[ -f "$WD" ]]; then
  bash "$WD" install || true
fi
HEAL="${INSTALL_DIR}/install/mt-billing-boot-heal.sh"
if [[ -f "$HEAL" ]]; then
  bash "$HEAL" install || true
  bash "$HEAL" once || true
fi

systemctl try-restart nginx mt-billing-api 2>/dev/null || true
systemctl try-restart cloudflared-mt-billing 2>/dev/null || true

echo
echo "--- status ---"
ip -br a 2>/dev/null || ip a | head -40
echo
ip route | head -20
echo
echo "resolv.conf:"
cat /etc/resolv.conf 2>/dev/null || true
echo
echo "If SSH still fails, connect by LAN IP (not hostname), e.g. ssh user@192.168.x.x"
echo "Prefer: sudo reboot   (soft reboot) instead of pulling power."
echo "DHCP renew: dhclient -v   OR   networkctl reconfigure eth0 enp1s0"
