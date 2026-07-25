import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DownloadCloud, RefreshCw, ExternalLink, GitBranch, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import Layout from '../components/Layout';
import { Card, Flash, LoadingPage, PageHeader, Modal } from '../components/ui';
import { api } from '../api';
import { getApiBase } from '../config';

type Phase = 'idle' | 'updating' | 'success' | 'failed';

const POLL_MS = 2000;
const TIMEOUT_MS = 12 * 60 * 1000;
const STALE_RUNNING_MS = 90_000;
const SESSION_KEY = 'mt_updater_phase';

export default function Updater() {
  const [info, setInfo] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [statusText, setStatusText] = useState('');
  const [result, setResult] = useState<{ title: string; detail: string; from?: string; to?: string } | null>(null);
  const pollRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);
  const targetShaRef = useRef<string | null>(null);
  const fromShaRef = useRef<string | null>(null);
  const seenOfflineRef = useRef(false);
  const healthyTicksRef = useRef(0);

  const stopPoll = () => {
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const clearSession = () => {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
  };

  const load = () =>
    api
      .get('/updater')
      .then((r) => setInfo(r.data))
      .catch((e) => setErr(e?.response?.data?.error || 'Could not load updater status'));

  useEffect(() => {
    load();
    // Recover if a previous tab refresh left a stale overlay intent
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved?.phase === 'updating' && saved?.startedAt) {
          const age = Date.now() - Number(saved.startedAt);
          if (age < TIMEOUT_MS) {
            fromShaRef.current = saved.fromSha || null;
            targetShaRef.current = saved.targetSha || null;
            startedAtRef.current = Number(saved.startedAt);
            setPhase('updating');
            setBusy(true);
            setStatusText('Resuming update watch…');
            // startPolling defined below — call after mount via timeout
            setTimeout(() => startPolling(true), 0);
          } else {
            clearSession();
          }
        }
      }
    } catch {
      clearSession();
    }
    return () => stopPoll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase !== 'updating') return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const block = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', block);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('beforeunload', block);
    };
  }, [phase]);

  const short = (sha?: string | null) => (sha ? String(sha).slice(0, 7) : '—');

  const finishSuccess = (detail: string, from?: string | null, to?: string | null) => {
    stopPoll();
    clearSession();
    setPhase('success');
    setBusy(false);
    setResult({
      title: 'Update complete',
      detail,
      from: from || fromShaRef.current || undefined,
      to: to || targetShaRef.current || undefined,
    });
    load();
  };

  const finishFailed = (detail: string) => {
    stopPoll();
    clearSession();
    setPhase('failed');
    setBusy(false);
    setResult({
      title: 'Update failed',
      detail,
      from: fromShaRef.current || undefined,
      to: targetShaRef.current || undefined,
    });
    load();
  };

  const dismissOverlay = () => {
    stopPoll();
    clearSession();
    setPhase('idle');
    setBusy(false);
    setStatusText('');
    setMsg('Updater overlay closed. Refresh if the panel was already updated.');
    load();
  };

  const startPolling = (resuming = false) => {
    stopPoll();
    if (!resuming) {
      startedAtRef.current = Date.now();
      seenOfflineRef.current = false;
      healthyTicksRef.current = 0;
    }
    setStatusText(resuming ? 'Checking whether the update finished…' : 'Update started. Waiting for the panel to restart…');

    try {
      sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify({
          phase: 'updating',
          startedAt: startedAtRef.current,
          fromSha: fromShaRef.current,
          targetSha: targetShaRef.current,
        })
      );
    } catch {
      /* ignore */
    }

    const tick = async () => {
      if (Date.now() - startedAtRef.current > TIMEOUT_MS) {
        finishFailed('Update timed out. On the LXC run: curl -fsSL https://raw.githubusercontent.com/tsogs66/MT-Billing/main/install/mt-billing-fix-now.sh | sudo bash');
        return;
      }

      try {
        // Prefer authenticated job status; bare /api/health is public but may 404 on old builds.
        const token = localStorage.getItem('mt_token');
        const health = await fetch(`${getApiBase()}/health`, {
          cache: 'no-store',
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (!health.ok) throw new Error('health');
      } catch {
        // Fall back: if authenticated updater responds, API is up even if /health is old/auth-gated
        try {
          await api.get('/updater/job', { timeout: 4000 });
        } catch {
          seenOfflineRef.current = true;
          healthyTicksRef.current = 0;
          setStatusText('Panel offline while updating — rebuilding and restarting services…');
          return;
        }
      }

      healthyTicksRef.current += 1;

      try {
        const r = await api.get('/updater');
        const data = r.data;
        setInfo(data);
        const job = data.job;
        const current = data.currentSha ? String(data.currentSha).toLowerCase() : '';
        const target = targetShaRef.current ? String(targetShaRef.current).toLowerCase() : '';
        const reachedTarget = !!(target && current && current === target);
        const upToDate = data.updateAvailable === false && !!current;
        const elapsed = Date.now() - startedAtRef.current;
        const jobStatus = String(job?.status || '');

        // Success: SHA matches, or job says updated/current, or panel is healthy + up to date
        // after we saw downtime (or after enough time for a no-restart local update).
        if (jobStatus === 'updated' || jobStatus === 'current') {
          finishSuccess(
            job?.message || `Panel is now on ${short(job?.to || data.currentSha)}.`,
            job?.from,
            job?.to || data.currentSha
          );
          return;
        }

        if (reachedTarget || (upToDate && (seenOfflineRef.current || elapsed > 20_000) && healthyTicksRef.current >= 2)) {
          finishSuccess(
            `Panel is now on ${short(data.currentSha)}. You can continue using the panel.`,
            fromShaRef.current,
            data.currentSha
          );
          return;
        }

        if (jobStatus === 'failed') {
          finishFailed(job?.message || 'Update failed. See server logs for details.');
          return;
        }

        // Stale "running" while API is healthy and code already matches → treat as done
        if (jobStatus === 'running' && (reachedTarget || upToDate) && elapsed > STALE_RUNNING_MS) {
          finishSuccess(
            'Update finished (cleared a stuck “running” status). Panel is up to date.',
            job?.from || fromShaRef.current,
            data.currentSha
          );
          return;
        }

        if (jobStatus === 'running') {
          setStatusText(job?.message || 'Update in progress…');
          return;
        }

        setStatusText(
          seenOfflineRef.current
            ? 'Panel is back — verifying version…'
            : 'Waiting for rebuild to finish…'
        );
      } catch {
        setStatusText('Waiting for API to come back online…');
      }
    };

    void tick();
    pollRef.current = window.setInterval(() => {
      void tick();
    }, POLL_MS);
  };

  const check = async () => {
    if (phase === 'updating') return;
    setBusy(true);
    setMsg('');
    setErr('');
    try {
      await api.post('/updater/check');
      await load();
      setMsg('Checked GitHub for updates.');
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'Check failed');
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (phase === 'updating') return;
    if (!confirm('Pull the latest code from GitHub and restart the panel?\n\nDo not close or navigate away until the update finishes.')) return;
    setBusy(true);
    setMsg('');
    setErr('');
    setResult(null);
    fromShaRef.current = info?.currentSha || null;
    targetShaRef.current = info?.latestSha || null;
    setPhase('updating');
    setStatusText('Starting update…');
    seenOfflineRef.current = false;
    healthyTicksRef.current = 0;

    try {
      const r = await api.post('/updater/apply');
      if (r.data.fromSha) fromShaRef.current = r.data.fromSha;
      if (r.data.targetSha) targetShaRef.current = r.data.targetSha;
      setStatusText(r.data.message || 'Update started…');
      startPolling(false);
    } catch (e: any) {
      clearSession();
      setPhase('idle');
      setBusy(false);
      setErr(e?.response?.data?.message || e?.response?.data?.error || 'Update failed');
    }
  };

  const dismissResult = () => {
    setPhase('idle');
    setResult(null);
    setStatusText('');
    setMsg(result?.title === 'Update complete' ? 'Panel updated successfully.' : '');
  };

  if (!info && !err) return <Layout title="Updater"><LoadingPage /></Layout>;

  return (
    <Layout title="Updater">
      <PageHeader title="Application Updater" description="Pull updates from the official GitHub repository." icon={DownloadCloud} />
      <Flash message={msg} type="success" onDismiss={() => setMsg('')} />
      {err && <Flash message={err} type="error" onDismiss={() => setErr('')} />}

      <Card className="max-w-3xl" interactive>
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center">
            <DownloadCloud size={22} />
          </div>
          <div className="min-w-0">
            <div className="font-bold text-slate-800">Panel {info?.current || '—'}</div>
            <div className="text-sm text-slate-500">
              Latest on GitHub: <span className="font-semibold text-slate-700">{info?.latest || '—'}</span>
            </div>
          </div>
          <div className="ml-auto shrink-0">
            {info?.updateAvailable ? (
              <span className="badge bg-amber-100 text-amber-700 ring-1 ring-amber-200/60">Update available</span>
            ) : (
              <span className="badge bg-emerald-100 text-emerald-700 ring-1 ring-emerald-200/60">Up to date</span>
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-3 text-xs text-slate-500">
          <a
            href={info?.repo || 'https://github.com/tsogs66/MT-Billing'}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-brand-700 hover:underline font-medium"
          >
            <ExternalLink size={12} /> {info?.repo || 'https://github.com/tsogs66/MT-Billing'}
          </a>
          <span className="inline-flex items-center gap-1">
            <GitBranch size={12} /> branch <b className="text-slate-700">{info?.branch || 'main'}</b>
          </span>
        </div>

        {info?.error && (
          <div className="mt-4 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">{info.error}</div>
        )}

        <div className="mt-6 rounded-xl bg-slate-50 border border-slate-100 p-4">
          <div className="text-sm font-semibold text-slate-700 mb-2">
            {info?.updateAvailable ? `Commits waiting on ${info?.branch || 'main'}` : 'Status'}
          </div>
          <ul className="list-disc pl-5 text-sm text-slate-600 space-y-1">
            {(info?.changelog || []).map((c: string, i: number) => (
              <li key={i}>{c}</li>
            ))}
            {!(info?.changelog || []).length && <li className="text-slate-400">No changelog entries.</li>}
          </ul>
        </div>

        <div className="mt-5 flex items-center gap-2 flex-wrap">
          <button type="button" className="btn-secondary" onClick={check} disabled={busy || phase === 'updating'}>
            <RefreshCw size={15} className={busy && phase !== 'updating' ? 'animate-spin' : ''} /> Check for updates
          </button>
          <button type="button" className="btn-primary" onClick={apply} disabled={busy || phase === 'updating' || !info?.updateAvailable}>
            <DownloadCloud size={16} /> Update from GitHub
          </button>
        </div>

        {info?.applyHint && (
          <div className="mt-5 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
            <div className="font-semibold text-slate-800 mb-1">If Update from GitHub fails</div>
            <p className="text-xs text-slate-500 mb-2 leading-relaxed whitespace-pre-wrap">{info.applyHint}</p>
            <code className="block text-[11px] leading-relaxed font-mono bg-white border border-slate-200 rounded-lg px-3 py-2 overflow-x-auto select-all">
              curl -fsSL https://raw.githubusercontent.com/tsogs66/MT-Billing/main/install/mt-billing-fix-now.sh | sudo bash
            </code>
            <p className="text-xs text-slate-500 mt-2">
              Run once on the Pi or LXC as root. After that, Update from GitHub works from this page without SSH.
            </p>
          </div>
        )}

        <div className="text-xs text-slate-400 mt-3">
          Last checked: {info?.lastChecked ? new Date(info.lastChecked).toLocaleString() : '—'}
          {info?.currentSha && info?.latestSha ? (
            <>
              {' · '}
              <span className="font-mono">{String(info.currentSha).slice(0, 7)}</span>
              {' → '}
              <span className="font-mono">{String(info.latestSha).slice(0, 7)}</span>
            </>
          ) : null}
        </div>
      </Card>

      {phase === 'updating' &&
        createPortal(
          <div
            className="fixed inset-0 z-[3000] bg-slate-950/70 backdrop-blur-sm flex items-center justify-center p-4"
            role="alertdialog"
            aria-modal="true"
            aria-busy="true"
            aria-label="Update in progress"
          >
            <div className="w-full max-w-md rounded-2xl bg-white shadow-2xl border border-slate-200 p-6 text-center">
              <div className="mx-auto w-14 h-14 rounded-2xl bg-brand-50 text-brand-600 flex items-center justify-center mb-4">
                <Loader2 size={28} className="animate-spin" />
              </div>
              <h2 className="text-lg font-bold text-slate-900">Updating panel</h2>
              <p className="text-sm text-slate-500 mt-2 leading-relaxed">{statusText}</p>
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 mt-4">
                Do not close this tab until the update finishes. If this screen is stuck, use Close below.
              </p>
              {(fromShaRef.current || targetShaRef.current) && (
                <p className="text-xs text-slate-400 mt-3 font-mono">
                  {short(fromShaRef.current)} → {short(targetShaRef.current)}
                </p>
              )}
              <button type="button" className="btn-secondary mt-5" onClick={dismissOverlay}>
                Close overlay
              </button>
            </div>
          </div>,
          document.body
        )}

      {(phase === 'success' || phase === 'failed') && result && (
        <Modal
          title={result.title}
          subtitle={phase === 'success' ? 'The panel restarted successfully.' : 'The update did not finish cleanly.'}
          onClose={dismissResult}
          footer={
            <button type="button" className="btn-primary" onClick={dismissResult}>
              OK
            </button>
          }
        >
          <div className="flex items-start gap-3">
            <div
              className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                phase === 'success' ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'
              }`}
            >
              {phase === 'success' ? <CheckCircle2 size={22} /> : <XCircle size={22} />}
            </div>
            <div className="min-w-0">
              <p className="text-sm text-slate-600 leading-relaxed">{result.detail}</p>
              {(result.from || result.to) && (
                <p className="text-xs text-slate-400 mt-3 font-mono">
                  {short(result.from)} → {short(result.to)}
                </p>
              )}
            </div>
          </div>
        </Modal>
      )}
    </Layout>
  );
}
