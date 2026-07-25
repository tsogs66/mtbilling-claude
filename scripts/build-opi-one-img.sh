#!/usr/bin/env bash
# Build the Orange Pi One (Allwinner H3 / armhf) flash image only.
# Output:
#   dist/flash/mt-billing-opi-one-armhf.img
#   dist/flash/mt-billing-opi-one-armhf.img.xz
#
# Do NOT flash this on Orange Pi 5 — use build-opi-img.sh for that.
# Orange Pi One has 512 MB RAM; first-boot enables swap. 1 GB+ boards preferred.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$ROOT/scripts/build-sbc-flash-image.sh" --board opi-one "$@"
