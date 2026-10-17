#!/usr/bin/env bash
# Copyright (c) 2026 MT-Billing / Pa-North
# License: MIT
#
# Proxmox VE host — create a dedicated GenieACS LXC and wire MT-Billing automatically.
#
# One-liner (public repo):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/tsogs66/mtbilling-claude/main/scripts/proxmox-genieacs.sh)"
#
# Optional env (no prompts):
#   BILLING_CTID=101          MT-Billing container (auto-detect if unset)
#   GENIEACS_CTID=102         Force CT id (default: next free)
#   GENIEACS_RAM=2048         MB RAM
#   GENIEACS_DISK=20          GB rootfs
#   GENIEACS_CORES=2
#   GENIEACS_BRIDGE=vmbr0
#   GENIEACS_STORAGE=local-lvm   (auto-pick if unset)
#   GENIEACS_HOSTNAME=genieacs
#   REPO_RAW=https://raw.githubusercontent.com/tsogs66/mtbilling-claude/main

set -euo pipefail

REPO_RAW="${REPO_RAW:-https://raw.githubusercontent.com/tsogs66/mtbilling-claude/main}"
GUEST_INSTALL_URL="${GUEST_INSTALL_URL:-${REPO_RAW}/install/genieacs-guest-install.sh}"

GENIEACS_HOSTNAME="${GENIEACS_HOSTNAME:-genieacs}"
GENIEACS_RAM="${GENIEACS_RAM:-2048}"
GENIEACS_DISK="${GENIEACS_DISK:-20}"
GENIEACS_CORES="${GENIEACS_CORES:-2}"
GENIEACS_BRIDGE="${GENIEACS_BRIDGE:-vmbr0}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root on the Proxmox host." >&2
  exit 1
fi
if ! command -v pct >/dev/null 2>&1; then
  echo "pct not found — this script requires Proxmox VE." >&2
  exit 1
fi

find_billing_ctid() {
  local id
  for id in $(pct list 2>/dev/null | awk 'NR>1 && $2=="running" {print $1}'); do
    if pct exec "$id" -- test -f /etc/systemd/system/mt-billing-api.service 2>/dev/null; then
      echo "$id"
      return 0
    fi
  done
  for id in $(pct list 2>/dev/null | awk 'NR>1 {print $1}'); do
    local hn
    hn="$(pct config "$id" 2>/dev/null | awk -F': ' '/^hostname:/ {print $2}' || true)"
    if echo "$hn" | grep -qi 'mt-billing\|mtbilling'; then
      echo "$id"
      return 0
    fi
  done
  return 1
}

find_genieacs_ctid() {
  local id
  for id in $(pct list 2>/dev/null | awk 'NR>1 {print $1}'); do
    local hn
    hn="$(pct config "$id" 2>/dev/null | awk -F': ' '/^hostname:/ {print $2}' || true)"
    if [[ "$hn" == "$GENIEACS_HOSTNAME" ]]; then
      echo "$id"
      return 0
    fi
  done
  return 1
}

pick_storage() {
  if [[ -n "${GENIEACS_STORAGE:-}" ]]; then
    echo "$GENIEACS_STORAGE"
    return
  fi
  local s
  s="$(pvesm status 2>/dev/null | awk 'NR>1 && $2=="active" && ($3 ~ /rootdir|images/) {print $1; exit}')"
  if [[ -n "$s" ]]; then
    echo "$s"
    return
  fi
  s="$(pvesm status 2>/dev/null | awk 'NR>1 && $2=="active" {print $1; exit}')"
  echo "${s:-local-lvm}"
}

pick_template() {
  local t
  t="$(pveam list local 2>/dev/null | awk '/ubuntu-24.04-standard/ && /amd64/ {print $1; exit}')"
  if [[ -n "$t" ]]; then
    echo "$t"
    return
  fi
  t="$(pveam available --section system 2>/dev/null | awk '/ubuntu-24.04-standard/ && /amd64/ {print $2; exit}')"
  if [[ -z "$t" ]]; then
    echo "Could not find Ubuntu 24.04 template. Run: pveam update && pveam available --section system" >&2
    exit 1
  fi
  echo "Downloading template ${t}…" >&2
  pveam download local "$t"
  echo "local:vztmpl/${t}"
}

next_ctid() {
  if [[ -n "${GENIEACS_CTID:-}" ]]; then
    echo "$GENIEACS_CTID"
    return
  fi
  if command -v pvesh >/dev/null 2>&1; then
    pvesh get /cluster/nextid 2>/dev/null && return
  fi
  local max
  max="$(pct list 2>/dev/null | awk 'NR>1 {print $1}' | sort -n | tail -1)"
  echo $((max + 1))
}

wait_for_ip() {
  local ct="$1"
  local ip=""
  local i
  for i in $(seq 1 90); do
    ip="$(pct exec "$ct" -- bash -c "hostname -I 2>/dev/null | awk '{print \$1}'" 2>/dev/null || true)"
    if [[ -n "$ip" && "$ip" != "127.0.0.1" ]]; then
      echo "$ip"
      return 0
    fi
    sleep 2
  done
  return 1
}

ensure_billing_acs_schema() {
  local billing_ct="$1"
  local db="/opt/mt-billing/server/data/mt-billing.db"
  pct exec "$billing_ct" -- bash -s "$db" <<'EOS'
set -euo pipefail
DB="$1"
has_col() {
  sqlite3 "$DB" "SELECT 1 FROM pragma_table_info('$1') WHERE name='$2' LIMIT 1" 2>/dev/null | grep -q 1
}
add_col() {
  sqlite3 "$DB" "ALTER TABLE $1 ADD COLUMN $2 $3" 2>/dev/null || true
}
for spec in \
  "acs_enabled INTEGER DEFAULT 0" \
  "acs_nbi_url TEXT DEFAULT NULL" \
  "acs_ui_url TEXT DEFAULT NULL" \
  "acs_username TEXT DEFAULT NULL" \
  "acs_password TEXT DEFAULT NULL" \
  "acs_autolink_enabled INTEGER DEFAULT 1" \
  "acs_autolink_interval_min INTEGER DEFAULT 15" \
  "acs_provision_tags INTEGER DEFAULT 1" \
  "acs_provision_on_install INTEGER DEFAULT 1" \
  "acs_cwmp_url TEXT DEFAULT NULL"; do
  col="${spec%% *}"
  rest="${spec#"$col "}"
  has_col app_settings "$col" || add_col app_settings "$col" "$rest"
done
for spec in "acs_device_id TEXT" "cpe_mac TEXT"; do
  col="${spec%% *}"
  rest="${spec#"$col "}"
  has_col pppoe_users "$col" || add_col pppoe_users "$col" "$rest"
done
EOS
}

wire_billing() {
  local billing_ct="$1"
  local acs_ip="$2"
  local db="/opt/mt-billing/server/data/mt-billing.db"
  local nbi="http://${acs_ip}:7557"
  local ui="http://${acs_ip}:3000"
  local cwmp="http://${acs_ip}:7547/"

  if ! pct exec "$billing_ct" -- test -f "$db" 2>/dev/null; then
    echo "WARNING: MT-Billing DB not found at ${db} — enable TR-069 manually in System Settings." >&2
    return 1
  fi

  ensure_billing_acs_schema "$billing_ct"

  # app_settings sync triggers use json_object(); wide schemas break the host sqlite3 CLI on UPDATE.
  pct exec "$billing_ct" -- sqlite3 "$db" "
    DROP TRIGGER IF EXISTS sync_outbox_app_settings_ai;
    DROP TRIGGER IF EXISTS sync_outbox_app_settings_au;
    DROP TRIGGER IF EXISTS sync_outbox_app_settings_ad;
  " 2>/dev/null || true

  pct exec "$billing_ct" -- sqlite3 "$db" "
    UPDATE app_settings SET
      acs_enabled = 1,
      acs_nbi_url = '${nbi}',
      acs_ui_url = '${ui}',
      acs_cwmp_url = '${cwmp}',
      acs_autolink_enabled = COALESCE(acs_autolink_enabled, 1),
      acs_autolink_interval_min = COALESCE(acs_autolink_interval_min, 15),
      acs_provision_tags = COALESCE(acs_provision_tags, 1),
      acs_provision_on_install = COALESCE(acs_provision_on_install, 1)
    WHERE id = 1;
  "

  pct exec "$billing_ct" -- systemctl restart mt-billing-api 2>/dev/null || true
  echo "MT-Billing CT ${billing_ct} wired: NBI=${nbi} CWMP=${cwmp}"
}

echo "=== MT-Billing GenieACS LXC installer (unattended) ==="

BILLING_CTID="${BILLING_CTID:-}"
if [[ -z "$BILLING_CTID" ]]; then
  BILLING_CTID="$(find_billing_ctid)" || {
    echo "WARNING: No MT-Billing LXC detected. GenieACS will install; wire billing later." >&2
    BILLING_CTID=""
  }
fi
[[ -n "$BILLING_CTID" ]] && echo "MT-Billing container: CTID=${BILLING_CTID}"

BILLING_IP=""
if [[ -n "$BILLING_CTID" ]]; then
  pct start "$BILLING_CTID" 2>/dev/null || true
  BILLING_IP="$(wait_for_ip "$BILLING_CTID" || true)"
fi

ACS_CTID="${GENIEACS_CTID:-}"
if [[ -z "$ACS_CTID" ]]; then
  ACS_CTID="$(find_genieacs_ctid || true)"
fi
if [[ -z "$ACS_CTID" ]]; then
  ACS_CTID="$(next_ctid)"
  STORAGE="$(pick_storage)"
  TEMPLATE="$(pick_template)"
  echo "Creating GenieACS LXC CTID=${ACS_CTID} (${GENIEACS_CORES}c / ${GENIEACS_RAM}MB / ${GENIEACS_DISK}GB on ${STORAGE})"
  pct create "$ACS_CTID" "$TEMPLATE" \
    --hostname "$GENIEACS_HOSTNAME" \
    --cores "$GENIEACS_CORES" \
    --memory "$GENIEACS_RAM" \
    --rootfs "${STORAGE}:${GENIEACS_DISK}" \
    --net0 "name=eth0,bridge=${GENIEACS_BRIDGE},ip=dhcp" \
    --unprivileged 1 \
    --onboot 1 \
    --features nesting=0 \
    --tags "genieacs;tr069;mt-billing"
  pct set "$ACS_CTID" -description "GenieACS TR-069 ACS for MT-Billing (CWMP 7547)" >/dev/null 2>&1 || true
else
  echo "Reusing existing GenieACS LXC CTID=${ACS_CTID}"
fi

pct start "$ACS_CTID" 2>/dev/null || true
sleep 3

ACS_IP="$(wait_for_ip "$ACS_CTID")" || {
  echo "GenieACS container has no IP yet — check DHCP on ${GENIEACS_BRIDGE}." >&2
  exit 1
}
echo "GenieACS container IP: ${ACS_IP}"

echo "Installing MongoDB + GenieACS inside CT ${ACS_CTID}…"
# Fresh Ubuntu CT templates often have no curl — fetch on the Proxmox host and push in.
HOST_GUEST="/var/tmp/mt-billing-genieacs-guest-install.sh"
curl -fsSL "${GUEST_INSTALL_URL}" -o "$HOST_GUEST"
chmod +x "$HOST_GUEST"
pct push "$ACS_CTID" "$HOST_GUEST" /tmp/genieacs-guest-install.sh
pct exec "$ACS_CTID" -- chmod +x /tmp/genieacs-guest-install.sh
echo "Waiting for guest apt/network…"
for _ in $(seq 1 45); do
  if pct exec "$ACS_CTID" -- bash -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq' 2>/dev/null; then
    break
  fi
  sleep 2
done
pct exec "$ACS_CTID" -- env BILLING_IP="${BILLING_IP:-}" bash /tmp/genieacs-guest-install.sh

if [[ -n "$BILLING_CTID" ]]; then
  wire_billing "$BILLING_CTID" "$ACS_IP"
fi

echo ""
echo "=== Complete ==="
echo "GenieACS LXC     : CTID ${ACS_CTID}  IP ${ACS_IP}"
echo "CWMP (CPEs)      : http://${ACS_IP}:7547/  — forward TCP 7547 from WAN if CPEs are on the internet"
echo "GenieACS UI      : http://${ACS_IP}:3000/"
echo "GenieACS UI login: admin / admin (first install only; see /opt/genieacs/ui-login.txt in CT — change under Admin → Users)"
echo "NBI (MT-Billing) : http://${ACS_IP}:7557 (restricted to billing IP when UFW applied)"
if [[ -n "$BILLING_CTID" && -n "$BILLING_IP" ]]; then
  echo "MT-Billing panel : http://${BILLING_IP}/  → System Settings → TR-069 (already enabled)"
  echo "CPE manager      : http://${BILLING_IP}/cpe-tr069"
fi
echo "Services in ACS CT: systemctl status genieacs-cwmp genieacs-nbi"
if pct exec "$ACS_CTID" -- systemctl is-active --quiet genieacs-cwmp genieacs-nbi 2>/dev/null; then
  echo "GenieACS CWMP/NBI: active"
else
  echo "WARNING: Check guest install: pct enter ${ACS_CTID} — journalctl -u genieacs-cwmp -n 30" >&2
fi
