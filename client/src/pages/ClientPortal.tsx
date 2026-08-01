import { useEffect, useMemo, useState } from 'react';
import {
  Wallet, FileText, LifeBuoy, LogOut, CreditCard, ExternalLink, Copy, Check,
  Phone, Building2, ChevronRight, Sparkles, Download, Share, X,
} from 'lucide-react';
import { peso } from '../api';
import { getApiBase } from '../config';
import Logo from '../components/Logo';
import { PRODUCT_TITLE } from '../branding';
import { usePortalInstall } from '../lib/portalInstall';

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

type PaymentLink = {
  path: string;
  url: string;
  amount: number;
  months: number;
  status: string;
  expiresAt?: string | null;
  payChannel?: string | null;
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

function copyText(text: string) {
  return navigator.clipboard?.writeText(text).catch(() => undefined);
}

function statusTone(status?: string) {
  const s = String(status || '').toLowerCase();
  if (s === 'active' || s === 'paid') return 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30';
  if (s === 'overdue' || s === 'suspended') return 'bg-rose-500/15 text-rose-300 ring-rose-400/30';
  if (s === 'partial' || s === 'pending' || s === 'submitted') return 'bg-amber-500/15 text-amber-200 ring-amber-400/30';
  return 'bg-white/10 text-slate-300 ring-white/15';
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
  const [payBusy, setPayBusy] = useState(false);
  const [payMsg, setPayMsg] = useState('');
  const [copied, setCopied] = useState('');
  const { installed, showInstallButton, iosHint, dismissIosHint, install } = usePortalInstall();

  const loadMe = async () => {
    if (!localStorage.getItem(TOKEN_KEY)) return;
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

  const onCopy = async (label: string, value: string) => {
    await copyText(value);
    setCopied(label);
    setTimeout(() => setCopied(''), 1800);
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
    setPayMsg('');
  };

  const openPayment = async () => {
    setPayMsg('');
    const existing: PaymentLink | null = me?.paymentLink || null;
    if (existing?.path) {
      window.location.href = existing.path;
      return;
    }
    setPayBusy(true);
    try {
      const data = await portalFetch('/public/portal/payment-link', {
        method: 'POST',
        body: '{}',
      });
      const link: PaymentLink | null = data.paymentLink || null;
      setMe((prev: any) => (prev ? { ...prev, paymentLink: link } : prev));
      if (link?.path) window.location.href = link.path;
      else setPayMsg('Payment page is not available yet. Contact your ISP.');
    } catch (err: any) {
      setPayMsg(err.message || 'Could not open payment page');
    } finally {
      setPayBusy(false);
    }
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
      <div
        className="subscriber-portal subscriber-portal--login min-h-full flex items-center justify-center p-4 relative overflow-x-hidden"
        style={{ fontFamily: "Manrope, 'Space Grotesk', system-ui, sans-serif" }}
      >
        <div className="absolute inset-0 bg-slate-950" />
        <div
          className="absolute inset-0 opacity-90"
          style={{
            backgroundImage:
              'radial-gradient(ellipse 80% 60% at 15% 10%, rgba(249,115,22,0.28), transparent 55%), radial-gradient(ellipse 70% 50% at 90% 20%, rgba(14,165,233,0.18), transparent 50%), radial-gradient(ellipse 60% 40% at 50% 100%, rgba(16,185,129,0.12), transparent 45%)',
          }}
        />
        <div
          className="absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              'linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px)',
            backgroundSize: '48px 48px',
          }}
        />

        <form
          onSubmit={login}
          className="relative w-full max-w-md rounded-3xl border border-white/10 bg-white/[0.06] backdrop-blur-xl shadow-2xl p-8 space-y-5"
        >
          <div className="flex flex-col items-center gap-4 mb-1">
            <div>
              <Logo size="md" variant="dark" />
            </div>
            <div className="text-center">
              <h1
                className="text-2xl font-bold text-white tracking-tight"
                style={{ fontFamily: "'Space Grotesk', Manrope, sans-serif" }}
              >
                {title}
              </h1>
              <p className="text-sm text-slate-400 mt-1">{subtitle}</p>
            </div>
          </div>
          {error && (
            <div className="text-sm text-rose-200 bg-rose-500/15 border border-rose-400/20 rounded-xl px-3 py-2">
              {error}
            </div>
          )}
          <label className="block text-sm font-medium text-slate-300">
            Account number
            <input
              className="mt-1.5 w-full rounded-xl border border-white/10 bg-slate-950/50 text-white px-3 py-2.5 outline-none focus:border-orange-400/60 focus:ring-2 focus:ring-orange-400/20"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              required
              autoComplete="username"
              placeholder="e.g. ACC-00123"
            />
          </label>
          <label className="block text-sm font-medium text-slate-300">
            PIN
            <input
              className="mt-1.5 w-full rounded-xl border border-white/10 bg-slate-950/50 text-white px-3 py-2.5 outline-none focus:border-orange-400/60 focus:ring-2 focus:ring-orange-400/20"
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              required
              autoComplete="current-password"
              placeholder="4–8 digits"
            />
          </label>
          <button
            className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-orange-500 hover:bg-orange-400 text-slate-950 font-semibold py-3 transition shadow-[0_12px_40px_-12px_rgba(249,115,22,0.7)] disabled:opacity-60"
            disabled={busy}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          {showInstallButton && (
            <button
              type="button"
              onClick={() => void install()}
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 hover:bg-white/10 text-white font-semibold py-3 transition"
            >
              <Download size={18} /> Install app
            </button>
          )}
          {installed && (
            <p className="text-xs text-emerald-300/90 text-center">Installed on this device</p>
          )}
          <p className="text-xs text-slate-500 text-center leading-relaxed">{helpText}</p>
          {iosHint && <IosInstallHint onClose={dismissIosHint} />}
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
  const paymentLink: PaymentLink | null = me.paymentLink || null;
  const balance = Number(me.balance) || 0;
  const company = me.company || {};
  const payAmount = paymentLink?.amount || balance || Number(c.price) || 0;
  const canPay = balance > 0 || !!paymentLink || Number(c.price) > 0;

  const payCtaLabel = (() => {
    if (paymentLink?.status === 'submitted') return 'View payment status';
    if (paymentLink?.status === 'rejected') return 'Resubmit payment';
    if (paymentLink?.status === 'pending') return 'Pay now';
    if (balance > 0) return 'Open payment page';
    return 'Get payment link';
  })();

  return (
    <div
      className="subscriber-portal min-h-full bg-slate-100 text-slate-900"
      style={{ fontFamily: "Manrope, 'Space Grotesk', system-ui, sans-serif", color: '#0f172a' }}
    >
      <div className="subscriber-portal-hero relative overflow-hidden bg-slate-950 text-white">
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              'radial-gradient(ellipse 70% 80% at 0% 0%, rgba(249,115,22,0.35), transparent 55%), radial-gradient(ellipse 50% 60% at 100% 30%, rgba(14,165,233,0.2), transparent 50%)',
          }}
        />
        <header className="relative max-w-3xl mx-auto px-4 pt-5 pb-8">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <Logo size="sm" variant="dark" />
              <div className="min-w-0">
                <div
                  className="text-[11px] uppercase tracking-[0.22em] text-orange-300/90 font-semibold"
                >
                  {title}
                </div>
                <h1
                  className="text-xl sm:text-2xl font-bold tracking-tight truncate"
                  style={{ fontFamily: "'Space Grotesk', Manrope, sans-serif" }}
                >
                  {c.name}
                </h1>
                <div className="flex flex-wrap items-center gap-2 mt-1.5 text-xs text-slate-400">
                  <span className="font-mono">{c.accountNumber || '—'}</span>
                  <span className={`inline-flex px-2 py-0.5 rounded-full ring-1 capitalize ${statusTone(c.status)}`}>
                    {c.status || '—'}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              {showInstallButton && (
                <button
                  type="button"
                  onClick={() => void install()}
                  className="inline-flex items-center gap-1.5 text-sm text-orange-200 hover:text-white shrink-0 rounded-lg px-2.5 py-1.5 bg-orange-500/15 hover:bg-orange-500/25 ring-1 ring-orange-400/30 transition"
                  title="Install Subscriber Portal on this device"
                >
                  <Download size={16} /> Install
                </button>
              )}
              <button
                onClick={logout}
                className="inline-flex items-center gap-1.5 text-sm text-slate-300 hover:text-white shrink-0 rounded-lg px-2.5 py-1.5 hover:bg-white/5 transition"
              >
                <LogOut size={16} /> Sign out
              </button>
            </div>
          </div>

          {showInstallButton && (
            <button
              type="button"
              onClick={() => void install()}
              className="relative mt-4 w-full flex items-center gap-3 rounded-2xl border border-orange-400/30 bg-orange-500/10 hover:bg-orange-500/15 px-4 py-3 text-left transition"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-500 text-slate-950 shrink-0">
                <Download size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-semibold text-white text-sm">Install Subscriber Portal</span>
                <span className="block text-xs text-slate-300 mt-0.5">
                  Add to your home screen for faster access — works offline for the login page.
                </span>
              </span>
              <ChevronRight size={18} className="text-orange-200 shrink-0" />
            </button>
          )}

          {s.welcomeText && (
            <p className="relative mt-5 text-sm text-slate-300/95 leading-relaxed border-l-2 border-orange-400/50 pl-3">
              {s.welcomeText}
            </p>
          )}

          <div className="relative mt-6 grid grid-cols-2 gap-3">
            {showBalance && (
              <div className="rounded-2xl bg-white/5 border border-white/10 p-4 backdrop-blur-sm">
                <div className="flex items-center gap-2 text-slate-400 text-[11px] uppercase tracking-wider mb-1">
                  <Wallet size={13} /> Balance due
                </div>
                <div
                  className={`text-2xl sm:text-3xl font-bold tabular-nums ${balance > 0 ? 'text-rose-300' : 'text-emerald-300'}`}
                  style={{ fontFamily: "'Space Grotesk', Manrope, sans-serif" }}
                >
                  {peso(balance)}
                </div>
              </div>
            )}
            <div className={`rounded-2xl bg-white/5 border border-white/10 p-4 backdrop-blur-sm ${showBalance ? '' : 'col-span-2'}`}>
              <div className="text-[11px] text-slate-400 uppercase tracking-wider mb-1">Plan</div>
              <div className="font-semibold text-white truncate">{c.plan || '—'}</div>
              <div className="text-sm text-slate-400 mt-0.5">
                {peso(c.price)} · due {c.due || '—'}
              </div>
            </div>
          </div>
        </header>
      </div>

      <main className="portal-light relative max-w-3xl mx-auto px-4 -mt-4 pb-10 space-y-4">
        {/* Payment — deep-link to dedicated /pay page (proof upload lives there) */}
        <section className="rounded-2xl border border-orange-200/80 bg-gradient-to-br from-orange-50 via-white to-sky-50 shadow-lg shadow-orange-500/5 overflow-hidden">
          <div className="p-5 sm:p-6">
            <div className="flex items-start gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-orange-500 text-white shadow-md shadow-orange-500/30">
                <CreditCard size={20} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2
                    className="text-lg font-bold text-slate-900"
                    style={{ fontFamily: "'Space Grotesk', Manrope, sans-serif" }}
                  >
                    Pay your bill
                  </h2>
                  {paymentLink?.status && (
                    <span className="text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-slate-900/5 text-slate-600 capitalize">
                      {paymentLink.status === 'submitted' ? 'Awaiting review' : paymentLink.status}
                    </span>
                  )}
                </div>
                <p className="text-sm text-slate-600 mt-1 leading-relaxed">
                  {paymentLink
                    ? 'Open the secure payment page to send GCash or Maya with a screenshot proof.'
                    : 'Pay via GCash or Maya on the payment portal — upload your receipt there for faster posting.'}
                </p>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold">Amount</div>
                <div
                  className="text-3xl font-bold text-slate-900 tabular-nums"
                  style={{ fontFamily: "'Space Grotesk', Manrope, sans-serif" }}
                >
                  {peso(payAmount)}
                </div>
                {paymentLink?.months ? (
                  <div className="text-xs text-slate-500 mt-0.5">{paymentLink.months} month{paymentLink.months === 1 ? '' : 's'}</div>
                ) : null}
              </div>
              {canPay && (
                <button
                  type="button"
                  onClick={openPayment}
                  disabled={payBusy}
                  className="inline-flex items-center gap-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-semibold px-5 py-3 text-sm shadow-lg shadow-slate-900/20 disabled:opacity-60 transition"
                >
                  {payBusy ? 'Opening…' : payCtaLabel}
                  <ExternalLink size={16} />
                </button>
              )}
            </div>

            {(company.gcash_number || company.maya_number) && (
              <div className="mt-4 grid sm:grid-cols-2 gap-2">
                {company.gcash_number && (
                  <button
                    type="button"
                    onClick={() => onCopy('gcash', company.gcash_number)}
                    className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white/80 px-3 py-2.5 text-left hover:border-orange-300 transition"
                  >
                    <div>
                      <div className="text-[11px] font-semibold text-slate-500 uppercase">GCash</div>
                      <div className="font-mono text-sm text-slate-800">{company.gcash_number}</div>
                    </div>
                    {copied === 'gcash' ? <Check size={16} className="text-emerald-600" /> : <Copy size={16} className="text-slate-400" />}
                  </button>
                )}
                {company.maya_number && (
                  <button
                    type="button"
                    onClick={() => onCopy('maya', company.maya_number)}
                    className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white/80 px-3 py-2.5 text-left hover:border-sky-300 transition"
                  >
                    <div>
                      <div className="text-[11px] font-semibold text-slate-500 uppercase">Maya</div>
                      <div className="font-mono text-sm text-slate-800">{company.maya_number}</div>
                    </div>
                    {copied === 'maya' ? <Check size={16} className="text-emerald-600" /> : <Copy size={16} className="text-slate-400" />}
                  </button>
                )}
              </div>
            )}

            {company.payment_instructions && (
              <p className="mt-3 text-xs text-slate-500 leading-relaxed flex gap-1.5">
                <Sparkles size={12} className="mt-0.5 shrink-0 text-orange-500" />
                {company.payment_instructions}
              </p>
            )}
            {payMsg && <p className="mt-2 text-sm text-rose-600">{payMsg}</p>}
            {paymentLink?.expiresAt && paymentLink.status === 'pending' && (
              <p className="mt-2 text-[11px] text-slate-400">
                Link expires {String(paymentLink.expiresAt).replace('T', ' ').slice(0, 16)}
              </p>
            )}
          </div>
        </section>

        {showCompany && company.name && (
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="font-semibold text-slate-800 flex items-center gap-2 mb-2">
              <Building2 size={16} className="text-slate-500" /> {company.name}
            </h2>
            <div className="text-sm text-slate-600 space-y-1">
              {company.phone && (
                <div className="flex items-center gap-2">
                  <Phone size={14} className="text-slate-400" />
                  <a href={`tel:${company.phone}`} className="hover:text-orange-600">{company.phone}</a>
                </div>
              )}
              {company.email && <div className="text-slate-500">{company.email}</div>}
              {company.address && <div className="text-slate-500">{company.address}</div>}
            </div>
          </section>
        )}

        {showInvoices && (
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="font-semibold text-slate-800 flex items-center gap-2 mb-3">
              <FileText size={16} className="text-slate-500" /> Statement of account
            </h2>
            <div className="overflow-x-auto -mx-1">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-slate-400 border-b border-slate-100">
                    <th className="py-2 px-1 font-semibold">Invoice</th>
                    <th className="py-2 px-1 font-semibold">Due</th>
                    <th className="py-2 px-1 font-semibold text-right">Amount</th>
                    <th className="py-2 px-1 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(me.invoices || []).map((inv: any) => (
                    <tr key={inv.id} className="border-b border-slate-50 last:border-0">
                      <td className="py-2.5 px-1 font-mono text-xs text-slate-700">{inv.number}</td>
                      <td className="py-2.5 px-1 text-slate-600">{inv.due_date || '—'}</td>
                      <td className="py-2.5 px-1 text-right tabular-nums font-medium text-slate-800">
                        {peso(inv.amount - inv.amount_paid)}
                      </td>
                      <td className="py-2.5 px-1">
                        <span className="capitalize text-xs font-medium text-slate-600">{inv.status}</span>
                      </td>
                    </tr>
                  ))}
                  {!me.invoices?.length && (
                    <tr>
                      <td colSpan={4} className="py-8 text-center text-slate-400">No invoices yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {showTickets && (
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="font-semibold text-slate-800 flex items-center gap-2 mb-1">
              <LifeBuoy size={16} className="text-slate-500" /> Request support
            </h2>
            <p className="text-xs text-slate-500 mb-3 leading-relaxed">
              Select apps or services that are down (optional), then describe the issue. Service outages also appear on the ISP Outage Monitor.
            </p>
            {outageServices.length > 0 && (
              <div className="mb-3 rounded-xl border border-slate-100 bg-slate-50/90 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Affected services
                    {selectedServices.length > 0 && (
                      <span className="ml-1 normal-case font-medium text-orange-600">
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
                  className="portal-field w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 mb-2 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-400/20"
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
              className="portal-field w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 min-h-[90px] mb-2 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-400/20"
              placeholder="Describe the issue (no signal, slow, relocation…)"
              value={ticket}
              onChange={(e) => setTicket(e.target.value)}
            />
            <button
              className="inline-flex items-center gap-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-semibold px-4 py-2.5 text-sm disabled:opacity-50 transition"
              disabled={!ticket.trim() && !selectedServices.length}
              onClick={submitTicket}
            >
              Submit report <ChevronRight size={16} />
            </button>
            {ticketMsg && <p className="text-sm text-slate-600 mt-2">{ticketMsg}</p>}
            {(me.openJobs || []).length > 0 && (
              <ul className="mt-4 space-y-2 text-sm">
                {me.openJobs.map((j: any) => (
                  <li key={j.id} className="flex justify-between border-t border-slate-50 pt-2">
                    <span className="font-mono text-xs text-slate-700">{j.number}</span>
                    <span className="capitalize text-slate-500">{j.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <p className="text-center text-[11px] text-slate-400 pt-2">{PRODUCT_TITLE}</p>
      </main>
      {iosHint && <IosInstallHint onClose={dismissIosHint} />}
    </div>
  );
}

function IosInstallHint({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center p-0 sm:p-4">
      <button type="button" className="absolute inset-0 bg-slate-950/60" onClick={onClose} aria-label="Close" />
      <div className="portal-light relative w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl bg-white p-5 sm:p-6 shadow-2xl text-slate-900">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h3
              className="text-lg font-bold text-slate-900"
              style={{ fontFamily: "'Space Grotesk', Manrope, sans-serif" }}
            >
              Install on iPhone
            </h3>
            <p className="text-sm text-slate-500 mt-1">Add Subscriber Portal to your Home Screen.</p>
          </div>
          <button type="button" className="p-2 rounded-lg hover:bg-slate-100 text-slate-400" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <ol className="space-y-3 text-sm text-slate-700">
          <li className="flex gap-3">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-100 font-semibold text-xs shrink-0">1</span>
            <span>
              Tap the <Share size={14} className="inline -mt-0.5 text-sky-600" /> <b>Share</b> button in Safari.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-100 font-semibold text-xs shrink-0">2</span>
            <span>
              Scroll and tap <b>Add to Home Screen</b>.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-100 font-semibold text-xs shrink-0">3</span>
            <span>
              Tap <b>Add</b> — open the Portal icon anytime without the browser chrome.
            </span>
          </li>
        </ol>
        <button
          type="button"
          onClick={onClose}
          className="mt-5 w-full rounded-xl bg-slate-900 text-white font-semibold py-2.5 text-sm"
        >
          Got it
        </button>
      </div>
    </div>
  );
}
