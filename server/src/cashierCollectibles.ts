import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { db } from './db.js';

export type CollectionType = 'cash' | 'online';
export type CollectibleStatus = 'open' | 'submitted' | 'collected' | 'rejected';

function columnExists(table: string, col: string) {
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((r) => r.name === col);
  } catch {
    return false;
  }
}

/** PayMongo remittance columns on cashier_deposits + close legacy online remittance rows. */
export function ensureCashierRemittanceColumns() {
  const cols: [string, string][] = [
    ['paymongo_checkout_id', 'TEXT'],
    ['remit_token', 'TEXT'],
    ['pay_channel', "TEXT DEFAULT 'manual'"],
  ];
  for (const [col, type] of cols) {
    if (!columnExists('cashier_deposits', col)) {
      try {
        db.exec(`ALTER TABLE cashier_deposits ADD COLUMN ${col} ${type}`);
      } catch {
        /* ignore */
      }
    }
  }
  // Online / PayMongo subscriber payments settle to the ISP — never queue for remittance.
  try {
    db.prepare(
      `UPDATE cashier_collectibles
       SET status = 'collected', collected_at = COALESCE(collected_at, datetime('now'))
       WHERE lower(collection_type) = 'online' AND status IN ('open', 'submitted')`
    ).run();
  } catch {
    /* ignore */
  }
}

function saveDepositProof(raw: string | null | undefined, depositId: number): string | null {
  if (!raw || typeof raw !== 'string' || !raw.startsWith('data:image/')) return null;
  const m = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!m) throw new Error('Invalid deposit proof format');
  const mime = m[1].toLowerCase();
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 6 * 1024 * 1024) throw new Error('Deposit proof must be 6MB or smaller');
  const dir = path.resolve(process.cwd(), 'data', 'cashier-deposits');
  fs.mkdirSync(dir, { recursive: true });
  const file = `deposit-${depositId}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(dir, file), buf);
  return `cashier-deposits/${file}`;
}

export function createCashierCollectible(opts: {
  cashierUserId: number;
  cashierUsername: string;
  paymentLinkId?: number | null;
  transactionId?: number | null;
  pppoeUserId: number;
  amount: number;
  months: number;
  collectionType: CollectionType;
  payChannel?: string | null;
  externalRef?: string | null;
  subscriberUsername?: string | null;
  customerName?: string | null;
  accountNumber?: string | null;
}) {
  const collectionType: CollectionType =
    String(opts.collectionType || '').toLowerCase() === 'online' ? 'online' : 'cash';
  // Only cash is remitted by the merchant. Online / PayMongo funds are already with the ISP.
  if (collectionType !== 'cash') return null;
  ensureCashierRemittanceColumns();
  const info = db
    .prepare(
      `INSERT INTO cashier_collectibles (
         cashier_user_id, cashier_username, payment_link_id, transaction_id, pppoe_user_id,
         amount, months, collection_type, pay_channel, external_ref,
         subscriber_username, customer_name, account_number, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`
    )
    .run(
      opts.cashierUserId,
      opts.cashierUsername,
      opts.paymentLinkId ?? null,
      opts.transactionId ?? null,
      opts.pppoeUserId,
      Number(opts.amount) || 0,
      Math.max(1, Math.floor(Number(opts.months) || 1)),
      collectionType,
      opts.payChannel || null,
      opts.externalRef || null,
      opts.subscriberUsername || null,
      opts.customerName || null,
      opts.accountNumber || null
    );
  return Number(info.lastInsertRowid);
}

function mapCollectible(row: any) {
  return {
    id: row.id,
    cashierUserId: row.cashier_user_id,
    cashierUsername: row.cashier_username,
    paymentLinkId: row.payment_link_id,
    transactionId: row.transaction_id,
    pppoeUserId: row.pppoe_user_id,
    amount: row.amount,
    months: row.months,
    collectionType: row.collection_type,
    payChannel: row.pay_channel,
    externalRef: row.external_ref,
    subscriberUsername: row.subscriber_username,
    customerName: row.customer_name,
    accountNumber: row.account_number,
    status: row.status,
    depositId: row.deposit_id,
    createdAt: row.created_at,
    collectedAt: row.collected_at,
  };
}

function mapDeposit(row: any) {
  return {
    id: row.id,
    cashierUserId: row.cashier_user_id,
    cashierUsername: row.cashier_username,
    mode: row.mode,
    amountTotal: row.amount_total,
    itemCount: row.item_count,
    note: row.note,
    proofImage: row.proof_image,
    proofUrl: row.proof_image ? `/api/merchant-deposits/${row.id}/proof` : null,
    status: row.status,
    payChannel: row.pay_channel || 'manual',
    paymongoCheckoutId: row.paymongo_checkout_id || null,
    remitToken: row.remit_token || null,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    reviewedByUsername: row.reviewed_by_username,
    reviewNote: row.review_note,
  };
}

export function listCashierCollectibles(opts: {
  cashierUserId?: number;
  status?: string | string[];
  /** Default: cash only (online settles directly and is not remitted). */
  collectionType?: CollectionType | 'all';
  limit?: number;
}) {
  ensureCashierRemittanceColumns();
  const where: string[] = [];
  const params: any[] = [];
  if (opts.cashierUserId != null) {
    where.push('cashier_user_id = ?');
    params.push(opts.cashierUserId);
  }
  const ct = opts.collectionType || 'cash';
  if (ct !== 'all') {
    where.push('lower(collection_type) = ?');
    params.push(ct);
  }
  if (opts.status) {
    const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
    where.push(`status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(500, Math.max(1, Number(opts.limit) || 200));
  const rows = db
    .prepare(
      `SELECT * FROM cashier_collectibles ${whereSql} ORDER BY id DESC LIMIT ?`
    )
    .all(...params, limit) as any[];
  return rows.map(mapCollectible);
}

export function listCashierDeposits(opts: {
  cashierUserId?: number;
  status?: string | string[];
  limit?: number;
}) {
  const where: string[] = [];
  const params: any[] = [];
  if (opts.cashierUserId != null) {
    where.push('cashier_user_id = ?');
    params.push(opts.cashierUserId);
  }
  if (opts.status) {
    const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
    where.push(`status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 100));
  const rows = db
    .prepare(`SELECT * FROM cashier_deposits ${whereSql} ORDER BY id DESC LIMIT ?`)
    .all(...params, limit) as any[];
  return rows.map(mapDeposit);
}

export function getCashierDeposit(id: number) {
  const row = db.prepare('SELECT * FROM cashier_deposits WHERE id = ?').get(id) as any;
  if (!row) return null;
  const items = db
    .prepare('SELECT * FROM cashier_collectibles WHERE deposit_id = ? ORDER BY id')
    .all(id)
    .map(mapCollectible);
  return { ...mapDeposit(row), items };
}

/** Cashier submits one or many open cash collectibles for admin acceptance (with deposit proof). */
export function submitCashierDeposit(opts: {
  cashierUserId: number;
  cashierUsername: string;
  collectibleIds: number[];
  note?: string | null;
  proofImage?: string | null;
}) {
  ensureCashierRemittanceColumns();
  const ids = [...new Set((opts.collectibleIds || []).map(Number).filter((n) => n > 0))];
  if (!ids.length) throw new Error('Select at least one cash payment to remit');

  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT * FROM cashier_collectibles
       WHERE id IN (${placeholders}) AND cashier_user_id = ? AND status = 'open'`
    )
    .all(...ids, opts.cashierUserId) as any[];

  if (rows.length !== ids.length) {
    throw new Error('Some selected payments are missing or already submitted');
  }
  if (rows.some((r) => String(r.collection_type || '').toLowerCase() !== 'cash')) {
    throw new Error('Only cash collections are remitted. Online payments settle directly to the ISP.');
  }

  const amountTotal = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const mode = rows.length === 1 ? 'single' : 'bulk';

  const run = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO cashier_deposits (
           cashier_user_id, cashier_username, mode, amount_total, item_count, note, status, pay_channel
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 'manual')`
      )
      .run(
        opts.cashierUserId,
        opts.cashierUsername,
        mode,
        amountTotal,
        rows.length,
        opts.note ? String(opts.note).trim() || null : null
      );
    const depositId = Number(info.lastInsertRowid);

    let proofPath: string | null = null;
    try {
      proofPath = saveDepositProof(opts.proofImage, depositId);
    } catch (e) {
      throw e;
    }
    if (proofPath) {
      db.prepare('UPDATE cashier_deposits SET proof_image = ? WHERE id = ?').run(proofPath, depositId);
    }

    db.prepare(
      `UPDATE cashier_collectibles SET status = 'submitted', deposit_id = ? WHERE id IN (${placeholders})`
    ).run(depositId, ...ids);

    return depositId;
  });

  const depositId = run();
  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
    'info',
    'cashier',
    `Cashier ${opts.cashierUsername} submitted ${mode} deposit #${depositId}: ${rows.length} payment(s), ₱${amountTotal}`
  );
  return getCashierDeposit(depositId);
}

/**
 * Merchant remits selected cash collectibles via PayMongo (funds go to ISP).
 * Creates an awaiting_payment deposit and returns a checkout URL.
 */
export async function startCashierRemittancePaymongo(opts: {
  cashierUserId: number;
  cashierUsername: string;
  collectibleIds: number[];
  note?: string | null;
  successUrl: string;
  cancelUrl: string;
}) {
  ensureCashierRemittanceColumns();
  const { getPublicPayOptions, createPaymongoCheckoutSession } = await import('./paymongo.js');
  if (!getPublicPayOptions().paymongo) throw new Error('PayMongo is not enabled on this panel');

  const ids = [...new Set((opts.collectibleIds || []).map(Number).filter((n) => n > 0))];
  if (!ids.length) throw new Error('Select at least one cash payment to remit');

  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT * FROM cashier_collectibles
       WHERE id IN (${placeholders}) AND cashier_user_id = ? AND status = 'open'`
    )
    .all(...ids, opts.cashierUserId) as any[];

  if (rows.length !== ids.length) {
    throw new Error('Some selected payments are missing or already submitted');
  }
  if (rows.some((r) => String(r.collection_type || '').toLowerCase() !== 'cash')) {
    throw new Error('Only cash collections are remitted via PayMongo');
  }

  const amountTotal = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  if (amountTotal < 10) throw new Error('Remittance total must be at least ₱10.00 for PayMongo');
  const mode = rows.length === 1 ? 'single' : 'bulk';

  const depositId = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO cashier_deposits (
           cashier_user_id, cashier_username, mode, amount_total, item_count, note, status, pay_channel
         ) VALUES (?, ?, ?, ?, ?, ?, 'awaiting_payment', 'paymongo')`
      )
      .run(
        opts.cashierUserId,
        opts.cashierUsername,
        mode,
        amountTotal,
        rows.length,
        opts.note ? String(opts.note).trim() || null : null
      );
    const id = Number(info.lastInsertRowid);
    const remitToken = `crmt${id}x${crypto.randomBytes(4).toString('hex')}`;
    db.prepare('UPDATE cashier_deposits SET remit_token = ? WHERE id = ?').run(remitToken, id);
    db.prepare(
      `UPDATE cashier_collectibles SET status = 'submitted', deposit_id = ? WHERE id IN (${placeholders})`
    ).run(id, ...ids);
    return id;
  })();

  const deposit = db.prepare('SELECT * FROM cashier_deposits WHERE id = ?').get(depositId) as any;
  const remitToken = String(deposit.remit_token);
  const cancelUrl = opts.cancelUrl.includes('deposit=')
    ? opts.cancelUrl
    : `${opts.cancelUrl}${opts.cancelUrl.includes('?') ? '&' : '?'}deposit=${depositId}`;

  try {
    const checkout = await createPaymongoCheckoutSession({
      amount: amountTotal,
      description: `Merchant cash remittance — ${opts.cashierUsername}`,
      lineItemName: `Cash remittance (${rows.length} payment${rows.length === 1 ? '' : 's'})`,
      referenceNumber: remitToken,
      successUrl: opts.successUrl,
      cancelUrl,
      metadata: {
        kind: 'cashier_remittance',
        deposit_id: String(depositId),
        cashier_user_id: String(opts.cashierUserId),
        remit_token: remitToken,
      },
    });
    db.prepare('UPDATE cashier_deposits SET paymongo_checkout_id = ? WHERE id = ?').run(
      checkout.checkoutId || null,
      depositId
    );
    db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
      'info',
      'cashier',
      `Cashier ${opts.cashierUsername} started PayMongo remittance #${depositId}: ${rows.length} cash payment(s), ₱${amountTotal}`
    );
    return {
      deposit: getCashierDeposit(depositId),
      checkoutUrl: checkout.checkoutUrl,
      checkoutId: checkout.checkoutId,
      remitToken,
    };
  } catch (e) {
    cancelCashierRemittancePaymongo({ depositId, cashierUserId: opts.cashierUserId });
    throw e;
  }
}

/** PayMongo paid → mark remittance deposit accepted and cash collectibles collected. */
export function fulfillCashierRemittancePaymongo(opts: {
  remitToken?: string | null;
  checkoutId?: string | null;
  paymentId?: string | null;
}) {
  ensureCashierRemittanceColumns();
  let deposit: any = null;
  if (opts.remitToken) {
    deposit = db.prepare('SELECT * FROM cashier_deposits WHERE remit_token = ?').get(String(opts.remitToken));
  }
  if (!deposit && opts.checkoutId) {
    deposit = db
      .prepare('SELECT * FROM cashier_deposits WHERE paymongo_checkout_id = ?')
      .get(String(opts.checkoutId));
  }
  if (!deposit) throw new Error('Remittance deposit not found');
  if (deposit.status === 'accepted') {
    return { ok: true, alreadyPaid: true, deposit: getCashierDeposit(deposit.id) };
  }
  if (deposit.status !== 'awaiting_payment' && deposit.status !== 'pending') {
    throw new Error(`Remittance deposit is ${deposit.status}`);
  }

  const note = opts.paymentId
    ? `Paid via PayMongo (${opts.paymentId})`
    : 'Paid via PayMongo';

  db.transaction(() => {
    db.prepare(
      `UPDATE cashier_deposits SET
         status = 'accepted',
         reviewed_at = datetime('now'),
         reviewed_by_username = 'paymongo',
         review_note = ?
       WHERE id = ?`
    ).run(note, deposit.id);
    db.prepare(
      `UPDATE cashier_collectibles SET status = 'collected', collected_at = datetime('now')
       WHERE deposit_id = ? AND status = 'submitted'`
    ).run(deposit.id);
  })();

  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
    'info',
    'cashier',
    `PayMongo remittance accepted deposit #${deposit.id} from ${deposit.cashier_username} (₱${deposit.amount_total})`
  );
  return { ok: true, alreadyPaid: false, deposit: getCashierDeposit(deposit.id) };
}

/** Cancel an unpaid PayMongo remittance and reopen cash collectibles. */
export function cancelCashierRemittancePaymongo(opts: { depositId: number; cashierUserId?: number }) {
  ensureCashierRemittanceColumns();
  const deposit = db.prepare('SELECT * FROM cashier_deposits WHERE id = ?').get(opts.depositId) as any;
  if (!deposit) throw new Error('Deposit not found');
  if (opts.cashierUserId != null && Number(deposit.cashier_user_id) !== Number(opts.cashierUserId)) {
    throw new Error('Deposit not found');
  }
  if (deposit.status === 'accepted') return getCashierDeposit(opts.depositId);
  if (deposit.status !== 'awaiting_payment') {
    throw new Error(`Deposit is ${deposit.status}`);
  }

  db.transaction(() => {
    db.prepare(
      `UPDATE cashier_deposits SET
         status = 'cancelled',
         reviewed_at = datetime('now'),
         review_note = COALESCE(review_note, 'PayMongo checkout canceled')
       WHERE id = ?`
    ).run(opts.depositId);
    db.prepare(
      `UPDATE cashier_collectibles SET status = 'open', deposit_id = NULL
       WHERE deposit_id = ? AND status = 'submitted'`
    ).run(opts.depositId);
  })();

  return getCashierDeposit(opts.depositId);
}

export function acceptCashierDeposit(opts: {
  depositId: number;
  admin: { id: number; username: string };
  note?: string | null;
}) {
  const deposit = db.prepare('SELECT * FROM cashier_deposits WHERE id = ?').get(opts.depositId) as any;
  if (!deposit) throw new Error('Deposit not found');
  if (deposit.status === 'accepted') return getCashierDeposit(opts.depositId);
  if (deposit.status !== 'pending') throw new Error(`Deposit is ${deposit.status}`);

  const run = db.transaction(() => {
    db.prepare(
      `UPDATE cashier_deposits SET
         status = 'accepted',
         reviewed_at = datetime('now'),
         reviewed_by_user_id = ?,
         reviewed_by_username = ?,
         review_note = ?
       WHERE id = ?`
    ).run(opts.admin.id, opts.admin.username, opts.note || null, opts.depositId);

    db.prepare(
      `UPDATE cashier_collectibles SET status = 'collected', collected_at = datetime('now')
       WHERE deposit_id = ? AND status = 'submitted'`
    ).run(opts.depositId);
  });
  run();

  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
    'info',
    'cashier',
    `Admin ${opts.admin.username} accepted cashier deposit #${opts.depositId} from ${deposit.cashier_username} (₱${deposit.amount_total})`
  );
  return getCashierDeposit(opts.depositId);
}

export function rejectCashierDeposit(opts: {
  depositId: number;
  admin: { id: number; username: string };
  note?: string | null;
}) {
  const deposit = db.prepare('SELECT * FROM cashier_deposits WHERE id = ?').get(opts.depositId) as any;
  if (!deposit) throw new Error('Deposit not found');
  if (deposit.status !== 'pending') throw new Error(`Deposit is ${deposit.status}`);

  const run = db.transaction(() => {
    db.prepare(
      `UPDATE cashier_deposits SET
         status = 'rejected',
         reviewed_at = datetime('now'),
         reviewed_by_user_id = ?,
         reviewed_by_username = ?,
         review_note = ?
       WHERE id = ?`
    ).run(opts.admin.id, opts.admin.username, opts.note || null, opts.depositId);

    // Return collectibles to open so cashier can resubmit
    db.prepare(
      `UPDATE cashier_collectibles SET status = 'open', deposit_id = NULL
       WHERE deposit_id = ? AND status = 'submitted'`
    ).run(opts.depositId);
  });
  run();

  return getCashierDeposit(opts.depositId);
}

export function resolveDepositProofPath(depositId: number): string | null {
  const row = db.prepare('SELECT proof_image FROM cashier_deposits WHERE id = ?').get(depositId) as
    | { proof_image: string | null }
    | undefined;
  if (!row?.proof_image) return null;
  const full = path.resolve(process.cwd(), 'data', row.proof_image);
  if (!full.startsWith(path.resolve(process.cwd(), 'data'))) return null;
  return fs.existsSync(full) ? full : null;
}

export function cashierCollectibleSummary(cashierUserId?: number) {
  ensureCashierRemittanceColumns();
  // Remittance queue is cash-only.
  const where =
    cashierUserId != null
      ? `WHERE cashier_user_id = ? AND lower(collection_type) = 'cash'`
      : `WHERE lower(collection_type) = 'cash'`;
  const params = cashierUserId != null ? [cashierUserId] : [];
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
       FROM cashier_collectibles ${where}
       GROUP BY status`
    )
    .all(...params) as { status: string; count: number; total: number }[];
  const byStatus: Record<string, { count: number; total: number }> = {};
  for (const r of rows) byStatus[r.status] = { count: r.count, total: r.total };
  return {
    open: byStatus.open || { count: 0, total: 0 },
    submitted: byStatus.submitted || { count: 0, total: 0 },
    collected: byStatus.collected || { count: 0, total: 0 },
    awaitingPayment: byStatus.awaiting_payment || { count: 0, total: 0 },
  };
}
