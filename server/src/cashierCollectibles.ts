import fs from 'fs';
import path from 'path';
import { db } from './db.js';

export type CollectionType = 'cash' | 'online';
export type CollectibleStatus = 'open' | 'submitted' | 'collected' | 'rejected';

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
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at,
    reviewedByUsername: row.reviewed_by_username,
    reviewNote: row.review_note,
  };
}

export function listCashierCollectibles(opts: {
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

/** Cashier submits one or many open collectibles for admin acceptance (with deposit proof). */
export function submitCashierDeposit(opts: {
  cashierUserId: number;
  cashierUsername: string;
  collectibleIds: number[];
  note?: string | null;
  proofImage?: string | null;
}) {
  const ids = [...new Set((opts.collectibleIds || []).map(Number).filter((n) => n > 0))];
  if (!ids.length) throw new Error('Select at least one payment to submit');

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

  const amountTotal = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const mode = rows.length === 1 ? 'single' : 'bulk';

  const run = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO cashier_deposits (
           cashier_user_id, cashier_username, mode, amount_total, item_count, note, status
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending')`
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
  const where = cashierUserId != null ? 'WHERE cashier_user_id = ?' : '';
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
  };
}
