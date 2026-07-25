import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

export type TrafficPoint = { t: string; label: string; downloadBps: number; uploadBps: number };

export type LiveService = {
  id: string;
  name: string;
  category: string;
  hits: number;
  destinations: string[];
};

export type LiveTrafficState = {
  downloadBps: number;
  uploadBps: number;
  online: boolean;
  address: string | null;
  uptime: string | null;
};

function applyDetailPayload(
  d: any,
  opts: { silent?: boolean },
  setters: {
    setHistory: (h: any[]) => void;
    setTrafficSeries: (fn: TrafficPoint[] | ((prev: TrafficPoint[]) => TrafficPoint[])) => void;
    setLiveServices: (s: LiveService[]) => void;
    setServicesNote: (n: string) => void;
    setLive: (l: LiveTrafficState | null) => void;
  }
) {
  const { setHistory, setTrafficSeries, setLiveServices, setServicesNote, setLive } = setters;
  if (!opts?.silent) {
    setHistory(d.history || []);
    const samples: TrafficPoint[] = (d.samples || []).map((s: any) => ({
      t: s.t,
      label: s.label || String(s.t || '').slice(11, 16),
      downloadBps: Number(s.downloadBps) || 0,
      uploadBps: Number(s.uploadBps) || 0,
    }));
    if (d.live && samples.length === 0) {
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
  } else if (d.live) {
    const nowIso = new Date().toISOString();
    const nowLabel = nowIso.slice(11, 19);
    setTrafficSeries((prev) => {
      const point: TrafficPoint = {
        t: nowIso,
        label: nowLabel,
        downloadBps: Number(d.live.downloadBps) || 0,
        uploadBps: Number(d.live.uploadBps) || 0,
      };
      const next = prev.length
        ? [...prev, point]
        : [
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
    if (Array.isArray(d.services)) setLiveServices(d.services);
    if (d.servicesNote != null) setServicesNote(d.servicesNote);
    if (Array.isArray(d.history) && d.history.length) setHistory(d.history);
  }
  setLive(d.live || null);
}

export function useLiveTrafficDetail(username: string | null, routerId?: number, enabled = true) {
  const [history, setHistory] = useState<any[]>([]);
  const [trafficSeries, setTrafficSeries] = useState<TrafficPoint[]>([]);
  const [liveServices, setLiveServices] = useState<LiveService[]>([]);
  const [servicesNote, setServicesNote] = useState('');
  const [live, setLive] = useState<LiveTrafficState | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [errorNote, setErrorNote] = useState('');

  const setters = { setHistory, setTrafficSeries, setLiveServices, setServicesNote, setLive };

  const reset = useCallback(() => {
    setHistory([]);
    setTrafficSeries([]);
    setLiveServices([]);
    setServicesNote('');
    setLive(null);
    setErrorNote('');
  }, []);

  const loadDetail = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!username || !enabled) return;
      if (!opts?.silent) setDetailBusy(true);
      try {
        const r = await api.get('/usage/detail', {
          params: { username, days: 30, hours: 6, ...(routerId ? { routerId } : {}) },
        });
        setErrorNote('');
        applyDetailPayload(r.data, opts || {}, setters);
      } catch {
        if (!opts?.silent) {
          reset();
          setErrorNote('Could not load user detail.');
        }
      } finally {
        if (!opts?.silent) setDetailBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [username, routerId, enabled]
  );

  useEffect(() => {
    if (!username || !enabled) {
      reset();
      return;
    }
    reset();
    void loadDetail();
  }, [username, routerId, enabled, loadDetail, reset]);

  useEffect(() => {
    if (!username || !enabled) return;
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
        await loadDetail({ silent: true });
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
  }, [username, routerId, enabled, loadDetail]);

  return {
    history,
    trafficSeries,
    liveServices,
    servicesNote: errorNote || servicesNote,
    live,
    detailBusy,
    reload: loadDetail,
  };
}
