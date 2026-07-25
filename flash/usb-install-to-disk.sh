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

# Wait for disks to settle
sleep 5
udevadm settle 2>/dev/null || true

ROOT_SRC=$(findmnt -n -o SOURCE /)
BOOT_PART=$(lsblk -no PKNAME,NAME,TYPE -p "$ROOT_SRC" 2>/dev/null | awk '$3=="part"{print $2; exit}')
[[ -n "$BOOT_PART" ]] || BOOT_PART="$ROOT_SRC"
BOOT_DISK="/dev/$(lsblk -no PKNAME -d "$BOOT_PART" 2>/dev/null | head -1)"
if [[ -z "$BOOT_DISK" || "$BOOT_DISK" == "/dev/" ]]; then
  BOOT_DISK=$(lsblk -no PKNAME -p "$BOOT_PART" | head -1)
  BOOT_DISK="/dev/${BOOT_DISK#/dev/}"
fi

log "Boot medium: $BOOT_DISK (root $ROOT_SRC)"

# Largest non-boot disk ≥ 8 GiB
TARGET_DISK=""
TARGET_BYTES=0
while read -r name size type; do
  [[ "$type" == "disk" ]] || continue
  [[ -b "$name" ]] || continue
  [[ "$name" == "$BOOT_DISK" ]] && continue
  # Skip obvious USB if path still matches boot (already skipped)
  if (( size >= 8589934592 && size > TARGET_BYTES )); then
    TARGET_DISK="$name"
    TARGET_BYTES=$size
  fi
done < <(lsblk -b -dn -o NAME,SIZE,TYPE -p)

if [[ -z "$TARGET_DISK" ]]; then
  log "ERROR: No internal disk ≥ 8 GB found (other than $BOOT_DISK)."
  log "Connect a target drive and reboot with this USB stick."
  sleep 120
  exit 1
fi

log "Target disk: $TARGET_DISK ($(( TARGET_BYTES / 1024 / 1024 / 1024 )) GiB)"
log "WARNING: All data on $TARGET_DISK will be erased."

apt-get update -qq
apt-get install -y -qq parted gdisk e2fsprogs dosfstools rsync grub-efi-amd64 grub-efi-amd64-bin \
  efibootmgr util-linux 2>&1 | tail -20

wipefs -a "$TARGET_DISK" 2>/dev/null || true
sgdisk --zap-all "$TARGET_DISK" 2>/dev/null || true

parted -s "$TARGET_DISK" mklabel gpt
parted -s "$TARGET_DISK" mkpart ESP fat32 1MiB 513MiB
parted -s "$TARGET_DISK" set 1 esp on
parted -s "$TARGET_DISK" mkpart root ext4 513MiB 100%

sleep 2
partprobe "$TARGET_DISK" 2>/dev/null || true
udevadm settle 2>/dev/null || true
sleep 2

if [[ -b "${TARGET_DISK}p1" ]]; then
  EFI_PART="${TARGET_DISK}p1"
  ROOT_PART="${TARGET_DISK}p2"
else
  EFI_PART="${TARGET_DISK}1"
  ROOT_PART="${TARGET_DISK}2"
fi

for i in 1 2 3 4 5 6 7 8 9 10; do
  [[ -b "$EFI_PART" && -b "$ROOT_PART" ]] && break
  sleep 1
  partprobe "$TARGET_DISK" 2>/dev/null || true
done

log "Formatting $EFI_PART (EFI) and $ROOT_PART (root)"
mkfs.vfat -F 32 -n EFI "$EFI_PART"
mkfs.ext4 -F -L mtbilling "$ROOT_PART"

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
grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=ubuntu --recheck
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
