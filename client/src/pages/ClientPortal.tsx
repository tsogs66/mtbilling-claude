import { useEffect, useState } from 'react';
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
  }, [token]);

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
  };

  const submitTicket = async () => {
    setTicketMsg('');
    try {
      await portalFetch('/public/portal/ticket', {
        method: 'POST',
        body: JSON.stringify({ description: ticket, type: 'repair' }),
      });
      setTicket('');
      setTicketMsg('Support request submitted. Our team will follow up.');
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
            <textarea
              className="input min-h-[90px] mb-2"
              placeholder="Describe the issue (no signal, slow, relocation…)"
              value={ticket}
              onChange={(e) => setTicket(e.target.value)}
            />
            <button className="btn-primary" disabled={!ticket.trim()} onClick={submitTicket}>Submit ticket</button>
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
