import { useEffect, useRef, useState } from 'react';
import { Cloud, Copy, ExternalLink, Globe2, Loader2, RefreshCw, Save } from 'lucide-react';
import Layout from '../components/Layout';
import { Card, Flash, FormField, LoadingPage, Progress, StatusBadge } from '../components/ui';
import { api } from '../api';
import { copyTextOrPrompt } from '../lib/clipboard';

type TunnelJob = { action: string; log: string; running: boolean; code: number | null; startedAt: number };

/**
 * Cloudflare Tunnel setup: connector token + public pay-portal / staff URL.
 * Apply heals nginx so the tunnel hostname serves full panel login (not pay-only).
 * Cloudflare Access / Bot Fight on the hostname still blocks POST /api/login at the edge.
 */
export default function CloudflareAccess() {
  const [app, setApp] = useState<any>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState('');
  const [effective, setEffective] = useState<string | null>(null);
  const [source, setSource] = useState('none');
  const [warning, setWarning] = useState<string | null>(null);
  const [cloudflareUrl, setCloudflareUrl] = useState<string | null>(null);
  const [adminLoginUrl, setAdminLoginUrl] = useState('');
  const [tunnelLoginUrl, setTunnelLoginUrl] = useState('');
  const [loginWarning, setLoginWarning] = useState('');
  const [job, setJob] = useState<TunnelJob | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const jobPollRef = useRef<number | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);

  const stopJobPoll = () => {
    if (jobPollRef.current != null) {
      window.clearInterval(jobPollRef.current);
      jobPollRef.current = null;
    }
  };

  useEffect(() => stopJobPoll, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [job?.log]);

  const flash = (m: string) => {
    setBanner(m);
    window.setTimeout(() => setBanner(''), 5000);
  };

  const loadApp = () => api.get('/settings/app').then((r) => setApp(r.data));

  const loadPublic = () =>
    api.get('/payment-links/config').then((r) => {
      setEffective(r.data.effective || null);
      setSource(r.data.source || 'none');
      setWarning(r.data.warning || null);
      setCloudflareUrl(r.data.cloudflareUrl || null);
      if (r.data.lanBaseUrl) setAdminLoginUrl(`${String(r.data.lanBaseUrl).replace(/\/$/, '')}/login`);
    });

  const refreshStatus = async () => {
    try {
      const r = await api.get('/cloudflare-tunnel/status');
      setApp((s: any) => ({
        ...s,
        cf_tunnel_status: r.data.status,
        cf_tunnel_url: r.data.url || r.data.cf_tunnel_url,
        public_base_url: r.data.public_base_url ?? s?.public_base_url,
      }));
      if (r.data.adminLoginUrl) setAdminLoginUrl(r.data.adminLoginUrl);
      if (r.data.tunnelLoginUrl) setTunnelLoginUrl(r.data.tunnelLoginUrl);
      else if (r.data.url || r.data.cf_tunnel_url) {
        setTunnelLoginUrl(`${String(r.data.url || r.data.cf_tunnel_url).replace(/\/$/, '')}/login`);
      }
      if (r.data.loginWarning) setLoginWarning(r.data.loginWarning);
      // A stale "Apply failed" banner from an earlier client-side error (e.g. a
      // request that outran a proxy/browser timeout while the install script
      // kept running and finished successfully server-side) is just wrong once
      // we've confirmed the tunnel is actually up — clear it rather than leave
      // contradictory info on screen next to a "running" badge.
      if (r.data.status === 'running') setBanner('');
      await loadPublic();
    } catch {
      /* ignore */
    }
  };

  const load = () => {
    loadApp().catch(() => setApp({}));
    loadPublic().catch(() => undefined);
    void refreshStatus();
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const saveSettings = async (extra: Record<string, unknown> = {}) => {
    const payload = { ...app, ...extra };
    const r = await api.put('/settings/app', payload);
    setApp(r.data);
    return r.data;
  };

  // apply/start/stop now run as a background job on the server (they can take
  // anywhere from a few seconds to ~30-90s — apt-get installs, cloudflared
  // install, token probe, cloudflared's own graceful-shutdown grace period on
  // stop). Poll for live progress instead of blocking on one long request.
  const pollJob = (action: string) => {
    stopJobPoll();
    const startedAt = Date.now();
    setJob({ action, log: '', running: true, code: null, startedAt });
    setElapsed(0);

    const tick = async () => {
      try {
        const r = await api.get('/cloudflare-tunnel/job');
        setElapsed(Math.round((Date.now() - startedAt) / 1000));
        setJob((j) => (j ? { ...j, log: r.data.log || '' } : j));
        if (!r.data.running) {
          stopJobPoll();
          const code = r.data.code;
          setJob((j) => (j ? { ...j, running: false, code } : j));
          const ok = code === 0;
          flash(
            ok
              ? action === 'stop'
                ? 'Tunnel stopped.'
                : 'Cloudflare Tunnel is running.'
              : `${action === 'stop' ? 'Stop' : action === 'start' ? 'Start' : 'Apply'} failed (exit ${code}). See details below.`
          );
          await refreshStatus();
          load();
          if (ok) {
            window.setTimeout(() => setJob((j) => (j && !j.running ? null : j)), 4000);
          }
        }
      } catch {
        /* transient network hiccup — keep polling */
      }
    };

    void tick();
    jobPollRef.current = window.setInterval(() => { void tick(); }, 1200);
  };

  const apply = async () => {
    setBusy(true);
    try {
      await saveSettings(token ? { cf_tunnel_token: token } : {});
      const r = await api.post('/cloudflare-tunnel/apply');
      setToken('');
      if (r.data.started) {
        pollJob('apply');
      } else {
        flash(r.data.url ? `Tunnel running at ${r.data.url}` : 'Cloudflare Tunnel applied.');
        load();
      }
    } catch (e: any) {
      flash(
        e?.response?.data?.error ||
            'Apply failed. One-time SSH fix: sudo bash /opt/mt-billing/install/mt-billing-grant-updater-root.sh — then retry from this page (no SSH after that).'
      );
      // The install script can outrun a proxy/browser timeout even when it
      // goes on to finish successfully. Re-check shortly after so a
      // genuinely-successful install doesn't sit behind a false failure.
      window.setTimeout(() => { refreshStatus(); }, 4000);
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    setBusy(true);
    try {
      const willStart = app.cf_tunnel_status !== 'running';
      const r = await api.post('/cloudflare-tunnel/toggle');
      if (r.data.started) {
        pollJob(willStart ? 'start' : 'stop');
      } else {
        flash(r.data.status === 'running' ? `Tunnel started: ${r.data.url}` : 'Tunnel stopped.');
        load();
      }
    } catch (e: any) {
      flash(e?.response?.data?.error || 'Failed to toggle Cloudflare Tunnel.');
    } finally {
      setBusy(false);
    }
  };

  const payPortalUrl = (() => {
    const base = (effective || cloudflareUrl || '').replace(/\/$/, '');
    if (!base) return '';
    return `${base}/pay/`;
  })();

  const copyPayPortal = async () => {
    if (!payPortalUrl) {
      flash('No public URL yet — save a Cloudflare hostname/token and start the tunnel.');
      return;
    }
    const ok = await copyTextOrPrompt(payPortalUrl, 'Pay portal base — copy:');
    flash(ok ? 'Pay portal base copied' : 'Copy from the dialog, then share the link');
  };

  const copyAdminLogin = async () => {
    if (!adminLoginUrl) {
      flash('LAN IP not detected — open http://<panel-lan-ip>/login for staff login.');
      return;
    }
    const ok = await copyTextOrPrompt(adminLoginUrl, 'Admin login (LAN) — copy:');
    flash(ok ? 'Admin LAN login copied' : 'Copy from the dialog');
  };

  if (!app) {
    return (
      <Layout title="Cloudflare Tunnel">
        <LoadingPage />
      </Layout>
    );
  }

  const status =
    app.cf_tunnel_status === 'running' ? 'running' : app.cf_tunnel_status === 'error' ? 'offline' : 'offline';
  const tunnelUrl =
    app.cf_tunnel_url || (app.cf_tunnel_hostname ? `https://${app.cf_tunnel_hostname}` : '');

  const sourceLabel =
    source === 'cloudflare'
      ? 'Cloudflare Tunnel'
      : source === 'public_base_url'
        ? 'saved public URL'
        : source === 'ngrok'
          ? 'ngrok tunnel'
          : source === 'lan'
            ? 'LAN IP'
            : source === 'env'
              ? 'PUBLIC_BASE_URL env'
              : 'not configured';

  return (
    <Layout title="Cloudflare Tunnel">
      <Flash message={banner} onDismiss={() => setBanner('')} />

      <Card className="mb-5 border-amber-200 bg-amber-50/70">
        <p className="text-sm text-amber-950 mb-3">
          <b>Staff login on tunnel + LAN.</b>{' '}
          {loginWarning ||
            'After Apply, nginx is healed so https://your-tunnel-host/login works. Disable Cloudflare Access (Zero Trust Application) and Bot Fight Mode on this hostname — they block POST /api/login at the edge. Prefer LAN IP when on-site.'}
        </p>
        <button
          type="button"
          className="btn-secondary"
          disabled={busy || !app?.cf_tunnel_hostname}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api.post('/cloudflare-tunnel/heal-nginx');
              if (r.data.tunnelLoginUrl) setTunnelLoginUrl(r.data.tunnelLoginUrl);
              flash('nginx healed — try staff login on the Cloudflare hostname');
              await refreshStatus();
            } catch (e: any) {
              flash(e?.response?.data?.error || e?.response?.data?.hint || 'Could not heal nginx');
            } finally {
              setBusy(false);
            }
          }}
        >
          <RefreshCw size={16} /> Fix Cloudflare login (heal nginx)
        </button>
      </Card>

      <Card className="mb-5 border-sky-200 bg-sky-50/50">
        <p className="text-sm text-sky-900">
          <b>Works with Twingate.</b> cloudflared is outbound-only and does not take over your LAN. After starting
          Twingate, use Network → Twingate → <b>Fix LAN coexistence</b> so local routes and DNS stay on this host while
          both tunnels run.
        </p>
      </Card>

      <Card className="mb-5">
        <div className="flex items-start gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl bg-sky-50 text-sky-600 flex items-center justify-center shrink-0">
            <Globe2 size={20} />
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-slate-800">Pay portal (public)</div>
            <p className="text-sm text-slate-500 mt-0.5">
              Subscriber payment links use this Cloudflare hostname. This is not the staff admin login.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <div className="flex-1 min-w-[240px] input font-mono text-sm bg-slate-50 truncate">
            {payPortalUrl || '(Configure Cloudflare Tunnel below to generate a public link)'}
          </div>
          <button type="button" className="btn-primary" onClick={copyPayPortal} disabled={!payPortalUrl}>
            <Copy size={16} /> Copy pay base
          </button>
          {payPortalUrl && (
            <a className="btn-secondary" href={payPortalUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={16} /> Open
            </a>
          )}
        </div>
        <div className="mt-4">
          <div className="font-semibold text-slate-800 text-sm">Staff login (Cloudflare)</div>
          <p className="text-xs text-slate-500 mt-0.5 mb-2">
            Works after Apply heals nginx for full panel. Turn off Access / Bot Fight on this host.
          </p>
          <div className="flex flex-wrap gap-2 items-center mb-4">
            <div className="flex-1 min-w-[240px] input font-mono text-sm bg-slate-50 truncate">
              {tunnelLoginUrl || '(Apply tunnel with a hostname first)'}
            </div>
            <button
              type="button"
              className="btn-secondary"
              disabled={!tunnelLoginUrl}
              onClick={async () => {
                if (!tunnelLoginUrl) return;
                const ok = await copyTextOrPrompt(tunnelLoginUrl, 'Tunnel staff login — copy:');
                flash(ok ? 'Tunnel login copied' : 'Copy from the dialog');
              }}
            >
              <Copy size={16} /> Copy tunnel login
            </button>
            {tunnelLoginUrl && (
              <a className="btn-secondary" href={tunnelLoginUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={16} /> Open
              </a>
            )}
          </div>
          <div className="font-semibold text-slate-800 text-sm">Staff login (LAN)</div>
          <p className="text-xs text-slate-500 mt-0.5 mb-2">
            Fastest on-site — always available even if Cloudflare edge blocks login.
          </p>
          <div className="flex flex-wrap gap-2 items-center">
            <div className="flex-1 min-w-[240px] input font-mono text-sm bg-slate-50 truncate">
              {adminLoginUrl || '(Click Refresh status to detect LAN IP)'}
            </div>
            <button type="button" className="btn-secondary" onClick={copyAdminLogin} disabled={!adminLoginUrl}>
              <Copy size={16} /> Copy LAN login
            </button>
          </div>
        </div>
        <div className="mt-3 text-xs text-slate-500 space-y-1">
          <div>
            Active base:{' '}
            <span className="font-mono text-slate-700">{effective || tunnelUrl || '(none)'}</span>
            {' · '}
            source <span className="font-medium text-slate-700">{sourceLabel}</span>
          </div>
          {(() => {
            const tunnelHost = String(app.cf_tunnel_hostname || '')
              .replace(/^https?:\/\//i, '')
              .replace(/\/.*$/, '')
              .toLowerCase();
            const activeHost = String(effective || '')
              .replace(/^https?:\/\//i, '')
              .replace(/\/.*$/, '')
              .toLowerCase();
            if (!tunnelHost || !activeHost || tunnelHost === activeHost) return null;
            return (
              <div className="text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-2 flex flex-wrap items-center gap-2">
                <span>
                  Pay link (<span className="font-mono">{activeHost}</span>) differs from tunnel hostname (
                  <span className="font-mono">{tunnelHost}</span>).
                </span>
                <button
                  type="button"
                  className="btn-secondary text-xs py-1 px-2"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await saveSettings({
                        sync_public_from_tunnel: true,
                        public_base_url: `https://${tunnelHost}`,
                      });
                      flash(`Pay links now use https://${tunnelHost}`);
                      load();
                    } catch (e: any) {
                      flash(e?.response?.data?.error || 'Could not sync public URL');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Use tunnel hostname
                </button>
              </div>
            );
          })()}
          {warning && (
            <div className="text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">{warning}</div>
          )}
        </div>
      </Card>

      <Card>
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-orange-50 text-orange-600 flex items-center justify-center shrink-0">
            <Cloud size={20} />
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-slate-800">Cloudflare Tunnel token</div>
            <p className="text-sm text-slate-500 mt-0.5">
              Create a tunnel in{' '}
              <a
                href="https://one.dash.cloudflare.com/"
                target="_blank"
                rel="noreferrer"
                className="text-brand-600 hover:underline font-medium"
              >
                Cloudflare Zero Trust
              </a>
              , add a Public Hostname to{' '}
              <code className="text-slate-600">http://127.0.0.1:{app.cf_tunnel_port || 80}</code>, then paste the
              connector token here.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between rounded-lg border border-slate-100 px-4 py-3 mb-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-slate-700">Tunnel status</div>
            <div className="text-xs text-slate-400 truncate">{tunnelUrl || 'Not running'}</div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <StatusBadge status={status} />
            <button type="button" className="btn-secondary text-xs py-1.5" onClick={refreshStatus} disabled={busy || !!job}>
              <RefreshCw size={14} />
            </button>
            <button type="button" className="btn-primary" onClick={toggle} disabled={busy || !!job}>
              {app.cf_tunnel_status === 'running' ? 'Stop' : 'Start'} Tunnel
            </button>
          </div>
        </div>

        <p className="text-xs text-slate-500 mb-4 max-w-2xl">
          Cloudflare <strong>502 Bad gateway / Host Error</strong> means this PC/RPi stopped answering the tunnel
          (often after Twingate DNS changes). Staff login stays on the{' '}
          <strong>LAN IP</strong>. On the appliance console:{' '}
          <code className="text-[11px] bg-slate-100 px-1 rounded">sudo bash /opt/mt-billing/install/mt-billing-net-rescue.sh</code>
          {' '}— then Update the panel so the network watchdog can auto-restart cloudflared.
        </p>

        {job && (
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 mb-4">
            <div className="flex items-center justify-between mb-2 gap-2">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-700 min-w-0">
                {job.running && <Loader2 size={15} className="animate-spin text-brand-600 shrink-0" />}
                <span className="truncate">
                  {job.running
                    ? `${job.action === 'stop' ? 'Stopping' : job.action === 'start' ? 'Starting' : 'Installing & starting'} Cloudflare Tunnel…`
                    : job.code === 0
                      ? 'Done.'
                      : `Failed (exit ${job.code}).`}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-slate-400 font-mono">{elapsed}s</span>
                {!job.running && (
                  <button type="button" className="text-xs text-slate-400 hover:text-slate-600" onClick={() => setJob(null)}>
                    Dismiss
                  </button>
                )}
              </div>
            </div>
            <Progress
              value={job.running ? Math.min(92, elapsed * 3) : 100}
              color={!job.running && job.code !== 0 ? 'bg-rose-500' : undefined}
            />
            <pre
              ref={logRef}
              className="mt-3 max-h-40 overflow-auto rounded-lg bg-slate-950 text-slate-300 text-[11px] leading-relaxed font-mono p-3 whitespace-pre-wrap break-words"
            >
              {job.log || 'Waiting for output…'}
            </pre>
          </div>
        )}

        <div className="space-y-4 max-w-2xl">
          <FormField label={`Tunnel token${app.cf_tunnel_token_set ? ' (saved)' : ''}`}>
            <input
              className="input font-mono text-sm"
              type="password"
              autoComplete="off"
              placeholder={
                app.cf_tunnel_token_set ? '••••••• (leave blank to keep)' : 'eyJhIjoi... (Cloudflare install token)'
              }
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </FormField>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FormField label="Public hostname">
              <input
                className="input font-mono text-sm"
                placeholder="panel.yourdomain.com"
                value={app.cf_tunnel_hostname || ''}
                onChange={(e) => setApp((s: any) => ({ ...s, cf_tunnel_hostname: e.target.value }))}
              />
              <span className="text-xs text-slate-400 mt-1 block">Hostname on your Cloudflare zone</span>
            </FormField>
            <FormField label="Local service port">
              <input
                className="input"
                type="number"
                value={app.cf_tunnel_port ?? 80}
                onChange={(e) =>
                  setApp((s: any) => ({ ...s, cf_tunnel_port: Number(e.target.value) || 80 }))
                }
              />
              <span className="text-xs text-slate-400 mt-1 block">Must match Cloudflare → http://127.0.0.1:PORT</span>
            </FormField>
          </div>

          <div className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2 text-xs text-slate-500 space-y-1">
            <div>
              After the tunnel is running, payment links and this website link both use{' '}
              <span className="font-mono text-slate-700">https://your-hostname</span>.
            </div>
            <div>
              One-time only (if Install fails):{' '}
              <code className="text-slate-700">sudo bash /opt/mt-billing/install/mt-billing-grant-updater-root.sh</code>
              {' '}— after that, manage the tunnel from this page without SSH.
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              className="btn-secondary"
              disabled={busy || !!job}
              onClick={async () => {
                setBusy(true);
                try {
                  const host = String(app.cf_tunnel_hostname || '')
                    .replace(/^https?:\/\//i, '')
                    .replace(/\/.*$/, '')
                    .toLowerCase();
                  await saveSettings({
                    ...(token ? { cf_tunnel_token: token } : {}),
                    sync_public_from_tunnel: true,
                    ...(host ? { public_base_url: `https://${host}` } : {}),
                  });
                  if (token) setToken('');
                  flash(
                    host
                      ? `Saved. Website & pay links use https://${host}`
                      : 'Cloudflare settings saved.'
                  );
                  load();
                } catch (e: any) {
                  flash(e?.response?.data?.error || 'Save failed');
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Save size={16} /> Save token & settings
            </button>
            <button type="button" className="btn-primary" disabled={busy || !!job} onClick={apply}>
              {busy ? 'Starting…' : job ? 'Working…' : 'Install & start tunnel'}
            </button>
          </div>
        </div>
      </Card>
    </Layout>
  );
}
