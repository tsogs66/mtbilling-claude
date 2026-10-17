#!/usr/bin/env bash
# Seed or reset GenieACS UI admin (MongoDB). Run inside GenieACS LXC as root.
# Env: GENIEACS_UI_USER, GENIEACS_UI_PASSWORD, GENIEACS_FORCE_RESET_UI_ADMIN=1
set -euo pipefail

GENIEACS_UI_USER="${GENIEACS_UI_USER:-admin}"
GENIEACS_UI_PASSWORD="${GENIEACS_UI_PASSWORD:-admin}"
GENIEACS_FORCE_RESET_UI_ADMIN="${GENIEACS_FORCE_RESET_UI_ADMIN:-0}"

log() { echo "[genieacs-ui-admin] $*"; }

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi

if ! command -v mongosh >/dev/null 2>&1; then
  log "ERROR: mongosh not found (install mongodb-org)"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  log "ERROR: node not found"
  exit 1
fi

for _ in $(seq 1 20); do
  if mongosh --quiet --eval 'db.runCommand({ ping: 1 }).ok' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

uid="${GENIEACS_UI_USER}"
existing="$(mongosh genieacs --quiet --eval "db.users.countDocuments({_id: '${uid}'})" 2>/dev/null | tr -d '[:space:]' || echo 0)"

if [[ "${existing}" != "0" && "${GENIEACS_FORCE_RESET_UI_ADMIN}" != "1" ]]; then
  log "User '${uid}' already exists (set GENIEACS_FORCE_RESET_UI_ADMIN=1 to reset password)"
  exit 0
fi

if [[ "${GENIEACS_FORCE_RESET_UI_ADMIN}" == "1" ]]; then
  log "Resetting GenieACS UI user '${uid}'"
  mongosh genieacs --quiet --eval "db.users.deleteOne({_id: '${uid}'})" >/dev/null 2>&1 || true
fi

log "Seeding GenieACS admin permissions and user '${uid}'"
mapfile -t _cred < <(
  GENIEACS_UI_PASSWORD="${GENIEACS_UI_PASSWORD}" node - <<'NODE'
const crypto = require('crypto');
const pass = process.env.GENIEACS_UI_PASSWORD || 'admin';
const salt = crypto.randomBytes(64).toString('hex');
const hash = crypto.pbkdf2Sync(pass, salt, 10000, 128, 'sha512').toString('hex');
console.log(salt);
console.log(hash);
NODE
)
SALT="${_cred[0]:-}"
HASH="${_cred[1]:-}"
if [[ -z "$SALT" || -z "$HASH" ]]; then
  log "ERROR: password hash generation failed"
  exit 1
fi

mongosh genieacs --quiet <<MONGO
const resources = [
  'devices', 'faults', 'files', 'presets', 'provisions', 'config',
  'permissions', 'users', 'virtualParameters', 'views'
];
db.permissions.deleteMany({ role: 'admin' });
db.permissions.insertMany(
  resources.map((resource) => ({
    _id: 'admin:' + resource + ':3',
    role: 'admin',
    resource,
    access: 3,
    validate: 'true',
  }))
);
db.users.replaceOne(
  { _id: '${uid}' },
  { _id: '${uid}', roles: 'admin', salt: '${SALT}', password: '${HASH}' },
  { upsert: true }
);
db.cache.deleteOne({ _id: 'ui-local-cache-hash' });
db.cache.deleteOne({ _id: 'cwmp-local-cache-hash' });
MONGO

mkdir -p /opt/genieacs
cat >/opt/genieacs/ui-login.txt <<EOF
# GenieACS web UI — change password under Admin → Users
username=${uid}
password=${GENIEACS_UI_PASSWORD}
EOF
chmod 600 /opt/genieacs/ui-login.txt

if systemctl is-active --quiet genieacs-ui 2>/dev/null; then
  systemctl restart genieacs-ui
  log "Restarted genieacs-ui (UI cache cleared)"
fi

log "Login: ${uid} / ${GENIEACS_UI_PASSWORD} (saved in /opt/genieacs/ui-login.txt)"
