#!/usr/bin/env bash
# Alias for scripts/build-sbc-flash-image.sh (rpi | opi | pc | all).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec bash "$ROOT/scripts/build-sbc-flash-image.sh" "$@"
