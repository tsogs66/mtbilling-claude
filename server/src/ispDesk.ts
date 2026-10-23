/**
 * Operator desk: one subscriber record, cashier payments, dunning,
 * NAP dispatch, CGNAT/session search, public area status, RADIUS export.
 */
import express from 'express';
import { db } from './db.js';
import { sendManual } from './notify.js';
import { rebootAcsDevice, refreshAcsDevice, setAcsParameterValues } from './genieacs.js';

function columnExists(table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === col);
}

export function initIspDesk() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS isp_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      branch_name TEXT DEFAULT 'Main',
      bir_or_prefix TEXT DEFAULT 'OR',
      bir_or_next INTEGER DEFAULT 1,
      radius_nas_ip TEXT,
      dunning_enabled INTEGER DEFAULT 1,
      dunning_warn_days TEXT DEFAULT '0,3',
      dunning_disconnect_day INTEGER DEFAULT 7,
      dunning_message TEXT DEFAULT 'Hi {name}, account {username} is {days} day(s) past due. Please pay to avoid disconnection on day {disconnect}.'
    );
    INSERT OR IGNORE INTO isp_settings (id) VALUES (1);

    CREATE TABLE IF NOT EXISTS isp_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pppoe_user_id INTEGER,
      customer_name TEXT,
      amount REAL NOT NULL,
      method TEXT DEFAULT 'cash',
      cashier_username TEXT,
      or_number TEXT,
      note TEXT,
      extend_months INTEGER DEFAULT 0,
      reversed_at TEXT,
      reverse_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cashier_closes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cashier_username TEXT NOT NULL,
      business_date TEXT NOT NULL,
      cash_total REAL DEFAULT 0,
      gcash_total REAL DEFAULT 0,
      other_total REAL DEFAULT 0,
      note TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cgnat_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seen_at TEXT NOT NULL,
      src_ip TEXT,
      src_port INTEGER,
      public_ip TEXT,
      public_port INTEGER,
      dst_ip TEXT,
      protocol TEXT,
      subscriber_id INTEGER,
      username TEXT,
      raw TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cgnat_public ON cgnat_logs(public_ip, seen_at);
    CREATE INDEX IF NOT EXISTS idx_cgnat_src ON cgnat_logs(src_ip, seen_at);

    CREATE TABLE IF NOT EXISTS session_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pppoe_user_id INTEGER,
      username TEXT,
      framed_ip TEXT,
      mac TEXT,
      started_at TEXT,
      stopped_at TEXT,
      router_name TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_session_ip ON session_history(framed_ip, started_at);

    CREATE TABLE IF NOT EXISTS area_outages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nap_id INTEGER,
      pon TEXT,
      title TEXT NOT NULL,
      detail TEXT,
      status TEXT DEFAULT 'open',
      eta TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      cleared_at TEXT
    );
  `);

  for (const [col, type] of [
    ['due_at', 'TEXT'],
    ['onu_serial', 'TEXT'],
    ['photo_note', 'TEXT'],
    ['materials_json', 'TEXT'],
    ['stock_applied', 'INTEGER DEFAULT 0'],
  ] as [string, string][]) {
    if (!columnExists('job_orders', col)) db.exec(`ALTER TABLE job_orders ADD COLUMN ${col} ${type}`);
  }
  if (!columnExists('pppoe_users', 'onu_serial')) {
    db.exec('ALTER TABLE pppoe_users ADD COLUMN onu_serial TEXT');
  }
}

export function getIspSettings() {
  initIspDesk();
  return db.prepare('SELECT * FROM isp_settings WHERE id = 1').get() as {
    branch_name: string;
    bir_or_prefix: string;
    bir_or_next: number;
    radius_nas_ip: string | null;
    dunning_enabled: number;
    dunning_warn_days: string;
    dunning_disconnect_day: number;
    dunning_message: string;
  };
}

function nextOfficialReceipt(): string {
  const s = getIspSettings();
  const n = Number(s.bir_or_next) || 1;
  const prefix = String(s.bir_or_prefix || 'OR').replace(/[^A-Za-z0-9-]/g, '') || 'OR';
  db.prepare('UPDATE isp_settings SET bir_or_next = ? WHERE id = 1').run(n + 1);
  return `${prefix}-${String(n).padStart(6, '0')}`;
}

function addMonths(iso: string, months: number): string {
  const base = new Date(`${String(iso || '').slice(0, 10) || new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return new Date().toISOString().slice(0, 10);
  const day = base.getUTCDate();
  const target = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months, 1));
  const dim = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, dim));
  return target.toISOString().slice(0, 10);
}

export type CgnatEntry = {
  seenAt: string;
  srcIp: string;
  srcPort: number | null;
  publicIp: string;
  publicPort: number | null;
  dstIp: string;
  protocol: string;
  username: string;
};

/** Accept "time srcIp:port publicIp:port proto [user]" or a JSON object. */
export function parseCgnatLine(line: string): CgnatEntry | null {
  const raw = String(line || '').trim();
  if (!raw) return null;
  if (raw.startsWith('{')) {
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      const seenAt = String(o.seenAt || o.seen_at || o.time || new Date().toISOString());
      const publicIp = String(o.publicIp || o.public_ip || o.dst || '').trim();
      const srcIp = String(o.srcIp || o.src_ip || o.src || '').trim();
      if (!publicIp && !srcIp) return null;
      return {
        seenAt,
        srcIp,
        srcPort: o.srcPort != null ? Number(o.srcPort) : o.src_port != null ? Number(o.src_port) : null,
        publicIp,
        publicPort: o.publicPort != null ? Number(o.publicPort) : o.public_port != null ? Number(o.public_port) : null,
        dstIp: String(o.dstIp || o.dst_ip || ''),
        protocol: String(o.protocol || o.proto || ''),
        username: String(o.username || ''),
      };
    } catch {
      return null;
    }
  }
  const parts = raw.split(/\s+/);
  if (parts.length < 2) return null;
  let seenAt = new Date().toISOString();
  let rest = parts;
  if (/^\d{4}-\d{2}-\d{2}/.test(parts[0]) || /^\d{10,}$/.test(parts[0])) {
    seenAt = /^\d{10,}$/.test(parts[0]) ? new Date(Number(parts[0]) * 1000).toISOString() : parts[0];
    rest = parts.slice(1);
  }
  const splitHost = (token: string) => {
    const m = token.match(/^([0-9a-fA-F:.]+):(\d+)$/);
    if (!m) return { ip: token, port: null as number | null };
    return { ip: m[1], port: Number(m[2]) };
  };
  const src = splitHost(rest[0] || '');
  const pub = splitHost(rest[1] || '');
  if (!src.ip && !pub.ip) return null;
  const third = rest[2] || '';
  const protocol = third && !/^\d/.test(third) ? third : '';
  const fourth = rest[3] || '';
  const username = fourth && !fourth.includes('.') ? fourth : '';
  const dstIp = username ? rest[4] || '' : fourth.includes('.') ? fourth : '';
  return {
    seenAt,
    srcIp: src.ip,
    srcPort: src.port,
    publicIp: pub.ip,
    publicPort: pub.port,
    dstIp,
    protocol,
    username,
  };
}

function daysPast(due: string | null): number | null {
  if (!due) return null;
  const d = Date.parse(`${String(due).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(d)) return null;
  return Math.floor((Date.now() - d) / 86400000);
}

export function subscriberHub(id: number) {
  const user = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!user) return null;
  const nap = user.nap_id
    ? db.prepare('SELECT id, name, kind, ports, parent_id FROM naps WHERE id = ?').get(user.nap_id)
    : null;
  const payments = db
    .prepare(
      `SELECT id, amount, method, cashier_username, or_number, note, extend_months, reversed_at, created_at
       FROM isp_payments WHERE pppoe_user_id = ? ORDER BY id DESC LIMIT 12`
    )
    .all(id);
  const sales = db
    .prepare(
      `SELECT id, amount, type, created_at FROM transactions WHERE pppoe_user_id = ? ORDER BY id DESC LIMIT 8`
    )
    .all(id);
  const jobs = db
    .prepare(
      `SELECT id, number, type, status, assigned_to, scheduled_at, due_at, onu_serial, completed_at
       FROM job_orders WHERE pppoe_user_id = ? ORDER BY id DESC LIMIT 8`
    )
    .all(id);
  const invoices = db
    .prepare(
      `SELECT id, number, amount, amount_paid, status, due_date FROM invoices
       WHERE pppoe_user_id = ? ORDER BY id DESC LIMIT 8`
    )
    .all(id);
  const sessions = db
    .prepare(
      `SELECT id, framed_ip, mac, started_at, stopped_at, router_name FROM session_history
       WHERE pppoe_user_id = ? OR username = ? ORDER BY id DESC LIMIT 8`
    )
    .all(id, String(user.username || ''));
  return {
    user,
    nap,
    daysPastDue: daysPast(user.subscription_due as string | null),
    payments,
    sales,
    jobs,
    invoices,
    sessions,
  };
}

export function recordIspPayment(body: {
  pppoeUserId: number;
  amount: number;
  method?: string;
  cashier?: string;
  note?: string;
  extendMonths?: number;
}) {
  const user = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(body.pppoeUserId) as {
    id: number;
    customer_name: string;
    username: string;
    subscription_due: string;
  } | undefined;
  if (!user) throw new Error('subscriber-not-found');
  const amount = Number(body.amount);
  if (!(amount > 0)) throw new Error('amount-required');
  const months = Math.max(0, Math.min(24, Number(body.extendMonths) || 0));
  const orNumber = nextOfficialReceipt();
  const info = db
    .prepare(
      `INSERT INTO isp_payments
       (pppoe_user_id, customer_name, amount, method, cashier_username, or_number, note, extend_months)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      user.id,
      user.customer_name || user.username,
      amount,
      body.method || 'cash',
      body.cashier || null,
      orNumber,
      body.note || null,
      months
    );
  db.prepare(
    `INSERT INTO transactions (pppoe_user_id, customer_name, amount, type, receipt_json)
     VALUES (?, ?, ?, 'payment', ?)`
  ).run(
    user.id,
    user.customer_name || user.username,
    amount,
    JSON.stringify({ or: orNumber, method: body.method || 'cash', cashier: body.cashier || null, partial: true })
  );
  if (months > 0) {
    const due = addMonths(user.subscription_due, months);
    db.prepare(`UPDATE pppoe_users SET subscription_due = ?, status = 'Active' WHERE id = ?`).run(due, user.id);
  }
  return db.prepare('SELECT * FROM isp_payments WHERE id = ?').get(info.lastInsertRowid);
}

export function reverseIspPayment(id: number, reason: string, cashier: string) {
  const row = db.prepare('SELECT * FROM isp_payments WHERE id = ?').get(id) as {
    id: number;
    amount: number;
    reversed_at: string | null;
    pppoe_user_id: number;
    customer_name: string;
    or_number: string;
  } | undefined;
  if (!row) throw new Error('not-found');
  if (row.reversed_at) throw new Error('already-reversed');
  db.prepare(
    `UPDATE isp_payments SET reversed_at = datetime('now'), reverse_reason = ? WHERE id = ?`
  ).run(reason || 'reversal', id);
  db.prepare(
    `INSERT INTO transactions (pppoe_user_id, customer_name, amount, type, receipt_json)
     VALUES (?, ?, ?, 'reversal', ?)`
  ).run(row.pppoe_user_id, row.customer_name, -Math.abs(Number(row.amount) || 0), JSON.stringify({ or: row.or_number, cashier, reason }));
  return db.prepare('SELECT * FROM isp_payments WHERE id = ?').get(id);
}

export function agingList() {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.customer_name, u.account_number, u.contact, u.price, u.status,
              u.subscription_due, u.nap_id, n.name AS nap_name
       FROM pppoe_users u
       LEFT JOIN naps n ON n.id = u.nap_id
       WHERE u.subscription_due IS NOT NULL AND trim(u.subscription_due) != ''
       ORDER BY u.subscription_due`
    )
    .all() as { subscription_due: string; status: string }[];
  return rows
    .map((r) => ({ ...r, daysPastDue: daysPast(r.subscription_due) }))
    .filter((r) => (r.daysPastDue ?? -1) >= 0 && String(r.status || '').toLowerCase() !== 'disconnected');
}

export function napDispatch() {
  return db
    .prepare(
      `SELECT n.id, n.name, n.ports, n.kind,
              (SELECT COUNT(*) FROM pppoe_users u WHERE u.nap_id = n.id) AS fill_count,
              (SELECT COUNT(*) FROM pppoe_users u WHERE u.nap_id = n.id AND COALESCE(u.online, 1) = 0) AS offline_count,
              (SELECT COUNT(*) FROM job_orders j
                 JOIN pppoe_users u ON u.id = j.pppoe_user_id
                WHERE u.nap_id = n.id AND j.status IN ('open','in_progress','follow_up')) AS open_jobs
       FROM naps n
       WHERE COALESCE(n.kind, 'nap') = 'nap'
       ORDER BY offline_count DESC, open_jobs DESC, n.name`
    )
    .all();
}

export function financeDesk() {
  const byCashier = db
    .prepare(
      `SELECT COALESCE(cashier_username, 'unassigned') AS cashier,
              SUM(amount) AS total, COUNT(*) AS tickets
       FROM isp_payments
       WHERE reversed_at IS NULL AND date(created_at) = date('now')
       GROUP BY cashier_username
       ORDER BY total DESC`
    )
    .all();
  const byArea = db
    .prepare(
      `SELECT COALESCE(n.name, 'No NAP') AS area, SUM(p.amount) AS total, COUNT(*) AS tickets
       FROM isp_payments p
       LEFT JOIN pppoe_users u ON u.id = p.pppoe_user_id
       LEFT JOIN naps n ON n.id = u.nap_id
       WHERE p.reversed_at IS NULL AND date(p.created_at) = date('now')
       GROUP BY area
       ORDER BY total DESC`
    )
    .all();
  const installs = db
    .prepare(
      `SELECT COUNT(*) AS c FROM job_orders
       WHERE type = 'new_install' AND status = 'completed'
         AND date(COALESCE(completed_at, updated_at)) >= date('now', 'start of month')`
    )
    .get() as { c: number };
  const disconnected = db
    .prepare(
      `SELECT COUNT(*) AS c FROM pppoe_users
       WHERE lower(COALESCE(status,'')) IN ('disconnected','disabled','expired')
         AND subscription_due IS NOT NULL
         AND date(subscription_due) >= date('now', 'start of month')
         AND date(subscription_due) <= date('now')`
    )
    .get() as { c: number };
  return { byCashier, byArea, churn: { newInstallsThisMonth: installs.c, lapsedThisMonth: disconnected.c } };
}

export async function broadcastArea(opts: { napId?: number; pon?: string; message: string }) {
  const msg = String(opts.message || '').trim();
  if (!msg) throw new Error('message-required');
  let ids: number[] = [];
  if (opts.napId) {
    ids = (
      db.prepare('SELECT id FROM pppoe_users WHERE nap_id = ? AND contact IS NOT NULL AND trim(contact) != \'\'').all(opts.napId) as { id: number }[]
    ).map((r) => r.id);
  } else if (opts.pon) {
    ids = (
      db
        .prepare(
          `SELECT id FROM pppoe_users WHERE plc_port = ? AND contact IS NOT NULL AND trim(contact) != ''`
        )
        .all(opts.pon) as { id: number }[]
    ).map((r) => r.id);
  }
  if (!ids.length) return { sent: 0, skipped: 0, targets: 0 };
  const result = await sendManual({
    channel: 'sms',
    target: 'selected',
    clientIds: ids,
    message: msg,
    subject: 'Area notice',
  });
  return { ...result, targets: ids.length };
}

export async function runIspDunning() {
  const s = getIspSettings();
  if (!s.dunning_enabled) return { sent: 0 };
  const warn = String(s.dunning_warn_days || '0,3')
    .split(/[,\s]+/)
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n >= 0);
  const users = db
    .prepare(
      `SELECT id, username, customer_name, contact, subscription_due, status
       FROM pppoe_users WHERE contact IS NOT NULL AND trim(contact) != ''`
    )
    .all() as {
    id: number;
    username: string;
    customer_name: string;
    contact: string;
    subscription_due: string;
    status: string;
  }[];
  let sent = 0;
  for (const u of users) {
    const days = daysPast(u.subscription_due);
    if (days == null || days < 0) continue;
    if (!warn.includes(days)) continue;
    const already = db
      .prepare(
        `SELECT id FROM notifications WHERE client_id = ? AND type = 'dunning' AND date(created_at) = date('now') LIMIT 1`
      )
      .get(u.id);
    if (already) continue;
    const message = String(s.dunning_message || '')
      .replaceAll('{name}', u.customer_name || u.username)
      .replaceAll('{username}', u.username)
      .replaceAll('{days}', String(days))
      .replaceAll('{disconnect}', String(s.dunning_disconnect_day || 7));
    await sendManual({
      channel: 'sms',
      target: 'client',
      clientId: u.id,
      message,
      subject: 'Payment reminder',
    });
    db.prepare(
      `UPDATE notifications SET type = 'dunning' WHERE id = (
         SELECT id FROM notifications WHERE client_id = ? ORDER BY id DESC LIMIT 1
       )`
    ).run(u.id);
    sent += 1;
  }
  return { sent };
}

export function insertCgnat(entry: CgnatEntry, raw: string) {
  let subscriberId: number | null = null;
  let username = entry.username;
  if (!username && entry.srcIp) {
    const hit = db
      .prepare(
        `SELECT pppoe_user_id AS id, username FROM session_history
         WHERE framed_ip = ? ORDER BY id DESC LIMIT 1`
      )
      .get(entry.srcIp) as { id: number; username: string } | undefined;
    if (hit) {
      subscriberId = hit.id;
      username = hit.username;
    }
  } else if (username) {
    const u = db.prepare('SELECT id FROM pppoe_users WHERE username = ?').get(username) as { id: number } | undefined;
    subscriberId = u?.id ?? null;
  }
  db.prepare(
    `INSERT INTO cgnat_logs
     (seen_at, src_ip, src_port, public_ip, public_port, dst_ip, protocol, subscriber_id, username, raw)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    entry.seenAt,
    entry.srcIp || null,
    entry.srcPort,
    entry.publicIp || null,
    entry.publicPort,
    entry.dstIp || null,
    entry.protocol || null,
    subscriberId,
    username || null,
    raw.slice(0, 500)
  );
}

export function searchCgnat(q: { publicIp?: string; srcIp?: string; at?: string }) {
  const where: string[] = [];
  const args: string[] = [];
  if (q.publicIp) {
    where.push('public_ip = ?');
    args.push(q.publicIp);
  }
  if (q.srcIp) {
    where.push('src_ip = ?');
    args.push(q.srcIp);
  }
  if (q.at) {
    where.push('seen_at <= ?');
    args.push(q.at);
  }
  const sql = `SELECT * FROM cgnat_logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seen_at DESC LIMIT 100`;
  return db.prepare(sql).all(...args);
}

export function searchSessions(q: { ip?: string; username?: string; at?: string }) {
  const where: string[] = [];
  const args: string[] = [];
  if (q.ip) {
    where.push('framed_ip = ?');
    args.push(q.ip);
  }
  if (q.username) {
    where.push('username = ?');
    args.push(q.username);
  }
  if (q.at) {
    where.push('(started_at IS NULL OR started_at <= ?) AND (stopped_at IS NULL OR stopped_at >= ?)');
    args.push(q.at, q.at);
  }
  const sql = `SELECT * FROM session_history ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 100`;
  return db.prepare(sql).all(...args);
}

export function radiusExport(): string {
  const s = getIspSettings();
  const users = db
    .prepare(
      `SELECT username, password, profile, status FROM pppoe_users
       WHERE COALESCE(service,'pppoe') = 'pppoe' AND lower(COALESCE(status,'active')) = 'active'`
    )
    .all() as { username: string; password: string; profile: string }[];
  const lines = [
    `# MT-Billing RADIUS users — branch ${s.branch_name || 'Main'}`,
    `# NAS ${s.radius_nas_ip || 'set radius_nas_ip in ISP settings'}`,
  ];
  for (const u of users) {
    const secret = String(u.password || '').replace(/"/g, '');
    lines.push(`${u.username} Cleartext-Password := "${secret}"`);
    lines.push(`    Mikrotik-Group := "${u.profile || 'default'}",`);
    lines.push('');
  }
  return lines.join('\n');
}

export function publicAreaStatus() {
  const s = getIspSettings();
  const outages = db
    .prepare(
      `SELECT o.id, o.title, o.detail, o.status, o.eta, o.pon, o.created_at, n.name AS nap_name
       FROM area_outages o
       LEFT JOIN naps n ON n.id = o.nap_id
       WHERE o.status = 'open'
       ORDER BY o.id DESC`
    )
    .all();
  return { branch: s.branch_name || 'Main', outages, updatedAt: new Date().toISOString() };
}

/** When a job is first completed, deduct listed stock and store the ONU serial on the subscriber. */
export function finalizeJobOrder(id: number, previousStatus: string) {
  const job = db.prepare('SELECT * FROM job_orders WHERE id = ?').get(id) as {
    status: string;
    stock_applied: number;
    materials_json: string | null;
    onu_serial: string | null;
    pppoe_user_id: number | null;
  } | undefined;
  if (!job) return;
  if (previousStatus === 'completed' || job.status !== 'completed') return;
  if (job.onu_serial && job.pppoe_user_id) {
    db.prepare(`UPDATE pppoe_users SET onu_serial = ?, online = 1 WHERE id = ?`).run(job.onu_serial, job.pppoe_user_id);
  }
  if (job.stock_applied) return;
  let items: { inventoryId?: number; qty?: number }[] = [];
  try {
    items = job.materials_json ? (JSON.parse(job.materials_json) as { inventoryId?: number; qty?: number }[]) : [];
  } catch {
    items = [];
  }
  const tx = db.transaction(() => {
    for (const item of items) {
      const invId = Number(item.inventoryId);
      const qty = Math.max(0, Number(item.qty) || 0);
      if (!invId || !qty) continue;
      db.prepare('UPDATE inventory SET quantity = MAX(0, COALESCE(quantity,0) - ?) WHERE id = ?').run(qty, invId);
    }
    db.prepare('UPDATE job_orders SET stock_applied = 1 WHERE id = ?').run(id);
  });
  if (items.length) tx();
  else db.prepare('UPDATE job_orders SET stock_applied = 1 WHERE id = ?').run(id);
}

export async function cpeAction(
  subscriberId: number,
  body: { action: string; ssid?: string; password?: string }
) {
  const user = db.prepare('SELECT acs_device_id, username FROM pppoe_users WHERE id = ?').get(subscriberId) as
    | { acs_device_id: string | null; username: string }
    | undefined;
  if (!user?.acs_device_id) throw new Error('cpe-not-linked');
  const id = user.acs_device_id;
  if (body.action === 'reboot') return rebootAcsDevice(id);
  if (body.action === 'refresh') return refreshAcsDevice(id);
  if (body.action === 'wifi') {
    const values: [string, string, string][] = [];
    if (body.ssid) values.push(['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID', body.ssid, 'xsd:string']);
    if (body.password) {
      values.push([
        'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase',
        body.password,
        'xsd:string',
      ]);
    }
    if (!values.length) throw new Error('ssid-or-password-required');
    return setAcsParameterValues(id, values);
  }
  throw new Error('unknown-action');
}

let dunningTimer: NodeJS.Timeout | null = null;
export function startIspDunningScheduler(intervalMs = 60 * 60 * 1000) {
  if (dunningTimer) return;
  dunningTimer = setInterval(() => {
    void runIspDunning().catch(() => undefined);
  }, intervalMs);
  if (typeof dunningTimer.unref === 'function') dunningTimer.unref();
}

export const ispDeskRouter = express.Router();

ispDeskRouter.get('/isp/settings', (_req, res) => {
  res.json(getIspSettings());
});

ispDeskRouter.put('/isp/settings', (req, res) => {
  const b = req.body || {};
  const cur = getIspSettings();
  db.prepare(
    `UPDATE isp_settings SET
       branch_name = ?, bir_or_prefix = ?, radius_nas_ip = ?,
       dunning_enabled = ?, dunning_warn_days = ?, dunning_disconnect_day = ?, dunning_message = ?
     WHERE id = 1`
  ).run(
    b.branchName != null ? String(b.branchName) : cur.branch_name,
    b.birOrPrefix != null ? String(b.birOrPrefix) : cur.bir_or_prefix,
    b.radiusNasIp != null ? String(b.radiusNasIp) : cur.radius_nas_ip,
    b.dunningEnabled != null ? (b.dunningEnabled ? 1 : 0) : cur.dunning_enabled,
    b.dunningWarnDays != null ? String(b.dunningWarnDays) : cur.dunning_warn_days,
    b.dunningDisconnectDay != null ? Number(b.dunningDisconnectDay) : cur.dunning_disconnect_day,
    b.dunningMessage != null ? String(b.dunningMessage) : cur.dunning_message
  );
  res.json(getIspSettings());
});

ispDeskRouter.get('/isp/subscribers/:id', (req, res) => {
  const hub = subscriberHub(Number(req.params.id));
  if (!hub) return res.status(404).json({ error: 'subscriber-not-found' });
  res.json(hub);
});

ispDeskRouter.get('/isp/subscribers', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const like = `%${q.replace(/[%_]/g, '')}%`;
  const rows = db
    .prepare(
      `SELECT id, username, customer_name, account_number, status, subscription_due, nap_id
       FROM pppoe_users
       WHERE customer_name LIKE ? COLLATE NOCASE OR username LIKE ? COLLATE NOCASE OR account_number LIKE ?
       ORDER BY customer_name LIMIT 30`
    )
    .all(like, like, like);
  res.json(rows);
});

ispDeskRouter.post('/isp/subscribers/:id/cpe', async (req, res) => {
  try {
    const out = await cpeAction(Number(req.params.id), req.body || {});
    res.json({ ok: true, result: out });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'cpe-action-failed';
    res.status(msg === 'cpe-not-linked' ? 400 : 502).json({ error: msg });
  }
});

ispDeskRouter.post('/isp/payments', (req, res) => {
  try {
    const cashier = String((req as express.Request & { user?: { username?: string } }).user?.username || req.body?.cashier || '');
    res.status(201).json(
      recordIspPayment({
        pppoeUserId: Number(req.body?.pppoeUserId),
        amount: Number(req.body?.amount),
        method: req.body?.method,
        cashier,
        note: req.body?.note,
        extendMonths: req.body?.extendMonths,
      })
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'payment-failed';
    res.status(msg === 'subscriber-not-found' ? 404 : 400).json({ error: msg });
  }
});

ispDeskRouter.post('/isp/payments/:id/reverse', (req, res) => {
  try {
    const cashier = String((req as express.Request & { user?: { username?: string } }).user?.username || '');
    res.json(reverseIspPayment(Number(req.params.id), String(req.body?.reason || ''), cashier));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'reverse-failed';
    res.status(msg === 'not-found' ? 404 : 400).json({ error: msg });
  }
});

ispDeskRouter.get('/isp/aging', (_req, res) => {
  res.json(agingList());
});

ispDeskRouter.post('/isp/dunning/run', async (_req, res) => {
  res.json(await runIspDunning());
});

ispDeskRouter.get('/isp/cashier-close', (req, res) => {
  const date = String(req.query.date || new Date().toISOString().slice(0, 10));
  const cashier = String(req.query.cashier || '');
  const rows = db
    .prepare(
      `SELECT * FROM isp_payments
       WHERE reversed_at IS NULL AND date(created_at) = date(?)
         AND (? = '' OR cashier_username = ?)
       ORDER BY id`
    )
    .all(date, cashier, cashier);
  const closes = db.prepare('SELECT * FROM cashier_closes ORDER BY id DESC LIMIT 14').all();
  res.json({ payments: rows, closes });
});

ispDeskRouter.post('/isp/cashier-close', (req, res) => {
  const cashier = String(
    (req as express.Request & { user?: { username?: string } }).user?.username || req.body?.cashier || 'cashier'
  );
  const date = String(req.body?.businessDate || new Date().toISOString().slice(0, 10));
  const totals = db
    .prepare(
      `SELECT method, SUM(amount) AS total FROM isp_payments
       WHERE reversed_at IS NULL AND cashier_username = ? AND date(created_at) = date(?)
       GROUP BY method`
    )
    .all(cashier, date) as { method: string; total: number }[];
  let cash = 0;
  let gcash = 0;
  let other = 0;
  for (const t of totals) {
    const m = String(t.method || '').toLowerCase();
    if (m === 'cash') cash += Number(t.total) || 0;
    else if (m.includes('gcash') || m.includes('maya')) gcash += Number(t.total) || 0;
    else other += Number(t.total) || 0;
  }
  const info = db
    .prepare(
      `INSERT INTO cashier_closes (cashier_username, business_date, cash_total, gcash_total, other_total, note)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(cashier, date, cash, gcash, other, req.body?.note || null);
  res.status(201).json(db.prepare('SELECT * FROM cashier_closes WHERE id = ?').get(info.lastInsertRowid));
});

ispDeskRouter.get('/isp/nap-dispatch', (_req, res) => {
  res.json(napDispatch());
});

ispDeskRouter.post('/isp/broadcast', async (req, res) => {
  try {
    res.json(
      await broadcastArea({
        napId: req.body?.napId != null ? Number(req.body.napId) : undefined,
        pon: req.body?.pon != null ? String(req.body.pon) : undefined,
        message: String(req.body?.message || ''),
      })
    );
  } catch (e: unknown) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'broadcast-failed' });
  }
});

ispDeskRouter.get('/isp/finance', (_req, res) => {
  res.json(financeDesk());
});

ispDeskRouter.post('/isp/cgnat', (req, res) => {
  const lines: string[] = Array.isArray(req.body?.lines) ? req.body.lines.map(String) : [];
  if (req.body?.line) lines.push(String(req.body.line));
  let stored = 0;
  for (const line of lines) {
    const entry = parseCgnatLine(line);
    if (!entry) continue;
    insertCgnat(entry, line);
    stored += 1;
  }
  res.json({ stored });
});

ispDeskRouter.get('/isp/cgnat', (req, res) => {
  res.json(
    searchCgnat({
      publicIp: req.query.publicIp ? String(req.query.publicIp) : undefined,
      srcIp: req.query.srcIp ? String(req.query.srcIp) : undefined,
      at: req.query.at ? String(req.query.at) : undefined,
    })
  );
});

ispDeskRouter.post('/isp/sessions', (req, res) => {
  const b = req.body || {};
  const info = db
    .prepare(
      `INSERT INTO session_history (pppoe_user_id, username, framed_ip, mac, started_at, stopped_at, router_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      b.pppoeUserId || null,
      b.username || null,
      b.framedIp || b.ip || null,
      b.mac || null,
      b.startedAt || new Date().toISOString(),
      b.stoppedAt || null,
      b.routerName || null
    );
  res.status(201).json(db.prepare('SELECT * FROM session_history WHERE id = ?').get(info.lastInsertRowid));
});

ispDeskRouter.get('/isp/sessions', (req, res) => {
  res.json(
    searchSessions({
      ip: req.query.ip ? String(req.query.ip) : undefined,
      username: req.query.username ? String(req.query.username) : undefined,
      at: req.query.at ? String(req.query.at) : undefined,
    })
  );
});

ispDeskRouter.get('/isp/radius-users', (_req, res) => {
  res.type('text/plain').send(radiusExport());
});

ispDeskRouter.get('/isp/outages', (_req, res) => {
  res.json(db.prepare('SELECT * FROM area_outages ORDER BY id DESC LIMIT 50').all());
});

ispDeskRouter.post('/isp/outages', (req, res) => {
  const title = String(req.body?.title || '').trim();
  if (!title) return res.status(400).json({ error: 'title-required' });
  const info = db
    .prepare(
      `INSERT INTO area_outages (nap_id, pon, title, detail, status, eta) VALUES (?, ?, ?, ?, 'open', ?)`
    )
    .run(req.body?.napId || null, req.body?.pon || null, title, req.body?.detail || null, req.body?.eta || null);
  res.status(201).json(db.prepare('SELECT * FROM area_outages WHERE id = ?').get(info.lastInsertRowid));
});

ispDeskRouter.post('/isp/outages/:id/clear', (req, res) => {
  db.prepare(`UPDATE area_outages SET status = 'cleared', cleared_at = datetime('now') WHERE id = ?`).run(
    Number(req.params.id)
  );
  res.json(db.prepare('SELECT * FROM area_outages WHERE id = ?').get(Number(req.params.id)));
});

export const publicIspRouter = express.Router();
publicIspRouter.get('/public/area-status', (_req, res) => {
  res.json(publicAreaStatus());
});
