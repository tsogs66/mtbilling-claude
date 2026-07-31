#!/usr/bin/env bash
# Copyright (c) 2026 MT-Billing / ts0gs
# License: MIT
# Source: https://github.com/tsogs66/MT-Billing
#
# Shared helpers so Cloudflare Tunnel (cloudflared) and Twingate Client can
# run side-by-side without black-holing this host's local LAN or public DNS.
#
# Sourced by:
#   install/mt-billing-twingate.sh
#   install/mt-billing-cloudflare-tunnel.sh
#
# Also runnable alone:
#   sudo bash /opt/mt-billing/install/mt-billing-net-coexist.sh apply
#   sudo bash /opt/mt-billing/install/mt-billing-net-coexist.sh status
#
# Policy:
#   1. Default route must stay on the physical uplink (never sdwan0).
#   2. Connected LAN prefixes on eth*/en*/wlan* keep a low-metric on-link route
#      so Twingate Resource routes cannot steal local traffic.
#   3. DNS prefers original + public resolvers first; Twingate 100.95.* is
#      appended last (IP Resources still work via TUN routes; Cloudflare and
#      apt/git keep resolving when the Connector is down).
#   4. cloudflared is left alone — it is outbound-only and does not need LAN.

set -euo pipefail

MT_CONF="${MT_CONF:-/etc/mt-billing}"
RESOLV_BAK="${RESOLV_BAK:-${MT_CONF}/resolv.conf.twingate-bak}"
COEXIST_STATE="${MT_CONF}/net-coexist.state"
CF_UNIT="${CF_UNIT:-cloudflared-mt-billing.service}"

_coexist_log_info() { printf '\033[1;34m[COEXIST]\033[0m %s\n' "$*"; }
_coexist_log_ok() { printf '\033[1;32m[COEXIST]\033[0m %s\n' "$*"; }
_coexist_log_warn() { printf '\033[1;33m[COEXIST]\033[0m %s\n' "$*"; }

# Physical / LAN interfaces we protect (exclude lo, docker, bridges we don't own, sdwan)
_coexist_lan_ifaces() {
  ip -o link show up 2>/dev/null | awk -F': ' '{print $2}' | while read -r ifc; do
    case "$ifc" in
      lo|docker*|br-*|veth*|virbr*|sdwan*|tun*|wg*|zt*|tailscale*) continue ;;
    esac
    echo "$ifc"
  done
}

# Emit "cidr iface" lines for connected LAN prefixes
_coexist_lan_prefixes() {
  local ifc
  for ifc in $(_coexist_lan_ifaces); do
    ip -4 -o addr show dev "$ifc" 2>/dev/null | awk -v ifc="$ifc" '{print $4, ifc}'
  done
}

# Pin local LAN on-link routes at metric 5 (Twingate uses ~25 on sdwan0).
protect_local_lan_routes() {
  mkdir -p "$MT_CONF"
  local cidr ifc count=0
  while read -r cidr ifc; do
    [[ -n "$cidr" && -n "$ifc" ]] || continue
    # Skip obviously non-LAN CGNAT Twingate ranges if somehow assigned
    case "$cidr" in
      100.96.*|100.95.*|100.64.*) continue ;;
    esac
    if ip route replace "$cidr" dev "$ifc" metric 5 2>/dev/null \
      || ip route add "$cidr" dev "$ifc" metric 5 2>/dev/null \
      || ip route replace "${cidr%/*}" dev "$ifc" metric 5 2>/dev/null; then
      _coexist_log_ok "Pinned local LAN $cidr via $ifc (metric 5)"
      count=$((count + 1))
    else
      _coexist_log_warn "Could not pin $cidr via $ifc (may already be on-link)"
    fi
  done < <(_coexist_lan_prefixes)

  # Ensure default route is NOT via sdwan0
  local def_dev
  def_dev="$(ip route show default 2>/dev/null | awk '/default/ {print $5; exit}')"
  if [[ "$def_dev" == "sdwan0" ]]; then
    _coexist_log_warn "Default route is on sdwan0 — removing Twingate default to protect uplink"
    ip route del default dev sdwan0 2>/dev/null || true
  fi

  # Re-assert primary default if we have a remembered gateway
  if [[ -f "$COEXIST_STATE" ]]; then
    # shellcheck disable=SC1090
    source "$COEXIST_STATE" 2>/dev/null || true
    if [[ -n "${COEXIST_DEFAULT_GW:-}" && -n "${COEXIST_DEFAULT_DEV:-}" ]]; then
      ip route replace default via "$COEXIST_DEFAULT_GW" dev "$COEXIST_DEFAULT_DEV" metric 100 2>/dev/null \
        || ip route add default via "$COEXIST_DEFAULT_GW" dev "$COEXIST_DEFAULT_DEV" metric 100 2>/dev/null \
        || true
      _coexist_log_ok "Default route via ${COEXIST_DEFAULT_GW} dev ${COEXIST_DEFAULT_DEV}"
    fi
  fi

  if [[ "$count" -eq 0 ]]; then
    _coexist_log_warn "No LAN prefixes to pin (container/host may use a single uplink)"
  fi
}

snapshot_default_route() {
  mkdir -p "$MT_CONF"
  local gw dev
  gw="$(ip route show default 2>/dev/null | awk '/default/ {for(i=1;i<=NF;i++) if($i=="via"){print $(i+1); exit}}')"
  dev="$(ip route show default 2>/dev/null | awk '/default/ {for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')"
  if [[ -n "$gw" && -n "$dev" && "$dev" != "sdwan0" ]]; then
    cat >"$COEXIST_STATE" <<EOF
COEXIST_DEFAULT_GW=$gw
COEXIST_DEFAULT_DEV=$dev
COEXIST_SNAPSHOT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF
    _coexist_log_ok "Saved uplink default $gw via $dev"
  fi
}

# DNS for coexistence: local/public FIRST, Twingate LAST.
# IP-based Twingate Resources do not need Twingate DNS; Cloudflare / apt / git do.
write_coexist_resolv() {
  mkdir -p "$MT_CONF"
  local tmp tw_online=0
  tmp="$(mktemp)"

  if command -v twingate >/dev/null 2>&1 && [[ "$(twingate status 2>/dev/null || true)" == "online" ]]; then
    tw_online=1
  fi

  {
    echo "# MT-Billing net-coexist — local/public DNS first so Cloudflare Tunnel + LAN keep working."
    echo "# Twingate 100.95.* appended last (Resources use TUN routes for IPs)."
    if [[ -f "$RESOLV_BAK" ]]; then
      grep -E '^\s*nameserver\s+' "$RESOLV_BAK" || true
    elif [[ -f /etc/resolv.conf ]] && ! grep -qE '100\.95\.0\.25|managed by twingate' /etc/resolv.conf; then
      grep -E '^\s*nameserver\s+' /etc/resolv.conf || true
    fi
    echo "nameserver 8.8.8.8"
    echo "nameserver 1.1.1.1"
    echo "nameserver 9.9.9.9"
    if [[ "$tw_online" -eq 1 ]]; then
      echo "nameserver 100.95.0.251"
      echo "nameserver 100.95.0.252"
      echo "nameserver 100.95.0.253"
      echo "nameserver 100.95.0.254"
    fi
  } >"$tmp"

  awk '
    /^[[:space:]]*nameserver[[:space:]]+/ {
      if (!seen[$0]++) print
      next
    }
    { print }
  ' "$tmp" >/etc/resolv.conf
  rm -f "$tmp"
  _coexist_log_ok "Wrote coexist DNS (public/local first${tw_online:+, Twingate last})"
}

cloudflare_still_ok() {
  if ! command -v systemctl >/dev/null 2>&1 || [[ ! -d /run/systemd/system ]]; then
    return 0
  fi
  if ! systemctl list-unit-files "$CF_UNIT" >/dev/null 2>&1; then
    return 0
  fi
  if systemctl is-enabled --quiet "$CF_UNIT" 2>/dev/null || systemctl is-active --quiet "$CF_UNIT" 2>/dev/null; then
    if systemctl is-active --quiet "$CF_UNIT" 2>/dev/null; then
      _coexist_log_ok "cloudflared ($CF_UNIT) still active"
      return 0
    fi
    _coexist_log_warn "cloudflared unit present but not active — leaving alone (start from Cloudflare Access page)"
  fi
  return 0
}

# Resolve Cloudflare edge + a public name — proves DNS coexistence
coexist_dns_ok() {
  getent hosts api.cloudflare.com >/dev/null 2>&1 && return 0
  getent hosts github.com >/dev/null 2>&1 && return 0
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY' >/dev/null 2>&1
import socket
socket.getaddrinfo("api.cloudflare.com", 443, proto=socket.IPPROTO_TCP)
PY
    return $?
  fi
  return 1
}

apply_net_coexist() {
  _coexist_log_info "Applying Cloudflare + Twingate coexistence (protect LAN, safe DNS)"
  snapshot_default_route
  protect_local_lan_routes
  write_coexist_resolv
  cloudflare_still_ok
  if coexist_dns_ok; then
    _coexist_log_ok "Public DNS OK (Cloudflare edge resolvable)"
  else
    _coexist_log_warn "Public DNS check failed — check /etc/resolv.conf"
    return 1
  fi
  local def_dev
  def_dev="$(ip route show default 2>/dev/null | awk '/default/ {print $5; exit}')"
  if [[ "$def_dev" == "sdwan0" ]]; then
    _coexist_log_warn "Default still on sdwan0 after protect — coexistence incomplete"
    return 1
  fi
  _coexist_log_ok "Coexistence applied (default via ${def_dev:-unknown})"
  return 0
}

status_net_coexist() {
  local def tw cf dns=system
  def="$(ip route show default 2>/dev/null | head -1 | tr -s ' ')"
  tw="$(command -v twingate >/dev/null 2>&1 && twingate status 2>/dev/null || echo not-installed)"
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$CF_UNIT" 2>/dev/null; then
    cf=running
  elif command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files "$CF_UNIT" >/dev/null 2>&1; then
    cf=stopped
  else
    cf=not-installed
  fi
  if grep -qE '100\.95\.0\.25' /etc/resolv.conf 2>/dev/null; then
    # First nameserver?
    local first
    first="$(grep -E '^\s*nameserver\s+' /etc/resolv.conf | head -1 | awk '{print $2}')"
    if [[ "$first" == 100.95.* ]]; then
      dns=twingate-first
    else
      dns=coexist
    fi
  fi
  echo "default=${def}"
  echo "twingate=${tw}"
  echo "cloudflare=${cf}"
  echo "dns=${dns}"
  echo "lan_pins=$(_coexist_lan_prefixes | wc -l | tr -d ' ')"
}

# When executed directly (not sourced)
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "Run as root" >&2
    exit 1
  fi
  action="${1:-apply}"
  case "$action" in
    apply) apply_net_coexist ;;
    status) status_net_coexist ;;
    protect-lan) snapshot_default_route; protect_local_lan_routes ;;
    dns) write_coexist_resolv ;;
    *)
      echo "Usage: $0 [apply|status|protect-lan|dns]" >&2
      exit 1
      ;;
  esac
fi
