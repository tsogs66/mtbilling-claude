# Flash images (Raspberry Pi, Orange Pi & PC)

Separate disk images — **one per board/platform**. Download from the
[flash images release](https://github.com/tsogs66/MT-Billing/releases/tag/sbc-flash-images)
or build locally, then flash with **Balena Etcher** or **Rufus** (DD Image mode).

| Platform | Build command | Output files |
|----------|---------------|--------------|
| **Raspberry Pi** 3/4/5 | `sudo bash scripts/build-rpi-img.sh` | `mt-billing-rpi-arm64.img` (+ `.img.xz`) |
| **Orange Pi 5** | `sudo bash scripts/build-opi-img.sh` | `mt-billing-opi-arm64.img` (+ `.img.xz`) |
| **Orange Pi One** (H3) | `sudo bash scripts/build-opi-one-img.sh` | `mt-billing-opi-one-armhf.img` (+ `.img.xz`) |
| **PC appliance** (run from USB/SSD) | `sudo bash scripts/build-pc-img.sh` | `mt-billing-pc-amd64.img` (+ `.img.xz`) |
| **PC USB installer** → internal disk | `sudo bash scripts/build-pc-usb-img.sh` | `mt-billing-pc-usb-amd64.img` (+ `.img.xz`) |

**Do not mix Orange Pi images.** `mt-billing-opi-arm64*` is for Orange Pi **5** only.
Orange Pi **One** must use `mt-billing-opi-one-armhf*`.

### PC: appliance vs USB installer

| Image | What it does |
|-------|----------------|
| `mt-billing-pc-amd64*` | Flash to USB/SSD and **run from that drive** (appliance). |
| `mt-billing-pc-usb-amd64*` | Flash to a USB stick, boot once — **installs onto the largest internal disk** (≥8 GB), then powers off. Unplug USB and boot from the PC disk. |

USB installer notes:

- UEFI boot required; target disk is **wiped**.
- Needs Ethernet/internet during install and again on first boot from the internal disk (MT-Billing firstboot).
- Console on the stick: `mtadmin` / `mtbilling`. Install log: `/var/log/mt-billing-usb-install.log`.

**Dell Wyse 3040 / Intel Atom thin clients:** if the screen stops at  
`EFI stub: Loaded initrd…` with a black screen, rebuild the USB image from current `main`  
(`sudo bash scripts/build-pc-usb-img.sh`) — images now bake in `nomodeset` and i915  
workarounds. Also use a **USB 2.0** port, disable **Secure Boot**, and try another stick.

Build all:

```bash
sudo bash scripts/build-all-flash-images.sh
```

Host build deps: `curl`, `xz`, `losetup`, `python3`, and for PC images `qemu-utils` (`qemu-img`).

See **[SYSTEM_REQUIREMENTS.md](../SYSTEM_REQUIREMENTS.md)** for hardware minimums.

## After flashing

1. Boot the device with Ethernet (recommended). First boot needs internet.
2. Wait for [`firstboot-mt-billing.sh`](./firstboot-mt-billing.sh) to finish (panel on port 80).
3. Open `http://<device-ip>/` — panel login `admin` / `admin123`.
4. Console / SSH login: **`mtadmin` / `mtbilling`** (change immediately).

```bash
ssh mtadmin@<device-ip>
```

First-boot log on device: `/var/log/mt-billing-firstboot.log`.

### Orange Pi One notes

- 512 MB RAM — first-boot creates swap and can take a long time (even hours) for the Node build.
- Console login works **immediately** (baked into the image): `mtadmin` / `mtbilling`  
  Recovery: `root` / `mtbilling`
- Prefer a Class 10 / UHS microSD **≥ 16 GB**.
- Use the **`.img.xz`** file directly in Etcher (do not extract into a folder).
- Do **not** wait for first-boot to finish before SSH — only the web panel needs the install to complete.
