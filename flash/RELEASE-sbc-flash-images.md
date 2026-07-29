# Flash images release (`sbc-flash-images`)

Download: https://github.com/tsogs66/mtbilling-claude/releases/tag/sbc-flash-images

Published `.img.xz` checksums (binaries live on GitHub Releases, not in git).

| Asset | SHA-256 | Updated (UTC) | Notes |
|-------|---------|---------------|-------|
| `mt-billing-pc-usb-amd64.img.xz` | `bff412f2870c2ed9e2b46ab3a6c962e482b5bf91317efcc25b61d25ebd9a1ceb` | 2026-07-29 | Fix systemd ordering cycle dropping usb-install; Wyse nomodeset on default GRUB |

Rebuild and publish PC USB installer:

```bash
sudo bash scripts/build-pc-usb-img.sh
gh release upload sbc-flash-images dist/flash/mt-billing-pc-usb-amd64.img.xz dist/flash/mt-billing-pc-usb-amd64.img.xz.sha256 --clobber
```
