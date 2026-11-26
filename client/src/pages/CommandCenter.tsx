import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis,
} from 'recharts';
import {
  Bookmark, ChevronDown, Command, Copy, Download, ExternalLink, Filter, LayoutGrid, Maximize2, Minimize2, Radar, RefreshCw,
  Rows3, Search, Timer, X, Zap,
} from 'lucide-react';
import Layout from '../components/Layout';
import CommandMap, { TONE_HEX } from '../components/command/CommandMap';
import CommandPalette, { type PaletteAction } from '../components/command/CommandPalette';
import { api } from '../api';
import { useRouterDevice } from '../context/RouterContext';
import { copyText } from '../lib/clipboard';
import {
  applyFilters, buildPace, buildRunway, categoryOf, csvOf, EMPTY_FILTERS, FLAG_LABEL, FLAG_TONE, filtersActive, LENS_CATEGORIES,
  LENSES, QUEUES, queueCounts, queueFor, reminderText, riskTone, segmentBy, shortDay, summarize, toggle,
  type CcFeed, type CcFlag, type CcSubscriber, type Filters, type Lens, type QueueKey, type SavedView, type Segment, type Tone,
} from '../lib/commandModel';

const TONE_VAR: Record<Tone, string> = {
  good: 'var(--cc-good)',
  warn: 'var(--cc-warn)',
  bad: 'var(--cc-bad)',
  info: 'var(--cc-info)',
  mute: 'var(--cc-mute)',
  hot: 'var(--cc-hot)',
};

const money = (n: number) => `\u20b1${Math.round(n || 0).toLocaleString('en-PH')}`;
const num = (n: number) => (n || 0).toLocaleString('en-PH');
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

const PREFS_KEY = 'mt.cc.prefs';
const VIEWS_KEY = 'mt.cc.views';
const WIDGETS = [
  { key: 'map', label: 'Geo map' },
  { key: 'queue', label: 'Attention queue' },
  { key: 'runway', label: 'Cash runway' },
  { key: 'pace', label: 'Collection pace' },
  { key: 'segments', label: 'Segments' },
] as const;
type WidgetKey = (typeof WIDGETS)[number]['key'];

interface Prefs {
  lens: Lens;
  back: number;
  refreshEvery: number;
  widgets: Record<WidgetKey, boolean>;
  compare: boolean;
}

const DEFAULT_PREFS: Prefs = {
  lens: 'revenue',
  back: 14,
  refreshEvery: 60,
  widgets: { map: true, queue: true, runway: true, pace: true, segments: true },
  compare: true,
};

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback;
  } catch {
    return fallback;
  }
}

function readViews(): SavedView[] {
  try {
    const raw = localStorage.getItem(VIEWS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readUrlState(params: URLSearchParams): Partial<{ lens: Lens; filters: Filters; queue: QueueKey; back: number }> {
  const raw = params.get('v');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return {
      lens: parsed.lens,
      queue: parsed.queue,
      back: parsed.back,
      filters: parsed.filters ? { ...EMPTY_FILTERS, ...parsed.filters, bounds: null } : undefined,
    };
  } catch {
    return {};
  }
}

function useClickAway(ref: React.RefObject<HTMLElement>, onAway: () => void) {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onAway();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ref, onAway]);
}

function Popover({ label, icon, badge, children, align = 'left' }: { label: string; icon: ReactNode; badge?: string | number; children: ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickAway(ref, () => setOpen(false));
  return (
    <div className="relative" ref={ref}>
      <button type="button" className={`cc-btn ${open ? 'is-on' : ''}`} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {icon}
        <span>{label}</span>
        {badge ? <span className="cc-badge">{badge}</span> : null}
        <ChevronDown size={13} className="opacity-60" />
      </button>
      {open && <div className={`cc-pop ${align === 'right' ? 'right-0' : 'left-0'}`}>{children}</div>}
    </div>
  );
}

function Dot({ tone }: { tone: Tone }) {
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: TONE_VAR[tone] }} />;
}

export default function CommandCenter({ onClassic }: { onClassic: () => void }) {
  const [params, setParams] = useSearchParams();
  const { routers: deviceRouters, current: currentRouter, setCurrent: setCurrentRouter } = useRouterDevice();
  const initialUrl = useMemo(() => readUrlState(params), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [prefs, setPrefs] = useState<Prefs>(() => {
    const stored = readJson<Prefs>(PREFS_KEY, DEFAULT_PREFS);
    return { ...stored, widgets: { ...DEFAULT_PREFS.widgets, ...stored.widgets }, lens: initialUrl.lens || stored.lens, back: initialUrl.back || stored.back };
  });
  const [filters, setFilters] = useState<Filters>(initialUrl.filters || EMPTY_FILTERS);
  const [queue, setQueue] = useState<QueueKey>(initialUrl.queue || 'all');
  const [feed, setFeed] = useState<CcFeed | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [follow, setFollow] = useState(false);
  const [bigMap, setBigMap] = useState(false);
  const [views, setViews] = useState<SavedView[]>(readViews);
  const [viewName, setViewName] = useState('');
  const [toast, setToast] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const { lens, back, refreshEvery, widgets, compare } = prefs;
  const patchPrefs = (p: Partial<Prefs>) => setPrefs((cur) => ({ ...cur, ...p }));

  useEffect(() => {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  }, [prefs]);

  useEffect(() => {
    const payload = { lens, queue, back, filters: { ...filters, bounds: null } };
    const next = new URLSearchParams(params);
    if (filtersActive({ ...filters, bounds: null }) || queue !== 'all') next.set('v', JSON.stringify(payload));
    else next.delete('v');
    if (next.toString() !== params.toString()) setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lens, queue, back, filters]);

  const flash = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(''), 2400);
  }, []);

  const load = useCallback(async (live: boolean) => {
    setRefreshing(true);
    try {
      if (live) await api.get('/dashboard/status').catch(() => null);
      const r = await api.get<CcFeed>('/dashboard/command');
      setFeed(r.data);
      setError('');
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Could not load the command feed');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load(false).then(() => load(true));
  }, [load]);

  useEffect(() => {
    if (!refreshEvery) return;
    const t = window.setInterval(() => load(true), refreshEvery * 1000);
    return () => window.clearInterval(t);
  }, [refreshEvery, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === '/' && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'Escape' && !typing && !paletteOpen) {
        setSelectedId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paletteOpen]);

  const subs = useMemo(() => feed?.subscribers ?? [], [feed]);
  const patchFilters = (p: Partial<Filters>) => setFilters((cur) => ({ ...cur, ...p }));
  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
    setFollow(false);
  };

  const shown = useMemo(() => applyFilters(subs, filters, lens), [subs, filters, lens]);
  const sum = useMemo(() => summarize(shown), [shown]);

  const mapScope = useMemo(() => applyFilters(subs, filters, lens, 'bounds'), [subs, filters, lens]);
  const legendPool = useMemo(() => applyFilters(subs, filters, lens, 'cat'), [subs, filters, lens]);
  const planPool = useMemo(() => applyFilters(subs, filters, lens, 'plans'), [subs, filters, lens]);
  const routerPool = useMemo(() => applyFilters(subs, filters, lens, 'routers'), [subs, filters, lens]);
  const napPool = useMemo(() => applyFilters(subs, filters, lens, 'naps'), [subs, filters, lens]);

  const runwayAll = useMemo(() => (feed ? buildRunway(shown, feed.payments, feed.today, back, 30) : []), [feed, shown, back]);
  const runway = useMemo(() => runwayAll.filter((b) => b.kind !== 'overdue'), [runwayAll]);
  const overdueBar = runwayAll.find((b) => b.kind === 'overdue');
  const pace = useMemo(() => (feed ? buildPace(shown, feed.payments, feed) : null), [feed, shown]);
  const queueRows = useMemo(() => queueFor(shown, queue), [shown, queue]);
  const queueTotals = useMemo(() => queueCounts(shown), [shown]);

  const selected = useMemo(() => subs.find((s) => s.id === selectedId) || null, [subs, selectedId]);

  const focusLens = (next: Lens, cat: string[]) => {
    patchPrefs({ lens: next });
    patchFilters({ cat });
  };

  const openInSubscribers = (s: CcSubscriber) => {
    const device = deviceRouters.find((r) => r.id === s.routerId);
    if (device && device.id !== currentRouter?.id) setCurrentRouter(device);
  };

  const exportCsv = (rows: CcSubscriber[], name: string) => {
    const blob = new Blob([csvOf(rows)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}-${feed?.today || 'export'}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    flash(`Exported ${rows.length} rows`);
  };

  const copyReminders = async (rows: CcSubscriber[]) => {
    const ok = await copyText(rows.map((s) => reminderText(s, money)).join('\n\n'));
    flash(ok ? `Copied ${rows.length} reminder${rows.length === 1 ? '' : 's'}` : 'Copy was blocked by the browser');
  };

  const saveView = () => {
    const name = viewName.trim();
    if (!name) return;
    const view: SavedView = { id: String(Date.now()), name, lens, filters: { ...filters, bounds: null }, back, queue };
    const next = [view, ...views].slice(0, 12);
    setViews(next);
    localStorage.setItem(VIEWS_KEY, JSON.stringify(next));
    setViewName('');
    flash(`Saved view "${name}"`);
  };
  const applyView = (v: SavedView) => {
    patchPrefs({ lens: v.lens, back: v.back });
    setFilters({ ...EMPTY_FILTERS, ...v.filters, bounds: null });
    setQueue(v.queue);
    setFollow(false);
  };
  const removeView = (id: string) => {
    const next = views.filter((v) => v.id !== id);
    setViews(next);
    localStorage.setItem(VIEWS_KEY, JSON.stringify(next));
  };

  const paletteActions: PaletteAction[] = [
    { id: 'lens-revenue', label: 'Switch to Revenue lens', icon: Zap, run: () => focusLens('revenue', []) },
    { id: 'lens-network', label: 'Switch to Network lens', icon: Radar, run: () => focusLens('network', []) },
    { id: 'lens-risk', label: 'Switch to Risk lens', icon: Zap, run: () => focusLens('risk', []) },
    { id: 'refresh', label: 'Refresh with live router data', icon: RefreshCw, run: () => load(true) },
    { id: 'clear', label: 'Clear all filters', icon: Filter, run: clearFilters },
    { id: 'export', label: 'Export the filtered subscribers as CSV', icon: Download, run: () => exportCsv(shown, 'subscribers') },
    { id: 'classic', label: 'Open the classic dashboard', icon: LayoutGrid, run: onClassic },
  ];

  const chips: { key: string; label: string; clear: () => void }[] = [];
  filters.routers.forEach((id) => chips.push({ key: `r${id}`, label: `Router: ${feed?.routers.find((r) => r.id === id)?.name ?? id}`, clear: () => patchFilters({ routers: filters.routers.filter((x) => x !== id) }) }));
  filters.plans.forEach((p) => chips.push({ key: `p${p}`, label: `Plan: ${p}`, clear: () => patchFilters({ plans: filters.plans.filter((x) => x !== p) }) }));
  filters.naps.forEach((n) => chips.push({ key: `n${n}`, label: `NAP: ${n}`, clear: () => patchFilters({ naps: filters.naps.filter((x) => x !== n) }) }));
  filters.cat.forEach((c) => chips.push({ key: `c${c}`, label: LENS_CATEGORIES[lens].find((x) => x.key === c)?.label ?? c, clear: () => patchFilters({ cat: filters.cat.filter((x) => x !== c) }) }));
  if (filters.flag) chips.push({ key: 'flag', label: FLAG_LABEL[filters.flag], clear: () => patchFilters({ flag: null }) });
  if (filters.dueDay) chips.push({ key: 'due', label: `Due ${shortDay(filters.dueDay)}`, clear: () => patchFilters({ dueDay: null }) });
  if (filters.search.trim()) chips.push({ key: 'q', label: `Search: ${filters.search.trim()}`, clear: () => patchFilters({ search: '' }) });
  if (filters.bounds) chips.push({ key: 'view', label: 'Map view', clear: () => setFollow(false) });

  const updated = feed ? new Date(feed.generatedAt).toLocaleTimeString('en-PH', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  const missingGeo = subs.filter((s) => s.lat == null || s.lng == null).length;

  const widgetOn = (k: WidgetKey) => widgets[k];
  const topRow = widgetOn('map') && widgetOn('queue');
  const midRow = widgetOn('runway') && widgetOn('pace');

  return (
    <Layout title="Command Center">
      <div className="cc space-y-5 pb-10">
        <header className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="mr-auto min-w-0">
              <h2 className="font-display text-xl font-bold tracking-tight sm:text-2xl">Command Center</h2>
              <p className="text-xs opacity-60">
                {feed ? `${num(subs.length)} subscribers \u00b7 updated ${updated}` : 'Loading the network and billing picture'}
              </p>
            </div>
            <label className="cc-search">
              <Search size={14} className="opacity-60" />
              <input
                ref={searchRef}
                value={filters.search}
                onChange={(e) => patchFilters({ search: e.target.value })}
                placeholder="Filter by name, account, plan, NAP"
                aria-label="Filter subscribers"
              />
              {!filters.search && <kbd className="cc-kbd">/</kbd>}
            </label>
            <button type="button" className="cc-btn" onClick={() => setPaletteOpen(true)} title="Command palette">
              <Command size={14} />
              <span className="hidden 2xl:inline">Jump to</span>
              <kbd className="cc-kbd">Ctrl K</kbd>
            </button>
            <Popover label="Views" icon={<Bookmark size={14} />} badge={views.length || undefined} align="right">
              <div className="w-72 space-y-3 p-3">
                <div className="flex gap-2">
                  <input value={viewName} onChange={(e) => setViewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveView()} placeholder="Name this view" className="cc-input flex-1" />
                  <button type="button" className="cc-btn is-on" onClick={saveView} disabled={!viewName.trim()}>Save</button>
                </div>
                <p className="text-[11px] opacity-60">Keeps the lens, filters, queue tab and runway window. The page link also carries them, so you can share it.</p>
                {views.length === 0 && <p className="text-xs opacity-60">No saved views yet.</p>}
                <ul className="space-y-1">
                  {views.map((v) => (
                    <li key={v.id} className="flex items-center gap-2">
                      <button type="button" className="cc-row flex-1 truncate text-left" onClick={() => applyView(v)}>
                        {v.name}
                        <span className="ml-2 text-[11px] opacity-55">{LENSES.find((l) => l.key === v.lens)?.label}</span>
                      </button>
                      <button type="button" className="cc-icon" onClick={() => removeView(v.id)} aria-label={`Delete view ${v.name}`}><X size={13} /></button>
                    </li>
                  ))}
                </ul>
              </div>
            </Popover>
            <Popover label="Layout" icon={<Rows3 size={14} />} align="right">
              <div className="w-64 space-y-3 p-3">
                <div>
                  <p className="cc-label">Panels</p>
                  {WIDGETS.map((w) => (
                    <label key={w.key} className="cc-check">
                      <input type="checkbox" checked={widgets[w.key]} onChange={() => patchPrefs({ widgets: { ...widgets, [w.key]: !widgets[w.key] } })} />
                      {w.label}
                    </label>
                  ))}
                </div>
                <div>
                  <p className="cc-label">Auto refresh</p>
                  <div className="cc-seg">
                    {[[0, 'Off'], [30, '30s'], [60, '1m'], [300, '5m']].map(([v, l]) => (
                      <button key={v} type="button" className={refreshEvery === v ? 'is-on' : ''} onClick={() => patchPrefs({ refreshEvery: v as number })}>{l}</button>
                    ))}
                  </div>
                </div>
                <label className="cc-check">
                  <input type="checkbox" checked={compare} onChange={() => patchPrefs({ compare: !compare })} />
                  Compare pace with last month
                </label>
              </div>
            </Popover>
            <button type="button" className="cc-btn" onClick={() => load(true)} disabled={refreshing} title="Pull live router state, then reload">
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
              <span className="hidden 2xl:inline">{refreshing ? 'Syncing' : 'Refresh'}</span>
            </button>
            <button type="button" className="cc-btn" onClick={onClassic} title="Back to the classic dashboard">
              <LayoutGrid size={14} />
              <span className="hidden xl:inline">Classic</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="cc-seg cc-seg-lens" role="tablist" aria-label="Lens">
              {LENSES.map((l) => (
                <button key={l.key} type="button" role="tab" aria-selected={lens === l.key} title={l.hint} className={lens === l.key ? 'is-on' : ''} onClick={() => focusLens(l.key, [])}>
                  {l.label}
                </button>
              ))}
            </div>
            <Popover label="Scope" icon={<Filter size={14} />} badge={filters.routers.length + filters.plans.length + filters.naps.length || undefined}>
              <ScopeMenu
                routers={feed?.routers ?? []}
                routerPool={routerPool}
                planPool={planPool}
                napPool={napPool}
                filters={filters}
                onChange={patchFilters}
              />
            </Popover>
            <label className="cc-btn cursor-pointer" title="Days of collections shown before today">
              <Timer size={14} />
              <select value={back} onChange={(e) => patchPrefs({ back: Number(e.target.value) })} className="cc-bare" aria-label="Collections window">
                <option value={7}>Last 7 days</option>
                <option value={14}>Last 14 days</option>
                <option value={30}>Last 30 days</option>
              </select>
            </label>
            {chips.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5">
                {chips.map((c) => (
                  <button key={c.key} type="button" className="cc-chip" onClick={c.clear} title="Remove filter">
                    {c.label}
                    <X size={11} />
                  </button>
                ))}
                <button type="button" className="cc-link" onClick={clearFilters}>Clear all</button>
              </div>
            )}
          </div>
        </header>

        {error && (
          <p className="rounded-lg border px-4 py-3 text-sm" style={{ borderColor: 'var(--cc-bad)', color: 'var(--cc-bad)' }}>
            {error}
          </p>
        )}

        {!feed && !error && <p className="py-16 text-center text-sm opacity-60">Loading subscribers</p>}

        {feed && subs.length === 0 && (
          <p className="py-16 text-center text-sm opacity-70">
            No subscribers yet. <Link className="cc-link" to="/pppoe">Add the first subscriber</Link> and this page fills in.
          </p>
        )}

        {feed && subs.length > 0 && (
          <>
            <section aria-label="Pulse" className="cc-pulse">
              <PulseItem label="Billable" value={num(sum.billable)} sub={`${num(sum.disabled)} disabled`} onClick={() => patchFilters({ cat: [] })} on={false} />
              <PulseItem label="Online" value={num(sum.online)} sub={`${pct(sum.online, sum.billable)}% of billable`} tone="good" on={lens === 'network' && filters.cat.join() === 'online'} onClick={() => focusLens('network', ['online'])} />
              <PulseItem label="Offline" value={num(sum.offline)} sub={sum.paidOffline ? `${num(sum.paidOffline)} of them paid` : 'active but not connected'} tone="bad" on={lens === 'network' && filters.cat.join() === 'offline'} onClick={() => focusLens('network', ['offline'])} />
              <PulseItem label="On hold" value={num(sum.held)} sub="non-payment or expired" tone="warn" on={lens === 'network' && filters.cat.join() === 'hold'} onClick={() => focusLens('network', ['hold'])} />
              <PulseItem label="Collected" value={money(sum.collected)} sub={`${pct(sum.collected, sum.target)}% of ${money(sum.target)} target`} tone="good" bar={sum.target ? Math.min(1, sum.collected / sum.target) : 0} on={lens === 'revenue' && filters.cat.join() === 'paid,late'} onClick={() => focusLens('revenue', ['paid', 'late'])} />
              <PulseItem label="Not paid" value={money(sum.unpaidAmount)} sub={`${num(sum.unpaidCount)} subscribers`} tone="bad" on={lens === 'revenue' && filters.cat.join() === 'unpaid'} onClick={() => focusLens('revenue', ['unpaid'])} />
              <PulseItem label="Paid after due" value={num(sum.lateCount)} sub={`${num(sum.onTimeCount)} paid on time`} tone="warn" on={lens === 'revenue' && filters.cat.join() === 'late'} onClick={() => focusLens('revenue', ['late'])} />
              <PulseItem label="Critical" value={num(sum.critical)} sub={sum.onlineUnpaid ? `${num(sum.onlineUnpaid)} online, unpaid` : 'risk 75 and up'} tone="hot" on={lens === 'risk' && filters.cat.join() === 'critical'} onClick={() => focusLens('risk', ['critical'])} />
            </section>

            {(widgetOn('map') || widgetOn('queue')) && (
              <section className={`grid gap-5 ${topRow ? 'lg:grid-cols-12' : ''}`}>
                {widgetOn('map') && (
                  <div className={topRow ? 'lg:col-span-8' : ''}>
                    <PanelHead
                      title="Where it is happening"
                      note={`${num(shown.filter((s) => s.lat != null).length)} shown on the map${missingGeo ? ` \u00b7 ${num(missingGeo)} without a location` : ''}`}
                      actions={
                        <>
                          <label className="cc-check m-0">
                            <input type="checkbox" checked={follow} onChange={() => setFollow((v) => !v)} />
                            Filter by map view
                          </label>
                          <button type="button" className="cc-icon" onClick={() => setBigMap((v) => !v)} aria-label={bigMap ? 'Shrink the map' : 'Enlarge the map'}>
                            {bigMap ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                          </button>
                        </>
                      }
                    />
                    <div className={`cc-mapframe ${bigMap ? 'is-big' : ''}`}>
                      <CommandMap
                        all={mapScope}
                        shown={shown}
                        lens={lens}
                        selectedId={selectedId}
                        follow={follow}
                        onSelect={setSelectedId}
                        onBounds={(b) => patchFilters({ bounds: b })}
                      />
                      <Legend lens={lens} pool={legendPool} active={filters.cat} onToggle={(k) => patchFilters({ cat: toggle(filters.cat, k) })} />
                    </div>
                  </div>
                )}

                {widgetOn('queue') && (
                  <div className={topRow ? 'lg:col-span-4' : ''}>
                    <PanelHead title="Needs attention" note={`${num(queueRows.length)} ranked by risk`} />
                    <div className="cc-tabs" role="tablist">
                      {QUEUES.map((q) => (
                        <button key={q.key} type="button" role="tab" aria-selected={queue === q.key} className={queue === q.key ? 'is-on' : ''} onClick={() => setQueue(q.key)}>
                          {q.label}
                          <span>{queueTotals[q.key]}</span>
                        </button>
                      ))}
                    </div>
                    <QueueList
                      rows={queueRows}
                      today={feed.today}
                      selectedId={selectedId}
                      picked={picked}
                      tall={topRow && !bigMap}
                      onSelect={setSelectedId}
                      onPick={(id) =>
                        setPicked((cur) => {
                          const next = new Set(cur);
                          if (next.has(id)) next.delete(id);
                          else next.add(id);
                          return next;
                        })
                      }
                    />
                    <div className="cc-queuebar">
                      {picked.size > 0 ? (
                        <>
                          <span>{picked.size} selected</span>
                          <button type="button" className="cc-link" onClick={() => copyReminders(subs.filter((s) => picked.has(s.id)))}><Copy size={12} /> Copy reminders</button>
                          <button type="button" className="cc-link" onClick={() => exportCsv(subs.filter((s) => picked.has(s.id)), 'selected')}><Download size={12} /> CSV</button>
                          <button type="button" className="cc-link" onClick={() => setPicked(new Set())}>Clear</button>
                        </>
                      ) : (
                        <>
                          <span className="opacity-60">Tick rows to act on several at once</span>
                          <button type="button" className="cc-link" onClick={() => exportCsv(queueRows, 'attention-queue')} disabled={queueRows.length === 0}><Download size={12} /> Export list</button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </section>
            )}

            {(widgetOn('runway') || widgetOn('pace')) && (
              <section className={`grid gap-5 ${midRow ? 'lg:grid-cols-12' : ''}`}>
                {widgetOn('runway') && (
                  <div className={midRow ? 'lg:col-span-8' : ''}>
                    <PanelHead
                      title="Cash runway"
                      note={`collected the last ${back} days, due the next 30`}
                      actions={
                        <span className="flex items-center gap-4 text-xs opacity-90">
                          {overdueBar && overdueBar.count > 0 && (
                            <button type="button" className="cc-link" style={{ color: 'var(--cc-bad)' }} onClick={() => patchFilters({ flag: filters.flag === 'overdue' ? null : 'overdue' })}>
                              {money(overdueBar.amount)} overdue, {num(overdueBar.count)} subscribers
                            </button>
                          )}
                          <span>Next 7 days: <strong>{money(runway.filter((b) => b.kind === 'due' || b.kind === 'today').slice(0, 8).reduce((a, b) => a + b.amount, 0))}</strong></span>
                        </span>
                      }
                    />
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart
                          data={runway}
                          margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
                          onClick={(state: any) => {
                            const bar = state?.activePayload?.[0]?.payload;
                            if (!bar) return;
                            if (bar.kind === 'due' || bar.kind === 'today') patchFilters({ dueDay: filters.dueDay === bar.date ? null : bar.date });
                          }}
                        >
                          <CartesianGrid vertical={false} stroke="var(--card-border)" />
                          <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'currentColor' }} interval="preserveStartEnd" minTickGap={26} axisLine={false} tickLine={false} />
                          <YAxis tick={{ fontSize: 10, fill: 'currentColor' }} width={52} axisLine={false} tickLine={false} tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
                          <RTooltip cursor={{ fill: 'rgba(148,163,184,0.18)' }} content={<RunwayTip />} />
                          <ReferenceLine x="Today" stroke="var(--brand)" strokeDasharray="3 3" />
                          <Bar dataKey="amount" radius={[3, 3, 0, 0]} cursor="pointer">
                            {runway.map((bar) => (
                              <Cell
                                key={bar.key}
                                fill={bar.kind === 'collected' ? TONE_HEX.good : bar.kind === 'today' ? 'var(--brand)' : TONE_HEX.info}
                                fillOpacity={filters.dueDay && bar.date !== filters.dueDay ? 0.3 : 0.9}
                              />
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                    <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] opacity-70">
                      <span><Dot tone="good" /> collected</span>
                      <span><Dot tone="info" /> falls due</span>
                      <span>Click a bar to list that day</span>
                    </p>
                  </div>
                )}

                {widgetOn('pace') && pace && (
                  <div className={midRow ? 'lg:col-span-4' : ''}>
                    <PanelHead title="Collection pace" note="this month, running total" />
                    <PaceSummary pace={pace} compare={compare} />
                    <div className="h-48">
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={pace.points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                          <CartesianGrid vertical={false} stroke="var(--card-border)" />
                          <XAxis dataKey="day" tick={{ fontSize: 10, fill: 'currentColor' }} axisLine={false} tickLine={false} interval={4} />
                          <YAxis tick={{ fontSize: 10, fill: 'currentColor' }} width={52} axisLine={false} tickLine={false} tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
                          <RTooltip formatter={(v: number, name: string) => [money(v), name]} labelFormatter={(d) => `Day ${d}`} contentStyle={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: 8, fontSize: 12 }} />
                          {pace.target > 0 && <ReferenceLine y={pace.target} stroke={TONE_HEX.warn} strokeDasharray="4 4" label={{ value: 'Target', fontSize: 10, fill: TONE_HEX.warn, position: 'insideTopLeft' }} />}
                          {compare && <Line type="monotone" dataKey="previous" name="Last month" stroke={TONE_HEX.mute} strokeDasharray="4 3" dot={false} strokeWidth={1.5} connectNulls />}
                          <Line type="monotone" dataKey="projected" name="Projected" stroke="var(--brand)" strokeDasharray="5 4" dot={false} strokeWidth={1.8} connectNulls />
                          <Line type="monotone" dataKey="current" name="This month" stroke={TONE_HEX.good} dot={false} strokeWidth={2.6} connectNulls />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}
              </section>
            )}

            {widgetOn('segments') && (
              <section>
                <PanelHead title="Where the money sits" note="monthly rate by plan, router and NAP, click to filter" />
                <div className="grid gap-x-8 gap-y-6 md:grid-cols-3">
                  <SegmentList title="Plans" rows={segmentBy(planPool, (s) => s.plan)} active={filters.plans} onToggle={(k) => patchFilters({ plans: toggle(filters.plans, k) })} />
                  <SegmentList title="Routers" rows={segmentBy(routerPool, (s) => s.router)} active={filters.routers.map((id) => feed.routers.find((r) => r.id === id)?.name ?? '')} onToggle={(k) => {
                    const id = feed.routers.find((r) => r.name === k)?.id;
                    if (id != null) patchFilters({ routers: toggle(filters.routers, id) });
                  }} />
                  <SegmentList title="NAP boxes" rows={segmentBy(napPool, (s) => s.nap || '\u2014')} active={filters.naps} onToggle={(k) => patchFilters({ naps: toggle(filters.naps, k) })} />
                </div>
              </section>
            )}
          </>
        )}
      </div>

      <Drawer sub={selected} today={feed?.today || ''} onClose={() => setSelectedId(null)} onCopy={(s) => copyReminders([s])} onOpen={openInSubscribers} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        subscribers={subs}
        actions={paletteActions}
        onPickSubscriber={(s) => setSelectedId(s.id)}
      />
      {toast && <div className="cc-toast" role="status">{toast}</div>}
    </Layout>
  );
}

function PanelHead({ title, note, actions }: { title: string; note?: string; actions?: ReactNode }) {
  return (
    <div className="mb-2 flex flex-wrap items-end justify-between gap-2 border-t pt-3" style={{ borderColor: 'var(--card-border)' }}>
      <div>
        <h3 className="text-sm font-semibold tracking-wide">{title}</h3>
        {note && <p className="text-[11px] opacity-60">{note}</p>}
      </div>
      {actions && <div className="flex items-center gap-3">{actions}</div>}
    </div>
  );
}

function PulseItem({
  label, value, sub, tone, on, onClick, bar,
}: { label: string; value: string; sub: string; tone?: Tone; on: boolean; onClick: () => void; bar?: number }) {
  return (
    <button type="button" onClick={onClick} className={`cc-pulse-item ${on ? 'is-on' : ''}`} aria-pressed={on}>
      <span className="cc-pulse-label">
        {tone && <Dot tone={tone} />}
        {label}
      </span>
      <span className="cc-pulse-value" style={tone ? { color: TONE_VAR[tone] } : undefined}>{value}</span>
      <span className="cc-pulse-sub">{sub}</span>
      {bar != null && <span className="cc-pulse-bar"><i style={{ width: `${Math.round(bar * 100)}%` }} /></span>}
    </button>
  );
}

function Legend({ lens, pool, active, onToggle }: { lens: Lens; pool: CcSubscriber[]; active: string[]; onToggle: (key: string) => void }) {
  const counts = new Map<string, number>();
  for (const s of pool) counts.set(categoryOf(s, lens), (counts.get(categoryOf(s, lens)) || 0) + 1);
  return (
    <div className="cc-legend" role="group" aria-label="Map legend">
      {LENS_CATEGORIES[lens].map((c) => {
        const n = counts.get(c.key) || 0;
        const off = active.length > 0 && !active.includes(c.key);
        return (
          <button key={c.key} type="button" className={`cc-legend-item ${off ? 'is-off' : ''}`} onClick={() => onToggle(c.key)} disabled={n === 0 && !active.includes(c.key)}>
            <Dot tone={c.tone} />
            <span>{c.label}</span>
            <b>{num(n)}</b>
          </button>
        );
      })}
    </div>
  );
}

function FlagPill({ flag }: { flag: CcFlag }) {
  const tone = FLAG_TONE[flag];
  return (
    <span className="cc-pill" style={{ color: TONE_VAR[tone], borderColor: `color-mix(in srgb, ${TONE_VAR[tone]} 45%, transparent)` }}>
      {FLAG_LABEL[flag]}
    </span>
  );
}

function dueText(s: CcSubscriber): string {
  if (s.dueIn == null) return 'No due date';
  if (s.dueIn < 0) return `${Math.abs(s.dueIn)}d overdue`;
  if (s.dueIn === 0) return 'Due today';
  return `Due in ${s.dueIn}d`;
}

function QueueList({
  rows, selectedId, picked, tall, onSelect, onPick,
}: { rows: CcSubscriber[]; today: string; selectedId: number | null; picked: Set<number>; tall: boolean; onSelect: (id: number) => void; onPick: (id: number) => void }) {
  const [limit, setLimit] = useState(40);
  useEffect(() => setLimit(40), [rows.length]);
  if (rows.length === 0) return <p className={`cc-empty ${tall ? 'cc-queue-tall' : ''}`}>Nothing in this queue for the current filters.</p>;
  return (
    <ul className={`cc-queue ${tall ? 'cc-queue-tall' : ''}`}>
      {rows.slice(0, limit).map((s, i) => (
        <li key={s.id} className={s.id === selectedId ? 'is-on' : ''}>
          <input type="checkbox" checked={picked.has(s.id)} onChange={() => onPick(s.id)} aria-label={`Select ${s.name}`} />
          <button type="button" onClick={() => onSelect(s.id)} className="min-w-0 flex-1 text-left">
            <span className="flex items-baseline gap-2">
              <span className="text-[11px] tabular-nums opacity-45">{i + 1}</span>
              <span className="truncate text-sm font-medium">{s.name}</span>
              <span className="ml-auto shrink-0 text-xs tabular-nums opacity-80">{money(s.price + s.balance)}</span>
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-1">
              {s.flags.slice(0, 3).map((f) => <FlagPill key={f} flag={f} />)}
              <span className="text-[11px] opacity-60">{dueText(s)}</span>
            </span>
          </button>
          <span className="cc-risk" title={`Risk ${s.risk}`} style={{ color: TONE_VAR[riskTone(s.risk)] }}>
            {s.risk}
            <i style={{ width: `${s.risk}%`, background: TONE_VAR[riskTone(s.risk)] }} />
          </span>
        </li>
      ))}
      {rows.length > limit && (
        <li className="justify-center">
          <button type="button" className="cc-link" onClick={() => setLimit((l) => l + 60)}>Show {Math.min(60, rows.length - limit)} more</button>
        </li>
      )}
    </ul>
  );
}

function RunwayTip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const bar = payload[0].payload;
  const verb = bar.kind === 'collected' ? 'collected' : bar.kind === 'overdue' ? 'unpaid past due' : bar.kind === 'today' ? 'today' : 'falls due';
  return (
    <div className="cc-tip">
      <b>{bar.label}</b>
      <span>{money(bar.amount)} {verb}</span>
      <span className="opacity-60">{num(bar.count)} {bar.kind === 'collected' ? 'payments' : 'subscribers'}</span>
      {bar.kind === 'today' && bar.collected ? <span className="opacity-60">{money(bar.collected)} already collected today</span> : null}
    </div>
  );
}

function PaceSummary({ pace, compare }: { pace: NonNullable<ReturnType<typeof buildPace>>; compare: boolean }) {
  const delta = pace.previousSameDay > 0 ? Math.round(((pace.collected - pace.previousSameDay) / pace.previousSameDay) * 100) : null;
  const gap = pace.target - pace.projected;
  return (
    <dl className="mb-2 grid grid-cols-3 gap-3 text-xs">
      <div>
        <dt className="opacity-60">So far</dt>
        <dd className="text-base font-semibold tabular-nums">{money(pace.collected)}</dd>
        {compare && delta != null && <dd style={{ color: delta >= 0 ? 'var(--cc-good)' : 'var(--cc-bad)' }}>{delta >= 0 ? '+' : ''}{delta}% vs same day</dd>}
      </div>
      <div>
        <dt className="opacity-60">Projected</dt>
        <dd className="text-base font-semibold tabular-nums">{money(pace.projected)}</dd>
        <dd className="opacity-60" title={pace.method === 'last-month' ? "Scaled from last month's collection curve" : 'Straight-line from the days so far'}>
          {pace.method === 'last-month' ? "last month's curve" : 'straight line'}, day {pace.dayOfMonth}/{pace.daysInMonth}
        </dd>
      </div>
      <div>
        <dt className="opacity-60">Target</dt>
        <dd className="text-base font-semibold tabular-nums">{money(pace.target)}</dd>
        <dd style={{ color: gap > 0 ? 'var(--cc-warn)' : 'var(--cc-good)' }}>{gap > 0 ? `${money(gap)} short` : 'on track'}</dd>
      </div>
    </dl>
  );
}

function SegmentList({ title, rows, active, onToggle }: { title: string; rows: Segment[]; active: string[]; onToggle: (key: string) => void }) {
  const [all, setAll] = useState(false);
  const max = Math.max(1, ...rows.map((r) => r.mrr));
  const list = all ? rows : rows.slice(0, 7);
  return (
    <div>
      <p className="cc-label">{title}</p>
      <ul className="space-y-1">
        {list.map((r) => {
          const on = active.includes(r.key);
          const dim = active.length > 0 && !on;
          return (
            <li key={r.key}>
              <button type="button" onClick={() => onToggle(r.key)} className={`cc-seg-row ${on ? 'is-on' : ''} ${dim ? 'is-dim' : ''}`}>
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm">{r.label}</span>
                  <span className="shrink-0 text-xs tabular-nums opacity-80">{money(r.mrr)}</span>
                </span>
                <span className="cc-track"><i style={{ width: `${Math.max(2, (r.mrr / max) * 100)}%` }} /></span>
                <span className="flex gap-3 text-[11px] opacity-65">
                  <span>{num(r.count)} subs</span>
                  {r.unpaid > 0 && <span style={{ color: 'var(--cc-bad)' }}>{num(r.unpaid)} unpaid</span>}
                  {r.offline > 0 && <span style={{ color: 'var(--cc-warn)' }}>{num(r.offline)} offline</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {rows.length > 7 && <button type="button" className="cc-link mt-1" onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${rows.length}`}</button>}
    </div>
  );
}

function ScopeMenu({
  routers, routerPool, planPool, napPool, filters, onChange,
}: {
  routers: { id: number; name: string }[];
  routerPool: CcSubscriber[];
  planPool: CcSubscriber[];
  napPool: CcSubscriber[];
  filters: Filters;
  onChange: (p: Partial<Filters>) => void;
}) {
  const [q, setQ] = useState('');
  const match = (label: string) => !q.trim() || label.toLowerCase().includes(q.trim().toLowerCase());
  const routerRows = segmentBy(routerPool, (s) => s.router).filter((r) => match(r.label));
  const planRows = segmentBy(planPool, (s) => s.plan).filter((r) => match(r.label));
  const napRows = segmentBy(napPool, (s) => s.nap || '\u2014').filter((r) => match(r.label));
  return (
    <div className="w-80 space-y-3 p-3">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a router, plan or NAP" className="cc-input w-full" autoFocus />
      <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
        <ScopeGroup label="Routers" rows={routerRows} isOn={(k) => filters.routers.includes(routers.find((r) => r.name === k)?.id ?? -1)} onToggle={(k) => {
          const id = routers.find((r) => r.name === k)?.id;
          if (id != null) onChange({ routers: toggle(filters.routers, id) });
        }} />
        <ScopeGroup label="Plans" rows={planRows} isOn={(k) => filters.plans.includes(k)} onToggle={(k) => onChange({ plans: toggle(filters.plans, k) })} />
        <ScopeGroup label="NAP boxes" rows={napRows.slice(0, 40)} isOn={(k) => filters.naps.includes(k)} onToggle={(k) => onChange({ naps: toggle(filters.naps, k) })} />
      </div>
    </div>
  );
}

function ScopeGroup({ label, rows, isOn, onToggle }: { label: string; rows: Segment[]; isOn: (k: string) => boolean; onToggle: (k: string) => void }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <p className="cc-label">{label}</p>
      {rows.map((r) => (
        <label key={r.key} className="cc-check">
          <input type="checkbox" checked={isOn(r.key)} onChange={() => onToggle(r.key)} />
          <span className="flex-1 truncate">{r.label}</span>
          <span className="text-[11px] tabular-nums opacity-55">{r.count}</span>
        </label>
      ))}
    </div>
  );
}

function Drawer({ sub, today, onClose, onCopy, onOpen }: { sub: CcSubscriber | null; today: string; onClose: () => void; onCopy: (s: CcSubscriber) => void; onOpen: (s: CcSubscriber) => void }) {
  if (!sub) return null;
  const facts: [string, string][] = [
    ['Account', sub.account],
    ['Username', sub.user],
    ['Plan', `${sub.plan} \u00b7 ${money(sub.price)}/mo`],
    ['Router', sub.router],
    ['NAP', sub.nap || '\u2014'],
    ['Status', `${sub.state}${sub.state === 'active' ? (sub.online ? ', online' : ', offline') : ''}`],
    ['Due', sub.due ? `${shortDay(sub.due)} \u00b7 ${dueText(sub)}` : 'No due date'],
    ['Paid this month', sub.paidMonth ? money(sub.paidMonth) : 'Nothing yet'],
    ['Last payment', sub.lastPaid ? shortDay(sub.lastPaid) : 'None in 90 days'],
    ['Late in 90 days', String(sub.late90)],
    ['Open balance', money(sub.balance)],
  ];
  return (
    <aside className="cc-drawer" aria-label={`Subscriber ${sub.name}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-[0.16em] opacity-55">{today ? `As of ${shortDay(today)}` : 'Subscriber'}</p>
          <h3 className="truncate text-lg font-semibold">{sub.name}</h3>
        </div>
        <button type="button" className="cc-icon" onClick={onClose} aria-label="Close"><X size={15} /></button>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <span className="cc-risk-big" style={{ color: TONE_VAR[riskTone(sub.risk)] }}>{sub.risk}</span>
        <div className="flex flex-wrap gap-1">
          {sub.flags.length ? sub.flags.map((f) => <FlagPill key={f} flag={f} />) : <span className="text-xs opacity-60">No risk flags</span>}
        </div>
      </div>
      <dl className="mt-4 divide-y text-sm" style={{ borderColor: 'var(--card-border)' }}>
        {facts.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4 py-1.5" style={{ borderColor: 'var(--card-border)' }}>
            <dt className="opacity-60">{k}</dt>
            <dd className="text-right font-medium">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-5 grid gap-2">
        <Link className="cc-btn is-on justify-center" to={`/pppoe?q=${encodeURIComponent(sub.user)}`} onClick={() => onOpen(sub)}>
          <ExternalLink size={14} /> Open in subscribers
        </Link>
        <button type="button" className="cc-btn justify-center" onClick={() => onCopy(sub)}>
          <Copy size={14} /> Copy a reminder message
        </button>
      </div>
    </aside>
  );
}
