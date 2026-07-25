import { useEffect, useState } from 'react';
import { Ticket, Trash2, Plus, Users, Wifi } from 'lucide-react';
import Layout from '../components/Layout';
import { Card, DataTable, IconAction, StatTile, StatusBadge } from '../components/ui';
import { api, peso } from '../api';

const PLAN_NAMES = ['1 Hour', '1 Day', '1 Week', '30 Days'];

export default function Hotspot() {
  const [data, setData] = useState<{ plans: any[]; active: any[] }>({ plans: [], active: [] });
  const [vouchers, setVouchers] = useState<any[]>([]);
  const [plan, setPlan] = useState('1 Day');
  const [count, setCount] = useState(10);
  const [busy, setBusy] = useState(false);

  const loadVouchers = () => api.get('/hotspot/vouchers').then((r) => setVouchers(r.data));
  useEffect(() => {
    api.get('/hotspot').then((r) => setData(r.data));
    loadVouchers();
  }, []);

  const generate = async () => {
    setBusy(true);
    try {
      await api.post('/hotspot/vouchers/generate', { plan, count });
      loadVouchers();
    } finally {
      setBusy(false);
    }
  };
  const del = async (id: number) => {
    await api.delete(`/hotspot/vouchers/${id}`);
    loadVouchers();
  };

  const unused = vouchers.filter((v) => v.status === 'unused').length;
  const used = vouchers.length - unused;

  const activeRows = data.active.map((a) => ({
    key: a.voucher,
    cells: [
      <span key="voucher" className="font-medium text-slate-800">{a.voucher}</span>,
      a.plan,
      a.address,
      a.uptime,
    ],
  }));

  const voucherRows = vouchers.map((v) => ({
    key: v.id,
    cells: [
      <span key="code" className="font-mono font-medium text-slate-800">{v.code}</span>,
      v.plan,
      <span key="price" className="text-slate-700">{peso(v.price)}</span>,
      v.speed,
      <StatusBadge key="status" status={v.status === 'unused' ? 'Active' : 'inactive'} />,
      <IconAction key="del" icon={Trash2} title="Delete voucher" onClick={() => del(v.id)} tone="rose" />,
    ],
  }));

  return (
    <Layout title="Hotspot">
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <Card title="Voucher Plans" icon={Ticket}>
          <div className="grid grid-cols-2 gap-3">
            {data.plans.map((p) => (
              <Card key={p.name} interactive className="!shadow-none">
                <div className="font-semibold text-slate-800">{p.name}</div>
                <div className="text-2xl font-bold text-brand-600 my-1">{peso(p.price)}</div>
                <div className="text-xs text-slate-400">{p.speed} · valid {p.validity}</div>
              </Card>
            ))}
          </div>
        </Card>

        <Card title="Active Hotspot Users" icon={Wifi}>
          <DataTable
            columns={[
              { key: 'voucher', label: 'Voucher' },
              { key: 'plan', label: 'Plan' },
              { key: 'address', label: 'Address' },
              { key: 'uptime', label: 'Uptime' },
            ]}
            rows={activeRows}
            emptyMessage="No active hotspot users."
          />
        </Card>
      </div>

      <div className="mt-5">
        <Card
          title="Voucher Management"
          icon={Users}
          right={
            <div className="flex items-center gap-2">
              <select className="text-sm border border-slate-200 rounded-lg px-2 py-1.5" value={plan} onChange={(e) => setPlan(e.target.value)}>
                {PLAN_NAMES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <input className="text-sm border border-slate-200 rounded-lg px-2 py-1.5 w-20" type="number" min={1} max={200} value={count} onChange={(e) => setCount(Number(e.target.value))} />
              <button className="btn-primary" onClick={generate} disabled={busy}><Plus size={16} /> {busy ? 'Generating…' : 'Generate'}</button>
            </div>
          }
        >
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-4">
            <StatTile
              label="Total vouchers"
              value={vouchers.length}
              icon={Ticket}
              tone="text-slate-800"
              accent="from-brand-500/10 to-transparent"
              delay={0}
            />
            <StatTile
              label="Unused"
              value={unused}
              icon={Ticket}
              tone="text-emerald-600"
              dot="bg-emerald-500"
              accent="from-emerald-500/15 to-transparent"
              delay={50}
            />
            <StatTile
              label="Used"
              value={used}
              icon={Users}
              tone="text-slate-500"
              accent="from-slate-500/10 to-transparent"
              delay={100}
            />
          </div>
          <div className="max-h-96 overflow-y-auto">
            <DataTable
              columns={[
                { key: 'code', label: 'Code' },
                { key: 'plan', label: 'Plan' },
                { key: 'price', label: 'Price', align: 'right' },
                { key: 'speed', label: 'Speed' },
                { key: 'status', label: 'Status' },
                { key: 'actions', label: 'Actions', align: 'right' },
              ]}
              rows={voucherRows}
              stickyHeader
              emptyMessage="No vouchers yet. Generate a batch above."
            />
          </div>
        </Card>
      </div>
    </Layout>
  );
}
