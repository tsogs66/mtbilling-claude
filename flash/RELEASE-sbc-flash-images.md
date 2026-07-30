# Flash images release (`sbc-flash-images`)

Download: https://github.com/tsogs66/mtbilling-claude/releases/tag/sbc-flash-images

Published `.img.xz` checksums (binaries live on GitHub Releases, not in git).

| Asset | SHA-256 | Updated (UTC) | Notes |
|-------|---------|---------------|-------|
| `mt-billing-pc-usb-amd64.img.xz` | `27c5886915b0907ec9b4140c64061ae2755a3dd1d0bdc35b031593d77fdbaab4` | 2026-07-30 | Full rebuild: #41 GRUB failure guards + #42 xz `-T1` (1 stream/1 block, Etcher) + #43 single grub-install; kernel 6.8.0-136; synthesized grub.cfg when chroot update-grub emits empty 10_linux |

Rebuild and publish PC USB installer:

```bash
sudo bash scripts/build-pc-usb-img.sh
gh release upload sbc-flash-images dist/flash/mt-billing-pc-usb-amd64.img.xz dist/flash/mt-billing-pc-usb-amd64.img.xz.sha256 --clobber
```
