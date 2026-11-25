import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Plus, Printer, RefreshCw, Trash2 } from 'lucide-react';
import Layout from '../components/Layout';
import { Modal, ModalFooter, FormField } from '../components/ui';
import {
  Col, compactMoney, money, moneyExact, num, PageBar, PanelHead, Reading, Readings, Table, TONE_VAR,
} from '../components/command/kit';
import { api, peso } from '../api';
import { openSalesReportPrint } from '../lib/invoicePrint';
import { useCompany } from '../context/CompanyContext';

const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/**
 * Financial reporting: MRR, income against expenses, receivables and the expense
 * ledger on one open page, with a print-ready sales snapshot.
 */
export default function Finance() {
  const { company } = useCompany();
  const navigate = useNavigate();
  const [data, setData] = useState<any>(null);
  const [sales, setSales] = useState<any>(null);
  const [edit, setEdit] = useState<any>(null);
  const [category, setCategory] = useState<string | null>(null);

  const load = useCallback(() => {
    api.get('/finance/summary').then((r) => setData(r.data));
    api.get('/sales?group=month').then((r) => setSales(r.data)).catch(() => setSales(null));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const plans = useMemo(
    () =>
      (data?.mrrByPlan || []).map((r: any) => ({
        plan: String(r.plan || '\u2014'),
        mrr: Number(r.mrr || 0),
        subscribers: Number(r.subscribers || 0),
      })),
    [data],
  );
  const categories = useMemo(
    () =>
      (data?.expensesByCategory || [])
        .map((c: any) => ({ name: String(c.category || 'other'), total: Number(c.total || 0) }))
        .sort((a: any, b: any) => b.total - a.total),
    [data],
  );

  if (!data) {
    return (
      <Layout title="Finance">
        <p className="text-sm opacity-60">Loading financial report…</p>
      </Layout>
    );
  }

  const income = Number(data.incomeThisMonth || 0);
  const expenses = Number(data.expensesThisMonth || 0);
  const net = Number(data.netThisMonth || 0);
  const mrr = Number(data.mrr || 0);
  const ar = Number(data.accountsReceivable || 0);
  const flowMax = Math.max(1, income, expenses);
  const plansMrr = plans.reduce((s: number, p: any) => s + p.mrr, 0);
  const plansMax = Math.max(1, ...plans.map((p: any) => p.mrr));
  const catMax = Math.max(1, ...categories.map((c: any) => c.total));
  const ledger = (data.expenses || []).filter((e: any) => !category || String(e.category || 'other') === category);
  const series: { label: string; value: number }[] = sales?.series || [];

  const companyPrint = company
    ? { name: company.name, address: company.address, phone: company.phone, email: company.email, logo: company.logo }
    : null;
  const printSales = () => {
    openSalesReportPrint({
      title: 'Sales & Finance Snapshot',
      companyName: company?.name || '',
      company: companyPrint,
      rangeLabel: `Month starting ${data.monthStart || 'this month'}`,
      total: Number(sales?.total ?? data.incomeThisMonth ?? 0),
      rows: series.map((s) => ({ label: s.label, value: Number(s.value || 0) })),
      meta: `MRR ${peso(data.mrr)} \u00b7 AR ${peso(data.accountsReceivable)} \u00b7 Net MTD ${peso(net)}`,
    });
  };

  const removeExpense = async (id: number) => {
    if (!confirm('Delete this expense?')) return;
    await api.delete(`/finance/expenses/${id}`);
    load();
  };

  const columns: Col<any>[] = [
    { key: 'date', label: 'Date', render: (e) => <span className="text-xs opacity-70">{e.spent_at}</span> },
    { key: 'cat', label: 'Category', render: (e) => <span className="capitalize">{e.category}</span> },
    { key: 'desc', label: 'Description', render: (e) => <span className="opacity-80">{e.description || '\u2014'}</span> },
    { key: 'amt', label: 'Amount', align: 'right', render: (e) => <span className="font-semibold">{peso(e.amount)}</span> },
    {
      key: 'actions',
      label: '',
      align: 'right',
      render: (e) => (
        <button type="button" className="cc-icon" style={{ color: TONE_VAR.bad }} onClick={() => removeExpense(e.id)} aria-label="Delete expense">
          <Trash2 size={14} />
        </button>
      ),
    },
  ];

  return (
    <Layout title="Finance">
      <div className="cc space-y-5 pb-10">
        <header className="space-y-3">
          <PageBar title="Financial reporting" subtitle={`Month starting ${data.monthStart || 'this month'} \u00b7 MRR, cashflow, receivables and expenses`}>
            <Link to="/sales" className="cc-btn">Sales detail</Link>
            <Link to="/invoices" className="cc-btn">Invoices / AR</Link>
            <button type="button" className="cc-btn" onClick={load} title="Refresh"><RefreshCw size={14} /></button>
            <button type="button" className="cc-btn is-on" onClick={printSales}>
              <Printer size={14} /> Print report
            </button>
          </PageBar>

          <Readings count={6}>
            <Reading label="Projected MRR" tone="info" value={money(mrr)} sub={`${num(data.activeSubscribers)} billed subscribers`} onClick={() => navigate('/pppoe')} />
            <Reading label="Income (MTD)" tone="good" value={money(income)} sub={mrr > 0 ? `${share(income, mrr)}% of MRR collected` : 'collected this month'} bar={mrr > 0 ? income / mrr : undefined} onClick={() => navigate('/sales')} />
            <Reading label="Expenses (MTD)" tone="warn" value={money(expenses)} sub={income > 0 ? `${share(expenses, income)}% of income` : 'logged this month'} bar={income > 0 ? expenses / income : undefined} />
            <Reading label="Net (MTD)" tone={net >= 0 ? 'good' : 'bad'} value={money(net)} sub={net >= 0 ? 'income after expenses' : 'spending ahead of income'} />
            <Reading label="Open AR" tone="bad" value={money(ar)} sub="unpaid invoice balance" onClick={() => navigate('/invoices')} />
            <Reading label="ARPU" value={money(data.activeSubscribers > 0 ? mrr / data.activeSubscribers : 0)} sub="MRR per billed subscriber" />
          </Readings>
        </header>

        <div className="grid gap-x-8 gap-y-5 lg:grid-cols-5">
          <section className="lg:col-span-2">
            <PanelHead title="Cashflow this month" note="Income against expenses" />
            <div className="space-y-4 py-2">
              {[
                { label: 'Income', value: income, tone: 'good' as const },
                { label: 'Expenses', value: expenses, tone: 'bad' as const },
              ].map((r) => (
                <div key={r.label}>
                  <div className="mb-1 flex items-baseline justify-between text-sm">
                    <span className="opacity-75">{r.label}</span>
                    <span className="font-semibold">{moneyExact(r.value)}</span>
                  </div>
                  <div className="h-3 overflow-hidden rounded-full" style={{ background: 'var(--card-border)' }}>
                    <div className="h-full rounded-full" style={{ width: `${(r.value / flowMax) * 100}%`, background: TONE_VAR[r.tone] }} />
                  </div>
                </div>
              ))}
              <div className="flex items-baseline justify-between border-t pt-3 text-sm" style={{ borderColor: 'var(--card-border)' }}>
                <span className="opacity-75">Net</span>
                <span className="text-lg font-bold" style={{ color: TONE_VAR[net >= 0 ? 'good' : 'bad'] }}>{moneyExact(net)}</span>
              </div>
            </div>
          </section>

          <section className="lg:col-span-3">
            <PanelHead title="Sales trend" note="Last 12 months of collected payments" actions={<Link to="/sales" className="cc-link">Open sales</Link>} />
            <div className="h-52">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="finArea" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--brand)" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="var(--brand)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="var(--card-border)" />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'currentColor' }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={24} />
                  <YAxis tick={{ fontSize: 10, fill: 'currentColor' }} width={52} axisLine={false} tickLine={false} tickFormatter={(v: number) => compactMoney(v)} />
                  <Tooltip
                    formatter={(v: number) => [moneyExact(v), 'Sales']}
                    contentStyle={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 8, fontSize: 12 }}
                  />
                  <Area type="monotone" dataKey="value" stroke="var(--brand)" fill="url(#finArea)" strokeWidth={2} name="Sales" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </section>
        </div>

        <section>
          <PanelHead
            title="Recurring revenue by plan"
            note="Click a plan to open its subscribers"
            actions={<span className="text-xs opacity-60">{money(plansMrr)} / month</span>}
          />
          {plans.length === 0 ? (
            <p className="cc-empty">No active priced subscribers.</p>
          ) : (
            <ul className="grid gap-x-10 md:grid-cols-2">
              {plans.map((p: any) => (
                <li key={p.plan}>
                  <button type="button" className="cc-seg-row w-full" onClick={() => navigate(`/pppoe?q=${encodeURIComponent(p.plan)}`)}>
                    <span className="flex items-baseline gap-3 text-sm">
                      <span className="min-w-0 flex-1 truncate font-medium">{p.plan}</span>
                      <span className="text-[11px] opacity-55">{num(p.subscribers)} subs · {share(p.mrr, plansMrr)}%</span>
                      <span className="w-24 text-right font-semibold">{money(p.mrr)}</span>
                    </span>
                    <span className="cc-pulse-bar mt-1 block"><i style={{ width: `${(p.mrr / plansMax) * 100}%` }} /></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="grid gap-x-8 gap-y-5 lg:grid-cols-5">
          <section className="lg:col-span-2">
            <PanelHead
              title="Expense mix"
              note="Click a category to filter the ledger"
              actions={category ? <button type="button" className="cc-link" onClick={() => setCategory(null)}>Show all</button> : undefined}
            />
            {categories.length === 0 ? (
              <p className="cc-empty">No expenses logged yet.</p>
            ) : (
              <ul className="space-y-0.5">
                {categories.map((c: any) => (
                  <li key={c.name}>
                    <button
                      type="button"
                      className="cc-seg-row w-full"
                      style={category === c.name ? { background: 'var(--cc-hover)' } : undefined}
                      onClick={() => setCategory((cur) => (cur === c.name ? null : c.name))}
                    >
                      <span className="flex items-baseline gap-3 text-sm">
                        <span className="min-w-0 flex-1 truncate capitalize">{c.name}</span>
                        <span className="text-[11px] opacity-55">{share(c.total, expenses || categories.reduce((s: number, x: any) => s + x.total, 0))}%</span>
                        <span className="w-24 text-right font-semibold">{money(c.total)}</span>
                      </span>
                      <span className="cc-pulse-bar mt-1 block"><i style={{ width: `${(c.total / catMax) * 100}%`, background: TONE_VAR.warn }} /></span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="lg:col-span-3">
            <PanelHead
              title="Expense ledger"
              note={category ? `${category} only` : 'Most recent first'}
              actions={
                <button
                  type="button"
                  className="cc-btn is-on"
                  onClick={() => setEdit({ category: category || 'opex', amount: '', spent_at: new Date().toISOString().slice(0, 10), description: '' })}
                >
                  <Plus size={14} /> Add expense
                </button>
              }
            />
            <Table columns={columns} rows={ledger} rowKey={(e: any) => e.id} empty="No expenses logged this period." />
          </section>
        </div>
      </div>

      {edit && (
        <ExpenseModal
          initial={edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            load();
          }}
        />
      )}
    </Layout>
  );
}

function ExpenseModal({ initial, onClose, onSaved }: any) {
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/finance/expenses', { ...form, amount: Number(form.amount) });
      onSaved();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Add expense" onClose={onClose} footer={<ModalFooter onCancel={onClose} onConfirm={save} busy={busy} />}>
      <div className="space-y-3">
        <FormField label="Date">
          <input type="date" className="input" value={form.spent_at || ''} onChange={(e) => setForm({ ...form, spent_at: e.target.value })} />
        </FormField>
        <FormField label="Category">
          <input className="input" value={form.category || ''} onChange={(e) => setForm({ ...form, category: e.target.value })} />
        </FormField>
        <FormField label="Description">
          <input className="input" value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </FormField>
        <FormField label="Amount" required>
          <input type="number" className="input" value={form.amount ?? ''} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </FormField>
      </div>
    </Modal>
  );
}
