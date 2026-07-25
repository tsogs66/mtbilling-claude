# Flash images release (`sbc-flash-images`)

Download: https://github.com/tsogs66/MT-Billing/releases/tag/sbc-flash-images

Published `.img.xz` checksums (binaries live on GitHub Releases, not in git).

| Asset | SHA-256 | Updated (UTC) | Notes |
|-------|---------|---------------|-------|
| `mt-billing-pc-usb-amd64.img.xz` | `953182f5ab6672f008ca159368c4c27414be1b8807443bdab2c88ec659f4f9f6` | 2026-07-23 | Wyse 3040 thin-client kernel args in EFI GRUB |

Rebuild and publish PC USB installer:

```bash
sudo bash scripts/build-pc-usb-img.sh
gh release upload sbc-flash-images dist/flash/mt-billing-pc-usb-amd64.img.xz dist/flash/mt-billing-pc-usb-amd64.img.xz.sha256 --clobber
```
