/**
 * Data feed for the admin Command Center home page.
 *
 * The page filters, slices and re-aggregates in the browser, so this returns
 * one compact row per subscriber (already classified and risk-scored) plus the
 * recent payments, instead of pre-baked totals that would not survive a filter.
 */
import { db } from './db.js';
import { isExpiredAccount, isNonPaymentAccount } from './notify.js';

export type CcState = 'active' | 'non-payment' | 'expired' | 'disabled' | 'inactive';
export type CcPaid = 'paid' | 'late' | 'unpaid' | 'covered' | 'none';
export type CcFlag =
  | 'overdue'
  | 'due-today'
  | 'due-soon'
  | 'offline'
  | 'paid-offline'
  | 'online-unpaid'
  | 'late-payer'
  | 'balance'
  | 'non-payment'
  | 'expired';

export type CcSubscriber = {
  id: number;
  user: string;
  name: string;
  account: string;
  plan: string;
  price: number;
  state: CcState;
  online: boolean;
  due: string | null;
  dueIn: number | null;
  lat: number | null;
  lng: number | null;
  routerId: number | null;
  router: string;
  nap: string;
  balance: number;
  paidMonth: number;
  lastPaid: string | null;
  late90: number;
  paid: CcPaid;
  risk: number;
  flags: CcFlag[];
};

/** [subscriberId, amount, YYYY-MM-DD, late 0|1] */
export type CcPayment = [number, number, string, 0 | 1];

export type CommandCenterFeed = {
  generatedAt: string;
  today: string;
  monthStart: string;
  prevMonthStart: string;
  routers: { id: number; name: string }[];
  subscribers: CcSubscriber[];
  payments: CcPayment[];
};

function day(value: string | null | undefined): string {
  const s = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

function shiftDay(from: string, delta: number): string {
  return new Date(Date.parse(`${from}T00:00:00Z`) + delta * 86400000).toISOString().slice(0, 10);
}

function prevMonthStartOf(today: string): string {
  const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function stateOf(row: {
  status: string | null;
  subscription_due: string | null;
  nonpayment_since: string | null;
  expiration_profile: string | null;
}): CcState {
  const panel = String(row.status || '')
    .toLowerCase()
    .replace(/\s+/g, '-');
  if (panel === 'disabled' && !row.nonpayment_since) return 'disabled';
  if (panel === 'inactive') return 'inactive';
  const shape = {
    status: row.status,
    subscription_due: row.subscription_due,
    nonpayment_since: row.nonpayment_since,
    expiration_profile: row.expiration_profile,
  };
  if (panel === 'expired') return 'expired';
  if (isNonPaymentAccount(shape)) return 'non-payment';
  if (isExpiredAccount(shape)) return 'expired';
  if (panel === 'disabled') return 'disabled';
  return 'active';
}

function lateOf(receiptJson: string | null, createdAt: string): 0 | 1 {
  if (!receiptJson) return 0;
  try {
    const receipt = JSON.parse(receiptJson);
    if (receipt?.correction) return 0;
    const previousDue = day(receipt.previousDue);
    const paidOn = day(receipt.paymentDate || createdAt);
    return previousDue && paidOn && paidOn > previousDue ? 1 : 0;
  } catch {
    return 0;
  }
}

/**
 * Explainable 0-100 score for "who should staff look at first". Every point
 * comes from a flag the page also shows, so a high score is never a black box.
 */
export function scoreRisk(input: {
  state: CcState;
  online: boolean;
  dueIn: number | null;
  balance: number;
  paid: CcPaid;
  late90: number;
}): { risk: number; flags: CcFlag[] } {
  if (input.state === 'disabled' || input.state === 'inactive') return { risk: 0, flags: [] };
  const flags: CcFlag[] = [];
  let risk = 0;
  const settled = input.paid === 'paid' || input.paid === 'late' || input.paid === 'covered';

  if (input.state === 'expired') {
    flags.push('expired');
    risk += 25;
  } else if (input.state === 'non-payment') {
    flags.push('non-payment');
    risk += 20;
  }

  if (!settled || input.balance > 0.009) {
    if (input.dueIn != null && input.dueIn < 0) {
      flags.push('overdue');
      risk += Math.min(40, 10 + Math.abs(input.dueIn) * 2);
      if (input.online) flags.push('online-unpaid');
    } else if (input.dueIn === 0) {
      flags.push('due-today');
      risk += 14;
    } else if (input.dueIn != null && input.dueIn <= 3) {
      flags.push('due-soon');
      risk += 8;
    }
  } else if (input.dueIn != null && input.dueIn >= 0 && input.dueIn <= 3) {
    flags.push('due-soon');
    risk += 4;
  }

  if (input.balance > 0.009) {
    flags.push('balance');
    risk += 10;
  }

  if (!input.online && input.state === 'active') {
    if (settled) {
      flags.push('paid-offline');
      risk += 15;
    } else {
      flags.push('offline');
      risk += 8;
    }
  }

  if (input.late90 >= 2) {
    flags.push('late-payer');
    risk += 15;
  } else if (input.late90 === 1) {
    flags.push('late-payer');
    risk += 6;
  }

  return { risk: Math.min(100, risk), flags };
}

export function buildCommandCenterFeed(today = new Date().toISOString().slice(0, 10)): CommandCenterFeed {
  const monthStart = `${today.slice(0, 7)}-01`;
  const prevMonthStart = prevMonthStartOf(today);
  const since = prevMonthStart < shiftDay(today, -90) ? prevMonthStart : shiftDay(today, -90);

  const routers = db.prepare('SELECT id, name FROM routers ORDER BY id').all() as { id: number; name: string }[];
  const routerName = new Map(routers.map((r) => [r.id, r.name]));

  const users = db
    .prepare(
      `SELECT u.id, u.username, u.customer_name, u.account_number, u.profile, u.status, u.online,
              u.price, u.subscription_due, u.nonpayment_since, u.expiration_profile,
              u.lat, u.lng, u.router_id, n.name AS nap_name
       FROM pppoe_users u
       LEFT JOIN naps n ON n.id = u.nap_id`
    )
    .all() as {
    id: number;
    username: string;
    customer_name: string | null;
    account_number: string | null;
    profile: string | null;
    status: string | null;
    online: number | null;
    price: number | null;
    subscription_due: string | null;
    nonpayment_since: string | null;
    expiration_profile: string | null;
    lat: number | null;
    lng: number | null;
    router_id: number | null;
    nap_name: string | null;
  }[];

  let openRows: { id: number; balance: number }[] = [];
  try {
    openRows = db
      .prepare(
        `SELECT pppoe_user_id AS id, COALESCE(SUM(amount - amount_paid), 0) AS balance
         FROM invoices
         WHERE status IN ('unpaid', 'partial', 'overdue')
         GROUP BY pppoe_user_id`
      )
      .all() as { id: number; balance: number }[];
  } catch {
    openRows = [];
  }
  const openByUser = new Map(openRows.map((r) => [r.id, Number(r.balance) || 0]));

  const txRows = db
    .prepare(
      `SELECT pppoe_user_id AS id, amount, created_at, receipt_json
       FROM transactions
       WHERE created_at >= ? AND COALESCE(type, 'payment') = 'payment' AND COALESCE(amount, 0) > 0
       ORDER BY created_at`
    )
    .all(since) as { id: number | null; amount: number; created_at: string; receipt_json: string | null }[];

  const payments: CcPayment[] = [];
  const paidMonth = new Map<number, number>();
  const lateMonth = new Set<number>();
  const late90 = new Map<number, number>();
  const lastPaid = new Map<number, string>();
  const lateWindowStart = shiftDay(today, -90);
  for (const tx of txRows) {
    const id = Number(tx.id);
    const date = day(tx.created_at);
    if (!id || !date) continue;
    const late = lateOf(tx.receipt_json, tx.created_at);
    const amount = round2(Number(tx.amount) || 0);
    payments.push([id, amount, date, late]);
    lastPaid.set(id, date);
    if (date >= monthStart) {
      paidMonth.set(id, (paidMonth.get(id) || 0) + amount);
      if (late) lateMonth.add(id);
    }
    if (late && date >= lateWindowStart) late90.set(id, (late90.get(id) || 0) + 1);
  }

  const subscribers: CcSubscriber[] = users.map((u) => {
    const state = stateOf(u);
    const due = day(u.subscription_due) || null;
    const dueIn = due ? daysBetween(today, due) : null;
    const price = Number(u.price) || 0;
    const balance = round2(openByUser.get(u.id) || 0);
    const paidAmount = round2(paidMonth.get(u.id) || 0);
    const billable = state !== 'disabled' && state !== 'inactive';
    const online = Number(u.online) === 1;

    let paid: CcPaid = 'none';
    if (billable) {
      if (paidAmount > 0) paid = lateMonth.has(u.id) ? 'late' : 'paid';
      else if (dueIn != null && dueIn > 0 && balance <= 0.009) paid = 'covered';
      else paid = 'unpaid';
    }

    const lateCount = late90.get(u.id) || 0;
    const { risk, flags } = scoreRisk({ state, online, dueIn, balance, paid, late90: lateCount });
    return {
      id: u.id,
      user: u.username,
      name: u.customer_name || u.username,
      account: u.account_number || u.username,
      plan: u.profile || 'No plan',
      price,
      state,
      online,
      due,
      dueIn,
      lat: u.lat != null && Number.isFinite(Number(u.lat)) ? Number(u.lat) : null,
      lng: u.lng != null && Number.isFinite(Number(u.lng)) ? Number(u.lng) : null,
      routerId: u.router_id,
      router: (u.router_id != null && routerName.get(u.router_id)) || 'Unassigned',
      nap: u.nap_name || '',
      balance,
      paidMonth: paidAmount,
      lastPaid: lastPaid.get(u.id) || null,
      late90: lateCount,
      paid,
      risk,
      flags,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    today,
    monthStart,
    prevMonthStart,
    routers,
    subscribers,
    payments,
  };
}
