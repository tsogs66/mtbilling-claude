/**
 * ISP operations modules: Job Orders, Invoices/AR, Client Portal,
 * Finance (MRR + expenses), Rogue MAC scan.
 */
import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { db } from './db.js';
import { fetchDhcpLeases, removeHotspotActive, type RouterConn } from './mikrotik.js';
import {
  listOutageServiceCatalog,
  recordSubscriberOutageReport,
  resolveOutageServiceSlugs,
} from './outageMonitor.js';
import { absolutePayUrl, changePppoeUserPlan, ensureFreshPayLink } from './billing.js';
import { pipePortalSse, publishPortalEvent } from './portalEvents.js';
import {
  initStaffNotifications,
  listStaffNotifications,
  markStaffNotificationsRead,
  notifyStaff,
  subscriberLabel,
} from './staffNotifications.js';
import {
  notifyClientChannels,
  phonesMatch,
  sendInstallationSuccessNotice,
  sendPortalActivationNotice,
} from './notify.js';

const PLAN_CYCLE_DAYS = 30;

/** Mid-cycle plan change: consumed days at old rate + remaining days at new rate (30-day month). */
export function computePlanChangeProration(opts: {
  oldPrice: number;
  newPrice: number;
  subscriptionDue: string | null | undefined;
  asOf?: string | null;
}) {
  const asOf = String(opts.asOf || new Date().toISOString()).slice(0, 10);
  const due = opts.subscriptionDue ? String(opts.subscriptionDue).slice(0, 10) : null;
  let remainingDays = PLAN_CYCLE_DAYS;
  if (due) {
    const rem = Math.round(
      (Date.parse(`${due}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 864e5
    );
    remainingDays = Math.max(0, Math.min(PLAN_CYCLE_DAYS, rem));
  }
  const consumedDays = PLAN_CYCLE_DAYS - remainingDays;
  const oldPrice = Number(opts.oldPrice) || 0;
  const newPrice = Number(opts.newPrice) || 0;
  const oldPortion = Math.round((oldPrice / PLAN_CYCLE_DAYS) * consumedDays);
  const newPortion = Math.round((newPrice / PLAN_CYCLE_DAYS) * remainingDays);
  return {
    cycleDays: PLAN_CYCLE_DAYS,
    consumedDays,
    remainingDays,
    oldPrice,
    newPrice,
    oldPortion,
    newPortion,
    proratedBalance: oldPortion + newPortion,
    asOf,
    due,
  };
}

function listBillingPlansPublic() {
  return db
    .prepare(
      `SELECT id, name, rate_limit AS rateLimit, price, ppp_profile AS pppProfile
       FROM profiles
       WHERE coalesce(type, '') = 'plan'
       ORDER BY price ASC, name ASC`
    )
    .all() as { id: number; name: string; rateLimit: string; price: number; pppProfile: string }[];
}

function portalPaymentLinkForUser(userId: number) {
  const row = db
    .prepare(
      `SELECT id, token, amount, months, status, expires_at, pay_channel, submitted_at, external_ref, created_by
       FROM payment_links
       WHERE pppoe_user_id = ?
         AND status IN ('pending', 'submitted', 'rejected')
         AND (status != 'pending' OR datetime(expires_at) > datetime('now'))
       ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END, id DESC
       LIMIT 1`
    )
    .get(userId) as any;
  if (!row) return null;
  const path = `/pay/${row.token}`;
  return {
    path,
    url: absolutePayUrl(path),
    amount: Number(row.amount) || 0,
    months: Number(row.months) || 1,
    status: row.status as string,
    expiresAt: row.expires_at as string,
    payChannel: row.pay_channel || null,
    submittedAt: row.submitted_at || null,
    externalRef: row.external_ref || null,
    createdBy: row.created_by || 'admin',
  };
}

function columnExists(table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === col);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Default portal password = contact/phone as stored on the subscriber account. */
export function defaultPortalPasswordFromContact(contact: string | null | undefined): string {
  return String(contact || '').trim();
}

function validateChosenPortalPassword(password: string): string | null {
  const pw = String(password || '');
  if (pw.length < 6) return 'Password must be at least 6 characters';
  if (pw.length > 64) return 'Password must be at most 64 characters';
  if (/\s/.test(pw)) return 'Password cannot contain spaces';
  return null;
}

/**
 * Auto-create portal login: username = account number, password = phone/contact.
 * Sets must-change so the subscriber picks their own password after first login.
 * Idempotent unless `force` resets to the phone default.
 *
 * Important: never rewrite an existing hash unless `force` is set. Re-hashing while
 * must-change was still pending raced with the subscriber's own password change and
 * wiped their new password back to the phone number.
 */
export function ensureDefaultPortalCredentials(
  userId: number,
  opts?: { force?: boolean }
): { ok: boolean; error?: string; provisioned?: boolean; skipped?: boolean } {
  const user = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(userId) as any;
  if (!user) return { ok: false, error: 'subscriber not found' };
  const account = String(user.account_number || '').trim();
  if (!account) return { ok: false, error: 'Account number required' };
  const phone = defaultPortalPasswordFromContact(user.contact);
  if (!phone) return { ok: false, error: 'Phone/contact number required for default portal password' };

  const hasCreds = !!(user.portal_enabled && user.portal_pin_hash);
  if (hasCreds && !opts?.force) {
    return { ok: true, skipped: true };
  }

  const hash = bcrypt.hashSync(phone, 10);
  db.prepare(
    `UPDATE pppoe_users SET portal_enabled = 1, portal_pin_hash = ?, portal_must_change_password = 1 WHERE id = ?`
  ).run(hash, userId);
  if (opts?.force) {
    db.prepare('DELETE FROM client_portal_sessions WHERE pppoe_user_id = ?').run(userId);
  }
  return { ok: true, provisioned: true };
}

/** After newly provisioning portal creds, SMS the activation template (account + default password + link). */
export function notifyPortalActivationIfProvisioned(
  userId: number,
  result: { ok?: boolean; provisioned?: boolean } | null | undefined
) {
  if (!result?.ok || !result.provisioned) return;
  const user = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(userId) as any;
  if (!user) return;
  void sendPortalActivationNotice(user).catch(() => undefined);
}

function portalSubscriberId(sess: any): number {
  const id = Number(sess?.pppoe_user_id ?? sess?.uid ?? 0);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

function portalPasswordMatches(plain: string, hash: string | null | undefined): boolean {
  if (!hash) return false;
  try {
    return bcrypt.compareSync(String(plain || ''), String(hash));
  } catch {
    return false;
  }
}

/** Readable temporary portal password (SMS-friendly). */
function generateTempPortalPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** Simple per-account rate limit for forgot-password SMS. */
const portalForgotRate = new Map<string, number>();
function portalForgotAllowed(key: string, minIntervalMs = 60_000): boolean {
  const now = Date.now();
  const prev = portalForgotRate.get(key) || 0;
  if (now - prev < minIntervalMs) return false;
  portalForgotRate.set(key, now);
  // Opportunistic cleanup
  if (portalForgotRate.size > 2000) {
    for (const [k, t] of portalForgotRate) {
      if (now - t > 3600_000) portalForgotRate.delete(k);
    }
  }
  return true;
}

function findPortalUserByAccount(account: string) {
  const acct = String(account || '').trim();
  if (!acct) return null;
  return db
    .prepare(
      `SELECT * FROM pppoe_users
       WHERE portal_enabled = 1
         AND (
           TRIM(COALESCE(account_number, '')) = ?
           OR TRIM(COALESCE(username, '')) = ?
           OR LOWER(TRIM(COALESCE(account_number, ''))) = LOWER(?)
           OR LOWER(TRIM(COALESCE(username, ''))) = LOWER(?)
         )
       LIMIT 1`
    )
    .get(acct, acct, acct, acct) as any;
}

function backfillDefaultPortalCredentials() {
  const rows = db
    .prepare(
      `SELECT id FROM pppoe_users
       WHERE account_number IS NOT NULL AND TRIM(account_number) != ''
         AND contact IS NOT NULL AND TRIM(contact) != ''
         AND (portal_enabled = 0 OR portal_pin_hash IS NULL OR portal_pin_hash = '')`
    )
    .all() as { id: number }[];
  for (const r of rows) {
    ensureDefaultPortalCredentials(r.id);
  }
}

function nextNumber(prefix: string, table: string, col: string): string {
  const ymd = todayISO().replace(/-/g, '');
  const like = `${prefix}-${ymd}-%`;
  const row = db.prepare(`SELECT ${col} AS n FROM ${table} WHERE ${col} LIKE ? ORDER BY id DESC LIMIT 1`).get(like) as
    | { n: string }
    | undefined;
  let seq = 1;
  if (row?.n) {
    const m = row.n.match(/-(\d+)$/);
    if (m) seq = Number(m[1]) + 1;
  }
  return `${prefix}-${ymd}-${String(seq).padStart(4, '0')}`;
}

export function initIspOps() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      number TEXT UNIQUE NOT NULL,
      pppoe_user_id INTEGER,
      customer_name TEXT,
      contact TEXT,
      address TEXT,
      lat REAL,
      lng REAL,
      type TEXT NOT NULL DEFAULT 'repair',
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'normal',
      assigned_to TEXT,
      description TEXT,
      notes TEXT,
      scheduled_at TEXT,
      completed_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

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

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      description TEXT,
      amount REAL NOT NULL,
      spent_at TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS client_portal_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE NOT NULL,
      pppoe_user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rogue_mac_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      router_id INTEGER,
      mac TEXT NOT NULL,
      address TEXT,
      hostname TEXT,
      lease_id TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      notes TEXT,
      first_seen TEXT DEFAULT CURRENT_TIMESTAMP,
      last_seen TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(router_id, mac)
    );

    CREATE TABLE IF NOT EXISTS plan_change_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pppoe_user_id INTEGER NOT NULL,
      from_plan TEXT,
      to_plan TEXT NOT NULL,
      from_price REAL DEFAULT 0,
      to_price REAL DEFAULT 0,
      subscription_due TEXT,
      consumed_days INTEGER DEFAULT 0,
      remaining_days INTEGER DEFAULT 0,
      old_portion REAL DEFAULT 0,
      new_portion REAL DEFAULT 0,
      prorated_balance REAL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT,
      review_note TEXT,
      reviewed_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  for (const [col, type] of [
    ['portal_pin_hash', 'TEXT'],
    ['portal_enabled', 'INTEGER DEFAULT 0'],
    ['portal_must_change_password', 'INTEGER DEFAULT 0'],
    ['portal_last_login_at', 'TEXT'],
  ] as [string, string][]) {
    if (!columnExists('pppoe_users', col)) {
      db.exec(`ALTER TABLE pppoe_users ADD COLUMN ${col} ${type}`);
    }
  }

  // Auto-create portal logins (account # + phone) for subscribers that still lack one.
  try {
    backfillDefaultPortalCredentials();
  } catch {
    /* ignore migration hiccups */
  }

  try {
    initStaffNotifications();
  } catch {
    /* ignore migration hiccups */
  }

  // Merge new permission keys into built-in roles (idempotent).
  const merge = (name: string, add: string[]) => {
    const row = db.prepare('SELECT id, permissions FROM roles WHERE name = ?').get(name) as
      | { id: number; permissions: string }
      | undefined;
    if (!row) return;
    let perms: string[] = [];
    try {
      perms = JSON.parse(row.permissions || '[]');
    } catch {
      perms = [];
    }
    if (perms.includes('*')) return;
    const next = Array.from(new Set([...perms, ...add]));
    if (next.length !== perms.length) {
      db.prepare('UPDATE roles SET permissions = ? WHERE id = ?').run(JSON.stringify(next), row.id);
    }
  };
  merge('Technician', ['job-orders', 'rogue']);
  merge('Cashier', ['invoices', 'finance', 'portal']);
  // Roles that already manage AR also get subscriber portal admin.
  for (const row of db.prepare('SELECT id, permissions FROM roles').all() as { id: number; permissions: string }[]) {
    let perms: string[] = [];
    try {
      perms = JSON.parse(row.permissions || '[]');
    } catch {
      perms = [];
    }
    if (perms.includes('*') || perms.includes('portal')) continue;
    if (perms.includes('invoices') || perms.includes('finance')) {
      db.prepare('UPDATE roles SET permissions = ? WHERE id = ?').run(
        JSON.stringify([...perms, 'portal']),
        row.id
      );
    }
  }
}

function refreshInvoiceStatus(id: number) {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as any;
  if (!inv || inv.status === 'void') return;
  const paid = Number(inv.amount_paid) || 0;
  const amount = Number(inv.amount) || 0;
  let status = 'unpaid';
  if (paid <= 0) status = 'unpaid';
  else if (paid + 0.001 >= amount) status = 'paid';
  else status = 'partial';
  if (status !== 'paid' && inv.due_date && inv.due_date < todayISO()) status = 'overdue';
  const paidAt = status === 'paid' ? inv.paid_at || new Date().toISOString() : null;
  db.prepare('UPDATE invoices SET status = ?, paid_at = ? WHERE id = ?').run(status, paidAt, id);
}

function markOverdueInvoices() {
  db.prepare(
    `UPDATE invoices SET status = 'overdue'
     WHERE status IN ('unpaid', 'partial') AND due_date IS NOT NULL AND due_date < date('now')`
  ).run();
}

export const ispOpsRouter = Router();
export const publicPortalRouter = Router();

// ─── Job Orders ─────────────────────────────────────────────────────────────

ispOpsRouter.get('/job-orders', (req, res) => {
  const status = String(req.query.status || '');
  const type = String(req.query.type || '');
  let sql = 'SELECT * FROM job_orders WHERE 1=1';
  const params: any[] = [];
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }
  sql += ' ORDER BY CASE status WHEN \'open\' THEN 0 WHEN \'in_progress\' THEN 1 WHEN \'follow_up\' THEN 2 ELSE 3 END, id DESC';
  const rows = db.prepare(sql).all(...params);
  const counts = db
    .prepare(
      `SELECT status, COUNT(*) AS c FROM job_orders GROUP BY status`
    )
    .all() as { status: string; c: number }[];
  res.json({
    jobs: rows,
    counts: Object.fromEntries(counts.map((c) => [c.status, c.c])),
  });
});

ispOpsRouter.post('/job-orders', (req, res) => {
  const b = req.body || {};
  const number = nextNumber('JO', 'job_orders', 'number');
  const info = db
    .prepare(
      `INSERT INTO job_orders
       (number, pppoe_user_id, customer_name, contact, address, lat, lng, type, status, priority, assigned_to, description, notes, scheduled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      number,
      b.pppoe_user_id || null,
      b.customer_name || null,
      b.contact || null,
      b.address || null,
      b.lat ?? null,
      b.lng ?? null,
      b.type || 'repair',
      b.status || 'open',
      b.priority || 'normal',
      b.assigned_to || null,
      b.description || null,
      b.notes || null,
      b.scheduled_at || null
    );
  res.status(201).json(db.prepare('SELECT * FROM job_orders WHERE id = ?').get(info.lastInsertRowid));
});

ispOpsRouter.put('/job-orders/:id', (req, res) => {
  const id = Number(req.params.id);
  const ex = db.prepare('SELECT * FROM job_orders WHERE id = ?').get(id) as any;
  if (!ex) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const status = b.status !== undefined ? b.status : ex.status;
  const type = b.type !== undefined ? b.type : ex.type;
  const completed_at =
    status === 'completed' ? b.completed_at || ex.completed_at || new Date().toISOString() : status !== 'completed' ? null : ex.completed_at;
  const wasCompleted = String(ex.status || '') === 'completed';
  db.prepare(
    `UPDATE job_orders SET
      pppoe_user_id=?, customer_name=?, contact=?, address=?, lat=?, lng=?,
      type=?, status=?, priority=?, assigned_to=?, description=?, notes=?,
      scheduled_at=?, completed_at=?, updated_at=CURRENT_TIMESTAMP
     WHERE id=?`
  ).run(
    b.pppoe_user_id !== undefined ? b.pppoe_user_id || null : ex.pppoe_user_id,
    b.customer_name !== undefined ? b.customer_name : ex.customer_name,
    b.contact !== undefined ? b.contact : ex.contact,
    b.address !== undefined ? b.address : ex.address,
    b.lat !== undefined ? b.lat : ex.lat,
    b.lng !== undefined ? b.lng : ex.lng,
    type,
    status,
    b.priority !== undefined ? b.priority : ex.priority,
    b.assigned_to !== undefined ? b.assigned_to : ex.assigned_to,
    b.description !== undefined ? b.description : ex.description,
    b.notes !== undefined ? b.notes : ex.notes,
    b.scheduled_at !== undefined ? b.scheduled_at : ex.scheduled_at,
    completed_at,
    id
  );
  const row = db.prepare('SELECT * FROM job_orders WHERE id = ?').get(id) as any;
  res.json(row);

  // Successful installation template when a new-install job is first marked completed.
  if (!wasCompleted && status === 'completed' && String(type) === 'new_install') {
    const userId = Number(row?.pppoe_user_id || 0);
    const user = userId
      ? (db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(userId) as any)
      : null;
    const target =
      user ||
      (row?.contact
        ? {
            id: null,
            username: row.customer_name || 'subscriber',
            customer_name: row.customer_name,
            contact: row.contact,
            account_number: user?.account_number || '',
            profile: user?.profile || '',
            subscription_due: user?.subscription_due || null,
            price: user?.price ?? null,
            email: user?.email || null,
          }
        : null);
    if (target) void sendInstallationSuccessNotice(target).catch(() => undefined);
  }
});

ispOpsRouter.delete('/job-orders/:id', (req, res) => {
  db.prepare('DELETE FROM job_orders WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ─── Invoices / AR ──────────────────────────────────────────────────────────

ispOpsRouter.get('/invoices', (_req, res) => {
  markOverdueInvoices();
  const rows = db.prepare('SELECT * FROM invoices ORDER BY id DESC LIMIT 500').all();
  const aging = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status IN ('unpaid','partial','overdue') AND (due_date IS NULL OR due_date >= date('now')) THEN amount - amount_paid ELSE 0 END) AS current,
         SUM(CASE WHEN status IN ('unpaid','partial','overdue') AND due_date < date('now') AND due_date >= date('now','-30 day') THEN amount - amount_paid ELSE 0 END) AS d1_30,
         SUM(CASE WHEN status IN ('unpaid','partial','overdue') AND due_date < date('now','-30 day') AND due_date >= date('now','-60 day') THEN amount - amount_paid ELSE 0 END) AS d31_60,
         SUM(CASE WHEN status IN ('unpaid','partial','overdue') AND due_date < date('now','-60 day') THEN amount - amount_paid ELSE 0 END) AS d61_plus,
         SUM(CASE WHEN status IN ('unpaid','partial','overdue') THEN amount - amount_paid ELSE 0 END) AS total_ar,
         SUM(CASE WHEN status = 'paid' AND paid_at >= date('now','start of month') THEN amount ELSE 0 END) AS paid_this_month
       FROM invoices`
    )
    .get() as any;
  res.json({ invoices: rows, aging });
});

ispOpsRouter.get('/invoices/:id', (req, res) => {
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(Number(req.params.id));
  if (!inv) return res.status(404).json({ error: 'not found' });
  const payments = db.prepare('SELECT * FROM invoice_payments WHERE invoice_id = ? ORDER BY id').all(Number(req.params.id));
  res.json({ invoice: inv, payments });
});

ispOpsRouter.post('/invoices', (req, res) => {
  const b = req.body || {};
  const user = b.pppoe_user_id
    ? (db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(Number(b.pppoe_user_id)) as any)
    : null;
  const number = nextNumber('INV', 'invoices', 'number');
  const amount = Number(b.amount ?? user?.price ?? 0);
  const info = db
    .prepare(
      `INSERT INTO invoices
       (number, pppoe_user_id, customer_name, account_number, period_start, period_end, due_date, amount, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', ?)`
    )
    .run(
      number,
      user?.id || b.pppoe_user_id || null,
      b.customer_name || user?.customer_name || user?.username || null,
      b.account_number || user?.account_number || null,
      b.period_start || todayISO().slice(0, 7) + '-01',
      b.period_end || todayISO(),
      b.due_date || todayISO(),
      amount,
      b.notes || null
    );
  res.status(201).json(db.prepare('SELECT * FROM invoices WHERE id = ?').get(info.lastInsertRowid));
});

ispOpsRouter.post('/invoices/batch', (req, res) => {
  const b = req.body || {};
  const dueDate = b.due_date || todayISO();
  const periodStart = b.period_start || todayISO().slice(0, 7) + '-01';
  const periodEnd = b.period_end || todayISO();
  const onlyActive = b.only_active !== false;
  let users = db
    .prepare(
      `SELECT id, customer_name, username, account_number, price, status, subscription_due
       FROM pppoe_users WHERE service = 'pppoe' AND COALESCE(price, 0) > 0`
    )
    .all() as any[];
  if (onlyActive) users = users.filter((u) => String(u.status || '').toLowerCase() === 'active');
  const ins = db.prepare(
    `INSERT INTO invoices
     (number, pppoe_user_id, customer_name, account_number, period_start, period_end, due_date, amount, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unpaid')`
  );
  let created = 0;
  const tx = db.transaction(() => {
    for (const u of users) {
      // Skip if unpaid invoice already exists for this period
      const exists = db
        .prepare(
          `SELECT id FROM invoices WHERE pppoe_user_id = ? AND period_start = ? AND status != 'void' LIMIT 1`
        )
        .get(u.id, periodStart);
      if (exists) continue;
      ins.run(
        nextNumber('INV', 'invoices', 'number'),
        u.id,
        u.customer_name || u.username,
        u.account_number,
        periodStart,
        periodEnd,
        dueDate,
        Number(u.price) || 0
      );
      created += 1;
    }
  });
  tx();
  res.json({ ok: true, created });
});

ispOpsRouter.post('/invoices/:id/pay', (req, res) => {
  const id = Number(req.params.id);
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as any;
  if (!inv) return res.status(404).json({ error: 'not found' });
  if (inv.status === 'void') return res.status(400).json({ error: 'Invoice is void' });
  const amount = Number(req.body?.amount ?? inv.amount - inv.amount_paid);
  if (!(amount > 0)) return res.status(400).json({ error: 'Invalid amount' });
  db.prepare(
    `INSERT INTO invoice_payments (invoice_id, amount, method, transaction_id, note) VALUES (?, ?, ?, ?, ?)`
  ).run(id, amount, req.body?.method || 'cash', req.body?.transaction_id || null, req.body?.note || null);
  db.prepare('UPDATE invoices SET amount_paid = amount_paid + ? WHERE id = ?').run(amount, id);
  refreshInvoiceStatus(id);
  // Mirror into sales transactions for reports
  db.prepare(
    `INSERT INTO transactions (pppoe_user_id, customer_name, amount, type, receipt_json)
     VALUES (?, ?, ?, 'payment', ?)`
  ).run(
    inv.pppoe_user_id,
    inv.customer_name,
    amount,
    JSON.stringify({ invoice: inv.number, method: req.body?.method || 'cash' })
  );
  res.json(db.prepare('SELECT * FROM invoices WHERE id = ?').get(id));
});

ispOpsRouter.post('/invoices/:id/void', (req, res) => {
  const id = Number(req.params.id);
  db.prepare(`UPDATE invoices SET status = 'void' WHERE id = ?`).run(id);
  res.json(db.prepare('SELECT * FROM invoices WHERE id = ?').get(id));
});

ispOpsRouter.get('/invoices/:id/soa', (req, res) => {
  const id = Number(req.params.id);
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as any;
  if (!inv) return res.status(404).json({ error: 'not found' });
  const history = inv.pppoe_user_id
    ? db
        .prepare(
          `SELECT number, period_start, period_end, due_date, amount, amount_paid, status, created_at
           FROM invoices WHERE pppoe_user_id = ? ORDER BY id DESC LIMIT 24`
        )
        .all(inv.pppoe_user_id)
    : [inv];
  const company = db.prepare('SELECT * FROM company WHERE id = 1').get();
  res.json({ invoice: inv, history, company });
});

// ─── Finance / MRR ──────────────────────────────────────────────────────────

ispOpsRouter.get('/finance/summary', (_req, res) => {
  markOverdueInvoices();
  const mrrRow = db
    .prepare(
      `SELECT COALESCE(SUM(price), 0) AS mrr, COUNT(*) AS active_subs
       FROM pppoe_users
       WHERE service = 'pppoe' AND LOWER(COALESCE(status,'')) = 'active' AND COALESCE(price,0) > 0`
    )
    .get() as { mrr: number; active_subs: number };

  const monthStart = todayISO().slice(0, 7) + '-01';
  const income = db
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS v FROM transactions WHERE created_at >= ?`)
    .get(monthStart) as { v: number };
  const expense = db
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS v FROM expenses WHERE spent_at >= ?`)
    .get(monthStart) as { v: number };
  const ar = db
    .prepare(
      `SELECT COALESCE(SUM(amount - amount_paid), 0) AS v FROM invoices WHERE status IN ('unpaid','partial','overdue')`
    )
    .get() as { v: number };

  const byPlan = db
    .prepare(
      `SELECT COALESCE(profile, 'unset') AS plan, COUNT(*) AS subscribers, COALESCE(SUM(price),0) AS mrr
       FROM pppoe_users
       WHERE service = 'pppoe' AND LOWER(COALESCE(status,'')) = 'active' AND COALESCE(price,0) > 0
       GROUP BY COALESCE(profile, 'unset')
       ORDER BY mrr DESC`
    )
    .all();

  const expenseRows = db.prepare('SELECT * FROM expenses ORDER BY spent_at DESC, id DESC LIMIT 100').all();
  const expenseByCat = db
    .prepare(
      `SELECT category, COALESCE(SUM(amount),0) AS total
       FROM expenses WHERE spent_at >= ? GROUP BY category ORDER BY total DESC`
    )
    .all(monthStart);

  res.json({
    mrr: mrrRow.mrr,
    activeSubscribers: mrrRow.active_subs,
    incomeThisMonth: income.v,
    expensesThisMonth: expense.v,
    netThisMonth: income.v - expense.v,
    accountsReceivable: ar.v,
    mrrByPlan: byPlan,
    expenses: expenseRows,
    expensesByCategory: expenseByCat,
    monthStart,
  });
});

ispOpsRouter.post('/finance/expenses', (req, res) => {
  const b = req.body || {};
  const amount = Number(b.amount);
  if (!b.category || !(amount > 0)) return res.status(400).json({ error: 'category and amount required' });
  const info = db
    .prepare(`INSERT INTO expenses (category, description, amount, spent_at) VALUES (?, ?, ?, ?)`)
    .run(String(b.category), b.description || null, amount, b.spent_at || todayISO());
  res.status(201).json(db.prepare('SELECT * FROM expenses WHERE id = ?').get(info.lastInsertRowid));
});

ispOpsRouter.delete('/finance/expenses/:id', (req, res) => {
  db.prepare('DELETE FROM expenses WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ─── Client portal (staff) ──────────────────────────────────────────────────

function normalizePortalLink(raw: unknown): string {
  return String(raw || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

function portalSettingsRow() {
  const row = db
    .prepare(
      `SELECT portal_title, portal_subtitle, portal_help_text, portal_welcome_text,
              portal_show_balance, portal_show_invoices, portal_show_tickets, portal_show_company,
              portal_session_days, portal_link, portal_theme,
              public_base_url, ngrok_url, ngrok_status,
              cf_tunnel_url, cf_tunnel_status, cf_tunnel_hostname
       FROM app_settings WHERE id = 1`
    )
    .get() as any;
  const cf =
    row?.cf_tunnel_status === 'running'
      ? row?.cf_tunnel_url ||
        (row?.cf_tunnel_hostname
          ? String(row.cf_tunnel_hostname).replace(/^https?:\/\//i, '')
          : '')
      : '';
  const ngrok = row?.ngrok_status === 'running' ? row?.ngrok_url : '';
  let autoPortalLink = '';
  for (const raw of [row?.public_base_url, process.env.PUBLIC_BASE_URL, cf, ngrok]) {
    const host = normalizePortalLink(raw);
    if (host) {
      autoPortalLink = `${host}/portal`;
      break;
    }
  }
  return {
    title: row?.portal_title || 'PANORTH',
    subtitle: row?.portal_subtitle || 'Internet Solutions',
    helpText:
      row?.portal_help_text ||
      'Sign in with your account number and password. First time: use your phone number, then set a new password. Forgot it? Request a temporary password by SMS.',
    welcomeText: row?.portal_welcome_text || '',
    showBalance: row?.portal_show_balance !== 0,
    showInvoices: row?.portal_show_invoices !== 0,
    showTickets: row?.portal_show_tickets !== 0,
    showCompany: row?.portal_show_company !== 0,
    sessionDays: Math.min(90, Math.max(1, Number(row?.portal_session_days) || 7)),
    portalLink: normalizePortalLink(row?.portal_link),
    autoPortalLink,
    theme: row?.portal_theme === 'orbital' ? 'orbital' : 'matrix',
  };
}

ispOpsRouter.get('/client-portal/settings', (_req, res) => {
  res.json(portalSettingsRow());
});

/** Staff topbar inbox — portal / payment-link subscriber activity. */
ispOpsRouter.get('/staff-notifications', (req, res) => {
  const userId = Number((req as any).user?.id);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const limit = Number(req.query.limit) || 40;
  res.json(listStaffNotifications(userId, limit));
});

ispOpsRouter.post('/staff-notifications/read', (req, res) => {
  const userId = Number((req as any).user?.id);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : undefined;
  const all = req.body?.all === true || req.body?.all === 1;
  res.json(markStaffNotificationsRead(userId, { ids, all }));
});

ispOpsRouter.put('/client-portal/settings', (req, res) => {
  const b = req.body || {};
  const title = String(b.title ?? 'PANORTH').trim() || 'PANORTH';
  const subtitle = String(b.subtitle ?? 'Internet Solutions').trim();
  const helpText = String(b.helpText ?? '').trim();
  const welcomeText = String(b.welcomeText ?? '').trim();
  const portalLink = normalizePortalLink(b.portalLink ?? b.portal_link);
  const showBalance = b.showBalance === false || b.showBalance === 0 ? 0 : 1;
  const showInvoices = b.showInvoices === false || b.showInvoices === 0 ? 0 : 1;
  const showTickets = b.showTickets === false || b.showTickets === 0 ? 0 : 1;
  const showCompany = b.showCompany === false || b.showCompany === 0 ? 0 : 1;
  let sessionDays = Number(b.sessionDays);
  if (!Number.isFinite(sessionDays)) sessionDays = 7;
  sessionDays = Math.min(90, Math.max(1, Math.round(sessionDays)));
  const themeRaw = String(b.theme ?? b.portalTheme ?? 'matrix').trim().toLowerCase();
  const portalTheme = themeRaw === 'orbital' ? 'orbital' : 'matrix';
  db.prepare(
    `UPDATE app_settings SET
       portal_title = ?, portal_subtitle = ?, portal_help_text = ?, portal_welcome_text = ?,
       portal_show_balance = ?, portal_show_invoices = ?, portal_show_tickets = ?, portal_show_company = ?,
       portal_session_days = ?, portal_link = ?, portal_theme = ?
     WHERE id = 1`
  ).run(
    title,
    subtitle || null,
    helpText || null,
    welcomeText || null,
    showBalance,
    showInvoices,
    showTickets,
    showCompany,
    sessionDays,
    portalLink || null,
    portalTheme
  );
  res.json(portalSettingsRow());
});

ispOpsRouter.post('/client-portal/enable', (req, res) => {
  const userId = Number(req.body?.pppoe_user_id);
  if (!userId) return res.status(400).json({ error: 'pppoe_user_id required' });
  const user = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(userId) as any;
  if (!user) return res.status(404).json({ error: 'subscriber not found' });

  const password = String(req.body?.password || req.body?.pin || '').trim();
  const useDefault =
    req.body?.useDefaultPassword === true ||
    req.body?.use_default_password === true ||
    !password;

  if (useDefault) {
    const result = ensureDefaultPortalCredentials(userId, { force: true });
    if (!result.ok) return res.status(400).json({ error: result.error });
    notifyPortalActivationIfProvisioned(userId, result);
    return res.json({
      ok: true,
      pppoe_user_id: userId,
      portal_enabled: true,
      mustChangePassword: true,
      defaultPassword: true,
    });
  }

  const err = validateChosenPortalPassword(password);
  if (err) return res.status(400).json({ error: err });
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(
    `UPDATE pppoe_users SET portal_enabled = 1, portal_pin_hash = ?, portal_must_change_password = 0 WHERE id = ?`
  ).run(hash, userId);
  res.json({ ok: true, pppoe_user_id: userId, portal_enabled: true, mustChangePassword: false });
});

ispOpsRouter.post('/client-portal/disable', (req, res) => {
  const userId = Number(req.body?.pppoe_user_id);
  db.prepare(
    `UPDATE pppoe_users SET portal_enabled = 0, portal_pin_hash = NULL, portal_must_change_password = 0 WHERE id = ?`
  ).run(userId);
  db.prepare('DELETE FROM client_portal_sessions WHERE pppoe_user_id = ?').run(userId);
  res.json({ ok: true });
});

/** Bulk auto-create portal logins (account # + phone) for eligible subscribers. */
ispOpsRouter.post('/client-portal/auto-provision', (_req, res) => {
  const before = db
    .prepare(
      `SELECT COUNT(*) AS n FROM pppoe_users
       WHERE portal_enabled = 1 AND portal_pin_hash IS NOT NULL AND portal_pin_hash != ''`
    )
    .get() as { n: number };
  backfillDefaultPortalCredentials();
  const after = db
    .prepare(
      `SELECT COUNT(*) AS n FROM pppoe_users
       WHERE portal_enabled = 1 AND portal_pin_hash IS NOT NULL AND portal_pin_hash != ''`
    )
    .get() as { n: number };
  res.json({ ok: true, created: Math.max(0, Number(after.n) - Number(before.n)), enabled: Number(after.n) });
});

ispOpsRouter.post('/client-portal/accounts/:id/reset-default-password', (req, res) => {
  const id = Number(req.params.id);
  const result = ensureDefaultPortalCredentials(id, { force: true });
  if (!result.ok) return res.status(400).json({ error: result.error });
  notifyPortalActivationIfProvisioned(id, result);
  const updated = db
    .prepare(
      `SELECT id, username, customer_name, account_number, status, contact, email, profile, price,
              portal_enabled, portal_must_change_password,
              CASE WHEN portal_pin_hash IS NOT NULL AND portal_pin_hash != '' THEN 1 ELSE 0 END AS has_pin
       FROM pppoe_users WHERE id = ?`
    )
    .get(id);
  res.json(updated);
});

ispOpsRouter.get('/client-portal/accounts', (req, res) => {
  const enabledOnly = String(req.query.enabled || '') === '1' || String(req.query.enabled || '') === 'true';
  const q = String(req.query.q || '').trim().toLowerCase();
  let rows = db
    .prepare(
      `SELECT u.id, u.username, u.customer_name, u.account_number, u.status, u.contact, u.email, u.profile, u.price,
              u.portal_enabled, u.portal_must_change_password, u.portal_last_login_at,
              CASE WHEN u.portal_pin_hash IS NOT NULL AND u.portal_pin_hash != '' THEN 1 ELSE 0 END AS has_pin,
              CASE WHEN EXISTS (
                SELECT 1 FROM client_portal_sessions s
                WHERE s.pppoe_user_id = u.id AND s.expires_at > datetime('now')
              ) THEN 1 ELSE 0 END AS portal_session_active
       FROM pppoe_users u
       ${enabledOnly ? 'WHERE u.portal_enabled = 1' : ''}
       ORDER BY COALESCE(u.customer_name, u.username)`
    )
    .all() as any[];
  if (q) {
    rows = rows.filter((r) => {
      const hay = [r.username, r.customer_name, r.account_number, r.contact, r.email, r.status]
        .map((x) => String(x || '').toLowerCase())
        .join(' ');
      return hay.includes(q);
    });
  }
  res.json(rows);
});

ispOpsRouter.put('/client-portal/accounts/:id', (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(id) as any;
  if (!user) return res.status(404).json({ error: 'subscriber not found' });

  const b = req.body || {};
  const customer_name =
    b.customer_name !== undefined ? String(b.customer_name || '').trim() || null : user.customer_name;
  const account_number =
    b.account_number !== undefined ? String(b.account_number || '').trim() || null : user.account_number;
  const contact = b.contact !== undefined ? String(b.contact || '').trim() || null : user.contact;
  const email = b.email !== undefined ? String(b.email || '').trim() || null : user.email;

  let portal_enabled = user.portal_enabled ? 1 : 0;
  if (b.portal_enabled !== undefined) {
    portal_enabled = b.portal_enabled === false || b.portal_enabled === 0 ? 0 : 1;
  }

  let pinHash = user.portal_pin_hash;
  let mustChange = Number(user.portal_must_change_password) === 1 ? 1 : 0;
  const password = String(b.password ?? b.pin ?? '').trim();
  const useDefault =
    b.useDefaultPassword === true ||
    b.use_default_password === true ||
    b.resetDefaultPassword === true;

  if (useDefault) {
    const phone = defaultPortalPasswordFromContact(contact);
    if (!phone) return res.status(400).json({ error: 'Phone/contact number required for default password' });
    if (!account_number) return res.status(400).json({ error: 'Account number required' });
    pinHash = bcrypt.hashSync(phone, 10);
    mustChange = 1;
    portal_enabled = 1;
  } else if (password) {
    // Accept legacy 4–8 digit PIN or a chosen password (6–64).
    if (!/^\d{4,8}$/.test(password)) {
      const err = validateChosenPortalPassword(password);
      if (err) return res.status(400).json({ error: err });
    }
    pinHash = bcrypt.hashSync(password, 10);
    mustChange = b.mustChangePassword === true || b.must_change_password === true ? 1 : 0;
    portal_enabled = 1;
  } else if (portal_enabled && !pinHash) {
    // Enabling without a password → default to phone.
    const phone = defaultPortalPasswordFromContact(contact);
    if (!phone) {
      return res.status(400).json({ error: 'Set a password or add a phone/contact for the default login' });
    }
    if (!account_number) return res.status(400).json({ error: 'Account number required' });
    pinHash = bcrypt.hashSync(phone, 10);
    mustChange = 1;
  }

  if (!portal_enabled) {
    pinHash = null;
    mustChange = 0;
    db.prepare('DELETE FROM client_portal_sessions WHERE pppoe_user_id = ?').run(id);
  }

  const hadCreds = !!(user.portal_enabled && user.portal_pin_hash);
  db.prepare(
    `UPDATE pppoe_users SET
       customer_name = ?, account_number = ?, contact = ?, email = ?,
       portal_enabled = ?, portal_pin_hash = ?, portal_must_change_password = ?
     WHERE id = ?`
  ).run(customer_name, account_number, contact, email, portal_enabled, pinHash, mustChange, id);

  // SMS portal activation when staff newly enables with default (phone) password.
  if (portal_enabled && pinHash && mustChange === 1 && (useDefault || !hadCreds)) {
    notifyPortalActivationIfProvisioned(id, { ok: true, provisioned: true });
  }

  const updated = db
    .prepare(
      `SELECT id, username, customer_name, account_number, status, contact, email, profile, price,
              portal_enabled, portal_must_change_password,
              CASE WHEN portal_pin_hash IS NOT NULL AND portal_pin_hash != '' THEN 1 ELSE 0 END AS has_pin
       FROM pppoe_users WHERE id = ?`
    )
    .get(id);
  res.json(updated);
});

// ─── Portal plan-change requests (staff) ────────────────────────────────────

ispOpsRouter.get('/client-portal/plan-changes', (req, res) => {
  const status = String(req.query.status || 'pending');
  let sql = `
    SELECT r.*, u.customer_name, u.username, u.account_number, u.status AS user_status
    FROM plan_change_requests r
    LEFT JOIN pppoe_users u ON u.id = r.pppoe_user_id
    WHERE 1=1`;
  const params: any[] = [];
  if (status && status !== 'all') {
    sql += ' AND r.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY CASE r.status WHEN \'pending\' THEN 0 ELSE 1 END, r.id DESC LIMIT 200';
  res.json({ requests: db.prepare(sql).all(...params) });
});

/** Live stream of portal requests (plan changes, tickets) for staff. */
ispOpsRouter.get('/client-portal/events', (req, res) => {
  pipePortalSse(res);
});

ispOpsRouter.post('/client-portal/plan-changes/:id/accept', async (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM plan_change_requests WHERE id = ?').get(id) as any;
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });

  const user = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(row.pppoe_user_id) as any;
  if (!user) return res.status(404).json({ error: 'subscriber not found' });

  // Recompute proration at acceptance time (days remaining may have shifted).
  const plan = listBillingPlansPublic().find((p) => p.name === row.to_plan);
  if (!plan) return res.status(400).json({ error: 'Target plan no longer exists' });
  const proration = computePlanChangeProration({
    oldPrice: Number(user.price) || Number(row.from_price) || 0,
    newPrice: Number(plan.price) || 0,
    subscriptionDue: user.subscription_due,
  });

  const change = await changePppoeUserPlan(user.id, plan.name, { bounce: true });
  if (!change.ok) {
    return res.status(400).json({ error: change.error || 'Could not change plan' });
  }

  // Replace open AR with a single prorated invoice for the remaining cycle.
  db.prepare(
    `UPDATE invoices SET status = 'void'
     WHERE pppoe_user_id = ? AND status IN ('unpaid','partial','overdue')`
  ).run(user.id);

  const number = nextNumber('INV', 'invoices', 'number');
  const due = user.subscription_due || todayISO();
  const invInfo = db
    .prepare(
      `INSERT INTO invoices
       (number, pppoe_user_id, customer_name, account_number, period_start, period_end, due_date, amount, status, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unpaid', ?)`
    )
    .run(
      number,
      user.id,
      user.customer_name || user.username,
      user.account_number || null,
      proration.asOf,
      due,
      due,
      proration.proratedBalance,
      `Plan change ${row.from_plan || '—'} → ${plan.name}: ${proration.consumedDays}d @ ${proration.oldPrice} + ${proration.remainingDays}d @ ${proration.newPrice}`
    );

  try {
    db.prepare(
      `UPDATE payment_links SET amount = ? WHERE pppoe_user_id = ? AND status = 'pending'`
    ).run(proration.proratedBalance, user.id);
  } catch {
    /* payment_links may be absent on older DBs */
  }

  db.prepare(
    `UPDATE plan_change_requests SET
       status = 'accepted',
       from_price = ?, to_price = ?,
       consumed_days = ?, remaining_days = ?,
       old_portion = ?, new_portion = ?, prorated_balance = ?,
       review_note = ?, reviewed_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(
    proration.oldPrice,
    proration.newPrice,
    proration.consumedDays,
    proration.remainingDays,
    proration.oldPortion,
    proration.newPortion,
    proration.proratedBalance,
    String(req.body?.note || '').trim() || null,
    id
  );

  const accepted = db.prepare('SELECT * FROM plan_change_requests WHERE id = ?').get(id);
  publishPortalEvent({
    type: 'plan_change',
    action: 'accepted',
    pppoeUserId: user.id,
    requestId: id,
    status: 'accepted',
    payload: { proration, toPlan: plan.name },
  });
  res.json({
    ok: true,
    request: accepted,
    proration,
    planChange: change,
    invoice: db.prepare('SELECT * FROM invoices WHERE id = ?').get(invInfo.lastInsertRowid),
  });
});

ispOpsRouter.post('/client-portal/plan-changes/:id/reject', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM plan_change_requests WHERE id = ?').get(id) as any;
  if (!row) return res.status(404).json({ error: 'not found' });
  if (row.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });
  db.prepare(
    `UPDATE plan_change_requests SET status = 'rejected', review_note = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(String(req.body?.note || '').trim() || null, id);
  const rejected = db.prepare('SELECT * FROM plan_change_requests WHERE id = ?').get(id);
  publishPortalEvent({
    type: 'plan_change',
    action: 'rejected',
    pppoeUserId: row.pppoe_user_id,
    requestId: id,
    status: 'rejected',
  });
  res.json({ ok: true, request: rejected });
});

// ─── Rogue MAC ──────────────────────────────────────────────────────────────

function routerConn(id: number | null): (RouterConn & { id: number; name: string }) | null {
  if (!id) return null;
  const r = db.prepare('SELECT id, name, host, port, api_user, api_pass FROM routers WHERE id = ?').get(id) as any;
  if (!r?.host || !r?.api_user) return null;
  return r;
}

ispOpsRouter.get('/rogue-macs', (req, res) => {
  const status = String(req.query.status || '');
  let sql = 'SELECT * FROM rogue_mac_events WHERE 1=1';
  const params: any[] = [];
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY last_seen DESC LIMIT 500';
  res.json({ events: db.prepare(sql).all(...params) });
});

ispOpsRouter.post('/rogue-macs/scan', async (req, res) => {
  const routerId = Number(req.body?.routerId || req.query.routerId);
  const conn = routerConn(routerId);
  if (!conn) return res.status(400).json({ error: 'Select a configured router' });

  const known = new Set<string>();
  for (const row of db.prepare('SELECT mac FROM ipoe_lease_meta WHERE mac IS NOT NULL').all() as { mac: string }[]) {
    known.add(String(row.mac).toUpperCase());
  }
  // Treat MACs mentioned in PPPoE comments/contact fields lightly — primary known set is IPoE meta.
  // Also whitelist anything previously marked trusted.
  for (const row of db.prepare(`SELECT mac FROM rogue_mac_events WHERE status = 'trusted'`).all() as { mac: string }[]) {
    known.add(String(row.mac).toUpperCase());
  }

  let leases: Awaited<ReturnType<typeof fetchDhcpLeases>> = [];
  try {
    leases = await fetchDhcpLeases(conn);
  } catch (e: any) {
    return res.status(502).json({ error: e?.message || 'Could not fetch DHCP leases' });
  }

  const upsert = db.prepare(
    `INSERT INTO rogue_mac_events (router_id, mac, address, hostname, lease_id, status, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, 'open', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(router_id, mac) DO UPDATE SET
       address = excluded.address,
       hostname = excluded.hostname,
       lease_id = excluded.lease_id,
       last_seen = CURRENT_TIMESTAMP,
       status = CASE WHEN rogue_mac_events.status = 'trusted' THEN 'trusted'
                     WHEN rogue_mac_events.status = 'purged' THEN 'open'
                     ELSE rogue_mac_events.status END`
  );

  let found = 0;
  for (const l of leases) {
    const mac = (l.macAddress || l.activeMac || '').toUpperCase();
    if (!mac || known.has(mac)) continue;
    if (l.blocked) continue;
    upsert.run(routerId, mac, l.address || l.activeAddress || null, l.hostName || null, l.id || null);
    found += 1;
  }

  const events = db
    .prepare(`SELECT * FROM rogue_mac_events WHERE router_id = ? AND status = 'open' ORDER BY last_seen DESC`)
    .all(routerId);
  res.json({ ok: true, scanned: leases.length, rogueCount: found, events });
});

ispOpsRouter.post('/rogue-macs/:id/trust', (req, res) => {
  db.prepare(`UPDATE rogue_mac_events SET status = 'trusted', notes = COALESCE(?, notes) WHERE id = ?`).run(
    req.body?.notes || null,
    Number(req.params.id)
  );
  res.json(db.prepare('SELECT * FROM rogue_mac_events WHERE id = ?').get(Number(req.params.id)));
});

ispOpsRouter.post('/rogue-macs/:id/purge', async (req, res) => {
  const id = Number(req.params.id);
  const ev = db.prepare('SELECT * FROM rogue_mac_events WHERE id = ?').get(id) as any;
  if (!ev) return res.status(404).json({ error: 'not found' });
  const conn = routerConn(ev.router_id);
  if (conn && ev.lease_id) {
    try {
      const { setDhcpLeaseBlocked } = await import('./mikrotik.js');
      await setDhcpLeaseBlocked(conn, String(ev.lease_id), true);
    } catch (e: any) {
      return res.status(502).json({ error: e?.message || 'Failed to block lease on router' });
    }
  }
  db.prepare(`UPDATE rogue_mac_events SET status = 'purged', notes = COALESCE(?, notes) WHERE id = ?`).run(
    req.body?.notes || 'Blocked on MikroTik',
    id
  );
  res.json(db.prepare('SELECT * FROM rogue_mac_events WHERE id = ?').get(id));
});

// Kick hotspot session helper used by Hotspot page
ispOpsRouter.post('/hotspot/active/:id/kick', async (req, res) => {
  const routerId = Number(req.body?.routerId);
  const conn = routerConn(routerId);
  if (!conn) return res.status(400).json({ error: 'Select a configured router' });
  try {
    await removeHotspotActive(conn, String(req.params.id));
    res.json({ ok: true });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || 'Kick failed' });
  }
});

// ─── Public Client Portal ───────────────────────────────────────────────────

function portalUserFromToken(token: string): any | null {
  if (!token) return null;
  const sess = db
    .prepare(
      `SELECT s.id AS session_id, s.token, s.pppoe_user_id, s.expires_at, s.created_at,
              u.id AS uid, u.username, u.customer_name, u.account_number, u.status,
              u.subscription_due, u.price, u.profile, u.contact, u.email, u.address,
              u.portal_must_change_password
       FROM client_portal_sessions s
       JOIN pppoe_users u ON u.id = s.pppoe_user_id
       WHERE s.token = ? AND s.expires_at > datetime('now') AND u.portal_enabled = 1`
    )
    .get(token) as any;
  if (!sess) return null;
  // Prefer the session's subscriber FK — never the session row id.
  sess.uid = Number(sess.pppoe_user_id || sess.uid);
  return sess;
}

function rejectIfMustChangePassword(sess: any, res: Response): boolean {
  if (Number(sess?.portal_must_change_password) !== 1) return false;
  res.status(403).json({
    error: 'Please set a new password before using the portal',
    mustChangePassword: true,
  });
  return true;
}

publicPortalRouter.get('/public/portal/settings', (_req, res) => {
  res.json(portalSettingsRow());
});

publicPortalRouter.post('/public/portal/login', (req, res) => {
  const account = String(req.body?.account || '').trim();
  const password = String(req.body?.password || req.body?.pin || '').trim();
  if (!account || !password) {
    return res.status(400).json({ error: 'Account number and password required' });
  }
  const user = findPortalUserByAccount(account);
  if (!user?.portal_pin_hash || !portalPasswordMatches(password, user.portal_pin_hash)) {
    return res.status(401).json({ error: 'Invalid account or password' });
  }
  const mustChangePassword = Number(user.portal_must_change_password) === 1;
  const settings = portalSettingsRow();
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + settings.sessionDays * 864e5).toISOString();
  const nowIso = new Date().toISOString();
  db.prepare(`INSERT INTO client_portal_sessions (token, pppoe_user_id, expires_at) VALUES (?, ?, ?)`).run(
    token,
    user.id,
    expires
  );
  db.prepare(`UPDATE pppoe_users SET portal_last_login_at = ? WHERE id = ?`).run(nowIso, user.id);
  res.json({
    token,
    expiresAt: expires,
    mustChangePassword,
    customer: {
      name: user.customer_name || user.username,
      accountNumber: user.account_number,
      status: user.status,
      due: user.subscription_due,
      plan: user.profile,
      price: user.price,
    },
  });
});

/**
 * Forgot password — SMS a temporary password to the mobile number on the account.
 * Requires account number + matching contact/phone. Forces password change after login.
 */
publicPortalRouter.post('/public/portal/forgot-password', async (req, res) => {
  const account = String(req.body?.account || '').trim();
  const contact = String(req.body?.contact || req.body?.phone || req.body?.mobile || '').trim();
  if (!account || !contact) {
    return res.status(400).json({ error: 'Account number and mobile number are required' });
  }

  const rateKey = `${account.toLowerCase()}|${contact.replace(/\D/g, '')}`;
  if (!portalForgotAllowed(rateKey)) {
    return res.status(429).json({ error: 'Please wait a minute before requesting another reset SMS' });
  }

  const user = findPortalUserByAccount(account);
  // Generic failures avoid account enumeration where possible.
  if (!user || !phonesMatch(user.contact, contact)) {
    return res.status(400).json({
      error: 'No portal account matched that account number and mobile number',
    });
  }
  if (!String(user.contact || '').trim()) {
    return res.status(400).json({ error: 'No mobile number on file — contact your ISP' });
  }

  const prevHash = user.portal_pin_hash;
  const prevMust = Number(user.portal_must_change_password) === 1 ? 1 : 0;
  const tempPassword = generateTempPortalPassword();
  const hash = bcrypt.hashSync(tempPassword, 10);
  db.prepare(
    `UPDATE pppoe_users
     SET portal_pin_hash = ?, portal_must_change_password = 1, portal_enabled = 1
     WHERE id = ?`
  ).run(hash, user.id);

  const name = user.customer_name || user.username || 'subscriber';
  const acct = user.account_number || account;
  const subject = 'Portal temporary password';
  const message =
    `Hi ${name}, your temporary subscriber portal password is: ${tempPassword}. ` +
    `Account: ${acct}. Sign in at /portal and set a new password right away.`;

  const revert = () => {
    db.prepare(
      `UPDATE pppoe_users SET portal_pin_hash = ?, portal_must_change_password = ? WHERE id = ?`
    ).run(prevHash, prevMust, user.id);
  };

  try {
    const results = await notifyClientChannels(user, ['sms'], subject, message, 'portal_password_reset');
    const smsResult = results.find((r) => r.startsWith('sms:')) || '';
    const status = smsResult.split(':')[1] || '';
    if (status === 'sent') {
      db.prepare('DELETE FROM client_portal_sessions WHERE pppoe_user_id = ?').run(user.id);
      return res.json({
        ok: true,
        sent: true,
        message: 'A temporary password was sent to your mobile number. Sign in and set a new password.',
      });
    }
    revert();
    if (status === 'simulated') {
      return res.status(503).json({
        error:
          'SMS is not configured on this panel. Ask your ISP to enable SMS notifications, or request a reset from support.',
        sent: false,
      });
    }
    return res.status(502).json({
      error: 'Could not send the SMS. Try again later or contact your ISP.',
      sent: false,
    });
  } catch (e: any) {
    revert();
    return res.status(502).json({
      error: e?.message || 'Could not send the SMS. Try again later or contact your ISP.',
      sent: false,
    });
  }
});

/** First login / forced password change — overwrites the default phone password. */
publicPortalRouter.post('/public/portal/change-password', (req, res) => {
  const token = String(req.headers['x-portal-token'] || req.body?.token || '');
  const sess = portalUserFromToken(token);
  if (!sess) return res.status(401).json({ error: 'Session expired' });
  const userId = portalSubscriberId(sess);
  if (!userId) return res.status(401).json({ error: 'Session expired' });

  const password = String(req.body?.password || '').trim();
  const confirm = String(req.body?.confirm || req.body?.confirmPassword || '').trim();
  const err = validateChosenPortalPassword(password);
  if (err) return res.status(400).json({ error: err });
  if (password !== confirm) return res.status(400).json({ error: 'Passwords do not match' });

  const user = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(userId) as any;
  if (!user || !user.portal_enabled) {
    return res.status(404).json({ error: 'Portal account not found' });
  }
  const defaultPw = defaultPortalPasswordFromContact(user.contact);
  if (defaultPw && password === defaultPw) {
    return res.status(400).json({ error: 'Choose a new password different from your phone number' });
  }
  if (portalPasswordMatches(password, user.portal_pin_hash)) {
    return res.status(400).json({ error: 'Choose a new password different from your current password' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const upd = db
    .prepare(
      `UPDATE pppoe_users
       SET portal_pin_hash = ?, portal_must_change_password = 0, portal_enabled = 1
       WHERE id = ?`
    )
    .run(hash, userId);
  if (!upd.changes) {
    return res.status(500).json({ error: 'Could not save password — please try again' });
  }

  const verify = db
    .prepare(`SELECT portal_pin_hash, portal_must_change_password FROM pppoe_users WHERE id = ?`)
    .get(userId) as any;
  if (
    !verify ||
    Number(verify.portal_must_change_password) === 1 ||
    !portalPasswordMatches(password, verify.portal_pin_hash)
  ) {
    return res.status(500).json({ error: 'Password could not be verified after save — please try again' });
  }

  // Keep this session; drop others.
  db.prepare('DELETE FROM client_portal_sessions WHERE pppoe_user_id = ? AND token != ?').run(userId, token);

  res.json({ ok: true, mustChangePassword: false });
});

publicPortalRouter.get('/public/portal/me', (req, res) => {
  const token = String(req.headers['x-portal-token'] || req.query.token || '');
  const sess = portalUserFromToken(token);
  if (!sess) return res.status(401).json({ error: 'Session expired' });
  markOverdueInvoices();
  const invoices = db
    .prepare(
      `SELECT id, number, period_start, period_end, due_date, amount, amount_paid, status, created_at
       FROM invoices WHERE pppoe_user_id = ? ORDER BY id DESC LIMIT 24`
    )
    .all(sess.uid);
  const openJobs = db
    .prepare(
      `SELECT id, number, type, status, description, created_at FROM job_orders
       WHERE pppoe_user_id = ? AND status NOT IN ('completed','cancelled') ORDER BY id DESC LIMIT 10`
    )
    .all(sess.uid);
  const balance = (invoices as any[])
    .filter((i) => ['unpaid', 'partial', 'overdue'].includes(i.status))
    .reduce((s, i) => s + (Number(i.amount) - Number(i.amount_paid)), 0);
  const company = db
    .prepare(
      `SELECT name, phone, email, address, gcash_number, maya_number, payment_instructions
       FROM company WHERE id = 1`
    )
    .get();
  res.json({
    customer: {
      name: sess.customer_name || sess.username,
      accountNumber: sess.account_number,
      status: sess.status,
      due: sess.subscription_due,
      plan: sess.profile,
      price: sess.price,
      contact: sess.contact,
      email: sess.email,
      address: sess.address,
    },
    balance,
    invoices,
    openJobs,
    company,
    paymentLink: portalPaymentLinkForUser(sess.uid),
    planChangeRequest: db
      .prepare(
        `SELECT id, from_plan AS fromPlan, to_plan AS toPlan, from_price AS fromPrice, to_price AS toPrice,
                consumed_days AS consumedDays, remaining_days AS remainingDays,
                old_portion AS oldPortion, new_portion AS newPortion, prorated_balance AS proratedBalance,
                status, created_at AS createdAt, review_note AS reviewNote
         FROM plan_change_requests
         WHERE pppoe_user_id = ? AND status = 'pending'
         ORDER BY id DESC LIMIT 1`
      )
      .get(sess.uid) || null,
    settings: portalSettingsRow(),
    mustChangePassword: Number(sess.portal_must_change_password) === 1,
  });
});

/**
 * Return existing active pay link, or create one from the subscriber side
 * (reverse of admin creating a payment-link entry). Always allowed so they can
 * send payment details even when no admin link exists yet.
 */
publicPortalRouter.post('/public/portal/payment-link', (req, res) => {
  const token = String(req.headers['x-portal-token'] || req.body?.token || '');
  const sess = portalUserFromToken(token);
  if (!sess) return res.status(401).json({ error: 'Session expired' });
  if (rejectIfMustChangePassword(sess, res)) return;

  const existing = portalPaymentLinkForUser(sess.uid);
  if (existing && (existing.status === 'pending' || existing.status === 'submitted')) {
    return res.json({ paymentLink: existing, created: false });
  }

  markOverdueInvoices();
  const balanceRow = db
    .prepare(
      `SELECT COALESCE(SUM(amount - amount_paid), 0) AS bal FROM invoices
       WHERE pppoe_user_id = ? AND status IN ('unpaid','partial','overdue')`
    )
    .get(sess.uid) as { bal: number };
  const bal = Number(balanceRow?.bal) || 0;
  const price = Number(sess.price) || 0;
  const months = Math.max(1, Math.floor(Number(req.body?.months) || 1));
  const amountRaw = req.body?.amount != null ? Number(req.body.amount) : NaN;
  const amount = Number.isFinite(amountRaw) && amountRaw > 0 ? amountRaw : bal > 0 ? bal : price * months;

  try {
    // Subscriber-initiated entry — shows up on Payment Links like an admin create, tagged portal.
    const created = ensureFreshPayLink(sess.uid, undefined, {
      createdBy: 'portal',
      months,
      amount: amount > 0 ? amount : price > 0 ? price * months : amount,
    });
    const paymentLink = portalPaymentLinkForUser(sess.uid) || {
      path: created.path,
      url: created.url,
      amount: Number(created.amount) || 0,
      months: Number(created.months) || 1,
      status: 'pending',
      expiresAt: null,
      payChannel: null,
      submittedAt: null,
      externalRef: null,
      createdBy: 'portal',
    };
    res.json({ paymentLink, created: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Could not create payment link' });
  }
});

publicPortalRouter.get('/public/portal/outage-services', (_req, res) => {
  res.json({ services: listOutageServiceCatalog() });
});

publicPortalRouter.get('/public/portal/plans', (_req, res) => {
  res.json({
    plans: listBillingPlansPublic().map((p) => ({
      id: p.id,
      name: p.name,
      rateLimit: p.rateLimit || '',
      price: Number(p.price) || 0,
    })),
    cycleDays: PLAN_CYCLE_DAYS,
  });
});

/** Subscriber invoice detail for view / print (must own the invoice). */
publicPortalRouter.get('/public/portal/invoices/:id', (req, res) => {
  const token = String(req.headers['x-portal-token'] || req.query.token || '');
  const sess = portalUserFromToken(token);
  if (!sess) return res.status(401).json({ error: 'Session expired' });
  if (rejectIfMustChangePassword(sess, res)) return;
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid invoice' });
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as any;
  if (!inv || Number(inv.pppoe_user_id) !== Number(sess.uid)) {
    return res.status(404).json({ error: 'Invoice not found' });
  }
  if (String(inv.status || '') === 'void') {
    return res.status(404).json({ error: 'Invoice not found' });
  }
  const payments = db
    .prepare(
      `SELECT id, amount, method, note, created_at, transaction_id
       FROM invoice_payments WHERE invoice_id = ? ORDER BY id`
    )
    .all(id);
  const company = db
    .prepare(
      `SELECT name, address, phone, email, logo, gcash_number, maya_number, payment_instructions
       FROM company WHERE id = 1`
    )
    .get();
  res.json({
    invoice: inv,
    payments,
    history: (payments as any[]).map((p) => ({
      amount: p.amount,
      method: p.method,
      paid_at: p.created_at,
      note: p.note,
    })),
    company,
  });
});

publicPortalRouter.post('/public/portal/plan-change', (req, res) => {
  const token = String(req.headers['x-portal-token'] || req.body?.token || '');
  const sess = portalUserFromToken(token);
  if (!sess) return res.status(401).json({ error: 'Session expired' });
  if (rejectIfMustChangePassword(sess, res)) return;

  const toPlan = String(req.body?.plan || req.body?.toPlan || '').trim();
  if (!toPlan) return res.status(400).json({ error: 'Select a plan' });
  if (toPlan === String(sess.profile || '')) {
    return res.status(400).json({ error: 'You are already on this plan' });
  }

  const plan = listBillingPlansPublic().find((p) => p.name === toPlan);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const pending = db
    .prepare(`SELECT id FROM plan_change_requests WHERE pppoe_user_id = ? AND status = 'pending'`)
    .get(sess.uid);
  if (pending) {
    return res.status(409).json({ error: 'You already have a pending plan change request' });
  }

  const user = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(sess.uid) as any;
  const proration = computePlanChangeProration({
    oldPrice: Number(user?.price) || 0,
    newPrice: Number(plan.price) || 0,
    subscriptionDue: user?.subscription_due,
  });
  const note = String(req.body?.note || '').trim() || null;

  const info = db
    .prepare(
      `INSERT INTO plan_change_requests
       (pppoe_user_id, from_plan, to_plan, from_price, to_price, subscription_due,
        consumed_days, remaining_days, old_portion, new_portion, prorated_balance, status, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    )
    .run(
      sess.uid,
      user?.profile || null,
      plan.name,
      proration.oldPrice,
      proration.newPrice,
      proration.due,
      proration.consumedDays,
      proration.remainingDays,
      proration.oldPortion,
      proration.newPortion,
      proration.proratedBalance,
      note
    );

  const row = db
    .prepare(
      `SELECT id, from_plan AS fromPlan, to_plan AS toPlan, from_price AS fromPrice, to_price AS toPrice,
              consumed_days AS consumedDays, remaining_days AS remainingDays,
              old_portion AS oldPortion, new_portion AS newPortion, prorated_balance AS proratedBalance,
              status, created_at AS createdAt, note
       FROM plan_change_requests WHERE id = ?`
    )
    .get(info.lastInsertRowid);
  const who = subscriberLabel(sess.uid);
  notifyStaff({
    type: 'plan_change',
    title: 'Plan change request',
    body: `${who} requested ${user?.profile || '—'} → ${plan.name}`,
    entityType: 'plan_change_request',
    entityId: Number(info.lastInsertRowid),
    pppoeUserId: sess.uid,
    status: 'pending',
    payload: {
      toPlan: plan.name,
      fromPlan: user?.profile || null,
      proratedBalance: proration.proratedBalance,
    },
  });
  res.status(201).json({ request: row, proration });
});

/** Live stream for the signed-in subscriber (their requests only). */
publicPortalRouter.get('/public/portal/events', (req, res) => {
  const token = String(req.headers['x-portal-token'] || req.query.token || '');
  const sess = portalUserFromToken(token);
  if (!sess) return res.status(401).json({ error: 'Session expired' });
  pipePortalSse(res, { pppoeUserId: sess.uid });
});

publicPortalRouter.post('/public/portal/ticket', (req, res) => {
  const token = String(req.headers['x-portal-token'] || req.body?.token || '');
  const sess = portalUserFromToken(token);
  if (!sess) return res.status(401).json({ error: 'Session expired' });
  if (rejectIfMustChangePassword(sess, res)) return;
  const description = String(req.body?.description || '').trim();
  const serviceSlugs = resolveOutageServiceSlugs(req.body?.serviceSlugs ?? req.body?.services);
  const type = String(req.body?.type || (serviceSlugs.length ? 'other' : 'repair'));
  if (!description && !serviceSlugs.length) {
    return res.status(400).json({ error: 'Describe the issue or select affected services' });
  }
  const serviceNames = listOutageServiceCatalog()
    .filter((s) => serviceSlugs.includes(s.slug))
    .map((s) => s.name);
  const fullDescription = [
    description,
    serviceNames.length ? `Affected services: ${serviceNames.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const number = nextNumber('JO', 'job_orders', 'number');
  const jobType = ['repair', 'new_install', 'follow_up', 'disconnect', 'other'].includes(type)
    ? type
    : 'repair';
  let info;
  try {
    info = db
      .prepare(
        `INSERT INTO job_orders
         (number, pppoe_user_id, customer_name, contact, address, type, status, priority, description, source)
         VALUES (?, ?, ?, ?, ?, ?, 'open', 'normal', ?, 'portal')`
      )
      .run(
        number,
        sess.uid,
        sess.customer_name || sess.username,
        sess.contact,
        sess.address,
        jobType,
        fullDescription
      );
  } catch {
    info = db
      .prepare(
        `INSERT INTO job_orders
         (number, pppoe_user_id, customer_name, contact, address, type, status, priority, description)
         VALUES (?, ?, ?, ?, ?, ?, 'open', 'normal', ?)`
      )
      .run(
        number,
        sess.uid,
        sess.customer_name || sess.username,
        sess.contact,
        sess.address,
        jobType,
        fullDescription
      );
  }
  const job = db.prepare('SELECT * FROM job_orders WHERE id = ?').get(info.lastInsertRowid) as any;
  let outageReport = null;
  if (serviceSlugs.length) {
    outageReport = recordSubscriberOutageReport({
      pppoeUserId: sess.uid,
      customerName: sess.customer_name || sess.username,
      contact: sess.contact,
      accountNumber: sess.account_number,
      description: description || fullDescription,
      jobOrderId: job?.id ?? null,
      serviceSlugs,
    });
  }
  const who = subscriberLabel(sess.uid);
  const servicesNote = serviceNames.length ? ` Apps: ${serviceNames.join(', ')}.` : '';
  notifyStaff({
    type: 'ticket',
    title: serviceNames.length ? 'Service outage report' : 'Support request',
    body: `${who} filed ${job?.number || number}.${servicesNote}`,
    entityType: 'job_order',
    entityId: Number(job?.id) || Number(info.lastInsertRowid),
    pppoeUserId: sess.uid,
    status: 'open',
    payload: {
      number: job?.number || number,
      serviceNames,
      description: description || null,
    },
  });
  res.status(201).json({ ...job, outageReport });
});

publicPortalRouter.post('/public/portal/logout', (req, res) => {
  const token = String(req.headers['x-portal-token'] || req.body?.token || '');
  if (token) db.prepare('DELETE FROM client_portal_sessions WHERE token = ?').run(token);
  res.json({ ok: true });
});

/** Helper used by PPPoE update to enforce NAP capacity. */
export function assertNapHasCapacity(napId: number | null | undefined, excludeUserId?: number): string | null {
  if (napId == null || napId === undefined || napId === ('' as any)) return null;
  const nap = db.prepare(`SELECT id, name, kind, ports FROM naps WHERE id = ?`).get(Number(napId)) as any;
  if (!nap || nap.kind !== 'nap') return null;
  const usedRow = db
    .prepare(
      `SELECT COUNT(*) AS c FROM pppoe_users WHERE nap_id = ? AND (? IS NULL OR id != ?)`
    )
    .get(nap.id, excludeUserId ?? null, excludeUserId ?? null) as { c: number };
  if (usedRow.c >= (nap.ports || 0)) {
    return `NAP "${nap.name}" is full (${usedRow.c}/${nap.ports} ports used). Free a port or raise capacity.`;
  }
  return null;
}
