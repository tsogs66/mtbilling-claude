import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Settings as SettingsIcon, Sun, Moon, Anchor, Database as DbIcon, Bot, Clock, KeyRound,
  Router as RouterIcon, Globe2, Download, Trash2, RefreshCw, Plus, Pencil, Power, Cloud, Wifi, Loader2, AlertCircle, Upload, FileCheck,
} from 'lucide-react';
import Layout from '../components/Layout';
import {
  StatusBadge, TabBar, Flash, LoadingPage, SettingsSection, Modal, ModalFooter, FormField,
} from '../components/ui';
import { api } from '../api';
import { useTheme, type ThemeId } from '../context/ThemeContext';

const TABS = [
  { key: 'panel', label: 'Panel Settings', icon: SettingsIcon },
  { key: 'cloudflare', label: 'Cloudflare Tunnel', icon: Cloud },
  { key: 'ngrok', label: 'Ngrok Remote Access', icon: Globe2 },
  { key: 'database', label: 'Database Management', icon: DbIcon },
  { key: 'ai', label: 'AI Settings', icon: Bot },
  { key: 'time', label: 'Time Synchronization', icon: Clock },
  { key: 'account', label: 'Account Reset', icon: KeyRound },
  { key: 'routers', label: 'Router Management', icon: RouterIcon },
] as const;

export default function SystemSettings() {
  const [tab, setTab] = useState('panel');
  const [app, setApp] = useState<any>(null);
  const [banner, setBanner] = useState('');

  const load = () => api.get('/settings/app').then((r) => setApp(r.data));
  useEffect(() => {
    load();
  }, []);

  const flash = (m: string) => {
    setBanner(m);
    setTimeout(() => setBanner(''), 4000);
  };
  const setA = (patch: any) => setApp((s: any) => ({ ...s, ...patch }));
  const saveApp = async (extra: any = {}) => {
    const r = await api.put('/settings/app', { ...app, ...extra });
    setApp(r.data);
    flash('Settings saved.');
  };

  if (!app) {
    return (
      <Layout title="System Settings">
        <LoadingPage />
      </Layout>
    );
  }

  return (
    <Layout title="System Settings">
      <Flash message={banner} onDismiss={() => setBanner('')} />

      <TabBar tabs={[...TABS]} active={tab} onChange={setTab} className="mb-5" />

      {tab === 'panel' && (
        <>
          <PanelSettings app={app} setA={setA} save={saveApp} />
          <ServerRestart flash={flash} />
        </>
      )}
      {tab === 'cloudflare' && <CloudflareTunnelSettings app={app} setA={setA} save={saveApp} flash={flash} reload={load} />}
      {tab === 'ngrok' && <NgrokSettings app={app} setA={setA} save={saveApp} flash={flash} reload={load} />}
      {tab === 'database' && <DatabaseManagement flash={flash} />}
      {tab === 'ai' && <AiSettings app={app} setA={setA} save={saveApp} />}
      {tab === 'time' && <TimeSync app={app} setA={setA} save={saveApp} flash={flash} />}
      {tab === 'account' && <AccountReset flash={flash} />}
      {tab === 'routers' && <RouterManagement flash={flash} />}
    </Layout>
  );
}

function PanelSettings({ app, setA, save }: any) {
  const { theme, setTheme } = useTheme();
  const themes: { key: ThemeId; label: string; Icon: typeof Sun; hint: string }[] = [
    { key: 'light', label: 'Light', Icon: Sun, hint: 'Clean daylight panel' },
    { key: 'dark', label: 'Dark', Icon: Moon, hint: 'Low-light operations' },
    { key: 'onepiece', label: 'One Piece', Icon: Anchor, hint: 'Nautical map art · gold & crimson' },
  ];
  const selectTheme = (key: ThemeId) => {
    setA({ theme: key });
    setTheme(key);
  };
  // Sync saved theme into provider when settings load
  useEffect(() => {
    if (app?.theme === 'light' || app?.theme === 'dark' || app?.theme === 'onepiece') {
      if (app.theme !== theme) setTheme(app.theme);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app?.theme]);

  return (
    <SettingsSection icon={SettingsIcon} title="Panel Settings">
      <div className="space-y-5 max-w-2xl">
        <div>
          <span className="text-sm font-semibold text-slate-700 mb-1 block">Theme</span>
          <div className="grid grid-cols-3 rounded-xl border border-slate-200 overflow-hidden">
            {themes.map(({ key, label, Icon, hint }) => (
              <button
                key={key}
                type="button"
                onClick={() => selectTheme(key)}
                className={`flex flex-col items-center justify-center gap-1 py-3 px-2 text-sm ${
                  (app.theme || theme) === key
                    ? 'bg-white text-brand-600 font-medium shadow-inner'
                    : 'bg-slate-50 text-slate-500 hover:bg-white'
                }`}
              >
                <span className="flex items-center gap-1.5"><Icon size={16} /> {label}</span>
                <span className="text-[10px] text-slate-400 font-normal">{hint}</span>
              </button>
            ))}
          </div>
        </div>
        <label className="block max-w-xs">
          <span className="text-sm font-semibold text-slate-700 mb-1 block">Currency</span>
          <select className="input" value={app.currency} onChange={(e) => setA({ currency: e.target.value })}>
            <option value="PHP">PHP (₱)</option>
            <option value="USD">USD ($)</option>
            <option value="EUR">EUR (€)</option>
          </select>
        </label>
        <label className="block">
          <span className="text-sm font-semibold text-slate-700 mb-1 block">Public pay portal URL</span>
          <input
            className="input font-mono text-sm"
            placeholder="https://billing.yourisp.com"
            value={app.public_base_url || ''}
            onChange={(e) => setA({ public_base_url: e.target.value })}
          />
          <span className="text-xs text-slate-400 mt-1 block">
            Globally reachable URL for subscriber payment links (domain, Cloudflare Tunnel, or ngrok). Also editable under Payment Links.
          </span>
        </label>
        <div className="flex justify-end">
          <button type="button" className="btn-primary" onClick={() => save({ theme: app.theme || theme })}>Save Panel Settings</button>
        </div>
      </div>
    </SettingsSection>
  );
}

function ServerRestart({ flash }: { flash: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const restart = async () => {
    setBusy(true);
    try {
      await api.post('/settings/restart-server');
      flash('Server restart initiated. Waiting for API to come back…');
      setConfirm(false);
      // Poll health until the API is back (tsx watch / systemd / self-respawn)
      let tries = 0;
      const tick = async () => {
        tries += 1;
        try {
          await api.get('/health');
          flash('API server is back online.');
          setBusy(false);
        } catch {
          if (tries < 30) setTimeout(tick, 1000);
          else {
            flash('Restart sent. If the panel stays offline, start the API process manually.');
            setBusy(false);
          }
        }
      };
      setTimeout(tick, 1500);
    } catch (e: any) {
      flash(e?.response?.data?.error || 'Restart failed.');
      setBusy(false);
    }
  };

  return (
    <SettingsSection icon={Power} title="Server Restart" className="mt-5">
      <div className="max-w-2xl space-y-4">
        <p className="text-sm text-slate-500">
          Restart the API service. Active sessions will be disconnected briefly. Use this after configuration changes or updates that require a full service restart.
        </p>
        {!confirm ? (
          <button type="button" className="btn-secondary border-rose-200 text-rose-700 hover:bg-rose-50" onClick={() => setConfirm(true)}>
            <Power size={16} /> Restart API server
          </button>
        ) : (
          <div className="rounded-xl border border-rose-200 bg-rose-50/50 p-4 space-y-3">
            <p className="text-sm text-rose-800 font-medium">Restart the API server now? The panel may be unavailable for a few seconds.</p>
            <div className="flex gap-2">
              <button type="button" className="btn-primary bg-rose-600 hover:bg-rose-700 from-rose-600 to-rose-700" onClick={restart} disabled={busy}>
                {busy ? 'Restarting…' : 'Yes, restart now'}
              </button>
              <button type="button" className="btn-secondary" onClick={() => setConfirm(false)} disabled={busy}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </SettingsSection>
  );
}

function CloudflareTunnelSettings({ app, setA, save, flash, reload }: any) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  const refreshStatus = async () => {
    try {
      const r = await api.get('/cloudflare-tunnel/status');
      setA({
        cf_tunnel_status: r.data.status,
        cf_tunnel_url: r.data.url || r.data.cf_tunnel_url,
        public_base_url: r.data.public_base_url ?? app.public_base_url,
      });
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = async () => {
    setBusy(true);
    try {
      const r = await api.post('/cloudflare-tunnel/toggle');
      flash(r.data.status === 'running' ? `Tunnel started: ${r.data.url}` : 'Tunnel stopped.');
      reload();
    } catch (e: any) {
      flash(e?.response?.data?.error || 'Failed to toggle Cloudflare Tunnel.');
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    setBusy(true);
    try {
      await save(token ? { cf_tunnel_token: token } : {});
      const r = await api.post('/cloudflare-tunnel/apply');
      flash(r.data.url ? `Tunnel running at ${r.data.url}` : 'Cloudflare Tunnel applied.');
      setToken('');
      reload();
    } catch (e: any) {
      flash(e?.response?.data?.error || 'Apply failed. On the LXC you may need: sudo bash install/mt-billing-grant-updater-root.sh');
    } finally {
      setBusy(false);
    }
  };

  const status = app.cf_tunnel_status === 'running' ? 'running' : app.cf_tunnel_status === 'error' ? 'offline' : 'offline';
  const url = app.cf_tunnel_url || (app.cf_tunnel_hostname ? `https://${app.cf_tunnel_hostname}` : '');

  return (
    <SettingsSection icon={Cloud} title="Cloudflare Tunnel">
      <div className="space-y-4 max-w-2xl">
        <p className="text-sm text-slate-500">
          Expose the panel website and subscriber payment links with Cloudflare Tunnel — no port-forwarding or DynDNS required.
          Prefer the dedicated{' '}
          <Link to="/cloudflare" className="text-brand-600 hover:underline font-medium">
            Cloudflare Access
          </Link>{' '}
          page to paste your connector token and copy the website login link.
          Create a tunnel in{' '}
          <a
            href="https://one.dash.cloudflare.com/"
            target="_blank"
            rel="noreferrer"
            className="text-brand-600 hover:underline font-medium"
          >
            Cloudflare Zero Trust
          </a>
          , add a Public Hostname pointing to{' '}
          <code className="text-slate-600">http://127.0.0.1:{app.cf_tunnel_port || 80}</code>, then paste the connector token below.
        </p>

        <div className="flex items-center justify-between rounded-lg border border-slate-100 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-medium text-slate-700">Tunnel status</div>
            <div className="text-xs text-slate-400 truncate">{url || 'Not running'}</div>
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

        <label className="block">
          <span className="text-sm font-semibold text-slate-700 mb-1 block">
            Tunnel token {app.cf_tunnel_token_set && <span className="text-emerald-600 text-xs">(saved)</span>}
          </span>
          <input
            className="input font-mono text-sm"
            type="password"
            placeholder={app.cf_tunnel_token_set ? '••••••• (leave blank to keep)' : 'eyJhIjoi... (Cloudflare install token)'}
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm font-semibold text-slate-700 mb-1 block">Public hostname</span>
            <input
              className="input font-mono text-sm"
              placeholder="pay.yourdomain.com"
              value={app.cf_tunnel_hostname || ''}
              onChange={(e) => setA({ cf_tunnel_hostname: e.target.value })}
            />
            <span className="text-xs text-slate-400 mt-1 block">
              Must be a hostname on your Cloudflare zone (not the pay.yourisp.com example).
            </span>
          </label>
          <label className="block">
            <span className="text-sm font-semibold text-slate-700 mb-1 block">Local service port</span>
            <input
              className="input"
              type="number"
              value={app.cf_tunnel_port ?? 80}
              onChange={(e) => setA({ cf_tunnel_port: Number(e.target.value) || 80 })}
            />
            <span className="text-xs text-slate-400 mt-1 block">Must match Cloudflare → http://127.0.0.1:PORT</span>
          </label>
        </div>

        <div className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2 text-xs text-slate-500 space-y-1">
          <div>
            CLI alternative:{' '}
            <code className="text-slate-700">sudo bash /opt/mt-billing/install/mt-billing-cloudflare-tunnel.sh --token … --hostname pay.yourdomain.com</code>
          </div>
          <div>
            First-time panel control may need:{' '}
            <code className="text-slate-700">sudo bash /opt/mt-billing/install/mt-billing-grant-updater-root.sh</code>
          </div>
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            onClick={() => save(token ? { cf_tunnel_token: token } : {})}
          >
            Save settings
          </button>
          <button type="button" className="btn-primary" disabled={busy} onClick={apply}>
            {busy ? 'Working…' : 'Install & start tunnel'}
          </button>
        </div>
      </div>
    </SettingsSection>
  );
}

function NgrokSettings({ app, setA, save, flash, reload }: any) {
  const [token, setToken] = useState('');
  const toggle = async () => {
    try {
      const r = await api.post('/ngrok/toggle');
      flash(r.data.status === 'running' ? `Tunnel started: ${r.data.url}` : 'Tunnel stopped.');
      reload();
    } catch (e: any) {
      flash(e?.response?.data?.error || 'Failed to toggle tunnel.');
    }
  };
  return (
    <SettingsSection icon={Globe2} title="Ngrok Remote Access">
      <div className="space-y-4 max-w-2xl">
        <p className="text-sm text-slate-500">Expose the panel securely over the internet via an ngrok tunnel.</p>
        <div className="flex items-center justify-between rounded-lg border border-slate-100 px-4 py-3">
          <div>
            <div className="text-sm font-medium text-slate-700">Tunnel status</div>
            <div className="text-xs text-slate-400">{app.ngrok_url ? app.ngrok_url : 'Not running'}</div>
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge status={app.ngrok_status === 'running' ? 'running' : 'offline'} />
            <button className="btn-primary" onClick={toggle}>{app.ngrok_status === 'running' ? 'Stop' : 'Start'} Tunnel</button>
          </div>
        </div>
        <label className="block">
          <span className="text-sm font-semibold text-slate-700 mb-1 block">Auth Token {app.ngrok_authtoken_set && <span className="text-emerald-600 text-xs">(saved)</span>}</span>
          <input className="input" type="password" placeholder={app.ngrok_authtoken_set ? '••••••• (leave blank to keep)' : 'ngrok authtoken'} value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
        <div className="grid grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm font-semibold text-slate-700 mb-1 block">Region</span>
            <select className="input" value={app.ngrok_region} onChange={(e) => setA({ ngrok_region: e.target.value })}>
              {['us', 'eu', 'ap', 'au', 'sa', 'jp', 'in'].map((r) => <option key={r} value={r}>{r.toUpperCase()}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-semibold text-slate-700 mb-1 block">Local Port</span>
            <input className="input" type="number" value={app.ngrok_port} onChange={(e) => setA({ ngrok_port: Number(e.target.value) })} />
          </label>
        </div>
        <div className="flex justify-end">
          <button className="btn-primary" onClick={() => save(token ? { ngrok_authtoken: token } : {})}>Save Ngrok Settings</button>
        </div>
      </div>
    </SettingsSection>
  );
}

function DatabaseManagement({ flash }: any) {
  const [backups, setBackups] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [fileData, setFileData] = useState('');
  const [selectedFile, setSelectedFile] = useState<{
    name: string;
    size: number;
    status: 'reading' | 'ready' | 'error';
    error?: string;
  } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [downloadJob, setDownloadJob] = useState<{
    name: string;
    phase: 'preparing' | 'downloading' | 'starting' | 'done' | 'error';
    percent?: number;
    error?: string;
  } | null>(null);
  const [restoreJob, setRestoreJob] = useState<{
    fileName: string;
    phase: 'uploading' | 'restarting' | 'done' | 'error';
    percent?: number;
    error?: string;
  } | null>(null);

  const load = () => api.get('/db/backups').then((r) => setBackups(r.data));
  useEffect(() => {
    load();
  }, []);

  const createBackup = async () => {
    setBusy(true);
    try {
      await api.post('/db/backup');
      flash('Backup created.');
      load();
    } finally {
      setBusy(false);
    }
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileData('');
    setSelectedFile({ name: f.name, size: f.size, status: 'reading' });
    const reader = new FileReader();
    reader.onload = () => {
      setFileData(String(reader.result));
      setSelectedFile({ name: f.name, size: f.size, status: 'ready' });
    };
    reader.onerror = () => {
      setFileData('');
      setSelectedFile({
        name: f.name,
        size: f.size,
        status: 'error',
        error: 'Could not read the backup file from disk.',
      });
    };
    reader.readAsDataURL(f);
    e.target.value = '';
  };

  const clearSelectedFile = () => {
    setFileData('');
    setSelectedFile(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const restore = async () => {
    if (!fileData || selectedFile?.status !== 'ready') {
      flash('Choose a backup file first and wait until it is ready.');
      return;
    }
    if (!confirm('Replace the current database with this backup? The API will restart to apply it.')) {
      return;
    }
    setBusy(true);
    setRestoreJob({ fileName: selectedFile.name, phase: 'uploading', percent: 0 });
    try {
      const r = await api.post(
        '/db/restore',
        { data: fileData, restart: true },
        {
          onUploadProgress: (ev) => {
            if (!ev.total) return;
            const percent = Math.min(100, Math.round((ev.loaded / ev.total) * 100));
            setRestoreJob((job) =>
              job?.fileName === selectedFile.name ? { ...job, phase: 'uploading', percent } : job
            );
          },
        }
      );
      setRestoreJob({ fileName: selectedFile.name, phase: 'restarting' });
      flash(r.data?.message || 'Backup staged. Restarting API to apply…');
      // Poll until API is back (restore applies pending DB on boot).
      let tries = 0;
      const timer = setInterval(async () => {
        tries += 1;
        try {
          await api.get('/settings/app');
          clearInterval(timer);
          setRestoreJob({ fileName: selectedFile.name, phase: 'done', percent: 100 });
          flash('Database restored and API is back online.');
          load();
          clearSelectedFile();
          setBusy(false);
          window.setTimeout(() => setRestoreJob(null), 2000);
        } catch {
          if (tries >= 40) {
            clearInterval(timer);
            setRestoreJob({
              fileName: selectedFile.name,
              phase: 'error',
              error: 'Restore staged but the API did not come back in time. Restart: sudo systemctl restart mt-billing-api',
            });
            flash('Restore staged. If the panel stays offline, restart: sudo systemctl restart mt-billing-api');
            setBusy(false);
          }
        }
      }, 1500);
      return;
    } catch (e: any) {
      const status = e?.response?.status;
      const msg =
        e?.response?.data?.error ||
        (status === 413
          ? 'Upload rejected (file too large). Raise nginx client_max_body_size to 100m and retry.'
          : e?.message || 'Restore failed.');
      setRestoreJob({ fileName: selectedFile.name, phase: 'error', error: msg });
      flash(msg);
      setBusy(false);
    }
  };

  const download = async (name: string) => {
    if (downloadJob) return;
    setDownloadJob({ name, phase: 'preparing', percent: 0 });
    try {
      const r = await api.get(`/db/backups/${name}/download`, {
        responseType: 'blob',
        onDownloadProgress: (ev) => {
          if (!ev.total) return;
          const percent = Math.min(100, Math.round((ev.loaded / ev.total) * 100));
          setDownloadJob((job) =>
            job?.name === name ? { ...job, phase: 'downloading', percent } : job
          );
        },
      });
      setDownloadJob({ name, phase: 'starting', percent: 100 });
      const url = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setDownloadJob({ name, phase: 'done', percent: 100 });
      window.setTimeout(() => setDownloadJob(null), 1500);
    } catch (e: any) {
      const blob = e?.response?.data;
      let message = e?.message || 'Download failed';
      if (blob instanceof Blob) {
        try {
          const text = await blob.text();
          const parsed = JSON.parse(text);
          if (parsed?.error) message = parsed.error;
        } catch {
          /* ignore */
        }
      } else if (e?.response?.data?.error) {
        message = e.response.data.error;
      }
      setDownloadJob({ name, phase: 'error', error: message });
    }
  };

  const del = async (name: string) => {
    await api.delete(`/db/backups/${name}`);
    load();
  };

  const fmtSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`);

  const downloadMessage =
    downloadJob?.phase === 'preparing'
      ? 'Preparing backup file…'
      : downloadJob?.phase === 'downloading'
        ? `Downloading… ${downloadJob.percent ?? 0}%`
        : downloadJob?.phase === 'starting'
          ? 'Starting save to your device…'
          : downloadJob?.phase === 'done'
            ? 'Download started.'
            : downloadJob?.error || 'Download failed';

  const restoreMessage =
    restoreJob?.phase === 'uploading'
      ? `Uploading backup… ${restoreJob.percent ?? 0}%`
      : restoreJob?.phase === 'restarting'
        ? 'Backup uploaded. Restarting API and applying database…'
        : restoreJob?.phase === 'done'
          ? 'Database restored successfully.'
          : restoreJob?.error || 'Restore failed';

  return (
    <SettingsSection icon={DbIcon} title="Database Management">
      {restoreJob && (
        <Modal
          title="Database restore"
          subtitle={restoreJob.fileName}
          onClose={() => {
            if (restoreJob.phase === 'uploading' || restoreJob.phase === 'restarting') return;
            setRestoreJob(null);
          }}
          maxWidth="sm"
        >
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              {restoreJob.phase === 'error' ? (
                <div className="w-10 h-10 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center shrink-0">
                  <AlertCircle size={18} />
                </div>
              ) : restoreJob.phase === 'done' ? (
                <div className="w-10 h-10 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
                  <FileCheck size={18} />
                </div>
              ) : (
                <Loader2 size={28} className="animate-spin text-amber-600 shrink-0" />
              )}
              <p className="text-sm text-slate-700 leading-relaxed">{restoreMessage}</p>
            </div>
            {restoreJob.phase === 'uploading' && typeof restoreJob.percent === 'number' && (
              <div className="space-y-1.5">
                <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                  <div
                    className="h-full bg-amber-500 transition-all duration-200"
                    style={{ width: `${restoreJob.percent}%` }}
                  />
                </div>
                <p className="text-xs text-slate-400 text-right">{restoreJob.percent}%</p>
              </div>
            )}
            {(restoreJob.phase === 'restarting' || (restoreJob.phase === 'uploading' && restoreJob.percent === 100)) && (
              <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                <div className="h-full w-1/3 bg-amber-500/70 animate-pulse" />
              </div>
            )}
            {restoreJob.phase === 'error' && (
              <button type="button" className="btn-secondary w-full" onClick={() => setRestoreJob(null)}>
                Close
              </button>
            )}
          </div>
        </Modal>
      )}
      {downloadJob && (
        <Modal
          title="Backup download"
          subtitle={downloadJob.name}
          onClose={() => {
            if (downloadJob.phase === 'preparing' || downloadJob.phase === 'downloading' || downloadJob.phase === 'starting') {
              return;
            }
            setDownloadJob(null);
          }}
          maxWidth="sm"
        >
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              {downloadJob.phase === 'error' ? (
                <div className="w-10 h-10 rounded-full bg-rose-50 text-rose-600 flex items-center justify-center shrink-0">
                  <AlertCircle size={18} />
                </div>
              ) : downloadJob.phase === 'done' ? (
                <div className="w-10 h-10 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center shrink-0">
                  <Download size={18} />
                </div>
              ) : (
                <Loader2 size={28} className="animate-spin text-brand-600 shrink-0" />
              )}
              <p className="text-sm text-slate-700 leading-relaxed">{downloadMessage}</p>
            </div>
            {downloadJob.phase === 'downloading' && typeof downloadJob.percent === 'number' && (
              <div className="space-y-1.5">
                <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                  <div
                    className="h-full bg-brand-500 transition-all duration-200"
                    style={{ width: `${downloadJob.percent}%` }}
                  />
                </div>
                <p className="text-xs text-slate-400 text-right">{downloadJob.percent}%</p>
              </div>
            )}
            {(downloadJob.phase === 'preparing' || downloadJob.phase === 'starting') && (
              <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                <div className="h-full w-1/3 bg-brand-500/70 animate-pulse" />
              </div>
            )}
            {downloadJob.phase === 'error' && (
              <button type="button" className="btn-secondary w-full" onClick={() => setDownloadJob(null)}>
                Close
              </button>
            )}
          </div>
        </Modal>
      )}
      <div className="space-y-5">
        <button className="w-full flex items-center justify-center gap-2 bg-sky-600 hover:bg-sky-700 text-white font-medium py-2.5 rounded-lg" onClick={createBackup} disabled={busy}>
          <DbIcon size={16} /> Create New Backup
        </button>

        <div className="rounded-lg bg-amber-50/60 border border-amber-100 p-4">
          <div className="text-sm font-semibold text-slate-700 mb-2">Restore from downloaded backup</div>
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <button type="button" className="btn-primary" onClick={() => fileRef.current?.click()} disabled={busy}>
              Choose file
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".db,.sqlite,application/octet-stream,application/x-sqlite3"
              className="hidden"
              onChange={onFile}
            />
            {selectedFile && (
              <button type="button" className="text-sm text-slate-500 hover:text-rose-600" onClick={clearSelectedFile} disabled={busy}>
                Clear
              </button>
            )}
          </div>
          {selectedFile ? (
            <div
              className={`mb-3 rounded-lg border px-3 py-2.5 flex items-start gap-3 ${
                selectedFile.status === 'error'
                  ? 'border-rose-200 bg-rose-50/50'
                  : selectedFile.status === 'ready'
                    ? 'border-emerald-200 bg-emerald-50/40'
                    : 'border-amber-200 bg-white/80'
              }`}
            >
              {selectedFile.status === 'reading' ? (
                <Loader2 size={18} className="animate-spin text-amber-600 shrink-0 mt-0.5" />
              ) : selectedFile.status === 'ready' ? (
                <FileCheck size={18} className="text-emerald-600 shrink-0 mt-0.5" />
              ) : (
                <AlertCircle size={18} className="text-rose-600 shrink-0 mt-0.5" />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-slate-800 truncate">{selectedFile.name}</div>
                <div className="text-xs text-slate-500 mt-0.5">{fmtSize(selectedFile.size)}</div>
                <div className="text-xs mt-1 text-slate-600">
                  {selectedFile.status === 'reading' && 'Reading backup file…'}
                  {selectedFile.status === 'ready' && 'Ready to upload. Click Upload & Restore below.'}
                  {selectedFile.status === 'error' && (selectedFile.error || 'Could not use this file.')}
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-500 mb-3">No backup file selected.</p>
          )}
          <p className="text-xs text-slate-500 mb-3">
            Use a panel backup (<code className="text-slate-600">.db</code> / <code className="text-slate-600">.sqlite</code>).
            After upload the API restarts to load it.
          </p>
          <button
            type="button"
            className="w-full flex items-center justify-center gap-2 bg-amber-400 hover:bg-amber-500 text-white font-medium py-2.5 rounded-lg disabled:opacity-60"
            onClick={restore}
            disabled={busy || selectedFile?.status !== 'ready' || !fileData}
          >
            <Upload size={16} className={busy ? 'animate-pulse' : ''} /> {busy ? 'Restoring…' : 'Upload & Restore'}
          </button>
        </div>

        <div>
          <div className="text-sm font-semibold text-slate-700 mb-2">Available Backups</div>
          {backups.length === 0 ? (
            <div className="text-center text-slate-400 py-6">No database backups found.</div>
          ) : (
            <div className="divide-y divide-slate-100 border border-slate-100 rounded-lg">
              {backups.map((b) => (
                <div key={b.name} className="flex items-center justify-between px-4 py-2.5 text-sm">
                  <div>
                    <div className="text-slate-700 font-medium">{b.name}</div>
                    <div className="text-xs text-slate-400">{new Date(b.created).toLocaleString()} · {fmtSize(b.size)}</div>
                  </div>
                  <div className="flex items-center gap-3 text-slate-400">
                    <button
                      title="Download"
                      className="hover:text-sky-600 disabled:opacity-40"
                      disabled={!!downloadJob}
                      onClick={() => download(b.name)}
                    >
                      {downloadJob?.name === b.name ? (
                        <Loader2 size={16} className="animate-spin text-sky-600" />
                      ) : (
                        <Download size={16} />
                      )}
                    </button>
                    <button title="Delete" className="hover:text-rose-600" onClick={() => del(b.name)}><Trash2 size={16} /></button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}

function AiSettings({ app, setA, save }: any) {
  const [key, setKey] = useState('');
  return (
    <SettingsSection icon={Bot} title="AI Settings">
      <div className="space-y-4 max-w-2xl">
        <p className="text-sm text-slate-500">
          Full Claude &amp; Cursor API setup lives under{' '}
          <a href="/ai-scripting" className="text-brand-600 hover:underline font-medium">AI Scripting → Setup</a>.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="w-4 h-4" checked={!!app.ai_enabled} onChange={(e) => setA({ ai_enabled: e.target.checked ? 1 : 0 })} /> Enable AI Scripting assistant
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm font-semibold text-slate-700 mb-1 block">Default provider</span>
            <select className="input" value={app.ai_provider} onChange={(e) => setA({ ai_provider: e.target.value })}>
              <option value="anthropic">Claude (Anthropic)</option>
              <option value="cursor">Cursor Cloud Agents</option>
              <option value="openai">OpenAI</option>
              <option value="google">Google Gemini</option>
              <option value="ollama">Ollama (local)</option>
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-semibold text-slate-700 mb-1 block">Claude model</span>
            <input className="input" value={app.ai_model} onChange={(e) => setA({ ai_model: e.target.value })} placeholder="claude-sonnet-4-20250514" />
          </label>
        </div>
        <label className="block">
          <span className="text-sm font-semibold text-slate-700 mb-1 block">Claude API Key {app.ai_api_key_set && <span className="text-emerald-600 text-xs">(saved)</span>}</span>
          <input className="input" type="password" placeholder={app.ai_api_key_set ? '••••••• (leave blank to keep)' : 'sk-ant-...'} value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        <div className="flex justify-end">
          <button className="btn-primary" onClick={() => save(key ? { ai_api_key: key } : {})}>Save AI Settings</button>
        </div>
      </div>
    </SettingsSection>
  );
}

function TimeSync({ app, setA, save, flash }: any) {
  const [now, setNow] = useState('');
  const refresh = () => api.get('/time').then((r) => setNow(r.data.serverTime));
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 1000);
    return () => clearInterval(t);
  }, []);
  const syncNow = async () => {
    const r = await api.post('/time/sync');
    setNow(r.data.serverTime);
    flash('Time synchronized.');
  };
  const zones = ['Asia/Manila', 'Asia/Singapore', 'Asia/Tokyo', 'UTC', 'America/Los_Angeles', 'Europe/London'];
  return (
    <SettingsSection icon={Clock} title="Time Synchronization">
      <div className="space-y-4 max-w-2xl">
        <div className="rounded-lg bg-slate-50 border border-slate-100 px-4 py-3">
          <div className="text-xs text-slate-400">Server time</div>
          <div className="text-lg font-semibold text-slate-800">{now ? new Date(now).toLocaleString('en-US', { timeZone: app.tz }) : '—'}</div>
          <div className="text-xs text-slate-400">{app.tz}</div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block">
            <span className="text-sm font-semibold text-slate-700 mb-1 block">Timezone</span>
            <select className="input" value={app.tz} onChange={(e) => setA({ tz: e.target.value })}>
              {zones.map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-semibold text-slate-700 mb-1 block">NTP Server</span>
            <input className="input" value={app.ntp_server} onChange={(e) => setA({ ntp_server: e.target.value })} />
          </label>
        </div>
        <div className="flex justify-end gap-2">
          <button className="inline-flex items-center gap-2 text-sm border border-slate-200 rounded-lg px-3 py-2 hover:bg-slate-50 text-slate-600" onClick={syncNow}><RefreshCw size={15} /> Sync now</button>
          <button className="btn-primary" onClick={() => save()}>Save Time Settings</button>
        </div>
      </div>
    </SettingsSection>
  );
}

function AccountReset({ flash }: any) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (pw.length < 6) {
      flash('Password must be at least 6 characters.');
      return;
    }
    if (pw !== confirm) {
      flash('Passwords do not match.');
      return;
    }
    if (!currentPassword && !recoveryKey.trim()) {
      flash('Enter your current password or a vendor recovery key.');
      return;
    }
    setBusy(true);
    try {
      await api.post('/account/reset-password', {
        newPassword: pw,
        currentPassword: currentPassword || undefined,
        recoveryKey: recoveryKey.trim() || undefined,
      });
      flash('Password updated.');
      setCurrentPassword('');
      setRecoveryKey('');
      setPw('');
      setConfirm('');
    } catch (e: any) {
      flash(e?.response?.data?.error || 'Could not update password.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection icon={KeyRound} title="Account Reset">
      <div className="space-y-4 max-w-md">
        <p className="text-sm text-slate-500">
          Change the password for the current panel account. You must confirm with your{' '}
          <b>current password</b> or a vendor <b>password recovery key</b> (from the activator).
        </p>
        <label className="block">
          <span className="text-sm font-semibold text-slate-700 mb-1 block">Current Password</span>
          <input className="input" type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} placeholder="Leave blank if using recovery key" />
        </label>
        <label className="block">
          <span className="text-sm font-semibold text-slate-700 mb-1 block">Or Recovery Key</span>
          <input className="input font-mono text-sm" value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value)} placeholder="RST-XXXX-XXXX-XXXX-XXXX" />
        </label>
        <label className="block">
          <span className="text-sm font-semibold text-slate-700 mb-1 block">New Password</span>
          <input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-sm font-semibold text-slate-700 mb-1 block">Confirm Password</span>
          <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        <button type="button" className="btn-primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Reset Password'}</button>
      </div>
    </SettingsSection>
  );
}

function RouterManagement({ flash }: any) {
  const [routers, setRouters] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);

  const load = () => api.get('/routers').then((r) => setRouters(r.data));
  useEffect(() => {
    load();
  }, []);

  const del = async (id: number) => {
    await api.delete(`/routers/${id}`);
    flash('Router removed.');
    load();
  };

  return (
    <SettingsSection icon={RouterIcon} title="Router Management">
      <div className="space-y-3">
        <div className="flex justify-end">
          <button className="btn-primary" onClick={() => setEdit({ name: '', host: '', port: 8728, ssh_port: 22, api_user: '', api_pass: '', board: '', type: 'pppoe', status: 'online' })}>
            <Plus size={16} /> Add Router
          </button>
        </div>
        <div className="border border-slate-100 rounded-lg divide-y divide-slate-100">
          {routers.map((r) => (
            <div key={r.id} className="flex items-center justify-between px-4 py-3">
              <div>
                <div className="font-medium text-slate-800">{r.name}</div>
                <div className="text-xs text-slate-400">{r.host}:{r.port} · SSH:{r.ssh_port ?? 22} · {(r.type || '').toUpperCase()} · {r.board || 'no board'}</div>
              </div>
              <div className="flex items-center gap-3 text-slate-400">
                <StatusBadge status={r.status} />
                <button className="hover:text-sky-600" onClick={() => setEdit(r)}><Pencil size={16} /></button>
                <button className="hover:text-rose-600" onClick={() => del(r.id)}><Trash2 size={16} /></button>
              </div>
            </div>
          ))}
          {routers.length === 0 && <div className="px-4 py-6 text-center text-slate-400 text-sm">No routers configured.</div>}
        </div>
      </div>

      {edit && (
        <RouterModal
          router={edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            flash('Router saved.');
            load();
          }}
        />
      )}
    </SettingsSection>
  );
}

function RouterModal({ router, onClose, onSaved }: any) {
  const [form, setForm] = useState({ ...router, api_pass: '' });
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const isEdit = !!router.id;
  const set = (patch: any) => setForm((f: any) => ({ ...f, ...patch }));
  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.post('/routers/test', { ...form, id: router.id });
      setTestResult(r.data);
      if (r.data.board) set({ board: r.data.board });
    } catch (e: any) {
      setTestResult({ online: false, error: e?.response?.data?.error || 'Test failed' });
    } finally {
      setTesting(false);
    }
  };
  const save = async () => {
    if (!form.name?.trim()) return;
    setBusy(true);
    try {
      if (isEdit) await api.put(`/routers/${router.id}`, form);
      else await api.post('/routers', form);
      onSaved();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={isEdit ? 'Edit Router' : 'Add Router'}
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between w-full gap-2">
          <button type="button" className="btn-secondary" onClick={test} disabled={testing || !form.host}>
            <Wifi size={16} className={testing ? 'animate-pulse' : ''} />
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <ModalFooter onCancel={onClose} onConfirm={save} busy={busy} />
        </div>
      }
    >
      <div className="space-y-3">
        {testResult && (
          <div
            className={`text-sm rounded-lg px-3 py-2 ${
              testResult.online ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'
            }`}
          >
            {testResult.online ? (
              <>
                <b>Connected</b>
                {testResult.board && <> · Board: {testResult.board}</>}
                {testResult.identity && <> · Identity: {testResult.identity}</>}
                {testResult.version && <> · {testResult.version}</>}
              </>
            ) : (
              <>
                <b>Unreachable</b>
                {testResult.error && <> — {testResult.error}</>}
              </>
            )}
          </div>
        )}
        <FormField label="Name" required>
          <input className="input" value={form.name || ''} onChange={(e) => set({ name: e.target.value })} />
        </FormField>
        <div className="grid grid-cols-3 gap-3">
          <FormField label="Host / IP">
            <input className="input" value={form.host || ''} onChange={(e) => set({ host: e.target.value })} />
          </FormField>
          <FormField label="API Port">
            <input className="input" type="number" value={form.port || 8728} onChange={(e) => set({ port: Number(e.target.value) })} />
          </FormField>
          <FormField label="SSH Port">
            <input className="input" type="number" value={form.ssh_port ?? 22} onChange={(e) => set({ ssh_port: Number(e.target.value) })} />
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="API User">
            <input className="input" value={form.api_user || ''} onChange={(e) => set({ api_user: e.target.value })} />
          </FormField>
          <FormField label="API Password">
            <input className="input" type="password" placeholder={isEdit ? '(leave blank to keep)' : ''} value={form.api_pass || ''} onChange={(e) => set({ api_pass: e.target.value })} />
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Type">
            <select className="input" value={form.type || 'pppoe'} onChange={(e) => set({ type: e.target.value })}>
              <option value="pppoe">PPPoE</option>
              <option value="ipoe">IPoE</option>
            </select>
          </FormField>
          <FormField label="Board">
            <input className="input" value={form.board || ''} onChange={(e) => set({ board: e.target.value })} />
          </FormField>
        </div>
      </div>
    </Modal>
  );
}
