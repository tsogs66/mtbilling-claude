import { useEffect, useMemo, useState } from 'react';
import { Wallet, FileText, LifeBuoy, LogOut } from 'lucide-react';
import { peso } from '../api';
import { getApiBase } from '../config';
import Logo from '../components/Logo';
import { PRODUCT_TITLE } from '../branding';

const TOKEN_KEY = 'mt_portal_token';

type PortalSettings = {
  title?: string;
  subtitle?: string;
  helpText?: string;
  welcomeText?: string;
  showBalance?: boolean;
  showInvoices?: boolean;
  showTickets?: boolean;
  showCompany?: boolean;
};

type OutageServiceOpt = {
  slug: string;
  name: string;
  category: string;
  region: string;
};

async function portalFetch(path: string, opts: RequestInit = {}) {
  const token = localStorage.getItem(TOKEN_KEY) || '';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers as any),
  };
  if (token) headers['X-Portal-Token'] = token;
  const res = await fetch(`${getApiBase()}${path}`, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export default function ClientPortal() {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || '');
  const [account, setAccount] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [me, setMe] = useState<any>(null);
  const [ticket, setTicket] = useState('');
  const [ticketMsg, setTicketMsg] = useState('');
  const [pageSettings, setPageSettings] = useState<PortalSettings>({});
  const [outageServices, setOutageServices] = useState<OutageServiceOpt[]>([]);
  const [selectedServices, setSelectedServices] = useState<string[]>([]);
  const [serviceFilter, setServiceFilter] = useState('');

  const loadMe = async (t = token) => {
    if (!t) return;
    const data = await portalFetch('/public/portal/me');
    setMe(data);
    if (data.settings) setPageSettings(data.settings);
  };

  useEffect(() => {
    portalFetch('/public/portal/settings')
      .then((s) => setPageSettings(s || {}))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!token) return;
    loadMe().catch(() => {
      localStorage.removeItem(TOKEN_KEY);
      setToken('');
      setMe(null);
    });
    portalFetch('/public/portal/outage-services')
      .then((d) => setOutageServices(d.services || []))
      .catch(() => setOutageServices([]));
  }, [token]);

  const servicesByCategory = useMemo(() => {
    const q = serviceFilter.trim().toLowerCase();
    const map = new Map<string, OutageServiceOpt[]>();
    for (const s of outageServices) {
      if (q && !s.name.toLowerCase().includes(q) && !s.category.toLowerCase().includes(q)) continue;
      const list = map.get(s.category) || [];
      list.push(s);
      map.set(s.category, list);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [outageServices, serviceFilter]);

  const toggleService = (slug: string) => {
    setSelectedServices((prev) =>
      prev.includes(slug) ? prev.filter((x) => x !== slug) : [...prev, slug]
    );
  };

  const login = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await portalFetch('/public/portal/login', {
        method: 'POST',
        body: JSON.stringify({ account, pin }),
      });
      localStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token);
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    try {
      await portalFetch('/public/portal/logout', { method: 'POST', body: '{}' });
    } catch {
      /* ignore */
    }
    localStorage.removeItem(TOKEN_KEY);
    setToken('');
    setMe(null);
    setSelectedServices([]);
  };

  const submitTicket = async () => {
    setTicketMsg('');
    if (!ticket.trim() && !selectedServices.length) {
      setTicketMsg('Describe the issue or select one or more affected services.');
      return;
    }
    try {
      const data = await portalFetch('/public/portal/ticket', {
        method: 'POST',
        body: JSON.stringify({
          description: ticket,
          type: selectedServices.length ? 'other' : 'repair',
          serviceSlugs: selectedServices,
        }),
      });
      setTicket('');
      setSelectedServices([]);
      const named = data?.outageReport?.serviceNames?.join(', ');
      setTicketMsg(
        named
          ? `Report submitted. Outage noted for: ${named}. Our team will follow up.`
          : 'Support request submitted. Our team will follow up.'
      );
      loadMe();
    } catch (err: any) {
      setTicketMsg(err.message || 'Failed');
    }
  };

  const title = pageSettings.title || 'Subscriber Portal';
  const subtitle = pageSettings.subtitle || PRODUCT_TITLE;
  const helpText = pageSettings.helpText || 'Ask your ISP for portal access (account + PIN).';

  if (!token || !me) {
    return (
      <div className="min-h-screen bg-slate-950 bg-mesh-dark flex items-center justify-center p-4">
        <form onSubmit={login} className="w-full max-w-md bg-white rounded-2xl shadow-xl p-8 space-y-4">
          <div className="flex flex-col items-center gap-3 mb-2">
            <Logo size="md" variant="light" />
            <div className="text-center">
              <h1 className="text-xl font-bold text-slate-800">{title}</h1>
              <p className="text-sm text-slate-500">{subtitle}</p>
            </div>
          </div>
          {error && <div className="text-sm text-rose-600 bg-rose-50 rounded-lg px-3 py-2">{error}</div>}
          <label className="block text-sm font-medium text-slate-700">
            Account number
            <input className="input mt-1" value={account} onChange={(e) => setAccount(e.target.value)} required autoComplete="username" />
          </label>
          <label className="block text-sm font-medium text-slate-700">
            PIN
            <input className="input mt-1" type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} required autoComplete="current-password" />
          </label>
          <button className="btn-primary w-full justify-center" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
          <p className="text-xs text-slate-400 text-center">{helpText}</p>
        </form>
      </div>
    );
  }

  const c = me.customer;
  const s: PortalSettings = me.settings || pageSettings;
  const showBalance = s.showBalance !== false;
  const showInvoices = s.showInvoices !== false;
  const showTickets = s.showTickets !== false;
  const showCompany = s.showCompany !== false;

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-slate-900 text-white px-4 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Logo size="sm" variant="dark" />
          <div>
            <div className="font-semibold">{c.name}</div>
            <div className="text-xs text-slate-400">{c.accountNumber || '—'} · {c.status}</div>
          </div>
        </div>
        <button onClick={logout} className="inline-flex items-center gap-2 text-sm text-slate-300 hover:text-white">
          <LogOut size={16} /> Sign out
        </button>
      </header>

      <main className="max-w-3xl mx-auto p-4 space-y-4">
        {s.welcomeText && (
          <div className="bg-brand-50 border border-brand-100 text-brand-900 rounded-xl px-4 py-3 text-sm">
            {s.welcomeText}
          </div>
        )}

        <div className={`grid gap-3 ${showBalance ? 'grid-cols-2' : 'grid-cols-1'}`}>
          {showBalance && (
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wide mb-1"><Wallet size={14} /> Balance due</div>
              <div className="text-2xl font-bold text-rose-600">{peso(me.balance || 0)}</div>
            </div>
          )}
          <div className="bg-white rounded-xl border border-slate-200 p-4">
            <div className="text-xs text-slate-500 uppercase tracking-wide mb-1">Plan</div>
            <div className="font-semibold text-slate-800">{c.plan || '—'}</div>
            <div className="text-sm text-slate-500">{peso(c.price)} · due {c.due || '—'}</div>
          </div>
        </div>

        {showCompany && me.company && (
          <div className="bg-white rounded-xl border border-slate-200 p-4 text-sm text-slate-600">
            <div className="font-semibold text-slate-800 mb-1">{me.company.name}</div>
            {me.company.phone && <div>Tel: {me.company.phone}</div>}
            {me.company.gcash_number && <div>GCash: {me.company.gcash_number}</div>}
            {me.company.maya_number && <div>Maya: {me.company.maya_number}</div>}
          </div>
        )}

        {showInvoices && (
          <section className="bg-white rounded-xl border border-slate-200 p-4">
            <h2 className="font-semibold text-slate-800 flex items-center gap-2 mb-3"><FileText size={16} /> Statement of account</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-slate-400 border-b">
                    <th className="py-2">Invoice</th>
                    <th>Due</th>
                    <th className="text-right">Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(me.invoices || []).map((inv: any) => (
                    <tr key={inv.id} className="border-b border-slate-50">
                      <td className="py-2 font-mono text-xs">{inv.number}</td>
                      <td>{inv.due_date}</td>
                      <td className="text-right">{peso(inv.amount - inv.amount_paid)}</td>
                      <td className="capitalize">{inv.status}</td>
                    </tr>
                  ))}
                  {!me.invoices?.length && (
                    <tr><td colSpan={4} className="py-6 text-center text-slate-400">No invoices yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {showTickets && (
          <section className="bg-white rounded-xl border border-slate-200 p-4">
            <h2 className="font-semibold text-slate-800 flex items-center gap-2 mb-3"><LifeBuoy size={16} /> Request support</h2>
            <p className="text-xs text-slate-500 mb-3">
              Select any apps or services that are down (optional), then describe the issue. Service outage reports also appear on the ISP Outage Monitor.
            </p>
            {outageServices.length > 0 && (
              <div className="mb-3 rounded-xl border border-slate-100 bg-slate-50/80 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Affected services
                    {selectedServices.length > 0 && (
                      <span className="ml-1 normal-case font-medium text-brand-600">
                        ({selectedServices.length} selected)
                      </span>
                    )}
                  </div>
                  {selectedServices.length > 0 && (
                    <button
                      type="button"
                      className="text-xs text-slate-500 hover:text-slate-800"
                      onClick={() => setSelectedServices([])}
                    >
                      Clear
                    </button>
                  )}
                </div>
                <input
                  className="input mb-2 text-sm"
                  placeholder="Filter services (GCash, Facebook…)"
                  value={serviceFilter}
                  onChange={(e) => setServiceFilter(e.target.value)}
                />
                <div className="max-h-52 overflow-y-auto space-y-3 pr-1">
                  {servicesByCategory.map(([cat, items]) => (
                    <div key={cat}>
                      <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-1">{cat}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {items.map((svc) => {
                          const on = selectedServices.includes(svc.slug);
                          return (
                            <button
                              key={svc.slug}
                              type="button"
                              onClick={() => toggleService(svc.slug)}
                              className={`text-xs px-2.5 py-1 rounded-lg border transition ${
                                on
                                  ? 'bg-rose-50 border-rose-300 text-rose-800 font-semibold'
                                  : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
                              }`}
                            >
                              {svc.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                  {!servicesByCategory.length && (
                    <p className="text-xs text-slate-400 py-2">No services match that filter.</p>
                  )}
                </div>
              </div>
            )}
            <textarea
              className="input min-h-[90px] mb-2"
              placeholder="Describe the issue (no signal, slow, relocation…)"
              value={ticket}
              onChange={(e) => setTicket(e.target.value)}
            />
            <button
              className="btn-primary"
              disabled={!ticket.trim() && !selectedServices.length}
              onClick={submitTicket}
            >
              Submit report
            </button>
            {ticketMsg && <p className="text-sm text-slate-600 mt-2">{ticketMsg}</p>}
            {(me.openJobs || []).length > 0 && (
              <ul className="mt-4 space-y-2 text-sm">
                {me.openJobs.map((j: any) => (
                  <li key={j.id} className="flex justify-between border-t border-slate-50 pt-2">
                    <span className="font-mono text-xs">{j.number}</span>
                    <span className="capitalize text-slate-500">{j.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
