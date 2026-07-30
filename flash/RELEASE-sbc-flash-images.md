# Flash images release (`sbc-flash-images`)

Download: https://github.com/tsogs66/mtbilling-claude/releases/tag/sbc-flash-images

Published `.img.xz` checksums (binaries live on GitHub Releases, not in git).

| Asset | SHA-256 | Updated (UTC) | Notes |
|-------|---------|---------------|-------|
| `mt-billing-pc-usb-amd64.img.xz` | `a21a2125bf05d8e356b185c7f7c63b7fbdf6c1a7783249a6a4869b8dc855390d` | 2026-07-30 | Includes #41 GRUB-failure guards + Wyse MMC/nomodeset/apt-lock/partition-reuse |

Rebuild and publish PC USB installer:

```bash
sudo bash scripts/build-pc-usb-img.sh
gh release upload sbc-flash-images dist/flash/mt-billing-pc-usb-amd64.img.xz dist/flash/mt-billing-pc-usb-amd64.img.xz.sha256 --clobber
```
