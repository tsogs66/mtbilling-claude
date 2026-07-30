#!/bin/bash
# Boot from MT-Billing USB installer stick → clone OS onto the largest internal disk,
# install UEFI GRUB, then power off. Remove the stick and boot from the PC disk.
set -euo pipefail

MARKER=/etc/mt-billing-usb-installer
LOG=/var/log/mt-billing-usb-install.log
TARGET_MNT=/mnt/mt-target

exec > >(tee -a "$LOG") 2>&1

log() { echo "[$(date -Iseconds)] $*"; }

if [[ ! -f "$MARKER" ]]; then
  log "Not a USB installer image (missing $MARKER); exiting."
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive

log "=== MT-Billing USB → internal disk installer ==="

# Wait for disks to settle; load common eMMC / SDHCI modules (Dell Wyse 3040, etc.)
sleep 5
for mod in mmc_block sdhci sdhci_pci sdhci_acpi mmc_core; do
  modprobe "$mod" 2>/dev/null || true
done
udevadm settle 2>/dev/null || true
sleep 2

ROOT_SRC=$(findmnt -n -o SOURCE /)
BOOT_PART=$(lsblk -no PKNAME,NAME,TYPE -p "$ROOT_SRC" 2>/dev/null | awk '$3=="part"{print $2; exit}')
[[ -n "$BOOT_PART" ]] || BOOT_PART="$ROOT_SRC"
BOOT_DISK="/dev/$(lsblk -no PKNAME -d "$BOOT_PART" 2>/dev/null | head -1)"
if [[ -z "$BOOT_DISK" || "$BOOT_DISK" == "/dev/" ]]; then
  BOOT_DISK=$(lsblk -no PKNAME -p "$BOOT_PART" | head -1)
  BOOT_DISK="/dev/${BOOT_DISK#/dev/}"
fi

log "Boot medium: $BOOT_DISK (root $ROOT_SRC)"
log "Block devices:"
lsblk -b -o NAME,SIZE,TYPE,TRAN,RM,MODEL -p 2>/dev/null | while read -r line; do log "  $line"; done || true

# Allow override: TARGET_DISK=/dev/mmcblk0 sudo -E .../usb-install-to-disk.sh
# Marketing "8 GB" eMMC is often ~7.2 GiB — require ≥ 4 GiB, not a strict 8 GiB.
MIN_TARGET_BYTES=${MIN_TARGET_BYTES:-4294967296}
TARGET_DISK="${TARGET_DISK:-}"
TARGET_BYTES=0

pick_score() {
  # Prefer internal eMMC / SATA / NVMe over USB sticks. Higher is better.
  local name="$1" tran="$2" rm="$3"
  local score=10
  case "$tran" in
    mmc) score=100 ;;
    nvme) score=90 ;;
    sata|ata|raid) score=80 ;;
    usb|"") score=20 ;;
  esac
  [[ "$rm" == "1" ]] && score=$((score - 50))
  [[ "$name" == /dev/mmcblk* ]] && score=$((score + 20))
  echo "$score"
}

if [[ -n "$TARGET_DISK" ]]; then
  [[ -b "$TARGET_DISK" ]] || { log "ERROR: TARGET_DISK=$TARGET_DISK is not a block device."; exit 1; }
  [[ "$TARGET_DISK" == "$BOOT_DISK" ]] && { log "ERROR: TARGET_DISK cannot be the boot USB ($BOOT_DISK)."; exit 1; }
  TARGET_BYTES=$(lsblk -b -dn -o SIZE -p "$TARGET_DISK" | head -1)
  log "Using TARGET_DISK override: $TARGET_DISK ($TARGET_BYTES bytes)"
else
  BEST_SCORE=-999
  while read -r name size type tran rm; do
    [[ "$type" == "disk" ]] || continue
    [[ -b "$name" ]] || continue
    if [[ "$name" == "$BOOT_DISK" ]]; then
      log "  skip $name (boot medium)"
      continue
    fi
    if (( size < MIN_TARGET_BYTES )); then
      log "  skip $name (size $size < min $MIN_TARGET_BYTES)"
      continue
    fi
    # Skip other removable USB disks unless nothing better exists (handled by score)
    score=$(pick_score "$name" "${tran:-}" "${rm:-0}")
    log "  candidate $name size=$size tran=${tran:-?} rm=${rm:-?} score=$score"
    if (( score > BEST_SCORE || (score == BEST_SCORE && size > TARGET_BYTES) )); then
      TARGET_DISK="$name"
      TARGET_BYTES=$size
      BEST_SCORE=$score
    fi
  done < <(lsblk -b -dn -o NAME,SIZE,TYPE,TRAN,RM -p)
fi

if [[ -z "$TARGET_DISK" ]]; then
  log "ERROR: No usable internal disk ≥ $(( MIN_TARGET_BYTES / 1024 / 1024 / 1024 )) GiB found (other than $BOOT_DISK)."
  log "Dell Wyse / thin clients: internal storage is usually /dev/mmcblk0 (eMMC)."
  log "If lsblk shows it, re-run with: sudo TARGET_DISK=/dev/mmcblk0 /usr/local/lib/mt-billing/usb-install-to-disk.sh"
  log "If no mmcblk device appears, enable eMMC in BIOS / try another kernel, then reboot."
  sleep 120
  exit 1
fi

log "Target disk: $TARGET_DISK ($(( TARGET_BYTES / 1024 / 1024 )) MiB / $(( TARGET_BYTES / 1024 / 1024 / 1024 )) GiB)"
log "WARNING: All data on $TARGET_DISK will be erased."

# Release any mounts/holders on the target (old Ubuntu on eMMC is often still mounted/busy).
release_disk() {
  local disk="$1" part
  log "Releasing mounts/holders on $disk…"
  # Swap on target partitions
  while read -r swapdev; do
    [[ -z "$swapdev" ]] && continue
    case "$swapdev" in
      ${disk}p*|"${disk}"[0-9]*) swapoff "$swapdev" 2>/dev/null || true ;;
    esac
  done < <(awk '/^\/dev\// {print $1}' /proc/swaps 2>/dev/null || true)
  # Mounted filesystems on target
  while read -r mp; do
    [[ -z "$mp" ]] && continue
    umount -R "$mp" 2>/dev/null || umount -l "$mp" 2>/dev/null || true
  done < <(findmnt -n -o TARGET -S "${disk}*" 2>/dev/null || true)
  while read -r part; do
    [[ -b "$part" ]] || continue
    umount -R "$part" 2>/dev/null || umount -l "$part" 2>/dev/null || true
  done < <(lsblk -ln -o NAME -p -n "$disk" 2>/dev/null | grep -v "^${disk}$" || true)
  # LVM / device-mapper on target
  if command -v dmsetup >/dev/null 2>&1; then
    dmsetup remove_all 2>/dev/null || true
  fi
  sync
  sleep 1
}

release_disk "$TARGET_DISK"

apt-get update -qq
apt-get install -y -qq parted gdisk e2fsprogs dosfstools rsync grub-efi-amd64 grub-efi-amd64-bin \
  efibootmgr util-linux 2>&1 | tail -20

release_disk "$TARGET_DISK"
wipefs -a "$TARGET_DISK" 2>/dev/null || true

# Prefer sgdisk for GPT on eMMC; fall back to parted. If a previous attempt
# already created our 512MiB ESP + root layout, skip repartition (avoids the
# classic "Error during partitioning" / busy-kernel failure on Wyse).
EFI_PART=""
ROOT_PART=""
if [[ -b "${TARGET_DISK}p1" ]]; then
  EFI_PART="${TARGET_DISK}p1"
  ROOT_PART="${TARGET_DISK}p2"
else
  EFI_PART="${TARGET_DISK}1"
  ROOT_PART="${TARGET_DISK}2"
fi

reuse_parts=0
if [[ -b "$EFI_PART" && -b "$ROOT_PART" ]]; then
  efi_sz="$(lsblk -b -dn -o SIZE -p "$EFI_PART" 2>/dev/null || echo 0)"
  root_sz="$(lsblk -b -dn -o SIZE -p "$ROOT_PART" 2>/dev/null || echo 0)"
  # ESP ~512 MiB (allow 256–768 MiB); root must be the bulk of the disk.
  if (( efi_sz >= 268435456 && efi_sz <= 805306368 && root_sz >= 2147483648 )); then
    reuse_parts=1
    log "Reusing existing partitions $EFI_PART ($(echo "$efi_sz" | awk '{printf "%.0fMiB",$1/1024/1024}')) + $ROOT_PART — skipping repartition."
  fi
fi

if [[ "$reuse_parts" -ne 1 ]]; then
  log "Partitioning $TARGET_DISK (GPT: EFI 512MiB + root)…"
  sgdisk --zap-all "$TARGET_DISK" 2>/dev/null || true
  partx -d "$TARGET_DISK" 2>/dev/null || true
  blockdev --rereadpt "$TARGET_DISK" 2>/dev/null || true
  sleep 1

  if command -v sgdisk >/dev/null 2>&1; then
    # sgdisk is more reliable than parted on busy eMMC after a failed attempt.
    sgdisk -n 1:2048:1050623 -t 1:EF00 -c 1:EFI "$TARGET_DISK" || true
    sgdisk -n 2:1050624:0 -t 2:8300 -c 2:root "$TARGET_DISK" || true
    sgdisk -p "$TARGET_DISK" || true
  else
    # parted returns non-zero when it cannot inform a busy kernel — table is often
    # still written. Tolerate that and rely on partprobe/partx + node checks below.
    parted -s "$TARGET_DISK" mklabel gpt || true
    parted -s "$TARGET_DISK" mkpart ESP fat32 1MiB 513MiB || true
    parted -s "$TARGET_DISK" set 1 esp on || true
    parted -s "$TARGET_DISK" mkpart root ext4 513MiB 100% || true
  fi

  sleep 2
  partprobe "$TARGET_DISK" 2>/dev/null || true
  partx -u "$TARGET_DISK" 2>/dev/null || true
  blockdev --rereadpt "$TARGET_DISK" 2>/dev/null || true
  udevadm settle 2>/dev/null || true
  sleep 2

  if [[ -b "${TARGET_DISK}p1" ]]; then
    EFI_PART="${TARGET_DISK}p1"
    ROOT_PART="${TARGET_DISK}p2"
  else
    EFI_PART="${TARGET_DISK}1"
    ROOT_PART="${TARGET_DISK}2"
  fi

  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    if [[ -b "$EFI_PART" && -b "$ROOT_PART" ]]; then
      break
    fi
    log "Waiting for new partitions to appear ($i)…"
    sleep 1
    partprobe "$TARGET_DISK" 2>/dev/null || true
    partx -u "$TARGET_DISK" 2>/dev/null || true
    blockdev --rereadpt "$TARGET_DISK" 2>/dev/null || true
  done
fi

if [[ ! -b "$EFI_PART" || ! -b "$ROOT_PART" ]]; then
  log "ERROR: Partitions not visible ($EFI_PART / $ROOT_PART)."
  log "Reboot from this USB stick (F12 → USB), then run the installer again:"
  log "  sudo /usr/local/lib/mt-billing/usb-install-to-disk.sh"
  log "If it still fails: sudo TARGET_DISK=/dev/mmcblk0 /usr/local/lib/mt-billing/usb-install-to-disk.sh"
  sleep 60
  exit 1
fi

# Kill anything still holding the new partition nodes (common on eMMC after GPT rewrite).
release_disk "$TARGET_DISK"
for part in "$EFI_PART" "$ROOT_PART"; do
  fuser -km "$part" 2>/dev/null || true
  umount -l "$part" 2>/dev/null || true
  wipefs -a "$part" 2>/dev/null || true
done
sync
sleep 2

log "Formatting $EFI_PART (EFI) and $ROOT_PART (root)"
if ! mkfs.vfat -F 32 -n EFI "$EFI_PART"; then
  log "ERROR: mkfs.vfat failed on $EFI_PART (device busy)."
  log "Reboot from this USB stick, then run:"
  log "  sudo /usr/local/lib/mt-billing/usb-install-to-disk.sh"
  sleep 60
  exit 1
fi
if ! mkfs.ext4 -F -L mtbilling "$ROOT_PART"; then
  log "ERROR: mkfs.ext4 failed on $ROOT_PART (device busy)."
  log "This usually means the kernel still has the old eMMC mapping."
  log "Reboot from this USB stick (do not boot internal disk), then run:"
  log "  sudo /usr/local/lib/mt-billing/usb-install-to-disk.sh"
  sleep 60
  exit 1
fi

mkdir -p "$TARGET_MNT"
mount "$ROOT_PART" "$TARGET_MNT"
mkdir -p "$TARGET_MNT/boot/efi"
mount "$EFI_PART" "$TARGET_MNT/boot/efi"

log "Copying system from USB → $TARGET_DISK (several minutes)…"
rsync -aHAX --info=progress2 \
  --exclude=/dev \
  --exclude=/proc \
  --exclude=/sys \
  --exclude=/run \
  --exclude=/tmp \
  --exclude=/mnt \
  --exclude=/media \
  --exclude=/lost+found \
  --exclude="$TARGET_MNT" \
  --exclude=/var/log/mt-billing-usb-install.log \
  / "$TARGET_MNT/"

mkdir -p "$TARGET_MNT"/{dev,proc,sys,run,tmp}

ROOT_UUID=$(blkid -s UUID -o value "$ROOT_PART")
EFI_UUID=$(blkid -s UUID -o value "$EFI_PART")

cat > "$TARGET_MNT/etc/fstab" <<EOF
UUID=$ROOT_UUID / ext4 defaults,noatime 0 1
UUID=$EFI_UUID /boot/efi vfat umask=0077 0 1
EOF

# Installed disk is not a USB installer
rm -f "$TARGET_MNT$MARKER"
rm -f "$TARGET_MNT/etc/systemd/system/multi-user.target.wants/mt-billing-usb-install.service"
rm -f "$TARGET_MNT/lib/systemd/system/mt-billing-usb-install.service"
rm -f "$TARGET_MNT/etc/systemd/system/mt-billing-usb-install.service"
# Keep firstboot enabled so MT-Billing installs on first boot from internal disk
mkdir -p "$TARGET_MNT/etc/systemd/system/multi-user.target.wants"
if [[ -f "$TARGET_MNT/etc/systemd/system/mt-billing-firstboot.service" ]]; then
  ln -sf /etc/systemd/system/mt-billing-firstboot.service \
    "$TARGET_MNT/etc/systemd/system/multi-user.target.wants/mt-billing-firstboot.service"
elif [[ -f "$TARGET_MNT/lib/systemd/system/mt-billing-firstboot.service" ]]; then
  ln -sf /lib/systemd/system/mt-billing-firstboot.service \
    "$TARGET_MNT/etc/systemd/system/multi-user.target.wants/mt-billing-firstboot.service"
fi

cat > "$TARGET_MNT/tmp/install-grub.sh" <<'GRUB'
#!/bin/bash
set -euo pipefail
mount -t proc proc /proc
mount -t sysfs sys /sys
mount -t devtmpfs dev /dev 2>/dev/null || mount --bind /dev /dev
mkdir -p /dev/pts
mount -t devpts devpts /dev/pts 2>/dev/null || true
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq || true
apt-get install -y -qq grub-efi-amd64 grub-efi-amd64-bin efibootmgr || true
grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=ubuntu --recheck --removable
# Wyse 3040 firmware only honors the removable/fallback path EFI/BOOT/BOOTX64.EFI
grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=ubuntu --recheck || true
update-grub
sync
GRUB
chmod +x "$TARGET_MNT/tmp/install-grub.sh"

log "Installing UEFI GRUB on $TARGET_DISK…"
mount --bind /dev "$TARGET_MNT/dev"
mount --bind /proc "$TARGET_MNT/proc"
mount --bind /sys "$TARGET_MNT/sys"
chroot "$TARGET_MNT" /tmp/install-grub.sh
umount "$TARGET_MNT/sys" 2>/dev/null || true
umount "$TARGET_MNT/proc" 2>/dev/null || true
umount "$TARGET_MNT/dev" 2>/dev/null || true
rm -f "$TARGET_MNT/tmp/install-grub.sh"

sync
umount "$TARGET_MNT/boot/efi" 2>/dev/null || true
umount "$TARGET_MNT" 2>/dev/null || true

log "=== Install finished ==="
log "1. Power will shut off shortly."
log "2. Unplug this USB stick."
log "3. Power on the PC and boot from the internal disk (UEFI)."
log "4. First boot installs MT-Billing (needs internet; can take 10–20 minutes)."
log "5. Panel: http://<pc-ip>:4000  —  admin / admin123"
log "   SSH: mtadmin / mtbilling"
sleep 15
poweroff -f || systemctl poweroff || true
