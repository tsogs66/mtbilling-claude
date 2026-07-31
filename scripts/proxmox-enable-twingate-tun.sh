#!/usr/bin/env bash
# Copyright (c) 2026 MT-Billing / ts0gs
# License: MIT
#
# Proxmox HOST helper — grant an MT-Billing LXC access to /dev/net/tun so the
# Twingate headless client can create its VPN interface (sdwan0).
#
# Without TUN, twingated crashes with:
#   linux_tun_new: opening /dev/net/tun … No such file or directory
#   Failed to initialize Network Manager(TUN device)
#
# Usage (on the Proxmox host as root):
#   sudo bash scripts/proxmox-enable-twingate-tun.sh
#   sudo bash scripts/proxmox-enable-twingate-tun.sh 105
#   CTID=105 sudo bash scripts/proxmox-enable-twingate-tun.sh
#
# Then inside the guest: update MT-Billing and retry Network → Twingate → Install & connect.

set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root on the Proxmox host." >&2
  exit 1
fi

if ! command -v pct >/dev/null 2>&1; then
  echo "pct not found — this script must run on a Proxmox VE host." >&2
  exit 1
fi

find_billing_ct() {
  local id
  for id in $(pct list 2>/dev/null | awk 'NR>1 && $2=="running" {print $1}'); do
    if pct exec "$id" -- test -f /etc/systemd/system/mt-billing-api.service 2>/dev/null; then
      echo "$id"
      return 0
    fi
  done
  for id in $(pct list 2>/dev/null | awk 'NR>1 {print $1}'); do
    if pct exec "$id" -- test -f /etc/systemd/system/mt-billing-api.service 2>/dev/null; then
      echo "$id"
      return 0
    fi
  done
  return 1
}

CTID="${1:-${CTID:-}}"
if [[ -z "$CTID" ]]; then
  CTID="$(find_billing_ct || true)"
fi
if [[ -z "$CTID" ]]; then
  echo "Could not auto-detect MT-Billing CT. Pass CTID: $0 <CTID>" >&2
  pct list 2>/dev/null || true
  exit 1
fi

CONF="/etc/pve/lxc/${CTID}.conf"
if [[ ! -f "$CONF" ]]; then
  echo "Missing $CONF — is CTID $CTID an LXC?" >&2
  exit 1
fi

echo "Enabling /dev/net/tun for LXC $CTID ($CONF)"

# Nesting helps some unprivileged setups; harmless if already set.
pct set "$CTID" -features nesting=1 2>/dev/null || true

add_line() {
  local line="$1"
  if grep -Fxq "$line" "$CONF" 2>/dev/null; then
    echo "  already present: $line"
    return 0
  fi
  echo "$line" >>"$CONF"
  echo "  added: $line"
}

# cgroup v2 (Proxmox 7.4+/8)
add_line "lxc.cgroup2.devices.allow: c 10:200 rwm"
# Also allow legacy cgroup line when present on older hosts
if grep -q '^lxc.cgroup.devices.allow' "$CONF" 2>/dev/null || [[ ! -d /sys/fs/cgroup/cgroup.controllers ]]; then
  add_line "lxc.cgroup.devices.allow: c 10:200 rwm"
fi
add_line "lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file"

echo
echo "Rebooting CT $CTID so TUN mount applies…"
pct reboot "$CTID"

echo "Waiting for guest…"
for _ in $(seq 1 30); do
  if pct status "$CTID" 2>/dev/null | grep -q running; then
    sleep 3
    break
  fi
  sleep 1
done

echo "Checking TUN inside guest…"
if pct exec "$CTID" -- test -c /dev/net/tun 2>/dev/null; then
  echo "OK: /dev/net/tun is present in CT $CTID"
  echo "Next: in the panel → Network → Twingate → Install & connect"
  exit 0
fi

echo "WARN: /dev/net/tun still missing after reboot." >&2
echo "  • Confirm the host has /dev/net/tun:  ls -l /dev/net/tun" >&2
echo "  • For unprivileged CTs, also try privileged=1 (pct set $CTID -unprivileged 0) then reboot." >&2
echo "  • Or run MT-Billing in a full VM instead of LXC." >&2
exit 1
