import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { db } from './db.js';
import { type AuthedRequest, sessionPayload } from './auth.js';
import { cashierCollectPayment } from './billing.js';
import { listPaymentMerchants } from './paymentMerchants.js';
import { notifyClientChannels, phonesMatch } from './notify.js';

export const cashierRouter = Router();
export const publicCashierRouter = Router();

const CASHIER_ROLE = 'Cashier';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(raw: string) {
  return String(raw || '').trim().toLowerCase();
}

function normalizeMobile(raw: string) {
  return String(raw || '').trim();
}

function isCashierRole(role: string | null | undefined) {
  return String(role || '').trim().toLowerCase() === 'cashier';
}

function requireCashier(req: AuthedRequest, res: any, next: any) {
  if (!req.user || !isCashierRole(req.user.role)) {
    return res.status(403).json({ error: 'Cashier access only' });
  }
  next();
}

function requireAdmin(req: AuthedRequest, res: any, next: any) {
  const role = String(req.user?.role || '');
  if (!/admin/i.test(role)) {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

function ensureCashierRoleExists() {
  const row = db.prepare('SELECT id FROM roles WHERE lower(name) = ?').get('cashier') as { id: number } | undefined;
  if (row) return;
  db.prepare('INSERT INTO roles (name, description, permissions) VALUES (?, ?, ?)').run(
    CASHIER_ROLE,
    'Cashier portal — collect subscriber payments and upload proof',
    JSON.stringify(['sales', 'invoices', 'dashboard', 'license'])
  );
}

function mapCashier(row: any) {
  return {
    id: row.id,
    email: row.email || row.username,
    username: row.username,
    mobile: row.mobile || '',
    role: row.role,
    mustChangePassword: Number(row.must_change_password) === 1,
    theme: row.cashier_theme === 'orbital' ? 'orbital' : 'matrix',
    createdAt: row.created_at,
  };
}

function generateTempPassword() {
  const n = crypto.randomInt(100000, 999999);
  return String(n);
}

// ---- Public: cashier forgot password (email + mobile) ----
publicCashierRouter.post('/public/cashier/forgot-password', async (req, res) => {
  const email = normalizeEmail(req.body?.email || '');
  const mobile = normalizeMobile(req.body?.mobile || req.body?.phone || '');
  if (!email || !mobile) {
    return res.status(400).json({ error: 'Email and mobile number are required' });
  }

  const user = db
    .prepare(
      `SELECT * FROM users WHERE lower(username) = ? OR lower(COALESCE(email, '')) = ? LIMIT 1`
    )
    .get(email, email) as any;
  if (!user || !isCashierRole(user.role)) {
    return res.status(400).json({ error: 'No cashier account matched that email and mobile number' });
  }
  if (!phonesMatch(user.mobile, mobile)) {
    return res.status(400).json({ error: 'No cashier account matched that email and mobile number' });
  }

  const temp = generateTempPassword();
  const hash = bcrypt.hashSync(temp, 10);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hash, user.id);

  const subject = 'Cashier portal temporary password';
  const message =
    `Hi, your temporary cashier portal password is: ${temp}. ` +
    `Sign in at /cashier with email ${user.email || user.username} and set a new password right away.`;

  try {
    await notifyClientChannels(
      { email: user.email || user.username, contact: user.mobile, customer_name: user.username },
      ['email', 'sms'],
      subject,
      message,
      'cashier_password_reset'
    );
  } catch (e: any) {
    db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
      'warn',
      'cashier',
      `Cashier password reset notify error for ${user.username}: ${e?.message || e}`
    );
  }

  res.json({
    ok: true,
    message: 'If the account matched, a temporary password was sent to the email and/or mobile on file.',
  });
});

// ---- Admin: cashier account CRUD ----
cashierRouter.get('/cashiers', requireAdmin, (_req, res) => {
  ensureCashierRoleExists();
  const rows = db
    .prepare(
      `SELECT id, username, email, mobile, role, must_change_password, cashier_theme, created_at
       FROM users WHERE lower(role) = 'cashier' ORDER BY id DESC`
    )
    .all();
  res.json({ cashiers: rows.map(mapCashier) });
});

cashierRouter.post('/cashiers', requireAdmin, (req, res) => {
  ensureCashierRoleExists();
  const email = normalizeEmail(req.body?.email || '');
  const mobile = normalizeMobile(req.body?.mobile || req.body?.phone || '');
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Valid email is required (used as login username)' });
  if (mobile.replace(/\D/g, '').length < 6) {
    return res.status(400).json({ error: 'Mobile number is required (used as the initial password)' });
  }

  const roleRow = db.prepare('SELECT name FROM roles WHERE lower(name) = ?').get('cashier') as
    | { name: string }
    | undefined;
  const roleName = roleRow?.name || CASHIER_ROLE;

  try {
    const info = db
      .prepare(
        `INSERT INTO users (username, password_hash, role, email, mobile, must_change_password, cashier_theme)
         VALUES (?, ?, ?, ?, ?, 1, 'matrix')`
      )
      .run(email, bcrypt.hashSync(mobile, 10), roleName, email, mobile);
    const id = Number(info.lastInsertRowid);
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
      'info',
      'cashier',
      `Cashier account created: ${email}`
    );
    res.status(201).json({
      cashier: mapCashier(row),
      initialPasswordHint: 'Initial password is the mobile number provided.',
    });
  } catch {
    res.status(409).json({ error: 'A user with that email already exists.' });
  }
});

cashierRouter.put('/cashiers/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const ex = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
  if (!ex || !isCashierRole(ex.role)) return res.status(404).json({ error: 'Cashier not found' });

  const email = req.body?.email != null ? normalizeEmail(req.body.email) : normalizeEmail(ex.email || ex.username);
  const mobile = req.body?.mobile != null ? normalizeMobile(req.body.mobile) : normalizeMobile(ex.mobile || '');
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Valid email is required' });
  if (mobile.replace(/\D/g, '').length < 6) return res.status(400).json({ error: 'Mobile number is required' });

  try {
    db.prepare('UPDATE users SET username = ?, email = ?, mobile = ? WHERE id = ?').run(email, email, mobile, id);
    if (req.body?.resetPasswordToMobile) {
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(
        bcrypt.hashSync(mobile, 10),
        id
      );
    }
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    res.json({ cashier: mapCashier(row) });
  } catch {
    res.status(409).json({ error: 'Email already in use.' });
  }
});

cashierRouter.delete('/cashiers/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const ex = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
  if (!ex || !isCashierRole(ex.role)) return res.status(404).json({ error: 'Cashier not found' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---- Cashier portal session APIs ----
cashierRouter.get('/cashier/me', requireCashier, (req: AuthedRequest, res) => {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id) as any;
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({
    ...sessionPayload(row),
    ...mapCashier(row),
  });
});

cashierRouter.put('/cashier/theme', requireCashier, (req: AuthedRequest, res) => {
  const theme = String(req.body?.theme || '').toLowerCase() === 'orbital' ? 'orbital' : 'matrix';
  db.prepare('UPDATE users SET cashier_theme = ? WHERE id = ?').run(theme, req.user!.id);
  res.json({ theme });
});

cashierRouter.post('/cashier/change-password', requireCashier, (req: AuthedRequest, res) => {
  const current = String(req.body?.currentPassword || '');
  const next = String(req.body?.newPassword || '');
  if (next.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id) as any;
  if (!row || !bcrypt.compareSync(current, row.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(
    bcrypt.hashSync(next, 10),
    req.user!.id
  );
  res.json({ ok: true });
});

cashierRouter.get('/cashier/subscribers', requireCashier, (req: AuthedRequest, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q.length < 2) {
    return res.json({ subscribers: [] });
  }
  const like = `%${q}%`;
  const rows = db
    .prepare(
      `SELECT id, username, customer_name AS customer, account_number AS account, profile, price,
              status, subscription_due AS subscriptionDue, contact, email
       FROM pppoe_users
       WHERE lower(username) LIKE ? OR lower(COALESCE(customer_name,'')) LIKE ?
          OR lower(COALESCE(account_number,'')) LIKE ? OR replace(COALESCE(contact,''), ' ', '') LIKE ?
          OR lower(COALESCE(email,'')) LIKE ?
       ORDER BY customer_name ASC, username ASC
       LIMIT 40`
    )
    .all(like, like, like, like.replace(/\D/g, '') ? `%${q.replace(/\D/g, '')}%` : like, like);
  res.json({ subscribers: rows });
});

cashierRouter.get('/cashier/merchants', requireCashier, (_req, res) => {
  res.json({ merchants: listPaymentMerchants({ activeOnly: true }) });
});

cashierRouter.get('/cashier/recent', requireCashier, (req: AuthedRequest, res) => {
  const rows = db
    .prepare(
      `SELECT pl.id, pl.amount, pl.months, pl.status, pl.pay_channel AS payChannel,
              pl.external_ref AS externalRef, pl.paid_at AS paidAt, pl.created_at AS createdAt,
              pl.cashier_username AS cashierUsername,
              u.username, u.customer_name AS customer, u.account_number AS account
       FROM payment_links pl
       JOIN pppoe_users u ON u.id = pl.pppoe_user_id
       WHERE pl.cashier_user_id = ? AND pl.status = 'paid'
       ORDER BY pl.id DESC LIMIT 40`
    )
    .all(req.user!.id);
  res.json({ payments: rows });
});

cashierRouter.post('/cashier/collect', requireCashier, async (req: AuthedRequest, res) => {
  try {
    const userId = Number(req.body?.userId || req.body?.pppoeUserId);
    if (!userId) return res.status(400).json({ error: 'Select a subscriber' });
    const result = await cashierCollectPayment({
      pppoeUserId: userId,
      months: req.body?.months,
      amount: req.body?.amount,
      channel: req.body?.channel,
      reference: req.body?.reference,
      proofImage: req.body?.proofImage,
      merchantId: req.body?.merchantId,
      cashier: { id: req.user!.id, username: req.user!.username },
    });
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e?.message || 'Payment failed' });
  }
});

/** Optional: cashier login helper returning mustChangePassword (uses same /login). */
export function cashierLoginExtras(user: any) {
  return {
    mustChangePassword: Number(user.must_change_password) === 1,
    theme: user.cashier_theme === 'orbital' ? 'orbital' : 'matrix',
    isCashier: isCashierRole(user.role),
  };
}
