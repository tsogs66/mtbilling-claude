import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Layout from '../components/Layout';
import { Card, FormField, SearchInput } from '../components/ui';
import { api, peso } from '../api';

const TABS = [
  ['subscriber', 'Subscriber'],
  ['aging', 'Aging'],
  ['cashier', 'Cashier close'],
  ['nap', 'NAP dispatch'],
  ['finance', 'Collections'],
  ['cgnat', 'CGNAT / sessions'],
  ['status', 'Area status'],
  ['policy', 'Dunning & BIR'],
] as const;

type Tab = (typeof TABS)[number][0];

export default function OperationsDesk() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'subscriber';
  const subscriberId = Number(params.get('subscriber') || 0);
  const setTab = (next: Tab) => {
    const p = new URLSearchParams(params);
    p.set('tab', next);
    setParams(p);
  };

  return (
    <Layout title="Operations desk">
      <p className="text-sm text-slate-600 mb-3 max-w-3xl">
        One place for the subscriber record, partial payments and official receipts, aging SMS,
        NAP dispatch, daily collections, CGNAT lookup, and the public area-status page.
      </p>
      <div className="flex flex-wrap gap-1.5 mb-4">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`px-3 py-1.5 rounded-full text-xs font-medium border ${tab === id ? 'bg-brand-600 text-white border-brand-600' : 'bg-white text-slate-600 border-slate-200'}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'subscriber' && <SubscriberTab initialId={subscriberId} />}
      {tab === 'aging' && <AgingTab />}
      {tab === 'cashier' && <CashierTab />}
      {tab === 'nap' && <NapTab />}
      {tab === 'finance' && <FinanceTab />}
      {tab === 'cgnat' && <CgnatTab />}
      {tab === 'status' && <StatusAdminTab />}
      {tab === 'policy' && <PolicyTab />}
    </Layout>
  );
}

function SubscriberTab({ initialId }: { initialId: number }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<any[]>([]);
  const [hub, setHub] = useState<any>(null);
  const [pay, setPay] = useState({ amount: '', method: 'cash', extendMonths: '0', note: '' });
  const [wifi, setWifi] = useState({ ssid: '', password: '' });
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (initialId > 0) {
      api.get(`/isp/subscribers/${initialId}`).then((r) => setHub(r.data)).catch(() => setHub(null));
    }
  }, [initialId]);

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    const t = window.setTimeout(() => {
      api.get('/isp/subscribers', { params: { q } }).then((r) => setHits(r.data)).catch(() => setHits([]));
    }, 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const open = (id: number) => {
    api.get(`/isp/subscribers/${id}`).then((r) => setHub(r.data));
  };

  const takePayment = async () => {
    if (!hub?.user?.id) return;
    try {
      const r = await api.post('/isp/payments', {
        pppoeUserId: hub.user.id,
        amount: Number(pay.amount),
        method: pay.method,
        extendMonths: Number(pay.extendMonths) || 0,
        note: pay.note,
      });
      setMsg(`Receipt ${r.data.or_number} recorded.`);
      open(hub.user.id);
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      setMsg(err?.response?.data?.error || 'Payment failed');
    }
  };

  const cpe = async (action: string) => {
    if (!hub?.user?.id) return;
    try {
      await api.post(`/isp/subscribers/${hub.user.id}/cpe`, {
        action,
        ssid: wifi.ssid,
        password: wifi.password,
      });
      setMsg(action === 'wifi' ? 'Wi-Fi push queued.' : `${action} queued on the CPE.`);
    } catch (e: unknown) {
      const err = e as { response?: { data?: { error?: string } } };
      setMsg(err?.response?.data?.error || 'CPE action failed');
    }
  };

  const u = hub?.user;
  return (
    <div className="grid lg:grid-cols-5 gap-4">
      <Card className="lg:col-span-2 p-3">
        <SearchInput value={q} onChange={setQ} placeholder="Name, username, or account #" />
        <ul className="mt-2 divide-y">
          {hits.map((h) => (
            <li key={h.id}>
              <button type="button" className="w-full text-left py-2 text-sm" onClick={() => open(h.id)}>
                <span className="font-medium">{h.customer_name || h.username}</span>
                <span className="block text-xs text-slate-400">{h.username} · {h.status}</span>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <Card className="lg:col-span-3 p-4 space-y-3">
        {!u && <p className="text-sm text-slate-500">Search a subscriber. PPPoE rows also open this page.</p>}
        {u && (
          <>
            <div>
              <h2 className="text-lg font-semibold">{u.customer_name || u.username}</h2>
              <p className="text-xs text-slate-500">
                {u.username} · {u.profile || 'no plan'} · due {u.subscription_due || '—'} · {hub.daysPastDue != null && hub.daysPastDue >= 0 ? `${hub.daysPastDue} days past due` : 'current'}
              </p>
              <p className="text-xs text-slate-500 mt-1">
                NAP {hub.nap?.name || '—'} · ONU {u.onu_serial || '—'} · CPE {u.acs_device_id || 'not linked'} · balance plan {peso(Number(u.price) || 0)}
              </p>
            </div>
            {msg && <p className="text-xs text-emerald-700">{msg}</p>}
            <div className="grid sm:grid-cols-2 gap-3">
              <div className="space-y-2">
                <div className="text-sm font-medium">Partial payment</div>
                <input className="input" placeholder="Amount" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
                <select className="input" value={pay.method} onChange={(e) => setPay({ ...pay, method: e.target.value })}>
                  <option value="cash">Cash</option>
                  <option value="gcash">GCash</option>
                  <option value="maya">Maya</option>
                  <option value="bank">Bank</option>
                </select>
                <input className="input" placeholder="Extend months (0 = partial only)" value={pay.extendMonths} onChange={(e) => setPay({ ...pay, extendMonths: e.target.value })} />
                <button type="button" className="btn-primary text-sm" onClick={() => void takePayment()}>Issue official receipt</button>
              </div>
              <div className="space-y-2">
                <div className="text-sm font-medium">CPE</div>
                <input className="input" placeholder="Wi-Fi name" value={wifi.ssid} onChange={(e) => setWifi({ ...wifi, ssid: e.target.value })} />
                <input className="input" placeholder="Wi-Fi password" value={wifi.password} onChange={(e) => setWifi({ ...wifi, password: e.target.value })} />
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn-secondary text-xs" onClick={() => void cpe('wifi')}>Push Wi-Fi</button>
                  <button type="button" className="btn-secondary text-xs" onClick={() => void cpe('reboot')}>Reboot</button>
                  <button type="button" className="btn-secondary text-xs" onClick={() => void cpe('refresh')}>Refresh</button>
                </div>
              </div>
            </div>
            <Mini title="Receipts" rows={(hub.payments || []).map((p: any) => `${p.or_number} · ${peso(p.amount)} · ${p.method} · ${p.cashier_username || '—'} ${p.reversed_at ? '(reversed)' : ''}`)} />
            <Mini title="Jobs" rows={(hub.jobs || []).map((j: any) => `${j.number} ${j.type} ${j.status} tech ${j.assigned_to || '—'}`)} />
            <Mini title="Invoices" rows={(hub.invoices || []).map((i: any) => `${i.number} ${i.status} ${peso(i.amount)}`)} />
            <Mini title="Sessions" rows={(hub.sessions || []).map((s: any) => `${s.framed_ip || '—'} ${s.started_at || ''} ${s.router_name || ''}`)} />
          </>
        )}
      </Card>
    </div>
  );
}

function Mini({ title, rows }: { title: string; rows: string[] }) {
  return (
    <div>
      <div className="text-xs font-semibold text-slate-500 uppercase">{title}</div>
      {rows.length === 0 && <p className="text-xs text-slate-400">None yet.</p>}
      <ul className="text-xs text-slate-700 space-y-0.5">
        {rows.map((r, i) => <li key={i}>{r}</li>)}
      </ul>
    </div>
  );
}

function AgingTab() {
  const [rows, setRows] = useState<any[]>([]);
  const [msg, setMsg] = useState('');
  const load = () => api.get('/isp/aging').then((r) => setRows(r.data));
  useEffect(() => { void load(); }, []);
  return (
    <Card className="p-4">
      <div className="flex justify-between items-center mb-2">
        <h2 className="font-semibold">Past due</h2>
        <button type="button" className="btn-secondary text-xs" onClick={() => api.post('/isp/dunning/run').then((r) => setMsg(`SMS sent: ${r.data.sent}`))}>Send dunning SMS now</button>
      </div>
      {msg && <p className="text-xs text-emerald-700 mb-2">{msg}</p>}
      <ul className="text-sm divide-y">
        {rows.slice(0, 80).map((r) => (
          <li key={r.id} className="py-1.5 flex justify-between gap-2">
            <span>{r.customer_name || r.username} · {r.nap_name || 'no NAP'}</span>
            <span className="text-rose-700">{r.daysPastDue}d · {peso(r.price || 0)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function CashierTab() {
  const [data, setData] = useState<any>(null);
  const [note, setNote] = useState('');
  const load = () => api.get('/isp/cashier-close').then((r) => setData(r.data));
  useEffect(() => { void load(); }, []);
  return (
    <Card className="p-4 space-y-3">
      <h2 className="font-semibold">Today&apos;s tickets</h2>
      <ul className="text-sm">
        {(data?.payments || []).map((p: any) => (
          <li key={p.id} className="flex justify-between py-1">
            <span>{p.or_number} · {p.customer_name} · {p.method} · {p.cashier_username}</span>
            <span>{peso(p.amount)}</span>
          </li>
        ))}
      </ul>
      <FormField label="Close note">
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </FormField>
      <button type="button" className="btn-primary text-sm" onClick={() => api.post('/isp/cashier-close', { note }).then(load)}>Close my drawer</button>
      <h3 className="text-sm font-medium pt-2">Recent closes</h3>
      <ul className="text-xs text-slate-600">
        {(data?.closes || []).map((c: any) => (
          <li key={c.id}>{c.business_date} {c.cashier_username}: cash {peso(c.cash_total)} · e-wallet {peso(c.gcash_total)} · other {peso(c.other_total)}</li>
        ))}
      </ul>
    </Card>
  );
}

function NapTab() {
  const [rows, setRows] = useState<any[]>([]);
  const [napId, setNapId] = useState('');
  const [pon, setPon] = useState('');
  const [message, setMessage] = useState('We are working on a line fault in your area. Service will return shortly.');
  const [msg, setMsg] = useState('');
  useEffect(() => { api.get('/isp/nap-dispatch').then((r) => setRows(r.data)); }, []);
  return (
    <Card className="p-4 space-y-3">
      <h2 className="font-semibold">Morning dispatch</h2>
      <ul className="text-sm divide-y">
        {rows.map((n) => (
          <li key={n.id} className="py-1.5 flex justify-between">
            <span>{n.name}</span>
            <span className="text-xs text-slate-500">fill {n.fill_count}/{n.ports || '—'} · offline {n.offline_count} · jobs {n.open_jobs}</span>
          </li>
        ))}
      </ul>
      <div className="grid sm:grid-cols-2 gap-2">
        <input className="input" placeholder="NAP id" value={napId} onChange={(e) => setNapId(e.target.value)} />
        <input className="input" placeholder="PON / PLC port" value={pon} onChange={(e) => setPon(e.target.value)} />
      </div>
      <textarea className="input min-h-[70px]" value={message} onChange={(e) => setMessage(e.target.value)} />
      <button
        type="button"
        className="btn-secondary text-sm"
        onClick={() => api.post('/isp/broadcast', { napId: napId ? Number(napId) : undefined, pon: pon || undefined, message }).then((r) => setMsg(`Targets ${r.data.targets}, SMS ${r.data.sent}`))}
      >
        SMS this area
      </button>
      {msg && <p className="text-xs text-emerald-700">{msg}</p>}
    </Card>
  );
}

function FinanceTab() {
  const [data, setData] = useState<any>(null);
  useEffect(() => { api.get('/isp/finance').then((r) => setData(r.data)); }, []);
  if (!data) return null;
  return (
    <div className="grid md:grid-cols-3 gap-3">
      <Card className="p-4">
        <h2 className="font-semibold mb-2">By cashier today</h2>
        {(data.byCashier || []).map((r: any) => <p key={r.cashier} className="text-sm">{r.cashier}: {peso(r.total)} ({r.tickets})</p>)}
      </Card>
      <Card className="p-4">
        <h2 className="font-semibold mb-2">By area today</h2>
        {(data.byArea || []).map((r: any) => <p key={r.area} className="text-sm">{r.area}: {peso(r.total)}</p>)}
      </Card>
      <Card className="p-4">
        <h2 className="font-semibold mb-2">This month</h2>
        <p className="text-sm">New installs completed: {data.churn?.newInstallsThisMonth ?? 0}</p>
        <p className="text-sm">Lapsed (due this month, not active): {data.churn?.lapsedThisMonth ?? 0}</p>
      </Card>
    </div>
  );
}

function CgnatTab() {
  const [publicIp, setPublicIp] = useState('');
  const [at, setAt] = useState('');
  const [line, setLine] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const search = () => {
    api.get('/isp/cgnat', { params: { publicIp, at } }).then((r) => setRows(r.data));
    api.get('/isp/sessions', { params: { ip: publicIp, at } }).then((r) => setSessions(r.data));
  };
  return (
    <Card className="p-4 space-y-3">
      <p className="text-xs text-slate-500">Paste firewall or CGNAT lines: <code>2026-10-23T01:00:00Z 10.0.0.5:1234 203.0.113.8:54321 tcp</code></p>
      <textarea className="input min-h-[60px]" placeholder="One log line" value={line} onChange={(e) => setLine(e.target.value)} />
      <button type="button" className="btn-secondary text-xs" onClick={() => api.post('/isp/cgnat', { line }).then(() => setLine(''))}>Store line</button>
      <div className="grid sm:grid-cols-2 gap-2">
        <input className="input" placeholder="Public or framed IP" value={publicIp} onChange={(e) => setPublicIp(e.target.value)} />
        <input className="input" placeholder="At time (ISO)" value={at} onChange={(e) => setAt(e.target.value)} />
      </div>
      <button type="button" className="btn-primary text-sm" onClick={search}>Search</button>
      <h3 className="text-sm font-medium">CGNAT</h3>
      <ul className="text-xs font-mono">{rows.map((r) => <li key={r.id}>{r.seen_at} {r.src_ip}:{r.src_port} → {r.public_ip}:{r.public_port} {r.username || ''}</li>)}</ul>
      <h3 className="text-sm font-medium">Sessions</h3>
      <ul className="text-xs">{sessions.map((s) => <li key={s.id}>{s.username} {s.framed_ip} {s.started_at} → {s.stopped_at || 'open'}</li>)}</ul>
      <button
        type="button"
        className="text-sm text-brand-600 underline"
        onClick={() => api.get('/isp/radius-users', { responseType: 'text' }).then((r) => {
          const blob = new Blob([r.data], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'radius-users.txt';
          a.click();
          URL.revokeObjectURL(url);
        })}
      >
        Download RADIUS users file
      </button>
      <p className="text-xs text-slate-500">A second site uses the existing hub-edge sync. Set the branch name under Dunning & BIR so receipts and this status page name the office.</p>
    </Card>
  );
}

function StatusAdminTab() {
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const load = () => api.get('/isp/outages').then((r) => setRows(r.data));
  useEffect(() => { void load(); }, []);
  return (
    <Card className="p-4 space-y-2">
      <p className="text-sm">Public page: <a className="text-brand-600 underline" href="/area-status" target="_blank" rel="noreferrer">/area-status</a></p>
      <input className="input" placeholder="Title (e.g. NAP 12 fiber cut)" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input className="input" placeholder="Detail / ETA" value={detail} onChange={(e) => setDetail(e.target.value)} />
      <button type="button" className="btn-primary text-sm" onClick={() => api.post('/isp/outages', { title, detail }).then(() => { setTitle(''); load(); })}>Publish outage</button>
      <ul className="text-sm">
        {rows.map((o) => (
          <li key={o.id} className="flex justify-between py-1">
            <span>{o.status}: {o.title}</span>
            {o.status === 'open' && <button type="button" className="text-xs underline" onClick={() => api.post(`/isp/outages/${o.id}/clear`).then(load)}>Clear</button>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function PolicyTab() {
  const [form, setForm] = useState<any>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { api.get('/isp/settings').then((r) => setForm(r.data)); }, []);
  if (!form) return null;
  const save = () => api.put('/isp/settings', {
    branchName: form.branch_name,
    birOrPrefix: form.bir_or_prefix,
    radiusNasIp: form.radius_nas_ip,
    dunningEnabled: !!form.dunning_enabled,
    dunningWarnDays: form.dunning_warn_days,
    dunningDisconnectDay: Number(form.dunning_disconnect_day),
    dunningMessage: form.dunning_message,
  }).then(() => setMsg('Saved.'));
  return (
    <Card className="p-4 space-y-2 max-w-xl">
      <FormField label="Branch name"><input className="input" value={form.branch_name || ''} onChange={(e) => setForm({ ...form, branch_name: e.target.value })} /></FormField>
      <FormField label="Official receipt prefix"><input className="input" value={form.bir_or_prefix || ''} onChange={(e) => setForm({ ...form, bir_or_prefix: e.target.value })} /></FormField>
      <FormField label="Next OR number">{form.bir_or_next}</FormField>
      <FormField label="RADIUS NAS IP"><input className="input" value={form.radius_nas_ip || ''} onChange={(e) => setForm({ ...form, radius_nas_ip: e.target.value })} /></FormField>
      <FormField label="Warn on these days past due"><input className="input" value={form.dunning_warn_days || ''} onChange={(e) => setForm({ ...form, dunning_warn_days: e.target.value })} /></FormField>
      <FormField label="Disconnect day"><input className="input" value={form.dunning_disconnect_day || 7} onChange={(e) => setForm({ ...form, dunning_disconnect_day: e.target.value })} /></FormField>
      <FormField label="SMS template"><textarea className="input min-h-[80px]" value={form.dunning_message || ''} onChange={(e) => setForm({ ...form, dunning_message: e.target.value })} /></FormField>
      <label className="text-sm flex items-center gap-2">
        <input type="checkbox" checked={!!form.dunning_enabled} onChange={(e) => setForm({ ...form, dunning_enabled: e.target.checked ? 1 : 0 })} />
        Automatic dunning SMS
      </label>
      <button type="button" className="btn-primary text-sm" onClick={save}>Save policy</button>
      {msg && <p className="text-xs text-emerald-700">{msg}</p>}
    </Card>
  );
}
