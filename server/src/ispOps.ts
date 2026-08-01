/**
 * ISP operations modules: Job Orders, Invoices/AR, Client Portal,
 * Finance (MRR + expenses), Rogue MAC scan.
 */
import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { db } from './db.js';
import { fetchDhcpLeases, removeHotspotActive, type RouterConn } from './mikrotik.js';

function columnExists(table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === col);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
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
  `);

  for (const [col, type] of [
    ['portal_pin_hash', 'TEXT'],
    ['portal_enabled', 'INTEGER DEFAULT 0'],
  ] as [string, string][]) {
    if (!columnExists('pppoe_users', col)) {
      db.exec(`ALTER TABLE pppoe_users ADD COLUMN ${col} ${type}`);
    }
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
  const completed_at =
    status === 'completed' ? b.completed_at || ex.completed_at || new Date().toISOString() : status !== 'completed' ? null : ex.completed_at;
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
    b.type !== undefined ? b.type : ex.type,
    status,
    b.priority !== undefined ? b.priority : ex.priority,
    b.assigned_to !== undefined ? b.assigned_to : ex.assigned_to,
    b.description !== undefined ? b.description : ex.description,
    b.notes !== undefined ? b.notes : ex.notes,
    b.scheduled_at !== undefined ? b.scheduled_at : ex.scheduled_at,
    completed_at,
    id
  );
  res.json(db.prepare('SELECT * FROM job_orders WHERE id = ?').get(id));
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

function portalSettingsRow() {
  const row = db
    .prepare(
      `SELECT portal_title, portal_subtitle, portal_help_text, portal_welcome_text,
              portal_show_balance, portal_show_invoices, portal_show_tickets, portal_show_company,
              portal_session_days
       FROM app_settings WHERE id = 1`
    )
    .get() as any;
  return {
    title: row?.portal_title || 'Subscriber Portal',
    subtitle: row?.portal_subtitle || '',
    helpText: row?.portal_help_text || 'Ask your ISP for portal access (account + PIN).',
    welcomeText: row?.portal_welcome_text || '',
    showBalance: row?.portal_show_balance !== 0,
    showInvoices: row?.portal_show_invoices !== 0,
    showTickets: row?.portal_show_tickets !== 0,
    showCompany: row?.portal_show_company !== 0,
    sessionDays: Math.min(90, Math.max(1, Number(row?.portal_session_days) || 7)),
  };
}

ispOpsRouter.get('/client-portal/settings', (_req, res) => {
  res.json(portalSettingsRow());
});

ispOpsRouter.put('/client-portal/settings', (req, res) => {
  const b = req.body || {};
  const title = String(b.title ?? 'Subscriber Portal').trim() || 'Subscriber Portal';
  const subtitle = String(b.subtitle ?? '').trim();
  const helpText = String(b.helpText ?? '').trim();
  const welcomeText = String(b.welcomeText ?? '').trim();
  const showBalance = b.showBalance === false || b.showBalance === 0 ? 0 : 1;
  const showInvoices = b.showInvoices === false || b.showInvoices === 0 ? 0 : 1;
  const showTickets = b.showTickets === false || b.showTickets === 0 ? 0 : 1;
  const showCompany = b.showCompany === false || b.showCompany === 0 ? 0 : 1;
  let sessionDays = Number(b.sessionDays);
  if (!Number.isFinite(sessionDays)) sessionDays = 7;
  sessionDays = Math.min(90, Math.max(1, Math.round(sessionDays)));
  db.prepare(
    `UPDATE app_settings SET
       portal_title = ?, portal_subtitle = ?, portal_help_text = ?, portal_welcome_text = ?,
       portal_show_balance = ?, portal_show_invoices = ?, portal_show_tickets = ?, portal_show_company = ?,
       portal_session_days = ?
     WHERE id = 1`
  ).run(title, subtitle || null, helpText || null, welcomeText || null, showBalance, showInvoices, showTickets, showCompany, sessionDays);
  res.json(portalSettingsRow());
});

ispOpsRouter.post('/client-portal/enable', (req, res) => {
  const userId = Number(req.body?.pppoe_user_id);
  const pin = String(req.body?.pin || '').trim();
  if (!userId || !/^\d{4,8}$/.test(pin)) {
    return res.status(400).json({ error: 'pppoe_user_id and 4–8 digit PIN required' });
  }
  const user = db.prepare('SELECT id FROM pppoe_users WHERE id = ?').get(userId);
  if (!user) return res.status(404).json({ error: 'subscriber not found' });
  const hash = bcrypt.hashSync(pin, 10);
  db.prepare('UPDATE pppoe_users SET portal_enabled = 1, portal_pin_hash = ? WHERE id = ?').run(hash, userId);
  res.json({ ok: true, pppoe_user_id: userId, portal_enabled: true });
});

ispOpsRouter.post('/client-portal/disable', (req, res) => {
  const userId = Number(req.body?.pppoe_user_id);
  db.prepare('UPDATE pppoe_users SET portal_enabled = 0, portal_pin_hash = NULL WHERE id = ?').run(userId);
  db.prepare('DELETE FROM client_portal_sessions WHERE pppoe_user_id = ?').run(userId);
  res.json({ ok: true });
});

ispOpsRouter.get('/client-portal/accounts', (req, res) => {
  const enabledOnly = String(req.query.enabled || '') === '1' || String(req.query.enabled || '') === 'true';
  const q = String(req.query.q || '').trim().toLowerCase();
  let rows = db
    .prepare(
      `SELECT id, username, customer_name, account_number, status, contact, email, profile, price,
              portal_enabled,
              CASE WHEN portal_pin_hash IS NOT NULL AND portal_pin_hash != '' THEN 1 ELSE 0 END AS has_pin
       FROM pppoe_users
       ${enabledOnly ? 'WHERE portal_enabled = 1' : ''}
       ORDER BY COALESCE(customer_name, username)`
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
  if (b.pin !== undefined && b.pin !== null && String(b.pin).trim() !== '') {
    const pin = String(b.pin).trim();
    if (!/^\d{4,8}$/.test(pin)) {
      return res.status(400).json({ error: 'PIN must be 4–8 digits' });
    }
    pinHash = bcrypt.hashSync(pin, 10);
    portal_enabled = 1;
  }
  if (!portal_enabled) {
    pinHash = null;
    db.prepare('DELETE FROM client_portal_sessions WHERE pppoe_user_id = ?').run(id);
  }

  db.prepare(
    `UPDATE pppoe_users SET
       customer_name = ?, account_number = ?, contact = ?, email = ?,
       portal_enabled = ?, portal_pin_hash = ?
     WHERE id = ?`
  ).run(customer_name, account_number, contact, email, portal_enabled, pinHash, id);

  const updated = db
    .prepare(
      `SELECT id, username, customer_name, account_number, status, contact, email, profile, price,
              portal_enabled,
              CASE WHEN portal_pin_hash IS NOT NULL AND portal_pin_hash != '' THEN 1 ELSE 0 END AS has_pin
       FROM pppoe_users WHERE id = ?`
    )
    .get(id);
  res.json(updated);
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
      `SELECT s.*, u.id AS uid, u.username, u.customer_name, u.account_number, u.status,
              u.subscription_due, u.price, u.profile, u.contact, u.email, u.address
       FROM client_portal_sessions s
       JOIN pppoe_users u ON u.id = s.pppoe_user_id
       WHERE s.token = ? AND s.expires_at > datetime('now') AND u.portal_enabled = 1`
    )
    .get(token) as any;
  return sess || null;
}

publicPortalRouter.get('/public/portal/settings', (_req, res) => {
  res.json(portalSettingsRow());
});

publicPortalRouter.post('/public/portal/login', (req, res) => {
  const account = String(req.body?.account || '').trim();
  const pin = String(req.body?.pin || '').trim();
  if (!account || !pin) return res.status(400).json({ error: 'Account number and PIN required' });
  const user = db
    .prepare(
      `SELECT * FROM pppoe_users
       WHERE portal_enabled = 1 AND (account_number = ? OR username = ?)
       LIMIT 1`
    )
    .get(account, account) as any;
  if (!user?.portal_pin_hash || !bcrypt.compareSync(pin, user.portal_pin_hash)) {
    return res.status(401).json({ error: 'Invalid account or PIN' });
  }
  const settings = portalSettingsRow();
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + settings.sessionDays * 864e5).toISOString();
  db.prepare(`INSERT INTO client_portal_sessions (token, pppoe_user_id, expires_at) VALUES (?, ?, ?)`).run(
    token,
    user.id,
    expires
  );
  res.json({
    token,
    expiresAt: expires,
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
  const company = db.prepare('SELECT name, phone, email, address, gcash_number, maya_number FROM company WHERE id = 1').get();
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
    settings: portalSettingsRow(),
  });
});

publicPortalRouter.post('/public/portal/ticket', (req, res) => {
  const token = String(req.headers['x-portal-token'] || req.body?.token || '');
  const sess = portalUserFromToken(token);
  if (!sess) return res.status(401).json({ error: 'Session expired' });
  const description = String(req.body?.description || '').trim();
  const type = String(req.body?.type || 'repair');
  if (!description) return res.status(400).json({ error: 'Description required' });
  const number = nextNumber('JO', 'job_orders', 'number');
  const info = db
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
      ['repair', 'new_install', 'follow_up', 'disconnect', 'other'].includes(type) ? type : 'repair',
      description
    );
  res.status(201).json(db.prepare('SELECT * FROM job_orders WHERE id = ?').get(info.lastInsertRowid));
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
