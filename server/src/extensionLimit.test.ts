/**
 * Extension rule: automatic, 3 days each, 3 uses between payments, then
 * non-payment + disabled with no grace. Run via scripts/run-tests.mjs.
 */
import assert from 'node:assert/strict';
import { db, initSchema, migrate, seed } from './db.js';
import { initPortalExtras, grantExtension } from './portalExtras.js';
import { previewBillingEnforcement } from './notify.js';
import { EXTENSION_DAYS, EXTENSION_MAX_USES, extensionsUsed } from './extensions.js';

initSchema();
migrate();
seed();
initPortalExtras();
db.exec('DELETE FROM pppoe_users; DELETE FROM transactions; DELETE FROM portal_extension_requests;');

const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

function addUser(name: string, due: string, status = 'Active') {
  return Number(
    db
      .prepare(
        `INSERT INTO pppoe_users (username, customer_name, account_number, profile, status, subscription_due, price, service)
         VALUES (?, ?, ?, 'Plan', ?, ?, 999, 'pppoe')`
      )
      .run(name, name, name, status, due).lastInsertRowid
  );
}

assert.equal(EXTENSION_DAYS, 3);
assert.equal(EXTENSION_MAX_USES, 3);

// Three grants, 3 days each, then a hard stop.
const a = addUser('alice', day(1));
for (let i = 1; i <= 3; i++) {
  const g = grantExtension(a, { note: 'test' });
  assert.ok(g.ok, `grant ${i} succeeds`);
  if (g.ok) {
    assert.equal(g.grantedDays, 3);
    assert.equal(g.used, i);
  }
}
const dueAfter3 = (db.prepare('SELECT subscription_due FROM pppoe_users WHERE id = ?').get(a) as any).subscription_due;
assert.equal(dueAfter3, day(1 + 9), 'three grants add nine days in total');
const fourth = grantExtension(a, { note: 'test' });
assert.ok(!fourth.ok && fourth.reason === 'exhausted', 'fourth grant is refused');
assert.equal(
  (db.prepare('SELECT subscription_due FROM pppoe_users WHERE id = ?').get(a) as any).subscription_due,
  dueAfter3,
  'a refused grant leaves the due date alone'
);
assert.equal(extensionsUsed(a), 3);

// Past due with every extension used: disabled with no grace, even though it is inside the grace hours.
db.prepare('UPDATE pppoe_users SET subscription_due = ? WHERE id = ?').run(day(-1), a);
let preview = previewBillingEnforcement();
assert.ok(preview.toDisable.some((c) => c.id === a && c.extensionsExhausted), 'exhausted + overdue goes straight to disable');
assert.ok(!preview.toExpire.some((c) => c.id === a), 'not parked in the grace profile');

// A subscriber with extensions left still gets the normal grace first.
const b = addUser('bob', day(1));
grantExtension(b, { note: 'test' });
db.prepare('UPDATE pppoe_users SET subscription_due = ? WHERE id = ?').run(day(-1), b);
preview = previewBillingEnforcement();
assert.ok(preview.toExpire.some((c) => c.id === b), 'two uses left: normal grace rules');
assert.ok(!preview.toDisable.some((c) => c.id === b));

// Paying starts the allowance over.
db.prepare(
  `INSERT INTO transactions (pppoe_user_id, customer_name, amount, type, created_at) VALUES (?, 'alice', 999, 'payment', ?)`
).run(a, new Date(Date.now() + 60_000).toISOString());
assert.equal(extensionsUsed(a), 0, 'payment resets the count');
assert.ok(grantExtension(a, { note: 'test' }).ok, 'extension available again after paying');

// A cancelled payment does not reset anything.
const c = addUser('cara', day(1));
grantExtension(c, { note: 'test' });
grantExtension(c, { note: 'test' });
grantExtension(c, { note: 'test' });
db.prepare(
  `INSERT INTO transactions (pppoe_user_id, customer_name, amount, type, created_at) VALUES (?, 'cara', 999, 'payment_cancelled', ?)`
).run(c, new Date(Date.now() + 60_000).toISOString());
assert.equal(extensionsUsed(c), 3, 'cancelled payment keeps the count');

console.log('extensionLimit.test.ts: ok');
