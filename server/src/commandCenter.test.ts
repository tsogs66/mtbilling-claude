/**
 * Command Center feed: every subscriber is classified and risk-scored on the
 * server so the page can filter and re-total them without re-deriving rules.
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
`);

import { buildCommandCenterFeed, scoreRisk } from './commandCenter.js';

const TODAY = '2026-11-15';
db.exec('DELETE FROM pppoe_users; DELETE FROM transactions;');

function addUser(username: string, o: { status?: string; online?: number; due?: string | null; price?: number }) {
  const r = db
    .prepare(
      `INSERT INTO pppoe_users (username, customer_name, account_number, profile, status, online, price, subscription_due, router_id)
       VALUES (?, ?, ?, 'PLAN700', ?, ?, ?, ?, 1)`
    )
    .run(username, username, `ACC-${username}`, o.status ?? 'Active', o.online ?? 1, o.price ?? 700, o.due ?? null);
  return Number(r.lastInsertRowid);
}

function pay(id: number, amount: number, createdAt: string, previousDue: string) {
  db.prepare(`INSERT INTO transactions (pppoe_user_id, customer_name, amount, type, created_at, receipt_json) VALUES (?, 'x', ?, 'payment', ?, ?)`).run(
    id,
    amount,
    createdAt,
    JSON.stringify({ previousDue, paymentDate: createdAt.slice(0, 10) })
  );
}

const onTime = addUser('ontime', { due: '2026-12-05' });
pay(onTime, 700, '2026-11-03T08:00:00.000Z', '2026-11-05');
const late = addUser('late', { due: '2026-12-05' });
pay(late, 700, '2026-11-09T08:00:00.000Z', '2026-11-05');
const covered = addUser('covered', { due: '2026-11-25' });
const overdueOnline = addUser('overdue-online', { due: '2026-11-10', online: 1 });
const paidOffline = addUser('paid-offline', { due: '2026-12-01', online: 0 });
pay(paidOffline, 700, '2026-11-02T08:00:00.000Z', '2026-11-03');
const disabled = addUser('disabled', { status: 'Disabled', due: '2026-10-01' });
const dueToday = addUser('due-today', { due: TODAY });

const feed = buildCommandCenterFeed(TODAY);
const by = (id: number) => feed.subscribers.find((s) => s.id === id)!;

assert.equal(feed.subscribers.length, 7);
assert.equal(feed.monthStart, '2026-11-01');
assert.equal(feed.prevMonthStart, '2026-10-01');

assert.equal(by(onTime).paid, 'paid');
assert.equal(by(onTime).paidMonth, 700);
assert.equal(by(late).paid, 'late');
assert.ok(by(late).flags.includes('late-payer'));
assert.equal(by(covered).paid, 'covered');
assert.equal(by(covered).dueIn, 10);
assert.equal(by(overdueOnline).paid, 'unpaid');
assert.equal(by(overdueOnline).dueIn, -5);
assert.ok(by(overdueOnline).flags.includes('overdue'));
assert.ok(by(overdueOnline).flags.includes('online-unpaid'));
assert.equal(by(paidOffline).flags.includes('paid-offline'), true);
assert.equal(by(disabled).state, 'disabled');
assert.equal(by(disabled).risk, 0);
assert.equal(by(disabled).paid, 'none');
assert.ok(by(dueToday).flags.includes('due-today'));

const ranked = [...feed.subscribers].sort((a, b) => b.risk - a.risk);
assert.equal(ranked[0].id, overdueOnline, 'overdue and still online is the first thing to chase');
assert.ok(by(onTime).risk < by(overdueOnline).risk);

assert.equal(feed.payments.length, 3);
assert.deepEqual(
  feed.payments.map((p) => [p[2], p[3]]).sort(),
  [
    ['2026-11-02', 0],
    ['2026-11-03', 0],
    ['2026-11-09', 1],
  ]
);

const worse = scoreRisk({ state: 'expired', online: false, dueIn: -20, balance: 500, paid: 'unpaid', late90: 3 });
assert.equal(worse.risk, 90, 'expired 25 + overdue 40 + balance 10 + repeat late payer 15');
assert.ok(worse.risk <= 100);
const clean = scoreRisk({ state: 'active', online: true, dueIn: 20, balance: 0, paid: 'paid', late90: 0 });
assert.equal(clean.risk, 0);
assert.deepEqual(clean.flags, []);

console.log('commandCenter.test.ts: ok');
