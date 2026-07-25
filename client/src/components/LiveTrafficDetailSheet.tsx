import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, Globe2, RefreshCw, X } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { isNativeApp } from '../config';
import { formatBps } from '../lib/traffic';
import { registerNativeSheet } from '../lib/nativeShell';
import { useLiveTrafficDetail } from '../hooks/useLiveTrafficDetail';

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

export type LiveTrafficDetailSheetProps = {
  open: boolean;
  username: string;
  customer?: string | null;
  routerId?: number;
  /** Seed rates before first API response (e.g. from active session row). */
  seedDownloadBps?: number;
  seedUploadBps?: number;
  onClose: () => void;
};

export default function LiveTrafficDetailSheet({
  open,
  username,
  customer,
  routerId,
  seedDownloadBps = 0,
  seedUploadBps = 0,
  onClose,
}: LiveTrafficDetailSheetProps) {
  const { history, trafficSeries, liveServices, servicesNote, live, detailBusy } = useLiveTrafficDetail(
    open ? username : null,
    routerId,
    open
  );
  const [useCompact, setUseCompact] = useState(() =>
    typeof window !== 'undefined' && (isNativeApp() || !window.matchMedia('(min-width: 1024px)').matches)
  );

  useEffect(() => {
    if (!open) return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const sync = () => setUseCompact(isNativeApp() || !mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [open]);

  useEffect(() => {
    registerNativeSheet(open, onClose);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open || !username) return null;

  const downloadBps = live?.downloadBps ?? seedDownloadBps;
  const uploadBps = live?.uploadBps ?? seedUploadBps;
  const maxLiveHits = Math.max(1, ...liveServices.map((s) => Number(s.hits) || 0));

  const panelBody = (
    <div className="space-y-4">
      {customer && <div className="text-xs text-slate-500 -mt-2">{customer}</div>}

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span
          className={`px-2 py-0.5 rounded-full font-medium ${
            live?.online ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-200 text-slate-600'
          }`}
        >
          {live?.online ? 'Online' : 'Offline'}
        </span>
        {live?.address && <span className="font-mono text-slate-600">{live.address}</span>}
        {live?.uptime && <span className="text-slate-400">up {live.uptime}</span>}
        {detailBusy && <RefreshCw size={12} className="animate-spin text-slate-400" />}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">Download</div>
          <div className="text-sm font-bold text-emerald-700">{formatBps(downloadBps)}</div>
        </div>
        <div className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-slate-400">Upload</div>
          <div className="text-sm font-bold text-sky-700">{formatBps(uploadBps)}</div>
        </div>
      </div>

      <div>
        <div className="text-xs font-semibold text-slate-700 mb-2 flex items-center gap-2">
          Traffic
          <span className="font-normal text-slate-400">download / upload · live</span>
        </div>
        <div className="h-52 w-full min-w-0 rounded-lg bg-slate-50 border border-slate-100 px-1 pt-2">
          {trafficSeries.length > 1 ? (
            <ResponsiveContainer width="100%" height="100%" minWidth={1}>
              <AreaChart data={trafficSeries} margin={{ top: 4, right: 6, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="liveDl" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#059669" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#059669" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="liveUl" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#0284c7" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#0284c7" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: '#94a3b8' }} interval="preserveStartEnd" minTickGap={24} />
                <YAxis tickFormatter={fmtAxis} tick={{ fontSize: 9, fill: '#94a3b8' }} width={36} />
                <Tooltip
                  formatter={(v: number, name: string) => [
                    formatBps(Number(v) || 0),
                    name === 'downloadBps' ? 'Download' : 'Upload',
                  ]}
                  labelFormatter={(l) => String(l)}
                  contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }}
                />
                <Area type="monotone" dataKey="downloadBps" stroke="#059669" fill="url(#liveDl)" strokeWidth={1.5} isAnimationActive={false} />
                <Area type="monotone" dataKey="uploadBps" stroke="#0284c7" fill="url(#liveUl)" strokeWidth={1.5} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex items-center justify-center text-xs text-slate-400 px-3 text-center">
              {detailBusy ? 'Loading traffic…' : 'Collecting samples — keep the session online.'}
            </div>
          )}
        </div>
      </div>

      <div>
        <div className="text-xs font-semibold text-slate-700 mb-2 flex items-center gap-2">
          <Globe2 size={13} /> Internet services in use
        </div>
        {servicesNote && <div className="text-[11px] text-slate-400 mb-2">{servicesNote}</div>}
        <div className="space-y-1.5 max-h-40 overflow-auto">
          {liveServices.map((s) => {
            const pct = Math.max(6, (Number(s.hits) / maxLiveHits) * 100);
            return (
              <div key={s.id} className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2" title={s.destinations?.join(', ') || undefined}>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-800 truncate">{s.name}</div>
                    <div className="text-[10px] text-slate-400">{s.category}</div>
                  </div>
                  <span className="text-xs font-semibold text-slate-600 shrink-0">{s.hits}</span>
                </div>
                <div className="mt-1.5 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                  <div className="h-full rounded-full bg-brand-500" style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
          {liveServices.length === 0 && !detailBusy && (
            <div className="text-xs text-slate-400">No service breakdown yet for this session.</div>
          )}
        </div>
      </div>

      {history.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-slate-700 mb-2">Daily totals</div>
          <div className="space-y-1 max-h-32 overflow-auto text-xs">
            {history.map((h) => (
              <div key={h.day} className="flex justify-between gap-2 border-b border-slate-100 py-1">
                <span className="font-medium text-slate-700">{h.day}</span>
                <span className="text-emerald-700">{formatBytes(h.rxBytes)} ↓</span>
                <span className="text-sky-700">{formatBytes(h.txBytes)} ↑</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const header = (
    <div className="flex items-center gap-2 font-semibold text-slate-800 mb-3 shrink-0">
      <Activity size={16} />
      <span className="truncate flex-1">{username}</span>
      <button
        type="button"
        className="p-1 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
        title="Close"
        onClick={onClose}
        aria-label="Close"
      >
        <X size={14} />
      </button>
    </div>
  );

  if (useCompact) {
    return createPortal(
      <div className="fixed inset-0 z-[2000] flex flex-col justify-end" role="presentation">
        <button type="button" className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm animate-fade-in" aria-label="Close" onClick={onClose} />
        <aside
          className="relative z-[1] w-full max-h-[min(88dvh,640px)] overflow-y-auto rounded-t-2xl border border-slate-200 bg-white shadow-2xl p-4 pb-[max(1rem,calc(env(safe-area-inset-bottom)+3.75rem))] animate-scale-in"
          role="dialog"
          aria-label={`Live traffic for ${username}`}
        >
          {header}
          {panelBody}
        </aside>
      </div>,
      document.body
    );
  }

  return createPortal(
    <div className="fixed inset-0 z-[2000] pointer-events-none" role="presentation">
      <button
        type="button"
        className="pointer-events-auto absolute inset-0 bg-slate-900/20"
        aria-label="Close"
        onClick={onClose}
      />
      <aside
        className="usage-detail-panel pointer-events-auto fixed right-5 top-1/2 -translate-y-1/2 w-[min(460px,calc(100vw-2.5rem))] max-h-[88vh] overflow-y-auto rounded-2xl border border-slate-200 bg-white/95 backdrop-blur-sm shadow-2xl p-5"
        role="dialog"
        aria-label={`Live traffic for ${username}`}
      >
        {header}
        {panelBody}
      </aside>
    </div>,
    document.body
  );
}
