import { useEffect, useState } from 'react';
import { Globe, Settings } from 'lucide-react';
import Layout from '../components/Layout';
import { Card, StatusBadge, DataTable, LoadingPage, PageHeader, FormField, Flash } from '../components/ui';
import { api } from '../api';

export default function ZeroTier() {
  const [data, setData] = useState<any>(null);
  const [settings, setSettings] = useState<any>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [form, setForm] = useState({ apiToken: '', networkId: '', nodeName: '' });
  const [flash, setFlash] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () => {
    api.get('/zerotier').then((r) => setData(r.data));
    api.get('/zerotier/settings').then((r) => {
      setSettings(r.data);
      setForm((f) => ({ ...f, networkId: r.data.networkId || '', nodeName: r.data.nodeName || '' }));
    });
  };

  useEffect(() => {
    load();
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await api.put('/zerotier/settings', {
        apiToken: form.apiToken || undefined,
        networkId: form.networkId,
        nodeName: form.nodeName,
      });
      setFlash({ type: 'success', msg: 'ZeroTier settings saved.' });
      setSetupOpen(false);
      setForm((f) => ({ ...f, apiToken: '' }));
      load();
    } catch (e: any) {
      setFlash({ type: 'error', msg: e?.response?.data?.error || 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  if (!data) return <Layout title="ZeroTier"><LoadingPage /></Layout>;

  return (
    <Layout title="ZeroTier">
      {flash && <Flash type={flash.type} message={flash.msg} onDismiss={() => setFlash(null)} />}

      <div className="flex items-center justify-between mb-6">
        <PageHeader title="ZeroTier Networks" description="Configure ZeroTier controller access and view network status." icon={Globe} />
        <button type="button" className="btn-secondary shrink-0" onClick={() => setSetupOpen((v) => !v)}>
          <Settings size={16} /> Setup
        </button>
      </div>

      {setupOpen && (
        <Card title="ZeroTier setup" className="max-w-4xl mb-5" interactive>
          <div className="space-y-3">
            <FormField label="API token" hint={settings?.apiTokenSet ? 'Token is saved. Leave blank to keep current.' : 'From my.zerotier.com → Account → API Access'}>
              <input
                className="input font-mono"
                type="password"
                placeholder={settings?.apiTokenSet ? '••••••••' : ''}
                value={form.apiToken}
                onChange={(e) => setForm({ ...form, apiToken: e.target.value })}
              />
            </FormField>
            <FormField label="Network ID" required>
              <input className="input font-mono" value={form.networkId} onChange={(e) => setForm({ ...form, networkId: e.target.value })} placeholder="8056c2e21c000001" />
            </FormField>
            <FormField label="Node name (this panel)">
              <input className="input" value={form.nodeName} onChange={(e) => setForm({ ...form, nodeName: e.target.value })} placeholder="panel-host" />
            </FormField>
            <button type="button" className="btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </Card>
      )}

      <Card className="max-w-4xl mb-5" interactive>
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-brand-50 text-brand-600 flex items-center justify-center"><Globe size={20} /></div>
          <div>
            <div className="font-bold text-slate-800">Node {data.address}</div>
            <div className="text-xs text-slate-400">
              {data.configured ? 'ZeroTier configured' : 'Not configured — use Setup above'}
            </div>
          </div>
          <div className="ml-auto"><StatusBadge status={data.online ? 'online' : 'offline'} /></div>
        </div>
        {data.message && <p className="text-sm text-amber-700 mt-3">{data.message}</p>}
      </Card>

      {data.networks.map((n: any) => (
        <Card key={n.id} title={n.name} className="max-w-4xl mb-5" interactive noPadding right={<span className="text-xs text-slate-400 font-mono">{n.id}</span>}>
          <div className="px-5 py-3 text-sm text-slate-500 border-b border-slate-100">
            Assigned IP: <span className="font-semibold text-slate-700">{n.assignedIp}</span> · Status: <StatusBadge status={n.status === 'OK' ? 'Active' : 'offline'} />
          </div>
          <div className="p-4">
            <DataTable
              columns={[
                { key: 'name', label: 'Member' },
                { key: 'ip', label: 'Managed IP' },
                { key: 'auth', label: 'Authorized' },
                { key: 'status', label: 'Status' },
              ]}
              rows={n.members.map((m: any) => ({
                key: m.name,
                cells: [
                  <span className="font-semibold text-slate-800">{m.name}</span>,
                  <span className="font-mono text-slate-600">{m.ip}</span>,
                  <StatusBadge status={m.authorized ? 'Active' : 'inactive'} />,
                  <StatusBadge status={m.online ? 'online' : 'offline'} />,
                ],
              }))}
              emptyMessage="No members in this network."
            />
          </div>
        </Card>
      ))}
    </Layout>
  );
}
