/**
 * Home collection report: target, paid, late (after the due date), and still unpaid.
 * Run via scripts/run-tests.mjs (throwaway MT_DATA_DIR).
 */
import assert from 'node:assert/strict';
import { db, initSchema, migrate, seed } from './db.js';

initSchema();
migrate();
seed();

import { buildCollectionReport } from './collectionReport.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number TEXT,
    pppoe_user_id INTEGER,
    amount REAL NOT NULL DEFAULT 0,
    amount_paid REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'unpaid'
  );
`);

function addUser(username: string, status: string, price: number, due: string, online = 0) {
  const info = db
    .prepare(
      `INSERT INTO pppoe_users (
         username, password, service, profile, price, status, subscription_due, online, customer_name, account_number
       ) VALUES (?, 'x', 'pppoe', 'default', ?, ?, ?, ?, ?, ?)`
    )
    .run(username, price, status, due, online, username, `ACC-${username}`);
  return Number(info.lastInsertRowid);
}

const covered = addUser('covered', 'Active', 700, '2026-11-20', 1);
const unpaid = addUser('unpaid', 'Active', 700, '2026-11-01', 0);
const lapsed = addUser('lapsed', 'non-payment', 900, '2026-10-01', 0);
const onTime = addUser('ontime', 'Active', 500, '2026-12-01', 1);
const late = addUser('late', 'Active', 500, '2026-12-01', 1);
addUser('closed', 'disabled', 1000, '2026-11-01', 0);

db.prepare(
  `INSERT INTO transactions (pppoe_user_id, customer_name, amount, type, created_at, receipt_json)
   VALUES (?, 'ontime', 500, 'payment', '2026-11-05T08:00:00.000Z', ?)`
).run(onTime, JSON.stringify({ previousDue: '2026-11-20', paymentDate: '2026-11-05', total: 500 }));
db.prepare(
  `INSERT INTO transactions (pppoe_user_id, customer_name, amount, type, created_at, receipt_json)
   VALUES (?, 'late', 500, 'payment', '2026-11-06T08:00:00.000Z', ?)`
).run(late, JSON.stringify({ previousDue: '2026-11-01', paymentDate: '2026-11-06', total: 500 }));

const report = buildCollectionReport(null, '2026-11-07');
assert.equal(report.total, 6);
assert.equal(report.active, 4);
assert.equal(report.online, 3);
assert.equal(report.offline, 1);
assert.equal(report.nonPayment, 1);
assert.equal(report.disabled, 1);
assert.equal(report.target, 700 + 700 + 900 + 500 + 500);
assert.equal(report.collected, 1000);
assert.equal(report.paidCount, 2);
assert.equal(report.onTimeCount, 1);
assert.equal(report.lateCount, 1);
assert.equal(report.unpaidCount, 2);
assert.equal(report.coveredCount, 1);
assert.ok(report.unpaid.some((row) => row.id === unpaid));
assert.ok(report.unpaid.some((row) => row.id === lapsed));
assert.ok(!report.unpaid.some((row) => row.id === covered));
assert.equal(report.late[0]?.id, late);
assert.ok(report.pie.some((slice) => slice.key === 'non-payment' && slice.value === 1));

console.log('collection report ok');
