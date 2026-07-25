import { useEffect, useMemo, useState } from 'react';
import { Share2, Shield, Route, Bot, RefreshCw, Plus, Trash2, Copy, Check, Router as RouterIcon, Radio } from 'lucide-react';
import Layout from '../components/Layout';
import { Card, StatusBadge, TabBar, DataTable, Toggle } from '../components/ui';
import { api } from '../api';
import { useRouterDevice } from '../context/RouterContext';
import { RoutersPanel } from './Routers';
import { OltsPanel } from './Olts';
import { copyText } from '../lib/clipboard';

const TABS = [
  { key: 'routers', label: 'Routers', icon: RouterIcon },
  { key: 'olt', label: 'OLT', icon: Radio },
  { key: 'wan', label: 'WAN & Failover', icon: Share2 },
  { key: 'firewall', label: 'Firewall', icon: Shield },
  { key: 'routes', label: 'Routes & VLANs', icon: Route },
  { key: 'multiwan', label: 'AI Multi-WAN', icon: Bot },
] as const;

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(2) : v < 100 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export default function Network() {
  const [tab, setTab] = useState(() => {
    const q = new URLSearchParams(window.location.search).get('tab');
    return q === 'routers' || q === 'olt' || q === 'wan' || q === 'firewall' || q === 'routes' || q === 'multiwan' ? q : 'routers';
  });
  const { current } = useRouterDevice();

  return (
    <Layout title="Network Management">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <TabBar tabs={[...TABS]} active={tab} onChange={setTab} />
        {tab !== 'routers' && tab !== 'olt' && (
          <span className="text-xs text-slate-500">
            {current ? (
              <>
                Live from <span className="font-semibold text-slate-700">{current.name}</span>
                {current.host ? <span className="text-slate-400"> ({current.host})</span> : null}
              </>
            ) : (
              'Select a router in the top bar'
            )}
          </span>
        )}
      </div>

      {tab === 'routers' && <RoutersPanel />}
      {tab === 'olt' && <OltsPanel />}
      {tab !== 'routers' && tab !== 'olt' && !current ? (
        <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 max-w-4xl">
          Select a MikroTik router with API credentials in the top bar. Network data is loaded live from that device — nothing is shown from sample/mock data.
        </div>
      ) : null}

      {tab !== 'routers' && tab !== 'olt' && current ? (
        <>
          {tab === 'wan' && <WanFailover routerId={current.id} routerName={current.name} />}
          {tab === 'firewall' && <Firewall routerId={current.id} />}
          {tab === 'routes' && <RoutesVlans routerId={current.id} />}
          {tab === 'multiwan' && <MultiWan routerId={current.id} />}
        </>
      ) : null}
    </Layout>
  );
}

function WanFailover({ routerId, routerName }: { routerId: number; routerName: string }) {
  const [routes, setRoutes] = useState<any[]>([]);
  const [live, setLive] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    setBusy(true);
    return api
      .get('/network/wan', { params: { routerId } })
      .then((r) => {
        setRoutes(r.data.routes || []);
        setLive(!!r.data.live);
        setError(r.data.error || '');
      })
      .catch((e) => {
        setRoutes([]);
        setLive(false);
        setError(e?.response?.data?.error || 'Could not load WAN routes from MikroTik');
      })
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routerId]);

  const allEnabled = routes.length > 0 && routes.every((r) => r.enabled);
  const toggleOne = async (id: number) => {
    try {
      await api.post(`/network/wan/${id}/toggle`);
      load();
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Could not toggle route on MikroTik');
    }
  };
  const toggleAll = async () => {
    try {
      const r = await api.post('/network/wan/toggle-all', { enabled: !allEnabled, routerId });
      if (r.data.errors?.length) setError(`Some routes failed: ${r.data.errors.join('; ')}`);
      else setError('');
      load();
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Could not toggle routes on MikroTik');
    }
  };

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="flex justify-end">
        <button type="button" className="btn-secondary text-sm" onClick={load} disabled={busy}>
          <RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>
      {error && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{error}</div>}
      {!live && routes.length === 0 && !error && (
        <div className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          No live WAN routes on {routerName}. Configure API credentials and ensure the router is reachable — routes with check-gateway (or default 0.0.0.0/0) appear here.
        </div>
      )}
      {routes.length > 0 && (
        <Card interactive>
          <div className="flex items-center justify-between">
            <div>
              <div className="font-semibold text-slate-800">Master Failover Switch</div>
              <div className="text-sm text-slate-400">
                Enable or disable monitored WAN routes on {routerName} (RouterOS /ip/route).
              </div>
            </div>
            <button
              onClick={toggleAll}
              className={`text-white text-sm font-medium px-4 py-2 rounded-lg ${allEnabled ? 'bg-rose-500 hover:bg-rose-600' : 'bg-emerald-500 hover:bg-emerald-600'}`}
            >
              {allEnabled ? 'Disable All' : 'Enable All'}
            </button>
          </div>
        </Card>
      )}

      <Card title="Monitored WAN Routes" noPadding>
        <DataTable
          columns={[
            { key: 'gateway', label: 'Gateway' },
            { key: 'iface', label: 'Interface' },
            { key: 'checkMethod', label: 'Check Method' },
            { key: 'distance', label: 'Distance' },
            { key: 'status', label: 'Status' },
            { key: 'enabled', label: 'Enabled', align: 'right' },
          ]}
          rows={routes.map((r) => ({
            key: r.id,
            cells: [
              <span className="text-sky-600 font-medium">{r.gateway}</span>,
              <span className="font-mono text-xs text-slate-500">{r.interfaceName || '—'}</span>,
              r.checkMethod,
              r.distance,
              <StatusBadge status={r.enabled ? 'Active' : 'disabled'} />,
              <div className="flex justify-end">
                <Toggle on={!!r.enabled} onChange={() => toggleOne(r.id)} label={`Toggle ${r.gateway}`} />
              </div>,
            ],
          }))}
          emptyMessage={live ? 'No monitored WAN routes on this router.' : 'WAN routes appear when the selected MikroTik is reachable.'}
        />
      </Card>
    </div>
  );
}

function Firewall({ routerId }: { routerId: number }) {
  const [rules, setRules] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);
  const [chainTab, setChainTab] = useState<'filter' | 'nat' | 'mangle'>('filter');
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ chain: 'input', action: 'accept', protocol: '', dstPort: '', comment: '' });

  const load = () => {
    setBusy(true);
    return api
      .get('/network/firewall', { params: { routerId } })
      .then((r) => {
        setRules(r.data.rules || []);
        setLive(!!r.data.live);
        setError(r.data.error || '');
      })
      .catch((e) => {
        setRules([]);
        setLive(false);
        setError(e?.response?.data?.error || 'Could not load firewall from MikroTik');
      })
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routerId]);

  const filtered = rules.filter((r) => r.table === chainTab);

  const toggle = async (r: any) => {
    try {
      await api.post('/network/firewall/toggle', { routerId, table: r.table, id: r.id, enabled: !r.enabled });
      load();
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Could not toggle firewall rule');
    }
  };

  const remove = async (r: any) => {
    if (!confirm(`Delete ${r.table} rule ${r.chain}/${r.action}?`)) return;
    try {
      await api.delete('/network/firewall', { params: { routerId, table: r.table, id: r.id } });
      load();
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Could not delete firewall rule');
    }
  };

  const add = async () => {
    try {
      await api.post('/network/firewall', {
        routerId,
        table: chainTab,
        chain: form.chain,
        action: form.action,
        protocol: form.protocol || undefined,
        dstPort: form.dstPort || undefined,
        comment: form.comment || undefined,
      });
      setAddOpen(false);
      setForm({ chain: chainTab === 'nat' ? 'srcnat' : 'input', action: chainTab === 'nat' ? 'masquerade' : 'accept', protocol: '', dstPort: '', comment: '' });
      load();
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Could not add firewall rule');
    }
  };

  return (
    <div className="space-y-3 max-w-6xl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
          {(['filter', 'nat', 'mangle'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => {
                setChainTab(t);
                setForm((f) => ({
                  ...f,
                  chain: t === 'nat' ? 'srcnat' : t === 'mangle' ? 'prerouting' : 'input',
                  action: t === 'nat' ? 'masquerade' : t === 'mangle' ? 'mark-connection' : 'accept',
                }));
              }}
              className={`px-3 py-1.5 text-sm font-medium rounded-md capitalize ${chainTab === t ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary text-sm" onClick={load} disabled={busy}>
            <RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> Refresh
          </button>
          <button type="button" className="btn-primary text-sm" onClick={() => setAddOpen((v) => !v)} disabled={!live}>
            <Plus size={14} /> Add Rule
          </button>
        </div>
      </div>
      {error && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{error}</div>}
      {addOpen && (
        <Card className="p-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <input className="input" placeholder="Chain" value={form.chain} onChange={(e) => setForm({ ...form, chain: e.target.value })} />
            <input className="input" placeholder="Action" value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })} />
            <input className="input" placeholder="Protocol" value={form.protocol} onChange={(e) => setForm({ ...form, protocol: e.target.value })} />
            <input className="input" placeholder="Dst port" value={form.dstPort} onChange={(e) => setForm({ ...form, dstPort: e.target.value })} />
            <input className="input" placeholder="Comment" value={form.comment} onChange={(e) => setForm({ ...form, comment: e.target.value })} />
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button type="button" className="btn-secondary text-sm" onClick={() => setAddOpen(false)}>Cancel</button>
            <button type="button" className="btn-primary text-sm" onClick={add}>Add on MikroTik</button>
          </div>
        </Card>
      )}
      <Card title={`${chainTab.toUpperCase()} Rules`} noPadding>
        <DataTable
          columns={[
            { key: '#', label: '#' },
            { key: 'chain', label: 'Chain' },
            { key: 'action', label: 'Action' },
            { key: 'addr', label: 'Src / Dst' },
            { key: 'data', label: 'Data' },
            { key: 'comment', label: 'Comment' },
            { key: 'actions', label: 'Actions', align: 'right' },
          ]}
          rows={filtered.map((r, i) => ({
            key: r.id || i,
            cells: [
              i,
              r.chain,
              <span className="font-medium text-slate-800">{r.action}</span>,
              <span className="font-mono text-xs text-slate-600">
                {r.srcAddress !== '-' ? r.srcAddress : '—'} / {r.dstAddress !== '-' ? r.dstAddress : '—'}
              </span>,
              <span className="text-xs text-slate-500">
                {formatBytes(Number(r.bytes) || 0)} / {Number(r.packets) || 0} pkts
              </span>,
              <span className="text-slate-500">{r.comment || '—'}</span>,
              <div className="flex items-center justify-end gap-2">
                <Toggle on={!!r.enabled} onChange={() => toggle(r)} label={`Toggle rule ${i}`} />
                <button type="button" className="text-rose-500 hover:text-rose-700" onClick={() => remove(r)} title="Delete on MikroTik">
                  <Trash2 size={15} />
                </button>
              </div>,
            ],
          }))}
          emptyMessage={live ? `No ${chainTab} rules on this router.` : 'Firewall rules load from the selected MikroTik.'}
        />
      </Card>
    </div>
  );
}

function RoutesVlans({ routerId }: { routerId: number }) {
  const [data, setData] = useState<{ routes: any[]; vlans: any[] }>({ routes: [], vlans: [] });
  const [parentIfaces, setParentIfaces] = useState<{ name: string; type: string; running: boolean }[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);
  const [routeForm, setRouteForm] = useState({ dst: '0.0.0.0/0', gateway: '', distance: '1', comment: '' });
  const [vlanForm, setVlanForm] = useState({ name: '', vlanId: '', iface: '', comment: '' });
  const [showRoute, setShowRoute] = useState(false);
  const [showVlan, setShowVlan] = useState(false);

  const load = () => {
    setBusy(true);
    return api
      .get('/network/routes', { params: { routerId } })
      .then((r) => {
        setData({ routes: r.data.routes || [], vlans: r.data.vlans || [] });
        setParentIfaces(r.data.parentInterfaces || []);
        setLive(!!r.data.live);
        setError(r.data.error || '');
        const ifaces: { name: string }[] = r.data.parentInterfaces || [];
        if (ifaces.length && !vlanForm.iface) {
          setVlanForm((f) => ({ ...f, iface: ifaces[0].name }));
        }
      })
      .catch((e) => {
        setData({ routes: [], vlans: [] });
        setParentIfaces([]);
        setLive(false);
        setError(e?.response?.data?.error || 'Could not load routes/VLANs from MikroTik');
      })
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routerId]);

  const addRoute = async () => {
    try {
      await api.post('/network/routes', {
        routerId,
        dst: routeForm.dst,
        gateway: routeForm.gateway,
        distance: Number(routeForm.distance) || 1,
        comment: routeForm.comment || undefined,
      });
      setShowRoute(false);
      setRouteForm({ dst: '0.0.0.0/0', gateway: '', distance: '1', comment: '' });
      load();
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Could not add route');
    }
  };

  const removeRoute = async (id: string) => {
    if (!confirm('Delete this route on MikroTik?')) return;
    try {
      await api.delete('/network/routes', { params: { routerId, id } });
      load();
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Could not delete route');
    }
  };

  const toggleRoute = async (r: any) => {
    try {
      await api.post('/network/routes/toggle', { routerId, id: r.id, enabled: !r.enabled });
      load();
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Could not toggle route');
    }
  };

  const addVlan = async () => {
    try {
      await api.post('/network/vlans', {
        routerId,
        name: vlanForm.name,
        vlanId: Number(vlanForm.vlanId),
        iface: vlanForm.iface,
        comment: vlanForm.comment || undefined,
      });
      setShowVlan(false);
      setVlanForm({ name: '', vlanId: '', iface: '', comment: '' });
      load();
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Could not add VLAN');
    }
  };

  const removeVlan = async (id: string) => {
    if (!confirm('Delete this VLAN interface on MikroTik?')) return;
    try {
      await api.delete('/network/vlans', { params: { routerId, id } });
      load();
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Could not delete VLAN');
    }
  };

  return (
    <div className="space-y-3 max-w-6xl">
      <div className="flex justify-end">
        <button type="button" className="btn-secondary text-sm" onClick={load} disabled={busy}>
          <RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>
      {error && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{error}</div>}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <h3 className="font-semibold text-slate-800">IP Routes</h3>
            <button type="button" className="btn-primary text-sm" disabled={!live} onClick={() => setShowRoute((v) => !v)}>
              <Plus size={14} /> Add Route
            </button>
          </div>
          {showRoute && (
            <Card className="p-4 space-y-2">
              <input className="input" placeholder="Destination (e.g. 0.0.0.0/0)" value={routeForm.dst} onChange={(e) => setRouteForm({ ...routeForm, dst: e.target.value })} />
              <input className="input" placeholder="Gateway" value={routeForm.gateway} onChange={(e) => setRouteForm({ ...routeForm, gateway: e.target.value })} />
              <input className="input" placeholder="Distance" value={routeForm.distance} onChange={(e) => setRouteForm({ ...routeForm, distance: e.target.value })} />
              <input className="input" placeholder="Comment" value={routeForm.comment} onChange={(e) => setRouteForm({ ...routeForm, comment: e.target.value })} />
              <button type="button" className="btn-primary text-sm w-full" onClick={addRoute}>Add on MikroTik</button>
            </Card>
          )}
          <Card noPadding>
            <DataTable
              columns={[
                { key: 'dst', label: 'Destination' },
                { key: 'gateway', label: 'Gateway' },
                { key: 'distance', label: 'Distance' },
                { key: 'status', label: 'Status' },
                { key: 'actions', label: '', align: 'right' },
              ]}
              rows={data.routes.map((r, i) => ({
                key: r.id || i,
                cells: [
                  <span className="font-mono text-slate-700">{r.dst}</span>,
                  <span className="text-sm">{r.gateway}</span>,
                  r.distance,
                  <StatusBadge status={r.active ? 'Active' : r.enabled ? 'offline' : 'disabled'} />,
                  <div className="flex items-center justify-end gap-2">
                    <Toggle on={!!r.enabled} onChange={() => toggleRoute(r)} label={`Toggle route ${i}`} />
                    <button type="button" className="text-rose-500 hover:text-rose-700" onClick={() => removeRoute(r.id)}>
                      <Trash2 size={15} />
                    </button>
                  </div>,
                ],
              }))}
              emptyMessage={live ? 'No routes on this router.' : 'Routes load from the selected MikroTik.'}
            />
          </Card>
        </div>

        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <h3 className="font-semibold text-slate-800">VLAN Interfaces</h3>
            <button type="button" className="btn-primary text-sm" disabled={!live} onClick={() => setShowVlan((v) => !v)}>
              <Plus size={14} /> Add VLAN
            </button>
          </div>
          {showVlan && (
            <Card className="p-4 space-y-2">
              <input className="input" placeholder="Name" value={vlanForm.name} onChange={(e) => setVlanForm({ ...vlanForm, name: e.target.value })} />
              <input className="input" placeholder="VLAN ID" value={vlanForm.vlanId} onChange={(e) => setVlanForm({ ...vlanForm, vlanId: e.target.value })} />
              <select
                className="input"
                value={vlanForm.iface}
                onChange={(e) => setVlanForm({ ...vlanForm, iface: e.target.value })}
              >
                <option value="">Select parent interface…</option>
                {parentIfaces.map((i) => (
                  <option key={i.name} value={i.name}>
                    {i.name}{i.type ? ` (${i.type})` : ''}{i.running ? '' : ' — down'}
                  </option>
                ))}
              </select>
              {parentIfaces.length === 0 && live && (
                <p className="text-xs text-amber-700">No suitable parent interfaces found (PPPoE interfaces are excluded).</p>
              )}
              <input className="input" placeholder="Comment" value={vlanForm.comment} onChange={(e) => setVlanForm({ ...vlanForm, comment: e.target.value })} />
              <button type="button" className="btn-primary text-sm w-full" onClick={addVlan} disabled={!vlanForm.iface}>Add on MikroTik</button>
            </Card>
          )}
          <Card noPadding>
            <DataTable
              columns={[
                { key: 'name', label: 'VLAN Name' },
                { key: 'vlanId', label: 'VLAN ID' },
                { key: 'iface', label: 'Parent Interface' },
                { key: 'actions', label: '', align: 'right' },
              ]}
              rows={data.vlans.map((v, i) => ({
                key: v.id || i,
                cells: [
                  <span className="font-medium text-slate-800">{v.name}</span>,
                  v.vlanId,
                  v.iface,
                  <button type="button" className="text-rose-500 hover:text-rose-700" onClick={() => removeVlan(v.id)}>
                    <Trash2 size={15} />
                  </button>,
                ],
              }))}
              emptyMessage={live ? 'No VLAN interfaces on this router.' : 'VLANs load from the selected MikroTik.'}
            />
          </Card>
        </div>
      </div>
    </div>
  );
}

function MultiWan({ routerId }: { routerId: number }) {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [wanIfaces, setWanIfaces] = useState('ether1, ether2');
  const [lanIface, setLanIface] = useState('');
  const [configType, setConfigType] = useState('pcc');
  const [script, setScript] = useState('');
  const [copied, setCopied] = useState(false);

  const load = () => {
    setBusy(true);
    return api
      .get('/network/multiwan', { params: { routerId } })
      .then((r) => {
        setData(r.data);
        setError(r.data.error || '');
        const ifaces: string[] = (r.data.interfaces || []).map((i: any) => i.name).filter(Boolean);
        const addrs: any[] = r.data.addresses || [];
        if (!lanIface && ifaces.length) {
          const bridge = ifaces.find((n) => /bridge|lan|pppoe/i.test(n)) || ifaces[0];
          setLanIface(bridge);
        }
        const wanNames = (r.data.links || [])
          .map((l: any) => l.interfaceName)
          .filter((n: string) => n && n !== '-');
        if (wanNames.length) setWanIfaces(wanNames.join(', '));
        else if (ifaces.length >= 2) setWanIfaces(ifaces.slice(0, 2).join(', '));
        // Prefer detected LAN address for selected iface
        void addrs;
      })
      .catch((e) => {
        setData({ enabled: false, strategy: '', links: [], interfaces: [], addresses: [], live: false });
        setError(e?.response?.data?.error || 'Could not load multi-WAN from MikroTik');
      })
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routerId]);

  const detectedIp = useMemo(() => {
    const addrs: any[] = data?.addresses || [];
    const hit = addrs.find((a) => a.interface === lanIface);
    return hit?.address || '';
  }, [data, lanIface]);

  const ifaceOptions: string[] = useMemo(
    () => (data?.interfaces || []).map((i: any) => i.name).filter(Boolean),
    [data]
  );

  const generate = () => {
    const wans = wanIfaces.split(',').map((s) => s.trim()).filter(Boolean);
    const lan = lanIface || 'bridge';
    const lines = [
      `# Multi-WAN script — generated for router ${data?.routerName || routerId}`,
      `# Type: ${configType === 'pcc' ? 'PCC load-balance' : configType === 'failover' ? 'Failover (distance)' : 'ECMP'}`,
      `# WAN: ${wans.join(', ') || '(none)'}  LAN: ${lan}${detectedIp ? ` (${detectedIp})` : ''}`,
      '',
    ];
    if (configType === 'failover') {
      wans.forEach((w, i) => {
        lines.push(`/ip route add dst-address=0.0.0.0/0 gateway=${w} check-gateway=ping distance=${i + 1} comment="mtb-wan-${i + 1}"`);
      });
    } else if (configType === 'ecmp') {
      if (wans.length) {
        lines.push(`/ip route add dst-address=0.0.0.0/0 gateway=${wans.join(',')} check-gateway=ping comment="mtb-ecmp"`);
      }
    } else {
      wans.forEach((w, i) => {
        const mark = `WAN${i + 1}`;
        lines.push(`/ip firewall mangle add chain=prerouting in-interface=${lan} per-connection-classifier=both-addresses:${wans.length}/${i} action=mark-connection new-connection-mark=${mark} passthrough=yes comment="mtb-pcc-${mark}"`);
        lines.push(`/ip firewall mangle add chain=prerouting connection-mark=${mark} action=mark-routing new-routing-mark=${mark} passthrough=no`);
        lines.push(`/ip route add dst-address=0.0.0.0/0 gateway=${w} routing-mark=${mark} check-gateway=ping comment="mtb-pcc-${mark}"`);
      });
    }
    lines.push('');
    setScript(lines.join('\n'));
  };

  const copy = async () => {
    if (!script) return;
    const ok = await copyText(script);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  if (!data) return <div className="text-slate-400">Loading…</div>;

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex justify-end">
        <button type="button" className="btn-secondary text-sm" onClick={load} disabled={busy}>
          <RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>
      {error && <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{error}</div>}

      <Card title="AI Multi-WAN Script Assistant" interactive>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div className="space-y-3">
            <label className="block text-sm">
              <span className="text-slate-600 font-medium">WAN Interfaces</span>
              <input className="input mt-1" value={wanIfaces} onChange={(e) => setWanIfaces(e.target.value)} placeholder="ether1, ether2" />
            </label>
            <label className="block text-sm">
              <span className="text-slate-600 font-medium">LAN Interface</span>
              <select className="input mt-1" value={lanIface} onChange={(e) => setLanIface(e.target.value)}>
                <option value="">Select…</option>
                {ifaceOptions.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
              {detectedIp && <div className="text-xs text-emerald-600 mt-1">Detected IP: {detectedIp}</div>}
            </label>
            <label className="block text-sm">
              <span className="text-slate-600 font-medium">Configuration Type</span>
              <select className="input mt-1" value={configType} onChange={(e) => setConfigType(e.target.value)}>
                <option value="pcc">PCC - Load Balance (Merge Speed)</option>
                <option value="failover">Failover (check-gateway distance)</option>
                <option value="ecmp">ECMP (equal cost)</option>
              </select>
            </label>
            <button type="button" className="btn-primary w-full" onClick={generate} disabled={!data.live}>
              Generate Script
            </button>
            {!data.live && (
              <p className="text-xs text-amber-700">Connect a reachable MikroTik with API credentials to load live interfaces.</p>
            )}
          </div>
          <div className="relative">
            <button type="button" className="absolute top-2 right-2 btn-secondary text-xs py-1 px-2" onClick={copy} disabled={!script}>
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
            <pre className="bg-slate-950 text-slate-100 rounded-xl p-4 text-xs min-h-[260px] overflow-auto whitespace-pre-wrap">
              {script || '# Your generated multi-WAN script will appear here.\n# Interfaces above are loaded from the selected MikroTik.'}
            </pre>
          </div>
        </div>
      </Card>

      <Card
        title="Live WAN Links"
        interactive
        right={<StatusBadge status={data.enabled ? 'Active' : 'disabled'} />}
        noPadding
      >
        <div className="px-5 pt-5 pb-4 text-sm text-slate-500 flex items-center gap-2">
          <Bot size={16} className="text-brand-500" /> Strategy:{' '}
          <span className="font-medium text-slate-700">{data.strategy || '—'}</span>
        </div>
        <DataTable
          columns={[
            { key: 'name', label: 'Link' },
            { key: 'gateway', label: 'Gateway' },
            { key: 'role', label: 'Role' },
            { key: 'weight', label: 'Weight', align: 'right' },
            { key: 'distance', label: 'Distance', align: 'right' },
            { key: 'check', label: 'Check' },
            { key: 'status', label: 'Status' },
          ]}
          rows={(data.links || []).map((l: any, i: number) => ({
            key: i,
            cells: [
              <span className="font-medium text-slate-800">{l.name}</span>,
              <span className="font-mono text-xs text-slate-500">{l.gateway}</span>,
              <span className="capitalize">{l.role}</span>,
              `${l.weight}%`,
              l.distance,
              l.checkMethod || '—',
              <StatusBadge status={l.status === 'up' ? 'online' : l.status === 'standby' ? 'offline' : 'disabled'} />,
            ],
          }))}
          emptyMessage="No WAN / check-gateway routes on this router."
        />
      </Card>
    </div>
  );
}
