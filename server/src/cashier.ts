import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { db } from './db.js';
import { type AuthedRequest, sessionPayload } from './auth.js';
import { cashierCollectPayment, cashierStartPaymongoCheckout } from './billing.js';
import { listPaymentMerchants } from './paymentMerchants.js';
import {
  listCashierCollectibles,
  listCashierDeposits,
  getCashierDeposit,
  submitCashierDeposit,
  startCashierRemittancePaymongo,
  cancelCashierRemittancePaymongo,
  acceptCashierDeposit,
  rejectCashierDeposit,
  resolveDepositProofPath,
  cashierCollectibleSummary,
} from './cashierCollectibles.js';
import { notifyClientChannels, phonesMatch } from './notify.js';
import { getPublicPayOptions } from './paymongo.js';

export const cashierRouter = Router();
export const publicCashierRouter = Router();

const MERCHANT_ROLE = 'Merchant';
const LEGACY_CASHIER_ROLE = 'Cashier';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(raw: string) {
  return String(raw || '').trim().toLowerCase();
}

function normalizeMobile(raw: string) {
  return String(raw || '').trim();
}

function isMerchantPartnerRole(role: string | null | undefined) {
  const r = String(role || '').trim().toLowerCase();
  return r === 'merchant' || r === 'cashier';
}

function requireMerchantPartner(req: AuthedRequest, res: any, next: any) {
  if (!req.user || !isMerchantPartnerRole(req.user.role)) {
    return res.status(403).json({ error: 'Merchant portal access only' });
  }
  next();
}

/** @deprecated alias */
const requireCashier = requireMerchantPartner;
const isCashierRole = isMerchantPartnerRole;


function requireAdmin(req: AuthedRequest, res: any, next: any) {
  const role = String(req.user?.role || '');
  if (!/admin/i.test(role)) {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

function ensureMerchantRoleExists() {
  const merchant = db.prepare('SELECT id FROM roles WHERE lower(name) = ?').get('merchant') as { id: number } | undefined;
  if (!merchant) {
    db.prepare('INSERT INTO roles (name, description, permissions) VALUES (?, ?, ?)').run(
      MERCHANT_ROLE,
      'Merchant portal — business partners who process subscriber payments',
      JSON.stringify(['sales', 'invoices', 'dashboard', 'license'])
    );
  }
  // Keep legacy Cashier role for existing accounts
  const cashier = db.prepare('SELECT id FROM roles WHERE lower(name) = ?').get('cashier') as { id: number } | undefined;
  if (!cashier) {
    db.prepare('INSERT INTO roles (name, description, permissions) VALUES (?, ?, ?)').run(
      LEGACY_CASHIER_ROLE,
      'Legacy name for Merchant portal partners',
      JSON.stringify(['sales', 'invoices', 'dashboard', 'license'])
    );
  }
}
const ensureCashierRoleExists = ensureMerchantRoleExists;


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
async function merchantForgotPassword(req: any, res: any) {
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
    return res.status(400).json({ error: 'No merchant account matched that email and mobile number' });
  }
  if (!phonesMatch(user.mobile, mobile)) {
    return res.status(400).json({ error: 'No merchant account matched that email and mobile number' });
  }

  const temp = generateTempPassword();
  const hash = bcrypt.hashSync(temp, 10);
  db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(hash, user.id);

  const subject = 'Merchant portal temporary password';
  const message =
    `Hi, your temporary merchant portal password is: ${temp}. ` +
    `Sign in at /merchant with email ${user.email || user.username} and set a new password right away.`;

  try {
    await notifyClientChannels(
      { email: user.email || user.username, contact: user.mobile, customer_name: user.username },
      ['email', 'sms'],
      subject,
      message,
      'merchant_password_reset'
    );
  } catch (e: any) {
    db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
      'warn',
      'cashier',
      `Merchant password reset notify error for ${user.username}: ${e?.message || e}`
    );
  }

  res.json({
    ok: true,
    message: 'If the account matched, a temporary password was sent to the email and/or mobile on file.',
  });
}

publicCashierRouter.post('/public/cashier/forgot-password', merchantForgotPassword);
publicCashierRouter.post('/public/merchant/forgot-password', merchantForgotPassword);

// ---- Admin: merchant portal account CRUD ----
function listMerchantPartnerUsers() {
  return db
    .prepare(
      `SELECT id, username, email, mobile, role, must_change_password, cashier_theme, created_at
       FROM users WHERE lower(role) IN ('cashier', 'merchant') ORDER BY id DESC`
    )
    .all();
}

cashierRouter.get('/cashiers', requireAdmin, (_req, res) => {
  ensureMerchantRoleExists();
  const merchants = listMerchantPartnerUsers().map(mapCashier);
  res.json({ cashiers: merchants, merchants });
});

cashierRouter.get('/merchants', requireAdmin, (_req, res) => {
  ensureMerchantRoleExists();
  const merchants = listMerchantPartnerUsers().map(mapCashier);
  res.json({ merchants, cashiers: merchants });
});

function createMerchantPartnerAccount(req: any, res: any) {
  ensureMerchantRoleExists();
  const email = normalizeEmail(req.body?.email || '');
  const mobile = normalizeMobile(req.body?.mobile || req.body?.phone || '');
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Valid email is required (used as login username)' });
  if (mobile.replace(/\D/g, '').length < 6) {
    return res.status(400).json({ error: 'Mobile number is required (used as the initial password)' });
  }

  const roleRow = db.prepare('SELECT name FROM roles WHERE lower(name) = ?').get('merchant') as
    | { name: string }
    | undefined;
  const roleName = roleRow?.name || MERCHANT_ROLE;

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
      'merchant',
      `Merchant portal account created: ${email}`
    );
    const mapped = mapCashier(row);
    res.status(201).json({
      cashier: mapped,
      merchant: mapped,
      initialPasswordHint: 'Initial password is the mobile number provided.',
    });
  } catch {
    res.status(409).json({ error: 'A user with that email already exists.' });
  }
}

cashierRouter.post('/cashiers', requireAdmin, createMerchantPartnerAccount);
cashierRouter.post('/merchants', requireAdmin, createMerchantPartnerAccount);

cashierRouter.put('/cashiers/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const ex = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
  if (!ex || !isCashierRole(ex.role)) return res.status(404).json({ error: 'Merchant not found' });

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
  if (!ex || !isCashierRole(ex.role)) return res.status(404).json({ error: 'Merchant not found' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

cashierRouter.put('/merchants/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const ex = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
  if (!ex || !isCashierRole(ex.role)) return res.status(404).json({ error: 'Merchant not found' });
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
    const mapped = mapCashier(row);
    res.json({ cashier: mapped, merchant: mapped });
  } catch {
    res.status(409).json({ error: 'Email already in use.' });
  }
});

cashierRouter.delete('/merchants/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const ex = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
  if (!ex || !isCashierRole(ex.role)) return res.status(404).json({ error: 'Merchant not found' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---- Merchant portal session APIs (and legacy /cashier/* aliases) ----
function merchantMe(req: AuthedRequest, res: any) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user!.id) as any;
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json({
    ...sessionPayload(row),
    ...mapCashier(row),
  });
}
cashierRouter.get('/cashier/me', requireCashier, merchantMe);
cashierRouter.get('/merchant/me', requireCashier, merchantMe);

cashierRouter.put('/merchant/theme', requireCashier, (req: AuthedRequest, res) => {
  const theme = String(req.body?.theme || '').toLowerCase() === 'orbital' ? 'orbital' : 'matrix';
  db.prepare('UPDATE users SET cashier_theme = ? WHERE id = ?').run(theme, req.user!.id);
  res.json({ theme });
});

cashierRouter.post('/merchant/change-password', requireCashier, (req: AuthedRequest, res) => {
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

cashierRouter.get('/merchant/subscribers', requireCashier, (req: AuthedRequest, res) => {
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

cashierRouter.get('/merchant/payment-merchants', requireCashier, (_req, res) => {
  res.json({ merchants: listPaymentMerchants({ activeOnly: true }) });
});

cashierRouter.get('/merchant/recent', requireCashier, (req: AuthedRequest, res) => {
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

cashierRouter.get('/merchant/collectibles', requireCashier, (req: AuthedRequest, res) => {
  const status = String(req.query.status || 'open');
  const statuses = status === 'all' ? undefined : status.split(',').map((s) => s.trim()).filter(Boolean);
  res.json({
    collectibles: listCashierCollectibles({
      cashierUserId: req.user!.id,
      status: statuses,
      limit: 300,
    }),
    summary: cashierCollectibleSummary(req.user!.id),
  });
});

cashierRouter.get('/merchant/deposits', requireCashier, (req: AuthedRequest, res) => {
  res.json({
    deposits: listCashierDeposits({ cashierUserId: req.user!.id, limit: 100 }),
  });
});

cashierRouter.post('/merchant/deposits', requireCashier, (req: AuthedRequest, res) => {
  try {
    const ids = Array.isArray(req.body?.collectibleIds)
      ? req.body.collectibleIds
      : String(req.body?.collectibleIds || '')
          .split(',')
          .map((x: string) => Number(x.trim()))
          .filter(Boolean);
    const deposit = submitCashierDeposit({
      cashierUserId: req.user!.id,
      cashierUsername: req.user!.username,
      collectibleIds: ids,
      note: req.body?.note,
      proofImage: req.body?.proofImage,
    });
    res.status(201).json({ deposit });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || 'Could not submit deposit' });
  }
});

/**
 * Merchant remits selected cash collectibles via PayMongo (QR Ph / GCash / Maya).
 * Webhook auto-accepts the remittance when paid.
 */
cashierRouter.post('/merchant/deposits/paymongo', requireCashier, async (req: AuthedRequest, res) => {
  try {
    const ids = Array.isArray(req.body?.collectibleIds)
      ? req.body.collectibleIds
      : String(req.body?.collectibleIds || '')
          .split(',')
          .map((x: string) => Number(x.trim()))
          .filter(Boolean);
    const origin = String(req.headers.origin || req.headers.referer || '')
      .replace(/\/merchant\/?.*$/i, '')
      .replace(/\/$/, '');
    const base =
      origin ||
      String(
        (db.prepare('SELECT public_base_url FROM app_settings WHERE id = 1').get() as any)?.public_base_url || ''
      ).replace(/\/$/, '');
    if (!base) {
      return res.status(400).json({
        error:
          'Public base URL is not configured. Set it under Payment Links so PayMongo can return to the merchant portal.',
      });
    }
    const successUrl = `${base}/merchant?remit=1&paid=1`;
    const cancelUrl = `${base}/merchant?remit=1&canceled=1`;
    const result = await startCashierRemittancePaymongo({
      cashierUserId: req.user!.id,
      cashierUsername: req.user!.username,
      collectibleIds: ids,
      note: req.body?.note,
      successUrl,
      cancelUrl,
    });
    res.status(201).json(result);
  } catch (e: any) {
    res.status(400).json({ error: e?.message || 'Could not start PayMongo remittance' });
  }
});

cashierRouter.post('/merchant/deposits/:id/cancel-paymongo', requireCashier, (req: AuthedRequest, res) => {
  try {
    const deposit = cancelCashierRemittancePaymongo({
      depositId: Number(req.params.id),
      cashierUserId: req.user!.id,
    });
    res.json({ deposit });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || 'Could not cancel remittance' });
  }
});

cashierRouter.post('/merchant/collect', requireCashier, async (req: AuthedRequest, res) => {
  try {
    const userId = Number(req.body?.userId || req.body?.pppoeUserId);
    if (!userId) return res.status(400).json({ error: 'Select a subscriber' });
    const collectionType =
      String(req.body?.collectionType || '').toLowerCase() === 'online' ? 'online' : 'cash';
    const result = await cashierCollectPayment({
      pppoeUserId: userId,
      months: req.body?.months,
      amount: req.body?.amount,
      collectionType,
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

/** Merchant: PayMongo status for the collect UI. */
cashierRouter.get('/merchant/paymongo/status', requireCashier, (_req, res) => {
  res.json(getPublicPayOptions());
});

/**
 * Merchant: start PayMongo checkout for the selected subscriber.
 * Unique checkout session per subscriber/amount; webhook activates + SMS (no remittance queue).
 */
cashierRouter.post('/merchant/collect/paymongo', requireCashier, async (req: AuthedRequest, res) => {
  try {
    const userId = Number(req.body?.userId || req.body?.pppoeUserId);
    if (!userId) return res.status(400).json({ error: 'Select a subscriber' });
    const origin = String(req.headers.origin || req.headers.referer || '')
      .replace(/\/merchant\/?.*$/i, '')
      .replace(/\/$/, '');
    const base =
      origin ||
      String(
        (db.prepare('SELECT public_base_url FROM app_settings WHERE id = 1').get() as any)?.public_base_url || ''
      ).replace(/\/$/, '');
    if (!base) {
      return res.status(400).json({
        error: 'Public base URL is not configured. Set it under Payment Links so PayMongo can return to the merchant portal.',
      });
    }
    const successUrl = `${base}/merchant?paymongo=1&paid=1`;
    const cancelUrl = `${base}/merchant?paymongo=1&canceled=1`;
    const result = await cashierStartPaymongoCheckout({
      pppoeUserId: userId,
      months: req.body?.months,
      amount: req.body?.amount,
      cashier: { id: req.user!.id, username: req.user!.username },
      successUrl,
      cancelUrl,
    });
    res.json(result);
  } catch (e: any) {
    res.status(400).json({ error: e?.message || 'Could not start PayMongo checkout' });
  }
});

// ---- Admin: cashier collectibles / deposits ----
cashierRouter.get('/merchant-collectibles', requireAdmin, (req, res) => {
  const cashierUserId = req.query.cashierUserId ? Number(req.query.cashierUserId) : undefined;
  const status = req.query.status ? String(req.query.status) : undefined;
  res.json({
    collectibles: listCashierCollectibles({
      cashierUserId: Number.isFinite(cashierUserId as number) ? cashierUserId : undefined,
      status: status && status !== 'all' ? status.split(',') : undefined,
      collectionType: 'all',
      limit: 500,
    }),
    summary: cashierCollectibleSummary(
      Number.isFinite(cashierUserId as number) ? (cashierUserId as number) : undefined
    ),
  });
});

cashierRouter.get('/merchant-deposits', requireAdmin, (req, res) => {
  const status = req.query.status ? String(req.query.status) : 'pending';
  res.json({
    deposits: listCashierDeposits({
      status: status === 'all' ? undefined : status.split(','),
      limit: 200,
    }),
  });
});

cashierRouter.get('/merchant-deposits/:id', requireAdmin, (req, res) => {
  const deposit = getCashierDeposit(Number(req.params.id));
  if (!deposit) return res.status(404).json({ error: 'not found' });
  res.json({ deposit });
});

cashierRouter.get('/merchant-deposits/:id/proof', (req: AuthedRequest, res) => {
  // Cashier owner or admin
  const id = Number(req.params.id);
  const deposit = getCashierDeposit(id);
  if (!deposit) return res.status(404).json({ error: 'not found' });
  const isAdmin = /admin/i.test(String(req.user?.role || ''));
  const isOwner = req.user && Number(deposit.cashierUserId) === Number(req.user.id);
  if (!isAdmin && !isOwner) return res.status(403).json({ error: 'Forbidden' });
  const full = resolveDepositProofPath(id);
  if (!full) return res.status(404).json({ error: 'No proof on file' });
  res.sendFile(full);
});
// Legacy proof URL path (older collectible rows / clients)
cashierRouter.get('/cashier-deposits/:id/proof', (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const deposit = getCashierDeposit(id);
  if (!deposit) return res.status(404).json({ error: 'not found' });
  const isAdmin = /admin/i.test(String(req.user?.role || ''));
  const isOwner = req.user && Number(deposit.cashierUserId) === Number(req.user.id);
  if (!isAdmin && !isOwner) return res.status(403).json({ error: 'Forbidden' });
  const full = resolveDepositProofPath(id);
  if (!full) return res.status(404).json({ error: 'No proof on file' });
  res.sendFile(full);
});

cashierRouter.post('/merchant-deposits/:id/accept', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const deposit = acceptCashierDeposit({
      depositId: Number(req.params.id),
      admin: { id: req.user!.id, username: req.user!.username },
      note: req.body?.note,
    });
    res.json({ deposit });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || 'Accept failed' });
  }
});

cashierRouter.post('/merchant-deposits/:id/reject', requireAdmin, (req: AuthedRequest, res) => {
  try {
    const deposit = rejectCashierDeposit({
      depositId: Number(req.params.id),
      admin: { id: req.user!.id, username: req.user!.username },
      note: req.body?.note,
    });
    res.json({ deposit });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || 'Reject failed' });
  }
});

/** Optional: cashier login helper returning mustChangePassword (uses same /login). */
export function cashierLoginExtras(user: any) {
  const partner = isMerchantPartnerRole(user.role);
  return {
    mustChangePassword: Number(user.must_change_password) === 1,
    theme: user.cashier_theme === 'orbital' ? 'orbital' : 'matrix',
    isCashier: partner,
    isMerchantPartner: partner,
  };
}


