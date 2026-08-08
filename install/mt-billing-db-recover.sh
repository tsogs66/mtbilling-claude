#!/usr/bin/env bash
# Copyright (c) 2026 MT-Billing / ts0gs
# License: MIT
# Source: https://github.com/tsogs66/mtbilling-claude
#
# Recover a corrupted SQLite DB so mt-billing-api can start again.
#
# Usage (on the billing host):
#   sudo bash /opt/mt-billing/install/mt-billing-db-recover.sh
#   sudo bash /opt/mt-billing/install/mt-billing-db-recover.sh --from backup-2026-07-30T13-08-15-196Z.db
#   sudo bash /opt/mt-billing/install/mt-billing-db-recover.sh --from /root/my-backup.db
#   sudo bash /opt/mt-billing/install/mt-billing-db-recover.sh --reset-db
#
# Order of operations:
#   1) stop API
#   2) if --from given, restore that file (name under server/data/backups/ or full path)
#   3) else restore newest healthy backup (panel backups or /var/backups)
#   4) else sqlite3 .recover from the corrupt live DB
#   5) with --reset-db: wipe DB and let the API re-seed (loses billing data)
#
set -euo pipefail

INSTALL_DIR="${var_install_dir:-${INSTALL_DIR:-/opt/mt-billing}}"
DATA_DIR="${INSTALL_DIR}/server/data"
DB_PATH="${DATA_DIR}/mt-billing.db"
PANEL_BACKUPS="${DATA_DIR}/backups"
VAR_BACKUPS="/var/backups/mt-billing"
SERVICE_UNIT="mt-billing-api"
API_HEALTH="http://127.0.0.1:4000/api/health"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
QUARANTINE="${DATA_DIR}/corrupt-${STAMP}"
RESET_DB=0
FROM_PATH=""

log_info() { printf '\033[1;34m[INFO]\033[0m %s\n' "$*"; }
log_ok() { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
log_warn() { printf '\033[1;33m[WARN]\033[0m %s\n' "$*"; }
log_err() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; }

prev=""
for arg in "$@"; do
  if [[ "$prev" == "--from" ]]; then
    FROM_PATH="$arg"
    prev=""
    continue
  fi
  case "$arg" in
    --from) prev="--from" ;;
    --reset-db) RESET_DB=1 ;;
    -h|--help)
      sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
  esac
done
if [[ "$prev" == "--from" ]]; then
  log_err "--from requires a backup file name or path"
  exit 1
fi

if [[ "$(id -u)" -ne 0 ]]; then
  log_err "Run as root: sudo bash $0"
  exit 1
fi

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    log_err "Missing command: $1"
    exit 1
  }
}

need_cmd systemctl
if ! command -v sqlite3 >/dev/null 2>&1; then
  log_info "Installing sqlite3..."
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq sqlite3
fi
need_cmd sqlite3

SERVICE_USER="mtbilling"
if [[ -f "/etc/systemd/system/${SERVICE_UNIT}.service" ]]; then
  detected="$(grep '^User=' "/etc/systemd/system/${SERVICE_UNIT}.service" | cut -d= -f2 || true)"
  [[ -n "$detected" ]] && SERVICE_USER="$detected"
fi

db_ok() {
  local path="$1"
  [[ -f "$path" ]] || return 1
  local out
  out="$(sqlite3 "$path" 'PRAGMA integrity_check;' 2>/dev/null || true)"
  [[ "$out" == "ok" ]]
}

quarantine_live() {
  mkdir -p "$QUARANTINE"
  local f
  for f in "${DB_PATH}" "${DB_PATH}-wal" "${DB_PATH}-shm"; do
    if [[ -e "$f" ]]; then
      mv "$f" "$QUARANTINE/"
      log_info "Moved $(basename "$f") → ${QUARANTINE}/"
    fi
  done
}

fix_owner() {
  if id "$SERVICE_USER" >/dev/null 2>&1; then
    chown -R "${SERVICE_USER}:${SERVICE_USER}" "$DATA_DIR" 2>/dev/null || true
  fi
}

start_and_check() {
  fix_owner
  systemctl reset-failed "$SERVICE_UNIT" 2>/dev/null || true
  systemctl start "$SERVICE_UNIT"
  sleep 2
  if curl -fsS --max-time 5 "$API_HEALTH" >/dev/null 2>&1; then
    log_ok "API is healthy at ${API_HEALTH}"
    systemctl --no-pager --full status "$SERVICE_UNIT" | head -n 12 || true
    return 0
  fi
  log_err "API still not healthy. Last logs:"
  journalctl -u "$SERVICE_UNIT" -n 30 --no-pager || true
  return 1
}

find_backup_candidates() {
  local -a found=()
  local f

  if [[ -d "$PANEL_BACKUPS" ]]; then
    while IFS= read -r f; do
      [[ -n "$f" ]] && found+=("$f")
    done < <(find "$PANEL_BACKUPS" -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) 2>/dev/null | sort -r)
  fi

  if [[ -d "$VAR_BACKUPS" ]]; then
    while IFS= read -r f; do
      [[ -n "$f" ]] && found+=("$f")
    done < <(find "$VAR_BACKUPS" -type f -name '*.db' 2>/dev/null | sort -r)

    # Unpack newest tarball that contains a db into a temp dir and test it
    local tar
    while IFS= read -r tar; do
      [[ -z "$tar" ]] && continue
      local unpack
      unpack="$(mktemp -d /tmp/mtb-db-unpack.XXXXXX)"
      if tar -tzf "$tar" 2>/dev/null | grep -qE 'mt-billing\.db$'; then
        tar -xzf "$tar" -C "$unpack" --wildcards --no-anchored 'mt-billing.db' 2>/dev/null \
          || tar -xzf "$tar" -C "$unpack" 2>/dev/null || true
        while IFS= read -r f; do
          [[ -n "$f" ]] && found+=("$f")
        done < <(find "$unpack" -type f -name 'mt-billing.db' 2>/dev/null)
      else
        rm -rf "$unpack"
      fi
    done < <(find "$VAR_BACKUPS" -type f \( -name '*.tar.gz' -o -name '*.tgz' \) 2>/dev/null | sort -r | head -n 5)
  fi

  printf '%s\n' "${found[@]+"${found[@]}"}"
}

apply_backup_file() {
  local candidate="$1"
  if ! db_ok "$candidate"; then
    log_err "Backup failed integrity_check: ${candidate}"
    return 1
  fi
  quarantine_live
  cp -a "$candidate" "$DB_PATH"
  rm -f "${DB_PATH}-wal" "${DB_PATH}-shm"
  log_ok "Restored from ${candidate}"
  return 0
}

resolve_from_arg() {
  local arg="$1"
  local candidates=()
  if [[ -f "$arg" ]]; then
    candidates+=("$arg")
  fi
  if [[ -f "${PANEL_BACKUPS}/${arg}" ]]; then
    candidates+=("${PANEL_BACKUPS}/${arg}")
  fi
  if [[ -f "${DATA_DIR}/${arg}" ]]; then
    candidates+=("${DATA_DIR}/${arg}")
  fi
  if [[ -f "/root/${arg}" ]]; then
    candidates+=("/root/${arg}")
  fi
  if [[ -f "/tmp/${arg}" ]]; then
    candidates+=("/tmp/${arg}")
  fi
  if [[ "${#candidates[@]}" -eq 0 ]]; then
    log_err "Backup not found: ${arg}"
    log_err "Tried: ${arg}, ${PANEL_BACKUPS}/${arg}, ${DATA_DIR}/${arg}, /root/${arg}, /tmp/${arg}"
    return 1
  fi
  printf '%s\n' "${candidates[0]}"
}

restore_from_explicit() {
  local resolved
  resolved="$(resolve_from_arg "$FROM_PATH")" || return 1
  log_info "Using --from backup: ${resolved}"
  apply_backup_file "$resolved"
}

restore_from_backup() {
  log_info "Searching for healthy backups..."
  local candidate
  local tried=0
  while IFS= read -r candidate; do
    [[ -z "$candidate" ]] && continue
    tried=$((tried + 1))
    log_info "Testing backup: ${candidate}"
    if apply_backup_file "$candidate"; then
      return 0
    fi
    log_warn "Skipping unhealthy backup: ${candidate}"
  done < <(find_backup_candidates)

  if [[ "$tried" -eq 0 ]]; then
    log_warn "No backup files found under ${PANEL_BACKUPS} or ${VAR_BACKUPS}"
  else
    log_warn "No healthy backup among ${tried} candidate(s)"
  fi
  return 1
}

recover_with_sqlite() {
  if [[ ! -f "$DB_PATH" ]]; then
    # May already be quarantined; try the quarantined copy
    if [[ -f "${QUARANTINE}/mt-billing.db" ]]; then
      cp -a "${QUARANTINE}/mt-billing.db" "$DB_PATH"
    else
      log_warn "No live DB file to recover"
      return 1
    fi
  fi

  log_info "Attempting sqlite3 .recover on live DB..."
  local sql="${DATA_DIR}/mt-billing.recovered-${STAMP}.sql"
  local recovered="${DATA_DIR}/mt-billing.recovered-${STAMP}.db"

  if ! sqlite3 "$DB_PATH" ".recover" >"$sql" 2>/tmp/mtb-recover.err; then
    log_warn "sqlite3 .recover failed: $(head -n 5 /tmp/mtb-recover.err 2>/dev/null || true)"
    return 1
  fi
  if [[ ! -s "$sql" ]]; then
    log_warn "sqlite3 .recover produced an empty dump"
    return 1
  fi

  rm -f "$recovered"
  if ! sqlite3 "$recovered" <"$sql"; then
    log_warn "Could not rebuild DB from recovered SQL"
    return 1
  fi
  if ! db_ok "$recovered"; then
    log_warn "Recovered DB still fails integrity_check"
    return 1
  fi

  quarantine_live
  mv "$recovered" "$DB_PATH"
  rm -f "${DB_PATH}-wal" "${DB_PATH}-shm"
  log_ok "Recovered DB written to ${DB_PATH}"
  return 0
}

reset_fresh_db() {
  log_warn "Creating a FRESH database (billing data will be lost)"
  quarantine_live
  rm -f "${DB_PATH}-wal" "${DB_PATH}-shm"
  # Empty path: API creates + seeds on first boot
  log_ok "Corrupt DB quarantined at ${QUARANTINE}"
}

# ── main ────────────────────────────────────────────────────────────
echo
echo "MT-Billing SQLite recovery"
echo "  Install : ${INSTALL_DIR}"
echo "  Database: ${DB_PATH}"
echo

log_info "Stopping ${SERVICE_UNIT}..."
systemctl stop "$SERVICE_UNIT" 2>/dev/null || true
sleep 1

mkdir -p "$DATA_DIR"
log_info "Current data dir:"
ls -lah "$DATA_DIR" || true
echo
if [[ -d "$PANEL_BACKUPS" ]]; then
  log_info "Panel backups:"
  ls -lah "$PANEL_BACKUPS" || true
  echo
fi
if [[ -d "$VAR_BACKUPS" ]]; then
  log_info "System backups:"
  ls -lah "$VAR_BACKUPS" || true
  echo
fi

if [[ -f "$DB_PATH" ]] && db_ok "$DB_PATH"; then
  log_ok "Live database already passes integrity_check — starting API"
  start_and_check
  exit $?
fi

if [[ "$RESET_DB" -eq 1 ]]; then
  reset_fresh_db
  start_and_check
  exit $?
fi

if restore_from_backup; then
  start_and_check
  exit $?
fi

# Ensure we still have a file to recover from
if [[ ! -f "$DB_PATH" ]] && [[ -f "${QUARANTINE}/mt-billing.db" ]]; then
  cp -a "${QUARANTINE}/mt-billing.db" "$DB_PATH"
fi

if recover_with_sqlite; then
  start_and_check
  exit $?
fi

log_err "Could not restore or recover automatically."
log_err "To wipe and start with a fresh DB (LOSES DATA), run:"
log_err "  sudo bash $0 --reset-db"
exit 2
