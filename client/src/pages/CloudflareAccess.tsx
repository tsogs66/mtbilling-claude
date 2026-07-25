import { useEffect, useState } from 'react';
import { Cloud, Copy, ExternalLink, Globe2, RefreshCw, Save } from 'lucide-react';
import Layout from '../components/Layout';
import { Card, Flash, FormField, LoadingPage, StatusBadge } from '../components/ui';
import { api } from '../api';
import { copyTextOrPrompt } from '../lib/clipboard';

/**
 * Dedicated Cloudflare Tunnel setup: connector token + public website access link
 * (same public base used by subscriber payment links).
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
    });

  const load = () => {
    loadApp().catch(() => setApp({}));
    loadPublic().catch(() => undefined);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshStatus = async () => {
    try {
      const r = await api.get('/cloudflare-tunnel/status');
      setApp((s: any) => ({
        ...s,
        cf_tunnel_status: r.data.status,
        cf_tunnel_url: r.data.url || r.data.cf_tunnel_url,
        public_base_url: r.data.public_base_url ?? s?.public_base_url,
      }));
      await loadPublic();
    } catch {
      /* ignore */
    }
  };

  const saveSettings = async (extra: Record<string, unknown> = {}) => {
    const payload = { ...app, ...extra };
    const r = await api.put('/settings/app', payload);
    setApp(r.data);
    return r.data;
  };

  const apply = async () => {
    setBusy(true);
    try {
      await saveSettings(token ? { cf_tunnel_token: token } : {});
      const r = await api.post('/cloudflare-tunnel/apply');
      flash(r.data.url ? `Tunnel running at ${r.data.url}` : 'Cloudflare Tunnel applied.');
      setToken('');
      load();
    } catch (e: any) {
      flash(
        e?.response?.data?.error ||
            'Apply failed. One-time SSH fix: sudo bash /opt/mt-billing/install/mt-billing-grant-updater-root.sh — then retry from this page (no SSH after that).'
      );
    } finally {
      setBusy(false);
    }
  };

  const toggle = async () => {
    setBusy(true);
    try {
      const r = await api.post('/cloudflare-tunnel/toggle');
      flash(r.data.status === 'running' ? `Tunnel started: ${r.data.url}` : 'Tunnel stopped.');
      load();
    } catch (e: any) {
      flash(e?.response?.data?.error || 'Failed to toggle Cloudflare Tunnel.');
    } finally {
      setBusy(false);
    }
  };

  const websiteUrl = (() => {
    const base = (effective || cloudflareUrl || '').replace(/\/$/, '');
    if (!base) return '';
    return `${base}/login`;
  })();

  const copyWebsite = async () => {
    if (!websiteUrl) {
      flash('No public website URL yet — save a Cloudflare hostname/token and start the tunnel.');
      return;
    }
    const ok = await copyTextOrPrompt(websiteUrl, 'Website access link — copy:');
    flash(ok ? 'Website link copied' : 'Copy from the dialog, then share the link');
  };

  if (!app) {
    return (
      <Layout title="Cloudflare Access">
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
    <Layout title="Cloudflare Access">
      <Flash message={banner} onDismiss={() => setBanner('')} />

      <Card className="mb-5">
        <div className="flex items-start gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl bg-sky-50 text-sky-600 flex items-center justify-center shrink-0">
            <Globe2 size={20} />
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-slate-800">Website access link</div>
            <p className="text-sm text-slate-500 mt-0.5">
              Same public base as payment links — opens the panel login for staff or remote access over the internet.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <div className="flex-1 min-w-[240px] input font-mono text-sm bg-slate-50 truncate">
            {websiteUrl || '(Configure Cloudflare Tunnel below to generate a public link)'}
          </div>
          <button type="button" className="btn-primary" onClick={copyWebsite} disabled={!websiteUrl}>
            <Copy size={16} /> Copy link
          </button>
          {websiteUrl && (
            <a className="btn-secondary" href={websiteUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={16} /> Open
            </a>
          )}
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
                  Website/pay link (<span className="font-mono">{activeHost}</span>) differs from tunnel hostname (
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
                      flash(`Website & pay links now use https://${tunnelHost}`);
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
            <button type="button" className="btn-secondary text-xs py-1.5" onClick={refreshStatus} disabled={busy}>
              <RefreshCw size={14} />
            </button>
            <button type="button" className="btn-primary" onClick={toggle} disabled={busy}>
              {app.cf_tunnel_status === 'running' ? 'Stop' : 'Start'} Tunnel
            </button>
          </div>
        </div>

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
              disabled={busy}
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
            <button type="button" className="btn-primary" disabled={busy} onClick={apply}>
              {busy ? 'Working…' : 'Install & start tunnel'}
            </button>
          </div>
        </div>
      </Card>
    </Layout>
  );
}
