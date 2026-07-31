import { useEffect, useState } from 'react';
import { ShieldAlert, RefreshCw, Ban, Check } from 'lucide-react';
import Layout from '../components/Layout';
import { Card, DataTable, StatTile, StatusBadge } from '../components/ui';
import { api } from '../api';
import { useRouterDevice } from '../context/RouterContext';

export default function RogueMacs() {
  const { current } = useRouterDevice();
  const [events, setEvents] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = () => api.get('/rogue-macs?status=open').then((r) => setEvents(r.data.events || []));

  useEffect(() => {
    load();
  }, []);

  const scan = async () => {
    if (!current?.id) {
      setMsg('Select a router in the top bar first.');
      return;
    }
    setBusy(true);
    setMsg('');
    try {
      const r = await api.post('/rogue-macs/scan', { routerId: current.id });
      setEvents(r.data.events || []);
      setMsg(`Scanned ${r.data.scanned} leases · ${r.data.rogueCount} unknown MAC(s)`);
    } catch (e: any) {
      setMsg(e?.response?.data?.error || 'Scan failed');
    } finally {
      setBusy(false);
    }
  };

  const trust = async (id: number) => {
    await api.post(`/rogue-macs/${id}/trust`);
    load();
  };
  const purge = async (id: number) => {
    if (!confirm('Block this DHCP lease on the MikroTik router?')) return;
    await api.post(`/rogue-macs/${id}/purge`);
    load();
  };

  return (
    <Layout title="Rogue MACs">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-5">
        <StatTile label="Open alerts" value={events.length} icon={ShieldAlert} tone="text-rose-600" delay={0} />
        <StatTile label="Router" value={current?.name || '—'} icon={ShieldAlert} delay={50} />
      </div>

      <Card
        title="Unauthorized DHCP clients"
        icon={ShieldAlert}
        right={
          <button className="btn-primary" onClick={scan} disabled={busy}>
            <RefreshCw size={16} className={busy ? 'animate-spin' : ''} /> {busy ? 'Scanning…' : 'Scan router'}
          </button>
        }
      >
        <p className="text-sm text-slate-500 mb-3">
          Compares live DHCP leases against known IPoE panel MACs and trusted entries. Unknown hardware can be blocked on the router.
        </p>
        {msg && <p className="text-sm text-slate-600 mb-3">{msg}</p>}
        <DataTable
          columns={[
            { key: 'mac', label: 'MAC' },
            { key: 'ip', label: 'Address' },
            { key: 'host', label: 'Hostname' },
            { key: 'seen', label: 'Last seen' },
            { key: 'status', label: 'Status' },
            { key: 'actions', label: '', align: 'right' },
          ]}
          rows={events.map((e) => ({
            key: e.id,
            cells: [
              <span className="font-mono text-xs font-medium">{e.mac}</span>,
              e.address || '—',
              e.hostname || '—',
              String(e.last_seen || '').replace('T', ' ').slice(0, 19),
              <StatusBadge status="Expired" />,
              <div className="flex justify-end gap-2">
                <button className="btn-secondary text-xs !py-1 inline-flex items-center gap-1" onClick={() => trust(e.id)}>
                  <Check size={12} /> Trust
                </button>
                <button className="btn-primary text-xs !py-1 inline-flex items-center gap-1 !bg-rose-600" onClick={() => purge(e.id)}>
                  <Ban size={12} /> Block
                </button>
              </div>,
            ],
          }))}
          emptyMessage="No open rogue MACs. Run a scan against the selected router."
        />
      </Card>
    </Layout>
  );
}
