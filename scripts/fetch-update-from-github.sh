#!/usr/bin/env bash
# Copyright (c) 2026 MT-Billing / ts0gs
# License: MIT
#
# Download MT-Billing update scripts from GitHub (raw) into install/.
# Use when the LXC was installed before auto-update existed, or to refresh
# updater files without a full git pull.
#
# Guest / VM (inside the container):
#   curl -fsSL https://raw.githubusercontent.com/tsogs66/MT-Billing/main/scripts/fetch-update-from-github.sh | sudo bash
#   sudo bash /opt/mt-billing/scripts/fetch-update-from-github.sh
#
# Proxmox host (copy into LXC):
#   sudo bash scripts/fetch-update-from-github.sh
#   CTID=101 sudo bash scripts/fetch-update-from-github.sh
#
# Options:
#   --run          run mt-billing-update.sh after download
#   --reinstall    run mt-billing-reinstall.sh after download (big update / factory reset)
#   --enable-timer install systemd timer units and enable auto-update
#
# Environment:
#   REPO_BRANCH / var_repo_branch   default main
#   INSTALL_DIR / var_install_dir   default /opt/mt-billing
#   CTID                            Proxmox container id (host mode only)

set -euo pipefail

REPO_OWNER="${REPO_OWNER:-tsogs66}"
REPO_NAME="${REPO_NAME:-MT-Billing}"
BRANCH="${var_repo_branch:-${REPO_BRANCH:-main}}"
INSTALL_DIR="${var_install_dir:-${INSTALL_DIR:-/opt/mt-billing}}"
RAW_BASE="https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${BRANCH}"

RUN_AFTER=0
RUN_REINSTALL=0
ENABLE_TIMER=0

for arg in "$@"; do
  case "$arg" in
    --run) RUN_AFTER=1 ;;
    --reinstall) RUN_REINSTALL=1 ;;
    --enable-timer) ENABLE_TIMER=1 ;;
    -h|--help)
      sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
  esac
done

UPDATE_FILES=(
  install/mt-billing-update.sh
  install/mt-billing-self-update.sh
  install/mt-billing-fix-now.sh
  install/mt-billing-reinstall.sh
  install/mt-billing-public-host.sh
  install/mt-billing-cloudflare-tunnel.sh
  install/mt-billing-grant-updater-root.sh
  install/mt-billing-panel-update.service
  install/mt-billing-sudoers
  install/mt-billing-auto-update.service
  install/mt-billing-auto-update.timer
)

guest_fetch() {
  local dest_root="$1"
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required." >&2
    exit 1
  fi
  mkdir -p "${dest_root}/install"
  local rel dest url
  for rel in "${UPDATE_FILES[@]}"; do
    dest="${dest_root}/${rel}"
    url="${RAW_BASE}/${rel}"
    echo "→ ${url}"
    curl -fsSL "$url" -o "$dest"
    if [[ "$rel" == *.sh ]]; then
      chmod 755 "$dest"
    else
      chmod 644 "$dest"
    fi
    echo "  saved ${dest}"
  done
}

guest_enable_timer() {
  local root="$1"
  sed "s|var_repo_branch=main|var_repo_branch=${BRANCH}|g" \
    "${root}/install/mt-billing-auto-update.service" \
    >/etc/systemd/system/mt-billing-auto-update.service
  install -m 644 "${root}/install/mt-billing-auto-update.timer" /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now mt-billing-auto-update.timer
  echo "Auto-update timer enabled (every 10 minutes)."
}

guest_run() {
  local root="$1"
  bash "${root}/install/mt-billing-update.sh"
}

guest_reinstall() {
  local root="$1"
  bash "${root}/install/mt-billing-reinstall.sh" --yes
}

# --- Proxmox host: pct exec into container ---
if [[ -n "${CTID:-}" ]] || command -v pct >/dev/null 2>&1 && [[ "$(id -u)" -eq 0 ]] && [[ -z "${FORCE_GUEST:-}" ]]; then
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "On Proxmox host, run as root or set FORCE_GUEST=1 to fetch locally." >&2
    exit 1
  fi
  if command -v pct >/dev/null 2>&1; then
    find_ctid() {
      local id
      for id in $(pct list 2>/dev/null | awk 'NR>1 && $2=="running" {print $1}'); do
        if pct exec "$id" -- test -f /etc/systemd/system/mt-billing-api.service 2>/dev/null; then
          echo "$id"
          return 0
        fi
      done
      for id in $(pct list 2>/dev/null | awk 'NR>1 {print $1}'); do
        local desc
        desc="$(pct config "$id" 2>/dev/null | grep -E '^hostname:|^description:' || true)"
        if echo "$desc" | grep -qi 'mt-billing\|mtbilling'; then
          echo "$id"
          return 0
        fi
      done
      return 1
    }
    CTID="${CTID:-}"
    if [[ -z "$CTID" ]]; then
      CTID="$(find_ctid)" || {
        echo "Could not detect MT-Billing LXC. Set CTID=<id> or run inside the guest." >&2
        exit 1
      }
      echo "Using container CTID=${CTID}"
    fi
    echo "Copying update files from GitHub (${BRANCH}) into CT ${CTID}:${INSTALL_DIR}/install/"
    for rel in "${UPDATE_FILES[@]}"; do
      url="${RAW_BASE}/${rel}"
      dest="${INSTALL_DIR}/${rel}"
      echo "→ ${rel}"
      pct exec "$CTID" -- bash -c "mkdir -p '${INSTALL_DIR}/install' && curl -fsSL '${url}' -o '${dest}'"
      if [[ "$rel" == *.sh ]]; then
        pct exec "$CTID" -- chmod 755 "$dest"
      else
        pct exec "$CTID" -- chmod 644 "$dest"
      fi
    done
    if [[ "$ENABLE_TIMER" == "1" ]]; then
      pct exec "$CTID" -- bash -c "
        sed 's|var_repo_branch=main|var_repo_branch=${BRANCH}|g' '${INSTALL_DIR}/install/mt-billing-auto-update.service' > /etc/systemd/system/mt-billing-auto-update.service
        install -m 644 '${INSTALL_DIR}/install/mt-billing-auto-update.timer' /etc/systemd/system/
        systemctl daemon-reload
        systemctl enable --now mt-billing-auto-update.timer
      "
      echo "Auto-update timer enabled in CT ${CTID}."
    fi
    if [[ "$RUN_AFTER" == "1" ]]; then
      pct exec "$CTID" -- bash "${INSTALL_DIR}/install/mt-billing-update.sh"
    fi
    if [[ "$RUN_REINSTALL" == "1" ]]; then
      pct exec "$CTID" -- bash "${INSTALL_DIR}/install/mt-billing-reinstall.sh" --yes
    fi
    echo "Done."
    exit 0
  fi
fi

# --- Guest / local ---
echo "Fetching update files from GitHub (${BRANCH}) → ${INSTALL_DIR}/install/"
guest_fetch "$INSTALL_DIR"

if [[ "$ENABLE_TIMER" == "1" ]]; then
  guest_enable_timer "$INSTALL_DIR"
fi

if [[ "$RUN_AFTER" == "1" ]]; then
  guest_run "$INSTALL_DIR"
fi

if [[ "$RUN_REINSTALL" == "1" ]]; then
  guest_reinstall "$INSTALL_DIR"
fi

echo "Update scripts ready under ${INSTALL_DIR}/install/"
