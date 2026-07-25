import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Search,
  TrendingUp,
  XCircle,
  ExternalLink,
} from 'lucide-react';
import Layout from '../components/Layout';
import { api } from '../api';

type OutageLevel = 'no_problems' | 'possible_problems' | 'problems' | 'unknown';

interface OutageService {
  slug: string;
  name: string;
  category: string;
  url: string;
  region: string;
  level: OutageLevel;
  status: string;
  detail: string;
  reports1h: number;
  reports24h: number;
  checkedAt: number;
  history: { t: number; level: OutageLevel; reports1h: number }[];
}

const LEVEL_META: Record<
  OutageLevel,
  { label: string; short: string; color: string; bg: string; ring: string }
> = {
  no_problems: {
    label: 'No problems',
    short: 'OK',
    color: '#059669',
    bg: 'bg-emerald-50',
    ring: 'ring-emerald-200',
  },
  possible_problems: {
    label: 'Possible problems',
    short: 'Watch',
    color: '#d97706',
    bg: 'bg-amber-50',
    ring: 'ring-amber-200',
  },
  problems: {
    label: 'Problems',
    short: 'Down',
    color: '#e11d48',
    bg: 'bg-rose-50',
    ring: 'ring-rose-200',
  },
  unknown: {
    label: 'Checking…',
    short: '…',
    color: '#64748b',
    bg: 'bg-slate-50',
    ring: 'ring-slate-200',
  },
};

function ago(ts: number | null | undefined) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function ReportSpark({ history }: { history: OutageService['history'] }) {
  const pts = history.slice(-28);
  if (pts.length < 2) {
    return <div className="h-8 w-full rounded bg-slate-100/80" />;
  }
  const max = Math.max(1, ...pts.map((p) => p.reports1h));
  const w = 120;
  const h = 32;
  const step = w / (pts.length - 1);
  const d = pts
    .map((p, i) => {
      const x = i * step;
      const y = h - 2 - (p.reports1h / max) * (h - 4);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const last = pts[pts.length - 1];
  const stroke =
    last.level === 'problems' ? '#e11d48' : last.level === 'possible_problems' ? '#d97706' : '#059669';
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="block">
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function OutageMonitor() {
  const [services, setServices] = useState<OutageService[]>([]);
  const [mostReported, setMostReported] = useState<OutageService[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [region, setRegion] = useState<'all' | 'ph' | 'global'>('all');
  const [category, setCategory] = useState<string>('all');
  const [selected, setSelected] = useState<OutageService | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const r = await api.get('/outage-monitor');
    setServices(r.data.services || []);
    setMostReported(r.data.mostReported || []);
    setSummary(r.data.summary || null);
    setCategories(r.data.categories || []);
    if (selected) {
      const fresh = (r.data.services || []).find((s: OutageService) => s.slug === selected.slug);
      if (fresh) setSelected(fresh);
    }
  };

  const refresh = async () => {
    setBusy(true);
    try {
      const r = await api.get('/outage-monitor/check');
      setServices(r.data.services || []);
      setMostReported(r.data.mostReported || []);
      setSummary(r.data.summary || null);
      setCategories(r.data.categories || []);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    load().catch(() => undefined);
    const id = setInterval(() => load().catch(() => undefined), 30_000);
    return () => clearInterval(id);
  }, []);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return services.filter((s) => {
      if (region !== 'all' && s.region !== region) return false;
      if (category !== 'all' && s.category !== category) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q) ||
        s.slug.toLowerCase().includes(q)
      );
    });
  }, [services, filter, region, category]);

  const byCategory = useMemo(() => {
    const map = new Map<string, OutageService[]>();
    for (const s of filtered) {
      const list = map.get(s.category) || [];
      list.push(s);
      map.set(s.category, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  return (
    <Layout title="Outage Monitor">
      <div className="space-y-6">
        <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-900 via-slate-900 to-slate-800 text-white px-5 py-6 sm:px-8 overflow-hidden relative">
          <div
            className="absolute inset-0 opacity-30 pointer-events-none"
            style={{
              backgroundImage:
                'radial-gradient(ellipse 60% 50% at 10% 0%, rgba(251,113,133,0.35), transparent), radial-gradient(ellipse 50% 40% at 90% 20%, rgba(52,211,153,0.2), transparent)',
            }}
          />
          <div className="relative flex flex-col lg:flex-row lg:items-end lg:justify-between gap-5">
            <div>
              <div className="inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.22em] text-rose-300/90 mb-2">
                <Activity size={14} /> Crowdsourced outages
              </div>
              <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">Outage Monitor</h1>
              <p className="mt-2 text-slate-300 text-sm sm:text-base max-w-xl leading-relaxed">
                Real-time service problems from public internet reports — Downdetector-style view for PH ISPs,
                banks, apps, and global platforms. Separate from Status Hub router probes.
              </p>
            </div>
            <button
              type="button"
              onClick={() => refresh()}
              disabled={busy}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-white text-slate-900 hover:bg-slate-100 disabled:opacity-60"
            >
              <RefreshCw size={16} className={busy || summary?.sweeping ? 'animate-spin' : ''} />
              Refresh now
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { label: 'No problems', value: summary?.noProblems ?? '—', icon: CheckCircle2, color: '#059669' },
            { label: 'Possible problems', value: summary?.possibleProblems ?? '—', icon: AlertTriangle, color: '#d97706' },
            { label: 'Problems', value: summary?.problems ?? '—', icon: XCircle, color: '#e11d48' },
            { label: 'Services', value: summary?.total ?? '—', icon: Activity, color: '#0f172a' },
          ].map((c) => (
            <div key={c.label} className="card p-4 flex items-center gap-3">
              <span
                className="w-10 h-10 rounded-xl flex items-center justify-center"
                style={{ background: `${c.color}14`, color: c.color }}
              >
                <c.icon size={18} />
              </span>
              <div>
                <div className="text-2xl font-bold text-slate-900 tabular-nums">{c.value}</div>
                <div className="text-xs text-slate-500">{c.label}</div>
              </div>
            </div>
          ))}
        </div>

        <p className="text-xs text-slate-500">
          Status uses crowdsourced report volume vs normal: <b>No problems</b> · <b>Possible problems</b> ·{' '}
          <b>Problems</b>. Auto-refreshes about every 3 minutes · Last sweep {ago(summary?.lastSweepAt)}
        </p>

        {mostReported.length > 0 && (
          <section className="card p-4">
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp size={16} className="text-rose-500" />
              <h2 className="text-sm font-semibold text-slate-800">Most reported right now</h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
              {mostReported.map((s, i) => {
                const m = LEVEL_META[s.level] || LEVEL_META.unknown;
                return (
                  <button
                    key={s.slug}
                    type="button"
                    onClick={() => setSelected(s)}
                    className={`text-left rounded-xl border px-3 py-2.5 hover:shadow-sm transition ${m.bg} ${m.ring} ring-1`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-slate-400">#{i + 1}</span>
                      <span className="text-[10px] font-semibold uppercase" style={{ color: m.color }}>
                        {m.short}
                      </span>
                    </div>
                    <div className="font-semibold text-slate-900 truncate mt-0.5">{s.name}</div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {s.reports1h} reports/1h · {s.reports24h}/24h
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
          <div className="relative flex-1">
            <Search size={15} className="absolute left-3 top-2.5 text-slate-400" />
            <input
              className="input pl-9"
              placeholder="Filter services…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <select className="input sm:w-40" value={region} onChange={(e) => setRegion(e.target.value as any)}>
            <option value="all">All regions</option>
            <option value="ph">Philippines</option>
            <option value="global">Global</option>
          </select>
          <select className="input sm:w-44" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="all">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-6">
          {byCategory.map(([cat, items]) => (
            <section key={cat}>
              <h2 className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-2">
                {cat} ({items.length})
              </h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {items.map((s) => {
                  const m = LEVEL_META[s.level] || LEVEL_META.unknown;
                  return (
                    <button
                      key={s.slug}
                      type="button"
                      onClick={() => setSelected(s)}
                      className="card p-3 text-left hover:shadow-md transition border border-slate-100"
                    >
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="min-w-0">
                          <div className="font-semibold text-slate-900 truncate">{s.name}</div>
                          <div className="text-[11px] text-slate-400 truncate">{s.url.replace(/^https?:\/\//, '')}</div>
                        </div>
                        <span
                          className="shrink-0 text-[10px] font-bold uppercase tracking-wide px-2 py-1 rounded-lg"
                          style={{ color: m.color, background: `${m.color}18` }}
                        >
                          {m.label}
                        </span>
                      </div>
                      <ReportSpark history={s.history} />
                      <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                        <span>
                          {s.reports1h} /1h · {s.reports24h} /24h
                        </span>
                        <span>{ago(s.checkedAt)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
          {!byCategory.length && (
            <div className="text-center py-16 text-slate-500">No services match this filter.</div>
          )}
        </div>
      </div>

      {selected && (
        <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center p-0 sm:p-4">
          <button type="button" className="absolute inset-0 bg-slate-900/50" onClick={() => setSelected(null)} aria-label="Close" />
          <div className="relative w-full sm:max-w-lg bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[85dvh] overflow-y-auto p-5 sm:p-6">
            {(() => {
              const m = LEVEL_META[selected.level] || LEVEL_META.unknown;
              return (
                <>
                  <div className="flex items-start justify-between gap-3 mb-4">
                    <div>
                      <h3 className="text-xl font-bold text-slate-900">{selected.name}</h3>
                      <p className="text-sm text-slate-500 mt-0.5">{selected.category} · {selected.region === 'ph' ? 'Philippines' : 'Global'}</p>
                    </div>
                    <button type="button" className="p-2 rounded-lg hover:bg-slate-100 text-slate-400" onClick={() => setSelected(null)}>
                      ✕
                    </button>
                  </div>
                  <div className={`rounded-xl px-4 py-3 mb-4 ${m.bg} ring-1 ${m.ring}`}>
                    <div className="font-semibold" style={{ color: m.color }}>
                      {m.label}
                    </div>
                    <div className="text-sm text-slate-600 mt-1">{selected.detail}</div>
                  </div>
                  <div className="grid grid-cols-2 gap-3 mb-4">
                    <div className="rounded-xl border border-slate-100 p-3">
                      <div className="text-2xl font-bold text-slate-900 tabular-nums">{selected.reports1h}</div>
                      <div className="text-xs text-slate-500">Reports last 1 hour</div>
                    </div>
                    <div className="rounded-xl border border-slate-100 p-3">
                      <div className="text-2xl font-bold text-slate-900 tabular-nums">{selected.reports24h}</div>
                      <div className="text-xs text-slate-500">Reports last 24 hours</div>
                    </div>
                  </div>
                  <div className="mb-4">
                    <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Report trend</div>
                    <div className="rounded-xl border border-slate-100 p-3">
                      <ReportSpark history={selected.history} />
                    </div>
                  </div>
                  <a
                    href={selected.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 text-sm font-medium text-brand-600 hover:text-brand-700"
                  >
                    <ExternalLink size={14} /> Open {selected.name}
                  </a>
                  <p className="text-[11px] text-slate-400 mt-4">
                    How to read statuses: <b>No problems</b> — no evidence of an incident. <b>Possible problems</b> — some elevated
                    reports. <b>Problems</b> — strong evidence of an outage. Updated {ago(selected.checkedAt)}.
                  </p>
                </>
              );
            })()}
          </div>
        </div>
      )}
    </Layout>
  );
}
