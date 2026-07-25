#!/usr/bin/env bash
# Sync install/mt-billing-install.sh into the embedded block of ct/mt-billing.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CT="$ROOT/ct/mt-billing.sh"
INSTALL="$ROOT/install/mt-billing-install.sh"

[[ -f "$CT" && -f "$INSTALL" ]] || { echo "Missing ct or install script" >&2; exit 1; }

tmp="$(mktemp)"
# Keep host script up to (but not including) the install body after the marker.
awk '
  /^# @@INSTALL_BEGIN@@$/ { print; exit }
  { print }
' "$CT" >"$tmp"

{
  echo '# @@INSTALL_BEGIN@@'
  # Drop copyright header from install file; keep executable body for build.func
  awk '
    BEGIN { skip=1 }
    /^source \/dev\/stdin/ { skip=0 }
    skip==0 { print }
  ' "$INSTALL"
  echo '# @@INSTALL_END@@'
} >>"$tmp"

mv "$tmp" "$CT"
chmod 755 "$CT"
echo "Synced $INSTALL → embedded block in $CT"
