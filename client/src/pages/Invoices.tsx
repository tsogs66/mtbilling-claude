import { useEffect, useState } from 'react';
import { FileText, Plus, Wallet, AlertTriangle, KeyRound } from 'lucide-react';
import Layout from '../components/Layout';
import { Card, DataTable, Modal, ModalFooter, FormField, StatTile, StatusBadge } from '../components/ui';
import { api, peso } from '../api';

export default function Invoices() {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [aging, setAging] = useState<any>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [payId, setPayId] = useState<number | null>(null);
  const [portalUser, setPortalUser] = useState<any>(null);
  const [subs, setSubs] = useState<any[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);

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

  const statusBadge = (s: string) => {
    if (s === 'paid') return <StatusBadge status="Active" />;
    if (s === 'overdue') return <StatusBadge status="Expired" />;
    if (s === 'void') return <StatusBadge status="inactive" />;
    return <StatusBadge status="Non-payment" />;
  };

  return (
    <Layout title="Invoices & AR">
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4 mb-5">
        <StatTile label="Total AR" value={peso(aging.total_ar || 0)} icon={Wallet} tone="text-rose-600" delay={0} />
        <StatTile label="Current" value={peso(aging.current || 0)} icon={FileText} delay={40} />
        <StatTile label="1–30 days" value={peso(aging.d1_30 || 0)} icon={AlertTriangle} tone="text-amber-600" delay={80} />
        <StatTile label="31–60 days" value={peso(aging.d31_60 || 0)} icon={AlertTriangle} tone="text-orange-600" delay={120} />
        <StatTile label="61+ days" value={peso(aging.d61_plus || 0)} icon={AlertTriangle} tone="text-rose-600" delay={160} />
        <StatTile label="Paid MTD" value={peso(aging.paid_this_month || 0)} icon={Wallet} tone="text-emerald-600" delay={200} />
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
              <div className="flex justify-end gap-2">
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
