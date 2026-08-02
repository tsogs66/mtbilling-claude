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
  RadioTower,
  Send,
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
  localReports1h?: number;
  localReports24h?: number;
  checkedAt: number;
  history: { t: number; level: OutageLevel; reports1h: number }[];
}

interface SubscriberReport {
  id: number;
  customerName?: string;
  accountNumber?: string;
  contact?: string;
  description?: string;
  jobOrderId?: number;
  createdAt: string;
  services: { slug: string; name: string; category: string }[];
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
  const [subscriberReports, setSubscriberReports] = useState<SubscriberReport[]>([]);
  const [summary, setSummary] = useState<any>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [region, setRegion] = useState<'all' | 'ph' | 'global'>('all');
  const [category, setCategory] = useState<string>('all');
  const [selected, setSelected] = useState<OutageService | null>(null);
  const [busy, setBusy] = useState(false);
  const [naps, setNaps] = useState<
    { id: number; name: string; code?: string; subscriberCount?: number }[]
  >([]);
  const [selectedNapIds, setSelectedNapIds] = useState<number[]>([]);
  const [noticeTitle, setNoticeTitle] = useState('Network outage');
  const [noticeBody, setNoticeBody] = useState('');
  const [noticeChannels, setNoticeChannels] = useState<string[]>(['sms']);
  const [noticeBusy, setNoticeBusy] = useState(false);
  const [noticeMsg, setNoticeMsg] = useState('');
  const [recentNotices, setRecentNotices] = useState<any[]>([]);

  const applyPayload = (data: any) => {
    setServices(data.services || []);
    setMostReported(data.mostReported || []);
    setSummary(data.summary || null);
    setCategories(data.categories || []);
    setSubscriberReports(data.subscriberReports || []);
    if (selected) {
      const fresh = (data.services || []).find((s: OutageService) => s.slug === selected.slug);
      if (fresh) setSelected(fresh);
    }
  };

  const load = async () => {
    const r = await api.get('/outage-monitor');
    applyPayload(r.data);
  };

  const refresh = async () => {
    setBusy(true);
    try {
      const r = await api.get('/outage-monitor/check');
      applyPayload(r.data);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    load().catch(() => undefined);
    const id = setInterval(() => load().catch(() => undefined), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    void api
      .get('/outage-notices/naps')
      .then((r) => setNaps(r.data.naps || []))
      .catch(() => setNaps([]));
    void api
      .get('/outage-notices')
      .then((r) => setRecentNotices(r.data.notices || []))
      .catch(() => setRecentNotices([]));
  }, []);

  const toggleNap = (id: number) => {
    setSelectedNapIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const recipientPreview = useMemo(
    () =>
      naps
        .filter((n) => selectedNapIds.includes(n.id))
        .reduce((s, n) => s + (Number(n.subscriberCount) || 0), 0),
    [naps, selectedNapIds]
  );

  const sendNapNotice = async () => {
    setNoticeBusy(true);
    setNoticeMsg('');
    try {
      const r = await api.post('/outage-notices/send', {
        title: noticeTitle,
        body: noticeBody,
        napIds: selectedNapIds,
        channels: noticeChannels,
      });
      setNoticeMsg(
        `Sent to ${r.data.recipientCount} subscriber${r.data.recipientCount === 1 ? '' : 's'} on selected NAP boxes.`
      );
      setNoticeBody('');
      const list = await api.get('/outage-notices');
      setRecentNotices(list.data.notices || []);
    } catch (e: any) {
      setNoticeMsg(e?.response?.data?.error || e.message || 'Send failed');
    } finally {
      setNoticeBusy(false);
    }
  };

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
                Crowdsourced public outages plus subscriber reports from the client portal — PH ISPs,
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
          Status uses crowdsourced report volume plus portal subscriber reports: <b>No problems</b> ·{' '}
          <b>Possible problems</b> · <b>Problems</b>. Auto-refreshes about every 3 minutes · Last sweep{' '}
          {ago(summary?.lastSweepAt)}
          {summary?.localReports24h != null && (
            <> · <b>{summary.localReports24h}</b> subscriber report{summary.localReports24h === 1 ? '' : 's'} /24h</>
          )}
        </p>

        <section className="card p-4 sm:p-5">
          <div className="flex items-center gap-2 mb-1">
            <RadioTower size={16} className="text-orange-500" />
            <h2 className="text-sm font-semibold text-slate-800">Notify subscribers by NAP box</h2>
          </div>
          <p className="text-xs text-slate-500 mb-3 leading-relaxed">
            Select affected NAP boxes — only clients linked to those NAPs get the SMS/email and an in-portal
            activity notice.
          </p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">NAP boxes</span>
                <div className="flex gap-2 text-xs">
                  <button
                    type="button"
                    className="text-brand-600 font-semibold"
                    onClick={() => setSelectedNapIds(naps.map((n) => n.id))}
                  >
                    Select all
                  </button>
                  <button type="button" className="text-slate-400" onClick={() => setSelectedNapIds([])}>
                    Clear
                  </button>
                </div>
              </div>
              <div className="max-h-56 overflow-y-auto border border-slate-100 rounded-xl divide-y divide-slate-100">
                {naps.map((n) => {
                  const on = selectedNapIds.includes(n.id);
                  return (
                    <label
                      key={n.id}
                      className={`flex items-center gap-2 px-3 py-2 text-sm cursor-pointer ${
                        on ? 'bg-orange-50' : 'hover:bg-slate-50'
                      }`}
                    >
                      <input type="checkbox" checked={on} onChange={() => toggleNap(n.id)} />
                      <span className="min-w-0 flex-1 truncate font-medium text-slate-800">
                        {n.name}
                        {n.code ? <span className="text-slate-400 font-normal"> · {n.code}</span> : null}
                      </span>
                      <span className="text-[11px] text-slate-400 tabular-nums shrink-0">
                        {n.subscriberCount ?? 0} clients
                      </span>
                    </label>
                  );
                })}
                {!naps.length && (
                  <div className="px-3 py-6 text-sm text-slate-400 text-center">No NAP boxes found.</div>
                )}
              </div>
              <p className="text-xs text-slate-500 mt-2">
                Selected {selectedNapIds.length} NAP
                {selectedNapIds.length === 1 ? '' : 's'} · ~{recipientPreview} subscriber
                {recipientPreview === 1 ? '' : 's'}
              </p>
            </div>
            <div className="space-y-2">
              <input
                className="input"
                value={noticeTitle}
                onChange={(e) => setNoticeTitle(e.target.value)}
                placeholder="Notice title"
              />
              <textarea
                className="input min-h-[120px]"
                value={noticeBody}
                onChange={(e) => setNoticeBody(e.target.value)}
                placeholder="Message shown in portal + SMS/email (e.g. fiber cut on feeder, ETA 2 hours)…"
              />
              <div className="flex flex-wrap gap-4 text-sm text-slate-600">
                {(['sms', 'email'] as const).map((ch) => (
                  <label key={ch} className="inline-flex items-center gap-2 capitalize">
                    <input
                      type="checkbox"
                      checked={noticeChannels.includes(ch)}
                      onChange={(e) =>
                        setNoticeChannels((prev) =>
                          e.target.checked ? [...prev, ch] : prev.filter((x) => x !== ch)
                        )
                      }
                    />
                    {ch}
                  </label>
                ))}
              </div>
              <button
                type="button"
                disabled={noticeBusy || !selectedNapIds.length || !noticeBody.trim()}
                onClick={() => void sendNapNotice()}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-orange-500 text-white hover:bg-orange-600 disabled:opacity-50"
              >
                <Send size={15} />
                {noticeBusy ? 'Sending…' : 'Send to selected NAPs'}
              </button>
              {noticeMsg && <p className="text-xs text-slate-600">{noticeMsg}</p>}
            </div>
          </div>
          {recentNotices.length > 0 && (
            <div className="mt-4 border-t border-slate-100 pt-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Recent sends</div>
              <ul className="space-y-1.5 text-sm">
                {recentNotices.slice(0, 6).map((n) => (
                  <li key={n.id} className="flex justify-between gap-3 text-slate-600">
                    <span className="truncate">
                      <b className="text-slate-800 font-medium">{n.title}</b>
                      <span className="text-slate-400">
                        {' '}
                        · {(n.napIds || []).length} NAP · {n.recipientCount || 0} clients
                      </span>
                    </span>
                    <span className="text-[11px] text-slate-400 shrink-0">
                      {String(n.sentAt || n.createdAt || '').replace('T', ' ').slice(0, 16)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {subscriberReports.length > 0 && (
          <section className="card p-4">
            <div className="flex items-center gap-2 mb-3">
              <AlertTriangle size={16} className="text-amber-500" />
              <h2 className="text-sm font-semibold text-slate-800">Subscriber portal reports</h2>
              <span className="text-xs text-slate-400 ml-auto">Latest from /portal</span>
            </div>
            <ul className="divide-y divide-slate-100">
              {subscriberReports.slice(0, 12).map((r) => (
                <li key={r.id} className="py-2.5 flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-slate-800 truncate">
                      {r.customerName || 'Subscriber'}
                      {r.accountNumber && (
                        <span className="ml-2 font-mono text-xs text-slate-400">{r.accountNumber}</span>
                      )}
                    </div>
                    {r.description && (
                      <p className="text-sm text-slate-600 mt-0.5 line-clamp-2">{r.description}</p>
                    )}
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {r.services.map((svc) => (
                        <button
                          key={`${r.id}-${svc.slug}`}
                          type="button"
                          className="text-[11px] px-2 py-0.5 rounded-md bg-rose-50 text-rose-700 border border-rose-100"
                          onClick={() => {
                            const match = services.find((x) => x.slug === svc.slug);
                            if (match) setSelected(match);
                          }}
                        >
                          {svc.name}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="text-[11px] text-slate-400 shrink-0 sm:text-right">
                    {r.createdAt?.replace('T', ' ').slice(0, 16) || '—'}
                    {r.jobOrderId != null && <div>JO linked</div>}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

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
                      {s.reports1h} public/1h
                      {(s.localReports1h || 0) > 0 && (
                        <span className="text-rose-600 font-medium"> · {s.localReports1h} portal</span>
                      )}
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
                          {s.reports1h}/{s.reports24h} public
                          {(s.localReports1h || s.localReports24h) ? (
                            <span className="text-rose-600 font-medium">
                              {' '}· {s.localReports1h || 0}/{s.localReports24h || 0} portal
                            </span>
                          ) : null}
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
                      <div className="text-xs text-slate-500">Public reports /1h</div>
                    </div>
                    <div className="rounded-xl border border-slate-100 p-3">
                      <div className="text-2xl font-bold text-slate-900 tabular-nums">{selected.reports24h}</div>
                      <div className="text-xs text-slate-500">Public reports /24h</div>
                    </div>
                    <div className="rounded-xl border border-rose-100 bg-rose-50/40 p-3">
                      <div className="text-2xl font-bold text-rose-700 tabular-nums">{selected.localReports1h || 0}</div>
                      <div className="text-xs text-slate-500">Portal subscriber /1h</div>
                    </div>
                    <div className="rounded-xl border border-rose-100 bg-rose-50/40 p-3">
                      <div className="text-2xl font-bold text-rose-700 tabular-nums">{selected.localReports24h || 0}</div>
                      <div className="text-xs text-slate-500">Portal subscriber /24h</div>
                    </div>
                  </div>
                  {subscriberReports.filter((r) => r.services.some((x) => x.slug === selected.slug)).length > 0 && (
                    <div className="mb-4">
                      <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
                        Recent portal reports for {selected.name}
                      </div>
                      <ul className="space-y-2 max-h-40 overflow-y-auto">
                        {subscriberReports
                          .filter((r) => r.services.some((x) => x.slug === selected.slug))
                          .slice(0, 8)
                          .map((r) => (
                            <li key={r.id} className="text-sm rounded-lg border border-slate-100 px-3 py-2">
                              <div className="font-medium text-slate-800">{r.customerName || 'Subscriber'}</div>
                              {r.description && <div className="text-slate-600 text-xs mt-0.5">{r.description}</div>}
                              <div className="text-[11px] text-slate-400 mt-1">{r.createdAt?.replace('T', ' ').slice(0, 16)}</div>
                            </li>
                          ))}
                      </ul>
                    </div>
                  )}
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
