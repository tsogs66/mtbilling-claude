/**
 * Home-page collection picture: who should pay this month, who already did,
 * who is late, and who still has not paid.
 */
import { db } from './db.js';

export type CollectionPerson = {
  id: number;
  name: string;
  account: string;
  due: string | null;
  price: number;
  balance: number;
};

export type LatePayment = {
  id: number;
  name: string;
  account: string;
  previousDue: string;
  paidOn: string;
  amount: number;
};

export type CollectionReport = {
  total: number;
  active: number;
  online: number;
  offline: number;
  nonPayment: number;
  expired: number;
  disabled: number;
  target: number;
  collected: number;
  remaining: number;
  openBalance: number;
  paidCount: number;
  onTimeCount: number;
  lateCount: number;
  unpaidCount: number;
  coveredCount: number;
  monthStart: string;
  pie: { name: string; value: number; key: string }[];
  unpaid: CollectionPerson[];
  late: LatePayment[];
};

function normStatus(status: string | null | undefined): string {
  return String(status || '')
    .toLowerCase()
    .replace(/\s+/g, '-');
}

function billable(status: string): boolean {
  return status !== 'disabled' && status !== 'inactive';
}

function day(value: string | null | undefined): string {
  const s = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function lateOf(receiptJson: string | null, createdAt: string): { late: boolean; previousDue: string; paidOn: string } | null {
  if (!receiptJson) return null;
  try {
    const receipt = JSON.parse(receiptJson);
    if (receipt?.correction) return null;
    const previousDue = day(receipt.previousDue);
    const paidOn = day(receipt.paymentDate || createdAt);
    if (!previousDue || !paidOn) return null;
    return { late: paidOn > previousDue, previousDue, paidOn };
  } catch {
    return null;
  }
}

export function buildCollectionReport(routerId?: number | null, today = new Date().toISOString().slice(0, 10)): CollectionReport {
  const monthStart = `${today.slice(0, 7)}-01`;
  const users = (
    routerId
      ? db
          .prepare(
            `SELECT id, username, customer_name, account_number, status, online, price, subscription_due
             FROM pppoe_users WHERE router_id = ?`
          )
          .all(routerId)
      : db
          .prepare(
            `SELECT id, username, customer_name, account_number, status, online, price, subscription_due
             FROM pppoe_users`
          )
          .all()
  ) as {
    id: number;
    username: string;
    customer_name: string | null;
    account_number: string | null;
    status: string | null;
    online: number | null;
    price: number | null;
    subscription_due: string | null;
  }[];

  const ids = new Set(users.map((u) => u.id));
  const openRows = db
    .prepare(
      `SELECT pppoe_user_id AS id, COALESCE(SUM(amount - amount_paid), 0) AS balance
       FROM invoices
       WHERE status IN ('unpaid', 'partial', 'overdue')
       GROUP BY pppoe_user_id`
    )
    .all() as { id: number; balance: number }[];
  const openByUser = new Map<number, number>();
  for (const row of openRows) {
    if (!ids.size || ids.has(row.id)) openByUser.set(row.id, Number(row.balance) || 0);
  }

  const payments = db
    .prepare(
      `SELECT pppoe_user_id AS id, amount, created_at, receipt_json
       FROM transactions
       WHERE created_at >= ? AND COALESCE(type, 'payment') = 'payment' AND COALESCE(amount, 0) > 0`
    )
    .all(monthStart) as {
    id: number | null;
    amount: number;
    created_at: string;
    receipt_json: string | null;
  }[];

  const paidIds = new Set<number>();
  const lateIds = new Set<number>();
  const onTimeIds = new Set<number>();
  const late: LatePayment[] = [];
  let collected = 0;
  const nameOf = new Map(users.map((u) => [u.id, u]));

  for (const pay of payments) {
    const id = Number(pay.id);
    if (!id || (ids.size && !ids.has(id))) continue;
    collected += Number(pay.amount) || 0;
    paidIds.add(id);
    const timing = lateOf(pay.receipt_json, pay.created_at);
    if (!timing) continue;
    if (timing.late) {
      lateIds.add(id);
      const user = nameOf.get(id);
      if (late.length < 12 && user) {
        late.push({
          id,
          name: user.customer_name || user.username,
          account: user.account_number || user.username,
          previousDue: timing.previousDue,
          paidOn: timing.paidOn,
          amount: round2(Number(pay.amount) || 0),
        });
      }
    } else {
      onTimeIds.add(id);
    }
  }

  let active = 0;
  let online = 0;
  let offline = 0;
  let nonPayment = 0;
  let expired = 0;
  let disabled = 0;
  let target = 0;
  let openBalance = 0;
  let unpaidCount = 0;
  let coveredCount = 0;
  const unpaid: CollectionPerson[] = [];

  for (const user of users) {
    const status = normStatus(user.status);
    const isOnline = Number(user.online) === 1;
    if (status === 'disabled') disabled += 1;
    else if (status === 'non-payment' || status === 'nonpayment') nonPayment += 1;
    else if (status === 'expired') expired += 1;
    else if (status === 'active') {
      active += 1;
      if (isOnline) online += 1;
      else offline += 1;
    }

    const balance = openByUser.get(user.id) || 0;
    openBalance += balance;
    if (!billable(status)) continue;
    const price = Number(user.price) || 0;
    if (price > 0) target += price;

    const due = day(user.subscription_due);
    const paid = paidIds.has(user.id);
    const pastDue = !due || due <= today;
    if (paid) continue;
    if (!pastDue && balance <= 0.009) {
      coveredCount += 1;
      continue;
    }
    unpaidCount += 1;
    if (unpaid.length < 12) {
      unpaid.push({
        id: user.id,
        name: user.customer_name || user.username,
        account: user.account_number || user.username,
        due: due || null,
        price: round2(price),
        balance: round2(balance),
      });
    }
  }

  const pie = [
    { name: 'Online', value: online, key: 'online' },
    { name: 'Offline', value: offline, key: 'offline' },
    { name: 'Non-payment', value: nonPayment, key: 'non-payment' },
    { name: 'Expired', value: expired, key: 'expired' },
    { name: 'Disabled', value: disabled, key: 'disabled' },
  ].filter((slice) => slice.value > 0);

  return {
    total: users.length,
    active,
    online,
    offline,
    nonPayment,
    expired,
    disabled,
    target: round2(target),
    collected: round2(collected),
    remaining: round2(Math.max(0, target - collected)),
    openBalance: round2(openBalance),
    paidCount: paidIds.size,
    onTimeCount: [...onTimeIds].filter((id) => !lateIds.has(id)).length,
    lateCount: lateIds.size,
    unpaidCount,
    coveredCount,
    monthStart,
    pie,
    unpaid,
    late,
  };
}
