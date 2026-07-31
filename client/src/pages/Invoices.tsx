import { useEffect, useMemo, useState } from 'react';
import {
  Pie, PieChart, Cell, ResponsiveContainer, Tooltip, Legend, BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from 'recharts';
import { FileText, Plus, Wallet, AlertTriangle, KeyRound, Printer, Eye } from 'lucide-react';
import Layout from '../components/Layout';
import { Card, DataTable, Modal, ModalFooter, FormField, StatTile, StatusBadge, PageHeader } from '../components/ui';
import { api, peso } from '../api';
import { openInvoicePrint } from '../lib/invoicePrint';

const AGING_COLORS = ['#10b981', '#f59e0b', '#f97316', '#f43f5e'];

export default function Invoices() {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [aging, setAging] = useState<any>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [payId, setPayId] = useState<number | null>(null);
  const [portalUser, setPortalUser] = useState<any>(null);
  const [subs, setSubs] = useState<any[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState<number | null>(null);

  const load = () =>
    api.get('/invoices').then((r) => {
      setInvoices(r.data.invoices || []);
      setAging(r.data.aging || {});
    });

  useEffect(() => {
    load();
    api.get('/pppoe/users?service=pppoe').then((r) => {
      const rows = Array.isArray(r.data) ? r.data : r.data.users || [];
      setSubs(rows.map((s: any) => ({
        ...s,
        customer_name: s.customer_name || s.customer,
        account_number: s.account_number || s.account,
      })));
    }).catch(() => {});
  }, []);

  const agingPie = useMemo(
    () =>
      [
        { name: 'Current', value: Number(aging.current || 0) },
        { name: '1–30d', value: Number(aging.d1_30 || 0) },
        { name: '31–60d', value: Number(aging.d31_60 || 0) },
        { name: '61d+', value: Number(aging.d61_plus || 0) },
      ].filter((x) => x.value > 0),
    [aging]
  );

  const statusBars = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const inv of invoices) {
      const s = String(inv.status || 'unpaid');
      counts[s] = (counts[s] || 0) + 1;
    }
    return Object.entries(counts).map(([status, count]) => ({ status, count }));
  }, [invoices]);

  const batch = async () => {
    if (!confirm('Generate unpaid invoices for all active subscribers with a plan price?')) return;
    setBatchBusy(true);
    try {
      const r = await api.post('/invoices/batch', {});
      alert(`Created ${r.data.created} invoice(s).`);
      load();
    } finally {
      setBatchBusy(false);
    }
  };

  const voidInv = async (id: number) => {
    if (!confirm('Void this invoice?')) return;
    await api.post(`/invoices/${id}/void`);
    load();
  };

  const printInvoice = async (id: number) => {
    setPreviewBusy(id);
    try {
      const r = await api.get(`/invoices/${id}/soa`);
      openInvoicePrint({
        company: r.data.company,
        invoice: r.data.invoice,
        history: (r.data.history || []).map((h: any) => ({
          amount: h.amount,
          method: h.method,
          paid_at: h.paid_at || h.created_at,
          note: h.note || h.reference,
        })),
      });
    } catch (e: any) {
      const inv = invoices.find((x) => x.id === id);
      if (inv) openInvoicePrint({ invoice: inv, history: [] });
      else alert(e?.response?.data?.error || 'Could not load invoice for print');
    } finally {
      setPreviewBusy(null);
    }
  };

  const statusBadge = (s: string) => {
    if (s === 'paid') return <StatusBadge status="Active" />;
    if (s === 'overdue') return <StatusBadge status="Expired" />;
    if (s === 'void') return <StatusBadge status="inactive" />;
    return <StatusBadge status="Non-payment" />;
  };

  return (
    <Layout title="Invoices & AR">
      <div className="mb-5">
        <PageHeader
          title="Invoices & receivables"
          description="Aging, status mix, and printable invoice / SOA for collectors."
          icon={FileText}
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4 mb-5">
        <StatTile label="Total AR" value={peso(aging.total_ar || 0)} icon={Wallet} tone="text-rose-600" delay={0} />
        <StatTile label="Current" value={peso(aging.current || 0)} icon={FileText} delay={40} />
        <StatTile label="1–30 days" value={peso(aging.d1_30 || 0)} icon={AlertTriangle} tone="text-amber-600" delay={80} />
        <StatTile label="31–60 days" value={peso(aging.d31_60 || 0)} icon={AlertTriangle} tone="text-orange-600" delay={120} />
        <StatTile label="61+ days" value={peso(aging.d61_plus || 0)} icon={AlertTriangle} tone="text-rose-600" delay={160} />
        <StatTile label="Paid MTD" value={peso(aging.paid_this_month || 0)} icon={Wallet} tone="text-emerald-600" delay={200} />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5 mb-5">
        <Card title="AR aging mix">
          <div className="h-52">
            {agingPie.length === 0 ? (
              <p className="text-sm text-slate-400 p-6">No open receivables.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={agingPie} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80}>
                    {agingPie.map((_, i) => (
                      <Cell key={i} fill={AGING_COLORS[i % AGING_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: number) => peso(v)} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>
        <Card title="Invoice status counts">
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={statusBars} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="status" tick={{ fontSize: 11, fill: '#94a3b8' }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#94a3b8' }} width={32} />
                <Tooltip />
                <Bar dataKey="count" fill="#0ea5e9" radius={[6, 6, 0, 0]} name="Invoices" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      <Card
        title="Invoices"
        icon={FileText}
        right={
          <div className="flex gap-2 flex-wrap">
            <button className="btn-secondary" onClick={() => setPortalUser({ pin: '' })}>
              <KeyRound size={16} /> Portal PIN
            </button>
            <button className="btn-secondary" onClick={batch} disabled={batchBusy}>
              {batchBusy ? 'Generating…' : 'Batch generate'}
            </button>
            <button className="btn-primary" onClick={() => setCreateOpen(true)}>
              <Plus size={16} /> New invoice
            </button>
          </div>
        }
      >
        <DataTable
          columns={[
            { key: 'number', label: 'Invoice' },
            { key: 'customer', label: 'Customer' },
            { key: 'due', label: 'Due' },
            { key: 'amount', label: 'Amount', align: 'right' },
            { key: 'paid', label: 'Paid', align: 'right' },
            { key: 'status', label: 'Status' },
            { key: 'actions', label: '', align: 'right' },
          ]}
          rows={invoices.map((inv) => ({
            key: inv.id,
            cells: [
              <span className="font-mono text-sm font-medium">{inv.number}</span>,
              <div>
                <div className="font-medium text-slate-800">{inv.customer_name || '—'}</div>
                <div className="text-xs text-slate-400">{inv.account_number || ''}</div>
              </div>,
              inv.due_date || '—',
              peso(inv.amount),
              peso(inv.amount_paid),
              statusBadge(inv.status),
              <div className="flex justify-end gap-2 flex-wrap">
                <button
                  type="button"
                  className="btn-secondary text-xs !py-1 inline-flex items-center gap-1"
                  onClick={() => printInvoice(inv.id)}
                  disabled={previewBusy === inv.id}
                  title="Preview & print invoice"
                >
                  {previewBusy === inv.id ? <Eye size={12} /> : <Printer size={12} />}
                  Print
                </button>
                {inv.status !== 'paid' && inv.status !== 'void' && (
                  <button className="btn-secondary text-xs !py-1" onClick={() => setPayId(inv.id)}>Record pay</button>
                )}
                {inv.status !== 'void' && inv.status !== 'paid' && (
                  <button className="text-xs text-rose-600" onClick={() => voidInv(inv.id)}>Void</button>
                )}
              </div>,
            ],
          }))}
          emptyMessage="No invoices yet. Batch-generate for the month or create one."
        />
      </Card>

      {createOpen && (
        <CreateInvoiceModal
          subs={subs}
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            setCreateOpen(false);
            load();
          }}
        />
      )}
      {payId != null && (
        <PayModal
          invoiceId={payId}
          onClose={() => setPayId(null)}
          onSaved={() => {
            setPayId(null);
            load();
          }}
        />
      )}
      {portalUser && (
        <PortalPinModal
          subs={subs}
          onClose={() => setPortalUser(null)}
        />
      )}
    </Layout>
  );
}


function CreateInvoiceModal({ subs, onClose, onSaved }: any) {
  const [form, setForm] = useState<any>({ pppoe_user_id: '', due_date: new Date().toISOString().slice(0, 10) });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/invoices', form);
      onSaved();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="New invoice" onClose={onClose} footer={<ModalFooter onCancel={onClose} onConfirm={save} busy={busy} />}>
      <div className="space-y-3">
        <FormField label="Subscriber" required>
          <select className="input" value={form.pppoe_user_id} onChange={(e) => setForm({ ...form, pppoe_user_id: Number(e.target.value) })}>
            <option value="">Select…</option>
            {subs.map((s: any) => (
              <option key={s.id} value={s.id}>{s.customer_name || s.username} — {peso(s.price)}</option>
            ))}
          </select>
        </FormField>
        <FormField label="Due date">
          <input type="date" className="input" value={form.due_date || ''} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
        </FormField>
        <FormField label="Amount override (optional)">
          <input type="number" className="input" value={form.amount ?? ''} onChange={(e) => setForm({ ...form, amount: e.target.value === '' ? undefined : Number(e.target.value) })} />
        </FormField>
      </div>
    </Modal>
  );
}

function PayModal({ invoiceId, onClose, onSaved }: any) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/invoices/${invoiceId}/pay`, { amount: amount ? Number(amount) : undefined, method });
      onSaved();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Record payment" onClose={onClose} footer={<ModalFooter onCancel={onClose} onConfirm={save} busy={busy} confirmLabel="Apply" />}>
      <div className="space-y-3">
        <FormField label="Amount (blank = remaining balance)">
          <input type="number" className="input" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </FormField>
        <FormField label="Method">
          <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="cash">Cash</option>
            <option value="gcash">GCash</option>
            <option value="maya">Maya</option>
            <option value="bank">Bank</option>
          </select>
        </FormField>
      </div>
    </Modal>
  );
}

function PortalPinModal({ subs, onClose }: any) {
  const [userId, setUserId] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const enable = async () => {
    setBusy(true);
    setMsg('');
    try {
      await api.post('/client-portal/enable', { pppoe_user_id: Number(userId), pin });
      setMsg('Portal enabled. Share account number + PIN with the subscriber. They log in at /portal');
    } catch (e: any) {
      setMsg(e?.response?.data?.error || 'Failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Enable client portal" onClose={onClose} footer={<ModalFooter onCancel={onClose} onConfirm={enable} busy={busy} confirmLabel="Enable" />}>
      <div className="space-y-3">
        <p className="text-sm text-slate-500">Subscribers use account number + PIN at <code className="text-brand-600">/portal</code> to view balance, SOA, and open support tickets.</p>
        <FormField label="Subscriber" required>
          <select className="input" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Select…</option>
            {subs.map((s: any) => (
              <option key={s.id} value={s.id}>{s.customer_name || s.username} ({s.account_number || s.username})</option>
            ))}
          </select>
        </FormField>
        <FormField label="PIN (4–8 digits)" required>
          <input className="input" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} placeholder="1234" />
        </FormField>
        {msg && <p className="text-sm text-slate-600">{msg}</p>}
      </div>
    </Modal>
  );
}
