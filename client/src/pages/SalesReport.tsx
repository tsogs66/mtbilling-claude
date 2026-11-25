import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Download, Eraser, Loader2, Printer, RefreshCw, Trash2, X } from 'lucide-react';
import Layout from '../components/Layout';
import { Flash } from '../components/ui';
import ReceiptPrintModal from '../components/ReceiptPrintModal';
import {
  Col, compactMoney, downloadCsv, money, moneyExact, num, PageBar, PanelHead, Popover, Reading, Readings, SearchBox, Seg, Table, TONE_VAR,
} from '../components/command/kit';
import { api, peso } from '../api';
import { openReceiptForPrint, type PaymentReceipt } from '../lib/receiptPrint';
import { openSalesReportPrint } from '../lib/invoicePrint';
import { useCompany } from '../context/CompanyContext';

type Group = 'month' | 'year';

const GROUPS: { key: Group; label: string }[] = [
  { key: 'month', label: 'Monthly' },
  { key: 'year', label: 'Yearly' },
];

function defaultFrom() {
  const d = new Date();
  d.setMonth(d.getMonth() - 2);
  return d.toISOString().slice(0, 10);
}
function defaultTo() {
  return new Date().toISOString().slice(0, 10);
}

const isCancel = (t: any) => String(t.type || '').includes('cancel');
const typeLabel = (t: any) => String(t.type || 'other').replace(/_/g, ' ');

export default function SalesReport() {
  const { company } = useCompany();
  const [range, setRange] = useState<Group>('month');
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [useCustom, setUseCustom] = useState(false);
  const [sales, setSales] = useState<any>(null);
  const [tx, setTx] = useState<any[]>([]);
  const [periodTx, setPeriodTx] = useState<any[] | null>(null);
  const [periodLabel, setPeriodLabel] = useState('');
  const [flash, setFlash] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [clearMonth, setClearMonth] = useState('');
  const [busy, setBusy] = useState(false);
  const [reprintId, setReprintId] = useState<number | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<PaymentReceipt | null>(null);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);

  const loadSales = useCallback(() => {
    const params = useCustom ? { from, to, group: range } : { group: range };
    return api.get('/sales', { params }).then((r) => setSales(r.data));
  }, [useCustom, from, to, range]);
  const loadTx = useCallback(() => {
    const params = useCustom ? { from, to } : {};
    return api.get('/sales/transactions', { params }).then((r) => setTx(r.data));
  }, [useCustom, from, to]);

  useEffect(() => {
    loadSales();
    loadTx();
    setPeriodTx(null);
  }, [loadSales, loadTx]);

  const refresh = () => {
    loadSales();
    loadTx();
    if (periodTx) void openPeriod(periodLabel);
  };

  const openPeriod = async (label: string) => {
    setPeriodLabel(label);
    try {
      const r = await api.get('/sales/transactions', { params: { period: label } });
      setPeriodTx(r.data || []);
    } catch (e: any) {
      setFlash({ type: 'error', msg: e?.response?.data?.error || 'Could not load period transactions' });
    }
  };

  const clearAll = async () => {
    if (!confirm('Delete ALL sales transactions? This cannot be undone.')) return;
    setBusy(true);
    try {
      const r = await api.delete('/sales/transactions');
      setFlash({ type: 'success', msg: `Cleared ${r.data.deleted} transaction(s).` });
      setPeriodTx(null);
      loadSales();
      loadTx();
    } catch (e: any) {
      setFlash({ type: 'error', msg: e?.response?.data?.error || 'Clear failed' });
    } finally {
      setBusy(false);
    }
  };

  const clearMonthReports = async () => {
    if (!clearMonth || !/^\d{4}-\d{2}$/.test(clearMonth)) {
      setFlash({ type: 'error', msg: 'Enter month as YYYY-MM (e.g. 2026-07)' });
      return;
    }
    if (!confirm(`Delete all transactions for ${clearMonth}?`)) return;
    setBusy(true);
    try {
      const r = await api.delete('/sales/transactions', { params: { month: clearMonth } });
      setFlash({ type: 'success', msg: `Cleared ${r.data.deleted} transaction(s) for ${clearMonth}.` });
      setPeriodTx(null);
      loadSales();
      loadTx();
    } catch (e: any) {
      setFlash({ type: 'error', msg: e?.response?.data?.error || 'Clear failed' });
    } finally {
      setBusy(false);
    }
  };

  const reprintReceipt = async (txId: number) => {
    setReprintId(txId);
    try {
      const r = await api.get(`/sales/transactions/${txId}/receipt`);
      openReceiptForPrint(r.data.receipt, setReceiptPreview);
    } catch (e: any) {
      setFlash({ type: 'error', msg: e?.response?.data?.error || 'Could not load receipt' });
    } finally {
      setReprintId(null);
    }
  };

  const companyPrint = company
    ? { name: company.name, address: company.address, phone: company.phone, email: company.email, logo: company.logo }
    : null;

  const rangeLabel = useCustom ? `${from} \u2192 ${to}` : range === 'year' ? 'Yearly' : 'Monthly';

  const series = useMemo<{ label: string; value: number }[]>(() => sales?.series ?? [], [sales]);
  const bestPoint = useMemo(
    () => series.reduce<{ label: string; value: number } | null>((b, s) => (s.value > (b?.value ?? 0) ? s : b), null),
    [series],
  );

  const ledger = periodTx ?? tx;
  const typeMix = useMemo(() => {
    const map = new Map<string, { type: string; amount: number; count: number; cancel: boolean }>();
    for (const t of ledger) {
      const key = typeLabel(t);
      const cur = map.get(key) || { type: key, amount: 0, count: 0, cancel: isCancel(t) };
      cur.amount += Number(t.amount || 0);
      cur.count += 1;
      map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  }, [ledger]);
  const mixMax = Math.max(1, ...typeMix.map((m) => Math.abs(m.amount)));

  const term = search.trim().toLowerCase();
  const shown = useMemo(
    () =>
      ledger.filter(
        (t) =>
          (!typeFilter || typeLabel(t) === typeFilter) &&
          (!term || String(t.customer || '').toLowerCase().includes(term) || typeLabel(t).includes(term)),
      ),
    [ledger, typeFilter, term],
  );
  const shownTotal = shown.reduce((s, t) => s + Number(t.amount || 0), 0);

  const columns: Col<any>[] = [
    { key: 'date', label: 'Date', render: (t) => <span className="text-xs opacity-65">{String(t.date || '').replace('T', ' ').slice(0, 16)}</span> },
    { key: 'customer', label: 'Customer', render: (t) => <span className="font-medium">{t.customer || '\u2014'}</span> },
    {
      key: 'type',
      label: 'Type',
      render: (t) => <span className="capitalize" style={isCancel(t) ? { color: TONE_VAR.bad } : { opacity: 0.75 }}>{typeLabel(t)}</span>,
    },
    { key: 'amount', label: 'Amount', align: 'right', render: (t) => <span className="font-semibold">{peso(t.amount)}</span> },
    {
      key: 'actions',
      label: '',
      align: 'right',
      render: (t) => (
        <button type="button" className="cc-link" disabled={reprintId === t.id} onClick={() => reprintReceipt(t.id)}>
          {reprintId === t.id ? <Loader2 size={12} className="animate-spin" /> : <Printer size={12} />}
          Receipt
        </button>
      ),
    },
  ];

  const printReport = () =>
    openSalesReportPrint({
      title: 'Sales Report',
      company: companyPrint,
      rangeLabel,
      total: Number(sales?.total || 0),
      rows: series.map((s) => ({ label: s.label, value: Number(s.value || 0) })),
      meta: `${sales?.transactions ?? 0} transactions \u00b7 avg/day ${peso(sales?.avgPerDay ?? 0)} \u00b7 best ${peso(sales?.best ?? 0)}`,
      transactions: ledger.slice(0, 200).map((t: any) => ({ date: t.date, customer: t.customer, amount: t.amount, type: t.type })),
    });

  const printPeriod = () => {
    if (!periodTx) return;
    const total = periodTx.reduce((s, t) => s + Number(t.amount || 0), 0);
    openSalesReportPrint({
      title: `Sales \u00b7 ${periodLabel}`,
      company: companyPrint,
      rangeLabel: periodLabel,
      total,
      rows: [{ label: periodLabel, value: total }],
      transactions: periodTx.map((t) => ({ date: t.date, customer: t.customer, amount: t.amount, type: t.type })),
    });
  };

  const exportCsv = () =>
    downloadCsv(
      `sales-${periodLabel || rangeLabel.replace(/\s/g, '')}.csv`,
      ['Date', 'Customer', 'Type', 'Amount'],
      shown.map((t) => [t.date, t.customer, typeLabel(t), t.amount]),
    );

  return (
    <Layout title="Sales Report">
      <div className="cc space-y-5 pb-10">
        {flash && <Flash type={flash.type} message={flash.msg} onDismiss={() => setFlash(null)} />}
        {receiptPreview && <ReceiptPrintModal receipt={receiptPreview} onClose={() => setReceiptPreview(null)} />}

        <header className="space-y-3">
          <PageBar title="Sales report" subtitle={`${rangeLabel} \u00b7 collected payments and what they were for`}>
            <Seg label="Grouping" options={GROUPS} value={range} onChange={(k) => { setRange(k); setUseCustom(false); }} />
            <label className="flex items-center gap-1.5 text-xs opacity-80">
              From
              <input type="date" className="cc-input" value={from} onChange={(e) => { setFrom(e.target.value); setUseCustom(true); }} />
            </label>
            <label className="flex items-center gap-1.5 text-xs opacity-80">
              To
              <input type="date" className="cc-input" value={to} onChange={(e) => { setTo(e.target.value); setUseCustom(true); }} />
            </label>
            {useCustom && (
              <button type="button" className="cc-btn" onClick={() => setUseCustom(false)}>
                <X size={13} /> Clear range
              </button>
            )}
            <button type="button" className="cc-btn" onClick={refresh} title="Refresh"><RefreshCw size={14} /></button>
            <button type="button" className="cc-btn is-on" onClick={printReport} disabled={!sales}>
              <Printer size={14} /> Print report
            </button>
          </PageBar>

          <Readings count={4}>
            <Reading label="Net revenue" tone="good" value={money(sales?.total ?? 0)} sub={rangeLabel} />
            <Reading label="Transactions" value={num(sales?.transactions ?? 0)} sub="payments in range" />
            <Reading label="Average / day" tone="info" value={money(sales?.avgPerDay ?? 0)} sub="days with collections" />
            <Reading
              label="Best period"
              tone="hot"
              value={money(sales?.best ?? 0)}
              sub={bestPoint ? `${bestPoint.label}, click to list` : 'no sales yet'}
              on={!!bestPoint && periodLabel === bestPoint.label && !!periodTx}
              onClick={bestPoint ? () => void openPeriod(bestPoint.label) : undefined}
            />
          </Readings>
        </header>

        <div className="grid gap-x-8 gap-y-5 lg:grid-cols-5">
          <section className="lg:col-span-3">
            <PanelHead title="Revenue" note="Click a bar to list that period's transactions" />
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={series} margin={{ top: 24, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--card-border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'currentColor' }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={18} />
                  <YAxis tick={{ fontSize: 10, fill: 'currentColor' }} width={52} axisLine={false} tickLine={false} tickFormatter={(v: number) => compactMoney(v)} />
                  <Tooltip
                    cursor={{ fill: 'rgba(148,163,184,0.18)' }}
                    formatter={(v: number) => [moneyExact(v), 'Revenue']}
                    contentStyle={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 8, fontSize: 12 }}
                  />
                  <Bar
                    dataKey="value"
                    radius={[4, 4, 0, 0]}
                    cursor="pointer"
                    onClick={(data: any) => {
                      const label = data?.payload?.label || data?.label;
                      if (label) void openPeriod(String(label));
                    }}
                  >
                    {series.map((s) => (
                      <Cell key={s.label} fill="var(--brand)" fillOpacity={periodTx && periodLabel !== s.label ? 0.35 : 1} />
                    ))}
                    {series.length <= 14 && (
                      <LabelList
                        dataKey="value"
                        position="top"
                        formatter={(v: number) => (Number(v) > 0 ? compactMoney(Number(v)) : '')}
                        style={{ fill: 'currentColor', fontSize: 10, fontWeight: 600 }}
                      />
                    )}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="lg:col-span-2">
            <PanelHead
              title="What it was for"
              note={periodTx ? `Transactions in ${periodLabel}` : 'Latest 500 transactions in range'}
              actions={typeFilter ? <button type="button" className="cc-link" onClick={() => setTypeFilter(null)}>Show all types</button> : undefined}
            />
            {typeMix.length === 0 ? (
              <p className="cc-empty">No transactions yet.</p>
            ) : (
              <ul className="space-y-0.5">
                {typeMix.map((m) => (
                  <li key={m.type}>
                    <button
                      type="button"
                      className={`cc-seg-row w-full ${typeFilter === m.type ? 'is-on' : ''}`}
                      style={typeFilter === m.type ? { background: 'var(--cc-hover)' } : undefined}
                      onClick={() => setTypeFilter((cur) => (cur === m.type ? null : m.type))}
                    >
                      <span className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="capitalize">{m.type}</span>
                        <span className="text-[11px] opacity-55">{m.count}</span>
                        <span className="ml-auto font-semibold">{money(m.amount)}</span>
                      </span>
                      <span className="cc-pulse-bar mt-1 block">
                        <i style={{ width: `${(Math.abs(m.amount) / mixMax) * 100}%`, background: m.cancel ? TONE_VAR.bad : undefined }} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <section>
          <PanelHead
            title={periodTx ? `Transactions \u00b7 ${periodLabel}` : 'Recent transactions'}
            note={`${num(shown.length)} shown \u00b7 ${money(shownTotal)}${typeFilter ? ` \u00b7 ${typeFilter} only` : ''}`}
            actions={
              <>
                {periodTx && (
                  <>
                    <button type="button" className="cc-link" onClick={printPeriod}><Printer size={12} /> Print period</button>
                    <button type="button" className="cc-link" onClick={() => setPeriodTx(null)}>Close period</button>
                  </>
                )}
                <button type="button" className="cc-link" onClick={exportCsv} disabled={shown.length === 0}><Download size={12} /> CSV</button>
                <Popover label="Clear data" icon={<Eraser size={14} />} align="right">
                  <div className="w-64 space-y-3 p-3">
                    <p className="text-[11px] opacity-65">Deleting transactions removes them from every sales and finance figure. It cannot be undone.</p>
                    <div className="flex gap-2">
                      <input className="cc-input flex-1" placeholder="YYYY-MM" value={clearMonth} onChange={(e) => setClearMonth(e.target.value)} />
                      <button type="button" className="cc-btn" disabled={busy} onClick={clearMonthReports}>Clear month</button>
                    </div>
                    <button type="button" className="cc-btn w-full justify-center" style={{ color: TONE_VAR.bad }} disabled={busy} onClick={clearAll}>
                      <Trash2 size={14} /> Clear all transactions
                    </button>
                  </div>
                </Popover>
              </>
            }
          />
          <div className="mb-2">
            <SearchBox value={search} onChange={setSearch} placeholder="Customer or type" />
          </div>
          <Table
            columns={columns}
            rows={shown}
            rowKey={(t) => t.id}
            empty={periodTx ? 'No transactions in this period.' : 'No transactions yet.'}
          />
        </section>
      </div>
    </Layout>
  );
}
