import { useEffect, useState } from 'react';
import { Radio, Plus, Pencil, Trash2, Wifi, RefreshCw } from 'lucide-react';
import { Card, StatusBadge, EmptyState, Modal, ModalFooter, FormField } from '../components/ui';
import { api } from '../api';

/** OLT inventory panel — Network tab: add by IP, probe online/offline + system details. */
export function OltsPanel() {
  const [olts, setOlts] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    setBusy(true);
    return api
      .get('/olts')
      .then((r) => setOlts(r.data || []))
      .catch(() => setOlts([]))
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  const del = async (id: number) => {
    if (!confirm('Delete this OLT? Child NAPs must be removed first.')) return;
    try {
      await api.delete(`/olts/${id}`);
      load();
    } catch (e: any) {
      alert(e?.response?.data?.error || 'Could not delete OLT');
    }
  };

  return (
    <div>
      <div className="flex justify-end gap-2 mb-4">
        <button type="button" className="btn-secondary text-sm" onClick={load} disabled={busy}>
          <RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> Refresh status
        </button>
        <button
          type="button"
          className="btn-primary"
          onClick={() =>
            setEdit({
              name: '',
              host: '',
              snmpPort: 161,
              snmpCommunity: 'public',
              ports: 8,
              vendor: '',
              model: '',
              status: 'offline',
            })
          }
        >
          <Plus size={16} /> Add OLT
        </button>
      </div>

      {olts.length === 0 ? (
        <EmptyState message='No OLTs configured. Click "Add OLT" and enter the management IP.' icon={Radio} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {olts.map((o) => (
            <Card
              key={o.id}
              interactive
              title={o.name}
              icon={Radio}
              right={<StatusBadge status={o.status === 'online' || o.online ? 'online' : 'offline'} />}
            >
              <div className="text-xs text-slate-400 truncate">
                {[o.vendor, o.model || o.sysName].filter(Boolean).join(' · ') || 'System details pending'}
              </div>
              <dl className="mt-3 text-sm space-y-1">
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">IP / Host</dt>
                  <dd className="text-slate-700 font-mono text-xs">{o.host || '—'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Vendor</dt>
                  <dd className="text-slate-700">{o.vendor || '—'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">Model / Name</dt>
                  <dd className="text-slate-700 truncate max-w-[60%] text-right">{o.model || o.sysName || '—'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-slate-500">PON ports</dt>
                  <dd className="text-slate-700">{o.ports ?? '—'}</dd>
                </div>
                {o.probeError && o.status !== 'online' && (
                  <div className="text-[11px] text-rose-600 mt-1">{o.probeError}</div>
                )}
                {o.lastProbeAt && (
                  <div className="text-[11px] text-slate-400 mt-1">
                    Probed {new Date(o.lastProbeAt).toLocaleString()}
                  </div>
                )}
              </dl>
              <div className="flex items-center gap-3 mt-3 text-slate-400">
                <button type="button" className="inline-flex items-center gap-1 text-sm hover:text-sky-600" onClick={() => setEdit(o)}>
                  <Pencil size={14} /> Edit
                </button>
                <button type="button" className="inline-flex items-center gap-1 text-sm hover:text-rose-600" onClick={() => del(o.id)}>
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {edit && (
        <OltModal
          olt={edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function OltModal({ olt, onClose, onSaved }: any) {
  const [form, setForm] = useState({ ...olt });
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const isEdit = !!olt.id;
  const set = (patch: any) => setForm((f: any) => ({ ...f, ...patch }));

  const test = async () => {
    if (!form.host?.trim()) {
      setTestResult({ online: false, error: 'Enter an IP address first' });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.post('/olts/test', form);
      setTestResult(r.data);
      if (r.data.sysName) set({ name: form.name || r.data.sysName });
      if (r.data.vendor) set({ vendor: r.data.vendor });
      if (r.data.model) set({ model: r.data.model });
    } catch (e: any) {
      setTestResult({ online: false, error: e?.response?.data?.error || 'Test failed' });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    if (!form.name?.trim() || !form.host?.trim()) return;
    setBusy(true);
    try {
      if (isEdit) await api.put(`/olts/${olt.id}`, form);
      else await api.post('/olts', form);
      onSaved();
    } catch (e: any) {
      setTestResult({ online: false, error: e?.response?.data?.error || 'Save failed' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isEdit ? 'Edit OLT' : 'Add OLT'}
      onClose={onClose}
      footer={<ModalFooter onCancel={onClose} onConfirm={save} confirmLabel="Save OLT" busy={busy} />}
    >
      <div className="space-y-4">
        <FormField label="Name" required>
          <input className="input" value={form.name || ''} onChange={(e) => set({ name: e.target.value })} placeholder="OLT Main" />
        </FormField>
        <FormField label="IP Address / Host" required hint="Management IP of the OLT (SNMP / Telnet / Web).">
          <input className="input font-mono" value={form.host || ''} onChange={(e) => set({ host: e.target.value })} placeholder="192.168.1.10" />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="SNMP Port">
            <input className="input" type="number" value={form.snmpPort ?? 161} onChange={(e) => set({ snmpPort: Number(e.target.value) })} />
          </FormField>
          <FormField label="SNMP Community">
            <input className="input font-mono" value={form.snmpCommunity || 'public'} onChange={(e) => set({ snmpCommunity: e.target.value })} />
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Vendor">
            <input className="input" value={form.vendor || ''} onChange={(e) => set({ vendor: e.target.value })} placeholder="Huawei / ZTE / …" />
          </FormField>
          <FormField label="PON Ports">
            <input className="input" type="number" value={form.ports ?? 8} onChange={(e) => set({ ports: Number(e.target.value) })} />
          </FormField>
        </div>
        <button type="button" className="btn-secondary text-sm inline-flex items-center gap-1.5" onClick={test} disabled={testing}>
          <Wifi size={14} /> {testing ? 'Probing…' : 'Test connection'}
        </button>
        {testResult && (
          <div className={`text-sm rounded-xl border px-3 py-2 ${testResult.online ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'}`}>
            {testResult.online ? (
              <>
                <b>Online</b>
                {testResult.sysName ? ` · ${testResult.sysName}` : ''}
                {testResult.vendor ? ` · ${testResult.vendor}` : ''}
                {testResult.model ? ` · ${testResult.model}` : ''}
              </>
            ) : (
              <>{testResult.error || 'Offline / unreachable'}</>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
