import { useEffect, useState } from 'react';
import { Plus, Pencil, Trash2, Package, DollarSign, AlertTriangle } from 'lucide-react';
import Layout from '../components/Layout';
import { Card, StatusBadge, StatTile, DataTable, Modal, ModalFooter, FormField, IconAction } from '../components/ui';
import { api, peso } from '../api';

export default function Inventory() {
  const [items, setItems] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);

  const load = () => api.get('/inventory').then((r) => setItems(r.data));
  useEffect(() => {
    load();
  }, []);

  const totalValue = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0);
  const lowStock = items.filter((i) => i.status !== 'In Stock').length;

  const del = async (id: number) => {
    await api.delete(`/inventory/${id}`);
    load();
  };

  return (
    <Layout title="Stock & Inventory">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-5 mb-5">
        <StatTile label="SKUs" value={items.length} icon={Package} delay={0} />
        <StatTile label="Inventory Value" value={peso(totalValue)} icon={DollarSign} tone="text-brand-600" accent="from-brand-500/15 to-transparent" delay={50} />
        <StatTile label="Needs Restock" value={lowStock} icon={AlertTriangle} tone={lowStock > 0 ? 'text-amber-600' : 'text-slate-800'} dot={lowStock > 0 ? 'bg-amber-500' : undefined} accent="from-amber-500/15 to-transparent" delay={100} />
      </div>

      <Card title="Items" right={<button className="btn-primary" onClick={() => setEdit({ name: '', category: '', sku: '', quantity: 0, unit_price: 0 })}><Plus size={16} /> Add Item</button>}>
        <DataTable
          columns={[
            { key: 'item', label: 'Item' },
            { key: 'category', label: 'Category' },
            { key: 'sku', label: 'SKU' },
            { key: 'qty', label: 'Qty', align: 'right' },
            { key: 'unit', label: 'Unit Price', align: 'right' },
            { key: 'status', label: 'Status' },
            { key: 'actions', label: 'Actions', align: 'right' },
          ]}
          rows={items.map((i) => ({
            key: i.id,
            cells: [
              <span className="font-medium text-slate-800">{i.name}</span>,
              <span className="text-slate-500">{i.category}</span>,
              <span className="text-slate-500">{i.sku}</span>,
              <span className="text-slate-700">{i.quantity}</span>,
              <span className="text-slate-700">{peso(i.unitPrice)}</span>,
              <StatusBadge status={i.status} />,
              <div className="flex items-center justify-end gap-1">
                <IconAction icon={Pencil} title="Edit" tone="sky" onClick={() => setEdit({ ...i, unit_price: i.unitPrice })} />
                <IconAction icon={Trash2} title="Delete" tone="rose" onClick={() => del(i.id)} />
              </div>,
            ],
          }))}
          emptyMessage="No items yet."
        />
      </Card>

      {edit && (
        <ItemModal
          item={edit}
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

function ItemModal({ item, onClose, onSaved }: any) {
  const [form, setForm] = useState({ ...item });
  const [busy, setBusy] = useState(false);
  const isEdit = !!item.id;
  const set = (patch: any) => setForm((f: any) => ({ ...f, ...patch }));
  const save = async () => {
    if (!form.name?.trim()) return;
    setBusy(true);
    try {
      if (isEdit) await api.put(`/inventory/${item.id}`, form);
      else await api.post('/inventory', form);
      onSaved();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={isEdit ? 'Edit Item' : 'Add Item'}
      onClose={onClose}
      footer={<ModalFooter onCancel={onClose} onConfirm={save} busy={busy} />}
    >
      <div className="space-y-3">
        <FormField label="Name" required>
          <input className="input" value={form.name || ''} onChange={(e) => set({ name: e.target.value })} />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Category">
            <input className="input" value={form.category || ''} onChange={(e) => set({ category: e.target.value })} />
          </FormField>
          <FormField label="SKU">
            <input className="input" value={form.sku || ''} onChange={(e) => set({ sku: e.target.value })} />
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Quantity">
            <input className="input" type="number" value={form.quantity ?? 0} onChange={(e) => set({ quantity: Number(e.target.value) })} />
          </FormField>
          <FormField label="Unit Price">
            <input className="input" type="number" value={form.unit_price ?? 0} onChange={(e) => set({ unit_price: Number(e.target.value) })} />
          </FormField>
        </div>
      </div>
    </Modal>
  );
}
