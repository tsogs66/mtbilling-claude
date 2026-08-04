#!/usr/bin/env bash
# Package the Windows installer scripts into dist/windows/mt-billing-windows-x64.zip
# (The zip is the installer payload; Node build happens on the Windows machine.)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${ROOT}/dist/windows"
STAGE="${OUT_DIR}/stage"
ZIP_NAME="mt-billing-windows-x64.zip"
ZIP_PATH="${OUT_DIR}/${ZIP_NAME}"

rm -rf "$STAGE"
mkdir -p "$STAGE" "$OUT_DIR"

cp -a "$ROOT/install/windows/." "$STAGE/"
printf '%s\n' \
  'MT-Billing Windows installer' \
  '' \
  '1. Right-click install.cmd → Run as administrator' \
  '2. Open http://127.0.0.1/ and sign in (admin / admin123)' \
  '' \
  'See README.md for options and uninstall.' \
  >"$STAGE/INSTALL.txt"

rm -f "$ZIP_PATH" "${ZIP_PATH}.sha256"
if command -v zip >/dev/null 2>&1; then
  (cd "$STAGE" && zip -qr "$ZIP_PATH" .)
else
  OUT="$ZIP_PATH" STAGE="$STAGE" python3 - <<'PY'
import os, zipfile
out = os.environ["OUT"]
stage = os.environ["STAGE"]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _dirs, files in os.walk(stage):
        for f in files:
            path = os.path.join(root, f)
            z.write(path, os.path.relpath(path, stage))
print("wrote", out)
PY
fi

if command -v sha256sum >/dev/null 2>&1; then
  (cd "$OUT_DIR" && sha256sum "$ZIP_NAME" >"${ZIP_NAME}.sha256")
elif command -v shasum >/dev/null 2>&1; then
  (cd "$OUT_DIR" && shasum -a 256 "$ZIP_NAME" >"${ZIP_NAME}.sha256")
fi

rm -rf "$STAGE"
echo "Wrote $ZIP_PATH"
ls -la "$ZIP_PATH"*
