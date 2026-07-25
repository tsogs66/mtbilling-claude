import { useEffect, useState } from 'react';
import { AlertTriangle, Check, RefreshCw, ShieldAlert } from 'lucide-react';
import Layout from '../components/Layout';
import { Card, FormField } from '../components/ui';
import { api } from '../api';
import { formatBps } from '../lib/traffic';

export default function FairUseAlerts() {
  const [alerts, setAlerts] = useState<any[]>([]);
  const [settings, setSettings] = useState<any>({
    enabled: 1,
    cap_percent: 95,
    sustain_minutes: 10,
    notify_email: 1,
    notify_sms: 0,
  });
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');

  const load = () =>
    api.get('/usage/alerts').then((r) => {
      setAlerts(r.data.alerts || []);
      if (r.data.settings) setSettings(r.data.settings);
    });

  useEffect(() => {
    load().catch(() => undefined);
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      const r = await api.put('/usage/settings', settings);
      setSettings(r.data);
      setToast('Fair-use settings saved.');
      setTimeout(() => setToast(''), 3000);
    } finally {
      setBusy(false);
    }
  };

  const ack = async (id: number) => {
    await api.post(`/usage/alerts/${id}/ack`);
    load();
  };

  return (
    <Layout title="Fair Use Alerts">
      {toast && (
        <div className="mb-4 text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">{toast}</div>
      )}

      <div className="grid lg:grid-cols-3 gap-4 mb-6">
        <Card title="Thresholds" icon={ShieldAlert} className="lg:col-span-1">
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={!!settings.enabled}
                onChange={(e) => setSettings((s: any) => ({ ...s, enabled: e.target.checked ? 1 : 0 }))}
              />
              Enable fair-use monitoring
            </label>
            <FormField label="Alert when usage ≥ % of plan rate-limit">
              <input
                type="number"
                className="input"
                min={50}
                max={100}
                value={settings.cap_percent ?? 95}
                onChange={(e) => setSettings((s: any) => ({ ...s, cap_percent: Number(e.target.value) }))}
              />
            </FormField>
            <FormField label="Sustain minutes before alert">
              <input
                type="number"
                className="input"
                min={1}
                value={settings.sustain_minutes ?? 10}
                onChange={(e) => setSettings((s: any) => ({ ...s, sustain_minutes: Number(e.target.value) }))}
              />
            </FormField>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={!!settings.notify_email}
                onChange={(e) => setSettings((s: any) => ({ ...s, notify_email: e.target.checked ? 1 : 0 }))}
              />
              Email subscriber
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={!!settings.notify_sms}
                onChange={(e) => setSettings((s: any) => ({ ...s, notify_sms: e.target.checked ? 1 : 0 }))}
              />
              SMS subscriber
            </label>
            <button type="button" className="btn-primary w-full" disabled={busy} onClick={save}>
              Save settings
            </button>
          </div>
        </Card>

        <Card title="Recent alerts" icon={AlertTriangle} className="lg:col-span-2" noPadding>
          <div className="px-4 py-3 border-b border-slate-100 flex justify-end">
            <button type="button" className="btn-secondary" onClick={() => load()}>
              <RefreshCw size={14} /> Refresh
            </button>
          </div>
          <div className="divide-y divide-slate-50">
            {alerts.map((a) => (
              <div key={a.id} className="px-4 py-3 flex items-start gap-3">
                <AlertTriangle size={16} className={`mt-1 shrink-0 ${a.acknowledged ? 'text-slate-300' : 'text-amber-500'}`} />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-slate-800">
                    {a.username || 'Unknown'} <span className="text-slate-400 font-normal">· {a.customer}</span>
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    Sustained {formatBps(a.observed_bps)} (cap {formatBps(a.threshold_bps)}) on plan {a.profile} ·{' '}
                    {a.created_at}
                  </div>
                </div>
                {!a.acknowledged && (
                  <button type="button" className="btn-secondary text-xs" onClick={() => ack(a.id)}>
                    <Check size={14} /> Ack
                  </button>
                )}
              </div>
            ))}
            {alerts.length === 0 && (
              <div className="px-4 py-10 text-center text-sm text-slate-400">No fair-use alerts yet.</div>
            )}
          </div>
        </Card>
      </div>
    </Layout>
  );
}
