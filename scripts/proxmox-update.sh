#!/usr/bin/env bash
# Copyright (c) 2026 MT-Billing / ts0gs
# License: MIT
#
# Proxmox host helper — run MT-Billing update inside an LXC.
#
# Usage (on Proxmox VE host as root):
#   sudo bash scripts/proxmox-update.sh
#   CTID=101 sudo bash scripts/proxmox-update.sh
#   CTID=101 MT_BILLING_AUTO_ONLY=1 sudo bash scripts/proxmox-update.sh
#
# Finds the container automatically when CTID is unset (first running LXC with
# mt-billing-api.service, or hostname/description containing mt-billing).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root on the Proxmox host (e.g. sudo bash scripts/proxmox-update.sh)." >&2
  exit 1
fi

if ! command -v pct >/dev/null 2>&1; then
  echo "This helper must run on a Proxmox VE host (pct not found)." >&2
  exit 1
fi

find_ctid() {
  local id
  for id in $(pct list 2>/dev/null | awk 'NR>1 && $2=="running" {print $1}'); do
    if pct exec "$id" -- test -f /etc/systemd/system/mt-billing-api.service 2>/dev/null; then
      echo "$id"
      return 0
    fi
  done
  for id in $(pct list 2>/dev/null | awk 'NR>1 {print $1}'); do
    local desc
    desc="$(pct config "$id" 2>/dev/null | grep -E '^hostname:|^description:' || true)"
    if echo "$desc" | grep -qi 'mt-billing\|mtbilling'; then
      echo "$id"
      return 0
    fi
  done
  return 1
}

CTID="${CTID:-}"
if [[ -z "$CTID" ]]; then
  CTID="$(find_ctid)" || {
    echo "Could not detect MT-Billing LXC. Set CTID=<id> and retry." >&2
    exit 1
  }
  echo "Detected MT-Billing container: CTID=${CTID}"
fi

UPDATER="/opt/mt-billing/install/mt-billing-update.sh"
AUTO_FLAG=""
[[ "${MT_BILLING_AUTO_ONLY:-0}" == "1" ]] && AUTO_FLAG="--auto"

if pct exec "$CTID" -- test -f "$UPDATER" 2>/dev/null; then
  echo "Running guest update script in CT ${CTID}…"
  pct exec "$CTID" -- env MT_BILLING_AUTO_ONLY="${MT_BILLING_AUTO_ONLY:-0}" bash "$UPDATER" $AUTO_FLAG
else
  echo "Guest update script missing — copying from GitHub into CT ${CTID}…"
  FETCH="$ROOT/scripts/fetch-update-from-github.sh"
  if [[ -f "$FETCH" ]]; then
    CTID="$CTID" var_repo_branch="${var_repo_branch:-main}" bash "$FETCH" --run
  else
    BRANCH="${var_repo_branch:-main}"
    RAW="https://raw.githubusercontent.com/tsogs66/MT-Billing/${BRANCH}/install/mt-billing-update.sh"
    pct exec "$CTID" -- bash -c "curl -fsSL '$RAW' -o /tmp/mt-billing-update.sh && chmod +x /tmp/mt-billing-update.sh && MT_BILLING_AUTO_ONLY='${MT_BILLING_AUTO_ONLY:-0}' bash /tmp/mt-billing-update.sh $AUTO_FLAG"
  fi
fi

echo "Done. Panel: http://$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
