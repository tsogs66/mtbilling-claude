import { useEffect, useState } from 'react';
import { FolderOpen, RefreshCw, Trash2, Upload } from 'lucide-react';
import Layout from '../components/Layout';
import { Card, DataTable, EmptyState, Flash, FormField, Modal, ModalFooter } from '../components/ui';
import { api } from '../api';
import { useRouterDevice } from '../context/RouterContext';

function fmtSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export default function MikrotikFiles() {
  const { routers, current, setCurrent } = useRouterDevice();
  const [files, setFiles] = useState<any[]>([]);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadName, setUploadName] = useState('');
  const [uploadContent, setUploadContent] = useState('');

  const routerId = current?.id;

  const load = async () => {
    if (!routerId) return;
    setBusy(true);
    try {
      const r = await api.get('/files', { params: { routerId } });
      setFiles(r.data.files || []);
      setLive(!!r.data.live);
    } catch (e: any) {
      setFlash({ type: 'error', msg: e?.response?.data?.error || 'Could not load files from router' });
      setFiles([]);
      setLive(false);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    load();
  }, [routerId]);

  const del = async (name: string) => {
    if (!routerId || !confirm(`Delete "${name}" from the router?`)) return;
    try {
      await api.delete('/files', { params: { routerId, name } });
      setFlash({ type: 'success', msg: `Deleted ${name}` });
      load();
    } catch (e: any) {
      setFlash({ type: 'error', msg: e?.response?.data?.error || 'Delete failed' });
    }
  };

  const upload = async () => {
    if (!routerId || !uploadName.trim()) return;
    setBusy(true);
    try {
      await api.post('/files/upload', { routerId, name: uploadName.trim(), content: uploadContent });
      setFlash({ type: 'success', msg: `Uploaded ${uploadName}` });
      setUploadOpen(false);
      setUploadName('');
      setUploadContent('');
      load();
    } catch (e: any) {
      setFlash({ type: 'error', msg: e?.response?.data?.error || 'Upload failed' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Layout title="Mikrotik Files">
      {flash && <Flash type={flash.type} message={flash.msg} onDismiss={() => setFlash(null)} />}

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          className="input max-w-xs"
          value={routerId || ''}
          onChange={(e) => {
            const r = routers.find((x) => x.id === Number(e.target.value));
            if (r) setCurrent(r);
          }}
        >
          {routers.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name} ({r.host})
            </option>
          ))}
        </select>
        <button className="btn-secondary" onClick={load} disabled={busy || !routerId}>
          <RefreshCw size={16} className={busy ? 'animate-spin' : ''} /> Refresh
        </button>
        <button className="btn-primary" onClick={() => setUploadOpen(true)} disabled={!routerId}>
          <Upload size={16} /> Upload
        </button>
        {live && <span className="text-xs text-emerald-600 font-medium">Live from router</span>}
      </div>

      {!routerId ? (
        <EmptyState message="Add a router first under Router Management." icon={FolderOpen} />
      ) : files.length === 0 && !busy ? (
        <EmptyState message="No files on this router (or router unreachable)." icon={FolderOpen} />
      ) : (
        <Card title={`Files on ${current?.name}`} noPadding>
          <DataTable
            columns={[
              { key: 'name', label: 'Name' },
              { key: 'type', label: 'Type' },
              { key: 'size', label: 'Size' },
              { key: 'created', label: 'Created' },
              { key: 'actions', label: '', align: 'right' },
            ]}
            rows={files.map((f) => ({
              key: f.name,
              cells: [
                <span className="font-mono text-slate-700">{f.name}</span>,
                f.type,
                fmtSize(f.size),
                <span className="text-slate-500 text-xs">{f.creationTime || '—'}</span>,
                <div className="flex justify-end">
                  <button className="text-rose-500 hover:text-rose-700 p-1" onClick={() => del(f.name)} title="Delete">
                    <Trash2 size={15} />
                  </button>
                </div>,
              ],
            }))}
            emptyMessage="No files."
          />
        </Card>
      )}

      {uploadOpen && (
        <Modal
          title="Upload file to router"
          onClose={() => setUploadOpen(false)}
          footer={<ModalFooter onCancel={() => setUploadOpen(false)} onConfirm={upload} busy={busy} confirmLabel="Upload" />}
        >
          <div className="space-y-3">
            <FormField label="File name" required>
              <input className="input font-mono" value={uploadName} onChange={(e) => setUploadName(e.target.value)} placeholder="script.rsc" />
            </FormField>
            <FormField label="Contents (text, max 64KB)">
              <textarea className="input font-mono text-xs min-h-[160px]" value={uploadContent} onChange={(e) => setUploadContent(e.target.value)} />
            </FormField>
          </div>
        </Modal>
      )}
    </Layout>
  );
}
