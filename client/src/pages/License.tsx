import { useEffect, useState } from 'react';
import { KeyRound, Copy, CheckCircle2, ShieldCheck, ShieldAlert } from 'lucide-react';
import Layout from '../components/Layout';
import { Card, Flash, FormField, LoadingPage, PageHeader } from '../components/ui';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { copyText } from '../lib/clipboard';

export default function License() {
  const { refresh } = useAuth();
  const [info, setInfo] = useState<any>(null);
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => api.get('/license').then((r) => setInfo(r.data));
  useEffect(() => {
    load();
  }, []);

  const copyHwid = async () => {
    if (!info?.hardwareId) return;
    const ok = await copyText(info.hardwareId);
    if (!ok) {
      setError('Could not copy Hardware ID — select the code and copy manually.');
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const activate = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post('/license/activate', { key });
      setKey('');
      await load();
      await refresh();
    } catch (e: any) {
      setError(e?.response?.data?.error || 'Activation failed');
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async () => {
    await api.post('/license/deactivate');
    await load();
    await refresh();
  };

  if (!info) return <Layout title="License" allowWrite><LoadingPage /></Layout>;

  return (
    <Layout title="License" allowWrite>
      <PageHeader title="Panel License" description="Activate with a duration-bound license key from your vendor." icon={KeyRound} />
      <Flash message={error} type="error" onDismiss={() => setError('')} />

      <Card className="max-w-2xl" interactive>
        <div className="flex items-center gap-3 mb-6">
          <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${info.activated ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
            {info.activated ? <ShieldCheck size={24} /> : <ShieldAlert size={24} />}
          </div>
          <div>
            <div className="font-bold text-slate-800">{info.product} — {info.edition}</div>
            <div className="text-sm text-slate-500">
              {info.activated
                ? info.expiresAt
                  ? `Valid until ${new Date(info.expiresAt).toLocaleString()}`
                  : 'Lifetime license.'
                : info.expired
                  ? 'Previous license expired. Enter a new key.'
                  : 'Activate the panel with a license key. Until then only Dashboard and License are available.'}
            </div>
          </div>
        </div>

        <div className="space-y-5">
          <FormField label="Hardware ID" hint="Send this Hardware ID to your vendor. They will pick an expiration (30d / 90d / 1y / lifetime) when generating the key.">
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-slate-700 font-mono text-sm">{info.hardwareId}</code>
              <button type="button" className="btn-secondary shrink-0" onClick={copyHwid}>
                {copied ? <CheckCircle2 size={15} className="text-emerald-600" /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </FormField>

          {info.activated ? (
            <div className="rounded-xl bg-emerald-50 border border-emerald-100 p-4">
              <div className="text-sm text-emerald-700 flex items-center gap-2 font-medium"><ShieldCheck size={16} /> Licensed</div>
              <div className="text-xs text-slate-500 mt-1 font-mono">{info.licenseKey}</div>
              {info.duration && (
                <div className="text-xs text-slate-500 mt-1">Duration: {info.duration}</div>
              )}
              <button type="button" className="mt-3 text-sm text-rose-600 hover:text-rose-700 font-medium" onClick={deactivate}>Deactivate</button>
            </div>
          ) : (
            <FormField label="License Key">
              <div className="flex items-center gap-2">
                <input className="input font-mono" value={key} onChange={(e) => setKey(e.target.value)} placeholder="XXXXX-XXXXX-XXXXX-XXXXX-1Y" />
                <button type="button" className="btn-primary shrink-0" data-allow-write onClick={activate} disabled={busy || !key.trim()}>
                  {busy ? 'Activating…' : 'Activate'}
                </button>
              </div>
            </FormField>
          )}
        </div>
      </Card>
    </Layout>
  );
}
