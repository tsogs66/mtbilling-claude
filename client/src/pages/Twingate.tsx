import { useEffect, useRef, useState } from 'react';
import { Globe2, Loader2, RefreshCw, Settings, Shield } from 'lucide-react';
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
    api.get('/twingate').then((r) => setData(r.data)).catch(() => setData({ configured: false, online: false, status: 'stopped', message: 'Could not load Twingate status.' }));
    api.get('/twingate/settings').then((r) => {
      setSettings(r.data);
      setForm((f) => ({ ...f, nodeName: r.data.nodeName || '' }));
      if (!r.data.serviceKeySet) setSetupOpen(true);
    });
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
                ? action === 'stop'
                  ? 'Twingate stopped.'
                  : 'Twingate is connected.'
                : `${action} failed (exit ${code}). See log below.`,
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
        <div className="flex gap-2">
          <button type="button" className="btn-secondary shrink-0" onClick={load}>
            <RefreshCw size={16} /> Refresh
          </button>
          <button type="button" className="btn-secondary shrink-0" onClick={() => setSetupOpen((v) => !v)}>
            <Settings size={16} /> Setup
          </button>
        </div>
      </div>

      {setupOpen && (
        <Card title="Twingate setup" className="max-w-4xl mb-5" interactive>
          <div className="space-y-3">
            <p className="text-sm text-slate-500">
              In Twingate Admin: create a <b>Connector</b> on the remote LAN, add <b>Resources</b> (OLT/router CIDRs),
              create a <b>Service</b> + Service Key, and grant this Service access to those Resources. Paste the JSON key below.
            </p>
            <FormField
              label="Service Key (JSON)"
              hint={settings?.serviceKeySet ? 'Key is saved. Leave blank to keep current.' : 'From Admin Console → Services → Service Key'}
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
                {data.online ? 'Disconnect' : 'Start'}
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
            </div>
          </div>
          <div className="ml-auto">
            <StatusBadge status={data.online ? 'online' : data.status === 'error' ? 'offline' : data.status || 'offline'} />
          </div>
        </div>
        {data.message && <p className="text-sm text-amber-700 mt-3">{data.message}</p>}
        {data.warning && <p className="text-sm text-rose-600 mt-2">{data.warning}</p>}
      </Card>

      {job && (
        <Card title={`Job: ${job.action}${job.running ? ' (running)' : ''}`} className="max-w-4xl mb-5" interactive>
          <pre ref={logRef} className="text-xs font-mono bg-slate-950 text-slate-200 rounded-lg p-3 max-h-64 overflow-auto whitespace-pre-wrap">
            {job.log || 'Waiting for output…'}
          </pre>
        </Card>
      )}
    </Layout>
  );
}
