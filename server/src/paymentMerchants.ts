import { db } from './db.js';

function columnExists(table: string, col: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return rows.some((r) => r.name === col);
  } catch {
    return false;
  }
}

export function initPaymentMerchants() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_merchants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      photo TEXT,
      address TEXT,
      notes TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_payment_merchants_active
      ON payment_merchants(active, sort_order, id);
  `);
  if (!columnExists('payment_links', 'merchant_id')) {
    try {
      db.exec('ALTER TABLE payment_links ADD COLUMN merchant_id INTEGER');
    } catch {
      /* ignore */
    }
  }
}

export type PaymentMerchant = {
  id: number;
  name: string;
  photo: string | null;
  address: string | null;
  notes: string | null;
  active: boolean;
  sortOrder: number;
  createdAt: string;
};

function mapRow(r: any): PaymentMerchant {
  return {
    id: Number(r.id),
    name: String(r.name || ''),
    photo: r.photo != null ? String(r.photo) : null,
    address: r.address != null ? String(r.address) : null,
    notes: r.notes != null ? String(r.notes) : null,
    active: Number(r.active) !== 0,
    sortOrder: Number(r.sort_order) || 0,
    createdAt: String(r.created_at || ''),
  };
}

export function listPaymentMerchants(opts?: { activeOnly?: boolean }) {
  initPaymentMerchants();
  const rows = opts?.activeOnly
    ? (db
        .prepare(
          `SELECT * FROM payment_merchants WHERE active = 1
           ORDER BY sort_order ASC, id ASC`
        )
        .all() as any[])
    : (db
        .prepare(`SELECT * FROM payment_merchants ORDER BY sort_order ASC, id ASC`)
        .all() as any[]);
  return rows.map(mapRow);
}

export function getPaymentMerchant(id: number) {
  initPaymentMerchants();
  const r = db.prepare('SELECT * FROM payment_merchants WHERE id = ?').get(id) as any;
  return r ? mapRow(r) : null;
}

export function createPaymentMerchant(input: {
  name: string;
  photo?: string | null;
  address?: string | null;
  notes?: string | null;
  active?: boolean;
  sortOrder?: number;
}) {
  initPaymentMerchants();
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Merchant name is required');
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM payment_merchants').get() as {
    m: number;
  };
  const info = db
    .prepare(
      `INSERT INTO payment_merchants (name, photo, address, notes, active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      name,
      input.photo || null,
      input.address?.trim() || null,
      input.notes?.trim() || null,
      input.active === false ? 0 : 1,
      input.sortOrder ?? Number(maxOrder?.m || 0) + 1
    );
  return getPaymentMerchant(Number(info.lastInsertRowid));
}

export function updatePaymentMerchant(
  id: number,
  input: {
    name?: string;
    photo?: string | null;
    address?: string | null;
    notes?: string | null;
    active?: boolean;
    sortOrder?: number;
  }
) {
  initPaymentMerchants();
  const ex = getPaymentMerchant(id);
  if (!ex) throw new Error('Merchant not found');
  const name = input.name !== undefined ? String(input.name).trim() : ex.name;
  if (!name) throw new Error('Merchant name is required');
  db.prepare(
    `UPDATE payment_merchants
     SET name = ?, photo = ?, address = ?, notes = ?, active = ?, sort_order = ?
     WHERE id = ?`
  ).run(
    name,
    input.photo !== undefined ? input.photo : ex.photo,
    input.address !== undefined ? (input.address?.trim() || null) : ex.address,
    input.notes !== undefined ? (input.notes?.trim() || null) : ex.notes,
    input.active !== undefined ? (input.active ? 1 : 0) : ex.active ? 1 : 0,
    input.sortOrder !== undefined ? Number(input.sortOrder) || 0 : ex.sortOrder,
    id
  );
  return getPaymentMerchant(id);
}

export function deletePaymentMerchant(id: number) {
  initPaymentMerchants();
  const info = db.prepare('DELETE FROM payment_merchants WHERE id = ?').run(id);
  return Number(info.changes) > 0;
}
