import { useEffect, useMemo, useState } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import {
  TrendingUp, Wallet, Receipt, Plus, Trash2, Printer, FileText, PieChart as PieIcon, ArrowUpRight, ArrowDownRight,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import Layout from '../components/Layout';
import {
  Card, DataTable, Modal, ModalFooter, FormField, StatTile, TabPills, PageHeader,
} from '../components/ui';
import { api, peso } from '../api';
import { openSalesReportPrint } from '../lib/invoicePrint';
import { useCompany } from '../context/CompanyContext';

const PIE_COLORS = ['#0ea5e9', '#10b981', '#f59e0b', '#f43f5e', '#8b5cf6', '#64748b', '#14b8a6'];

/**
 * Comprehensive financial reporting hub — MRR, income vs expense, AR, expenses
 * with charts + print-ready sales snapshot.
 */
export default function Finance() {
  const { company } = useCompany();
  const [data, setData] = useState<any>(null);
  const [sales, setSales] = useState<any>(null);
  const [edit, setEdit] = useState<any>(null);
  const [tab, setTab] = useState('overview');

  const load = () => {
    api.get('/finance/summary').then((r) => setData(r.data));
    api.get('/sales?group=month').then((r) => setSales(r.data)).catch(() => setSales(null));
  };
  useEffect(() => {
    load();
  }, []);

  const expensePie = useMemo(
    () =>
      (data?.expensesByCategory || []).map((c: any) => ({
        name: c.category || 'other',
        value: Number(c.total || 0),
      })),
    [data]
  );

  const mrrBars = useMemo(
    () =>
      (data?.mrrByPlan || []).map((r: any) => ({
        plan: String(r.plan || '—').slice(0, 18),
        mrr: Number(r.mrr || 0),
        subscribers: Number(r.subscribers || 0),
      })),
    [data]
  );

  const cashflow = useMemo(() => {
    const income = Number(data?.incomeThisMonth || 0);
    const expenses = Number(data?.expensesThisMonth || 0);
    return [
      { name: 'Income', value: income, fill: '#10b981' },
      { name: 'Expenses', value: expenses, fill: '#f43f5e' },
      { name: 'Net', value: Math.max(0, income - expenses), fill: '#0ea5e9' },
    ];
  }, [data]);

  if (!data) {
    return (
      <Layout title="Finance">
        <p className="text-slate-500 text-sm">Loading financial report…</p>
      </Layout>
    );
  }

  const net = Number(data.netThisMonth || 0);
  const companyPrint = company
    ? {
        name: company.name,
        address: company.address,
        phone: company.phone,
        email: company.email,
        logo: company.logo,
      }
    : null;
  const printSales = () => {
    openSalesReportPrint({
      title: 'Sales & Finance Snapshot',
      companyName: company?.name || '',
      company: companyPrint,
      rangeLabel: `Month starting ${data.monthStart || 'this month'}`,
      total: Number(sales?.total ?? data.incomeThisMonth ?? 0),
      rows: (sales?.series || []).map((s: any) => ({ label: s.label, value: Number(s.value || 0) })),
      meta: `MRR ${peso(data.mrr)} · AR ${peso(data.accountsReceivable)} · Net MTD ${peso(net)}`,
    });
  };

  return (
    <Layout title="Finance">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <PageHeader
          title="Financial reporting"
          description="MRR, cashflow, accounts receivable, and expense mix — print sales/finance snapshot anytime."
          icon={TrendingUp}
        />
        <div className="flex flex-wrap gap-2">
          <Link to="/sales" className="btn-secondary text-sm">Sales detail</Link>
          <Link to="/invoices" className="btn-secondary text-sm">Invoices / AR</Link>
          <button type="button" className="btn-primary text-sm" onClick={printSales}>
            <Printer size={16} /> Print report
          </button>
        </div>
      </div>

      <div className="mb-5">
        <TabPills
          tabs={[
            { key: 'overview', label: 'Overview' },
            { key: 'mrr', label: 'MRR & plans' },
            { key: 'expenses', label: 'Expenses' },
          ]}
          active={tab}
          onChange={setTab}
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4 mb-6">
        <StatTile label="Projected MRR" value={peso(data.mrr)} icon={TrendingUp} tone="text-brand-600" accent="from-brand-500/15 to-transparent" delay={0} />
        <StatTile label="Active billed" value={data.activeSubscribers} icon={Wallet} delay={40} />
        <StatTile label="Income (MTD)" value={peso(data.incomeThisMonth)} icon={ArrowUpRight} tone="text-emerald-600" delay={80} />
        <StatTile label="Expenses (MTD)" value={peso(data.expensesThisMonth)} icon={ArrowDownRight} tone="text-rose-600" delay={120} />
        <StatTile
          label="Net (MTD)"
          value={peso(net)}
          icon={TrendingUp}
          tone={net >= 0 ? 'text-emerald-600' : 'text-rose-600'}
          delay={160}
        />
      </div>

      {tab === 'overview' && (
        <>
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-5 mb-5">
            <Card title="Cashflow this month" icon={Wallet} className="xl:col-span-1">
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={cashflow} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                    <XAxis dataKey="name" tick={{ fontSize: 12, fill: '#94a3b8' }} />
                    <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} tickFormatter={(v) => (v >= 1000 ? `₱${v / 1000}k` : `₱${v}`)} width={48} />
                    <Tooltip formatter={(v: number) => peso(v)} contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0' }} />
                    <Bar dataKey="value" radius={[8, 8, 0, 0]}>
                      {cashflow.map((e) => (
                        <Cell key={e.name} fill={e.fill} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className="text-xs text-slate-500 mt-2">
                Open AR: <b className="text-slate-800">{peso(data.accountsReceivable)}</b>
              </p>
            </Card>

            <Card title="Sales trend" icon={TrendingUp} className="xl:col-span-2" right={<Link to="/sales" className="text-sm text-brand-600">Open sales →</Link>}>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={sales?.series || []} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="finArea" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#0ea5e9" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#0ea5e9" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} />
                    <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} tickFormatter={(v) => (v >= 1000 ? `₱${v / 1000}k` : `₱${v}`)} width={48} />
                    <Tooltip formatter={(v: number) => peso(v)} contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0' }} />
                    <Area type="monotone" dataKey="value" stroke="#0284c7" fill="url(#finArea)" strokeWidth={2} name="Sales" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card className="bg-gradient-to-br from-sky-50 to-white border-sky-100">
              <div className="flex items-center gap-2 text-sky-700 text-sm font-semibold mb-1"><PieIcon size={16} /> Health snapshot</div>
              <p className="text-2xl font-bold text-slate-900">{data.activeSubscribers} <span className="text-sm font-medium text-slate-500">active</span></p>
              <p className="text-xs text-slate-500 mt-1">Projected MRR {peso(data.mrr)}</p>
            </Card>
            <Card className="bg-gradient-to-br from-emerald-50 to-white border-emerald-100">
              <div className="flex items-center gap-2 text-emerald-700 text-sm font-semibold mb-1"><FileText size={16} /> Collections</div>
              <p className="text-2xl font-bold text-slate-900">{peso(data.incomeThisMonth)}</p>
              <p className="text-xs text-slate-500 mt-1">Income month-to-date</p>
            </Card>
            <Card className="bg-gradient-to-br from-rose-50 to-white border-rose-100">
              <div className="flex items-center gap-2 text-rose-700 text-sm font-semibold mb-1"><Receipt size={16} /> Receivables</div>
              <p className="text-2xl font-bold text-slate-900">{peso(data.accountsReceivable)}</p>
              <p className="text-xs text-slate-500 mt-1">Open invoice balance</p>
            </Card>
          </div>
        </>
      )}

      {tab === 'mrr' && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
          <Card title="MRR by plan" icon={TrendingUp}>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={mrrBars} layout="vertical" margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
                  <XAxis type="number" tick={{ fontSize: 11, fill: '#94a3b8' }} tickFormatter={(v) => (v >= 1000 ? `₱${v / 1000}k` : `₱${v}`)} />
                  <YAxis type="category" dataKey="plan" width={100} tick={{ fontSize: 11, fill: '#64748b' }} />
                  <Tooltip formatter={(v: number) => peso(v)} contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0' }} />
                  <Bar dataKey="mrr" fill="#0ea5e9" radius={[0, 6, 6, 0]} name="MRR" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <Card title="Plan mix" icon={Wallet}>
            <DataTable
              columns={[
                { key: 'plan', label: 'Plan / profile' },
                { key: 'subs', label: 'Subs', align: 'right' },
                { key: 'mrr', label: 'MRR', align: 'right' },
              ]}
              rows={(data.mrrByPlan || []).map((r: any) => ({
                key: r.plan,
                cells: [r.plan, r.subscribers, peso(r.mrr)],
              }))}
              emptyMessage="No active priced subscribers."
            />
          </Card>
        </div>
      )}

      {tab === 'expenses' && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
          <Card title="Expense mix" icon={PieIcon}>
            <div className="h-64">
              {expensePie.length === 0 ? (
                <p className="text-sm text-slate-400 p-6">No expenses logged yet.</p>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={expensePie} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={2}>
                      {expensePie.map((_: any, i: number) => (
                        <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v: number) => peso(v)} />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </Card>
          <Card
            title="Expense ledger"
            icon={Receipt}
            right={
              <button
                className="btn-primary"
                onClick={() =>
                  setEdit({ category: 'opex', amount: '', spent_at: new Date().toISOString().slice(0, 10), description: '' })
                }
              >
                <Plus size={16} /> Add
              </button>
            }
          >
            <DataTable
              columns={[
                { key: 'date', label: 'Date' },
                { key: 'cat', label: 'Category' },
                { key: 'desc', label: 'Description' },
                { key: 'amt', label: 'Amount', align: 'right' },
                { key: 'actions', label: '', align: 'right' },
              ]}
              rows={(data.expenses || []).map((e: any) => ({
                key: e.id,
                cells: [
                  e.spent_at,
                  e.category,
                  e.description || '—',
                  peso(e.amount),
                  <button
                    className="text-rose-500"
                    onClick={async () => {
                      await api.delete(`/finance/expenses/${e.id}`);
                      load();
                    }}
                  >
                    <Trash2 size={14} />
                  </button>,
                ],
              }))}
              emptyMessage="No expenses logged this period."
            />
          </Card>
        </div>
      )}

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
