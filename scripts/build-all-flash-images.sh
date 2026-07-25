#!/usr/bin/env bash
# Build all flashable appliance images (Raspberry Pi, Orange Pi 5, Orange Pi One, PC).
# Output under dist/flash/:
#   mt-billing-rpi-arm64.img(.xz)
#   mt-billing-opi-arm64.img(.xz)       # Orange Pi 5
#   mt-billing-opi-one-armhf.img(.xz)   # Orange Pi One
#   mt-billing-pc-amd64.img(.xz)        # run-from-USB/SSD appliance
#   mt-billing-pc-usb-amd64.img(.xz)    # USB → internal disk installer
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$ROOT/scripts/build-sbc-flash-image.sh" --board all "$@"
