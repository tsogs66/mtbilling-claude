import { useEffect, useState } from 'react';
import {
  Activity, Plus, Pencil, Trash2, RefreshCw, Radio, Router, Wifi, Server, Cable,
} from 'lucide-react';
import Layout from '../components/Layout';
import {
  Card, StatusBadge, EmptyState, Modal, ModalFooter, FormField, PageHeader, StatTile, LoadingPage,
} from '../components/ui';
import { api } from '../api';

const KINDS = [
  { value: 'olt', label: 'OLT' },
  { value: 'router', label: 'Router' },
  { value: 'switch', label: 'Switch' },
  { value: 'ap', label: 'Access Point' },
  { value: 'radio', label: 'Radio / PtP' },
  { value: 'other', label: 'Other' },
];

function kindIcon(kind: string) {
  switch (kind) {
    case 'olt':
      return Radio;
    case 'router':
      return Router;
    case 'ap':
    case 'radio':
      return Wifi;
    case 'switch':
      return Cable;
    default:
      return Server;
  }
}

/** NOC suite — live up/down for custom devices + linked routers/OLTs. */
export default function Noc() {
  const [data, setData] = useState<any>(null);
  const [edit, setEdit] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<'all' | 'online' | 'offline' | 'custom'>('all');

  const load = (live = false) => {
    setBusy(true);
    return api
      .get('/noc', { params: live ? { live: 1 } : {} })
      .then((r) => setData(r.data))
      .catch(() => setData({ devices: [], counts: { total: 0, online: 0, offline: 0, unknown: 0 } }))
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    load(false);
    const t = setInterval(() => load(false), 30000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const del = async (id: number) => {
    if (!confirm('Remove this NOC device?')) return;
    try {
      await api.delete(`/noc/devices/${id}`);
      load(false);
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Delete failed');
    }
  };

  if (!data) {
    return (
      <Layout title="NOC">
        <LoadingPage />
      </Layout>
    );
  }

  const devices = (data.devices || []).filter((d: any) => {
    if (filter === 'online') return d.online || d.status === 'online';
    if (filter === 'offline') return d.status === 'offline';
    if (filter === 'custom') return d.source === 'custom';
    return true;
  });

  return (
    <Layout title="NOC">
      <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
        <PageHeader
          title="NOC Suite"
          description="Monitor whether network devices (OLT, router, switch, radio) are up or down."
          icon={Activity}
        />
        <div className="flex gap-2 flex-wrap">
          <button type="button" className="btn-secondary text-sm" onClick={() => load(true)} disabled={busy}>
            <RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> Live probe
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() =>
              setEdit({
                name: '',
                kind: 'switch',
                host: '',
                ports: '22,80,443',
                snmpPort: 161,
                snmpCommunity: 'public',
                notes: '',
              })
            }
          >
            <Plus size={16} /> Add device
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatTile label="Total" value={String(data.counts?.total ?? 0)} icon={Server} tone="text-slate-700" accent="from-slate-500/15 to-transparent" delay={0} />
        <StatTile label="Online" value={String(data.counts?.online ?? 0)} icon={Activity} tone="text-emerald-600" accent="from-emerald-500/15 to-transparent" delay={50} />
        <StatTile label="Offline" value={String(data.counts?.offline ?? 0)} icon={Radio} tone="text-rose-600" accent="from-rose-500/15 to-transparent" delay={100} />
        <StatTile label="Custom" value={String(data.counts?.custom ?? 0)} icon={Cable} tone="text-brand-600" accent="from-brand-500/15 to-transparent" delay={150} />
      </div>

      <div className="flex gap-2 mb-4 flex-wrap">
        {([
          ['all', 'All'],
          ['online', 'Online'],
          ['offline', 'Offline'],
          ['custom', 'Custom only'],
        ] as const).map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={filter === k ? 'btn-primary text-sm' : 'btn-secondary text-sm'}
            onClick={() => setFilter(k)}
          >
            {label}
          </button>
        ))}
      </div>

      {devices.length === 0 ? (
        <EmptyState message="No devices to show. Add a custom device, or configure Routers / OLTs under Network." icon={Activity} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {devices.map((d: any) => {
            const Icon = kindIcon(d.kind);
            const key = `${d.source}-${d.id}`;
            return (
              <Card
                key={key}
                interactive
                title={d.name}
                icon={Icon}
                right={<StatusBadge status={d.online || d.status === 'online' ? 'online' : d.status === 'offline' ? 'offline' : 'inactive'} />}
              >
                <div className="text-xs text-slate-400 truncate">
                  {d.kind?.toUpperCase()}
                  {d.source && d.source !== 'custom' ? ` · linked ${d.source}` : ''}
                  {[d.vendor, d.model || d.board || d.sys_name].filter(Boolean).length
                    ? ` · ${[d.vendor, d.model || d.board || d.sys_name].filter(Boolean).join(' · ')}`
                    : ''}
                </div>
                <dl className="mt-3 text-sm space-y-1">
                  <div className="flex justify-between gap-2">
                    <dt className="text-slate-500">Host</dt>
                    <dd className="text-slate-700 font-mono text-xs">{d.host || '—'}</dd>
                  </div>
                  {d.last_latency_ms != null && (
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-500">Latency</dt>
                      <dd className="text-slate-700">{d.last_latency_ms} ms</dd>
                    </div>
                  )}
                  {d.latencyMs != null && d.last_latency_ms == null && (
                    <div className="flex justify-between gap-2">
                      <dt className="text-slate-500">Latency</dt>
                      <dd className="text-slate-700">{d.latencyMs} ms</dd>
                    </div>
                  )}
                  {(d.probe_error || d.error) && d.status !== 'online' && (
                    <div className="text-[11px] text-rose-600 mt-1">{d.probe_error || d.error}</div>
                  )}
                  {(d.last_probe_at || d.lastProbeAt) && (
                    <div className="text-[11px] text-slate-400 mt-1">
                      Probed {new Date(d.last_probe_at || d.lastProbeAt).toLocaleString()}
                    </div>
                  )}
                </dl>
                {d.source === 'custom' && (
                  <div className="flex items-center gap-3 mt-3 text-slate-400">
                    <button type="button" className="inline-flex items-center gap-1 text-sm hover:text-sky-600" onClick={() => setEdit(d)}>
                      <Pencil size={14} /> Edit
                    </button>
                    <button type="button" className="inline-flex items-center gap-1 text-sm hover:text-rose-600" onClick={() => del(d.id)}>
                      <Trash2 size={14} /> Delete
                    </button>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {edit && (
        <DeviceModal
          device={edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            load(false);
          }}
        />
      )}
    </Layout>
  );
}

function DeviceModal({ device, onClose, onSaved }: any) {
  const [form, setForm] = useState({ ...device });
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const isEdit = !!device.id && device.source !== 'router' && device.source !== 'olt';
  const set = (patch: any) => setForm((f: any) => ({ ...f, ...patch }));

  const test = async () => {
    if (!form.host?.trim()) {
      setTestResult({ online: false, error: 'Enter a host / IP first' });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.post('/noc/test', form);
      setTestResult(r.data);
      if (r.data.sysName && !form.name) set({ name: r.data.sysName });
      if (r.data.vendor) set({ vendor: r.data.vendor });
      if (r.data.model) set({ model: r.data.model });
    } catch (e: any) {
      setTestResult({ online: false, error: e?.response?.data?.error || 'Test failed' });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!form.name?.trim() || !form.host?.trim()) return;
    setBusy(true);
    try {
      if (isEdit) await api.put(`/noc/devices/${device.id}`, form);
      else await api.post('/noc/devices', form);
      onSaved();
    } catch (e: any) {
      setTestResult({ online: false, error: e?.response?.data?.error || 'Save failed' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isEdit ? 'Edit NOC device' : 'Add NOC device'}
      onClose={onClose}
      footer={<ModalFooter onCancel={onClose} onConfirm={save} confirmLabel="Save" busy={busy} />}
    >
      <div className="space-y-4">
        <FormField label="Name" required>
          <input className="input" value={form.name || ''} onChange={(e) => set({ name: e.target.value })} placeholder="Core switch / OLT-B" />
        </FormField>
        <FormField label="Type">
          <select className="input" value={form.kind || 'other'} onChange={(e) => set({ kind: e.target.value })}>
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="IP / Host" required hint="Reachable from this panel (use Twingate if on another subnet).">
          <input className="input font-mono" value={form.host || ''} onChange={(e) => set({ host: e.target.value })} placeholder="10.20.30.1" />
        </FormField>
        <FormField label="TCP ports to try" hint="Comma-separated. Empty = 161,23,22,80,443,8080.">
          <input className="input font-mono" value={form.ports || ''} onChange={(e) => set({ ports: e.target.value })} placeholder="22,80,443" />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="SNMP Port">
            <input className="input" type="number" value={form.snmpPort ?? form.snmp_port ?? 161} onChange={(e) => set({ snmpPort: Number(e.target.value) })} />
          </FormField>
          <FormField label="SNMP Community">
            <input
              className="input font-mono"
              value={form.snmpCommunity ?? form.snmp_community ?? 'public'}
              onChange={(e) => set({ snmpCommunity: e.target.value })}
            />
          </FormField>
        </div>
        <FormField label="Notes">
          <input className="input" value={form.notes || ''} onChange={(e) => set({ notes: e.target.value })} />
        </FormField>
        <button type="button" className="btn-secondary text-sm inline-flex items-center gap-1.5" onClick={test} disabled={testing}>
          <Activity size={14} /> {testing ? 'Probing…' : 'Test connection'}
        </button>
        {testResult && (
          <div
            className={`text-sm rounded-xl border px-3 py-2 ${
              testResult.online ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'
            }`}
          >
            {testResult.online ? (
              <>
                <b>Online</b>
                {testResult.sysName ? ` · ${testResult.sysName}` : ''}
                {testResult.latencyMs != null ? ` · ${testResult.latencyMs} ms` : ''}
              </>
            ) : (
              <>{testResult.error || 'Offline / unreachable'}</>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
