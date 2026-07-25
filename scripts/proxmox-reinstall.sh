#!/usr/bin/env bash
# Copyright (c) 2026 MT-Billing / ts0gs
# License: MIT
#
# Proxmox host helper — reinstall MT-Billing inside an LXC to the latest Git
# defaults (for large updates that need a clean rebuild).
#
# Usage (on Proxmox VE host as root):
#   sudo bash scripts/proxmox-reinstall.sh
#   CTID=101 sudo bash scripts/proxmox-reinstall.sh --yes
#   CTID=101 sudo bash scripts/proxmox-reinstall.sh --yes --reset-db
#   CTID=101 sudo bash scripts/proxmox-reinstall.sh --yes --keep-db
#
# Extra args are forwarded to install/mt-billing-reinstall.sh inside the guest.
# Finds the container automatically when CTID is unset.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root on the Proxmox host (e.g. sudo bash scripts/proxmox-reinstall.sh --yes)." >&2
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

REINSTALL="/opt/mt-billing/install/mt-billing-reinstall.sh"
LOCAL_REINSTALL="$ROOT/install/mt-billing-reinstall.sh"
BRANCH="${var_repo_branch:-${REPO_BRANCH:-main}}"

# Ensure guest has the latest reinstall script (copy from host repo, else GitHub raw).
if [[ -f "$LOCAL_REINSTALL" ]]; then
  echo "Copying reinstall script into CT ${CTID}…"
  pct exec "$CTID" -- mkdir -p /opt/mt-billing/install
  pct push "$CTID" "$LOCAL_REINSTALL" "$REINSTALL"
  pct exec "$CTID" -- chmod +x "$REINSTALL"
elif ! pct exec "$CTID" -- test -f "$REINSTALL" 2>/dev/null; then
  echo "Fetching reinstall script from GitHub into CT ${CTID}…"
  RAW="https://raw.githubusercontent.com/tsogs66/MT-Billing/${BRANCH}/install/mt-billing-reinstall.sh"
  pct exec "$CTID" -- bash -c "mkdir -p /opt/mt-billing/install && curl -fsSL '$RAW' -o '$REINSTALL' && chmod +x '$REINSTALL'"
fi

# Default to --yes when run non-interactively from the host unless user passed flags.
FORWARD=("$@")
has_yes=0
for a in "${FORWARD[@]+"${FORWARD[@]}"}"; do
  [[ "$a" == "--yes" || "$a" == "-y" ]] && has_yes=1
done
if [[ "$has_yes" != "1" ]]; then
  if [[ ! -t 0 ]]; then
    FORWARD+=(--yes)
  fi
fi

echo "Running guest reinstall in CT ${CTID}…"
pct exec "$CTID" -- env \
  var_repo_branch="$BRANCH" \
  var_repo_url="${var_repo_url:-${REPO_URL:-https://github.com/tsogs66/MT-Billing.git}}" \
  bash "$REINSTALL" "${FORWARD[@]+"${FORWARD[@]}"}"

IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
echo "Done. Panel: http://${IP:-<container-ip>}"
