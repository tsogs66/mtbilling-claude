# Flash images release (`sbc-flash-images`)

Download: https://github.com/tsogs66/mtbilling-claude/releases/tag/sbc-flash-images

Published `.img.xz` checksums (binaries live on GitHub Releases, not in git).
All assets below are single-stream / single-block `xz -T1` (Balena Etcher compatible).

| Asset | SHA-256 | Updated (UTC) | Notes |
|-------|---------|---------------|-------|
| `mt-billing-rpi-arm64.img.xz` | `b726d60a5abc31c0201f8b1623b86b22626cd343c6c42164ffc0878a075825aa` | 2026-08-27 | Full rebuild from main (#191 portal login, #167 SQLite recovery) |
| `mt-billing-opi-arm64.img.xz` | `e868fd8ce1359199d386b8face0546e2464b785729786d19cae43eb5c06a40be` | 2026-08-27 | Orange Pi 5; full rebuild |
| `mt-billing-opi-one-armhf.img.xz` | `f07ce6fa00ccc182829885d6321b89c669307ae6db90b4996951c0bd0869fac7` | 2026-08-27 | Orange Pi One; full rebuild |
| `mt-billing-pc-amd64.img.xz` | `be1b7fab71ca049e3c2a533b7eb3819bb3a8d8c304a4af251fb07ae1dd643f6e` | 2026-08-27 | Run-from-USB/SSD appliance; full rebuild |
| `mt-billing-pc-usb-amd64.img.xz` | `ffd0f0b2c5f63592f3afe3b1b54d05d05c0cb660e0a677d85b931071eb6289c0` | 2026-08-27 | USB→disk installer; full rebuild |

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
