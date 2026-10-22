#!/usr/bin/env bash
# Backfill immutable numbered GitHub releases from saved workflow artifacts.
# Usage: ./scripts/backfill-android-numbered-releases.sh tsogs66/MT-Billing 39187645850:2 39778270875:4 ...
set -euo pipefail

REPO="${1:?repo e.g. tsogs66/MT-Billing}"
shift
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

publish_one() {
  local run_id="$1"
  local num="$2"
  local dir="$WORKDIR/run-$num"
  mkdir -p "$dir"
  if gh release view "android-apps-v${num}" --repo "$REPO" >/dev/null 2>&1; then
    echo "skip android-apps-v${num} (exists)"
    return 0
  fi
  echo "download run $run_id -> series v${num}"
  gh run download "$run_id" --repo "$REPO" -n android-apps-bundle -D "$dir"
  gh release create "android-apps-v${num}" \
    --repo "$REPO" \
    --title "MT-Billing Android Apps v${num} (1.0.${num})" \
    --notes "Backfilled immutable series release **#${num}** from workflow run ${run_id}." \
    --prerelease \
    "$dir/mt-billing-debug.apk" "$dir/panorth-debug.apk" "$dir/panorth-version.json"
  if ! gh release view "android-v${num}" --repo "$REPO" >/dev/null 2>&1; then
    gh release create "android-v${num}" \
      --repo "$REPO" \
      --title "MT-Billing Android staff v${num}" \
      --notes "Backfilled staff APK series **#${num}** (run ${run_id})." \
      --prerelease \
      "$dir/mt-billing-debug.apk"
  fi
  if ! gh release view "portal-android-v${num}" --repo "$REPO" >/dev/null 2>&1; then
    gh release create "portal-android-v${num}" \
      --repo "$REPO" \
      --title "PANORTH Android v${num} (1.0.${num})" \
      --notes "Backfilled PANORTH APK series **#${num}** (run ${run_id})." \
      --prerelease \
      "$dir/panorth-debug.apk" "$dir/panorth-version.json"
  fi
}

# Sort pairs by series number (field after colon)
mapfile -t SORTED < <(printf '%s\n' "$@" | sort -t: -k2 -n)
for pair in "${SORTED[@]}"; do
  run_id="${pair%%:*}"
  num="${pair##*:}"
  publish_one "$run_id" "$num"
done

echo "Done: $REPO"
