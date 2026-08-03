import { useEffect, useState } from 'react';
import { ClipboardList, Plus, Pencil, Trash2, Wrench } from 'lucide-react';
import Layout from '../components/Layout';
import { Card, DataTable, IconAction, Modal, ModalFooter, FormField, StatTile, StatusBadge, TabPills } from '../components/ui';
import { api } from '../api';
import { subscribePortalLive } from '../lib/portalLive';

const TYPES = [
  { key: 'new_install', label: 'New Install' },
  { key: 'repair', label: 'Repair' },
  { key: 'follow_up', label: 'Follow-up' },
  { key: 'disconnect', label: 'Disconnect' },
  { key: 'other', label: 'Other' },
];
const STATUSES = [
  { key: '', label: 'All' },
  { key: 'open', label: 'Open' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'follow_up', label: 'Follow-up' },
  { key: 'completed', label: 'Completed' },
  { key: 'cancelled', label: 'Cancelled' },
];

export default function JobOrders() {
  const [jobs, setJobs] = useState<any[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [status, setStatus] = useState('');
  const [edit, setEdit] = useState<any>(null);
  const [subs, setSubs] = useState<any[]>([]);

  const load = () =>
    api.get(`/job-orders${status ? `?status=${status}` : ''}`).then((r) => {
      setJobs(r.data.jobs || []);
      setCounts(r.data.counts || {});
    });

  useEffect(() => {
    load();
  }, [status]);

  useEffect(() => {
    const token = localStorage.getItem('mt_token') || '';
    return subscribePortalLive({
      path: '/client-portal/events',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      onEvent: (event, data) => {
        if (event === 'ticket' || data?.type === 'ticket') load();
      },
    });
  }, [status]);

  useEffect(() => {
    api.get('/pppoe/users?service=pppoe').then((r) => {
      const rows = Array.isArray(r.data) ? r.data : r.data.users || [];
      setSubs(rows.map((s: any) => ({
        ...s,
        customer_name: s.customer_name || s.customer,
        account_number: s.account_number || s.account,
      })));
    }).catch(() => {});
  }, []);

  const del = async (id: number) => {
    if (!confirm('Delete this job order?')) return;
    await api.delete(`/job-orders/${id}`);
    load();
  };

  return (
    <Layout title="Job Orders">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
        <StatTile label="Open" value={counts.open || 0} icon={ClipboardList} tone="text-sky-600" delay={0} />
        <StatTile label="In Progress" value={counts.in_progress || 0} icon={Wrench} tone="text-amber-600" delay={50} />
        <StatTile label="Follow-up" value={counts.follow_up || 0} icon={ClipboardList} tone="text-orange-600" delay={100} />
        <StatTile label="Completed" value={counts.completed || 0} icon={ClipboardList} tone="text-emerald-600" delay={150} />
      </div>

      <Card
        title="Field Job Orders"
        icon={ClipboardList}
        right={
          <button className="btn-primary" onClick={() => setEdit({ type: 'repair', status: 'open', priority: 'normal' })}>
            <Plus size={16} /> New Job
          </button>
        }
      >
        <div className="mb-4">
          <TabPills
            tabs={STATUSES.map((s) => ({ key: s.key || 'all', label: s.label }))}
            active={status || 'all'}
            onChange={(k) => setStatus(k === 'all' ? '' : k)}
          />
        </div>
        <DataTable
          columns={[
            { key: 'number', label: 'JO #' },
            { key: 'customer', label: 'Customer' },
            { key: 'type', label: 'Type' },
            { key: 'status', label: 'Status' },
            { key: 'tech', label: 'Assigned' },
            { key: 'actions', label: '', align: 'right' },
          ]}
          rows={jobs.map((j) => ({
            key: j.id,
            cells: [
              <span className="font-mono text-sm font-medium text-slate-800">{j.number}</span>,
              <div>
                <div className="font-medium text-slate-800">{j.customer_name || '—'}</div>
                <div className="text-xs text-slate-400">{j.contact || j.address || ''}</div>
              </div>,
              TYPES.find((t) => t.key === j.type)?.label || j.type,
              <StatusBadge
                status={STATUSES.find((s) => s.key === j.status)?.label || j.status}
              />,
              j.assigned_to || '—',
              <div className="flex justify-end gap-1">
                <IconAction icon={Pencil} title="Edit" tone="sky" onClick={() => setEdit(j)} />
                <IconAction icon={Trash2} title="Delete" tone="rose" onClick={() => del(j.id)} />
              </div>,
            ],
          }))}
          emptyMessage="No job orders yet."
        />
      </Card>

      {edit && (
        <JobModal
          job={edit}
          subs={subs}
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

function JobModal({ job, subs, onClose, onSaved }: any) {
  const [form, setForm] = useState({ ...job });
  const [busy, setBusy] = useState(false);
  const set = (p: any) => setForm((f: any) => ({ ...f, ...p }));
  const save = async () => {
    setBusy(true);
    try {
      if (form.id) await api.put(`/job-orders/${form.id}`, form);
      else await api.post('/job-orders', form);
      onSaved();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={form.id ? `Edit ${form.number}` : 'New Job Order'} onClose={onClose} footer={<ModalFooter onCancel={onClose} onConfirm={save} busy={busy} />}>
      <div className="space-y-3">
        <FormField label="Link subscriber">
          <select
            className="input"
            value={form.pppoe_user_id || ''}
            onChange={(e) => {
              const id = Number(e.target.value) || null;
              const u = subs.find((s: any) => s.id === id);
              set({
                pppoe_user_id: id,
                customer_name: u?.customer_name || u?.username || form.customer_name,
                contact: u?.contact || form.contact,
                address: u?.address || form.address,
              });
            }}
          >
            <option value="">— Optional —</option>
            {subs.map((s: any) => (
              <option key={s.id} value={s.id}>{s.customer_name || s.username} ({s.account_number || s.username})</option>
            ))}
          </select>
        </FormField>
        <FormField label="Customer name">
          <input className="input" value={form.customer_name || ''} onChange={(e) => set({ customer_name: e.target.value })} />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Type">
            <select className="input" value={form.type || 'repair'} onChange={(e) => set({ type: e.target.value })}>
              {TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
            </select>
          </FormField>
          <FormField label="Status">
            <select className="input" value={form.status || 'open'} onChange={(e) => set({ status: e.target.value })}>
              {STATUSES.filter((s) => s.key).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Priority">
            <select className="input" value={form.priority || 'normal'} onChange={(e) => set({ priority: e.target.value })}>
              <option value="normal">Normal</option>
              <option value="high">High</option>
              <option value="urgent">Urgent</option>
            </select>
          </FormField>
          <FormField label="Assigned tech">
            <input className="input" value={form.assigned_to || ''} onChange={(e) => set({ assigned_to: e.target.value })} />
          </FormField>
        </div>
        <FormField label="Contact"><input className="input" value={form.contact || ''} onChange={(e) => set({ contact: e.target.value })} /></FormField>
        <FormField label="Address"><input className="input" value={form.address || ''} onChange={(e) => set({ address: e.target.value })} /></FormField>
        <FormField label="Description">
          <textarea className="input min-h-[80px]" value={form.description || ''} onChange={(e) => set({ description: e.target.value })} />
        </FormField>
        <FormField label="Notes">
          <textarea className="input min-h-[60px]" value={form.notes || ''} onChange={(e) => set({ notes: e.target.value })} />
        </FormField>
      </div>
    </Modal>
  );
}
