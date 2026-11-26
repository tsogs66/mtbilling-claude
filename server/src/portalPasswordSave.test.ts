/**
 * A chosen portal password must be the exact string that was typed.
 * Phone-variant matching must not skip the write, and a failed check must
 * leave the previous hash and the must-change flag in place.
 *
 * Run via scripts/run-tests.mjs (throwaway MT_DATA_DIR).
 */
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { db, initSchema, migrate, seed } from './db.js';

initSchema();
migrate();
seed();

import { commitSubscriberPortalPassword } from './ispOps.js';
import { portalPasswordExactMatch, portalPasswordMatches } from './portalPassword.js';

db.exec(`
  ALTER TABLE pppoe_users ADD COLUMN portal_pin_hash TEXT;
  ALTER TABLE pppoe_users ADD COLUMN portal_enabled INTEGER DEFAULT 0;
  ALTER TABLE pppoe_users ADD COLUMN portal_must_change_password INTEGER DEFAULT 0;
  CREATE TABLE IF NOT EXISTS client_portal_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT,
    pppoe_user_id INTEGER,
    expires_at TEXT
  );
`);

const phone = '09170001122';
const info = db
  .prepare(
    `INSERT INTO pppoe_users (
       username, password, service, profile, price, status, subscription_due,
       customer_name, account_number, contact, portal_enabled, portal_pin_hash, portal_must_change_password
     ) VALUES ('pw.user', 'x', 'pppoe', 'default', 500, 'Active', '2026-11-20', 'PW User', 'ACC-PW', ?, 1, ?, 1)`
  )
  .run(phone, bcrypt.hashSync(phone, 4));
const id = Number(info.lastInsertRowid);

const saved = commitSubscriberPortalPassword(id, { newPassword: 'Harbor9', confirmPassword: 'Harbor9' });
assert.equal(saved.ok, true);
if (!saved.ok) throw new Error('unreachable');
assert.equal(saved.saved, true);
assert.equal(saved.passwordVerified, true);
assert.equal(saved.keptExisting, false);

const row = db
  .prepare('SELECT portal_pin_hash, portal_must_change_password FROM pppoe_users WHERE id = ?')
  .get(id) as { portal_pin_hash: string; portal_must_change_password: number };
assert.equal(portalPasswordExactMatch('Harbor9', row.portal_pin_hash), true);
assert.equal(portalPasswordMatches(phone, row.portal_pin_hash, phone), false);
assert.equal(Number(row.portal_must_change_password), 0);

const kept = commitSubscriberPortalPassword(id, { password: 'Harbor9', confirm: 'Harbor9' });
assert.equal(kept.ok, true);
if (kept.ok) assert.equal(kept.keptExisting, true);

const mismatch = commitSubscriberPortalPassword(id, { password: 'Other99', confirm: 'Other00' });
assert.equal(mismatch.ok, false);
const still = db.prepare('SELECT portal_pin_hash FROM pppoe_users WHERE id = ?').get(id) as { portal_pin_hash: string };
assert.equal(portalPasswordExactMatch('Harbor9', still.portal_pin_hash), true);

const variant = '+639170001122';
const typedPhone = commitSubscriberPortalPassword(id, { password: variant, confirm: variant });
assert.equal(typedPhone.ok, true);
if (typedPhone.ok) assert.equal(typedPhone.saved, true);
const afterVariant = db.prepare('SELECT portal_pin_hash FROM pppoe_users WHERE id = ?').get(id) as {
  portal_pin_hash: string;
};
assert.equal(portalPasswordExactMatch(variant, afterVariant.portal_pin_hash), true);
assert.equal(portalPasswordExactMatch(phone, afterVariant.portal_pin_hash), false);
assert.equal(portalPasswordMatches(phone, afterVariant.portal_pin_hash, phone), true);

const shadowed = commitSubscriberPortalPassword(id, {
  password: phone,
  confirm: phone,
  newPassword: 'Harbor9',
  confirmPassword: 'Harbor9',
});
assert.equal(shadowed.ok, true);
if (shadowed.ok) {
  assert.equal(shadowed.saved, true);
  assert.equal(shadowed.keptExisting, false);
}
const afterShadow = db.prepare('SELECT portal_pin_hash FROM pppoe_users WHERE id = ?').get(id) as {
  portal_pin_hash: string;
};
assert.equal(portalPasswordExactMatch('Harbor9', afterShadow.portal_pin_hash), true);
assert.equal(portalPasswordMatches(phone, afterShadow.portal_pin_hash, phone), false);
assert.equal(portalPasswordMatches('Harbor9', afterShadow.portal_pin_hash, phone), true);

const spaced = commitSubscriberPortalPassword(id, {
  newPassword: 'Harbor 9',
  confirmPassword: 'Harbor 9',
});
assert.equal(spaced.ok, true);
if (spaced.ok) assert.equal(spaced.saved, true);
const afterSpace = db.prepare('SELECT portal_pin_hash FROM pppoe_users WHERE id = ?').get(id) as {
  portal_pin_hash: string;
};
assert.equal(portalPasswordExactMatch('Harbor 9', afterSpace.portal_pin_hash), true);
assert.equal(portalPasswordMatches(phone, afterSpace.portal_pin_hash, phone), false);

console.log('portal password save ok');
