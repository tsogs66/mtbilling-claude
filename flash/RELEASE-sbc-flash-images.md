# Flash images release (`sbc-flash-images`)

Download: https://github.com/tsogs66/mtbilling-claude/releases/tag/sbc-flash-images

Published `.img.xz` checksums (binaries live on GitHub Releases, not in git).

| Asset | SHA-256 | Updated (UTC) | Notes |
|-------|---------|---------------|-------|
| `mt-billing-pc-usb-amd64.img.xz` | `c0bdf0278447f3377981df6cb3816f8349610250531fa2b648ca5b7fd3668ef9` | 2026-07-29 | Wyse 3040: `nomodeset` on **default** GRUB entries (XBOOTLDR grub.cfg) |

Rebuild and publish PC USB installer:

```bash
sudo bash scripts/build-pc-usb-img.sh
gh release upload sbc-flash-images dist/flash/mt-billing-pc-usb-amd64.img.xz dist/flash/mt-billing-pc-usb-amd64.img.xz.sha256 --clobber
```
