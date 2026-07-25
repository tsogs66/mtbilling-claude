import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Activity, CheckCircle2, AlertTriangle, XCircle, Gauge, Globe2, MapPin, Building2 } from 'lucide-react';
import Layout from '../components/Layout';
import { Card, StatTile } from '../components/ui';
import { api } from '../api';
import { useRouterDevice } from '../context/RouterContext';

type ScopeId = 'global' | 'regional' | 'local';

interface Sample { t: number; up: boolean; ms: number | null }
interface Monitor {
  id: string;
  name: string;
  category: string;
  url: string;
  status: 'up' | 'down' | 'degraded' | 'pending';
  latencyMs: number | null;
  code: number;
  lastChecked: number | null;
  uptimePct: number;
  avgMs: number | null;
  history: Sample[];
  lastError?: string | null;
  detail?: string;
  source?: string;
  reportCount1h?: number;
  reportCount24h?: number;
  regionStatus?: string;
  regionDetail?: string;
  scope?: ScopeId;
}
interface Summary {
  total: number;
  up: number;
  degraded: number;
  down: number;
  avgMs: number | null;
  reports1h?: number;
  scope?: ScopeId;
  lastRun: number | null;
}
interface ScopeMeta {
  id: ScopeId;
  label: string;
  description: string;
}

const STATUS: Record<string, { label: string; cls: string; dot: string }> = {
  up: { label: 'Operational', cls: 'bg-emerald-100 text-emerald-700', dot: 'bg-emerald-500' },
  degraded: { label: 'Degraded', cls: 'bg-amber-100 text-amber-700', dot: 'bg-amber-500' },
  down: { label: 'Down', cls: 'bg-rose-100 text-rose-700', dot: 'bg-rose-500' },
  pending: { label: 'Checking...', cls: 'bg-slate-100 text-slate-500', dot: 'bg-slate-300' },
};

const SCOPE_ICONS: Record<ScopeId, typeof Globe2> = {
  global: Globe2,
  regional: Building2,
  local: MapPin,
};

const STORAGE_KEY = 'mt_uptime_scope';

function ago(ts: number | null) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

/** Green segments for good samples, red for bad — split path by consecutive status. */
function Sparkline({ history }: { history: Sample[] }) {
  const pts = history.slice(-24);
  if (pts.length < 2) return <div className="h-8 flex items-center text-[11px] text-slate-300">collecting…</div>;

  const hasLatency = pts.some((p) => p.up && p.ms != null && p.ms > 0);
  const vals = pts.map((p) => (p.up ? (hasLatency ? p.ms ?? 0 : 1) : 0));
  const max = Math.max(1, ...vals);
  const w = 120;
  const h = 32;
  const step = w / (pts.length - 1);
  const yFor = (p: Sample) => {
    if (!p.up) return h - 2;
    if (!hasLatency) return 8;
    return h - ((p.ms ?? 0) / max) * (h - 4) - 2;
  };

  return (
    <svg width={w} height={h} className="overflow-visible" aria-hidden>
      {pts.map((p, i) => {
        const next = pts[i + 1];
        if (!next) return null;
        const good = p.up && next.up;
        return (
          <line
            key={`l${i}`}
            x1={i * step}
            y1={yFor(p)}
            x2={(i + 1) * step}
            y2={yFor(next)}
            stroke={good ? '#10b981' : '#ef4444'}
            strokeWidth={1.8}
            strokeLinecap="round"
          />
        );
      })}
      {pts.map((p, i) => (
        <circle
          key={`c${i}`}
          cx={i * step}
          cy={yFor(p)}
          r={1.8}
          fill={p.up ? '#10b981' : '#ef4444'}
        />
      ))}
    </svg>
  );
}

const DEFAULT_SCOPES: ScopeMeta[] = [
  { id: 'global', label: 'Global', description: 'Worldwide outage feeds' },
  { id: 'regional', label: 'Regional (Asia)', description: 'Asia / SEA status pages' },
  { id: 'local', label: 'Local (Philippines)', description: 'Reachability from this panel' },
];

export default function Uptime() {
  const { current } = useRouterDevice();
  const routerId = current?.id ?? null;
  const [scope, setScope] = useState<ScopeId>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'global' || saved === 'regional' || saved === 'local') return saved;
    } catch {
      /* ignore */
    }
    return 'global';
  });
  const [scopes, setScopes] = useState<ScopeMeta[]>(DEFAULT_SCOPES);
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  const load = (sc = scope, rid = routerId) =>
    api
      .get('/uptime', { params: { scope: sc, ...(rid ? { routerId: rid } : {}) } })
      .then((r) => {
        setMonitors(r.data.monitors || []);
        setSummary(r.data.summary);
        if (Array.isArray(r.data.scopes) && r.data.scopes.length) setScopes(r.data.scopes);
        setError('');
      })
      .catch((e) => {
        setError(e?.response?.data?.error || 'Could not load uptime data');
      });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, scope);
    } catch {
      /* ignore */
    }
    let cancelled = false;
    setChecking(true);
    api
      .post('/uptime/check', { scope, ...(routerId ? { routerId } : {}) })
      .then((r) => {
        if (cancelled) return;
        setMonitors(r.data.monitors || []);
        setSummary(r.data.summary);
        if (Array.isArray(r.data.scopes) && r.data.scopes.length) setScopes(r.data.scopes);
        setError('');
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e?.response?.data?.error || 'Could not load uptime data');
        load(scope);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });

    const t = setInterval(() => load(scope, routerId), 30000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, routerId]);

  const changeScope = (next: ScopeId) => {
    if (next === scope) return;
    setScope(next);
    setMonitors([]);
    setSummary(null);
  };

  const refresh = async () => {
    setChecking(true);
    setError('');
    try {
      const r = await api.post('/uptime/check', { scope, ...(routerId ? { routerId } : {}) });
      setMonitors(r.data.monitors || []);
      setSummary(r.data.summary);
      if (Array.isArray(r.data.scopes) && r.data.scopes.length) setScopes(r.data.scopes);
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Check failed');
    } finally {
      setChecking(false);
    }
  };

  const grouped = useMemo(() => {
    const g: Record<string, Monitor[]> = {};
    for (const m of monitors) (g[m.category] ||= []).push(m);
    return g;
  }, [monitors]);

  const activeMeta = scopes.find((s) => s.id === scope) || DEFAULT_SCOPES.find((s) => s.id === scope);

  return (
    <Layout title="Uptime Monitor">
      <div className="mb-4 flex flex-wrap gap-2">
        {scopes.map((s) => {
          const Icon = SCOPE_ICONS[s.id] || Globe2;
          const active = s.id === scope;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => changeScope(s.id)}
              className={`inline-flex items-center gap-2 rounded-xl border px-3.5 py-2 text-sm font-semibold transition-colors ${
                active
                  ? 'border-brand-500 bg-brand-50 text-brand-800 shadow-sm'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'
              }`}
            >
              <Icon size={15} className={active ? 'text-brand-600' : 'text-slate-400'} />
              {s.label}
            </button>
          );
        })}
      </div>

      <div className="mb-5 rounded-xl border border-slate-200 bg-slate-50/80 px-4 py-3 text-sm text-slate-700 max-w-4xl">
        <div className="font-semibold text-slate-800">{activeMeta?.label}</div>
        <div className="text-slate-500 mt-0.5">{activeMeta?.description}</div>
        {scope === 'local' && (
          <div className="mt-2 text-xs text-slate-600">
            Probe source:{' '}
            <span className="font-semibold text-slate-800">
              {current?.name ? `MikroTik router “${current.name}”` : 'Panel server (no router selected)'}
            </span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        <StatTile label="Monitored" value={summary?.total ?? '—'} icon={Activity} tone="text-slate-700" delay={0} />
        <StatTile label="Operational" value={summary?.up ?? '—'} icon={CheckCircle2} tone="text-emerald-600" accent="from-emerald-500/15 to-transparent" delay={50} />
        <StatTile label="Degraded" value={summary?.degraded ?? '—'} icon={AlertTriangle} tone="text-amber-600" accent="from-amber-500/15 to-transparent" delay={100} />
        <StatTile label="Down" value={summary?.down ?? '—'} icon={XCircle} tone="text-rose-600" accent="from-rose-500/15 to-transparent" delay={150} />
        <StatTile
          label={scope === 'local' ? 'Avg latency' : 'Reports (1h)'}
          value={
            scope === 'local'
              ? summary?.avgMs != null
                ? `${summary.avgMs} ms`
                : '—'
              : (summary?.reports1h ?? '—')
          }
          icon={scope === 'local' ? Gauge : Globe2}
          tone="text-sky-600"
          accent="from-sky-500/15 to-transparent"
          delay={200}
        />
      </div>

      <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <div className="text-sm text-slate-500">
          Last check: <span className="font-medium text-slate-700">{ago(summary?.lastRun ?? null)}</span>
          {' · '}graph: <span className="text-emerald-600 font-medium">green</span> good /{' '}
          <span className="text-rose-600 font-medium">red</span> bad
        </div>
        <button type="button" className="btn-primary" onClick={refresh} disabled={checking}>
          <RefreshCw size={16} className={checking ? 'animate-spin' : ''} /> {checking ? 'Checking…' : 'Check now'}
        </button>
      </div>

      {error && (
        <div className="mb-4 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{error}</div>
      )}

      <div className="space-y-5">
        {Object.entries(grouped).map(([category, list]) => (
          <Card key={category} title={category} icon={Activity} interactive>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-1">
              {list.map((m) => {
                const st = STATUS[m.status] || STATUS.pending;
                return (
                  <div key={m.id} className="flex items-center gap-4 py-3 border-b border-slate-50 last:border-0 hover:bg-slate-50/50 rounded-lg px-1 transition-colors">
                    <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${st.dot} ${m.status === 'up' ? 'animate-pulse-soft' : ''}`} />
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold text-slate-800 truncate">{m.name}</div>
                      <div className="text-[11px] text-slate-400 truncate" title={m.detail || m.lastError || m.url}>
                        {m.detail || m.lastError || m.url.replace(/^https?:\/\//, '')}
                      </div>
                    </div>
                    <div className="hidden sm:block"><Sparkline history={m.history} /></div>
                    <div className="text-right w-16 shrink-0">
                      <div className="text-sm font-semibold text-slate-700">
                        {scope === 'local'
                          ? m.latencyMs != null
                            ? `${m.latencyMs} ms`
                            : '—'
                          : m.reportCount1h
                            ? `${m.reportCount1h} rpt`
                            : m.regionStatus && m.regionStatus !== 'unknown'
                              ? 'Asia'
                              : 'Global'}
                      </div>
                      <div className="text-[11px] text-slate-400">{m.uptimePct}% up</div>
                    </div>
                    <span className={`badge ${st.cls} w-24 justify-center shrink-0`}>{st.label}</span>
                  </div>
                );
              })}
            </div>
          </Card>
        ))}
        {monitors.length === 0 && !error && (
          <div className="text-sm text-slate-400 py-10 text-center">Loading monitors…</div>
        )}
      </div>
    </Layout>
  );
}
