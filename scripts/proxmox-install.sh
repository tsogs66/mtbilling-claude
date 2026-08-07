#!/usr/bin/env bash
# Copyright (c) 2026 MT-Billing / Pa-North
# License: MIT
#
# Proxmox host helper — creates an Ubuntu LXC and installs MT-Billing.
#
# Requirements (Proxmox VE host):
#   - Proxmox VE 8+ (or 7.4+)
#   - Root shell on the host
#   - Storage with ≥ 32 GB free for the container disk
#   - Network bridge (vmbr0) with DHCP or static IP available
#   - Internet access (community-scripts + GitHub + npm)
#
# Recommended container resources (defaults in ct/mt-billing.sh):
#   2 vCPU · 4096 MB RAM · 32 GB disk · Ubuntu 24.04 · unprivileged
#
# Usage (from a clone):
#   sudo bash scripts/proxmox-install.sh
#   mode=default sudo bash scripts/proxmox-install.sh
#
# One-liner (public repo):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/tsogs66/MT-Billing/main/ct/mt-billing.sh)"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$ROOT/ct/mt-billing.sh"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root on the Proxmox host (e.g. sudo bash scripts/proxmox-install.sh)." >&2
  exit 1
fi

if ! command -v pct >/dev/null 2>&1; then
  echo "This helper must run on a Proxmox VE host (pct not found)." >&2
  exit 1
fi

if [[ ! -f "$TARGET" ]]; then
  echo "Missing $TARGET — clone the full repository first." >&2
  exit 1
fi

# Keep optional SSH_* vars defined for community-scripts under set -u.
: "${SSH_CLIENT:=}"
: "${SSH_CONNECTION:=}"

echo "MT-Billing Proxmox installer"
echo "  script : $TARGET"
echo "  defaults: 2 vCPU / 4096 MB RAM / 32 GB disk / Ubuntu 24.04"
echo

exec bash "$TARGET" "$@"
