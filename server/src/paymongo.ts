/**
 * PayMongo hosted checkout + webhook fulfillment for subscriber pay links.
 * Docs: https://docs.paymongo.com/docs/payment-channels-hosted-checkout
 */
import crypto from 'crypto';
import { db } from './db.js';
import { markPaymentLinkPaid } from './billing.js';

export type PaymongoSettings = {
  enabled: boolean;
  secretKey: string;
  publicKey: string;
  webhookSecret: string;
  methods: string[];
  secretKeySet: boolean;
  publicKeySet: boolean;
  webhookSecretSet: boolean;
  /** Manual QR + proof upload on the pay page (not PayMongo hosted checkout). */
  manualGcash: boolean;
  manualMaya: boolean;
  /** Cash at merchant + ISP confirmation. */
  manualCash: boolean;
};

const DEFAULT_METHODS = ['gcash', 'paymaya', 'qrph'];

function columnExists(table: string, col: string) {
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((r) => r.name === col);
  } catch {
    return false;
  }
}

export function ensurePaymongoColumns() {
  const cols: [string, string][] = [
    ['paymongo_enabled', 'INTEGER DEFAULT 0'],
    ['paymongo_secret_key', 'TEXT'],
    ['paymongo_public_key', 'TEXT'],
    ['paymongo_webhook_secret', 'TEXT'],
    ['paymongo_methods', "TEXT DEFAULT 'gcash,paymaya,qrph'"],
    ['backup_auto_enabled', 'INTEGER DEFAULT 0'],
    ['backup_auto_hours', 'INTEGER DEFAULT 24'],
    ['backup_retain_count', 'INTEGER DEFAULT 14'],
    ['backup_last_at', 'TEXT'],
    ['fair_use_auto_throttle', 'INTEGER DEFAULT 0'],
    ['fair_use_throttle_profile', 'TEXT'],
  ];
  for (const [col, type] of cols) {
    if (!columnExists('app_settings', col)) {
      db.exec(`ALTER TABLE app_settings ADD COLUMN ${col} ${type}`);
    }
  }
  // Pay-page channel toggles. When PayMongo is already live, prefer hosted checkout
  // over manual GCash/Maya QR proof (cash stays available).
  const addingManual = !columnExists('app_settings', 'pay_manual_gcash');
  for (const [col, type] of [
    ['pay_manual_gcash', 'INTEGER DEFAULT 1'],
    ['pay_manual_maya', 'INTEGER DEFAULT 1'],
    ['pay_manual_cash', 'INTEGER DEFAULT 1'],
  ] as [string, string][]) {
    if (!columnExists('app_settings', col)) {
      db.exec(`ALTER TABLE app_settings ADD COLUMN ${col} ${type}`);
    }
  }
  if (addingManual) {
    const r = db.prepare('SELECT paymongo_enabled FROM app_settings WHERE id = 1').get() as
      | { paymongo_enabled?: number }
      | undefined;
    if (Number(r?.paymongo_enabled) === 1) {
      db.prepare(
        `UPDATE app_settings SET pay_manual_gcash = 0, pay_manual_maya = 0, pay_manual_cash = 1 WHERE id = 1`
      ).run();
    }
  }
  if (!columnExists('payment_links', 'paymongo_checkout_id')) {
    db.exec('ALTER TABLE payment_links ADD COLUMN paymongo_checkout_id TEXT');
  }
}

function row() {
  ensurePaymongoColumns();
  return db.prepare('SELECT * FROM app_settings WHERE id = 1').get() as any;
}

export function getPaymongoSettings(): PaymongoSettings {
  const r = row();
  const methods = String(r.paymongo_methods || DEFAULT_METHODS.join(','))
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return {
    enabled: Number(r.paymongo_enabled) === 1,
    secretKey: '',
    publicKey: '',
    webhookSecret: '',
    methods: methods.length ? methods : [...DEFAULT_METHODS],
    secretKeySet: !!r.paymongo_secret_key,
    publicKeySet: !!r.paymongo_public_key,
    webhookSecretSet: !!r.paymongo_webhook_secret,
    manualGcash: r.pay_manual_gcash == null ? true : Number(r.pay_manual_gcash) === 1,
    manualMaya: r.pay_manual_maya == null ? true : Number(r.pay_manual_maya) === 1,
    manualCash: r.pay_manual_cash == null ? true : Number(r.pay_manual_cash) === 1,
  };
}

/** Public pay-page options (safe to expose without secrets). */
export function getPublicPayOptions() {
  const s = getPaymongoSettings();
  const paymongoLive = s.enabled && s.secretKeySet;
  return {
    paymongo: paymongoLive,
    methods: paymongoLive ? s.methods : [],
    manualGcash: s.manualGcash,
    manualMaya: s.manualMaya,
    manualCash: s.manualCash,
  };
}

export function assertManualChannelAllowed(channel: string) {
  const s = getPaymongoSettings();
  const ch = String(channel || '').toLowerCase().trim();
  if (ch === 'gcash' && !s.manualGcash) {
    throw new Error('Manual GCash proof is disabled. Pay online with PayMongo or choose Cash.');
  }
  if (ch === 'maya' && !s.manualMaya) {
    throw new Error('Manual Maya proof is disabled. Pay online with PayMongo or choose Cash.');
  }
  if (ch === 'cash' && !s.manualCash) {
    throw new Error('Cash payment is disabled on this portal.');
  }
}

export function updatePaymongoSettings(patch: Record<string, unknown>) {
  ensurePaymongoColumns();
  const cur = row();
  const enabled =
    patch.enabled != null ? (patch.enabled ? 1 : 0) : Number(cur.paymongo_enabled) === 1 ? 1 : 0;
  const methods = Array.isArray(patch.methods)
    ? (patch.methods as string[]).map(String).join(',')
    : patch.methods != null
      ? String(patch.methods)
      : cur.paymongo_methods || DEFAULT_METHODS.join(',');
  const secret =
    patch.secretKey != null && String(patch.secretKey).trim()
      ? String(patch.secretKey).trim()
      : cur.paymongo_secret_key;
  const pub =
    patch.publicKey != null && String(patch.publicKey).trim()
      ? String(patch.publicKey).trim()
      : cur.paymongo_public_key;
  const wh =
    patch.webhookSecret != null && String(patch.webhookSecret).trim()
      ? String(patch.webhookSecret).trim()
      : cur.paymongo_webhook_secret;
  const manualGcash =
    patch.manualGcash != null
      ? patch.manualGcash
        ? 1
        : 0
      : cur.pay_manual_gcash == null
        ? 1
        : Number(cur.pay_manual_gcash) === 1
          ? 1
          : 0;
  const manualMaya =
    patch.manualMaya != null
      ? patch.manualMaya
        ? 1
        : 0
      : cur.pay_manual_maya == null
        ? 1
        : Number(cur.pay_manual_maya) === 1
          ? 1
          : 0;
  const manualCash =
    patch.manualCash != null
      ? patch.manualCash
        ? 1
        : 0
      : cur.pay_manual_cash == null
        ? 1
        : Number(cur.pay_manual_cash) === 1
          ? 1
          : 0;
  db.prepare(
    `UPDATE app_settings SET paymongo_enabled = ?, paymongo_secret_key = ?, paymongo_public_key = ?,
       paymongo_webhook_secret = ?, paymongo_methods = ?,
       pay_manual_gcash = ?, pay_manual_maya = ?, pay_manual_cash = ? WHERE id = 1`
  ).run(enabled, secret || null, pub || null, wh || null, methods, manualGcash, manualMaya, manualCash);
  return getPaymongoSettings();
}

function secretKey(): string {
  const r = row();
  return String(r.paymongo_secret_key || '').trim();
}

function authHeader(sk: string) {
  return `Basic ${Buffer.from(`${sk}:`).toString('base64')}`;
}

/** Create a PayMongo Checkout Session v2 for a pending payment link. */
export async function createPaymongoCheckout(opts: {
  token: string;
  successUrl: string;
  cancelUrl: string;
}) {
  ensurePaymongoColumns();
  const s = row();
  if (Number(s.paymongo_enabled) !== 1) throw new Error('PayMongo is not enabled');
  const sk = String(s.paymongo_secret_key || '').trim();
  if (!sk) throw new Error('PayMongo secret key is not configured');

  const link = db.prepare('SELECT * FROM payment_links WHERE token = ?').get(opts.token) as any;
  if (!link) throw new Error('Payment link not found');
  if (link.status === 'paid') throw new Error('Already paid');
  if (link.status === 'expired' || (link.expires_at && Date.parse(link.expires_at) < Date.now())) {
    throw new Error('Payment link expired');
  }
  const amountCentavos = Math.round(Number(link.amount) * 100);
  if (!Number.isFinite(amountCentavos) || amountCentavos < 1000) {
    throw new Error('Amount must be at least ₱10.00 for PayMongo');
  }

  const user = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(link.pppoe_user_id) as any;
  const methods = String(s.paymongo_methods || DEFAULT_METHODS.join(','))
    .split(',')
    .map((x: string) => x.trim().toLowerCase())
    .filter(Boolean);

  const body = {
    data: {
      attributes: {
        send_email_receipt: false,
        show_description: true,
        show_line_items: true,
        description: `Internet payment — ${user?.username || user?.account_number || 'subscriber'}`,
        line_items: [
          {
            name: `${link.months || 1} month subscription`,
            quantity: 1,
            amount: amountCentavos,
            currency: 'PHP',
          },
        ],
        payment_method_types: methods.length ? methods : DEFAULT_METHODS,
        success_url: opts.successUrl,
        cancel_url: opts.cancelUrl,
        reference_number: opts.token,
        metadata: {
          payment_link_token: opts.token,
          payment_link_id: String(link.id),
          pppoe_user_id: String(link.pppoe_user_id),
        },
      },
    },
  };

  const r = await fetch('https://api.paymongo.com/v2/checkout_sessions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader(sk),
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!r.ok) {
    const err =
      data?.errors?.[0]?.detail || data?.errors?.[0]?.title || text.slice(0, 200) || `HTTP ${r.status}`;
    throw new Error(`PayMongo: ${err}`);
  }

  const session = data?.data;
  const checkoutId = session?.id;
  const checkoutUrl = session?.attributes?.checkout_url;
  if (!checkoutUrl) throw new Error('PayMongo did not return a checkout URL');

  db.prepare(
    `UPDATE payment_links SET paymongo_checkout_id = ?, pay_channel = COALESCE(pay_channel, 'paymongo') WHERE id = ?`
  ).run(checkoutId || null, link.id);

  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
    'info',
    'paymongo',
    `Checkout created for token ${opts.token.slice(0, 8)}… · ${checkoutId || 'no-id'} · ₱${Number(link.amount).toFixed(2)}`
  );

  return { checkoutId, checkoutUrl, token: opts.token };
}

function timingSafeEqualStr(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Verify PayMongo webhook signature (paymongo-signature header). */
export function verifyPaymongoSignature(rawBody: string, signatureHeader: string | undefined): boolean {
  const wh = String(row().paymongo_webhook_secret || '').trim();
  if (!wh) return true; // allow if secret not set (dev); prefer setting it in production
  if (!signatureHeader) return false;
  // Format: t=timestamp,te=test_sig,li=live_sig
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => {
      const [k, ...rest] = p.trim().split('=');
      return [k, rest.join('=')];
    })
  );
  const t = parts.t || '';
  const sig = parts.li || parts.te || '';
  if (!t || !sig) return false;
  const expected = crypto.createHmac('sha256', wh).update(`${t}.${rawBody}`).digest('hex');
  return timingSafeEqualStr(expected, sig);
}

/** Fulfill a paid checkout — activates the subscriber via markPaymentLinkPaid. */
export async function handlePaymongoWebhook(payload: any) {
  ensurePaymongoColumns();
  const type = String(payload?.data?.attributes?.type || payload?.data?.type || payload?.type || '');
  const eventData = payload?.data?.attributes?.data || payload?.data?.data || payload?.data;

  const isPaid =
    type.includes('payment.paid') ||
    type === 'checkout_session.payment.paid' ||
    String(eventData?.attributes?.status || '').toLowerCase() === 'paid';

  if (!isPaid && !type.includes('paid')) {
    return { ok: true, ignored: true, type };
  }

  const attrs = eventData?.attributes || {};
  const token =
    attrs.reference_number ||
    attrs.metadata?.payment_link_token ||
    attrs.payment_intent?.attributes?.metadata?.payment_link_token ||
    null;

  const checkoutId = eventData?.id || attrs.checkout_session_id || null;
  let resolvedToken = token ? String(token) : null;

  if (!resolvedToken && checkoutId) {
    const rowLink = db
      .prepare('SELECT token FROM payment_links WHERE paymongo_checkout_id = ?')
      .get(String(checkoutId)) as { token?: string } | undefined;
    resolvedToken = rowLink?.token || null;
  }

  if (!resolvedToken) {
    db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
      'warning',
      'paymongo',
      `Webhook paid event missing payment link token (type=${type})`
    );
    return { ok: false, error: 'missing payment link reference' };
  }

  const payments = attrs.payments || [];
  const payId = payments[0]?.id || attrs.payment_intent?.id || checkoutId || 'paymongo';
  const sourceType = payments[0]?.attributes?.source?.type || payments[0]?.attributes?.source?.id || 'paymongo';

  try {
    db.prepare(
      `UPDATE payment_links SET pay_channel = ?, external_ref = COALESCE(?, external_ref) WHERE token = ?`
    ).run(String(sourceType).slice(0, 32), String(payId), resolvedToken);

    const result = await markPaymentLinkPaid(resolvedToken, String(payId));
    db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
      'info',
      'paymongo',
      `Payment confirmed · token ${resolvedToken.slice(0, 8)}… · ${payId}${result.alreadyPaid ? ' (already paid)' : ''}`
    );
    return { ok: true, alreadyPaid: !!result.alreadyPaid, token: resolvedToken, paymentId: payId };
  } catch (e: any) {
    db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
      'warning',
      'paymongo',
      `Webhook fulfill failed for ${resolvedToken.slice(0, 8)}…: ${e?.message || e}`
    );
    throw e;
  }
}

export function getBackupAutoSettings() {
  ensurePaymongoColumns();
  const r = row();
  return {
    enabled: Number(r.backup_auto_enabled) === 1,
    everyHours: Math.max(1, Number(r.backup_auto_hours) || 24),
    retainCount: Math.max(1, Number(r.backup_retain_count) || 14),
    lastAt: r.backup_last_at || null,
  };
}

export function updateBackupAutoSettings(patch: {
  enabled?: boolean;
  everyHours?: number;
  retainCount?: number;
}) {
  ensurePaymongoColumns();
  const cur = getBackupAutoSettings();
  const enabled = patch.enabled != null ? (patch.enabled ? 1 : 0) : cur.enabled ? 1 : 0;
  const hours = patch.everyHours != null ? Math.max(1, Number(patch.everyHours) || 24) : cur.everyHours;
  const retain = patch.retainCount != null ? Math.max(1, Number(patch.retainCount) || 14) : cur.retainCount;
  db.prepare(
    `UPDATE app_settings SET backup_auto_enabled = ?, backup_auto_hours = ?, backup_retain_count = ? WHERE id = 1`
  ).run(enabled, hours, retain);
  return getBackupAutoSettings();
}

export function getFairUseThrottleSettings() {
  ensurePaymongoColumns();
  const r = row();
  return {
    autoThrottle: Number(r.fair_use_auto_throttle) === 1,
    throttleProfile: String(r.fair_use_throttle_profile || '').trim() || null,
  };
}

export function updateFairUseThrottleSettings(patch: { autoThrottle?: boolean; throttleProfile?: string | null }) {
  ensurePaymongoColumns();
  const cur = getFairUseThrottleSettings();
  const auto = patch.autoThrottle != null ? (patch.autoThrottle ? 1 : 0) : cur.autoThrottle ? 1 : 0;
  const profile =
    patch.throttleProfile !== undefined ? String(patch.throttleProfile || '').trim() || null : cur.throttleProfile;
  db.prepare(
    `UPDATE app_settings SET fair_use_auto_throttle = ?, fair_use_throttle_profile = ? WHERE id = 1`
  ).run(auto, profile);
  return getFairUseThrottleSettings();
}
