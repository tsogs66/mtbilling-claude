/**
 * Mid-cycle plan change: the payment page shows the prorated bill (₱817),
 * but posting only the catalog plan (₱700) left ₱117 on the next cycle and
 * the receipt total was the plan price. The amount paid has to clear that
 * bill, and the saved receipt has to show it.
 *
 * Run via scripts/run-tests.mjs (throwaway MT_DATA_DIR).
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
  createPaymentLink,
  creditAlreadyPaid,
  markPaymentLinkPaid,
  openInvoiceBalanceForUser,
  recordPppoePayment,
} from './billing.js';

db.prepare(
  `INSERT INTO profiles (name, rate_limit, price, type, ppp_profile)
   VALUES ('PLAN700', '10M/10M', 700, 'plan', 'default')`
).run();
db.prepare(
  `INSERT INTO profiles (name, rate_limit, price, type, ppp_profile)
   VALUES ('PLAN900', '20M/20M', 900, 'plan', 'default')`
).run();

function addUser(username: string, plan: string, price: number) {
  const info = db
    .prepare(
      `INSERT INTO pppoe_users (username, password, service, profile, price, status, subscription_due, customer_name, account_number)
       VALUES (?, 'x', 'pppoe', ?, ?, 'Active', '2026-11-20', ?, ?)`
    )
    .run(username, plan, price, username, `ACC-${username}`);
  return Number(info.lastInsertRowid);
}

function addInvoice(userId: number, number: string, amount: number) {
  db.prepare(
    `INSERT INTO invoices (number, pppoe_user_id, amount, amount_paid, status, due_date)
     VALUES (?, ?, ?, 0, 'unpaid', '2026-11-20')`
  ).run(number, userId, amount);
}

// Payment page shows ₱817 (prorated 700 → 900). Paying that link must clear
// the bill even while the account plan price is still the original ₱700.
const oldPlanUser = addUser('prorate.old', 'PLAN700', 700);
addInvoice(oldPlanUser, 'INV-OLD', 817);
const oldLink = createPaymentLink({ pppoeUserId: oldPlanUser, months: 1, amount: 817, createdBy: 'portal' });
assert.equal(oldLink.amount, 817);
const oldPaid = await markPaymentLinkPaid(oldLink.token, 'REF-817');
assert.ok(oldPaid.payment);
assert.equal(oldPaid.payment.total, 817);
assert.equal(oldPaid.payment.receipt.subtotal, 700);
assert.equal(oldPaid.payment.receipt.adjustment, 117);
assert.equal(oldPaid.payment.receipt.total, 817);
assert.equal(openInvoiceBalanceForUser(oldPlanUser), 0);
const oldRow = db.prepare('SELECT price, profile FROM pppoe_users WHERE id = ?').get(oldPlanUser) as {
  price: number;
  profile: string;
};
assert.equal(Number(oldRow.price), 700);
assert.equal(oldRow.profile, 'PLAN700');
const oldTx = db.prepare('SELECT amount, receipt_json FROM transactions WHERE pppoe_user_id = ?').get(oldPlanUser) as {
  amount: number;
  receipt_json: string;
};
assert.equal(Number(oldTx.amount), 817);
const oldReceipt = JSON.parse(oldTx.receipt_json);
assert.equal(oldReceipt.total, 817);
assert.equal(oldReceipt.adjustment, 117);
assert.equal(oldReceipt.plan, 'PLAN700');

// After the plan is already switched to ₱900, the pay page still collects the
// prorated ₱817. Books and the receipt must record ₱817, not the new plan price.
const newPlanUser = addUser('prorate.new', 'PLAN900', 900);
addInvoice(newPlanUser, 'INV-NEW', 817);
const newLink = createPaymentLink({ pppoeUserId: newPlanUser, months: 1, amount: 817, createdBy: 'portal' });
const newPaid = await markPaymentLinkPaid(newLink.token);
assert.ok(newPaid.payment);
assert.equal(newPaid.payment.total, 817);
assert.equal(newPaid.payment.receipt.subtotal, 900);
assert.equal(newPaid.payment.receipt.adjustment, -83);
assert.equal(newPaid.payment.receipt.total, 817);
assert.equal(openInvoiceBalanceForUser(newPlanUser), 0);
const newRow = db.prepare('SELECT price FROM pppoe_users WHERE id = ?').get(newPlanUser) as { price: number };
assert.equal(Number(newRow.price), 900);

// Staff / merchant payment with no explicit amount still covers that one invoice.
const staffUser = addUser('prorate.staff', 'PLAN700', 700);
addInvoice(staffUser, 'INV-STAFF', 817);
const staffPaid = await recordPppoePayment(staffUser, { months: 1, source: 'test' });
assert.equal(staffPaid.total, 817);
assert.equal(staffPaid.receipt.adjustment, 117);
assert.equal(openInvoiceBalanceForUser(staffUser), 0);
const staffRow = db.prepare('SELECT price FROM pppoe_users WHERE id = ?').get(staffUser) as { price: number };
assert.equal(Number(staffRow.price), 700);

// A normal renewal is still plan × months. One invoice at the plan price is not an adjustment.
const plainUser = addUser('prorate.plain', 'PLAN700', 700);
addInvoice(plainUser, 'INV-PLAIN', 700);
const plainPaid = await recordPppoePayment(plainUser, { months: 1, source: 'test' });
assert.equal(plainPaid.total, 700);
assert.equal(plainPaid.receipt.adjustment, 0);
assert.equal(openInvoiceBalanceForUser(plainUser), 0);

// Several open invoices are arrears. Do not inflate one payment to swallow all of them.
const arrearsUser = addUser('prorate.arrears', 'PLAN700', 700);
addInvoice(arrearsUser, 'INV-A1', 700);
addInvoice(arrearsUser, 'INV-A2', 117);
const arrearsPaid = await recordPppoePayment(arrearsUser, { months: 1, source: 'test' });
assert.equal(arrearsPaid.total, 700);
assert.equal(openInvoiceBalanceForUser(arrearsUser), 117);

// Already paid ₱887 on a ₱900 → ₱700 change; only ₱700 was posted, so ₱187 remains.
// Crediting that remainder clears the bill and leaves the due date where it is.
const magno = addUser('magno.sangalang', 'PLAN700', 700);
db.prepare(
  `INSERT INTO invoices (number, pppoe_user_id, amount, amount_paid, status, due_date)
   VALUES ('INV-MAGNO', ?, 887, 700, 'partial', '2026-11-20')`
).run(magno);
const before = db.prepare('SELECT subscription_due, price FROM pppoe_users WHERE id = ?').get(magno) as {
  subscription_due: string;
  price: number;
};
const credited = creditAlreadyPaid(magno, {
  amount: 187,
  note: 'Already paid 887; only 700 was posted',
});
assert.equal(credited.total, 187);
assert.equal(credited.balance, 0);
assert.equal(credited.receipt.correction, true);
assert.equal(credited.receipt.total, 187);
assert.equal(openInvoiceBalanceForUser(magno), 0);
const magnoInv = db.prepare(`SELECT status, amount_paid FROM invoices WHERE number = 'INV-MAGNO'`).get() as {
  status: string;
  amount_paid: number;
};
assert.equal(magnoInv.status, 'paid');
assert.equal(Number(magnoInv.amount_paid), 887);
const after = db.prepare('SELECT subscription_due, price FROM pppoe_users WHERE id = ?').get(magno) as {
  subscription_due: string;
  price: number;
};
assert.equal(String(after.subscription_due).slice(0, 10), String(before.subscription_due).slice(0, 10));
assert.equal(Number(after.price), Number(before.price));
assert.throws(() => creditAlreadyPaid(magno, { amount: 50 }), /no open balance/);

// Staff can override the next collection amount. That payment still extends service.
const overrideUser = addUser('override.next', 'PLAN700', 700);
const overridden = await recordPppoePayment(overrideUser, { months: 1, amount: 500, source: 'test' });
assert.equal(overridden.total, 500);
assert.equal(overridden.subscriptionDue, '2026-12-20');

console.log('planChangePayment.test.ts: ok');
