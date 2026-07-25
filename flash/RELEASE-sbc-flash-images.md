# Flash images release (`sbc-flash-images`)

Download: https://github.com/tsogs66/mtbilling-claude/releases/tag/sbc-flash-images

Published `.img.xz` checksums (binaries live on GitHub Releases, not in git).

| Asset | SHA-256 | Rebuilt from this repo? | Notes |
|-------|---------|--------------------------|-------|
| `mt-billing-pc-amd64.img.xz` | `7ee86d6e23580cd27be6cc1b1d693f720cdb6e388d4dfc2cf400e7333fd98ed1` | **Yes** (2026-07-25) | Built from this repo's `main`; embeds a firstboot script that pulls from `tsogs66/mtbilling-claude` |
| `mt-billing-pc-usb-amd64.img.xz` | `ccdbf71b60d45523a19158d4d4fd237dcc147c2a784576395d561ffea42e34b6` | **Yes** (2026-07-25) | Built from this repo's `main`; Wyse 3040 thin-client kernel args in EFI GRUB |
| `mt-billing-rpi-arm64.img.xz` | `e7b532b784674815873dc7af1dcb726ec93dba4c5cbef36817a4bc76f44b9c40` | **No** — copied from `tsogs66/mt-billing`'s release | ⚠️ Embedded firstboot script still points at the old repo — see below |
| `mt-billing-opi-arm64.img.xz` | `a03d1cc11f953f0f02f143b9f175b4a95084f97ab0fde6aee6382ba92ed15eec` | **No** — copied from `tsogs66/mt-billing`'s release | ⚠️ Same caveat — Orange Pi 5 only |
| `mt-billing-opi-one-armhf.img.xz` | `6b1ffd4dfeb2f2e49616602a63d1889f62793c1d4a4e2dcfa1d05b4adc521d39` | **No** — copied from `tsogs66/mt-billing`'s release | ⚠️ Same caveat — Orange Pi One only |

**About the RPi/Orange Pi images:** these three were copied byte-for-byte from the
original `tsogs66/mt-billing` repo's release rather than rebuilt here (this repo's
sandboxed build environment can't reach `downloads.raspberrypi.com` or the Armbian
release API to build them). That means the firstboot script baked into those specific
image files still points at `tsogs66/MT-Billing`, not this repo — a device flashed
from them will provision from the original repo's `main` on first boot, not this one.
Rebuild them from an unrestricted machine to get images that match this repo:

```bash
sudo bash scripts/build-rpi-img.sh
sudo bash scripts/build-opi-img.sh
sudo bash scripts/build-opi-one-img.sh
gh release upload sbc-flash-images dist/flash/mt-billing-{rpi-arm64,opi-arm64,opi-one-armhf}.img.xz \
  dist/flash/mt-billing-{rpi-arm64,opi-arm64,opi-one-armhf}.img.xz.sha256 --clobber
```

Rebuild and publish the PC images:

```bash
sudo bash scripts/build-pc-img.sh
sudo bash scripts/build-pc-usb-img.sh
gh release upload sbc-flash-images dist/flash/mt-billing-pc-amd64.img.xz dist/flash/mt-billing-pc-amd64.img.xz.sha256 \
  dist/flash/mt-billing-pc-usb-amd64.img.xz dist/flash/mt-billing-pc-usb-amd64.img.xz.sha256 --clobber
```
