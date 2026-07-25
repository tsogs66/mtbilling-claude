import { useEffect, useState } from 'react';
import { BarChart, Bar, ResponsiveContainer, XAxis, YAxis, Tooltip, CartesianGrid, LabelList } from 'recharts';
import { Wallet, Receipt, TrendingUp, CalendarDays, Trash2, Printer, Loader2 } from 'lucide-react';
import Layout from '../components/Layout';
import { Card, StatTile, TabPills, DataTable, Flash } from '../components/ui';
import ReceiptPrintModal from '../components/ReceiptPrintModal';
import { api, peso } from '../api';
import { openReceiptForPrint, type PaymentReceipt } from '../lib/receiptPrint';

const GROUPS = [
  { key: 'month', label: 'Monthly' },
  { key: 'year', label: 'Yearly' },
];

export default function SalesReport() {
  const [range, setRange] = useState('month');
  const [sales, setSales] = useState<any>(null);
  const [tx, setTx] = useState<any[]>([]);
  const [flash, setFlash] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [clearMonth, setClearMonth] = useState('');
  const [busy, setBusy] = useState(false);
  const [reprintId, setReprintId] = useState<number | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<PaymentReceipt | null>(null);

  const loadSales = () => api.get(`/sales?group=${range}`).then((r) => setSales(r.data));
  const loadTx = () => api.get('/sales/transactions').then((r) => setTx(r.data));

  useEffect(() => {
    loadSales();
  }, [range]);
  useEffect(() => {
    loadTx();
  }, []);

  const refresh = () => {
    loadSales();
    loadTx();
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

  return (
    <Layout title="Sales Report">
      {flash && <Flash type={flash.type} message={flash.msg} onDismiss={() => setFlash(null)} />}
      {receiptPreview && (
        <ReceiptPrintModal receipt={receiptPreview} onClose={() => setReceiptPreview(null)} />
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-5 mb-5">
        <StatTile label="Net Revenue" value={peso(sales?.total ?? 0)} icon={Wallet} tone="text-brand-600" accent="from-brand-500/15 to-transparent" delay={0} />
        <StatTile label="Transactions" value={sales?.transactions ?? 0} icon={Receipt} delay={50} />
        <StatTile label="Average / day" value={peso(sales?.avgPerDay ?? 0)} icon={TrendingUp} accent="from-sky-500/15 to-transparent" delay={100} />
        <StatTile label="Best day" value={peso(sales?.best ?? 0)} icon={CalendarDays} accent="from-emerald-500/15 to-transparent" tone="text-emerald-600" delay={150} />
      </div>

      <Card title="Revenue" interactive right={<TabPills tabs={GROUPS} active={range} onChange={setRange} />}>
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
              <Bar dataKey="value" fill="url(#salesBar)" radius={[6, 6, 0, 0]} name="Amount">
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

      <div className="mt-5 space-y-5">
        <Card title="Clear reports" className="max-w-2xl">
          <p className="text-sm text-slate-500 mb-4">Remove payment transactions from the sales database. Charts and totals update immediately.</p>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="text-xs text-slate-500 block mb-1">Month (YYYY-MM)</label>
              <input
                className="input w-40 font-mono"
                placeholder="2026-07"
                value={clearMonth}
                onChange={(e) => setClearMonth(e.target.value)}
              />
            </div>
            <button type="button" className="btn-secondary" onClick={clearMonthReports} disabled={busy}>
              Clear selected month
            </button>
            <button type="button" className="inline-flex items-center gap-2 text-sm text-rose-600 border border-rose-200 rounded-lg px-4 py-2 hover:bg-rose-50" onClick={clearAll} disabled={busy}>
              <Trash2 size={15} /> Clear all reports
            </button>
          </div>
        </Card>

        <Card title="Recent Transactions">
          <DataTable
            columns={[
              { key: 'date', label: 'Date' },
              { key: 'customer', label: 'Customer' },
              { key: 'type', label: 'Type' },
              { key: 'amount', label: 'Amount', align: 'right' },
              { key: 'actions', label: '', align: 'right', sortable: false },
            ]}
            rows={tx.slice(0, 50).map((t) => ({
              key: t.id,
              sortValues: {
                date: t.date,
                customer: t.customer,
                type: t.type,
                amount: t.amount,
              },
              cells: [
                <span className="text-slate-500">{new Date(t.date).toLocaleString()}</span>,
                <span className="text-slate-700">{t.customer}</span>,
                <span className="text-slate-500 capitalize">{t.type}</span>,
                <span className="font-medium text-emerald-600">{peso(t.amount)}</span>,
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-brand-600 hover:text-brand-700 border border-brand-200 rounded-lg px-2.5 py-1.5 hover:bg-brand-50 disabled:opacity-50"
                  onClick={() => reprintReceipt(t.id)}
                  disabled={reprintId === t.id}
                  title="Reprint receipt"
                >
                  {reprintId === t.id ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />}
                  Reprint
                </button>,
              ],
            }))}
            emptyMessage="No transactions yet."
          />
        </Card>
      </div>
    </Layout>
  );
}
