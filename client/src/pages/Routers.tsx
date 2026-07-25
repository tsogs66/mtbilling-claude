import { useEffect, useState } from 'react';
import { Router as RouterIcon, Plus, Pencil, Trash2, Wifi } from 'lucide-react';
import { Card, StatusBadge, EmptyState, Modal, ModalFooter, FormField } from '../components/ui';
import { api } from '../api';
import { useRouterDevice } from '../context/RouterContext';

/** Router inventory panel — embedded as the first Network tab. */
export function RoutersPanel() {
  const [routers, setRouters] = useState<any[]>([]);
  const [edit, setEdit] = useState<any>(null);
  const { refresh } = useRouterDevice();

  const load = () => api.get('/routers').then((r) => setRouters(r.data));
  useEffect(() => {
    load();
  }, []);

  const del = async (id: number) => {
    await api.delete(`/routers/${id}`);
    load();
    refresh();
  };

  return (
    <div>
      <div className="flex justify-end mb-4">
        <button
          className="btn-primary"
          onClick={() =>
            setEdit({
              name: '',
              host: '',
              port: 8728,
              api_user: '',
              api_pass: '',
              board: '',
              type: 'pppoe',
              status: 'offline',
            })
          }
        >
          <Plus size={16} /> Add Router
        </button>
      </div>

      {routers.length === 0 ? (
        <EmptyState message='No routers configured. Click "Add Router".' icon={RouterIcon} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {routers.map((r) => (
            <Card key={r.id} interactive title={r.name} icon={RouterIcon} right={<StatusBadge status={r.status} />}>
              <div className="text-xs text-slate-400">{r.board}</div>
              <dl className="mt-3 text-sm space-y-1">
                <div className="flex justify-between">
                  <dt className="text-slate-500">Host</dt>
                  <dd className="text-slate-700">
                    {r.host}:{r.port}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Type</dt>
                  <dd className="text-slate-700 uppercase">{r.type}</dd>
                </div>
              </dl>
              <div className="flex items-center gap-3 mt-3 text-slate-400">
                <button className="inline-flex items-center gap-1 text-sm hover:text-sky-600" onClick={() => setEdit(r)}>
                  <Pencil size={14} /> Edit
                </button>
                <button className="inline-flex items-center gap-1 text-sm hover:text-rose-600" onClick={() => del(r.id)}>
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {edit && (
        <RouterModal
          router={edit}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            load();
            refresh();
          }}
        />
      )}
    </div>
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
              <>Not reachable{testResult.error ? `: ${testResult.error}` : ''}</>
            )}
          </div>
        )}
        <FormField label="Name" required>
          <input className="input" value={form.name || ''} onChange={(e) => set({ name: e.target.value })} />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Host / IP">
            <input className="input" value={form.host || ''} onChange={(e) => set({ host: e.target.value })} />
          </FormField>
          <FormField label="API Port">
            <input
              className="input"
              type="number"
              value={form.port || 8728}
              onChange={(e) => set({ port: Number(e.target.value) })}
            />
          </FormField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="API User">
            <input className="input" value={form.api_user || ''} onChange={(e) => set({ api_user: e.target.value })} />
          </FormField>
          <FormField label="API Password">
            <input
              className="input"
              type="password"
              placeholder={isEdit ? '(leave blank to keep)' : ''}
              value={form.api_pass || ''}
              onChange={(e) => set({ api_pass: e.target.value })}
            />
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
            <input
              className="input"
              value={form.board || ''}
              onChange={(e) => set({ board: e.target.value })}
              placeholder="Auto-filled after Test"
              readOnly={!!testResult?.board}
            />
          </FormField>
        </div>
      </div>
    </Modal>
  );
}

/** @deprecated Standalone page kept for redirects — use Network → Routers tab */
export default function Routers() {
  return <RoutersPanel />;
}
