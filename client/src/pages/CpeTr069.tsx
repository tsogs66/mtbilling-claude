import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Router, RefreshCw, Power, Search, ExternalLink, Loader2, Settings2, ChevronRight, Save,
} from 'lucide-react';
import Layout from '../components/Layout';
import { Card, Flash, FormField, SearchInput, StatusBadge } from '../components/ui';
import { api } from '../api';

type AcsConfig = {
  enabled: boolean;
  nbiUrl: string;
  uiUrl: string;
  username: string;
  passwordSet: boolean;
};

type DeviceRow = {
  id: string;
  lastInform: string | null;
  tags: string[];
  subscriber: { id: number; name: string; username: string } | null;
};

type Preset = {
  id: string;
  label: string;
  paths: string[];
  writable?: boolean;
  current?: { path: string; value: string };
};

type DeviceDetail = {
  presets: Preset[];
  parameters: { path: string; value: string }[];
  subscriber: { id: number; username: string; customer_name: string } | null;
};

export default function CpeTr069() {
  const [config, setConfig] = useState<AcsConfig | null>(null);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [banner, setBanner] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<DeviceDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [customPath, setCustomPath] = useState('');
  const [customValue, setCustomValue] = useState('');
  const [autolinkBusy, setAutolinkBusy] = useState(false);

  const flash = (m: string) => {
    setBanner(m);
    setTimeout(() => setBanner(''), 5000);
  };

  const loadConfig = useCallback(() => api.get('/acs/config').then((r) => setConfig(r.data)), []);

  const runAutolink = async () => {
    setAutolinkBusy(true);
    try {
      const r = await api.post('/acs/autolink', {});
      flash(`Autolink: ${r.data.linked} linked, ${r.data.tagsSynced} tag sync(s), ${r.data.skipped} skipped.`);
      await loadDevices();
    } catch (e: any) {
      flash(e?.response?.data?.error || 'Autolink failed');
    } finally {
      setAutolinkBusy(false);
    }
  };

  const loadDevices = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get('/acs/devices', { params: { limit: 300 } });
      setDevices(r.data);
    } catch (e: any) {
      setDevices([]);
      const err = e?.response?.data?.error;
      flash(
        err === 'fetch failed' || err === 'acs-disabled'
          ? 'GenieACS is disabled or not reachable — install ACS, open port 7547 for CPE CWMP, and set the NBI URL in System Settings.'
          : err || 'Could not list CPE devices — check GenieACS settings.'
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig().then(() => loadDevices());
  }, [loadConfig, loadDevices]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return devices;
    return devices.filter(
      (d) =>
        d.id.toLowerCase().includes(q) ||
        d.subscriber?.name?.toLowerCase().includes(q) ||
        d.subscriber?.username?.toLowerCase().includes(q)
    );
  }, [devices, search]);

  const openDevice = async (id: string) => {
    setSelectedId(id);
    setDetail(null);
    setEditValues({});
    setDetailBusy(true);
    try {
      const r = await api.get(`/acs/devices/${encodeURIComponent(id)}`);
      const d = r.data as DeviceDetail;
      setDetail(d);
      const init: Record<string, string> = {};
      for (const p of d.presets) {
        if (p.writable && p.current) init[p.id] = p.current.value;
      }
      setEditValues(init);
    } catch (e: any) {
      flash(e?.response?.data?.error || 'Failed to load device');
      setSelectedId(null);
    } finally {
      setDetailBusy(false);
    }
  };

  const runDeviceAction = async (action: 'refresh' | 'reboot') => {
    if (!selectedId) return;
    if (action === 'reboot' && !window.confirm('Reboot this CPE now?')) return;
    setDetailBusy(true);
    try {
      if (action === 'refresh') await api.post(`/acs/devices/${encodeURIComponent(selectedId)}/refresh`, {});
      else await api.post(`/acs/devices/${encodeURIComponent(selectedId)}/reboot`, {});
      flash(action === 'refresh' ? 'Refresh queued — device will report on next inform.' : 'Reboot queued.');
      setTimeout(() => openDevice(selectedId), 2500);
    } catch (e: any) {
      flash(e?.response?.data?.error || `${action} failed`);
    } finally {
      setDetailBusy(false);
    }
  };

  const pushPreset = async (preset: Preset) => {
    if (!selectedId || !preset.writable) return;
    const value = editValues[preset.id] ?? '';
    const path = preset.current?.path || preset.paths[0];
    if (!path) {
      flash('Parameter path unknown — refresh device data first.');
      return;
    }
    setDetailBusy(true);
    try {
      await api.post(`/acs/devices/${encodeURIComponent(selectedId)}/set-parameter`, { path, value });
      flash(`Pushed ${preset.label}.`);
    } catch (e: any) {
      flash(e?.response?.data?.error || 'Push failed');
    } finally {
      setDetailBusy(false);
    }
  };

  const pushCustom = async () => {
    if (!selectedId || !customPath.trim()) return;
    setDetailBusy(true);
    try {
      await api.post(`/acs/devices/${encodeURIComponent(selectedId)}/set-parameter`, {
        path: customPath.trim(),
        value: customValue,
      });
      flash('Custom parameter pushed.');
      setCustomPath('');
      setCustomValue('');
    } catch (e: any) {
      flash(e?.response?.data?.error || 'Push failed');
    } finally {
      setDetailBusy(false);
    }
  };

  return (
    <Layout title="CPE / TR-069 (GenieACS)">
      <Flash message={banner} onDismiss={() => setBanner('')} />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-slate-600 max-w-2xl">
            Manage customer Huawei and other TR-069 CPEs through{' '}
            <a href="https://genieacs.com/" className="text-brand-600 hover:underline" target="_blank" rel="noreferrer">
              GenieACS
            </a>
            . MikroTik PPPoE/IPoE stays the access server; ACS handles CPE configuration over CWMP.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {config?.uiUrl ? (
            <a href={config.uiUrl} target="_blank" rel="noreferrer" className="btn-secondary text-sm inline-flex items-center gap-1.5">
              <ExternalLink size={14} /> GenieACS UI
            </a>
          ) : null}
          <Link to="/settings" className="btn-secondary text-sm inline-flex items-center gap-1.5">
            <Settings2 size={14} /> ACS settings
          </Link>
          <button type="button" className="btn-secondary text-sm inline-flex items-center gap-1.5" onClick={runAutolink} disabled={autolinkBusy || loading}>
            <RefreshCw size={14} className={autolinkBusy ? 'animate-spin' : ''} /> Run autolink
          </button>
          <button type="button" className="btn-primary text-sm inline-flex items-center gap-1.5" onClick={loadDevices} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh list
          </button>
        </div>
      </div>

      {!config?.enabled && (
        <Card className="mb-4 border-amber-200 bg-amber-50 text-amber-950 text-sm">
          TR-069 integration is disabled. Open{' '}
          <Link to="/settings" className="font-medium underline">
            System Settings → TR-069 / GenieACS
          </Link>{' '}
          to enable and set the GenieACS NBI URL (default <code className="text-xs">http://127.0.0.1:7557</code>).
        </Card>
      )}

      <div className="grid lg:grid-cols-5 gap-4">
        <Card className="lg:col-span-2 p-0 overflow-hidden">
          <div className="p-3 border-b border-slate-100">
            <SearchInput value={search} onChange={setSearch} placeholder="Search device ID or subscriber…" />
          </div>
          <div className="max-h-[min(70vh,560px)] overflow-y-auto divide-y divide-slate-100">
            {loading && (
              <div className="p-6 text-center text-slate-400 text-sm flex items-center justify-center gap-2">
                <Loader2 size={16} className="animate-spin" /> Loading devices…
              </div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="p-6 text-center text-slate-400 text-sm">No devices — ensure CPEs inform to GenieACS CWMP (port 7547).</div>
            )}
            {filtered.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => openDevice(d.id)}
                className={`w-full text-left px-3 py-2.5 hover:bg-slate-50 flex items-start gap-2 ${selectedId === d.id ? 'bg-brand-50' : ''}`}
              >
                <Router size={16} className="text-slate-400 shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-xs text-slate-800 truncate">{d.id}</div>
                  {d.subscriber ? (
                    <div className="text-xs text-slate-500 truncate">{d.subscriber.name} ({d.subscriber.username})</div>
                  ) : (
                    <div className="text-xs text-slate-400">Not linked to a subscriber</div>
                  )}
                  {d.lastInform && (
                    <div className="text-[10px] text-slate-400 mt-0.5">Last inform: {new Date(d.lastInform).toLocaleString()}</div>
                  )}
                </div>
                <ChevronRight size={14} className="text-slate-300 shrink-0 mt-1" />
              </button>
            ))}
          </div>
        </Card>

        <Card className="lg:col-span-3 p-4">
          {!selectedId && (
            <div className="text-sm text-slate-500 py-12 text-center">Select a CPE to read or push TR-069 parameters.</div>
          )}
          {selectedId && detailBusy && !detail && (
            <div className="py-12 flex justify-center text-slate-400 gap-2 text-sm">
              <Loader2 className="animate-spin" size={18} /> Loading device…
            </div>
          )}
          {selectedId && detail && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-mono text-sm text-slate-900 break-all">{selectedId}</div>
                  {detail.subscriber ? (
                    <div className="text-xs text-slate-500 mt-1">
                      Linked: {detail.subscriber.customer_name}{' '}
                      <Link to="/pppoe" className="text-brand-600 hover:underline">
                        ({detail.subscriber.username})
                      </Link>
                    </div>
                  ) : (
                    <div className="text-xs text-amber-700 mt-1">Link this device ID on the subscriber edit form in PPPoE Management.</div>
                  )}
                </div>
                <div className="flex gap-2">
                  <button type="button" className="btn-secondary text-xs" onClick={() => runDeviceAction('refresh')} disabled={detailBusy}>
                    <RefreshCw size={12} /> Refresh
                  </button>
                  <button type="button" className="btn-secondary text-xs text-rose-700 border-rose-200" onClick={() => runDeviceAction('reboot')} disabled={detailBusy}>
                    <Power size={12} /> Reboot
                  </button>
                </div>
              </div>

              <div>
                <div className="text-sm font-semibold text-slate-800 mb-2">Common settings</div>
                <div className="space-y-3">
                  {detail.presets.map((p) => (
                    <div key={p.id} className="rounded-xl border border-slate-100 p-3 bg-slate-50/50">
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                        <span className="text-sm font-medium text-slate-700">{p.label}</span>
                        {p.current ? (
                          <span className="text-xs text-emerald-700">cached: {p.current.value || '—'}</span>
                        ) : (
                          <StatusBadge status="offline" />
                        )}
                      </div>
                      {p.current && <div className="text-[10px] font-mono text-slate-400 mb-2 truncate">{p.current.path}</div>}
                      {p.writable ? (
                        <div className="flex gap-2">
                          <input
                            className="input text-sm flex-1 font-mono"
                            value={editValues[p.id] ?? ''}
                            onChange={(e) => setEditValues((v) => ({ ...v, [p.id]: e.target.value }))}
                            placeholder="New value"
                          />
                          <button type="button" className="btn-primary text-xs shrink-0" onClick={() => pushPreset(p)} disabled={detailBusy}>
                            <Save size={12} /> Push
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-sm font-semibold text-slate-800 mb-2">Custom parameter</div>
                <div className="grid sm:grid-cols-2 gap-2">
                  <FormField label="TR-069 path">
                    <input className="input text-xs font-mono" value={customPath} onChange={(e) => setCustomPath(e.target.value)} placeholder="InternetGatewayDevice.…" />
                  </FormField>
                  <FormField label="Value">
                    <input className="input text-sm" value={customValue} onChange={(e) => setCustomValue(e.target.value)} />
                  </FormField>
                </div>
                <button type="button" className="btn-primary text-sm mt-2" onClick={pushCustom} disabled={detailBusy || !customPath.trim()}>
                  Push custom parameter
                </button>
              </div>

              <details className="text-xs">
                <summary className="cursor-pointer text-slate-500 hover:text-slate-700">All cached parameters ({detail.parameters.length})</summary>
                <div className="mt-2 max-h-48 overflow-y-auto font-mono bg-slate-900 text-slate-100 rounded-lg p-2 space-y-0.5">
                  {detail.parameters.slice(0, 400).map((p) => (
                    <div key={p.path} className="truncate">
                      <span className="text-slate-400">{p.path}=</span>
                      {p.value}
                    </div>
                  ))}
                </div>
              </details>
            </div>
          )}
        </Card>
      </div>
    </Layout>
  );
}
