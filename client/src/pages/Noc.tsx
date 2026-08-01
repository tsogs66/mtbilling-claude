import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, Plus, Pencil, Trash2, RefreshCw, Radio, Router, Wifi, Server, Cable,
  TerminalSquare, Plug, PlugZap, X, Info, ScanSearch,
} from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
  Bar, BarChart, Cell,
} from 'recharts';
import Layout from '../components/Layout';
import {
  Card, StatusBadge, EmptyState, Modal, ModalFooter, FormField, PageHeader, StatTile, LoadingPage,
} from '../components/ui';
import { api } from '../api';
import { getWsUrl } from '../config';

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

function deviceKey(d: { source?: string; id: number }) {
  const src = d.source || 'custom';
  return `${src}:${d.id}`;
}

function shortLabel(key: string, nameMap: Record<string, string>) {
  return nameMap[key] || key;
}

/** NOC suite — uptime health (5‑min probes), device info, SSH tunnel console. */
export default function Noc() {
  const [data, setData] = useState<any>(null);
  const [health, setHealth] = useState<any>(null);
  const [edit, setEdit] = useState<any>(null);
  const [selected, setSelected] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<'all' | 'online' | 'offline' | 'custom'>('all');
  const [sshOpen, setSshOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<any>(null);
  const [scanPick, setScanPick] = useState<Set<string>>(new Set());

  const load = (live = false) => {
    setBusy(true);
    return Promise.all([
      api.get('/noc', { params: live ? { live: 1 } : {} }),
      api.get('/noc/health', { params: { hours: 24 } }),
    ])
      .then(([nocRes, healthRes]) => {
        setData(nocRes.data);
        setHealth(healthRes.data);
      })
      .catch(() => {
        setData({ devices: [], counts: { total: 0, online: 0, offline: 0, unknown: 0 } });
        setHealth({ devices: [] });
      })
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    load(false);
    // Refresh list + health on the same cadence as the server probe (5 min)
    const t = setInterval(() => load(false), 5 * 60 * 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectDevice = async (d: any) => {
    setSelected(d);
    setDetail(null);
    setHistory([]);
    setSshOpen(false);
    try {
      const src = d.source || 'custom';
      if (src === 'custom') {
        const [infoRes, histRes] = await Promise.all([
          api.get(`/noc/devices/${d.id}/info`),
          api.get(`/noc/devices/${d.id}/history`, { params: { source: 'custom' } }),
        ]);
        setDetail(infoRes.data);
        setHistory(histRes.data.history || []);
        // Merge fresh probe into selected card
        if (infoRes.data?.device) {
          setSelected({ ...d, ...infoRes.data.device, online: infoRes.data.probe?.online, status: infoRes.data.device.status });
        }
      } else {
        const histRes = await api.get(`/noc/devices/${d.id}/history`, { params: { source: src } });
        setHistory(histRes.data.history || []);
        setDetail({
          device: d,
          probe: { online: d.online, latencyMs: d.latencyMs ?? d.last_latency_ms, error: d.error || d.probe_error },
          sshCapable: src === 'router' || !!(d.ssh_user || d.sshCapable),
        });
      }
    } catch {
      setDetail({ device: d, probe: null, sshCapable: d.source === 'router' });
    }
  };

  const del = async (id: number) => {
    if (!confirm('Remove this NOC device?')) return;
    try {
      await api.delete(`/noc/devices/${id}`);
      if (selected?.id === id && selected?.source === 'custom') setSelected(null);
      load(false);
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Delete failed');
    }
  };

  const nameMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const d of data?.devices || []) {
      m[deviceKey(d)] = d.name;
    }
    return m;
  }, [data]);

  const uptimeBars = useMemo(() => {
    const list = (health?.devices || []) as { key: string; uptimePct: number | null; samples: number }[];
    return list
      .filter((x) => x.samples > 0)
      .map((x) => ({
        name: shortLabel(x.key, nameMap).slice(0, 18),
        key: x.key,
        uptime: x.uptimePct ?? 0,
        samples: x.samples,
      }))
      .sort((a, b) => a.uptime - b.uptime)
      .slice(0, 12);
  }, [health, nameMap]);

  const fleetSeries = useMemo(() => {
    // Aggregate online count over time across all devices (uptime-monitor style)
    const buckets = new Map<string, { t: string; up: number; total: number }>();
    for (const d of health?.devices || []) {
      for (const s of d.series || []) {
        const minute = String(s.t).slice(0, 16); // YYYY-MM-DD HH:MM
        const cur = buckets.get(minute) || { t: minute, up: 0, total: 0 };
        cur.total += 1;
        if (s.online) cur.up += 1;
        buckets.set(minute, cur);
      }
    }
    return [...buckets.values()]
      .sort((a, b) => a.t.localeCompare(b.t))
      .map((b) => ({
        t: b.t.slice(11),
        pct: b.total ? Math.round((b.up / b.total) * 1000) / 10 : 0,
        up: b.up,
        total: b.total,
      }));
  }, [health]);

  const selectedSeries = useMemo(() => {
    if (!selected) return [];
    const key = deviceKey(selected);
    const fromHealth = (health?.devices || []).find((x: any) => x.key === key)?.series;
    if (fromHealth?.length) {
      return fromHealth.map((s: any) => ({
        t: String(s.t).slice(11, 16),
        online: s.online,
        latency: s.latency,
      }));
    }
    return (history || []).map((h: any) => ({
      t: String(h.probedAt || '').slice(11, 16),
      online: h.online ? 1 : 0,
      latency: h.latencyMs,
    }));
  }, [selected, health, history]);

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

  const canSsh =
    selected &&
    (selected.source === 'router' ||
      detail?.sshCapable ||
      (selected.source === 'custom' && (selected.ssh_user || detail?.device?.ssh_user)));

  return (
    <Layout title="NOC">
      <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
        <PageHeader
          title="NOC Suite"
          description="5‑minute uptime health, device inventory, and SSH command tunnel for the selected network device."
          icon={Activity}
        />
        <div className="flex gap-2 flex-wrap">
          <button type="button" className="btn-secondary text-sm" onClick={() => load(true)} disabled={busy}>
            <RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> Live probe
          </button>
          <button
            type="button"
            className="btn-secondary text-sm"
            disabled={scanning}
            onClick={async () => {
              setScanning(true);
              setScanResult(null);
              setScanPick(new Set());
              try {
                const r = await api.post('/noc/scan', { hops: 2 }, { timeout: 120000 });
                setScanResult(r.data);
                setScanPick(
                  new Set(
                    (r.data.devices || [])
                      .filter((d: any) => !d.alreadyMonitored)
                      .map((d: any) => d.host)
                  )
                );
              } catch (e: any) {
                alert(e?.response?.data?.error || 'Network scan failed');
              } finally {
                setScanning(false);
              }
            }}
          >
            <ScanSearch size={14} className={scanning ? 'animate-pulse' : ''} />
            {scanning ? 'Scanning…' : 'Scan network (2 hops)'}
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
                sshPort: 22,
                sshUser: '',
                sshPass: '',
                notes: '',
              })
            }
          >
            <Plus size={16} /> Add device
          </button>
        </div>
      </div>

      {scanResult && (
        <Card
          className="mb-5"
          title={`Discovered devices · ${scanResult.devices?.length || 0}`}
          right={
            <div className="flex gap-2">
              <button type="button" className="btn-secondary text-sm" onClick={() => setScanResult(null)}>
                Close
              </button>
              <button
                type="button"
                className="btn-primary text-sm"
                disabled={!scanPick.size}
                onClick={async () => {
                  const devices = (scanResult.devices || []).filter((d: any) => scanPick.has(d.host));
                  try {
                    const r = await api.post('/noc/scan/import', { devices });
                    alert(`Added ${r.data.added} device(s) to NOC monitor.`);
                    setScanResult(null);
                    load(false);
                  } catch (e: any) {
                    alert(e?.response?.data?.error || 'Import failed');
                  }
                }}
              >
                Monitor selected ({scanPick.size})
              </button>
            </div>
          }
        >
          <p className="text-xs text-slate-500 mb-3">
            Scanned {scanResult.scanned} addresses on {((scanResult.localCidrs || []) as string[]).join(', ') || 'LAN'}
            {scanResult.gateways?.length ? ` · gateway ${scanResult.gateways.join(', ')}` : ''}. Select devices to add to monitoring.
          </p>
          <div className="max-h-64 overflow-auto divide-y divide-slate-100 border border-slate-200 rounded-xl">
            {(scanResult.devices || []).length === 0 ? (
              <div className="text-sm text-slate-400 p-4 text-center">No hosts responded on common ports.</div>
            ) : (
              (scanResult.devices || []).map((d: any) => (
                <label key={d.host} className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-slate-50 cursor-pointer">
                  <input
                    type="checkbox"
                    className="rounded border-slate-300"
                    disabled={d.alreadyMonitored}
                    checked={scanPick.has(d.host)}
                    onChange={() => {
                      setScanPick((prev) => {
                        const next = new Set(prev);
                        if (next.has(d.host)) next.delete(d.host);
                        else next.add(d.host);
                        return next;
                      });
                    }}
                  />
                  <span className="font-mono font-medium text-slate-800">{d.host}</span>
                  <span className="text-xs text-slate-400">hop {d.hop}</span>
                  <span className="text-xs text-slate-500">{d.kind}</span>
                  <span className="text-xs text-slate-400 truncate">ports {d.openPorts?.join(',')}</span>
                  {d.isGateway && <span className="text-[10px] uppercase text-sky-600 font-semibold">gateway</span>}
                  {d.sshCapable && <span className="text-[10px] uppercase text-emerald-600 font-semibold">ssh</span>}
                  {d.alreadyMonitored && <span className="text-[10px] text-slate-400">already monitored</span>}
                </label>
              ))
            )}
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <StatTile label="Total" value={String(data.counts?.total ?? 0)} icon={Server} tone="text-slate-700" accent="from-slate-500/15 to-transparent" delay={0} />
        <StatTile label="Online" value={String(data.counts?.online ?? 0)} icon={Activity} tone="text-emerald-600" accent="from-emerald-500/15 to-transparent" delay={50} />
        <StatTile label="Offline" value={String(data.counts?.offline ?? 0)} icon={Radio} tone="text-rose-600" accent="from-rose-500/15 to-transparent" delay={100} />
        <StatTile
          label="Fleet uptime 24h"
          value={
            uptimeBars.length
              ? `${Math.round(uptimeBars.reduce((s, x) => s + x.uptime, 0) / uptimeBars.length)}%`
              : '—'
          }
          icon={Activity}
          tone="text-sky-600"
          accent="from-sky-500/15 to-transparent"
          delay={150}
        />
      </div>

      {/* Fleet health — uptime monitor style */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 mb-6">
        <Card title="Fleet availability (24h)" className="xl:col-span-2">
          <div className="h-48 mt-2">
            {fleetSeries.length === 0 ? (
              <p className="text-sm text-slate-400 py-8 text-center">
                Health samples appear after the first 5‑minute probe cycle.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={fleetSeries} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="nocUp" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#10b981" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="t" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} unit="%" width={36} />
                  <Tooltip
                    formatter={(v: number, _n, p: any) => [`${v}% (${p.payload.up}/${p.payload.total})`, 'Online']}
                    labelFormatter={(l) => `Probe ${l}`}
                  />
                  <Area type="monotone" dataKey="pct" stroke="#059669" fill="url(#nocUp)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
          <p className="text-[11px] text-slate-400 mt-1">Probed every 5 minutes · last 24 hours</p>
        </Card>
        <Card title="Per-device uptime">
          <div className="h-48 mt-2">
            {uptimeBars.length === 0 ? (
              <p className="text-sm text-slate-400 py-8 text-center">No history yet</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={uptimeBars} layout="vertical" margin={{ left: 4, right: 12, top: 4, bottom: 4 }}>
                  <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10 }} unit="%" />
                  <YAxis type="category" dataKey="name" width={88} tick={{ fontSize: 10 }} />
                  <Tooltip formatter={(v: number) => [`${v}%`, 'Uptime']} />
                  <Bar dataKey="uptime" radius={[0, 4, 4, 0]}>
                    {uptimeBars.map((e) => (
                      <Cell key={e.key} fill={e.uptime >= 99 ? '#10b981' : e.uptime >= 90 ? '#f59e0b' : '#f43f5e'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>
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

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-5">
        <div className="xl:col-span-2 space-y-3">
          {devices.length === 0 ? (
            <EmptyState message="No devices to show. Add a custom device, or configure Routers / OLTs under Network." icon={Activity} />
          ) : (
            devices.map((d: any) => {
              const Icon = kindIcon(d.kind);
              const key = `${d.source}-${d.id}`;
              const active = selected && deviceKey(selected) === deviceKey(d);
              const spark = ((health?.devices || []).find((x: any) => x.key === deviceKey(d))?.series || []).slice(-24);
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => selectDevice(d)}
                  className={`w-full text-left rounded-2xl border px-4 py-3 transition ${
                    active ? 'border-sky-400 bg-sky-50/80 shadow-sm' : 'border-slate-200 bg-white hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Icon size={16} className="text-slate-500 shrink-0" />
                      <div className="min-w-0">
                        <div className="font-medium text-slate-800 truncate">{d.name}</div>
                        <div className="text-[11px] text-slate-400 truncate">
                          {d.kind?.toUpperCase()}
                          {d.source && d.source !== 'custom' ? ` · ${d.source}` : ''}
                          {d.host ? ` · ${d.host}` : ''}
                        </div>
                      </div>
                    </div>
                    <StatusBadge status={d.online || d.status === 'online' ? 'online' : d.status === 'offline' ? 'offline' : 'inactive'} />
                  </div>
                  {spark.length > 0 && (
                    <div className="mt-2 flex items-end gap-px h-6">
                      {spark.map((s: any, i: number) => (
                        <div
                          key={i}
                          title={`${s.t} · ${s.online ? 'up' : 'down'}`}
                          className={`flex-1 rounded-sm ${s.online ? 'bg-emerald-400' : 'bg-rose-300'}`}
                          style={{ height: s.online ? '100%' : '35%' }}
                        />
                      ))}
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>

        <div className="xl:col-span-3 space-y-4">
          {!selected ? (
            <Card>
              <div className="py-12 text-center text-slate-400 text-sm">
                <Info size={28} className="mx-auto mb-2 opacity-50" />
                Select a device to view details, health history, and open an SSH tunnel.
              </div>
            </Card>
          ) : (
            <>
              <Card
                title={selected.name}
                icon={kindIcon(selected.kind)}
                right={<StatusBadge status={selected.online || selected.status === 'online' ? 'online' : selected.status === 'offline' ? 'offline' : 'inactive'} />}
              >
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm mt-2">
                  <div>
                    <dt className="text-slate-400 text-xs">Host</dt>
                    <dd className="font-mono text-slate-800">{selected.host || '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-400 text-xs">Type</dt>
                    <dd className="text-slate-800">{selected.kind}{selected.source !== 'custom' ? ` (${selected.source})` : ''}</dd>
                  </div>
                  <div>
                    <dt className="text-slate-400 text-xs">Vendor / model</dt>
                    <dd className="text-slate-800">
                      {[selected.vendor, selected.model || selected.board || selected.sys_name || detail?.device?.sys_name]
                        .filter(Boolean)
                        .join(' · ') || '—'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-400 text-xs">Latency</dt>
                    <dd className="text-slate-800">
                      {detail?.probe?.latencyMs ?? selected.last_latency_ms ?? selected.latencyMs ?? '—'}
                      {(detail?.probe?.latencyMs ?? selected.last_latency_ms ?? selected.latencyMs) != null ? ' ms' : ''}
                    </dd>
                  </div>
                  {(detail?.probe?.error || selected.probe_error || selected.error) && (
                    <div className="col-span-2 text-xs text-rose-600">
                      {detail?.probe?.error || selected.probe_error || selected.error}
                    </div>
                  )}
                </dl>
                <div className="flex flex-wrap gap-2 mt-4">
                  {selected.source === 'custom' && (
                    <>
                      <button type="button" className="btn-secondary text-sm" onClick={() => setEdit(selected)}>
                        <Pencil size={14} /> Edit
                      </button>
                      <button type="button" className="btn-secondary text-sm text-rose-600" onClick={() => del(selected.id)}>
                        <Trash2 size={14} /> Delete
                      </button>
                    </>
                  )}
                  {selected.source === 'router' && (
                    <Link to="/terminal" className="btn-secondary text-sm inline-flex items-center gap-1">
                      <TerminalSquare size={14} /> Full terminal
                    </Link>
                  )}
                  {canSsh && (
                    <button
                      type="button"
                      className="btn-primary text-sm"
                      onClick={() => setSshOpen(true)}
                    >
                      <TerminalSquare size={14} /> SSH tunnel
                    </button>
                  )}
                  {selected.source === 'custom' && !canSsh && (
                    <button type="button" className="btn-secondary text-sm" onClick={() => setEdit(selected)}>
                      Set SSH credentials
                    </button>
                  )}
                </div>
              </Card>

              <Card title="Health timeline (5‑min probes)">
                <div className="h-40 mt-2">
                  {selectedSeries.length === 0 ? (
                    <p className="text-sm text-slate-400 py-8 text-center">No samples yet for this device.</p>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={selectedSeries} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                        <XAxis dataKey="t" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                        <YAxis domain={[0, 1]} ticks={[0, 1]} tickFormatter={(v) => (v ? 'Up' : 'Down')} width={40} tick={{ fontSize: 10 }} />
                        <Tooltip
                          formatter={(v: number, name: string) =>
                            name === 'online' ? [v ? 'Online' : 'Offline', 'Status'] : [`${v} ms`, 'Latency']
                          }
                        />
                        <Area type="stepAfter" dataKey="online" stroke="#059669" fill="#10b98133" strokeWidth={2} />
                      </AreaChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </Card>

              {sshOpen && (
                <NocSshPanel
                  device={selected}
                  detail={detail}
                  onClose={() => setSshOpen(false)}
                />
              )}
            </>
          )}
        </div>
      </div>

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

function NocSshPanel({ device, detail, onClose }: { device: any; detail: any; onClose: () => void }) {
  const [mode, setMode] = useState<'disconnected' | 'connecting' | 'ssh' | 'error'>('disconnected');
  const [message, setMessage] = useState('');
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const writeTerm = useCallback((text: string) => {
    xtermRef.current?.write(text);
  }, []);

  const disconnect = useCallback(() => {
    try {
      wsRef.current?.send(JSON.stringify({ type: 'disconnect' }));
    } catch {
      /* ignore */
    }
    wsRef.current?.close();
    wsRef.current = null;
    setMode('disconnected');
  }, []);

  useEffect(() => {
    if (!termRef.current || xtermRef.current) return;
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      theme: { background: '#0f172a', foreground: '#e2e8f0', cursor: '#38bdf8' },
      rows: 20,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termRef.current);
    fit.fit();
    xtermRef.current = term;
    fitRef.current = fit;
    const onResize = () => fit.fit();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      disconnect();
      term.dispose();
      xtermRef.current = null;
    };
  }, [disconnect]);

  const connect = useCallback(() => {
    const token = localStorage.getItem('mt_token');
    if (!token) return;
    disconnect();
    xtermRef.current?.clear();
    const host = device.host;
    const port = device.ssh_port || detail?.device?.ssh_port || 22;
    writeTerm(`\r\n\x1b[1;36mSSH tunnel → ${device.name} (${host}:${port})…\x1b[0m\r\n`);

    const ws = new WebSocket(getWsUrl(`/api/terminal/ws?token=${encodeURIComponent(token)}`));
    wsRef.current = ws;
    setMode('connecting');

    ws.onopen = () => {
      if (device.source === 'router') {
        ws.send(JSON.stringify({ type: 'connect', routerId: device.routerId || device.id }));
      } else {
        ws.send(JSON.stringify({ type: 'connect', nocDeviceId: device.id }));
      }
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'data') writeTerm(msg.data);
        if (msg.type === 'status') {
          if (msg.mode === 'ssh') {
            setMode('ssh');
            writeTerm(`\x1b[32m✓ SSH session ${msg.host}:${msg.port ?? port}\x1b[0m\r\n`);
          } else if (msg.mode === 'error') {
            setMode('error');
            setMessage(msg.message || 'Error');
            writeTerm(`\x1b[31m${msg.message}\x1b[0m\r\n`);
          } else if (msg.mode === 'connecting') {
            setMode('connecting');
          } else if (msg.mode === 'disconnected') {
            setMode('disconnected');
          } else if (msg.message) {
            setMessage(msg.message);
            writeTerm(`\x1b[33m${msg.message}\x1b[0m\r\n`);
          }
        }
      } catch {
        writeTerm(ev.data);
      }
    };

    ws.onclose = () => {
      setMode('disconnected');
      writeTerm('\r\n\x1b[90m[disconnected]\x1b[0m\r\n');
    };
    ws.onerror = () => {
      setMode('error');
      writeTerm('\r\n\x1b[31mWebSocket error\x1b[0m\r\n');
    };

    const disposable = xtermRef.current?.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });
    return () => disposable?.dispose();
  }, [device, detail, disconnect, writeTerm]);

  useEffect(() => {
    connect();
    return () => disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card
      title="SSH command tunnel"
      icon={TerminalSquare}
      right={
        <button type="button" className="text-slate-400 hover:text-slate-700" onClick={onClose} aria-label="Close SSH">
          <X size={16} />
        </button>
      }
    >
      <div className="flex items-center gap-2 mb-2 flex-wrap text-xs">
        <StatusBadge
          status={mode === 'ssh' ? 'online' : mode === 'connecting' ? 'pending' : mode === 'error' ? 'offline' : 'inactive'}
        />
        <span className="text-slate-500">
          {mode === 'ssh' ? 'Interactive shell' : mode === 'connecting' ? 'Connecting…' : message || mode}
        </span>
        <div className="ml-auto flex gap-2">
          {mode === 'ssh' || mode === 'connecting' ? (
            <button type="button" className="btn-secondary text-xs" onClick={disconnect}>
              <PlugZap size={12} /> Disconnect
            </button>
          ) : (
            <button type="button" className="btn-primary text-xs" onClick={connect}>
              <Plug size={12} /> Reconnect
            </button>
          )}
        </div>
      </div>
      <div ref={termRef} className="rounded-xl overflow-hidden border border-slate-800 bg-slate-900 min-h-[280px]" />
      <p className="text-[11px] text-slate-400 mt-2">
        Commands run on the selected device over SSH from this panel host. Viewer accounts cannot open tunnels.
      </p>
    </Card>
  );
}

function DeviceModal({ device, onClose, onSaved }: any) {
  const [form, setForm] = useState({
    ...device,
    sshPort: device.sshPort ?? device.ssh_port ?? 22,
    sshUser: device.sshUser ?? device.ssh_user ?? '',
    sshPass: '',
  });
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
      const payload = {
        ...form,
        sshPort: form.sshPort,
        sshUser: form.sshUser,
        ...(form.sshPass ? { sshPass: form.sshPass } : {}),
      };
      if (isEdit) await api.put(`/noc/devices/${device.id}`, payload);
      else await api.post('/noc/devices', payload);
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
        <div className="border-t border-slate-100 pt-3">
          <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">SSH tunnel</div>
          <div className="grid grid-cols-3 gap-3">
            <FormField label="SSH port">
              <input className="input" type="number" value={form.sshPort ?? 22} onChange={(e) => set({ sshPort: Number(e.target.value) })} />
            </FormField>
            <FormField label="SSH user">
              <input className="input font-mono" value={form.sshUser || ''} onChange={(e) => set({ sshUser: e.target.value })} placeholder="admin" />
            </FormField>
            <FormField label="SSH password" hint={isEdit ? 'Leave blank to keep' : undefined}>
              <input
                className="input font-mono"
                type="password"
                value={form.sshPass || ''}
                onChange={(e) => set({ sshPass: e.target.value })}
                placeholder={isEdit ? '••••••••' : ''}
                autoComplete="new-password"
              />
            </FormField>
          </div>
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
