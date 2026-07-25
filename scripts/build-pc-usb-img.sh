#!/usr/bin/env bash
# Build the PC amd64 USB installer image (flash to USB stick).
# Boot from the stick once: it wipes the largest internal disk (≥8 GB),
# clones the OS, installs UEFI GRUB, then powers off.
# Unplug USB and boot from the internal disk; firstboot installs MT-Billing.
#
# Output:
#   dist/flash/mt-billing-pc-usb-amd64.img
#   dist/flash/mt-billing-pc-usb-amd64.img.xz
#
# Flash with Balena Etcher or Rufus (DD Image mode). UEFI required.
# Console SSH on the installer stick: mtadmin / mtbilling
# After install + firstboot — panel: admin / admin123
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$ROOT/scripts/build-sbc-flash-image.sh" --board pc-usb "$@"
