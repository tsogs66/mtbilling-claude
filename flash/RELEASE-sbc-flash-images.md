# Flash images release (`sbc-flash-images`)

Download: https://github.com/tsogs66/mtbilling-claude/releases/tag/sbc-flash-images

Published `.img.xz` checksums (binaries live on GitHub Releases, not in git).
All assets below are single-stream / single-block `xz -T1` (Balena Etcher compatible).

| Asset | SHA-256 | Updated (UTC) | Notes |
|-------|---------|---------------|-------|
| `mt-billing-rpi-arm64.img.xz` | `9b3488ff8bca1caa9bed807447207066d44bd723a96a1d6cb7dee8bd176113fb` | 2026-07-30 | Full rebuild from main (#45 + flash pipeline) |
| `mt-billing-opi-arm64.img.xz` | `90b5c75240a2234a03759863a741180f23402fe8efc303e34845bd2618893511` | 2026-07-30 | Orange Pi 5; full rebuild |
| `mt-billing-opi-one-armhf.img.xz` | `5da995c236804b52e936593e86810cd8a5a573dba9ad9d0c5aa8c6ec928e3e11` | 2026-07-30 | Orange Pi One; full rebuild |
| `mt-billing-pc-amd64.img.xz` | `d4b576e00a09343e29f9e40c567a986c1985ed166d8f6e437957c5ca5f3a3997` | 2026-07-30 | Run-from-USB/SSD appliance; full rebuild |
| `mt-billing-pc-usb-amd64.img.xz` | `ba3d5f386481b6091de1ae825dbce415927938a18d4b865790d062f0910344dd` | 2026-07-30 | USB→disk installer; includes #41/#42/#43/#45 (preserve grub.cfg during modules-extra, patch_grub set -e guard, normal.mod verify + handwritten target grub.cfg) |

Rebuild and publish all boards:

```bash
sudo bash scripts/build-all-flash-images.sh
gh release upload sbc-flash-images \
  dist/flash/mt-billing-rpi-arm64.img.xz dist/flash/mt-billing-rpi-arm64.img.xz.sha256 \
  dist/flash/mt-billing-opi-arm64.img.xz dist/flash/mt-billing-opi-arm64.img.xz.sha256 \
  dist/flash/mt-billing-opi-one-armhf.img.xz dist/flash/mt-billing-opi-one-armhf.img.xz.sha256 \
  dist/flash/mt-billing-pc-amd64.img.xz dist/flash/mt-billing-pc-amd64.img.xz.sha256 \
  dist/flash/mt-billing-pc-usb-amd64.img.xz dist/flash/mt-billing-pc-usb-amd64.img.xz.sha256 \
  --clobber
```
