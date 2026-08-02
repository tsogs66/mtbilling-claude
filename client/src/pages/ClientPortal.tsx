import { useEffect, useMemo, useState } from 'react';
import {
  Wallet, FileText, LifeBuoy, LogOut, ExternalLink,
  Phone, Building2, ChevronRight, Download, Share, X, Mail, MapPin, Gauge, Zap,
  Eye, Printer, Loader2,
} from 'lucide-react';
import { peso } from '../api';
import { getApiBase } from '../config';
import Logo from '../components/Logo';
import { PRODUCT_TITLE } from '../branding';
import { usePortalInstall } from '../lib/portalInstall';
import { subscribePortalLive } from '../lib/portalLive';
import { openInvoicePrint } from '../lib/invoicePrint';

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
  const [password, setPassword] = useState('');
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
  const [plans, setPlans] = useState<{ id: number; name: string; rateLimit: string; price: number }[]>([]);
  const [planBusy, setPlanBusy] = useState(false);
  const [planMsg, setPlanMsg] = useState('');
  const [invoiceBusy, setInvoiceBusy] = useState<number | null>(null);
  const [viewInvoice, setViewInvoice] = useState<any | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState('');
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotAccount, setForgotAccount] = useState('');
  const [forgotPhone, setForgotPhone] = useState('');
  const [forgotBusy, setForgotBusy] = useState(false);
  const [forgotMsg, setForgotMsg] = useState('');
  const [forgotOk, setForgotOk] = useState(false);
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
    portalFetch('/public/portal/plans')
      .then((d) => setPlans(d.plans || []))
      .catch(() => setPlans([]));
  }, [token]);

  // Realtime: when staff accepts/rejects a plan change, refresh without reload.
  useEffect(() => {
    if (!token) return;
    const stop = subscribePortalLive({
      path: '/public/portal/events',
      headers: { 'X-Portal-Token': token },
      onEvent: (event, data) => {
        if (event === 'plan_change' || data?.type === 'plan_change') {
          void loadMe().catch(() => undefined);
          if (data?.action === 'accepted') {
            setPlanMsg(
              data?.payload?.toPlan
                ? `Plan change approved — you are now on ${data.payload.toPlan}.`
                : 'Plan change approved.'
            );
          } else if (data?.action === 'rejected') {
            setPlanMsg('Plan change was declined by your ISP. You can request again.');
          }
        }
      },
    });
    return stop;
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
        body: JSON.stringify({ account, password }),
      });
      localStorage.setItem(TOKEN_KEY, data.token);
      setToken(data.token);
      setPassword('');
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setBusy(false);
    }
  };

  const submitForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setForgotMsg('');
    setForgotOk(false);
    setForgotBusy(true);
    try {
      const data = await portalFetch('/public/portal/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ account: forgotAccount, contact: forgotPhone }),
      });
      setForgotOk(true);
      setForgotMsg(data.message || 'Temporary password sent to your mobile number.');
      setAccount(forgotAccount.trim());
      setPassword('');
    } catch (err: any) {
      setForgotMsg(err.message || 'Could not reset password');
    } finally {
      setForgotBusy(false);
    }
  };

  const submitNewPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwMsg('');
    if (newPassword.trim() !== confirmPassword.trim()) {
      setPwMsg('Passwords do not match');
      return;
    }
    if (newPassword.trim().length < 6) {
      setPwMsg('Password must be at least 6 characters');
      return;
    }
    setPwBusy(true);
    const chosen = newPassword.trim();
    try {
      const result = await portalFetch('/public/portal/change-password', {
        method: 'POST',
        body: JSON.stringify({ password: chosen, confirm: confirmPassword.trim() }),
      });
      if (result?.mustChangePassword) {
        setPwMsg('Password was not saved. Please try again.');
        return;
      }
      setNewPassword('');
      setConfirmPassword('');
      // Remember what they chose so login autofill can use it after sign-out.
      setPassword(chosen);
      setPwMsg('Password updated. Welcome to your portal.');
      // Optimistically clear the gate even if /me is briefly stale.
      setMe((prev: any) => (prev ? { ...prev, mustChangePassword: false } : prev));
      try {
        await loadMe();
      } catch {
        /* keep optimistic state — password already saved */
      }
    } catch (err: any) {
      setPwMsg(err.message || 'Could not update password');
    } finally {
      setPwBusy(false);
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
    // Reuse pending/submitted links; otherwise create a subscriber-initiated payment-link entry.
    if (existing?.path && (existing.status === 'pending' || existing.status === 'submitted')) {
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

  const fetchInvoiceDetail = async (id: number) => {
    return portalFetch(`/public/portal/invoices/${id}`);
  };

  const printInvoice = async (id: number) => {
    setInvoiceBusy(id);
    try {
      const data = await fetchInvoiceDetail(id);
      openInvoicePrint({
        company: data.company,
        invoice: data.invoice,
        history: data.history || [],
      });
    } catch (err: any) {
      alert(err.message || 'Could not load invoice');
    } finally {
      setInvoiceBusy(null);
    }
  };

  const viewInvoiceDetail = async (id: number) => {
    setInvoiceBusy(id);
    try {
      const data = await fetchInvoiceDetail(id);
      setViewInvoice(data);
    } catch (err: any) {
      alert(err.message || 'Could not load invoice');
    } finally {
      setInvoiceBusy(null);
    }
  };

  const requestPlanChange = async (planName: string) => {
    setPlanMsg('');
    if (!confirm(`Request change to ${planName}? Your ISP must accept before the plan updates.`)) return;
    setPlanBusy(true);
    try {
      await portalFetch('/public/portal/plan-change', {
        method: 'POST',
        body: JSON.stringify({ plan: planName }),
      });
      setPlanMsg(`Plan change to ${planName} submitted — waiting for ISP approval.`);
      await loadMe();
    } catch (err: any) {
      setPlanMsg(err.message || 'Could not submit plan change');
    } finally {
      setPlanBusy(false);
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
  const helpText =
    pageSettings.helpText ||
    'Sign in with your account number and password. First time: use your phone number, then set a new password.';

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

        {forgotOpen ? (
          <form
            onSubmit={submitForgotPassword}
            className="relative w-full max-w-md rounded-3xl border border-white/15 bg-white/[0.08] backdrop-blur-xl shadow-2xl p-5 sm:p-8 space-y-4 sm:space-y-5"
          >
            <div className="text-center space-y-2">
              <Logo size="md" variant="dark" />
              <h1
                className="text-2xl font-bold text-white tracking-tight"
                style={{ fontFamily: "'Space Grotesk', Manrope, sans-serif" }}
              >
                Reset password
              </h1>
              <p className="text-sm text-slate-300 leading-relaxed">
                Enter your account number and the mobile number on your account. We will SMS a temporary password.
              </p>
            </div>
            {forgotMsg && (
              <div
                className={`text-sm rounded-xl px-3 py-2 border ${
                  forgotOk
                    ? 'text-emerald-200 bg-emerald-500/15 border-emerald-400/20'
                    : 'text-rose-200 bg-rose-500/15 border-rose-400/20'
                }`}
              >
                {forgotMsg}
              </div>
            )}
            <label className="block text-sm font-medium text-slate-300">
              Account number
              <input
                className="mt-1.5 w-full rounded-xl border border-white/10 bg-slate-950/50 text-white px-3 py-2.5 outline-none focus:border-orange-400/60 focus:ring-2 focus:ring-orange-400/20"
                value={forgotAccount}
                onChange={(e) => setForgotAccount(e.target.value)}
                required
                autoComplete="username"
                placeholder="e.g. ACC-00123"
              />
            </label>
            <label className="block text-sm font-medium text-slate-300">
              Mobile number
              <input
                className="mt-1.5 w-full rounded-xl border border-white/10 bg-slate-950/50 text-white px-3 py-2.5 outline-none focus:border-orange-400/60 focus:ring-2 focus:ring-orange-400/20"
                value={forgotPhone}
                onChange={(e) => setForgotPhone(e.target.value)}
                required
                inputMode="tel"
                autoComplete="tel"
                placeholder="Same number on your account"
              />
            </label>
            <button
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-orange-500 hover:bg-orange-400 text-slate-950 font-semibold py-3 transition disabled:opacity-60"
              disabled={forgotBusy}
            >
              {forgotBusy ? 'Sending…' : 'Send temporary password'}
            </button>
            <button
              type="button"
              onClick={() => {
                setForgotOpen(false);
                setForgotMsg('');
                setForgotOk(false);
              }}
              className="w-full text-sm text-slate-400 hover:text-white py-1"
            >
              Back to sign in
            </button>
          </form>
        ) : (
          <form
            onSubmit={login}
            className="relative w-full max-w-md rounded-3xl border border-white/15 bg-white/[0.08] backdrop-blur-xl shadow-2xl p-5 sm:p-8 space-y-4 sm:space-y-5"
          >
            <div className="flex flex-col items-center gap-3 sm:gap-4 mb-1">
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
                <p className="text-sm text-slate-300 mt-1">{subtitle}</p>
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
                name="portal-account"
                value={account}
                onChange={(e) => setAccount(e.target.value)}
                required
                autoComplete="username"
                placeholder="e.g. ACC-00123"
              />
            </label>
            <div>
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <label className="text-sm font-medium text-slate-300" htmlFor="portal-password">
                  Password
                </label>
                <button
                  type="button"
                  onClick={() => {
                    setForgotAccount(account);
                    setForgotPhone('');
                    setForgotMsg('');
                    setForgotOk(false);
                    setForgotOpen(true);
                  }}
                  className="text-xs font-medium text-orange-300 hover:text-orange-200 shrink-0 py-1"
                >
                  Forgot password?
                </button>
              </div>
              <input
                id="portal-password"
                className="w-full rounded-xl border border-white/10 bg-slate-950/50 text-white px-3 py-2.5 outline-none focus:border-orange-400/60 focus:ring-2 focus:ring-orange-400/20"
                name="portal-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                placeholder="Your portal password"
              />
            </div>
            <p className="text-xs text-slate-300 -mt-1 leading-relaxed">
              First time? Use your phone number, then you will set a new password.
            </p>
            <button
              className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-orange-500 hover:bg-orange-400 text-slate-950 font-semibold py-3.5 min-h-[48px] transition shadow-[0_12px_40px_-12px_rgba(249,115,22,0.7)] disabled:opacity-60"
              disabled={busy}
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            {showInstallButton && (
              <button
                type="button"
                onClick={() => void install()}
                className="w-full inline-flex items-center justify-center gap-2 rounded-xl border border-white/20 bg-white/10 hover:bg-white/15 text-white font-semibold py-3.5 min-h-[48px] transition"
              >
                <Download size={18} /> Install PANORTH
              </button>
            )}
            {installed && (
              <p className="text-xs text-emerald-300 text-center">PANORTH installed on this device</p>
            )}
            <p className="text-xs text-slate-300 text-center leading-relaxed">{helpText}</p>
            {iosHint && <IosInstallHint onClose={dismissIosHint} />}
          </form>
        )}
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
  // Always allow sending payment details — creates a Payment Links entry if none exists (reverse of admin create).
  const canPay = showBalance;
  const pendingPlan = me.planChangeRequest || null;

  const payCtaLabel = (() => {
    if (paymentLink?.status === 'submitted') return 'View status';
    if (paymentLink?.status === 'rejected') return 'Resubmit payment';
    if (paymentLink?.status === 'pending') return 'Pay now';
    if (balance > 0) return 'Pay now';
    return 'Send payment details';
  })();

  const previewProration = (newPrice: number) => {
    const CYCLE = 30;
    const due = c.due ? String(c.due).slice(0, 10) : null;
    const asOf = new Date().toISOString().slice(0, 10);
    let remaining = CYCLE;
    if (due) {
      const rem = Math.round(
        (Date.parse(`${due}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 864e5
      );
      remaining = Math.max(0, Math.min(CYCLE, rem));
    }
    const consumed = CYCLE - remaining;
    const oldP = Number(c.price) || 0;
    const oldPortion = Math.round((oldP / CYCLE) * consumed);
    const newPortion = Math.round((newPrice / CYCLE) * remaining);
    return { consumed, remaining, oldPortion, newPortion, total: oldPortion + newPortion };
  };

  if (me.mustChangePassword) {
    return (
      <div
        className="subscriber-portal subscriber-portal--login relative min-h-full flex items-center justify-center p-6 overflow-hidden"
        style={{ fontFamily: "Manrope, 'Space Grotesk', system-ui, sans-serif" }}
      >
        <div className="absolute inset-0 bg-slate-950" />
        <div
          className="absolute inset-0 opacity-90"
          style={{
            backgroundImage:
              'radial-gradient(ellipse 80% 60% at 15% 10%, rgba(249,115,22,0.28), transparent 55%), radial-gradient(ellipse 70% 50% at 90% 20%, rgba(14,165,233,0.18), transparent 50%)',
          }}
        />
        <form
          onSubmit={submitNewPassword}
          className="relative w-full max-w-md rounded-3xl border border-white/10 bg-white/[0.06] backdrop-blur-xl shadow-2xl p-8 space-y-5"
        >
          <div className="text-center space-y-2">
            <Logo size="md" variant="dark" />
            <h1
              className="text-2xl font-bold text-white tracking-tight"
              style={{ fontFamily: "'Space Grotesk', Manrope, sans-serif" }}
            >
              Set your password
            </h1>
            <p className="text-sm text-slate-400 leading-relaxed">
              You signed in with a temporary or default password. Choose a new password to continue.
            </p>
            {c?.accountNumber && (
              <p className="text-xs text-slate-500 font-mono">Account {c.accountNumber}</p>
            )}
          </div>
          {pwMsg && (
            <div
              className={`text-sm rounded-xl px-3 py-2 border ${
                pwMsg.includes('updated')
                  ? 'text-emerald-200 bg-emerald-500/15 border-emerald-400/20'
                  : 'text-rose-200 bg-rose-500/15 border-rose-400/20'
              }`}
            >
              {pwMsg}
            </div>
          )}
          <label className="block text-sm font-medium text-slate-300">
            New password
            <input
              className="mt-1.5 w-full rounded-xl border border-white/10 bg-slate-950/50 text-white px-3 py-2.5 outline-none focus:border-orange-400/60 focus:ring-2 focus:ring-orange-400/20"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              minLength={6}
              maxLength={64}
              autoComplete="new-password"
              placeholder="At least 6 characters"
            />
          </label>
          <label className="block text-sm font-medium text-slate-300">
            Confirm password
            <input
              className="mt-1.5 w-full rounded-xl border border-white/10 bg-slate-950/50 text-white px-3 py-2.5 outline-none focus:border-orange-400/60 focus:ring-2 focus:ring-orange-400/20"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              minLength={6}
              maxLength={64}
              autoComplete="new-password"
            />
          </label>
          <button
            className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-orange-500 hover:bg-orange-400 text-slate-950 font-semibold py-3 transition disabled:opacity-60"
            disabled={pwBusy}
          >
            {pwBusy ? 'Saving…' : 'Save password & continue'}
          </button>
          <button
            type="button"
            onClick={() => void logout()}
            className="w-full text-sm text-slate-400 hover:text-white py-1"
          >
            Sign out
          </button>
        </form>
      </div>
    );
  }

  return (
    <div
      className="subscriber-portal min-h-full bg-slate-100 text-slate-900 flex flex-col"
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
        <header className="relative max-w-3xl mx-auto px-4 pt-4 sm:pt-5 pb-8">
          <div className="flex items-start justify-between gap-2 sm:gap-3">
            <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
              <Logo size="sm" variant="dark" />
              <div className="min-w-0">
                <div
                  className="text-[11px] uppercase tracking-[0.18em] sm:tracking-[0.22em] text-orange-300 font-semibold"
                >
                  {title}
                </div>
                <h1
                  className="text-lg sm:text-2xl font-bold tracking-tight truncate text-white"
                  style={{ fontFamily: "'Space Grotesk', Manrope, sans-serif" }}
                >
                  {c.name}
                </h1>
                <div className="flex flex-wrap items-center gap-2 mt-1.5 text-xs text-slate-300">
                  <span className="font-mono">{c.accountNumber || '—'}</span>
                  <span className={`inline-flex px-2 py-0.5 rounded-full ring-1 capitalize ${statusTone(c.status)}`}>
                    {c.status || '—'}
                  </span>
                </div>
              </div>
            </div>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-1.5 shrink-0">
              {showInstallButton && (
                <button
                  type="button"
                  onClick={() => void install()}
                  className="inline-flex items-center justify-center gap-1.5 text-sm text-orange-200 hover:text-white shrink-0 rounded-lg px-2.5 py-2 min-h-[40px] bg-orange-500/20 hover:bg-orange-500/30 ring-1 ring-orange-400/40 transition"
                  title="Install PANORTH on this device"
                  >
                  <Download size={16} />
                  <span className="hidden xs:inline sm:inline">Install</span>
                </button>
              )}
              <button
                onClick={logout}
                className="inline-flex items-center justify-center gap-1.5 text-sm text-slate-200 hover:text-white shrink-0 rounded-lg px-2.5 py-2 min-h-[40px] bg-white/10 hover:bg-white/15 ring-1 ring-white/15 transition"
              >
                <LogOut size={16} />
                <span>Sign out</span>
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
                <span className="block font-semibold text-white text-sm">Install PANORTH</span>
                <span className="block text-xs text-slate-300 mt-0.5">
                  Add PANORTH to your home screen for faster access — works offline for the login page.
                </span>
              </span>
              <ChevronRight size={18} className="text-orange-200 shrink-0" />
            </button>
          )}

          {s.welcomeText && (
            <p className="relative mt-5 text-sm text-slate-300 leading-relaxed border-l-2 border-orange-400/60 pl-3">
              {s.welcomeText}
            </p>
          )}

          <div className="relative mt-5 sm:mt-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {showBalance && (
              <div className="rounded-2xl bg-white/10 border border-white/15 p-4 backdrop-blur-sm flex flex-col">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <div className="flex items-center gap-2 text-slate-300 text-[11px] uppercase tracking-wider font-semibold">
                    <Wallet size={13} /> Balance due
                  </div>
                  {paymentLink?.status && (
                    <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-white/15 text-white capitalize">
                      {paymentLink.status === 'submitted' ? 'Awaiting review' : paymentLink.status}
                    </span>
                  )}
                </div>
                <div
                  className={`text-3xl font-bold tabular-nums ${balance > 0 ? 'text-rose-300' : 'text-emerald-300'}`}
                  style={{ fontFamily: "'Space Grotesk', Manrope, sans-serif" }}
                >
                  {peso(paymentLink?.amount || balance)}
                </div>
                {paymentLink?.expiresAt && paymentLink.status === 'pending' && (
                  <div className="text-xs text-slate-300 mt-1">
                    Link expires {String(paymentLink.expiresAt).replace('T', ' ').slice(0, 16)}
                  </div>
                )}
                {canPay && (
                  <button
                    type="button"
                    onClick={openPayment}
                    disabled={payBusy}
                    className="mt-3 inline-flex items-center justify-center gap-2 rounded-xl bg-orange-500 hover:bg-orange-400 text-slate-950 font-semibold px-4 py-3 min-h-[48px] text-sm shadow-lg shadow-orange-500/25 disabled:opacity-60 transition w-full"
                  >
                    {payBusy ? 'Opening…' : payCtaLabel}
                    <ExternalLink size={15} />
                  </button>
                )}
                {canPay && !paymentLink && (
                  <p className="mt-2 text-xs text-slate-300 leading-relaxed">
                    Already paid? Send your GCash/Maya details here — your ISP will see it under Payment Links.
                  </p>
                )}
                {payMsg && <p className="mt-2 text-sm text-rose-300 font-medium">{payMsg}</p>}
              </div>
            )}
            <div className={`rounded-2xl bg-white/10 border border-white/15 p-4 backdrop-blur-sm ${showBalance ? '' : 'sm:col-span-2'}`}>
              <div className="text-[11px] text-slate-300 uppercase tracking-wider mb-1 font-semibold">Current plan</div>
              <div className="font-semibold text-white text-base truncate">{c.plan || '—'}</div>
              <div className="text-sm text-slate-300 mt-0.5">
                {peso(c.price)} · due {c.due || '—'}
              </div>
            </div>
          </div>
        </header>
      </div>

      <main className="portal-light relative max-w-3xl mx-auto px-3 sm:px-4 -mt-4 pb-12 space-y-3 sm:space-y-4 flex-1 w-full">
        {plans.length > 0 && (
          <section className="rounded-2xl border border-slate-200/80 bg-white/70 backdrop-blur-md p-5 shadow-sm">
            <div className="flex items-start justify-between gap-3 mb-1">
              <div>
                <h2 className="font-semibold text-slate-900 flex items-center gap-2" style={{ fontFamily: "'Space Grotesk', Manrope, sans-serif" }}>
                  <Zap size={16} className="text-orange-500" /> Change plan
                </h2>
                <p className="text-sm text-slate-600 mt-1 leading-relaxed">
                  Request a new plan — your ISP must accept it. Mid-cycle changes are prorated (30-day month).
                </p>
              </div>
            </div>

            {pendingPlan && (
              <div className="mt-3 mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-900">
                Pending: <b>{pendingPlan.fromPlan || '—'}</b> → <b>{pendingPlan.toPlan}</b>
                {' '}· estimated due {peso(pendingPlan.proratedBalance)}
                <span className="block text-xs text-amber-800/80 mt-0.5">
                  {pendingPlan.consumedDays}d @ {peso(pendingPlan.fromPrice)} + {pendingPlan.remainingDays}d @ {peso(pendingPlan.toPrice)}
                </span>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
              {plans.map((p) => {
                const current = p.name === c.plan;
                const preview = !current ? previewProration(Number(p.price) || 0) : null;
                return (
                  <button
                    key={p.id}
                    type="button"
                    disabled={planBusy || current || !!pendingPlan}
                    onClick={() => void requestPlanChange(p.name)}
                    className="portal-plan-glass group text-left rounded-2xl p-4 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-bold text-slate-900 tracking-tight truncate group-hover:text-orange-700 transition-colors">
                          {p.name}
                        </div>
                        {p.rateLimit && (
                          <div className="mt-1 inline-flex items-center gap-1 text-xs text-slate-500">
                            <Gauge size={12} /> {p.rateLimit}
                          </div>
                        )}
                      </div>
                      <div
                        className="text-lg font-bold text-slate-900 tabular-nums shrink-0"
                        style={{ fontFamily: "'Space Grotesk', Manrope, sans-serif" }}
                      >
                        {peso(p.price)}
                      </div>
                    </div>
                    <div className="mt-3 text-[11px] text-slate-500">
                      {current && <span className="text-emerald-600 font-semibold">Current plan</span>}
                      {!current && preview && (
                        <span>
                          Est. balance if accepted today: <b className="text-slate-800">{peso(preview.total)}</b>
                          <span className="block opacity-80">
                            {preview.consumed}d × {peso(c.price)}/30 + {preview.remaining}d × {peso(p.price)}/30
                          </span>
                        </span>
                      )}
                      {!!pendingPlan && !current && <span>Wait for pending request</span>}
                    </div>
                  </button>
                );
              })}
            </div>
            {planMsg && <p className="text-sm text-slate-600 mt-3">{planMsg}</p>}
          </section>
        )}

        {showInvoices && (
          <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 shadow-sm">
            <h2 className="font-semibold text-slate-900 flex items-center gap-2 mb-3 text-base">
              <FileText size={16} className="text-slate-600" /> Statement of account
            </h2>
            {/* Mobile: stacked cards (table is hard to read on phones) */}
            <div className="sm:hidden space-y-2.5">
              {(me.invoices || [])
                .filter((inv: any) => String(inv.status || '') !== 'void')
                .map((inv: any) => (
                  <div
                    key={inv.id}
                    className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-mono text-sm font-semibold text-slate-900 truncate">
                          {inv.number}
                        </div>
                        <div className="text-xs text-slate-600 mt-0.5">
                          Due {inv.due_date || '—'} ·{' '}
                          <span className="capitalize font-medium text-slate-700">{inv.status}</span>
                        </div>
                      </div>
                      <div className="text-base font-bold tabular-nums text-slate-900 shrink-0">
                        {peso(inv.amount - inv.amount_paid)}
                      </div>
                    </div>
                    <div className="mt-2.5 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        className="inline-flex items-center justify-center gap-1.5 text-sm font-semibold text-slate-800 bg-white border border-slate-200 rounded-lg py-2.5 min-h-[44px] hover:border-orange-300 hover:text-orange-700 transition disabled:opacity-50"
                        disabled={invoiceBusy === inv.id}
                        onClick={() => void viewInvoiceDetail(inv.id)}
                      >
                        {invoiceBusy === inv.id ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />}
                        View
                      </button>
                      <button
                        type="button"
                        className="inline-flex items-center justify-center gap-1.5 text-sm font-semibold text-slate-800 bg-white border border-slate-200 rounded-lg py-2.5 min-h-[44px] hover:border-orange-300 hover:text-orange-700 transition disabled:opacity-50"
                        disabled={invoiceBusy === inv.id}
                        onClick={() => void printInvoice(inv.id)}
                      >
                        <Printer size={14} />
                        Print
                      </button>
                    </div>
                  </div>
                ))}
              {!me.invoices?.filter((inv: any) => String(inv.status || '') !== 'void').length && (
                <p className="py-8 text-center text-slate-600 text-sm">No invoices yet.</p>
              )}
            </div>
            <div className="hidden sm:block overflow-x-auto -mx-1">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-slate-600 border-b border-slate-200">
                    <th className="py-2 px-1 font-semibold">Invoice</th>
                    <th className="py-2 px-1 font-semibold">Due</th>
                    <th className="py-2 px-1 font-semibold text-right">Balance</th>
                    <th className="py-2 px-1 font-semibold">Status</th>
                    <th className="py-2 px-1 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {(me.invoices || [])
                    .filter((inv: any) => String(inv.status || '') !== 'void')
                    .map((inv: any) => (
                    <tr key={inv.id} className="border-b border-slate-100 last:border-0">
                      <td className="py-2.5 px-1 font-mono text-xs text-slate-800">{inv.number}</td>
                      <td className="py-2.5 px-1 text-slate-700">{inv.due_date || '—'}</td>
                      <td className="py-2.5 px-1 text-right tabular-nums font-semibold text-slate-900">
                        {peso(inv.amount - inv.amount_paid)}
                      </td>
                      <td className="py-2.5 px-1">
                        <span className="capitalize text-xs font-semibold text-slate-700">{inv.status}</span>
                      </td>
                      <td className="py-2.5 px-1 text-right whitespace-nowrap">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-xs font-semibold text-slate-700 hover:text-orange-700 px-2 py-1.5 rounded-lg hover:bg-orange-50 transition disabled:opacity-50"
                          disabled={invoiceBusy === inv.id}
                          onClick={() => void viewInvoiceDetail(inv.id)}
                          title="View invoice"
                        >
                          {invoiceBusy === inv.id ? <Loader2 size={13} className="animate-spin" /> : <Eye size={13} />}
                          View
                        </button>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-xs font-semibold text-slate-700 hover:text-orange-700 px-2 py-1.5 rounded-lg hover:bg-orange-50 transition disabled:opacity-50"
                          disabled={invoiceBusy === inv.id}
                          onClick={() => void printInvoice(inv.id)}
                          title="Print invoice"
                        >
                          <Printer size={13} />
                          Print
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!me.invoices?.filter((inv: any) => String(inv.status || '') !== 'void').length && (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-slate-600">No invoices yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {showTickets && (
          <section className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 shadow-sm">
            <h2 className="font-semibold text-slate-900 flex items-center gap-2 mb-1 text-base">
              <LifeBuoy size={16} className="text-slate-600" /> Request support
            </h2>
            <p className="text-sm text-slate-600 mb-3 leading-relaxed">
              Select apps or services that are down (optional), then describe the issue. Service outages also appear on the ISP Outage Monitor.
            </p>
            {outageServices.length > 0 && (
              <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                    Affected services
                    {selectedServices.length > 0 && (
                      <span className="ml-1 normal-case font-semibold text-orange-700">
                        ({selectedServices.length} selected)
                      </span>
                    )}
                  </div>
                  {selectedServices.length > 0 && (
                    <button
                      type="button"
                      className="text-xs font-semibold text-slate-600 hover:text-slate-900 py-1"
                      onClick={() => setSelectedServices([])}
                    >
                      Clear
                    </button>
                  )}
                </div>
                <input
                  className="portal-field w-full rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-slate-900 mb-2 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-400/20"
                  placeholder="Filter services (GCash, Facebook…)"
                  value={serviceFilter}
                  onChange={(e) => setServiceFilter(e.target.value)}
                />
                <div className="max-h-52 overflow-y-auto space-y-3 pr-1">
                  {servicesByCategory.map(([cat, items]) => (
                    <div key={cat}>
                      <div className="text-[11px] font-bold uppercase tracking-wider text-slate-600 mb-1.5">{cat}</div>
                      <div className="flex flex-wrap gap-1.5">
                        {items.map((svc) => {
                          const on = selectedServices.includes(svc.slug);
                          return (
                            <button
                              key={svc.slug}
                              type="button"
                              onClick={() => toggleService(svc.slug)}
                              className={`text-xs px-2.5 py-2 min-h-[36px] rounded-lg border transition ${
                                on
                                  ? 'bg-rose-50 border-rose-300 text-rose-900 font-semibold'
                                  : 'bg-white border-slate-200 text-slate-700 hover:border-slate-400'
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
                    <p className="text-xs text-slate-600 py-2">No services match that filter.</p>
                  )}
                </div>
              </div>
            )}
            <textarea
              className="portal-field w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-slate-900 min-h-[100px] mb-2 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-400/20"
              placeholder="Describe the issue (no signal, slow, relocation…)"
              value={ticket}
              onChange={(e) => setTicket(e.target.value)}
            />
            <button
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-semibold px-4 py-3 min-h-[48px] text-sm disabled:opacity-50 transition"
              disabled={!ticket.trim() && !selectedServices.length}
              onClick={submitTicket}
            >
              Submit report <ChevronRight size={16} />
            </button>
            {ticketMsg && <p className="text-sm text-slate-700 font-medium mt-2">{ticketMsg}</p>}
            {(me.openJobs || []).length > 0 && (
              <ul className="mt-4 space-y-2 text-sm">
                {me.openJobs.map((j: any) => (
                  <li key={j.id} className="flex justify-between border-t border-slate-200 pt-2">
                    <span className="font-mono text-xs text-slate-800 font-semibold">{j.number}</span>
                    <span className="capitalize text-slate-600 font-medium">{j.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </main>

      {showCompany && (
        <footer className="portal-light mt-auto border-t border-slate-200 bg-white">
          <div className="max-w-3xl mx-auto px-4 py-6">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-600 shrink-0">
                <Building2 size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-slate-900">
                  {company.name || title}
                </div>
                <div className="mt-2 space-y-1.5 text-sm text-slate-600">
                  {company.address && (
                    <div className="flex items-start gap-2">
                      <MapPin size={14} className="mt-0.5 text-slate-400 shrink-0" />
                      <span>{company.address}</span>
                    </div>
                  )}
                  {company.phone && (
                    <div className="flex items-center gap-2">
                      <Phone size={14} className="text-slate-400 shrink-0" />
                      <a href={`tel:${company.phone}`} className="hover:text-orange-600">{company.phone}</a>
                    </div>
                  )}
                  {company.email && (
                    <div className="flex items-center gap-2">
                      <Mail size={14} className="text-slate-400 shrink-0" />
                      <a href={`mailto:${company.email}`} className="hover:text-orange-600 break-all">{company.email}</a>
                    </div>
                  )}
                  {(company.gcash_number || company.maya_number) && (
                    <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs text-slate-500">
                      {company.gcash_number && <span>GCash: <span className="font-mono text-slate-700">{company.gcash_number}</span></span>}
                      {company.maya_number && <span>Maya: <span className="font-mono text-slate-700">{company.maya_number}</span></span>}
                    </div>
                  )}
                </div>
              </div>
            </div>
            <p className="text-center text-[11px] text-slate-400 mt-5 pt-4 border-t border-slate-100">
              {PRODUCT_TITLE}
            </p>
          </div>
        </footer>
      )}

      {!showCompany && (
        <p className="portal-light text-center text-[11px] text-slate-400 py-4 mt-auto">{PRODUCT_TITLE}</p>
      )}

      {viewInvoice && (
        <PortalInvoiceModal
          data={viewInvoice}
          onClose={() => setViewInvoice(null)}
          onPrint={() => {
            openInvoicePrint({
              company: viewInvoice.company,
              invoice: viewInvoice.invoice,
              history: viewInvoice.history || [],
            });
          }}
        />
      )}

      {iosHint && <IosInstallHint onClose={dismissIosHint} />}
    </div>
  );
}

function PortalInvoiceModal({
  data,
  onClose,
  onPrint,
}: {
  data: any;
  onClose: () => void;
  onPrint: () => void;
}) {
  const inv = data.invoice || {};
  const balance = Math.max(0, Number(inv.amount || 0) - Number(inv.amount_paid || 0));
  const payments = data.payments || data.history || [];
  const company = data.company || {};

  return (
    <div className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center p-0 sm:p-4">
      <button type="button" className="absolute inset-0 bg-slate-950/60" onClick={onClose} aria-label="Close" />
      <div
        className="portal-light portal-invoice-preview relative w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[90dvh] overflow-y-auto"
        style={{ background: '#ffffff', color: '#0f172a' }}
      >
        <div
          className="sticky top-0 border-b px-5 py-4 flex items-start justify-between gap-3"
          style={{ background: '#ffffff', borderColor: '#e2e8f0' }}
        >
          <div>
            <div className="text-[11px] uppercase tracking-wider font-bold" style={{ color: '#334155' }}>
              Invoice
            </div>
            <h3
              className="text-xl font-bold font-mono"
              style={{ fontFamily: "'Space Grotesk', Manrope, sans-serif", color: '#0f172a' }}
            >
              {inv.number || '—'}
            </h3>
            <span
              className="inline-block mt-1 text-[11px] font-bold uppercase tracking-wide px-2.5 py-0.5 rounded-full capitalize"
              style={{ background: '#e2e8f0', color: '#1e293b' }}
            >
              {inv.status || 'unpaid'}
            </span>
          </div>
          <button
            type="button"
            className="p-2 rounded-lg"
            style={{ color: '#334155' }}
            onClick={onClose}
            aria-label="Close invoice"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4" style={{ color: '#0f172a' }}>
          {company.name && (
            <div className="text-sm">
              <div className="font-bold" style={{ color: '#0f172a' }}>{company.name}</div>
              {company.address && (
                <div className="text-sm mt-0.5" style={{ color: '#334155' }}>{company.address}</div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-xl border p-3" style={{ borderColor: '#cbd5e1', background: '#f8fafc' }}>
              <div className="text-[11px] uppercase tracking-wider font-bold" style={{ color: '#334155' }}>
                Bill to
              </div>
              <div className="font-bold mt-0.5" style={{ color: '#0f172a' }}>{inv.customer_name || '—'}</div>
              <div className="text-sm font-mono mt-0.5" style={{ color: '#1e293b' }}>
                #{inv.account_number || '—'}
              </div>
            </div>
            <div className="rounded-xl border p-3" style={{ borderColor: '#cbd5e1', background: '#f8fafc' }}>
              <div className="text-[11px] uppercase tracking-wider font-bold" style={{ color: '#334155' }}>
                Period
              </div>
              <div className="mt-0.5 font-medium" style={{ color: '#0f172a' }}>
                {inv.period_start || '—'} → {inv.period_end || '—'}
              </div>
              <div className="text-sm mt-0.5 font-medium" style={{ color: '#1e293b' }}>
                Due {inv.due_date || '—'}
              </div>
            </div>
          </div>

          <div className="rounded-xl border p-3" style={{ borderColor: '#94a3b8' }}>
            <div className="flex justify-between text-sm py-1.5">
              <span style={{ color: '#1e293b' }}>Service charge</span>
              <span className="font-bold tabular-nums" style={{ color: '#0f172a' }}>{peso(inv.amount)}</span>
            </div>
            <div className="flex justify-between text-sm py-1.5">
              <span style={{ color: '#1e293b' }}>Amount paid</span>
              <span className="font-bold tabular-nums" style={{ color: '#0f172a' }}>{peso(inv.amount_paid)}</span>
            </div>
            <div
              className="flex justify-between text-base font-bold pt-2.5 mt-1 border-t"
              style={{ borderColor: '#cbd5e1' }}
            >
              <span style={{ color: '#0f172a' }}>Balance due</span>
              <span
                className="tabular-nums"
                style={{ color: balance > 0 ? '#be123c' : '#047857' }}
              >
                {peso(balance)}
              </span>
            </div>
            {inv.notes && (
              <p className="text-sm mt-2" style={{ color: '#334155' }}>{inv.notes}</p>
            )}
          </div>

          {payments.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider font-bold mb-2" style={{ color: '#334155' }}>
                Payment history
              </div>
              <ul className="space-y-1.5 text-sm">
                {payments.map((p: any, i: number) => (
                  <li
                    key={p.id || i}
                    className="flex justify-between gap-3 rounded-lg border px-3 py-2.5"
                    style={{ borderColor: '#cbd5e1', background: '#ffffff' }}
                  >
                    <div>
                      <div className="capitalize font-semibold" style={{ color: '#0f172a' }}>
                        {p.method || 'Payment'}
                      </div>
                      <div className="text-xs font-medium mt-0.5" style={{ color: '#334155' }}>
                        {String(p.paid_at || p.created_at || '').replace('T', ' ').slice(0, 16)}
                      </div>
                    </div>
                    <div className="font-bold tabular-nums" style={{ color: '#0f172a' }}>{peso(p.amount)}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div
          className="sticky bottom-0 border-t px-5 py-3 flex gap-2"
          style={{ background: '#ffffff', borderColor: '#e2e8f0' }}
        >
          <button
            type="button"
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl border font-bold py-2.5 text-sm"
            style={{ borderColor: '#94a3b8', background: '#ffffff', color: '#0f172a' }}
            onClick={onClose}
          >
            Close
          </button>
          <button
            type="button"
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-xl font-bold py-2.5 text-sm"
            style={{ background: '#0f172a', color: '#ffffff' }}
            onClick={onPrint}
          >
            <Printer size={16} /> Print
          </button>
        </div>
      </div>
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
              Install PANORTH
            </h3>
            <p className="text-sm text-slate-600 mt-1">Add PANORTH to your Home Screen.</p>
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
