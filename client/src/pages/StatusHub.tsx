import { useEffect, useMemo, useState } from 'react';
import {
  Plus, RefreshCw, Radio, Satellite, Trash2, Wifi, 
  CheckCircle2, AlertTriangle, XCircle, Clock, Network, Gamepad2,
  Globe2, Server,
} from 'lucide-react';
import Layout from '../components/Layout';
import { Modal, ModalFooter, FormField } from '../components/ui';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { useRouterDevice } from '../context/RouterContext';

type Tab = 'services' | 'uplink' | 'manage';
type Status = 'up' | 'down' | 'degraded' | 'pending';

interface Monitor {
  id: number;
  name: string;
  url: string;
  type: string;
  groupId: number;
  groupSlug: string;
  groupName: string;
  enabled: boolean;
  builtin: boolean;
  status: Status;
  latencyMs: number | null;
  uptimePct: number;
  lastChecked: number | null;
  lastError?: string | null;
  source?: string;
  history: { t: number; up: boolean; ms: number | null; status: string }[];
}

interface Group {
  id: number;
  slug: string;
  name: string;
  sortOrder: number;
  icon: string;
}

interface UplinkTarget {
  id: number;
  slug: string;
  name: string;
  region: string;
  url: string;
  status: Status;
  latencyMs: number | null;
  bodySnip?: string | null;
  lastChecked: number | null;
  lastError?: string | null;
  history: { t: number; up: boolean; ms: number | null }[];
}

interface UplinkHost {
  id: number;
  label: string;
  host: string;
  port: number;
  status: Status;
  latencyMs: number | null;
  lastError?: string | null;
  lastChecked: number | null;
}

const STATUS_META: Record<Status, { label: string; color: string; glow: string }> = {
  up: { label: 'Online', color: '#34d399', glow: 'rgba(52,211,153,0.45)' },
  degraded: { label: 'Slow', color: '#fbbf24', glow: 'rgba(251,191,36,0.4)' },
  down: { label: 'Offline', color: '#fb7185', glow: 'rgba(251,113,133,0.45)' },
  pending: { label: 'Pending', color: '#64748b', glow: 'rgba(100,116,139,0.35)' },
};

function ago(ts: number | null) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function Spark({ history }: { history: { up: boolean; ms: number | null; status?: string }[] }) {
  // Skip "pending/scanning" filler samples so charts show real up/down history.
  const pts = history.filter((p) => p.status !== 'pending').slice(-28);
  if (pts.length < 2) {
    return <div className="h-7 text-[10px] text-cyan-500/40 font-mono tracking-wider">SYNC…</div>;
  }
  const w = 112;
  const h = 28;
  const gap = 1.5;
  const barW = Math.max(2, (w - gap * (pts.length - 1)) / pts.length);

  // Latency line only when we have real RTT samples (router probes).
  const latencyPts = pts
    .map((p, i) => ({ i, ms: p.ms }))
    .filter((p): p is { i: number; ms: number } => p.ms != null && p.ms > 0 && pts[p.i].up);
  const latMin = latencyPts.length ? Math.min(...latencyPts.map((p) => p.ms)) : 0;
  const latMax = latencyPts.length ? Math.max(...latencyPts.map((p) => p.ms)) : 1;
  const latSpan = Math.max(1, latMax - latMin);
  const xFor = (i: number) => i * (barW + gap) + barW / 2;
  const yForMs = (ms: number) => {
    // Invert: lower RTT near top. Keep a small pad.
    const t = (ms - latMin) / latSpan;
    return 3 + (1 - t) * (h - 8);
  };

  return (
    <svg width={w} height={h} className="overflow-visible opacity-90" aria-hidden>
      {pts.map((p, i) => {
        const st = p.status || (p.up ? 'up' : 'down');
        const fill =
          st === 'up' ? '#22d3ee' : st === 'degraded' ? '#fbbf24' : st === 'pending' ? '#64748b' : '#fb7185';
        // Status bars: up tall, degraded mid, down/pending short — avoids null-ms diagonal artifact.
        const barH = st === 'up' ? h - 4 : st === 'degraded' ? h * 0.55 : h * 0.22;
        const x = i * (barW + gap);
        const y = h - barH;
        return <rect key={i} x={x} y={y} width={barW} height={barH} rx={1} fill={fill} opacity={0.85} />;
      })}
      {latencyPts.length >= 2 &&
        latencyPts.slice(0, -1).map((p, idx) => {
          const next = latencyPts[idx + 1];
          return (
            <line
              key={`lat-${p.i}`}
              x1={xFor(p.i)}
              y1={yForMs(p.ms)}
              x2={xFor(next.i)}
              y2={yForMs(next.ms)}
              stroke="#e0f2fe"
              strokeWidth={1.2}
              strokeLinecap="round"
              opacity={0.9}
            />
          );
        })}
    </svg>
  );
}

function StatusDot({ status }: { status: Status }) {
  const m = STATUS_META[status] || STATUS_META.pending;
  return (
    <span
      className="inline-block w-2.5 h-2.5 rounded-full shrink-0 animate-pulse"
      style={{ background: m.color, boxShadow: `0 0 10px ${m.glow}` }}
    />
  );
}

export default function StatusHub() {
  const { canWrite } = useAuth();
  const { current } = useRouterDevice();
  const routerId = current?.id ?? null;
  const routerParams = routerId ? { routerId } : {};
  const viaRouter = !!routerId;
  const [tab, setTab] = useState<Tab>('services');
  const [groups, setGroups] = useState<Group[]>([]);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [uplink, setUplink] = useState<{ targets: UplinkTarget[]; hosts: UplinkHost[]; summary: any } | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [addOpen, setAddOpen] = useState(false);

  const loadServices = async () => {
    const r = await api.get('/status-hub', { params: routerParams });
    setGroups(r.data.groups || []);
    setMonitors(r.data.monitors || []);
    setSummary(r.data.summary || null);
  };

  const loadUplink = async () => {
    const r = await api.get('/status-hub/uplink', { params: routerParams });
    setUplink(r.data);
  };

  const triggerScan = async () => {
    setBusy(true);
    try {
      await Promise.all([
        api.get('/status-hub/check', { params: routerParams }).then((r) => {
          setGroups(r.data.groups || []);
          setMonitors(r.data.monitors || []);
          setSummary({ ...(r.data.summary || {}), scanning: true });
        }),
        api.get('/status-hub/uplink/check', { params: routerParams }).then((r) => setUplink(r.data)),
      ]);
      // Full router sweep can take several minutes (sequential probes).
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const [svc, up] = await Promise.all([
          api.get('/status-hub', { params: routerParams }),
          api.get('/status-hub/uplink', { params: routerParams }),
        ]);
        setGroups(svc.data.groups || []);
        setMonitors(svc.data.monitors || []);
        setSummary(svc.data.summary || null);
        setUplink(up.data);
        if (!svc.data.summary?.scanning) break;
      }
    } catch {
      try {
        await Promise.all([loadServices(), loadUplink()]);
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const id = 'status-hub-fonts';
    if (!document.getElementById(id)) {
      const link = document.createElement('link');
      link.id = id;
      link.rel = 'stylesheet';
      link.href =
        'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap';
      document.head.appendChild(link);
    }
  }, []);

  useEffect(() => {
    // Load latest background results — do not force a full scan on every visit.
    loadServices().catch(() => undefined);
    loadUplink().catch(() => undefined);
    const id = setInterval(() => {
      loadServices().catch(() => undefined);
      loadUplink().catch(() => undefined);
    }, 30_000);
    return () => clearInterval(id);
  }, [routerId]);

  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q
      ? monitors.filter(
          (m) =>
            m.name.toLowerCase().includes(q) ||
            m.url.toLowerCase().includes(q) ||
            m.groupName.toLowerCase().includes(q)
        )
      : monitors;
    return groups
      .map((g) => ({
        group: g,
        items: list.filter((m) => m.groupId === g.id),
      }))
      .filter((x) => x.items.length > 0);
  }, [groups, monitors, filter]);

  return (
    <Layout title="Status Hub">
      <div
        className="status-hub relative -mx-3 sm:-mx-6 lg:-mx-8 -mt-3 sm:-mt-6 lg:-mt-8 -mb-3 sm:-mb-6 lg:-mb-8 min-h-[calc(100dvh-4rem)] overflow-hidden"
        style={{ fontFamily: "'Space Grotesk', system-ui, sans-serif" }}
      >
        {/* Atmosphere */}
        <div className="absolute inset-0 bg-[#050b16]" />
        <div
          className="absolute inset-0 opacity-70"
          style={{
            background:
              'radial-gradient(ellipse 80% 50% at 20% -10%, rgba(34,211,238,0.18), transparent 55%), radial-gradient(ellipse 60% 40% at 90% 10%, rgba(14,165,233,0.12), transparent 50%), radial-gradient(ellipse 50% 60% at 70% 100%, rgba(56,189,248,0.08), transparent 55%)',
          }}
        />
        <div
          className="absolute inset-0 opacity-[0.12] pointer-events-none"
          style={{
            backgroundImage:
              'linear-gradient(rgba(34,211,238,0.35) 1px, transparent 1px), linear-gradient(90deg, rgba(34,211,238,0.35) 1px, transparent 1px)',
            backgroundSize: '48px 48px',
            maskImage: 'radial-gradient(ellipse at center, black 20%, transparent 75%)',
          }}
        />
        <div className="absolute top-24 left-1/2 -translate-x-1/2 w-[520px] h-[520px] rounded-full bg-cyan-400/5 blur-3xl pointer-events-none animate-[pulse_6s_ease-in-out_infinite]" />

        <div className="relative z-10 px-4 sm:px-6 lg:px-8 py-6 sm:py-8 max-w-[1600px] mx-auto">
          {/* Hero */}
          <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-5 mb-8">
            <div>
              <div className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.28em] text-cyan-300/80 mb-3">
                <Satellite size={14} className="text-cyan-400" />
                Internet status feeds
              </div>
              <h1 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-white tracking-tight leading-none">
                Status <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 to-sky-400">Hub</span>
              </h1>
              <p className="mt-3 text-slate-400 max-w-xl text-sm sm:text-base leading-relaxed">
                {viaRouter
                  ? `Reachability and latency tests run through the active MikroTik router (“${current?.name}”) — your subscribers’ WAN perspective.`
                  : 'Crowdsourced and official outage data from the internet. Select a router in the top bar to probe services from your network edge.'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => triggerScan()}
                disabled={busy}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-cyan-950 bg-gradient-to-r from-cyan-300 to-sky-400 hover:from-cyan-200 hover:to-sky-300 shadow-[0_0_24px_rgba(34,211,238,0.35)] transition disabled:opacity-60"
              >
                <RefreshCw size={16} className={busy ? 'animate-spin' : ''} />
                Scan now
              </button>
              {canWrite && (
                <button
                  type="button"
                  onClick={() => setAddOpen(true)}
                  className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-cyan-100 border border-cyan-400/30 bg-cyan-400/10 hover:bg-cyan-400/20 transition"
                >
                  <Plus size={16} /> Add service
                </button>
              )}
            </div>
          </div>

          {/* Summary strip */}
          <div className="mb-4 rounded-2xl border border-cyan-400/20 bg-cyan-400/5 px-4 py-3 text-sm text-cyan-100/90">
            {summary?.routerProbeUnavailable ? (
              <>
                <b>{current?.name}</b> is missing <b>Host</b> and/or <b>API user</b> — open <b>System Settings → Routers → Edit</b>, enter the MikroTik API address (reachable from this panel), API user/password, run <b>Test connection</b>, then <b>Save</b>. Showing <b>internet feeds</b> until then.
              </>
            ) : summary?.feedFallback ? (
              <>
                Router scan still warming up — showing <b>internet feeds</b> until probes from <b>{current?.name}</b> are available.
              </>
            ) : viaRouter && summary && summary.total > 0 && summary.down === summary.total ? (
              <>
                All services show <b>offline</b> from <b>{current?.name}</b>. Check WAN/DNS on the router, API user permissions (read, ping, tool), and firewall rules for outbound HTTPS. Tap <b>Scan now</b> after fixing — a full sweep takes a few minutes.
              </>
            ) : viaRouter ? (
              <>
                Probing via <b>{current?.name}</b> — checks run automatically in the background about every 5 minutes. Use <b>Scan now</b> only for an immediate refresh.
              </>
            ) : (
              <>
                No router selected — showing <b>internet status feeds</b> (also auto-refreshed in the background). Pick a router in the top bar for live probes from your network.
              </>
            )}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            {[
              { label: 'Online', value: summary?.up ?? '—', icon: CheckCircle2, tone: '#34d399' },
              { label: 'Degraded', value: summary?.degraded ?? '—', icon: AlertTriangle, tone: '#fbbf24' },
              { label: 'Offline', value: summary?.down ?? '—', icon: XCircle, tone: '#fb7185' },
              {
                label: summary?.mode === 'router-probe' ? 'Avg RTT' : 'Source',
                value:
                  summary?.mode === 'router-probe'
                    ? summary?.avgMs != null
                      ? `${summary.avgMs} ms`
                      : '—'
                    : 'Internet',
                icon: summary?.mode === 'router-probe' ? Network : Globe2,
                tone: '#22d3ee',
              },
            ].map((s) => (
              <div
                key={s.label}
                className="rounded-2xl border border-white/10 bg-white/[0.03] backdrop-blur-md px-4 py-3.5"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] uppercase tracking-widest text-slate-500">{s.label}</span>
                  <s.icon size={15} style={{ color: s.tone }} />
                </div>
                <div className="text-2xl font-semibold text-white tabular-nums" style={{ textShadow: `0 0 18px ${s.tone}55` }}>
                  {s.value}
                </div>
              </div>
            ))}
          </div>

          {/* Tabs */}
          <div className="flex flex-wrap gap-1 p-1 rounded-2xl border border-white/10 bg-black/30 mb-6 w-full sm:w-auto">
            {(
              [
                { id: 'services' as Tab, label: 'Services & Games', icon: Gamepad2 },
                { id: 'uplink' as Tab, label: 'Backbone', icon: Wifi },
                { id: 'manage' as Tab, label: 'Manage', icon: Server },
              ] as const
            ).map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={[
                  'flex-1 sm:flex-none inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition',
                  tab === t.id
                    ? 'bg-cyan-400/15 text-cyan-200 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.35)]'
                    : 'text-slate-400 hover:text-slate-200',
                ].join(' ')}
              >
                <t.icon size={15} />
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'services' && (
            <div>
              <div className="mb-5 flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
                <div className="relative max-w-md w-full">
                  <Globe2 size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-cyan-500/60" />
                  <input
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    placeholder="Filter services, games, URLs…"
                    className="w-full rounded-xl border border-white/10 bg-white/5 pl-10 pr-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-400/30"
                  />
                </div>
                <div className="text-[11px] font-mono text-slate-500 flex items-center gap-2">
                  <Clock size={12} />
                  Last sweep {ago(summary?.lastRunAt ?? null)}
                </div>
              </div>

              <div className="space-y-8">
                {grouped.map(({ group, items }) => (
                  <section key={group.id}>
                    <div className="flex items-center gap-3 mb-3">
                      <div className="h-px flex-1 bg-gradient-to-r from-cyan-400/40 to-transparent" />
                      <h2 className="text-xs font-semibold uppercase tracking-[0.22em] text-cyan-200/90 shrink-0">
                        {group.name}
                      </h2>
                      <span className="text-[10px] font-mono text-slate-500">{items.length}</span>
                      <div className="h-px flex-1 bg-gradient-to-l from-cyan-400/40 to-transparent" />
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
                      {items.map((m) => {
                        const meta = STATUS_META[m.status] || STATUS_META.pending;
                        return (
                          <article
                            key={m.id}
                            className="group rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.06] to-white/[0.02] p-4 hover:border-cyan-400/30 transition"
                            style={{ boxShadow: m.status === 'down' ? `0 0 24px ${meta.glow}` : undefined }}
                          >
                            <div className="flex items-start justify-between gap-2 mb-2">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <StatusDot status={m.status} />
                                  <h3 className="font-semibold text-slate-100 truncate">{m.name}</h3>
                                </div>
                                <a
                                  href={m.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-[11px] text-slate-500 hover:text-cyan-300 truncate block mt-0.5 font-mono"
                                >
                                  {m.url.replace(/^https?:\/\//, '')}
                                </a>
                                {m.status === 'down' && m.lastError && (
                                  <p className="text-[10px] text-rose-300/80 truncate mt-1" title={m.lastError}>
                                    {m.lastError}
                                  </p>
                                )}
                              </div>
                              <span
                                className="text-[10px] uppercase tracking-wider font-semibold px-2 py-1 rounded-lg shrink-0"
                                style={{ color: meta.color, background: `${meta.color}18` }}
                              >
                                {meta.label}
                              </span>
                            </div>
                            <div className="flex items-end justify-between gap-2 mt-3">
                              <Spark history={m.history} />
                              <div className="text-right">
                                <div className="text-[10px] uppercase tracking-wider text-cyan-300/80">
                                  {m.source === 'router'
                                    ? m.latencyMs != null
                                      ? `${m.latencyMs} ms`
                                      : 'Router'
                                    : m.source === 'internet-fallback'
                                      ? 'Feed · waiting'
                                      : 'Feed'}
                                </div>
                                <div className="text-[10px] text-slate-500 font-mono">{m.uptimePct}% · {ago(m.lastChecked)}</div>
                              </div>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  </section>
                ))}
                {!grouped.length && (
                  <div className="text-center py-16 text-slate-500">No monitors match this filter.</div>
                )}
              </div>
            </div>
          )}

          {tab === 'uplink' && (
            <UplinkPanel
              data={uplink}
              viaRouter={viaRouter}
              routerName={current?.name}
              onRefresh={async () => {
                setBusy(true);
                try {
                  const r = await api.get('/status-hub/uplink/check', { params: routerParams });
                  setUplink(r.data);
                  for (let i = 0; i < 8; i++) {
                    await new Promise((x) => setTimeout(x, 1200));
                    const up = await api.get('/status-hub/uplink', { params: routerParams });
                    setUplink(up.data);
                    if (!up.data.summary?.scanning) break;
                  }
                } finally {
                  setBusy(false);
                }
              }}
              busy={busy}
            />
          )}

          {tab === 'manage' && (
            <ManagePanel
              monitors={monitors}
              canWrite={canWrite}
              onToggle={async (id, enabled) => {
                await api.patch(`/status-hub/monitors/${id}`, { enabled });
                await loadServices();
              }}
              onDelete={async (id) => {
                if (!confirm('Delete this custom monitor?')) return;
                await api.delete(`/status-hub/monitors/${id}`);
                await loadServices();
              }}
              onAdd={() => setAddOpen(true)}
            />
          )}
        </div>
      </div>

      {addOpen && (
        <AddMonitorModal
          groups={groups}
          onClose={() => setAddOpen(false)}
          onSaved={async () => {
            setAddOpen(false);
            await triggerScan();
            setTab('services');
          }}
        />
      )}
    </Layout>
  );
}

function UplinkPanel({
  data,
  viaRouter,
  routerName,
  onRefresh,
  busy,
}: {
  data: { targets: UplinkTarget[]; hosts: UplinkHost[]; summary: any } | null;
  viaRouter?: boolean;
  routerName?: string;
  onRefresh: () => void;
  busy: boolean;
}) {
  const summary = data?.summary;
  return (
    <div className="space-y-6">
      <div className="rounded-3xl border border-cyan-400/20 bg-gradient-to-br from-cyan-500/10 via-transparent to-sky-500/5 p-5 sm:p-6 relative overflow-hidden">
        <div className="absolute -right-10 -top-10 w-40 h-40 rounded-full bg-cyan-400/10 blur-2xl" />
        <div className="relative flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-[0.25em] text-cyan-300/80 mb-2 flex items-center gap-2">
              <Radio size={14} /> Global backbone
            </div>
            <div className="text-2xl sm:text-3xl font-bold text-white tracking-tight">CDN & cloud health</div>
            <p className="text-sm text-slate-400 mt-2 max-w-lg">
              {viaRouter
                ? `Backbone reachability tested from router “${routerName}”.`
                : 'Internet backbone status from public feeds — select a router to probe from your network.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm text-cyan-100 border border-cyan-400/30 bg-black/30 hover:bg-cyan-400/10"
          >
            <RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> Refresh feeds
          </button>
        </div>
        <div className="relative mt-5 grid grid-cols-2 sm:grid-cols-3 gap-3">
          {[
            { label: 'Operational', value: summary?.up ?? '—' },
            { label: 'Degraded', value: summary?.degraded ?? '—' },
            { label: 'Outage', value: summary?.down ?? '—' },
          ].map((x) => (
            <div key={x.label} className="rounded-xl bg-black/25 border border-white/5 px-3 py-2">
              <div className="text-[10px] uppercase tracking-wider text-slate-500">{x.label}</div>
              <div className="text-lg text-cyan-100 font-semibold tabular-nums">{x.value}</div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-xs font-semibold uppercase tracking-[0.22em] text-cyan-200/90 mb-3 flex items-center gap-2">
          <Network size={14} /> Providers (internet status)
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {(data?.targets || []).map((t) => {
            const meta = STATUS_META[t.status] || STATUS_META.pending;
            return (
              <article key={t.id} className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <StatusDot status={t.status} />
                      <h3 className="font-semibold text-slate-100 truncate">{t.name}</h3>
                    </div>
                    <div className="text-[11px] text-slate-500 mt-0.5">{t.region}</div>
                    {t.bodySnip && <div className="text-[10px] text-slate-500 mt-1 line-clamp-2">{t.bodySnip}</div>}
                  </div>
                  <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: meta.color }}>
                    {meta.label}
                  </span>
                </div>
                <div className="flex items-end justify-between mt-3">
                  <Spark history={t.history || []} />
                  <div className="text-right">
                    {viaRouter && t.latencyMs != null && (
                      <div className="text-[10px] text-cyan-300/80 font-mono">{t.latencyMs} ms</div>
                    )}
                    <div className="text-[10px] text-slate-500 font-mono">{ago(t.lastChecked)}</div>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </div>

      <p className="text-[11px] text-slate-500 font-mono">
        Prometheus scrape: <span className="text-cyan-400/80">GET /api/status-hub/metrics</span> · Last refresh {ago(summary?.lastRunAt ?? null)}
      </p>
    </div>
  );
}

function ManagePanel({
  monitors,
  canWrite,
  onToggle,
  onDelete,
  onAdd,
}: {
  monitors: Monitor[];
  canWrite: boolean;
  onToggle: (id: number, enabled: boolean) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
  onAdd: () => void;
}) {
  const custom = monitors.filter((m) => !m.builtin);
  const builtin = monitors.filter((m) => m.builtin);
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Monitor catalog</h2>
          <p className="text-sm text-slate-400">Enable or add monitors that read public internet status feeds. No local network probes.</p>
        </div>
        {canWrite && (
          <button
            type="button"
            onClick={onAdd}
            className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl text-sm font-medium text-cyan-950 bg-cyan-300 hover:bg-cyan-200"
          >
            <Plus size={15} /> Add
          </button>
        )}
      </div>

      {!!custom.length && (
        <div>
          <h3 className="text-xs uppercase tracking-widest text-slate-500 mb-2">Custom</h3>
          <MonitorTable rows={custom} canWrite={canWrite} onToggle={onToggle} onDelete={onDelete} />
        </div>
      )}
      <div>
        <h3 className="text-xs uppercase tracking-widest text-slate-500 mb-2">Built-in ({builtin.length})</h3>
        <MonitorTable rows={builtin} canWrite={canWrite} onToggle={onToggle} onDelete={onDelete} />
      </div>
    </div>
  );
}

function MonitorTable({
  rows,
  canWrite,
  onToggle,
  onDelete,
}: {
  rows: Monitor[];
  canWrite: boolean;
  onToggle: (id: number, enabled: boolean) => Promise<void>;
  onDelete: (id: number) => Promise<void>;
}) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-white/10">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wider text-slate-500 border-b border-white/10">
            <th className="px-4 py-3">Name</th>
            <th className="px-4 py-3">Group</th>
            <th className="px-4 py-3">Type</th>
            <th className="px-4 py-3">Enabled</th>
            <th className="px-4 py-3" />
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id} className="border-b border-white/5 text-slate-300">
              <td className="px-4 py-2.5">
                <div className="font-medium text-slate-100">{m.name}</div>
                <div className="text-[11px] font-mono text-slate-500 truncate max-w-[280px]">{m.url}</div>
              </td>
              <td className="px-4 py-2.5 text-slate-400">{m.groupName}</td>
              <td className="px-4 py-2.5 font-mono text-xs uppercase text-cyan-300/80">{m.type}</td>
              <td className="px-4 py-2.5">
                {canWrite ? (
                  <button
                    type="button"
                    onClick={() => onToggle(m.id, !m.enabled)}
                    className={`text-xs font-semibold px-2 py-1 rounded-lg ${m.enabled ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-500/20 text-slate-400'}`}
                  >
                    {m.enabled ? 'On' : 'Off'}
                  </button>
                ) : (
                  <span className="text-xs text-slate-500">{m.enabled ? 'On' : 'Off'}</span>
                )}
              </td>
              <td className="px-4 py-2.5 text-right">
                {canWrite && !m.builtin && (
                  <button type="button" className="text-rose-400 hover:text-rose-300" onClick={() => onDelete(m.id)}>
                    <Trash2 size={15} />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AddMonitorModal({
  groups,
  onClose,
  onSaved,
}: {
  groups: Group[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [feedSlug, setFeedSlug] = useState('');
  const [statusPage, setStatusPage] = useState('');
  const [url, setUrl] = useState('');
  const [groupSlug, setGroupSlug] = useState('custom');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const save = async () => {
    setErr('');
    setBusy(true);
    try {
      await api.post('/status-hub/monitors', { name, feedSlug, statusPage, url, groupSlug, type: 'feed' });
      onSaved();
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Add internet status monitor"
      onClose={onClose}
      footer={<ModalFooter onCancel={onClose} onConfirm={save} busy={busy} confirmLabel="Add monitor" />}
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-500">
          Uses public feeds only (e.g. isitdownstatus slug and/or official Statuspage JSON). Nothing is probed through your network.
        </p>
        <FormField label="Name" required>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="My Service" />
        </FormField>
        <FormField label="Feed slug" hint="isitdownstatus.com slug, e.g. discord, steam, netflix">
          <input className="input font-mono text-sm" value={feedSlug} onChange={(e) => setFeedSlug(e.target.value)} placeholder="discord" />
        </FormField>
        <FormField label="Official status page JSON" hint="Optional Atlassian Statuspage …/api/v2/summary.json">
          <input
            className="input font-mono text-sm"
            value={statusPage}
            onChange={(e) => setStatusPage(e.target.value)}
            placeholder="https://…/api/v2/summary.json"
          />
        </FormField>
        <FormField label="Website (display only)">
          <input className="input font-mono text-sm" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" />
        </FormField>
        <FormField label="Group">
          <select className="input" value={groupSlug} onChange={(e) => setGroupSlug(e.target.value)}>
            {groups.map((g) => (
              <option key={g.slug} value={g.slug}>
                {g.name}
              </option>
            ))}
          </select>
        </FormField>
        {err && <div className="text-sm text-rose-600 bg-rose-50 border border-rose-100 rounded-xl px-3 py-2">{err}</div>}
      </div>
    </Modal>
  );
}
