#!/usr/bin/env bash
# Build the PC / x86_64 (amd64) flash image only.
# Output:
#   dist/flash/mt-billing-pc-amd64.img
#   dist/flash/mt-billing-pc-amd64.img.xz
# Flash with Balena Etcher or Rufus (DD Image mode) onto USB/SSD.
# UEFI boot recommended. Console SSH after first cloud-init: mtadmin / mtbilling
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$ROOT/scripts/build-sbc-flash-image.sh" --board pc "$@"
