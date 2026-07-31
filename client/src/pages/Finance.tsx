import { useEffect, useState } from 'react';
import { TrendingUp, Wallet, Receipt, Plus, Trash2 } from 'lucide-react';
import Layout from '../components/Layout';
import { Card, DataTable, Modal, ModalFooter, FormField, StatTile, SectionTitle } from '../components/ui';
import { api, peso } from '../api';

export default function Finance() {
  const [data, setData] = useState<any>(null);
  const [edit, setEdit] = useState<any>(null);

  const load = () => api.get('/finance/summary').then((r) => setData(r.data));
  useEffect(() => {
    load();
  }, []);

  if (!data) {
    return (
      <Layout title="Finance">
        <p className="text-slate-500 text-sm">Loading…</p>
      </Layout>
    );
  }

  return (
    <Layout title="Finance & MRR">
      <SectionTitle icon={TrendingUp}>Projected monthly recurring revenue</SectionTitle>
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4 mb-8">
        <StatTile label="Projected MRR" value={peso(data.mrr)} icon={TrendingUp} tone="text-brand-600" accent="from-brand-500/15 to-transparent" delay={0} />
        <StatTile label="Active billed subs" value={data.activeSubscribers} icon={Wallet} delay={40} />
        <StatTile label="Income (MTD)" value={peso(data.incomeThisMonth)} icon={Wallet} tone="text-emerald-600" delay={80} />
        <StatTile label="Expenses (MTD)" value={peso(data.expensesThisMonth)} icon={Receipt} tone="text-rose-600" delay={120} />
        <StatTile
          label="Net (MTD)"
          value={peso(data.netThisMonth)}
          icon={TrendingUp}
          tone={data.netThisMonth >= 0 ? 'text-emerald-600' : 'text-rose-600'}
          delay={160}
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 mb-5">
        <Card title="MRR by plan" icon={TrendingUp}>
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
          <p className="text-xs text-slate-400 mt-3">Accounts receivable (open invoices): <b className="text-slate-700">{peso(data.accountsReceivable)}</b></p>
        </Card>

        <Card
          title="Expenses"
          icon={Receipt}
          right={<button className="btn-primary" onClick={() => setEdit({ category: 'opex', amount: '', spent_at: new Date().toISOString().slice(0, 10) })}><Plus size={16} /> Add</button>}
        >
          <div className="flex flex-wrap gap-2 mb-3">
            {(data.expensesByCategory || []).map((c: any) => (
              <span key={c.category} className="badge bg-slate-100 text-slate-600">{c.category}: {peso(c.total)}</span>
            ))}
          </div>
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

      {edit && (
        <ExpenseModal
          form={edit}
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

function ExpenseModal({ form: initial, onClose, onSaved }: any) {
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
        <FormField label="Category" required>
          <input className="input" value={form.category || ''} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="rent, power, bandwidth…" />
        </FormField>
        <FormField label="Amount" required>
          <input type="number" className="input" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </FormField>
        <FormField label="Date">
          <input type="date" className="input" value={form.spent_at || ''} onChange={(e) => setForm({ ...form, spent_at: e.target.value })} />
        </FormField>
        <FormField label="Description">
          <input className="input" value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </FormField>
      </div>
    </Modal>
  );
}
