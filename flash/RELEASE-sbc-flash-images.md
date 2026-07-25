# Flash images release (`sbc-flash-images`)

Download: https://github.com/tsogs66/mtbilling-claude/releases/tag/sbc-flash-images

Published `.img.xz` checksums (binaries live on GitHub Releases, not in git).
All five images below were built from this repo's `main` (2026-07-25) — each
embeds a firstboot script whose `REPO_URL` points at `tsogs66/mtbilling-claude`,
confirmed by mounting each image and checking the installed script directly
(not just diffing bytes against the previous release).

| Asset | SHA-256 |
|-------|---------|
| `mt-billing-rpi-arm64.img.xz` | `bea517d58f3f7d71ac9b98acc143da409cd6ad21a4b17a24b14d1a264472b749` |
| `mt-billing-opi-arm64.img.xz` | `bf9e58f7d096034d8b35f86bd3f762caa3d4346214457a09250ba7964ad1cfee` |
| `mt-billing-opi-one-armhf.img.xz` | `6927d0eb0fd5ab5d8edbf0979d9ea5ea4047bae06d4d11af6945ec4329bf63ad` |
| `mt-billing-pc-amd64.img.xz` | `7ee86d6e23580cd27be6cc1b1d693f720cdb6e388d4dfc2cf400e7333fd98ed1` |
| `mt-billing-pc-usb-amd64.img.xz` | `ccdbf71b60d45523a19158d4d4fd237dcc147c2a784576395d561ffea42e34b6` |

Note for the RPi/Orange Pi builds specifically: the base OS images (Raspberry Pi OS,
Armbian) were sourced from an already-published copy of these images rather than
freshly downloaded from `downloads.raspberrypi.com` / Armbian's GitHub releases —
some build environments can't reach those hosts. `build-sbc-flash-image.sh` supports
this directly: pre-populate `dist/flash-cache/{rpi,opi5,opi-one}-base.img.xz` and set
`OPI_IMAGE_URL`/`OPI_ONE_IMAGE_URL` (any non-empty value) so the Armbian release
lookup is skipped — `download_image()` uses the cached file instead of fetching.
Only the firstboot-injection step re-runs, which is what actually needed the fix.

Rebuild and publish (fresh base images, unrestricted network):

```bash
sudo bash scripts/build-rpi-img.sh
sudo bash scripts/build-opi-img.sh
sudo bash scripts/build-opi-one-img.sh
sudo bash scripts/build-pc-img.sh
sudo bash scripts/build-pc-usb-img.sh
gh release upload sbc-flash-images dist/flash/*.img.xz dist/flash/*.img.xz.sha256 --clobber
```
