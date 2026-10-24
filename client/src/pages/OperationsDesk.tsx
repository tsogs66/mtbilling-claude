import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Layout from '../components/Layout';
import { Card, Flash, FormField, SearchInput } from '../components/ui';
import { api, peso } from '../api';
import { useAuth } from '../context/AuthContext';

const TABS = [
  ['subscriber', 'Subscriber', 'pppoe'],
  ['aging', 'Aging', 'pppoe'],
  ['cashier', 'Cashier close', 'sales'],
  ['nap', 'NAP dispatch', 'pppoe'],
  ['finance', 'Collections', 'sales'],
  ['cgnat', 'CGNAT / sessions', 'pppoe'],
  ['status', 'Area status', 'pppoe'],
  ['policy', 'Dunning & BIR', 'settings'],
] as const;

type Tab = (typeof TABS)[number][0];

/** Turn an axios failure into something the operator can act on. */
export function apiError(e: unknown, fallback: string): string {
  const err = e as { response?: { status?: number; data?: { error?: string; message?: string } } };
  const body = err?.response?.data;
  if (err?.response?.status === 403) {
    return body?.message || 'Your role does not have permission for this action.';
  }
  return body?.error || body?.message || fallback;
}

export default function OperationsDesk() {
  const [params, setParams] = useSearchParams();
  const { canAccess } = useAuth();
  // Mirror the API gate: a cashier has no business on the BIR/dunning policy
  // tab, and a technician has none on the drawer. Hiding beats a 403 toast.
  const tabs = TABS.filter(([, , perm]) => canAccess(perm));
  const requested = (params.get('tab') as Tab) || 'subscriber';
  const tab = tabs.some(([id]) => id === requested) ? requested : (tabs[0]?.[0] ?? 'subscriber');
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
        {tabs.map(([id, label]) => (
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
  const { canAccess } = useAuth();
  const canTakeMoney = canAccess('sales') || canAccess('invoices') || canAccess('finance');
  const canPushCpe = canAccess('network') || canAccess('tech-tools');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<any[]>([]);
  const [hub, setHub] = useState<any>(null);
  const [pay, setPay] = useState({ amount: '', method: 'cash', extendMonths: '0', note: '' });
  const [wifi, setWifi] = useState({ ssid: '', password: '' });
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (initialId > 0) {
      api
        .get(`/isp/subscribers/${initialId}`)
        .then((r) => setHub(r.data))
        .catch((e) => {
          setHub(null);
          setErr(apiError(e, 'Could not load that subscriber.'));
        });
    }
  }, [initialId]);

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    const t = window.setTimeout(() => {
      api
        .get('/isp/subscribers', { params: { q } })
        .then((r) => setHits(r.data))
        .catch((e) => {
          setHits([]);
          setErr(apiError(e, 'Subscriber search failed.'));
        });
    }, 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const open = (id: number) => {
    setMsg('');
    setErr('');
    api
      .get(`/isp/subscribers/${id}`)
      .then((r) => setHub(r.data))
      .catch((e) => setErr(apiError(e, 'Could not load that subscriber.')));
  };

  const takePayment = async () => {
    if (!hub?.user?.id) return;
    const amount = Number(pay.amount);
    if (!(amount > 0)) {
      setErr('Enter an amount greater than zero.');
      return;
    }
    const months = Number(pay.extendMonths) || 0;
    if (
      months > 0 &&
      !window.confirm(
        `Issue an official receipt for ${peso(amount)} and extend ${hub.user.customer_name || hub.user.username} by ${months} month(s)?`
      )
    ) {
      return;
    }
    setBusy(true);
    setMsg('');
    setErr('');
    try {
      const r = await api.post(
        '/isp/payments',
        { pppoeUserId: hub.user.id, amount, method: pay.method, extendMonths: months, note: pay.note },
        // Extending restores the router too, which waits on a MikroTik round trip.
        { timeout: 45000 }
      );
      setMsg(
        months > 0
          ? `Receipt ${r.data.or_number} recorded — service restored and expiry re-armed.`
          : `Receipt ${r.data.or_number} recorded.`
      );
      setPay({ amount: '', method: pay.method, extendMonths: '0', note: '' });
      open(hub.user.id);
    } catch (e: unknown) {
      setErr(apiError(e, 'Payment failed'));
    } finally {
      setBusy(false);
    }
  };

  const reversePayment = async (p: any) => {
    const reason = window.prompt(`Reverse receipt ${p.or_number} (${peso(p.amount)})? Give a reason:`);
    if (reason == null || !reason.trim()) return;
    setBusy(true);
    setMsg('');
    setErr('');
    try {
      await api.post(`/isp/payments/${p.id}/reverse`, { reason: reason.trim() });
      setMsg(
        `Receipt ${p.or_number} reversed.${
          Number(p.extend_months) > 0 ? ' The extension was rolled back — run Recheck Expiry if the account is now past due.' : ''
        }`
      );
      open(hub.user.id);
    } catch (e: unknown) {
      setErr(apiError(e, 'Reversal failed'));
    } finally {
      setBusy(false);
    }
  };

  const cpe = async (action: string) => {
    if (!hub?.user?.id) return;
    if (action === 'reboot' && !window.confirm('Reboot this subscriber\'s router now?')) return;
    setBusy(true);
    setMsg('');
    setErr('');
    try {
      await api.post(
        `/isp/subscribers/${hub.user.id}/cpe`,
        { action, ssid: wifi.ssid, password: wifi.password },
        { timeout: 45000 }
      );
      setMsg(action === 'wifi' ? 'Wi-Fi push queued.' : `${action} queued on the CPE.`);
    } catch (e: unknown) {
      setErr(apiError(e, 'CPE action failed'));
    } finally {
      setBusy(false);
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
        {!u && !err && <p className="text-sm text-slate-500">Search a subscriber. PPPoE rows also open this page.</p>}
        <Flash message={err} type="error" onDismiss={() => setErr('')} />
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
              {canTakeMoney && (
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
                  <input className="input" placeholder="Note (optional)" value={pay.note} onChange={(e) => setPay({ ...pay, note: e.target.value })} />
                  <p className="text-[11px] text-slate-500">
                    Extending settles open invoices, restores the MikroTik profile and re-arms expiry for the new due date.
                  </p>
                  <button type="button" className="btn-primary text-sm" disabled={busy} onClick={() => void takePayment()}>
                    {busy ? 'Working…' : 'Issue official receipt'}
                  </button>
                </div>
              )}
              {canPushCpe && (
                <div className="space-y-2">
                  <div className="text-sm font-medium">CPE</div>
                  <input className="input" placeholder="Wi-Fi name" value={wifi.ssid} onChange={(e) => setWifi({ ...wifi, ssid: e.target.value })} />
                  <input className="input" placeholder="Wi-Fi password" value={wifi.password} onChange={(e) => setWifi({ ...wifi, password: e.target.value })} />
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={() => void cpe('wifi')}>Push Wi-Fi</button>
                    <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={() => void cpe('reboot')}>Reboot</button>
                    <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={() => void cpe('refresh')}>Refresh</button>
                  </div>
                  {!u.acs_device_id && (
                    <p className="text-[11px] text-amber-700">No CPE linked — attach one on the CPE / TR-069 page first.</p>
                  )}
                </div>
              )}
            </div>
            <div>
              <div className="text-xs font-semibold text-slate-500 uppercase">Receipts</div>
              {(hub.payments || []).length === 0 && <p className="text-xs text-slate-400">None yet.</p>}
              <ul className="text-xs text-slate-700 space-y-0.5">
                {(hub.payments || []).map((p: any) => (
                  <li key={p.id} className="flex items-center justify-between gap-2">
                    <span className={p.reversed_at ? 'line-through text-slate-400' : ''}>
                      {p.or_number} · {peso(p.amount)} · {p.method} · {p.cashier_username || '—'}
                      {Number(p.extend_months) > 0 ? ` · +${p.extend_months}mo` : ''}
                    </span>
                    {canTakeMoney && !p.reversed_at && (
                      <button
                        type="button"
                        className="text-[11px] text-rose-700 underline shrink-0"
                        disabled={busy}
                        onClick={() => void reversePayment(p)}
                      >
                        Reverse
                      </button>
                    )}
                    {p.reversed_at && <span className="text-[11px] text-slate-400 shrink-0">reversed</span>}
                  </li>
                ))}
              </ul>
            </div>
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
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () =>
    api
      .get('/isp/aging')
      .then((r) => setRows(r.data))
      .catch((e) => setErr(apiError(e, 'Could not load the aging list.')));
  useEffect(() => { void load(); }, []);
  const runDunning = async () => {
    if (!window.confirm('Send the dunning SMS to everyone due today? This texts real subscribers.')) return;
    setBusy(true);
    setErr('');
    try {
      const r = await api.post('/isp/dunning/run', {}, { timeout: 120000 });
      setMsg(`SMS sent: ${r.data.sent}`);
    } catch (e: unknown) {
      setErr(apiError(e, 'Dunning run failed.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-4">
      <div className="flex justify-between items-center mb-2">
        <h2 className="font-semibold">Past due</h2>
        <button type="button" className="btn-secondary text-xs" disabled={busy} onClick={() => void runDunning()}>
          {busy ? 'Sending…' : 'Send dunning SMS now'}
        </button>
      </div>
      <Flash message={err} type="error" onDismiss={() => setErr('')} />
      {msg && <p className="text-xs text-emerald-700 mb-2">{msg}</p>}
      {rows.length === 0 && <p className="text-sm text-slate-500">Nobody is past due.</p>}
      <ul className="text-sm divide-y">
        {rows.slice(0, 80).map((r) => (
          <li key={r.id} className="py-1.5 flex justify-between gap-2">
            <span>{r.customer_name || r.username} · {r.nap_name || 'no NAP'}</span>
            <span className="text-rose-700">{r.daysPastDue}d · {peso(r.price || 0)}/mo</span>
          </li>
        ))}
      </ul>
      {rows.length > 80 && <p className="text-xs text-slate-400 mt-2">Showing the 80 oldest of {rows.length}.</p>}
    </Card>
  );
}

function CashierTab() {
  const [data, setData] = useState<any>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () =>
    api
      .get('/isp/cashier-close')
      .then((r) => setData(r.data))
      .catch((e) => setErr(apiError(e, 'Could not load today\'s tickets.')));
  useEffect(() => { void load(); }, []);
  const total = (data?.payments || []).reduce((sum: number, p: any) => sum + (Number(p.amount) || 0), 0);
  const close = async () => {
    if (!window.confirm('Close your drawer for today? This snapshots your totals.')) return;
    setBusy(true);
    setErr('');
    try {
      await api.post('/isp/cashier-close', { note });
      setNote('');
      await load();
    } catch (e: unknown) {
      setErr(apiError(e, 'Drawer close failed.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-4 space-y-3">
      <h2 className="font-semibold">Today&apos;s tickets</h2>
      <Flash message={err} type="error" onDismiss={() => setErr('')} />
      {(data?.payments || []).length === 0 && <p className="text-sm text-slate-500">No tickets yet today.</p>}
      <ul className="text-sm">
        {(data?.payments || []).map((p: any) => (
          <li key={p.id} className="flex justify-between py-1">
            <span>{p.or_number} · {p.customer_name} · {p.method} · {p.cashier_username}</span>
            <span>{peso(p.amount)}</span>
          </li>
        ))}
      </ul>
      {(data?.payments || []).length > 0 && (
        <p className="text-sm font-medium flex justify-between border-t pt-2">
          <span>Total</span>
          <span>{peso(total)}</span>
        </p>
      )}
      <FormField label="Close note">
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </FormField>
      <button type="button" className="btn-primary text-sm" disabled={busy} onClick={() => void close()}>
        {busy ? 'Closing…' : 'Close my drawer'}
      </button>
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
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .get('/isp/nap-dispatch')
      .then((r) => setRows(r.data))
      .catch((e) => setErr(apiError(e, 'Could not load NAP dispatch.')));
  }, []);
  const selected = rows.find((n) => String(n.id) === napId);
  const broadcast = async () => {
    if (!napId && !pon.trim()) {
      setErr('Pick a NAP from the list or enter a PON / PLC port first.');
      return;
    }
    const where = selected ? selected.name : `PON ${pon}`;
    if (!window.confirm(`SMS every subscriber on ${where}? This texts real subscribers.`)) return;
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      const r = await api.post(
        '/isp/broadcast',
        { napId: napId ? Number(napId) : undefined, pon: pon.trim() || undefined, message },
        { timeout: 120000 }
      );
      setMsg(`Targets ${r.data.targets}, SMS ${r.data.sent}`);
    } catch (e: unknown) {
      setErr(apiError(e, 'Broadcast failed.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-4 space-y-3">
      <h2 className="font-semibold">Morning dispatch</h2>
      <Flash message={err} type="error" onDismiss={() => setErr('')} />
      {rows.length === 0 && <p className="text-sm text-slate-500">No NAPs defined yet.</p>}
      {/* Pick the NAP here — the broadcast box used to ask for a raw id this
          list never displayed. */}
      <ul className="text-sm divide-y">
        {rows.map((n) => (
          <li key={n.id}>
            <button
              type="button"
              className={`w-full text-left py-1.5 flex justify-between gap-2 px-2 rounded ${String(n.id) === napId ? 'bg-brand-50 font-medium' : ''}`}
              onClick={() => setNapId(String(n.id) === napId ? '' : String(n.id))}
            >
              <span>{n.name}</span>
              <span className="text-xs text-slate-500">fill {n.fill_count}/{n.ports || '—'} · offline {n.offline_count} · jobs {n.open_jobs}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="text-xs text-slate-500">
        {selected ? `Selected: ${selected.name}` : 'No NAP selected — tap one above, or target a PON below.'}
      </div>
      <FormField label="PON / PLC port (instead of a NAP)">
        <input className="input" placeholder="e.g. 0/1/2" value={pon} onChange={(e) => setPon(e.target.value)} />
      </FormField>
      <textarea className="input min-h-[70px]" value={message} onChange={(e) => setMessage(e.target.value)} />
      <button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => void broadcast()}>
        {busy ? 'Sending…' : 'SMS this area'}
      </button>
      {msg && <p className="text-xs text-emerald-700">{msg}</p>}
    </Card>
  );
}

function FinanceTab() {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api
      .get('/isp/finance')
      .then((r) => setData(r.data))
      .catch((e) => setErr(apiError(e, 'Could not load collections.')));
  }, []);
  if (err) return <Flash message={err} type="error" onDismiss={() => setErr('')} />;
  if (!data) return <Card className="p-4 text-sm text-slate-500">Loading collections…</Card>;
  return (
    <div className="grid md:grid-cols-3 gap-3">
      <Card className="p-4">
        <h2 className="font-semibold mb-2">By cashier today</h2>
        {(data.byCashier || []).length === 0 && <p className="text-sm text-slate-500">Nothing collected yet.</p>}
        {(data.byCashier || []).map((r: any) => <p key={r.cashier} className="text-sm">{r.cashier}: {peso(r.total)} ({r.tickets})</p>)}
      </Card>
      <Card className="p-4">
        <h2 className="font-semibold mb-2">By area today</h2>
        {(data.byArea || []).length === 0 && <p className="text-sm text-slate-500">Nothing collected yet.</p>}
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
  const { canAccess } = useAuth();
  const [publicIp, setPublicIp] = useState('');
  const [at, setAt] = useState('');
  const [line, setLine] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [searched, setSearched] = useState(false);
  const search = async () => {
    setErr('');
    try {
      const [cg, ss] = await Promise.all([
        api.get('/isp/cgnat', { params: { publicIp, at } }),
        api.get('/isp/sessions', { params: { ip: publicIp, at } }),
      ]);
      setRows(cg.data);
      setSessions(ss.data);
      setSearched(true);
    } catch (e: unknown) {
      setErr(apiError(e, 'Lookup failed.'));
    }
  };
  const storeLine = async () => {
    setErr('');
    try {
      const r = await api.post('/isp/cgnat', { line });
      setMsg(r.data.stored > 0 ? 'Line stored.' : 'Nothing parsed from that line — check the format.');
      if (r.data.stored > 0) setLine('');
    } catch (e: unknown) {
      setErr(apiError(e, 'Could not store that line.'));
    }
  };
  const downloadRadius = async () => {
    setErr('');
    try {
      const r = await api.get('/isp/radius-users', { responseType: 'text' });
      const blob = new Blob([r.data], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'radius-users.txt';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      setErr(apiError(e, 'RADIUS export failed.'));
    }
  };
  return (
    <Card className="p-4 space-y-3">
      <Flash message={err} type="error" onDismiss={() => setErr('')} />
      <p className="text-xs text-slate-500">Paste firewall or CGNAT lines: <code>2026-10-23T01:00:00Z 10.0.0.5:1234 203.0.113.8:54321 tcp</code></p>
      <textarea className="input min-h-[60px]" placeholder="One log line" value={line} onChange={(e) => setLine(e.target.value)} />
      <button type="button" className="btn-secondary text-xs" disabled={!line.trim()} onClick={() => void storeLine()}>Store line</button>
      {msg && <p className="text-xs text-emerald-700">{msg}</p>}
      <div className="grid sm:grid-cols-2 gap-2">
        <input className="input" placeholder="Public or framed IP" value={publicIp} onChange={(e) => setPublicIp(e.target.value)} />
        <input className="input" placeholder="At time (ISO)" value={at} onChange={(e) => setAt(e.target.value)} />
      </div>
      <button type="button" className="btn-primary text-sm" onClick={() => void search()}>Search</button>
      <h3 className="text-sm font-medium">CGNAT</h3>
      {searched && rows.length === 0 && <p className="text-xs text-slate-400">No CGNAT records for that IP and time.</p>}
      <ul className="text-xs font-mono">{rows.map((r) => <li key={r.id}>{r.seen_at} {r.src_ip}:{r.src_port} → {r.public_ip}:{r.public_port} {r.username || ''}</li>)}</ul>
      <h3 className="text-sm font-medium">Sessions</h3>
      {searched && sessions.length === 0 && <p className="text-xs text-slate-400">No sessions matched.</p>}
      <ul className="text-xs">{sessions.map((s) => <li key={s.id}>{s.username} {s.framed_ip} {s.started_at} → {s.stopped_at || 'open'}</li>)}</ul>
      {/* Cleartext PPPoE secrets — same gate the API applies. */}
      {canAccess('settings') && (
        <div className="border-t pt-3">
          <button type="button" className="text-sm text-brand-600 underline" onClick={() => void downloadRadius()}>
            Download RADIUS users file
          </button>
          <p className="text-[11px] text-amber-700 mt-1">
            Contains every active subscriber&apos;s PPPoE password in cleartext. Hand it straight to the RADIUS host.
          </p>
        </div>
      )}
    </Card>
  );
}

function StatusAdminTab() {
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () =>
    api
      .get('/isp/outages')
      .then((r) => setRows(r.data))
      .catch((e) => setErr(apiError(e, 'Could not load outages.')));
  useEffect(() => { void load(); }, []);
  const publish = async () => {
    if (!title.trim()) {
      setErr('Give the outage a title.');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      await api.post('/isp/outages', { title: title.trim(), detail });
      setTitle('');
      setDetail('');
      await load();
    } catch (e: unknown) {
      setErr(apiError(e, 'Could not publish that outage.'));
    } finally {
      setBusy(false);
    }
  };
  const clear = async (id: number) => {
    setErr('');
    try {
      await api.post(`/isp/outages/${id}/clear`);
      await load();
    } catch (e: unknown) {
      setErr(apiError(e, 'Could not clear that outage.'));
    }
  };
  return (
    <Card className="p-4 space-y-2">
      <p className="text-sm">Public page: <a className="text-brand-600 underline" href="/area-status" target="_blank" rel="noreferrer">/area-status</a></p>
      <Flash message={err} type="error" onDismiss={() => setErr('')} />
      <input className="input" placeholder="Title (e.g. NAP 12 fiber cut)" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input className="input" placeholder="Detail / ETA" value={detail} onChange={(e) => setDetail(e.target.value)} />
      <button type="button" className="btn-primary text-sm" disabled={busy} onClick={() => void publish()}>
        {busy ? 'Publishing…' : 'Publish outage'}
      </button>
      {rows.length === 0 && <p className="text-sm text-slate-500">No outages posted.</p>}
      <ul className="text-sm">
        {rows.map((o) => (
          <li key={o.id} className="flex justify-between py-1">
            <span>{o.status}: {o.title}</span>
            {o.status === 'open' && <button type="button" className="text-xs underline" onClick={() => void clear(o.id)}>Clear</button>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function PolicyTab() {
  const [form, setForm] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api
      .get('/isp/settings')
      .then((r) => setForm(r.data))
      .catch((e) => setErr(apiError(e, 'Could not load the policy settings.')));
  }, []);
  if (err && !form) return <Flash message={err} type="error" onDismiss={() => setErr('')} />;
  if (!form) return <Card className="p-4 text-sm text-slate-500">Loading policy…</Card>;
  const save = async () => {
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      await api.put('/isp/settings', {
        branchName: form.branch_name,
        birOrPrefix: form.bir_or_prefix,
        radiusNasIp: form.radius_nas_ip,
        dunningEnabled: !!form.dunning_enabled,
        dunningWarnDays: form.dunning_warn_days,
        dunningDisconnectDay: Number(form.dunning_disconnect_day),
        dunningMessage: form.dunning_message,
      });
      setMsg('Saved.');
    } catch (e: unknown) {
      setErr(apiError(e, 'Save failed.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-4 space-y-2 max-w-xl">
      <Flash message={err} type="error" onDismiss={() => setErr('')} />
      <FormField label="Branch name"><input className="input" value={form.branch_name || ''} onChange={(e) => setForm({ ...form, branch_name: e.target.value })} /></FormField>
      <FormField label="Official receipt prefix" hint="The OR series is per site — it is deliberately not shared by hub/edge sync."><input className="input" value={form.bir_or_prefix || ''} onChange={(e) => setForm({ ...form, bir_or_prefix: e.target.value })} /></FormField>
      <FormField label="Next OR number">{form.bir_or_next}</FormField>
      <FormField label="RADIUS NAS IP"><input className="input" value={form.radius_nas_ip || ''} onChange={(e) => setForm({ ...form, radius_nas_ip: e.target.value })} /></FormField>
      <FormField label="Warn on these days past due"><input className="input" value={form.dunning_warn_days || ''} onChange={(e) => setForm({ ...form, dunning_warn_days: e.target.value })} /></FormField>
      <FormField label="Disconnect day"><input className="input" value={form.dunning_disconnect_day || 7} onChange={(e) => setForm({ ...form, dunning_disconnect_day: e.target.value })} /></FormField>
      <FormField label="SMS template"><textarea className="input min-h-[80px]" value={form.dunning_message || ''} onChange={(e) => setForm({ ...form, dunning_message: e.target.value })} /></FormField>
      <label className="text-sm flex items-center gap-2">
        <input type="checkbox" checked={!!form.dunning_enabled} onChange={(e) => setForm({ ...form, dunning_enabled: e.target.checked ? 1 : 0 })} />
        Automatic dunning SMS
      </label>
      <button type="button" className="btn-primary text-sm" disabled={busy} onClick={() => void save()}>
        {busy ? 'Saving…' : 'Save policy'}
      </button>
      {msg && <p className="text-xs text-emerald-700">{msg}</p>}
    </Card>
  );
}
