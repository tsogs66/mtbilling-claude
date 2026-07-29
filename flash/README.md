# Flash images (Raspberry Pi, Orange Pi & PC)

Separate disk images — **one per board/platform**. Download from the
[flash images release](https://github.com/tsogs66/mtbilling-claude/releases/tag/sbc-flash-images)
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
| `mt-billing-pc-usb-amd64*` | Flash to a USB stick, boot once — **installs onto the largest internal disk** (≥4 GB; prefers eMMC), then powers off. Unplug USB and boot from the PC disk. |

USB installer notes:

- UEFI boot required; target disk is **wiped**.
- Needs Ethernet/internet during install and again on first boot from the internal disk (MT-Billing firstboot).
- Console on the stick: `mtadmin` / `mtbilling`. Install log: `/var/log/mt-billing-usb-install.log`.
- Target selection prefers **eMMC** (`/dev/mmcblk0`) over USB. Marketing “8 GB” eMMC (Dell Wyse 3040) is accepted (≥4 GiB).
- Force a disk: `sudo TARGET_DISK=/dev/mmcblk0 /usr/local/lib/mt-billing/usb-install-to-disk.sh`
- If `lsblk` shows **only the USB stick** (no `mmcblk0`), the cloud image was missing MMC drivers — re-flash the latest release (includes `linux-modules-extra`), or on a networked stick:

```bash
sudo apt-get update
sudo apt-get install -y linux-modules-extra-$(uname -r)
sudo modprobe sdhci_acpi sdhci_pci mmc_block
lsblk -o NAME,SIZE,TYPE,TRAN,MODEL
```

**Dell Wyse 3040 / Intel Atom thin clients:** if the screen stops at  
`EFI stub: Loaded initrd…` with a black screen, re-flash the latest  
`mt-billing-pc-usb-amd64.img.xz` from the [flash images release](https://github.com/tsogs66/mtbilling-claude/releases/tag/sbc-flash-images)  
(images bake in `nomodeset` / `i915.modeset=0` on the **default** GRUB entries).  
Also use a **USB 2.0** port, disable **Secure Boot**, and try another stick.

**Immediate workaround** (current stick, no re-flash): at the GRUB menu press `e`,  
append `nomodeset i915.modeset=0` to the `linux` line, then Ctrl-X to boot.  
Or open **Advanced options → recovery mode** (already includes `nomodeset`).  
If the screen stays black but Ethernet is up, try `ssh mtadmin@<device-ip>`  
(password `mtbilling`) — the installer may still be running.

If boot reaches a login/console but you see  
`Job mt-billing-usb-install.service/start deleted to break ordering cycle`,  
run the installer manually:

```bash
sudo /usr/local/lib/mt-billing/usb-install-to-disk.sh
```

(or re-flash the latest USB image, which removes the cloud-init ordering cycle).


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

`mtadmin` has passwordless `sudo`, so use `sudo reboot` / `sudo poweroff` —
a bare `reboot` fails with "Interactive authentication required" over SSH
(that goes through polkit/logind, not sudo). `mtadmin` can also reboot/power
off without `sudo` at all, since firstboot installs a polkit rule granting
that to the `sudo` group.

First-boot log on device: `/var/log/mt-billing-firstboot.log`.

### Staying up to date

Firstboot enables a systemd timer that polls GitHub `main` every 10 minutes and applies
updates automatically (`systemctl status mt-billing-auto-update.timer`). Set
`MT_AUTO_UPDATE=0` before flashing/first boot to opt out, or trigger "Update from GitHub"
from the panel's Application Updater page at any time.

Retrofitting a device flashed before this existed:

```bash
curl -fsSL https://raw.githubusercontent.com/tsogs66/MT-Billing/main/scripts/fetch-update-from-github.sh | sudo bash -s -- --enable-timer
```

### Orange Pi One notes

- 512 MB RAM — first-boot creates swap and can take a long time (even hours) for the Node build.
- Console login works **immediately** (baked into the image): `mtadmin` / `mtbilling`  
  Recovery: `root` / `mtbilling`
- Prefer a Class 10 / UHS microSD **≥ 16 GB**.
- Use the **`.img.xz`** file directly in Etcher (do not extract into a folder).
- Do **not** wait for first-boot to finish before SSH — only the web panel needs the install to complete.
