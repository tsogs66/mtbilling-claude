/**
 * Merchant duration: months × plan price, and the subscriber due date moves
 * by that many months. Run via scripts/run-tests.mjs (throwaway MT_DATA_DIR).
 */
import assert from 'node:assert/strict';
import { db, initSchema, migrate, seed } from './db.js';

initSchema();
migrate();
seed();
db.exec(`
  CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    number TEXT UNIQUE NOT NULL,
    pppoe_user_id INTEGER,
    customer_name TEXT,
    account_number TEXT,
    period_start TEXT,
    period_end TEXT,
    due_date TEXT,
    amount REAL NOT NULL DEFAULT 0,
    amount_paid REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'unpaid',
    notes TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    paid_at TEXT
  );
  CREATE TABLE IF NOT EXISTS invoice_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL,
    amount REAL NOT NULL,
    method TEXT,
    transaction_id INTEGER,
    note TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);
import {
  addMonthsPreserveDay,
  createPaymentLink,
  normalizePayMonths,
  recordPppoePayment,
  subscriptionMonthlyRate,
} from './billing.js';

assert.equal(normalizePayMonths(''), 1);
assert.equal(normalizePayMonths(0), 1);
assert.equal(normalizePayMonths(3.9), 3);
assert.equal(normalizePayMonths(99), 24);
assert.equal(addMonthsPreserveDay('2026-01-15', 3), '2026-04-15');
assert.equal(addMonthsPreserveDay('2026-01-31', 1), '2026-02-28');

db.prepare(
  `INSERT INTO profiles (name, rate_limit, price, type, ppp_profile)
   VALUES ('TESTPLAN-MONTHS', '10M/10M', 800, 'plan', 'default')`
).run();

const info = db
  .prepare(
    `INSERT INTO pppoe_users (username, password, service, profile, price, status, subscription_due, customer_name, account_number)
     VALUES ('paymonths', 'x', 'pppoe', 'TESTPLAN-MONTHS', 1, 'Active', '2026-01-15', 'Pay Months', 'ACC-PM')`
  )
  .run();
const userId = Number(info.lastInsertRowid);

assert.equal(subscriptionMonthlyRate({ profile: 'TESTPLAN-MONTHS', price: 1 }), 800);

const link = createPaymentLink({ pppoeUserId: userId, months: 3, createdBy: 'cashier' });
assert.equal(link.months, 3);
assert.equal(link.amount, 2400);

db.prepare(
  `INSERT INTO invoices (number, pppoe_user_id, amount, amount_paid, status, due_date)
   VALUES ('INV-PM-1', ?, 800, 0, 'unpaid', '2026-01-15')`
).run(userId);

const paid = await recordPppoePayment(userId, { months: 3, source: 'test' });
assert.equal(paid.months, 3);
assert.equal(paid.previousDue, '2026-01-15');
assert.equal(paid.subscriptionDue, '2026-04-15');
assert.equal(paid.total, 2400);

const row = db.prepare('SELECT subscription_due, price, status FROM pppoe_users WHERE id = ?').get(userId) as {
  subscription_due: string;
  price: number;
  status: string;
};
assert.equal(String(row.subscription_due).slice(0, 10), '2026-04-15');
assert.equal(Number(row.price), 800);
assert.equal(row.status, 'Active');

const tx = db
  .prepare(`SELECT amount FROM transactions WHERE pppoe_user_id = ? ORDER BY id DESC LIMIT 1`)
  .get(userId) as { amount: number };
assert.equal(Number(tx.amount), 2400);

const invoice = db.prepare(`SELECT status, amount_paid FROM invoices WHERE number = 'INV-PM-1'`).get() as {
  status: string;
  amount_paid: number;
};
assert.equal(invoice.status, 'paid');
assert.equal(Number(invoice.amount_paid), 800);

console.log('merchantPayMonths.test.ts: ok');
