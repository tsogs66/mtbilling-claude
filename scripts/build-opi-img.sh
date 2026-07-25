#!/usr/bin/env bash
# Build the Orange Pi 5 (RK3588S / arm64) flash image only.
# Output:
#   dist/flash/mt-billing-opi-arm64.img
#   dist/flash/mt-billing-opi-arm64.img.xz
#
# Do NOT flash this on Orange Pi One — use build-opi-one-img.sh for that.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$ROOT/scripts/build-sbc-flash-image.sh" --board opi "$@"
