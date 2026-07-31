import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Globe2, Loader2, RefreshCw, Settings, Shield, Unplug } from 'lucide-react';
import Layout from '../components/Layout';
import { Card, Flash, FormField, LoadingPage, PageHeader, StatusBadge } from '../components/ui';
import { api } from '../api';

type TgJob = { action: string; log: string; running: boolean; code: number | null; startedAt: number };

/**
 * Twingate headless client — lets this panel reach OLTs / routers on remote
 * or different subnets through a Twingate Connector on that LAN.
 */
export default function Twingate() {
  const [data, setData] = useState<any>(null);
  const [settings, setSettings] = useState<any>(null);
  const [setupOpen, setSetupOpen] = useState(true);
  const [form, setForm] = useState({ serviceKey: '', nodeName: '' });
  const [flash, setFlash] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<TgJob | null>(null);
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

  const load = () => {
    // Fast path: DB-only /twingate (never shells out — Proxmox UI must not hang).
    api
      .get('/twingate', { timeout: 5000 })
      .then((r) => {
        setData(r.data);
        setSettings((s: any) => s || {
          serviceKeySet: !!r.data.configured,
          network: r.data.network,
          nodeName: r.data.nodeName,
          status: r.data.status,
        });
        setForm((f) => ({ ...f, nodeName: r.data.nodeName || f.nodeName || '' }));
        if (!r.data.configured) setSetupOpen(true);
      })
      .catch(() =>
        setData((prev: any) => ({
          configured: prev?.configured ?? false,
          online: false,
          status: prev?.status || 'stopped',
          network: prev?.network || '',
          nodeName: prev?.nodeName || 'panel-host',
          message: 'Could not load Twingate status from the panel API.',
        }))
      );

    // Background live probe (may be slow) — never blocks first paint
    api
      .get('/twingate/live', { timeout: 6000 })
      .then((r) => setData(r.data))
      .catch(() => {
        /* keep fast snapshot */
      });

    api
      .get('/twingate/settings', { timeout: 5000 })
      .then((r) => {
        setSettings(r.data);
        setForm((f) => ({ ...f, nodeName: r.data.nodeName || '' }));
        if (!r.data.serviceKeySet) setSetupOpen(true);
      })
      .catch(() => {
        /* ignore */
      });
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-refresh while the client is still authenticating with Twingate.
  useEffect(() => {
    if (!data?.connecting && data?.status !== 'authenticating') return;
    const id = window.setInterval(() => load(), 5000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.connecting, data?.status]);

  const save = async () => {
    setSaving(true);
    try {
      await api.put('/twingate/settings', {
        serviceKey: form.serviceKey || undefined,
        nodeName: form.nodeName,
      });
      setFlash({ type: 'success', msg: 'Twingate settings saved.' });
      setForm((f) => ({ ...f, serviceKey: '' }));
      load();
    } catch (e: any) {
      setFlash({ type: 'error', msg: e?.response?.data?.error || 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  const pollJob = (action: string) => {
    stopJobPoll();
    const startedAt = Date.now();
    setJob({ action, log: '', running: true, code: null, startedAt });
    setElapsed(0);
    const tick = async () => {
      try {
        const r = await api.get('/twingate/job');
        setElapsed(Math.round((Date.now() - startedAt) / 1000));
        setJob((j) => (j ? { ...j, log: r.data.log || '' } : j));
        if (!r.data.running) {
          stopJobPoll();
          const code = r.data.code;
          setJob((j) => (j ? { ...j, running: false, code } : j));
          setFlash({
            type: code === 0 ? 'success' : 'error',
            msg:
              code === 0
                ? action === 'stop' || action === 'emergency-restore'
                  ? 'Twingate stopped and host DNS restored.'
                  : 'Twingate apply finished. If status is authenticating, wait for the Connector / Resources in Twingate Admin.'
                : `${action} failed (exit ${code}). If the panel lost internet, run Emergency restore (or SSH: sudo bash /opt/mt-billing/install/mt-billing-twingate.sh emergency-restore).`,
          });
          load();
          setBusy(false);
        }
      } catch {
        /* keep polling */
      }
    };
    void tick();
    jobPollRef.current = window.setInterval(tick, 1000);
  };

  const apply = async () => {
    setBusy(true);
    try {
      if (form.serviceKey.trim()) await save();
      await api.post('/twingate/apply');
      pollJob('apply');
    } catch (e: any) {
      setBusy(false);
      setFlash({ type: 'error', msg: e?.response?.data?.error || 'Apply failed' });
    }
  };

  const toggle = async () => {
    setBusy(true);
    try {
      const r = await api.post('/twingate/toggle');
      pollJob(r.data.action || 'toggle');
    } catch (e: any) {
      setBusy(false);
      setFlash({ type: 'error', msg: e?.response?.data?.error || 'Toggle failed' });
    }
  };

  const emergencyRestore = async () => {
    if (!confirm('Stop Twingate and restore host DNS? Use this if the panel lost internet after connecting.')) return;
    setBusy(true);
    try {
      await api.post('/twingate/emergency-restore');
      pollJob('emergency-restore');
    } catch (e: any) {
      setBusy(false);
      setFlash({ type: 'error', msg: e?.response?.data?.error || 'Emergency restore failed' });
    }
  };

  if (!data) {
    return (
      <Layout title="Twingate">
        <LoadingPage />
      </Layout>
    );
  }

  return (
    <Layout title="Twingate">
      {flash && <Flash type={flash.type} message={flash.msg} onDismiss={() => setFlash(null)} />}

      <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
        <PageHeader
          title="Twingate Remote Access"
          description="Connect this panel to OLTs and devices on other subnets via Twingate ZTNA."
          icon={Globe2}
        />
        <div className="flex gap-2 flex-wrap">
          <button type="button" className="btn-secondary shrink-0" onClick={load}>
            <RefreshCw size={16} /> Refresh
          </button>
          <button
            type="button"
            className="btn-secondary shrink-0 text-rose-700 border-rose-200"
            onClick={emergencyRestore}
            disabled={busy}
          >
            <Unplug size={16} /> Emergency restore
          </button>
          <button
            type="button"
            className="btn-secondary shrink-0"
            onClick={async () => {
              setBusy(true);
              try {
                await api.post('/twingate/coexist');
                pollJob('coexist');
              } catch (e: any) {
                setBusy(false);
                setFlash({ type: 'error', msg: e?.response?.data?.error || 'Coexist apply failed' });
              }
            }}
            disabled={busy}
          >
            <Shield size={16} /> Fix LAN coexistence
          </button>
          <button type="button" className="btn-secondary shrink-0" onClick={() => setSetupOpen((v) => !v)}>
            <Settings size={16} /> Setup
          </button>
        </div>
      </div>

      <Card className="max-w-4xl mb-5 border-sky-200 bg-sky-50/50" interactive>
        <div className="flex gap-3 text-sm text-sky-950">
          <Globe2 size={18} className="shrink-0 mt-0.5 text-sky-600" />
          <div className="space-y-1">
            <p className="font-semibold">Connector vs this panel (Client)</p>
            <p>
              <b>Connectors</b> (Admin → Connectors) sit on a LAN and publish it into Twingate. You already have
              Connected ones on Homelab — use those. A Connector named like <code className="font-mono text-xs">mtbilling</code>{' '}
              that says <b>Not yet connected</b> was never deployed; this page does <b>not</b> install Connectors.
            </p>
            <p>
              This page installs a headless <b>Client</b> with a <b>Service Key</b> (Admin → Services) so the panel can{' '}
              <i>reach</i> Resources through your existing Connectors. Paste a Service Key below — not a Connector
              deploy token.
            </p>
          </div>
        </div>
      </Card>

      {data.tunOk === false && (
        <Card className="max-w-4xl mb-5 border-rose-200 bg-rose-50/70" interactive>
          <div className="flex gap-3 text-sm text-rose-950">
            <AlertTriangle size={18} className="shrink-0 mt-0.5 text-rose-600" />
            <div className="space-y-1">
              <p className="font-semibold">Missing /dev/net/tun (Twingate cannot start)</p>
              <p>
                Works on Proxmox once TUN is passed into the LXC. On <b>Raspberry Pi / Dell Wyse / PC flash</b> images,
                load the kernel module first:
              </p>
              <pre className="text-xs font-mono bg-white/90 border border-rose-200 rounded-lg px-3 py-2 overflow-x-auto whitespace-pre-wrap">
                {`sudo modprobe tun
ls -l /dev/net/tun
echo tun | sudo tee /etc/modules-load.d/tun.conf
# then retry Install & connect`}
              </pre>
              <p className="text-xs">
                Raspberry Pi 3 must be <b>64-bit</b> (<code className="font-mono">mt-billing-rpi-arm64</code> /{' '}
                <code className="font-mono">aarch64</code>). Twingate has no 32-bit armhf client. Wyse 3040 uses{' '}
                <code className="font-mono">mt-billing-pc-usb-amd64</code>.
              </p>
              <p className="text-xs">
                Proxmox LXC only: on the host run{' '}
                <code className="font-mono">scripts/proxmox-enable-twingate-tun.sh CTID</code> then{' '}
                <code className="font-mono">pct reboot CTID</code>.
              </p>
            </div>
          </div>
        </Card>
      )}

      {data.unsupportedArch && (
        <Card className="max-w-4xl mb-5 border-rose-200 bg-rose-50/70" interactive>
          <div className="flex gap-3 text-sm text-rose-950">
            <AlertTriangle size={18} className="shrink-0 mt-0.5 text-rose-600" />
            <div className="space-y-1">
              <p className="font-semibold">Unsupported CPU architecture for Twingate ({data.arch})</p>
              <p>
                Re-flash Raspberry Pi with the 64-bit image <code className="font-mono">mt-billing-rpi-arm64.img.xz</code>.
                Twingate Client supports <b>amd64</b> and <b>arm64</b> only.
              </p>
            </div>
          </div>
        </Card>
      )}

      <Card className="max-w-4xl mb-5 border-amber-200 bg-amber-50/60" interactive>
        <div className="flex gap-3 text-sm text-amber-900">
          <AlertTriangle size={18} className="shrink-0 mt-0.5 text-amber-600" />
          <div className="space-y-1">
            <p className="font-semibold">Cloudflare Tunnel + Twingate side-by-side</p>
            <p>
              Both can run together. After connecting Twingate, MT-Billing pins your local LAN routes and puts
              public DNS first so <b>cloudflared</b> and local devices keep working. Use <b>Fix LAN coexistence</b> anytime
              routes look wrong. Twingate Resources should be <b>specific remote device IPs</b> — never broad CIDRs that
              include this panel’s LAN.
            </p>
            <p>
              Twingate rewrites DNS to <code className="font-mono text-xs">100.95.*</code> by default; coexistence rewrites
              it to public/local first. If the panel still looks offline, click <b>Emergency restore</b>, or SSH:
            </p>
            <pre className="text-xs font-mono bg-white/80 border border-amber-200 rounded-lg px-3 py-2 overflow-x-auto">
              sudo bash /opt/mt-billing/install/mt-billing-twingate.sh emergency-restore
            </pre>
            <p>
              If SSH / remote terminal dies after Install &amp; connect, plug in a monitor+keyboard and run the same
              command (or <code className="font-mono text-xs">sudo bash /opt/mt-billing/install/mt-billing-net-rescue.sh</code>
              ). Then reconnect by <b>LAN IP</b>, not hostname.
            </p>
            <p>
              A <b>network watchdog</b> (installed on update / Twingate apply) rewrites DNS every minute if Twingate
              puts <code className="font-mono text-xs">100.95.*</code> first again — that is what causes login to fail
              &quot;after some time&quot; on Proxmox, RPi, and Wyse.
            </p>
            <p>
              In Twingate Admin: keep the Connector online, and define Resources as <b>specific device IPs</b> — not broad{' '}
              <code className="font-mono text-xs">192.168.0.0/16</code> ranges that include this panel.
            </p>
          </div>
        </div>
      </Card>

      {setupOpen && (
        <Card title="Twingate setup" className="max-w-4xl mb-5" interactive>
          <div className="space-y-3">
            <p className="text-sm text-slate-500">
              Use a <b>Service Key</b> (Admin → Services) — headless auth is automatic; there is no Accept / approve
              click. You need: an online <b>Connector</b> (your Proxmox one is fine), <b>Resources</b> (OLT/router IPs),
              and this Service granted those Resources. Paste the JSON key below, then Install &amp; connect.
            </p>
            <FormField
              label="Service Key (JSON)"
              hint={
                settings?.serviceKeySet
                  ? 'Key is saved. Leave blank to keep current.'
                  : 'From Admin Console → Services → Service Key'
              }
            >
              <textarea
                className="input font-mono text-xs min-h-[120px]"
                placeholder={settings?.serviceKeySet ? '•••••••• (saved)' : '{"version":"1","network":"…",…}'}
                value={form.serviceKey}
                onChange={(e) => setForm({ ...form, serviceKey: e.target.value })}
              />
            </FormField>
            <FormField label="Node name (this panel)">
              <input
                className="input"
                value={form.nodeName}
                onChange={(e) => setForm({ ...form, nodeName: e.target.value })}
                placeholder="mt-billing-panel"
              />
            </FormField>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-secondary" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save settings'}
              </button>
              <button type="button" className="btn-primary" onClick={apply} disabled={busy}>
                {busy && job?.running ? (
                  <>
                    <Loader2 size={16} className="animate-spin" /> Working… {elapsed}s
                  </>
                ) : (
                  'Install & connect'
                )}
              </button>
              <button type="button" className="btn-secondary" onClick={toggle} disabled={busy || !data.configured}>
                {data.online || data.connecting || data.status === 'authenticating' ? 'Disconnect' : 'Start'}
              </button>
            </div>
          </div>
        </Card>
      )}

      <Card className="max-w-4xl mb-5" interactive>
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center">
            <Shield size={20} />
          </div>
          <div>
            <div className="font-bold text-slate-800">{data.nodeName || 'panel-host'}</div>
            <div className="text-xs text-slate-400">
              {data.network ? `Network: ${data.network}` : 'Network not configured'}
              {data.installed ? ' · Client installed' : ' · Client not installed'}
              {typeof data.resourceCount === 'number' ? ` · ${data.resourceCount} resource(s)` : ''}
              {data.dns ? ` · DNS: ${data.dns}` : ''}
            </div>
          </div>
          <div className="ml-auto">
            <StatusBadge
              status={
                data.online
                  ? 'online'
                  : data.status === 'authenticating' || data.connecting
                    ? 'authenticating'
                    : data.status === 'error'
                      ? 'offline'
                      : data.status || 'offline'
              }
            />
          </div>
        </div>
        {data.message && <p className="text-sm text-amber-700 mt-3">{data.message}</p>}
        {data.warning && <p className="text-sm text-rose-600 mt-2">{data.warning}</p>}
      </Card>

      {job && (
        <Card title={`Job: ${job.action}${job.running ? ' (running)' : ''}`} className="max-w-4xl mb-5" interactive>
          <pre
            ref={logRef}
            className="text-xs font-mono bg-slate-950 text-slate-200 rounded-lg p-3 max-h-64 overflow-auto whitespace-pre-wrap"
          >
            {job.log || 'Waiting for output…'}
          </pre>
        </Card>
      )}
    </Layout>
  );
}
