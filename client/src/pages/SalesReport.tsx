import { useEffect, useState } from 'react';
import { BarChart, Bar, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid, LabelList } from 'recharts';
import { Wallet, Receipt, TrendingUp, CalendarDays, Trash2, Printer, Loader2 } from 'lucide-react';
import Layout from '../components/Layout';
import { Card, StatTile, TabPills, DataTable, Flash } from '../components/ui';
import ReceiptPrintModal from '../components/ReceiptPrintModal';
import { api, peso } from '../api';
import { openReceiptForPrint, type PaymentReceipt } from '../lib/receiptPrint';
import { openSalesReportPrint } from '../lib/invoicePrint';
import { useCompany } from '../context/CompanyContext';

const GROUPS = [
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

export default function SalesReport() {
  const { company } = useCompany();
  const [range, setRange] = useState('month');
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

  const loadSales = () => {
    const params = useCustom
      ? { from, to, group: range }
      : { group: range };
    return api.get('/sales', { params }).then((r) => setSales(r.data));
  };
  const loadTx = () => {
    const params = useCustom ? { from, to } : {};
    return api.get('/sales/transactions', { params }).then((r) => setTx(r.data));
  };

  useEffect(() => {
    loadSales();
    loadTx();
    setPeriodTx(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, useCustom, from, to]);

  const refresh = () => {
    loadSales();
    loadTx();
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
      refresh();
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
      refresh();
    } catch (e: any) {
      setFlash({ type: 'error', msg: e?.response?.data?.error || 'Clear failed' });
    } finally {
      setBusy(false);
    }
  };

  const formatBarAmount = (v: number) => {
    const n = Number(v) || 0;
    if (n >= 1_000_000) return `₱${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1000) return `₱${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
    return peso(n);
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

  const rangeLabel = useCustom
    ? `${from} → ${to}`
    : range === 'year'
      ? 'Yearly'
      : 'Monthly';

  return (
    <Layout title="Sales Report">
      {flash && <Flash type={flash.type} message={flash.msg} onDismiss={() => setFlash(null)} />}
      {receiptPreview && (
        <ReceiptPrintModal receipt={receiptPreview} onClose={() => setReceiptPreview(null)} />
      )}

      <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div className="flex flex-wrap items-end gap-3">
          <TabPills tabs={GROUPS} active={range} onChange={(k) => { setRange(k); setUseCustom(false); }} />
          <label className="text-sm">
            <span className="text-xs text-slate-500">From</span>
            <input
              type="date"
              className="input mt-1"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setUseCustom(true);
              }}
            />
          </label>
          <label className="text-sm">
            <span className="text-xs text-slate-500">To</span>
            <input
              type="date"
              className="input mt-1"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setUseCustom(true);
              }}
            />
          </label>
          {useCustom && (
            <button type="button" className="btn-secondary text-sm" onClick={() => setUseCustom(false)}>
              Clear range
            </button>
          )}
        </div>
        <button
          type="button"
          className="btn-secondary"
          onClick={() =>
            openSalesReportPrint({
              title: 'Sales Report',
              company: companyPrint,
              rangeLabel,
              total: Number(sales?.total || 0),
              rows: (sales?.series || []).map((s: any) => ({ label: s.label, value: Number(s.value || 0) })),
              meta: `${sales?.transactions ?? 0} transactions · avg/day ${peso(sales?.avgPerDay ?? 0)} · best ${peso(sales?.best ?? 0)}`,
              transactions: (periodTx || tx).slice(0, 200).map((t: any) => ({
                date: t.date,
                customer: t.customer,
                amount: t.amount,
                type: t.type,
              })),
            })
          }
          disabled={!sales}
        >
          <Printer size={16} /> Print sales report
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-5 mb-5">
        <StatTile label="Net Revenue" value={peso(sales?.total ?? 0)} icon={Wallet} tone="text-brand-600" accent="from-brand-500/15 to-transparent" delay={0} />
        <StatTile label="Transactions" value={sales?.transactions ?? 0} icon={Receipt} delay={50} />
        <StatTile label="Average / day" value={peso(sales?.avgPerDay ?? 0)} icon={TrendingUp} accent="from-sky-500/15 to-transparent" delay={100} />
        <StatTile label="Best period" value={peso(sales?.best ?? 0)} icon={CalendarDays} accent="from-emerald-500/15 to-transparent" tone="text-emerald-600" delay={150} />
      </div>

      <Card title="Revenue" interactive right={<span className="text-xs text-slate-400">Click a bar to list transactions</span>}>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={sales?.series ?? []} margin={{ top: 28, right: 12, left: 8, bottom: 4 }}>
              <defs>
                <linearGradient id="salesBar" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#fb923c" stopOpacity={1} />
                  <stop offset="100%" stopColor="#f97316" stopOpacity={0.75} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} tickFormatter={(v) => String(v)} />
              <YAxis
                tick={{ fontSize: 11, fill: '#94a3b8' }}
                tickFormatter={(v) => (v >= 1000 ? `₱${v / 1000}k` : `₱${v}`)}
                width={56}
              />
              <Tooltip formatter={(v: number) => peso(v)} labelStyle={{ color: '#334155' }} contentStyle={{ borderRadius: '12px', border: '1px solid #e2e8f0' }} />
              <Bar
                dataKey="value"
                fill="url(#salesBar)"
                radius={[6, 6, 0, 0]}
                name="Amount"
                cursor="pointer"
                onClick={(data: any) => {
                  const label = data?.payload?.label || data?.label;
                  if (label) void openPeriod(String(label));
                }}
              >
                <LabelList
                  dataKey="value"
                  position="top"
                  formatter={(v: number) => (Number(v) > 0 ? formatBarAmount(Number(v)) : '')}
                  style={{ fill: '#475569', fontSize: 11, fontWeight: 600 }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {periodTx && (
        <Card
          className="mt-5"
          title={`Transactions · ${periodLabel}`}
          right={
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-secondary text-sm"
                onClick={() =>
                  openSalesReportPrint({
                    title: `Sales · ${periodLabel}`,
                    company: companyPrint,
                    rangeLabel: periodLabel,
                    total: periodTx.reduce((s, t) => s + Number(t.amount || 0), 0),
                    rows: [{ label: periodLabel, value: periodTx.reduce((s, t) => s + Number(t.amount || 0), 0) }],
                    transactions: periodTx.map((t) => ({
                      date: t.date,
                      customer: t.customer,
                      amount: t.amount,
                      type: t.type,
                    })),
                  })
                }
              >
                <Printer size={14} /> Print period
              </button>
              <button type="button" className="btn-secondary text-sm" onClick={() => setPeriodTx(null)}>
                Close
              </button>
            </div>
          }
        >
          <DataTable
            columns={[
              { key: 'date', label: 'Date' },
              { key: 'customer', label: 'Customer' },
              { key: 'type', label: 'Type' },
              { key: 'amount', label: 'Amount', align: 'right' },
              { key: 'actions', label: '', align: 'right' },
            ]}
            rows={periodTx.map((t) => ({
              key: t.id,
              cells: [
                <span className="text-xs text-slate-500">{String(t.date || '').replace('T', ' ').slice(0, 16)}</span>,
                <span className="font-medium text-slate-800">{t.customer || '—'}</span>,
                <span className={`font-medium ${String(t.type || '').includes('cancel') ? 'text-rose-600' : 'text-slate-600'}`}>
                  {String(t.type || '—').replace(/_/g, ' ')}
                </span>,
                <span className="font-semibold text-slate-800">{peso(t.amount)}</span>,
                <button
                  type="button"
                  className="text-brand-600 text-xs inline-flex items-center gap-1"
                  disabled={reprintId === t.id}
                  onClick={() => reprintReceipt(t.id)}
                >
                  {reprintId === t.id ? <Loader2 size={12} className="animate-spin" /> : <Printer size={12} />}
                  Receipt
                </button>,
              ],
            }))}
            emptyMessage="No transactions in this period."
          />
        </Card>
      )}

      <Card
        className="mt-5"
        title="Recent transactions"
        right={
          <div className="flex flex-wrap gap-2 items-center">
            <input
              className="input w-36 text-sm"
              placeholder="YYYY-MM"
              value={clearMonth}
              onChange={(e) => setClearMonth(e.target.value)}
            />
            <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={clearMonthReports}>
              Clear month
            </button>
            <button type="button" className="btn-secondary text-sm text-rose-600" disabled={busy} onClick={clearAll}>
              <Trash2 size={14} /> Clear all
            </button>
          </div>
        }
      >
        <DataTable
          columns={[
            { key: 'date', label: 'Date' },
            { key: 'customer', label: 'Customer' },
            { key: 'type', label: 'Type' },
            { key: 'amount', label: 'Amount', align: 'right' },
            { key: 'actions', label: '', align: 'right' },
          ]}
          rows={tx.map((t) => ({
            key: t.id,
            cells: [
              <span className="text-xs text-slate-500">{String(t.date || '').replace('T', ' ').slice(0, 16)}</span>,
              <span className="font-medium text-slate-800">{t.customer || '—'}</span>,
              <span className={`font-medium ${String(t.type || '').includes('cancel') ? 'text-rose-600' : 'text-slate-600'}`}>
                  {String(t.type || '—').replace(/_/g, ' ')}
                </span>,
              <span className="font-semibold text-slate-800">{peso(t.amount)}</span>,
              <button
                type="button"
                className="text-brand-600 text-xs inline-flex items-center gap-1"
                disabled={reprintId === t.id}
                onClick={() => reprintReceipt(t.id)}
              >
                {reprintId === t.id ? <Loader2 size={12} className="animate-spin" /> : <Printer size={12} />}
                Receipt
              </button>,
            ],
          }))}
          emptyMessage="No transactions yet."
        />
      </Card>
    </Layout>
  );
}
