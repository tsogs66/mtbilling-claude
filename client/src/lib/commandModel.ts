/**
 * Pure data model for the Command Center home page: types that mirror
 * `server/src/commandCenter.ts`, the cross-filter, and every aggregate the
 * page draws. Nothing here touches React so it stays easy to reason about.
 */

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

export interface CcSubscriber {
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
}

export type CcPayment = [number, number, string, 0 | 1];

export interface CcFeed {
  generatedAt: string;
  today: string;
  monthStart: string;
  prevMonthStart: string;
  routers: { id: number; name: string }[];
  subscribers: CcSubscriber[];
  payments: CcPayment[];
}

export type Lens = 'revenue' | 'network' | 'risk';

export const LENSES: { key: Lens; label: string; hint: string }[] = [
  { key: 'revenue', label: 'Revenue', hint: 'Who paid, who is late, who has not paid' },
  { key: 'network', label: 'Network', hint: 'Who is online, offline or on hold' },
  { key: 'risk', label: 'Risk', hint: 'Who needs staff attention first' },
];

export const FLAG_LABEL: Record<CcFlag, string> = {
  overdue: 'Overdue',
  'due-today': 'Due today',
  'due-soon': 'Due in 3 days',
  offline: 'Offline',
  'paid-offline': 'Paid, offline',
  'online-unpaid': 'Online, unpaid',
  'late-payer': 'Pays late',
  balance: 'Open balance',
  'non-payment': 'Non-payment',
  expired: 'Expired',
};

export type Tone = 'good' | 'warn' | 'bad' | 'info' | 'mute' | 'hot';

export const FLAG_TONE: Record<CcFlag, Tone> = {
  overdue: 'bad',
  'due-today': 'warn',
  'due-soon': 'info',
  offline: 'warn',
  'paid-offline': 'hot',
  'online-unpaid': 'bad',
  'late-payer': 'warn',
  balance: 'warn',
  'non-payment': 'bad',
  expired: 'bad',
};

export interface LensCategory {
  key: string;
  label: string;
  tone: Tone;
}

export const LENS_CATEGORIES: Record<Lens, LensCategory[]> = {
  revenue: [
    { key: 'paid', label: 'Paid on time', tone: 'good' },
    { key: 'late', label: 'Paid after due', tone: 'warn' },
    { key: 'covered', label: 'Covered, not due', tone: 'info' },
    { key: 'unpaid', label: 'Not paid', tone: 'bad' },
    { key: 'none', label: 'Disabled', tone: 'mute' },
  ],
  network: [
    { key: 'online', label: 'Online', tone: 'good' },
    { key: 'offline', label: 'Offline', tone: 'bad' },
    { key: 'hold', label: 'Non-payment or expired', tone: 'warn' },
    { key: 'off', label: 'Disabled', tone: 'mute' },
  ],
  risk: [
    { key: 'low', label: 'Low, under 25', tone: 'good' },
    { key: 'medium', label: 'Medium, 25 to 49', tone: 'info' },
    { key: 'high', label: 'High, 50 to 74', tone: 'warn' },
    { key: 'critical', label: 'Critical, 75 and up', tone: 'bad' },
  ],
};

export function categoryOf(s: CcSubscriber, lens: Lens): string {
  if (lens === 'revenue') return s.paid;
  if (lens === 'network') {
    if (s.state === 'disabled' || s.state === 'inactive') return 'off';
    if (s.state === 'non-payment' || s.state === 'expired') return 'hold';
    return s.online ? 'online' : 'offline';
  }
  if (s.risk >= 75) return 'critical';
  if (s.risk >= 50) return 'high';
  if (s.risk >= 25) return 'medium';
  return 'low';
}

export interface Filters {
  routers: number[];
  plans: string[];
  naps: string[];
  cat: string[];
  flag: CcFlag | null;
  dueDay: string | null;
  search: string;
  bounds: [number, number, number, number] | null;
}

export const EMPTY_FILTERS: Filters = {
  routers: [],
  plans: [],
  naps: [],
  cat: [],
  flag: null,
  dueDay: null,
  search: '',
  bounds: null,
};

export function filtersActive(f: Filters): boolean {
  return (
    f.routers.length > 0 ||
    f.plans.length > 0 ||
    f.naps.length > 0 ||
    f.cat.length > 0 ||
    !!f.flag ||
    !!f.dueDay ||
    !!f.search.trim() ||
    !!f.bounds
  );
}

export function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
}

/**
 * Cross-filter. `skip` leaves one dimension out so a panel can keep showing
 * every option for its own dimension while the other panels narrow the data.
 */
export function applyFilters(
  subs: CcSubscriber[],
  f: Filters,
  lens: Lens,
  skip?: keyof Filters
): CcSubscriber[] {
  const q = f.search.trim().toLowerCase();
  return subs.filter((s) => {
    if (skip !== 'routers' && f.routers.length && (s.routerId == null || !f.routers.includes(s.routerId))) return false;
    if (skip !== 'plans' && f.plans.length && !f.plans.includes(s.plan)) return false;
    if (skip !== 'naps' && f.naps.length && !f.naps.includes(s.nap || '—')) return false;
    if (skip !== 'cat' && f.cat.length && !f.cat.includes(categoryOf(s, lens))) return false;
    if (skip !== 'flag' && f.flag && !s.flags.includes(f.flag)) return false;
    if (skip !== 'dueDay' && f.dueDay && s.due !== f.dueDay) return false;
    if (skip !== 'search' && q) {
      const hay = `${s.name} ${s.user} ${s.account} ${s.plan} ${s.nap}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (skip !== 'bounds' && f.bounds) {
      if (s.lat == null || s.lng == null) return false;
      const [south, west, north, east] = f.bounds;
      if (s.lat < south || s.lat > north || s.lng < west || s.lng > east) return false;
    }
    return true;
  });
}

export const billable = (s: CcSubscriber) => s.state !== 'disabled' && s.state !== 'inactive';

export interface Summary {
  total: number;
  billable: number;
  online: number;
  offline: number;
  held: number;
  disabled: number;
  target: number;
  collected: number;
  paidCount: number;
  onTimeCount: number;
  lateCount: number;
  unpaidCount: number;
  coveredCount: number;
  unpaidAmount: number;
  openBalance: number;
  critical: number;
  paidOffline: number;
  onlineUnpaid: number;
}

export function summarize(subs: CcSubscriber[]): Summary {
  const out: Summary = {
    total: subs.length,
    billable: 0,
    online: 0,
    offline: 0,
    held: 0,
    disabled: 0,
    target: 0,
    collected: 0,
    paidCount: 0,
    onTimeCount: 0,
    lateCount: 0,
    unpaidCount: 0,
    coveredCount: 0,
    unpaidAmount: 0,
    openBalance: 0,
    critical: 0,
    paidOffline: 0,
    onlineUnpaid: 0,
  };
  for (const s of subs) {
    out.collected += s.paidMonth;
    out.openBalance += s.balance;
    if (!billable(s)) {
      out.disabled += 1;
      continue;
    }
    out.billable += 1;
    out.target += s.price;
    if (s.state === 'non-payment' || s.state === 'expired') out.held += 1;
    else if (s.online) out.online += 1;
    else out.offline += 1;
    if (s.paid === 'paid') {
      out.paidCount += 1;
      out.onTimeCount += 1;
    } else if (s.paid === 'late') {
      out.paidCount += 1;
      out.lateCount += 1;
    } else if (s.paid === 'unpaid') {
      out.unpaidCount += 1;
      out.unpaidAmount += s.price + s.balance;
    } else if (s.paid === 'covered') out.coveredCount += 1;
    if (s.risk >= 75) out.critical += 1;
    if (s.flags.includes('paid-offline')) out.paidOffline += 1;
    if (s.flags.includes('online-unpaid')) out.onlineUnpaid += 1;
  }
  return out;
}

export function addDays(iso: string, delta: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + delta * 86400000).toISOString().slice(0, 10);
}

export function shortDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export interface RunwayBar {
  key: string;
  date: string | null;
  label: string;
  kind: 'overdue' | 'collected' | 'today' | 'due';
  amount: number;
  count: number;
  collected?: number;
}

/**
 * One timeline: money already collected for the last `back` days, then money
 * that falls due over the next `ahead` days, with unpaid overdue accounts
 * stacked in a single bar on the far left.
 */
export function buildRunway(
  subs: CcSubscriber[],
  payments: CcPayment[],
  today: string,
  back: number,
  ahead: number
): RunwayBar[] {
  const ids = new Set(subs.map((s) => s.id));
  const collected = new Map<string, { amount: number; count: number }>();
  for (const [id, amount, date] of payments) {
    if (!ids.has(id)) continue;
    const cur = collected.get(date) || { amount: 0, count: 0 };
    cur.amount += amount;
    cur.count += 1;
    collected.set(date, cur);
  }
  const due = new Map<string, { amount: number; count: number }>();
  const overdue = { amount: 0, count: 0 };
  for (const s of subs) {
    if (!billable(s) || s.dueIn == null || !s.due) continue;
    if (s.dueIn < 0) {
      if (s.paid === 'unpaid') {
        overdue.amount += s.price + s.balance;
        overdue.count += 1;
      }
      continue;
    }
    if (s.dueIn >= ahead) continue;
    const cur = due.get(s.due) || { amount: 0, count: 0 };
    cur.amount += s.price;
    cur.count += 1;
    due.set(s.due, cur);
  }

  const bars: RunwayBar[] = [
    { key: 'overdue', date: null, label: 'Overdue', kind: 'overdue', amount: overdue.amount, count: overdue.count },
  ];
  for (let i = back; i >= 1; i--) {
    const date = addDays(today, -i);
    const c = collected.get(date);
    bars.push({ key: date, date, label: shortDay(date), kind: 'collected', amount: c?.amount || 0, count: c?.count || 0 });
  }
  const t = collected.get(today);
  const td = due.get(today);
  bars.push({
    key: today,
    date: today,
    label: 'Today',
    kind: 'today',
    amount: td?.amount || 0,
    count: td?.count || 0,
    collected: t?.amount || 0,
  });
  for (let i = 1; i < ahead; i++) {
    const date = addDays(today, i);
    const d = due.get(date);
    bars.push({ key: date, date, label: shortDay(date), kind: 'due', amount: d?.amount || 0, count: d?.count || 0 });
  }
  return bars;
}

export interface PacePoint {
  day: number;
  current: number | null;
  projected: number | null;
  previous: number | null;
}

export interface Pace {
  points: PacePoint[];
  collected: number;
  projected: number;
  previousSameDay: number;
  previousTotal: number;
  daysInMonth: number;
  dayOfMonth: number;
  target: number;
  method: 'last-month' | 'linear';
}

export function buildPace(subs: CcSubscriber[], payments: CcPayment[], feed: CcFeed): Pace {
  const ids = new Set(subs.map((s) => s.id));
  const [year, month] = feed.today.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const prevDaysInMonth = new Date(Date.UTC(year, month - 1, 0)).getUTCDate();
  const dayOfMonth = Number(feed.today.slice(8, 10));

  const cur = new Array(daysInMonth + 1).fill(0);
  const prev = new Array(prevDaysInMonth + 1).fill(0);
  for (const [id, amount, date] of payments) {
    if (!ids.has(id)) continue;
    if (date >= feed.monthStart) cur[Number(date.slice(8, 10))] += amount;
    else if (date >= feed.prevMonthStart) prev[Number(date.slice(8, 10))] += amount;
  }
  const target = subs.reduce((sum, s) => sum + (billable(s) ? s.price : 0), 0);

  const prevCum = new Array(prevDaysInMonth + 1).fill(0);
  for (let d = 1; d <= prevDaysInMonth; d++) prevCum[d] = prevCum[d - 1] + prev[d];
  const prevAt = (d: number) => prevCum[Math.min(d, prevDaysInMonth)];

  const collected = cur.reduce((a, b) => a + b, 0);
  const previousTotal = prevCum[prevDaysInMonth];
  const previousSameDay = prevAt(dayOfMonth);
  const useCurve = previousSameDay > 0 && previousTotal > 0;
  const ratio = useCurve ? collected / previousSameDay : 0;
  const linear = (d: number) => (dayOfMonth > 0 ? (collected / dayOfMonth) * d : collected);
  const projectedAt = (d: number) => (useCurve ? prevAt(d) * ratio : linear(d));
  const projected = projectedAt(daysInMonth);

  let runCur = 0;
  const points: PacePoint[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    runCur += cur[d];
    points.push({
      day: d,
      current: d <= dayOfMonth ? runCur : null,
      projected: d < dayOfMonth ? null : d === dayOfMonth ? runCur : projectedAt(d),
      previous: d <= prevDaysInMonth ? prevCum[d] : null,
    });
  }
  return { points, collected, projected, previousSameDay, previousTotal, daysInMonth, dayOfMonth, target, method: useCurve ? 'last-month' : 'linear' };
}

export interface Segment {
  key: string;
  label: string;
  count: number;
  mrr: number;
  unpaid: number;
  offline: number;
}

export function segmentBy(subs: CcSubscriber[], pick: (s: CcSubscriber) => string): Segment[] {
  const map = new Map<string, Segment>();
  for (const s of subs) {
    const key = pick(s);
    const seg = map.get(key) || { key, label: key, count: 0, mrr: 0, unpaid: 0, offline: 0 };
    seg.count += 1;
    if (billable(s)) {
      seg.mrr += s.price;
      if (s.paid === 'unpaid') seg.unpaid += 1;
      if (s.state === 'active' && !s.online) seg.offline += 1;
    }
    map.set(key, seg);
  }
  return [...map.values()].sort((a, b) => b.mrr - a.mrr || b.count - a.count);
}

export type QueueKey = 'all' | 'overdue' | 'soon' | 'paid-offline' | 'online-unpaid' | 'late-payer';

export const QUEUES: { key: QueueKey; label: string; flags: CcFlag[] }[] = [
  { key: 'all', label: 'All', flags: [] },
  { key: 'overdue', label: 'Overdue', flags: ['overdue', 'due-today'] },
  { key: 'soon', label: 'Due soon', flags: ['due-soon'] },
  { key: 'paid-offline', label: 'Paid, offline', flags: ['paid-offline'] },
  { key: 'online-unpaid', label: 'Online, unpaid', flags: ['online-unpaid'] },
  { key: 'late-payer', label: 'Pays late', flags: ['late-payer'] },
];

export function queueFor(subs: CcSubscriber[], key: QueueKey): CcSubscriber[] {
  const def = QUEUES.find((q) => q.key === key)!;
  return subs
    .filter((s) => s.risk > 0 && (def.flags.length === 0 || def.flags.some((f) => s.flags.includes(f))))
    .sort((a, b) => b.risk - a.risk || (a.dueIn ?? 9999) - (b.dueIn ?? 9999));
}

export function queueCounts(subs: CcSubscriber[]): Record<QueueKey, number> {
  const out = {} as Record<QueueKey, number>;
  for (const q of QUEUES) out[q.key] = queueFor(subs, q.key).length;
  return out;
}

export function csvOf(subs: CcSubscriber[]): string {
  const head = ['Account', 'Name', 'Username', 'Plan', 'Router', 'NAP', 'Status', 'Online', 'Due', 'Days to due', 'Monthly', 'Open balance', 'Paid this month', 'Risk', 'Flags'];
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = subs.map((s) =>
    [s.account, s.name, s.user, s.plan, s.router, s.nap, s.state, s.online ? 'yes' : 'no', s.due || '', s.dueIn ?? '', s.price, s.balance, s.paidMonth, s.risk, s.flags.map((f) => FLAG_LABEL[f]).join('; ')]
      .map(esc)
      .join(',')
  );
  return [head.map(esc).join(','), ...rows].join('\n');
}

export function reminderText(s: CcSubscriber, money: (n: number) => string): string {
  const owed = s.price + s.balance;
  if (s.dueIn != null && s.dueIn < 0)
    return `Hi ${s.name}, your internet subscription (${s.account}) was due on ${s.due}. Amount to settle: ${money(owed)}. Thank you.`;
  if (s.dueIn != null)
    return `Hi ${s.name}, your internet subscription (${s.account}) is due on ${s.due}. Amount: ${money(owed)}. Thank you.`;
  return `Hi ${s.name}, please settle your internet subscription (${s.account}). Amount: ${money(owed)}. Thank you.`;
}

export interface SavedView {
  id: string;
  name: string;
  lens: Lens;
  filters: Filters;
  back: number;
  queue: QueueKey;
}

export function riskTone(risk: number): Tone {
  if (risk >= 75) return 'bad';
  if (risk >= 50) return 'hot';
  if (risk >= 25) return 'warn';
  return 'good';
}
