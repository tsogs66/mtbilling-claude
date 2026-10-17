#!/usr/bin/env bash
# Reset GenieACS UI login to admin/admin (or GENIEACS_UI_*). Run inside GenieACS LXC as root.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export GENIEACS_FORCE_RESET_UI_ADMIN=1
exec bash "${SCRIPT_DIR}/genieacs-ui-admin.sh"
