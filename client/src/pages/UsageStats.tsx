import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, Globe2, RefreshCw, Users, X } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import Layout from '../components/Layout';
import LiveTrafficDetailSheet from '../components/LiveTrafficDetailSheet';
import { Card, TabBar, Toolbar, DataTable } from '../components/ui';
import { api } from '../api';
import { formatBps } from '../lib/traffic';
import { useRouterDevice } from '../context/RouterContext';

function formatBytes(n: number): string {
  const v = Number(n) || 0;
  if (v >= 1e12) return `${(v / 1e12).toFixed(2)} TB`;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} GB`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} MB`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)} KB`;
  return `${Math.round(v)} B`;
}

function fmtAxis(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(0)}M`;
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(0)}k`;
  return `${Math.round(bps)}`;
}

const TABS = [
  { key: 'users', label: 'Per User', icon: Users },
  { key: 'services', label: 'Websites & Platforms', icon: Globe2 },
];

type TrafficPoint = { t: string; label: string; downloadBps: number; uploadBps: number };
type LiveService = {
  id: string;
  name: string;
  category: string;
  hits: number;
  destinations: string[];
};

export default function UsageStats() {
  const { current } = useRouterDevice();
  const [tab, setTab] = useState('users');
  const [days, setDays] = useState(7);
  const [users, setUsers] = useState<any[]>([]);
  const [services, setServices] = useState<any[]>([]);
  const [note, setNote] = useState('');
  const [sampleCount, setSampleCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<any | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [trafficSeries, setTrafficSeries] = useState<TrafficPoint[]>([]);
  const [liveServices, setLiveServices] = useState<LiveService[]>([]);
  const [live, setLive] = useState<{
    downloadBps: number;
    uploadBps: number;
    online: boolean;
    address: string | null;
    uptime: string | null;
  } | null>(null);
  const [servicesNote, setServicesNote] = useState('');
  const [detailBusy, setDetailBusy] = useState(false);
  const [toast, setToast] = useState('');
  const panelSlotRef = useRef<HTMLDivElement>(null);
  /** Horizontal box for the floating panel — vertical stays viewport-centered so it remains visible while scrolling. */
  const [panelBox, setPanelBox] = useState<{ left: number; width: number; anchored: boolean } | null>(null);

  const closeDetail = () => {
    setSelected(null);
    setHistory([]);
    setTrafficSeries([]);
    setLiveServices([]);
    setLive(null);
  };

  // Keep the floating panel aligned to the table’s right slot (inside the card), while staying
  // vertically centered in the viewport so it remains visible as the page scrolls.
  useEffect(() => {
    if (!selected || tab !== 'users') {
      setPanelBox(null);
      return;
    }

    const sync = () => {
      const slot = panelSlotRef.current;
      const wide = window.matchMedia('(min-width: 1024px)').matches;
      if (wide && slot) {
        const r = slot.getBoundingClientRect();
        if (r.width > 40) {
          setPanelBox({ left: r.left, width: r.width, anchored: true });
          return;
        }
      }
      setPanelBox({ left: 0, width: 0, anchored: false });
    };

    sync();
    const t1 = window.setTimeout(sync, 50);
    const t2 = window.setTimeout(sync, 350); // after table shrink transition
    window.addEventListener('resize', sync);
    const ro = new ResizeObserver(sync);
    if (panelSlotRef.current) ro.observe(panelSlotRef.current);
    const split = panelSlotRef.current?.parentElement;
    if (split) ro.observe(split);

    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.removeEventListener('resize', sync);
      ro.disconnect();
    };
  }, [selected, tab, users.length]);

  const load = () => {
    setBusy(true);
    api
      .get('/usage/summary', { params: { days, ...(current?.id ? { routerId: current.id } : {}) } })
      .then((r) => {
        setUsers(r.data.users || []);
        setServices(r.data.services || []);
        setNote(r.data.note || '');
        setSampleCount(Number(r.data.sampleCount) || 0);
      })
      .catch(() => {
        setUsers([]);
        setServices([]);
      })
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    setSelected(null);
    setHistory([]);
    setTrafficSeries([]);
    setLiveServices([]);
    setLive(null);
    load();
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 30_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, current?.id]);

  const applyDetail = (d: any, opts?: { silent?: boolean }) => {
    if (!opts?.silent) {
      setHistory(d.history || []);
      const samples: TrafficPoint[] = (d.samples || []).map((s: any) => ({
        t: s.t,
        label: s.label || String(s.t || '').slice(11, 16),
        downloadBps: Number(s.downloadBps) || 0,
        uploadBps: Number(s.uploadBps) || 0,
      }));
      if (d.live && (d.live.downloadBps || d.live.uploadBps || d.live.online)) {
        const nowLabel = new Date().toISOString().slice(11, 19);
        samples.push({
          t: new Date().toISOString(),
          label: nowLabel,
          downloadBps: Number(d.live.downloadBps) || 0,
          uploadBps: Number(d.live.uploadBps) || 0,
        });
      }
      setTrafficSeries(samples.slice(-120));
      setLiveServices(d.services || []);
      setServicesNote(d.servicesNote || '');
    } else {
      // 1s silent polls: update live rates + append graph point; refresh services occasionally via full samples.
      if (Array.isArray(d.samples) && d.samples.length) {
        /* keep stored history samples as baseline on first silent after open — handled by initial load */
      }
      if (d.live) {
        const nowIso = new Date().toISOString();
        const nowLabel = nowIso.slice(11, 19);
        setTrafficSeries((prev) => {
          const point: TrafficPoint = {
            t: nowIso,
            label: nowLabel,
            downloadBps: Number(d.live.downloadBps) || 0,
            uploadBps: Number(d.live.uploadBps) || 0,
          };
          const next = prev.length ? [...prev, point] : [
            ...(d.samples || []).map((s: any) => ({
              t: s.t,
              label: s.label || String(s.t || '').slice(11, 16),
              downloadBps: Number(s.downloadBps) || 0,
              uploadBps: Number(s.uploadBps) || 0,
            })),
            point,
          ];
          return next.slice(-120);
        });
      }
      if (Array.isArray(d.services)) setLiveServices(d.services);
      if (d.servicesNote != null) setServicesNote(d.servicesNote);
      if (Array.isArray(d.history) && d.history.length) setHistory(d.history);
    }
    setLive(d.live || null);
  };

  const loadDetail = async (username: string, opts?: { silent?: boolean }) => {
    if (!opts?.silent) setDetailBusy(true);
    try {
      const r = await api.get('/usage/detail', {
        params: { username, days: 30, hours: 6, ...(current?.id ? { routerId: current.id } : {}) },
      });
      applyDetail(r.data, opts);
    } catch {
      if (!opts?.silent) {
        setHistory([]);
        setTrafficSeries([]);
        setLiveServices([]);
        setLive(null);
        setServicesNote('Could not load user detail.');
      }
    } finally {
      if (!opts?.silent) setDetailBusy(false);
    }
  };

  const openUser = (u: any) => {
    setSelected(u);
    setHistory([]);
    setTrafficSeries([]);
    setLiveServices([]);
    setLive(null);
    setServicesNote('');
  };

  /* Detail polling + chart UI moved to LiveTrafficDetailSheet (mobile-safe bottom sheet). */
  const _legacyDetailPollingDisabled = true;
  useEffect(() => {
    if (_legacyDetailPollingDisabled) return;
    if (!selected?.username || tab !== 'users') return;
    let cancelled = false;
    let timer: number | null = null;
    let inFlight = false;

    const clearTimer = () => {
      if (timer != null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const schedule = () => {
      clearTimer();
      if (cancelled || document.visibilityState !== 'visible') return;
      timer = window.setTimeout(tick, 1000);
    };

    const tick = async () => {
      if (cancelled || document.visibilityState !== 'visible' || inFlight) {
        if (!cancelled && document.visibilityState === 'visible' && inFlight) schedule();
        return;
      }
      inFlight = true;
      try {
        await loadDetail(selected.username, { silent: true });
      } finally {
        inFlight = false;
        if (!cancelled && document.visibilityState === 'visible') schedule();
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void tick();
      else clearTimer();
    };

    document.addEventListener('visibilitychange', onVisibility);
    void tick();
    return () => {
      cancelled = true;
      clearTimer();
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.username, tab, current?.id]);

  const poll = async () => {
    setBusy(true);
    setToast('');
    try {
      const r = await api.post('/usage/poll', current?.id ? { routerId: current.id } : {});
      const d = r.data || {};
      setToast(
        `Sampled ${d.samples || 0} online session(s)` +
          (d.bytesDelta != null ? ` · +${formatBytes(d.bytesDelta)} since last poll` : '')
      );
      load();
    } catch (e: any) {
      setToast(e?.response?.data?.error || 'Sample failed — check router API credentials');
    } finally {
      setBusy(false);
    }
  };

  const maxServiceHits = Math.max(1, ...services.map((s) => Number(s.hits) || 0));
  const maxLiveHits = Math.max(1, ...liveServices.map((s) => Number(s.hits) || 0));

  const userColumns = useMemo(
    () => [
      { key: 'subscriber', label: 'Subscriber' },
      { key: 'plan', label: 'Plan' },
      { key: 'download', label: 'Download', align: 'right' as const },
      { key: 'upload', label: 'Upload', align: 'right' as const },
      { key: 'peak', label: 'Peak ↓', align: 'right' as const },
    ],
    []
  );

  const userRows = useMemo(
    () =>
      users.map((u) => {
        const active = selected?.username === u.username;
        return {
          key: u.username,
          sortValues: {
            subscriber: `${u.username} ${u.customer || ''}`,
            plan: u.profile || '',
            download: Number(u.rxBytes) || 0,
            upload: Number(u.txBytes) || 0,
            peak: Number(u.peakRxBps) || 0,
          },
          cells: [
            <button
              type="button"
              key="sub"
              className={`usage-user-btn ${active ? 'is-selected' : ''}`}
              onClick={() => openUser(u)}
            >
              <div className="usage-user-name font-semibold text-slate-800">{u.username}</div>
              <div className="text-xs text-slate-400">{u.customer}</div>
            </button>,
            <span key="plan" className="text-slate-600">
              {u.profile || '—'}
            </span>,
            <span key="dl" className="font-medium text-emerald-700">
              {formatBytes(u.rxBytes)}
            </span>,
            <span key="ul" className="font-medium text-sky-700">
              {formatBytes(u.txBytes)}
            </span>,
            <span key="peak" className="text-xs text-slate-500">
              {formatBps(u.peakRxBps)}
            </span>,
          ],
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [users, selected?.username]
  );

  const serviceColumns = useMemo(
    () => [
      { key: 'name', label: 'Platform' },
      { key: 'category', label: 'Category' },
      { key: 'hits', label: 'DNS hits', align: 'right' as const },
      { key: 'share', label: 'Share', align: 'right' as const, sortable: false },
    ],
    []
  );

  const serviceRows = useMemo(
    () =>
      services.map((s) => {
        const hits = Number(s.hits) || 0;
        const pct = Math.max(4, (hits / maxServiceHits) * 100);
        return {
          key: s.id,
          sortValues: {
            name: s.name || '',
            category: s.category || '',
            hits,
          },
          cells: [
            <span key="n" className="font-semibold text-slate-800">
              {s.name}
            </span>,
            <span key="c" className="text-xs text-slate-500">
              {s.category}
            </span>,
            <span key="h" className="font-semibold text-slate-700">
              {hits}
            </span>,
            <div key="bar" className="min-w-[100px] h-2.5 rounded-full bg-slate-100 overflow-hidden ml-auto">
              <div className="h-full rounded-full bg-brand-500" style={{ width: `${pct}%` }} />
            </div>,
          ],
        };
      }),
    [services, maxServiceHits]
  );

  return (
    <Layout title="Usage Statistics">
      {toast && (
        <div className="mb-4 text-sm text-slate-700 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">{toast}</div>
      )}
      <Card noPadding interactive className="overflow-hidden">
        <TabBar tabs={TABS} active={tab} onChange={setTab} className="px-2" />
        <Toolbar
          left={
            <div className="text-sm text-slate-500">
              Live MikroTik byte counters (deltas)
              {current ? ` · ${current.name}` : ''}
              {' · last '}
              <select
                className="input py-1 text-xs inline-block w-auto ml-1"
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              >
                <option value={1}>1 day</option>
                <option value={7}>7 days</option>
                <option value={30}>30 days</option>
              </select>
              {sampleCount > 0 && (
                <span className="ml-2 text-xs text-slate-400">{sampleCount} samples (24h)</span>
              )}
            </div>
          }
          right={
            <button type="button" className="btn-secondary" onClick={poll} disabled={busy}>
              <RefreshCw size={16} className={busy ? 'animate-spin' : ''} /> Sample now
            </button>
          }
        />

        {tab === 'users' && (
          <div className="p-4 pt-0">
            <p className="text-xs text-slate-400 mb-3">
              {note ||
                'Download/Upload totals are real traffic measured from each subscriber’s <pppoe-*> interface since sampling started. First sample sets a baseline; usage accumulates after that.'}{' '}
              Click a subscriber for live traffic graph and services.
            </p>
            <DataTable
              columns={userColumns}
              rows={userRows}
              emptyMessage="No usage yet. Online PPPoE sessions are sampled every minute — click Sample now while clients are connected."
            />
          </div>
        )}

        {tab === 'services' && (
          <div className="p-4 pt-0 space-y-3">
            <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
              This tab is a <b>DNS cache / connection popularity snapshot</b> from MikroTik — not exact bytes per website.
              Click <b>Sample now</b> to refresh. For per-subscriber live services, open a user under <b>Per User</b>.
            </div>
            <DataTable
              columns={serviceColumns}
              rows={serviceRows}
              emptyMessage="No platform data yet. Sample now (works even with no PPPoE sessions). Prefer router DNS so the cache fills with real hostnames."
            />
          </div>
        )}
      </Card>

      {selected && tab === 'users' && (
        <LiveTrafficDetailSheet
          open
          username={selected.username}
          customer={selected.customer}
          routerId={current?.id}
          seedDownloadBps={Number(selected.downloadBps) || 0}
          seedUploadBps={Number(selected.uploadBps) || 0}
          onClose={closeDetail}
        />
      )}
    </Layout>
  );
}
