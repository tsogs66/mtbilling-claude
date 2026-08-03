/**
 * Subscriber-portal extras: activity feed, NAP-targeted outage notices,
 * contact OTP, plan cancel, grace/reconnect, add-ons, ticket threads,
 * payment history/receipts, reminders, usage snapshot, referrals, tech visits.
 */
import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { db } from './db.js';
import { notifyClientChannels } from './notify.js';
import { notifyStaff, subscriberLabel } from './staffNotifications.js';
import { publishPortalEvent } from './portalEvents.js';
import { getSubscriberUsageDetail } from './usage.js';

function columnExists(table: string, col: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return rows.some((r) => r.name === col);
  } catch {
    return false;
  }
}

function portalUserFromToken(token: string): any | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.token, s.expires_at, u.id AS uid, u.username, u.customer_name, u.account_number,
              u.status, u.subscription_due, u.profile, u.price, u.contact, u.email, u.address,
              u.portal_must_change_password, u.nap_id, u.nonpayment_since, u.online, u.router_id
       FROM client_portal_sessions s
       JOIN pppoe_users u ON u.id = s.pppoe_user_id
       WHERE s.token = ?`
    )
    .get(token) as any;
  if (!row) return null;
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    db.prepare('DELETE FROM client_portal_sessions WHERE token = ?').run(token);
    return null;
  }
  return row;
}

function requirePortal(req: Request, res: Response): any | null {
  const token = String(
    req.headers['x-portal-token'] || (req.body as any)?.token || req.query.token || ''
  );
  const sess = portalUserFromToken(token);
  if (!sess) {
    res.status(401).json({ error: 'Session expired' });
    return null;
  }
  if (Number(sess.portal_must_change_password) === 1) {
    res.status(403).json({ error: 'Password change required', mustChangePassword: true });
    return null;
  }
  return sess;
}

/** Persist an in-portal activity item for a subscriber. */
export function pushPortalActivity(opts: {
  pppoeUserId: number;
  type: string;
  title: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: number | null;
  payload?: Record<string, unknown> | null;
}) {
  try {
    const info = db
      .prepare(
        `INSERT INTO portal_activity
           (pppoe_user_id, type, title, body, entity_type, entity_id, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        opts.pppoeUserId,
        opts.type,
        opts.title,
        opts.body || null,
        opts.entityType || null,
        opts.entityId ?? null,
        opts.payload ? JSON.stringify(opts.payload) : null
      );
    publishPortalEvent({
      type: 'portal_activity',
      action: 'created',
      entityType: opts.entityType || 'portal_activity',
      entityId: Number(info.lastInsertRowid),
      pppoeUserId: opts.pppoeUserId,
      status: null,
      title: opts.title,
      body: opts.body || null,
      payload: { activityType: opts.type, ...(opts.payload || {}) },
    });
  } catch (e) {
    console.warn('[portalExtras] pushPortalActivity failed', e);
  }
}

export function initPortalExtras() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS portal_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pppoe_user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      entity_type TEXT,
      entity_id INTEGER,
      payload TEXT,
      read_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_portal_activity_user
      ON portal_activity(pppoe_user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS portal_otp_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pppoe_user_id INTEGER NOT NULL,
      purpose TEXT NOT NULL,
      channel TEXT NOT NULL,
      target TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS portal_reminder_prefs (
      pppoe_user_id INTEGER PRIMARY KEY,
      due_reminder_enabled INTEGER NOT NULL DEFAULT 1,
      due_reminder_days INTEGER NOT NULL DEFAULT 3,
      sms_enabled INTEGER NOT NULL DEFAULT 1,
      email_enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS network_outage_notices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      nap_ids TEXT NOT NULL,
      channels TEXT NOT NULL DEFAULT '["sms"]',
      status TEXT NOT NULL DEFAULT 'draft',
      recipient_count INTEGER DEFAULT 0,
      created_by TEXT,
      sent_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS job_order_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_order_id INTEGER NOT NULL,
      author_role TEXT NOT NULL,
      author_name TEXT,
      body TEXT NOT NULL,
      attachment_path TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_jo_messages_job
      ON job_order_messages(job_order_id, id);

    CREATE TABLE IF NOT EXISTS portal_addon_catalog (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS portal_addon_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pppoe_user_id INTEGER NOT NULL,
      addon_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT,
      review_note TEXT,
      reviewed_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS portal_reconnect_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pppoe_user_id INTEGER NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      review_note TEXT,
      reviewed_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS portal_referrals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      referrer_pppoe_user_id INTEGER NOT NULL,
      code TEXT UNIQUE NOT NULL,
      referred_name TEXT,
      referred_contact TEXT,
      referred_address TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  for (const [col, type] of [
    ['referral_code', 'TEXT'],
  ] as [string, string][]) {
    if (!columnExists('pppoe_users', col)) {
      try {
        db.exec(`ALTER TABLE pppoe_users ADD COLUMN ${col} ${type}`);
      } catch {
        /* ignore */
      }
    }
  }

  const defaults = [
    ['mesh-node', 'Mesh / extender', 'Extra Wi‑Fi mesh node or extender install.', 0],
    ['boost-7d', '7-day speed boost', 'Temporary higher speed profile for 7 days.', 150],
  ] as const;
  const ins = db.prepare(
    `INSERT OR IGNORE INTO portal_addon_catalog (code, name, description, price, active)
     VALUES (?, ?, ?, ?, 1)`
  );
  for (const [code, name, description, price] of defaults) {
    ins.run(code, name, description, price);
  }
  // Remove Static IP from the subscriber add-on request catalog.
  try {
    db.prepare(`UPDATE portal_addon_catalog SET active = 0 WHERE code = 'static-ip'`).run();
  } catch {
    /* ignore */
  }
}

function savePortalAttachment(dataUrl: string | undefined | null, prefix: string): string | null {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
  const m = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) throw new Error('Invalid image format');
  const mime = m[1].toLowerCase();
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 6 * 1024 * 1024) throw new Error('Image must be 6MB or smaller');
  const dir = path.resolve(process.cwd(), 'data', 'portal-attachments');
  fs.mkdirSync(dir, { recursive: true });
  const file = `${prefix}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(dir, file), buf);
  return `portal-attachments/${file}`;
}

function ensureReferralCode(uid: number): string {
  const row = db.prepare('SELECT referral_code FROM pppoe_users WHERE id = ?').get(uid) as
    | { referral_code?: string }
    | undefined;
  if (row?.referral_code) return row.referral_code;
  const code = `PR-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  try {
    db.prepare('UPDATE pppoe_users SET referral_code = ? WHERE id = ?').run(code, uid);
  } catch {
    /* column may be missing on very old DBs */
  }
  return code;
}

function otpRateOk(uid: number, purpose: string): boolean {
  const recent = db
    .prepare(
      `SELECT COUNT(*) AS c FROM portal_otp_codes
       WHERE pppoe_user_id = ? AND purpose = ?
         AND datetime(created_at) > datetime('now', '-10 minutes')`
    )
    .get(uid, purpose) as { c: number };
  return Number(recent?.c || 0) < 3;
}

/** Register extra portal + staff routes onto existing routers. */
export function registerPortalExtraRoutes(publicPortalRouter: Router, ispOpsRouter: Router) {
  // Serve ticket / portal image attachments by stored relative path.
  publicPortalRouter.get('/public/portal/attachment', (req, res) => {
    const sess = requirePortal(req, res);
    if (!sess) return;
    const rel = String(req.query.path || '').replace(/^\/+/, '');
    if (!rel.startsWith('portal-attachments/') || rel.includes('..')) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    const full = path.resolve(process.cwd(), 'data', rel);
    const root = path.resolve(process.cwd(), 'data', 'portal-attachments');
    if (!full.startsWith(root) || !fs.existsSync(full)) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.sendFile(full);
  });

  // ── Activity feed ─────────────────────────────────────────────────────────
  publicPortalRouter.get('/public/portal/activity', (req, res) => {
    const sess = requirePortal(req, res);
    if (!sess) return;
    const rows = db
      .prepare(
        `SELECT id, type, title, body, entity_type AS entityType, entity_id AS entityId,
                read_at AS readAt, created_at AS createdAt, payload
         FROM portal_activity
         WHERE pppoe_user_id = ?
         ORDER BY id DESC LIMIT 40`
      )
      .all(sess.uid)
      .map((r: any) => {
        let payload = null;
        try {
          payload = r.payload ? JSON.parse(r.payload) : null;
        } catch {
          payload = null;
        }
        return { ...r, payload };
      });
    const unread = (rows as any[]).filter((r) => !r.readAt).length;
    res.json({ items: rows, unread });
  });

  publicPortalRouter.post('/public/portal/activity/read', (req, res) => {
    const sess = requirePortal(req, res);
    if (!sess) return;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
    if (ids.length) {
      const stmt = db.prepare(
        `UPDATE portal_activity SET read_at = datetime('now')
         WHERE pppoe_user_id = ? AND id = ? AND read_at IS NULL`
      );
      const tx = db.transaction(() => {
        for (const id of ids) stmt.run(sess.uid, id);
      });
      tx();
    } else {
      db.prepare(
        `UPDATE portal_activity SET read_at = datetime('now')
         WHERE pppoe_user_id = ? AND read_at IS NULL`
      ).run(sess.uid);
    }
    res.json({ ok: true });
  });

  // ── Connection / usage snapshot ───────────────────────────────────────────
  publicPortalRouter.get('/public/portal/connection', async (req, res) => {
    const sess = requirePortal(req, res);
    if (!sess) return;
    try {
      const detail = await getSubscriberUsageDetail(sess.username, { days: 7, hours: 6 });
      const nap = sess.nap_id
        ? (db.prepare(`SELECT id, name, code, status FROM naps WHERE id = ?`).get(sess.nap_id) as any)
        : null;
      res.json({
        online: Boolean(detail?.live?.online ?? sess.online),
        address: detail?.live?.address || null,
        uptime: detail?.live?.uptime || null,
        downloadBps: detail?.live?.downloadBps || 0,
        uploadBps: detail?.live?.uploadBps || 0,
        nap: nap ? { id: nap.id, name: nap.name, code: nap.code || null, status: nap.status || null } : null,
        history: (detail?.history || []).slice(-7),
      });
    } catch (e: any) {
      res.json({
        online: Boolean(sess.online),
        address: null,
        uptime: null,
        downloadBps: 0,
        uploadBps: 0,
        nap: null,
        history: [],
        note: e?.message || 'Usage unavailable',
      });
    }
  });

  // ── Reminder prefs ────────────────────────────────────────────────────────
  publicPortalRouter.get('/public/portal/reminders', (req, res) => {
    const sess = requirePortal(req, res);
    if (!sess) return;
    const row =
      (db
        .prepare(
          `SELECT due_reminder_enabled AS dueReminderEnabled, due_reminder_days AS dueReminderDays,
                  sms_enabled AS smsEnabled, email_enabled AS emailEnabled
           FROM portal_reminder_prefs WHERE pppoe_user_id = ?`
        )
        .get(sess.uid) as any) || {
        dueReminderEnabled: 1,
        dueReminderDays: 3,
        smsEnabled: 1,
        emailEnabled: 1,
      };
    res.json({
      prefs: {
        dueReminderEnabled: Number(row.dueReminderEnabled) === 1,
        dueReminderDays: Number(row.dueReminderDays) || 3,
        smsEnabled: Number(row.smsEnabled) === 1,
        emailEnabled: Number(row.emailEnabled) === 1,
      },
    });
  });

  publicPortalRouter.put('/public/portal/reminders', (req, res) => {
    const sess = requirePortal(req, res);
    if (!sess) return;
    const days = Math.max(1, Math.min(14, Number(req.body?.dueReminderDays) || 3));
    db.prepare(
      `INSERT INTO portal_reminder_prefs
         (pppoe_user_id, due_reminder_enabled, due_reminder_days, sms_enabled, email_enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(pppoe_user_id) DO UPDATE SET
         due_reminder_enabled = excluded.due_reminder_enabled,
         due_reminder_days = excluded.due_reminder_days,
         sms_enabled = excluded.sms_enabled,
         email_enabled = excluded.email_enabled,
         updated_at = datetime('now')`
    ).run(
      sess.uid,
      req.body?.dueReminderEnabled === false ? 0 : 1,
      days,
      req.body?.smsEnabled === false ? 0 : 1,
      req.body?.emailEnabled === false ? 0 : 1
    );
    res.json({ ok: true });
  });

  // ── Contact OTP update ────────────────────────────────────────────────────
  publicPortalRouter.post('/public/portal/contact/request-otp', async (req, res) => {
    const sess = requirePortal(req, res);
    if (!sess) return;
    const channel = String(req.body?.channel || 'sms') === 'email' ? 'email' : 'sms';
    const target = String(req.body?.target || '').trim();
    if (!target) return res.status(400).json({ error: 'Enter the new phone or email' });
    if (channel === 'sms' && target.replace(/\D/g, '').length < 10) {
      return res.status(400).json({ error: 'Enter a valid phone number' });
    }
    if (channel === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) {
      return res.status(400).json({ error: 'Enter a valid email' });
    }
    if (!otpRateOk(sess.uid, 'contact_update')) {
      return res.status(429).json({ error: 'Too many codes requested. Try again in a few minutes.' });
    }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO portal_otp_codes (pppoe_user_id, purpose, channel, target, code, expires_at)
       VALUES (?, 'contact_update', ?, ?, ?, ?)`
    ).run(sess.uid, channel, target, code, expires);

    const client = (db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(sess.uid) || {}) as Record<
      string,
      unknown
    >;
    const msg = `Your PANORTH verification code is ${code}. Valid for 15 minutes.`;
    try {
      if (channel === 'sms') {
        await notifyClientChannels(
          { ...client, contact: target },
          ['sms'],
          'Verification code',
          msg,
          'portal_otp'
        );
      } else {
        await notifyClientChannels(
          { ...client, email: target },
          ['email'],
          'Verification code',
          msg,
          'portal_otp'
        );
      }
    } catch {
      /* still return ok — code stored; staff can help */
    }
    res.json({ ok: true, expiresAt: expires });
  });

  publicPortalRouter.post('/public/portal/contact/verify', (req, res) => {
    const sess = requirePortal(req, res);
    if (!sess) return;
    const code = String(req.body?.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Enter the verification code' });
    const row = db
      .prepare(
        `SELECT * FROM portal_otp_codes
         WHERE pppoe_user_id = ? AND purpose = 'contact_update' AND consumed_at IS NULL
         ORDER BY id DESC LIMIT 1`
      )
      .get(sess.uid) as any;
    if (!row) return res.status(400).json({ error: 'No verification pending' });
    if (Date.parse(row.expires_at) < Date.now()) {
      return res.status(400).json({ error: 'Code expired — request a new one' });
    }
    if (String(row.code) !== code) return res.status(400).json({ error: 'Incorrect code' });

    if (row.channel === 'sms') {
      db.prepare('UPDATE pppoe_users SET contact = ? WHERE id = ?').run(row.target, sess.uid);
    } else {
      db.prepare('UPDATE pppoe_users SET email = ? WHERE id = ?').run(row.target, sess.uid);
    }
    db.prepare(`UPDATE portal_otp_codes SET consumed_at = datetime('now') WHERE id = ?`).run(row.id);
    pushPortalActivity({
      pppoeUserId: sess.uid,
      type: 'contact_updated',
      title: 'Contact updated',
      body: row.channel === 'sms' ? `Phone updated to ${row.target}` : `Email updated to ${row.target}`,
    });
    res.json({
      ok: true,
      customer: {
        contact: row.channel === 'sms' ? row.target : sess.contact,
        email: row.channel === 'email' ? row.target : sess.email,
      },
    });
  });

  // ── Cancel plan change ────────────────────────────────────────────────────
  publicPortalRouter.post('/public/portal/plan-change/cancel', (req, res) => {
    const sess = requirePortal(req, res);
    if (!sess) return;
    const pending = db
      .prepare(
        `SELECT id, to_plan FROM plan_change_requests
         WHERE pppoe_user_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1`
      )
      .get(sess.uid) as any;
    if (!pending) return res.status(404).json({ error: 'No pending plan change' });
    db.prepare(
      `UPDATE plan_change_requests
       SET status = 'cancelled', review_note = 'Cancelled by subscriber', reviewed_at = datetime('now')
       WHERE id = ?`
    ).run(pending.id);
    pushPortalActivity({
      pppoeUserId: sess.uid,
      type: 'plan_change',
      title: 'Plan change cancelled',
      body: `You cancelled the request to switch to ${pending.to_plan}.`,
      entityType: 'plan_change_request',
      entityId: pending.id,
    });
    notifyStaff({
      type: 'plan_change',
      title: 'Plan change cancelled',
      body: `${subscriberLabel(sess.uid)} cancelled request → ${pending.to_plan}`,
      entityType: 'plan_change_request',
      entityId: pending.id,
      pppoeUserId: sess.uid,
      status: 'cancelled',
    });
    res.json({ ok: true });
  });

  // ── Payment history + receipt ─────────────────────────────────────────────
  publicPortalRouter.get('/public/portal/payments', (req, res) => {
    const sess = requirePortal(req, res);
    if (!sess) return;
    const payments = db
      .prepare(
        `SELECT ip.id, ip.amount, ip.method, ip.note, ip.created_at AS paidAt, ip.transaction_id AS transactionId,
                i.number AS invoiceNumber, i.id AS invoiceId
         FROM invoice_payments ip
         JOIN invoices i ON i.id = ip.invoice_id
         WHERE i.pppoe_user_id = ?
         ORDER BY ip.id DESC LIMIT 40`
      )
      .all(sess.uid);
    const txPayments = db
      .prepare(
        `SELECT id AS transactionId, amount, type, created_at AS paidAt, receipt_json AS receiptJson
         FROM transactions WHERE pppoe_user_id = ? ORDER BY id DESC LIMIT 40`
      )
      .all(sess.uid);
    res.json({ invoicePayments: payments, transactions: txPayments });
  });

  publicPortalRouter.get('/public/portal/receipts/:txId', (req, res) => {
    const sess = requirePortal(req, res);
    if (!sess) return;
    const txId = Number(req.params.txId);
    const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId) as any;
    if (!tx || Number(tx.pppoe_user_id) !== Number(sess.uid)) {
      return res.status(404).json({ error: 'Receipt not found' });
    }
    let receipt: any = null;
    if (tx.receipt_json) {
      try {
        receipt = JSON.parse(tx.receipt_json);
      } catch {
        receipt = { raw: tx.receipt_json };
      }
    } else {
      receipt = {
        amount: tx.amount,
        type: tx.type,
        paidAt: tx.created_at,
        customer: sess.customer_name || sess.username,
        account: sess.account_number,
      };
    }
    res.json({ receipt, transactionId: txId });
  });

  // ── Add-ons / promos ──────────────────────────────────────────────────────
  publicPortalRouter.get('/public/portal/addons', (req, res) => {
    const sess = requirePortal(req, res);
    if (!sess) return;
    const catalog = db
      .prepare(
        `SELECT id, code, name, description, price FROM portal_addon_catalog WHERE active = 1 ORDER BY price, name`
      )
      .all();
    const pending = db
      .prepare(
        `SELECT r.id, r.status, r.note, r.created_at AS createdAt, a.name, a.price
         FROM portal_addon_requests r
         JOIN portal_addon_catalog a ON a.id = r.addon_id
         WHERE r.pppoe_user_id = ? AND r.status = 'pending'
         ORDER BY r.id DESC`
      )
      .all(sess.uid);
    res.json({ catalog, pending });
  });

  publicPortalRouter.post('/public/portal/addons/request', (req, res) => {
    const sess = requirePortal(req, res);
    if (!sess) return;
    const addonId = Number(req.body?.addonId);
    const addon = db
      .prepare(`SELECT * FROM portal_addon_catalog WHERE id = ? AND active = 1`)
      .get(addonId) as any;
    if (!addon) return res.status(404).json({ error: 'Add-on not found' });
    const exists = db
      .prepare(
        `SELECT id FROM portal_addon_requests
         WHERE pppoe_user_id = ? AND addon_id = ? AND status = 'pending'`
      )
      .get(sess.uid, addonId);
    if (exists) return res.status(409).json({ error: 'You already requested this add-on' });
    const note = String(req.body?.note || '').trim() || null;
    const info = db
      .prepare(
        `INSERT INTO portal_addon_requests (pppoe_user_id, addon_id, status, note)
         VALUES (?, ?, 'pending', ?)`
      )
      .run(sess.uid, addonId, note);
    notifyStaff({
      type: 'ticket',
      title: 'Add-on request',
      body: `${subscriberLabel(sess.uid)} requested ${addon.name}`,
      entityType: 'portal_addon_request',
      entityId: Number(info.lastInsertRowid),
      pppoeUserId: sess.uid,
      status: 'pending',
      payload: { addon: addon.name, price: addon.price },
    });
    pushPortalActivity({
      pppoeUserId: sess.uid,
      type: 'addon_request',
      title: 'Add-on requested',
      body: `${addon.name} — pending ISP review`,
      entityType: 'portal_addon_request',
      entityId: Number(info.lastInsertRowid),
    });
    res.status(201).json({ ok: true, id: Number(info.lastInsertRowid) });
  });

  // ── Grace / reconnect ─────────────────────────────────────────────────────
  publicPortalRouter.post('/public/portal/reconnect-request', (req, res) => {
    const sess = requirePortal(req, res);
    if (!sess) return;
    const st = String(sess.status || '').toLowerCase();
    const eligible =
      st.includes('non') || st === 'disabled' || st === 'expired' || st === 'suspended';
    if (!eligible) {
      return res.status(400).json({ error: 'Reconnect is only for suspended / overdue accounts' });
    }
    const pending = db
      .prepare(
        `SELECT id FROM portal_reconnect_requests
         WHERE pppoe_user_id = ? AND status = 'pending'`
      )
      .get(sess.uid);
    if (pending) return res.status(409).json({ error: 'You already have a pending reconnect request' });
    const reason = String(req.body?.reason || '').trim() || null;
    const info = db
      .prepare(
        `INSERT INTO portal_reconnect_requests (pppoe_user_id, reason, status)
         VALUES (?, ?, 'pending')`
      )
      .run(sess.uid, reason);
    notifyStaff({
      type: 'ticket',
      title: 'Temporary reconnect request',
      body: `${subscriberLabel(sess.uid)} asked for temporary reconnect${reason ? `: ${reason}` : ''}`,
      entityType: 'portal_reconnect_request',
      entityId: Number(info.lastInsertRowid),
      pppoeUserId: sess.uid,
      status: 'pending',
    });
    pushPortalActivity({
      pppoeUserId: sess.uid,
      type: 'reconnect_request',
      title: 'Reconnect requested',
      body: 'Your ISP will review a temporary reconnect.',
      entityType: 'portal_reconnect_request',
      entityId: Number(info.lastInsertRowid),
    });
    res.status(201).json({ ok: true, id: Number(info.lastInsertRowid) });
  });

  publicPortalRouter.get('/public/portal/reconnect-request', (req, res) => {
    const sess = requirePortal(req, res);
    if (!sess) return;
    const row = db
      .prepare(
        `SELECT id, reason, status, review_note AS reviewNote, created_at AS createdAt
         FROM portal_reconnect_requests
         WHERE pppoe_user_id = ?
         ORDER BY id DESC LIMIT 1`
      )
      .get(sess.uid);
    res.json({ request: row || null });
  });

  // ── Ticket thread ─────────────────────────────────────────────────────────
  publicPortalRouter.get('/public/portal/tickets/:id/messages', (req, res) => {
    const sess = requirePortal(req, res);
    if (!sess) return;
    const id = Number(req.params.id);
    const job = db.prepare('SELECT * FROM job_orders WHERE id = ?').get(id) as any;
    if (!job || Number(job.pppoe_user_id) !== Number(sess.uid)) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    const messages = db
      .prepare(
        `SELECT id, author_role AS authorRole, author_name AS authorName, body,
                attachment_path AS attachmentPath, created_at AS createdAt
         FROM job_order_messages WHERE job_order_id = ? ORDER BY id ASC`
      )
      .all(id);
    res.json({
      job: {
        id: job.id,
        number: job.number,
        type: job.type,
        status: job.status,
        description: job.description,
        scheduledAt: job.scheduled_at,
        assignedTo: job.assigned_to,
        createdAt: job.created_at,
      },
      messages,
    });
  });

  publicPortalRouter.post('/public/portal/tickets/:id/messages', (req, res) => {
    const sess = requirePortal(req, res);
    if (!sess) return;
    const id = Number(req.params.id);
    const job = db.prepare('SELECT * FROM job_orders WHERE id = ?').get(id) as any;
    if (!job || Number(job.pppoe_user_id) !== Number(sess.uid)) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    if (['completed', 'cancelled'].includes(String(job.status))) {
      return res.status(400).json({ error: 'This ticket is closed' });
    }
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Enter a message' });
    let attachment: string | null = null;
    try {
      attachment = savePortalAttachment(req.body?.attachment, `jo-${id}`);
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || 'Invalid attachment' });
    }
    const info = db
      .prepare(
        `INSERT INTO job_order_messages (job_order_id, author_role, author_name, body, attachment_path)
         VALUES (?, 'subscriber', ?, ?, ?)`
      )
      .run(id, sess.customer_name || sess.username, body, attachment);
    notifyStaff({
      type: 'ticket',
      title: 'Ticket reply',
      body: `${subscriberLabel(sess.uid)} replied on ${job.number}`,
      entityType: 'job_order',
      entityId: id,
      pppoeUserId: sess.uid,
      status: job.status,
    });
    res.status(201).json({
      id: Number(info.lastInsertRowid),
      authorRole: 'subscriber',
      authorName: sess.customer_name || sess.username,
      body,
      attachmentPath: attachment,
      createdAt: new Date().toISOString(),
    });
  });

  publicPortalRouter.post('/public/portal/tickets/:id/close', (req, res) => {
    const sess = requirePortal(req, res);
    if (!sess) return;
    const id = Number(req.params.id);
    const job = db.prepare('SELECT * FROM job_orders WHERE id = ?').get(id) as any;
    if (!job || Number(job.pppoe_user_id) !== Number(sess.uid)) {
      return res.status(404).json({ error: 'Ticket not found' });
    }
    if (['completed', 'cancelled'].includes(String(job.status))) {
      return res.json({ ok: true });
    }
    db.prepare(
      `UPDATE job_orders SET status = 'cancelled', updated_at = datetime('now'),
       notes = COALESCE(notes,'') || ' [Closed by subscriber]'
       WHERE id = ?`
    ).run(id);
    pushPortalActivity({
      pppoeUserId: sess.uid,
      type: 'ticket',
      title: 'Ticket closed',
      body: `${job.number} closed by you`,
      entityType: 'job_order',
      entityId: id,
    });
    res.json({ ok: true });
  });

  // ── Tech visit (from scheduled job orders) ────────────────────────────────
  publicPortalRouter.get('/public/portal/visits', (req, res) => {
    const sess = requirePortal(req, res);
    if (!sess) return;
    const visits = db
      .prepare(
        `SELECT id, number, type, status, assigned_to AS assignedTo, scheduled_at AS scheduledAt,
                description, created_at AS createdAt
         FROM job_orders
         WHERE pppoe_user_id = ?
           AND status NOT IN ('completed','cancelled')
           AND scheduled_at IS NOT NULL
         ORDER BY scheduled_at ASC LIMIT 10`
      )
      .all(sess.uid);
    res.json({ visits });
  });

  // ── Referrals ─────────────────────────────────────────────────────────────
  publicPortalRouter.get('/public/portal/referral', (req, res) => {
    const sess = requirePortal(req, res);
    if (!sess) return;
    const code = ensureReferralCode(sess.uid);
    const leads = db
      .prepare(
        `SELECT id, referred_name AS name, referred_contact AS contact, status, created_at AS createdAt
         FROM portal_referrals WHERE referrer_pppoe_user_id = ? ORDER BY id DESC LIMIT 20`
      )
      .all(sess.uid);
    res.json({ code, leads });
  });

  publicPortalRouter.post('/public/portal/referral', (req, res) => {
    const sess = requirePortal(req, res);
    if (!sess) return;
    const code = ensureReferralCode(sess.uid);
    const name = String(req.body?.name || '').trim();
    const contact = String(req.body?.contact || '').trim();
    const address = String(req.body?.address || '').trim() || null;
    if (!name || !contact) return res.status(400).json({ error: 'Name and contact are required' });
    const info = db
      .prepare(
        `INSERT INTO portal_referrals
           (referrer_pppoe_user_id, code, referred_name, referred_contact, referred_address, status)
         VALUES (?, ?, ?, ?, ?, 'pending')`
      )
      .run(sess.uid, code, name, contact, address);
    notifyStaff({
      type: 'ticket',
      title: 'Referral lead',
      body: `${subscriberLabel(sess.uid)} referred ${name} (${contact})`,
      entityType: 'portal_referral',
      entityId: Number(info.lastInsertRowid),
      pppoeUserId: sess.uid,
      status: 'pending',
      payload: { name, contact, address, code },
    });
    pushPortalActivity({
      pppoeUserId: sess.uid,
      type: 'referral',
      title: 'Referral submitted',
      body: `${name} — our team will follow up`,
      entityType: 'portal_referral',
      entityId: Number(info.lastInsertRowid),
    });
    res.status(201).json({ ok: true, id: Number(info.lastInsertRowid), code });
  });

  // ── Active outage notices for this subscriber (by NAP) ────────────────────
  publicPortalRouter.get('/public/portal/outage-notices', (req, res) => {
    const sess = requirePortal(req, res);
    if (!sess) return;
    const napId = sess.nap_id != null ? Number(sess.nap_id) : null;
    const rows = db
      .prepare(
        `SELECT id, title, body, nap_ids AS napIds, sent_at AS sentAt, created_at AS createdAt
         FROM network_outage_notices
         WHERE status = 'sent'
         ORDER BY id DESC LIMIT 30`
      )
      .all() as any[];
    const notices = rows.filter((r) => {
      let ids: number[] = [];
      try {
        ids = JSON.parse(r.napIds || '[]').map(Number);
      } catch {
        ids = [];
      }
      if (!ids.length) return true; // broadcast
      if (napId == null) return false;
      return ids.includes(napId);
    });
    res.json({ notices, napId });
  });

  // ── Staff: NAP-targeted outage notifications ──────────────────────────────
  ispOpsRouter.get('/outage-notices', (_req, res) => {
    const rows = db
      .prepare(
        `SELECT id, title, body, nap_ids AS napIds, channels, status, recipient_count AS recipientCount,
                created_by AS createdBy, sent_at AS sentAt, created_at AS createdAt
         FROM network_outage_notices ORDER BY id DESC LIMIT 50`
      )
      .all()
      .map((r: any) => {
        let napIds: number[] = [];
        let channels: string[] = [];
        try {
          napIds = JSON.parse(r.napIds || '[]');
        } catch {
          napIds = [];
        }
        try {
          channels = JSON.parse(r.channels || '[]');
        } catch {
          channels = ['sms'];
        }
        return { ...r, napIds, channels };
      });
    res.json({ notices: rows });
  });

  ispOpsRouter.get('/outage-notices/naps', (_req, res) => {
    const naps = db
      .prepare(
        `SELECT n.id, n.name, n.code, n.status, n.ports,
                (SELECT COUNT(*) FROM pppoe_users u WHERE u.nap_id = n.id) AS subscriberCount
         FROM naps n
         WHERE COALESCE(n.kind, 'nap') = 'nap'
         ORDER BY n.name COLLATE NOCASE`
      )
      .all();
    res.json({ naps });
  });

  ispOpsRouter.post('/outage-notices/send', async (req, res) => {
    const title = String(req.body?.title || '').trim();
    const body = String(req.body?.body || '').trim();
    const napIds = Array.isArray(req.body?.napIds)
      ? [...new Set(req.body.napIds.map(Number).filter((n: number) => n > 0))]
      : [];
    const channels = Array.isArray(req.body?.channels)
      ? req.body.channels.filter((c: string) => c === 'sms' || c === 'email')
      : ['sms'];
    if (!title || !body) return res.status(400).json({ error: 'Title and message are required' });
    if (!napIds.length) {
      return res.status(400).json({ error: 'Select at least one NAP box' });
    }
    if (!channels.length) return res.status(400).json({ error: 'Select SMS and/or email' });

    const placeholders = napIds.map(() => '?').join(',');
    const users = db
      .prepare(
        `SELECT * FROM pppoe_users
         WHERE nap_id IN (${placeholders})
           AND COALESCE(portal_enabled, 1) IS NOT NULL`
      )
      .all(...napIds) as any[];

    const info = db
      .prepare(
        `INSERT INTO network_outage_notices
           (title, body, nap_ids, channels, status, recipient_count, created_by, sent_at)
         VALUES (?, ?, ?, ?, 'sent', ?, ?, datetime('now'))`
      )
      .run(
        title,
        body,
        JSON.stringify(napIds),
        JSON.stringify(channels),
        users.length,
        (req as any).user?.username || (req as any).user?.email || 'staff'
      );
    const noticeId = Number(info.lastInsertRowid);

    let sent = 0;
    for (const u of users) {
      pushPortalActivity({
        pppoeUserId: u.id,
        type: 'outage_notice',
        title,
        body,
        entityType: 'network_outage_notice',
        entityId: noticeId,
        payload: { napIds },
      });
      try {
        const r = await notifyClientChannels(u, channels as ('sms' | 'email')[], title, body, 'outage_notice');
        if (Array.isArray(r) ? r.some((x: any) => x?.status === 'sent') : (r as any)?.status === 'sent') {
          sent += 1;
        } else if (r && typeof r === 'object') {
          // notifyClient may return per-channel results
          sent += 1;
        }
      } catch {
        /* continue */
      }
    }

    res.status(201).json({
      ok: true,
      id: noticeId,
      recipientCount: users.length,
      attempted: users.length,
      sentHint: sent,
    });
  });

  // Staff ticket reply (so threads work both ways)
  ispOpsRouter.post('/job-orders/:id/messages', (req, res) => {
    const id = Number(req.params.id);
    const job = db.prepare('SELECT * FROM job_orders WHERE id = ?').get(id) as any;
    if (!job) return res.status(404).json({ error: 'Job order not found' });
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Enter a message' });
    let attachment: string | null = null;
    try {
      attachment = savePortalAttachment(req.body?.attachment, `jo-staff-${id}`);
    } catch (e: any) {
      return res.status(400).json({ error: e?.message || 'Invalid attachment' });
    }
    const author = (req as any).user?.username || (req as any).user?.name || 'Staff';
    const info = db
      .prepare(
        `INSERT INTO job_order_messages (job_order_id, author_role, author_name, body, attachment_path)
         VALUES (?, 'staff', ?, ?, ?)`
      )
      .run(id, author, body, attachment);
    if (job.pppoe_user_id) {
      pushPortalActivity({
        pppoeUserId: Number(job.pppoe_user_id),
        type: 'ticket',
        title: `Update on ${job.number}`,
        body: body.slice(0, 180),
        entityType: 'job_order',
        entityId: id,
      });
    }
    res.status(201).json({
      id: Number(info.lastInsertRowid),
      authorRole: 'staff',
      authorName: author,
      body,
      attachmentPath: attachment,
      createdAt: new Date().toISOString(),
    });
  });

  ispOpsRouter.get('/job-orders/:id/messages', (req, res) => {
    const id = Number(req.params.id);
    const job = db.prepare('SELECT id FROM job_orders WHERE id = ?').get(id);
    if (!job) return res.status(404).json({ error: 'Job order not found' });
    const messages = db
      .prepare(
        `SELECT id, author_role AS authorRole, author_name AS authorName, body,
                attachment_path AS attachmentPath, created_at AS createdAt
         FROM job_order_messages WHERE job_order_id = ? ORDER BY id ASC`
      )
      .all(id);
    res.json({ messages });
  });

  // Staff review queues for add-ons / reconnect / referrals
  ispOpsRouter.get('/portal-requests/addons', (_req, res) => {
    res.json({
      items: db
        .prepare(
          `SELECT r.id, r.status, r.note, r.created_at AS createdAt, r.pppoe_user_id AS pppoeUserId,
                  a.name AS addonName, a.price,
                  u.customer_name AS customerName, u.account_number AS accountNumber
           FROM portal_addon_requests r
           JOIN portal_addon_catalog a ON a.id = r.addon_id
           LEFT JOIN pppoe_users u ON u.id = r.pppoe_user_id
           WHERE r.status = 'pending' ORDER BY r.id DESC LIMIT 100`
        )
        .all(),
    });
  });

  ispOpsRouter.post('/portal-requests/addons/:id/decide', (req, res) => {
    const id = Number(req.params.id);
    const accept = String(req.body?.decision || '') === 'accept';
    const row = db.prepare('SELECT * FROM portal_addon_requests WHERE id = ?').get(id) as any;
    if (!row || row.status !== 'pending') return res.status(404).json({ error: 'Request not found' });
    const reviewNote = String(req.body?.note || '').trim() || null;
    db.prepare(
      `UPDATE portal_addon_requests SET status = ?, review_note = ?, reviewed_at = datetime('now') WHERE id = ?`
    ).run(accept ? 'accepted' : 'rejected', reviewNote, id);
    const addon = db.prepare('SELECT name FROM portal_addon_catalog WHERE id = ?').get(row.addon_id) as any;
    pushPortalActivity({
      pppoeUserId: row.pppoe_user_id,
      type: 'addon_request',
      title: accept ? 'Add-on approved' : 'Add-on declined',
      body: `${addon?.name || 'Add-on'}${reviewNote ? ` — ${reviewNote}` : ''}`,
      entityType: 'portal_addon_request',
      entityId: id,
    });
    res.json({ ok: true });
  });

  ispOpsRouter.get('/portal-requests/reconnects', (_req, res) => {
    res.json({
      items: db
        .prepare(
          `SELECT r.id, r.reason, r.status, r.created_at AS createdAt, r.pppoe_user_id AS pppoeUserId,
                  u.customer_name AS customerName, u.account_number AS accountNumber, u.status AS accountStatus
           FROM portal_reconnect_requests r
           LEFT JOIN pppoe_users u ON u.id = r.pppoe_user_id
           WHERE r.status = 'pending' ORDER BY r.id DESC LIMIT 100`
        )
        .all(),
    });
  });

  ispOpsRouter.post('/portal-requests/reconnects/:id/decide', (req, res) => {
    const id = Number(req.params.id);
    const accept = String(req.body?.decision || '') === 'accept';
    const row = db.prepare('SELECT * FROM portal_reconnect_requests WHERE id = ?').get(id) as any;
    if (!row || row.status !== 'pending') return res.status(404).json({ error: 'Request not found' });
    const reviewNote = String(req.body?.note || '').trim() || null;
    db.prepare(
      `UPDATE portal_reconnect_requests SET status = ?, review_note = ?, reviewed_at = datetime('now') WHERE id = ?`
    ).run(accept ? 'accepted' : 'rejected', reviewNote, id);
    pushPortalActivity({
      pppoeUserId: row.pppoe_user_id,
      type: 'reconnect_request',
      title: accept ? 'Reconnect approved' : 'Reconnect declined',
      body: reviewNote || (accept ? 'Temporary reconnect granted — settle your balance soon.' : 'Request was not approved.'),
      entityType: 'portal_reconnect_request',
      entityId: id,
    });
    res.json({ ok: true });
  });

  ispOpsRouter.get('/portal-requests/referrals', (_req, res) => {
    res.json({
      items: db
        .prepare(
          `SELECT r.id, r.code, r.referred_name AS name, r.referred_contact AS contact,
                  r.referred_address AS address, r.status, r.created_at AS createdAt,
                  u.customer_name AS referrerName, u.account_number AS referrerAccount
           FROM portal_referrals r
           LEFT JOIN pppoe_users u ON u.id = r.referrer_pppoe_user_id
           ORDER BY r.id DESC LIMIT 100`
        )
        .all(),
    });
  });
}
