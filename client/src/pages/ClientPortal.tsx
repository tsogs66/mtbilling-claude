import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Wallet, FileText, LifeBuoy, LogOut, ExternalLink,
  Phone, Building2, ChevronRight, Download, Share, X, Mail, MapPin, Gauge, Zap,
  Eye, EyeOff, Printer, Loader2, History, Bell,
} from 'lucide-react';
import { peso } from '../api';
import { getApiBase } from '../config';
import Logo from '../components/Logo';
import { MatrixRain } from '../components/portal/MatrixRain';
import { OrbitalNetwork } from '../components/themes/OrbitalNetwork';
import { DEFAULT_LOGO, PRODUCT_TITLE } from '../branding';
import { useCompany } from '../context/CompanyContext';
import { usePortalInstall, type PortalThemeId } from '../lib/portalInstall';
import { subscribePortalLive } from '../lib/portalLive';
import { openInvoicePrint } from '../lib/invoicePrint';
import { formatRateLimit } from '../lib/rateLimit';
import {
  PortalExtrasStack,
  PortalPlanCancelButton,
  PortalTicketThread,
  PortalConnectionStrip,
  PortalActivityBody,
  PortalPaymentHistoryBody,
  PortalAddonsPanel,
  PortalRequestTabs,
} from '../components/portal/PortalExtraPanels';

const TOKEN_KEY = 'mt_portal_token';

function PortalBackdrop({ theme }: { theme: PortalThemeId }) {
  if (theme === 'orbital') {
    return (
      <>
        <OrbitalNetwork />
        <div className="portal-orbital-veil" aria-hidden="true" />
      </>
    );
  }
  return (
    <>
      <MatrixRain />
      <div className="portal-matrix-veil" aria-hidden="true" />
    </>
  );
}

/**
 * Two aligned rows:
 *  1) label+name (left) · logo+brand (right) — logo height = left top block
 *  2) account+status (left) · Sign out (right) — shared bottom edge
 */
function PortalAccountBrandRow({
  name,
  accountNumber,
  status,
  logoSrc,
  logoAlt,
  brandTitle,
  brandSubtitle,
  onSignOut,
}: {
  name: string;
  accountNumber?: string | null;
  status?: string | null;
  logoSrc: string;
  logoAlt: string;
  brandTitle: string;
  brandSubtitle: string;
  onSignOut: () => void;
}) {
  const topLeftRef = useRef<HTMLDivElement | null>(null);
  const [logoPx, setLogoPx] = useState(0);

  useLayoutEffect(() => {
    const el = topLeftRef.current;
    if (!el) return;
    const apply = () => {
      const h = Math.round(el.getBoundingClientRect().height);
      if (h > 0) setLogoPx(h);
    };
    apply();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [name]);

  return (
    <div className="flex flex-col gap-2 text-left">
      <div className="flex items-start justify-between gap-3 sm:gap-4">
        <div ref={topLeftRef} className="min-w-0 flex-1">
          <div className="text-[11px] uppercase tracking-[0.14em] text-orange-300 font-semibold leading-none">
            Subscriber portal
          </div>
          <h1 className="m-0 mt-1.5 text-lg sm:text-2xl font-bold tracking-tight text-white break-words leading-tight">
            {name}
          </h1>
        </div>
        <div className="portal-brand-glow shrink-0 flex items-center gap-2 sm:gap-2.5 max-w-[52%] sm:max-w-[50%]">
          <div
            className="rounded-2xl bg-white/95 flex items-center justify-center overflow-hidden shadow-glow ring-1 ring-black/5 shrink-0"
            style={
              logoPx > 0
                ? { width: logoPx, height: logoPx }
                : { width: '3.75rem', height: '3.75rem', visibility: 'hidden' as const }
            }
            title={brandTitle}
          >
            <img
              src={logoSrc}
              alt={logoAlt}
              className="h-full w-full object-contain object-center p-1 rounded-[inherit]"
            />
          </div>
          <div className="min-w-0 text-left">
            <div className="text-base sm:text-xl font-bold text-white tracking-tight leading-tight">
              {brandTitle}
            </div>
            <div className="text-[11px] sm:text-xs text-orange-300/90 font-semibold tracking-wide leading-snug">
              {brandSubtitle}
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex flex-wrap items-center gap-2 text-xs text-portal-muted leading-none">
          <span className="font-mono tracking-normal">{accountNumber || '—'}</span>
          <span className={`portal-chip capitalize ${statusTone(status)}`}>
            {status || '—'}
          </span>
        </div>
        <button
          type="button"
          onClick={onSignOut}
          className="portal-btn-ghost inline-flex items-center gap-1.5 text-xs sm:text-sm rounded-lg px-2.5 py-1.5 text-portal-dim hover:text-white shrink-0"
        >
          <LogOut size={14} />
          <span>Sign out</span>
        </button>
      </div>
    </div>
  );
}

type PortalSettings = {
  title?: string;
  subtitle?: string;
  helpText?: string;
  welcomeText?: string;
  showBalance?: boolean;
  showInvoices?: boolean;
  showTickets?: boolean;
  showCompany?: boolean;
  theme?: PortalThemeId;
};

type BillingTabId = 'statement' | 'payments' | 'activity';

const BILLING_TABS: { id: BillingTabId; label: string; icon: typeof FileText }[] = [
  { id: 'statement', label: 'Statement', icon: FileText },
  { id: 'payments', label: 'Payments', icon: History },
  { id: 'activity', label: 'Activity', icon: Bell },
];

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

function statusTone(status?: string | null) {
  const s = String(status || '').toLowerCase();
  if (s === 'active' || s === 'paid') return 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-400/35';
  if (s === 'overdue' || s === 'suspended') return 'bg-rose-500/20 text-rose-300 ring-1 ring-rose-400/35';
  if (s === 'partial' || s === 'pending' || s === 'submitted') return 'bg-amber-500/20 text-amber-200 ring-1 ring-amber-400/35';
  return 'bg-white/10 text-slate-300 ring-1 ring-white/20';
}

export default function ClientPortal() {
  const { company: brandCompany } = useCompany();
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
  const [payOnlineBusy, setPayOnlineBusy] = useState(false);
  const [paymongoEnabled, setPaymongoEnabled] = useState(false);
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
  const [showLoginPassword, setShowLoginPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [ticketThreadId, setTicketThreadId] = useState<number | null>(null);
  const [extrasRefresh, setExtrasRefresh] = useState(0);
  const [billingTab, setBillingTab] = useState<BillingTabId>('statement');
  const portalTheme: PortalThemeId =
    (me?.settings?.theme || pageSettings.theme) === 'orbital' ? 'orbital' : 'matrix';
  const { installed, showInstallButton, iosHint, dismissIosHint, install } = usePortalInstall(portalTheme);

  const loadMe = async () => {
    if (!localStorage.getItem(TOKEN_KEY)) return;
    const data = await portalFetch('/public/portal/me');
    setMe(data);
    if (data.settings) setPageSettings((prev: PortalSettings) => ({ ...prev, ...data.settings }));
  };

  useEffect(() => {
    portalFetch('/public/portal/settings')
      .then((s) => setPageSettings((prev) => ({ ...prev, ...(s || {}) })))
      .catch(() => undefined);
    fetch(`${getApiBase()}/public/paymongo/status`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        setPaymongoEnabled(!!j.enabled);
      })
      .catch(() => setPaymongoEnabled(false));
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
        if (
          event === 'portal_activity' ||
          event === 'outage_notice' ||
          event === 'payment' ||
          event === 'ticket' ||
          data?.type === 'portal_activity'
        ) {
          setExtrasRefresh((n) => n + 1);
          void loadMe().catch(() => undefined);
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
      setPwMsg(
        result?.keptExisting
          ? 'Current password kept. Welcome to your portal.'
          : 'Password updated. Welcome to your portal.'
      );
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

  const keepCurrentPassword = async () => {
    setPwMsg('');
    setPwBusy(true);
    try {
      const result = await portalFetch('/public/portal/change-password', {
        method: 'POST',
        body: JSON.stringify({ keepCurrent: true }),
      });
      if (result?.mustChangePassword) {
        setPwMsg('Could not keep the current password. Please try again.');
        return;
      }
      setNewPassword('');
      setConfirmPassword('');
      setPwMsg('Current password kept. Welcome to your portal.');
      setMe((prev: any) => (prev ? { ...prev, mustChangePassword: false } : prev));
      try {
        await loadMe();
      } catch {
        /* keep optimistic state */
      }
    } catch (err: any) {
      setPwMsg(err.message || 'Could not keep the current password');
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

  const ensurePaymentLink = async (): Promise<PaymentLink | null> => {
    const existing: PaymentLink | null = me?.paymentLink || null;
    if (existing?.path && (existing.status === 'pending' || existing.status === 'submitted' || existing.status === 'rejected')) {
      return existing;
    }
    const data = await portalFetch('/public/portal/payment-link', {
      method: 'POST',
      body: '{}',
    });
    const link: PaymentLink | null = data.paymentLink || null;
    setMe((prev: any) => (prev ? { ...prev, paymentLink: link } : prev));
    return link;
  };

  const payTokenFromLink = (link: PaymentLink | null) => {
    if (!link?.path) return '';
    const m = String(link.path).match(/\/pay\/([^/?#]+)/i);
    return m?.[1] || '';
  };

  const openPayment = async () => {
    setPayMsg('');
    setPayBusy(true);
    try {
      const link = await ensurePaymentLink();
      if (link?.path) window.location.href = link.path;
      else setPayMsg('Payment page is not available yet. Contact your ISP.');
    } catch (err: any) {
      setPayMsg(err.message || 'Could not open payment page');
    } finally {
      setPayBusy(false);
    }
  };

  /** Jump straight to PayMongo hosted checkout (QR Ph / GCash / Maya web). */
  const openPayOnline = async () => {
    setPayMsg('');
    setPayOnlineBusy(true);
    try {
      const link = await ensurePaymentLink();
      const payToken = payTokenFromLink(link);
      if (!payToken) throw new Error('Payment page is not available yet. Contact your ISP.');
      const origin = window.location.origin.replace(/\/$/, '');
      const r = await fetch(`${getApiBase()}/public/pay/${encodeURIComponent(payToken)}/paymongo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          successUrl: `${origin}/pay/${payToken}?paid=1`,
          cancelUrl: `${origin}/pay/${payToken}?canceled=1`,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Could not start PayMongo checkout');
      if (!j.checkoutUrl) throw new Error('No checkout URL returned');
      window.location.href = j.checkoutUrl;
    } catch (err: any) {
      setPayMsg(err.message || 'Could not open PayMongo');
      setPayOnlineBusy(false);
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

  const brandTitle = 'PANORTH';
  const brandSubtitle = 'Internet Solutions';
  const title = pageSettings.title?.trim() || brandTitle;
  const helpText =
    pageSettings.helpText ||
    'Sign in with your account number and password. First time: use your registered mobile number. You can keep it or set a new password.';

  if (!token || !me) {
    return (
      <div className="subscriber-portal subscriber-portal--login min-h-full flex flex-col items-center justify-center p-4 relative overflow-x-hidden">
        <PortalBackdrop theme={portalTheme} />

        <div className="relative z-[1] w-full max-w-md flex flex-col items-center gap-6">
          {!forgotOpen && (
            <div className="text-center space-y-2 portal-brand-glow px-2 flex flex-col items-center">
              <Logo size="lg" variant="dark" showText={false} />
              <h1 className="text-3xl font-bold text-white tracking-tight">{brandTitle}</h1>
              <p className="text-sm text-orange-300/90 font-semibold tracking-wide">
                {brandSubtitle}
              </p>
            </div>
          )}

          {forgotOpen ? (
            <form
              onSubmit={submitForgotPassword}
              className="portal-glass portal-glass-strong w-full rounded-3xl p-5 sm:p-8 space-y-4 sm:space-y-5"
            >
              <div className="text-center space-y-2">
                <Logo size="md" variant="dark" />
                <h1 className="text-2xl font-bold text-white tracking-tight">Reset password</h1>
                <p className="text-sm text-portal-muted leading-relaxed">
                  Enter your account number and the mobile number on your account. We will SMS a temporary password.
                </p>
              </div>
              {forgotMsg && (
                <div
                  className={`text-sm rounded-xl px-3 py-2 border ${
                    forgotOk
                      ? 'text-emerald-200 bg-emerald-500/15 border-emerald-400/25'
                      : 'text-rose-200 bg-rose-500/15 border-rose-400/25'
                  }`}
                >
                  {forgotMsg}
                </div>
              )}
              <label className="block text-sm font-medium text-portal-muted">
                Account number
                <input
                  className="portal-field mt-1.5 w-full px-3 py-2.5"
                  value={forgotAccount}
                  onChange={(e) => setForgotAccount(e.target.value)}
                  required
                  autoComplete="username"
                  placeholder="e.g. ACC-00123"
                />
              </label>
              <label className="block text-sm font-medium text-portal-muted">
                Mobile number
                <input
                  className="portal-field mt-1.5 w-full px-3 py-2.5"
                  value={forgotPhone}
                  onChange={(e) => setForgotPhone(e.target.value)}
                  required
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="Same number on your account"
                />
              </label>
              <button
                className="portal-cta w-full inline-flex items-center justify-center gap-2 rounded-xl py-3 min-h-[48px]"
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
                className="w-full text-sm text-portal-dim hover:text-white py-1 transition"
              >
                Back to sign in
              </button>
            </form>
          ) : (
            <form
              onSubmit={login}
              className="portal-glass portal-glass-strong w-full rounded-3xl p-5 sm:p-8 space-y-4 sm:space-y-5"
            >
              <div className="text-center space-y-1 mb-1">
                <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight">Sign in</h2>
                <p className="text-sm text-portal-muted">Access your {brandTitle} account</p>
              </div>
              {error && (
                <div className="text-sm text-rose-200 bg-rose-500/15 border border-rose-400/25 rounded-xl px-3 py-2">
                  {error}
                </div>
              )}
              <label className="block text-sm font-medium text-portal-muted">
                Account number
                <input
                  className="portal-field mt-1.5 w-full px-3 py-2.5"
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
                  <label className="text-sm font-medium text-portal-muted" htmlFor="portal-password">
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
                    className="text-xs font-semibold text-orange-300 hover:text-orange-200 shrink-0 py-1"
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative">
                  <input
                    id="portal-password"
                    className="portal-field w-full px-3 py-2.5 pr-11"
                    name="portal-password"
                    type={showLoginPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="current-password"
                    placeholder="Mobile number or your password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowLoginPassword((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-portal-dim hover:text-white"
                    aria-label={showLoginPassword ? 'Hide password' : 'Show password'}
                  >
                    {showLoginPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
              <p className="text-xs text-portal-dim -mt-1 leading-relaxed">
                First time? Use your registered mobile number (09… or +63…). You can keep it as your password.
              </p>
              <button
                className="portal-cta w-full inline-flex items-center justify-center gap-2 rounded-xl py-3.5 min-h-[48px]"
                disabled={busy}
              >
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
              {showInstallButton && (
                <button
                  type="button"
                  onClick={() => void install()}
                  className="portal-btn-ghost w-full inline-flex items-center justify-center gap-2 rounded-xl font-semibold py-3.5 min-h-[48px]"
                >
                  <Download size={18} /> Install PANORTH
                </button>
              )}
              {installed && (
                <p className="text-xs text-emerald-300 text-center">PANORTH installed on this device</p>
              )}
              <p className="text-xs text-portal-dim text-center leading-relaxed">{helpText}</p>
            </form>
          )}
        </div>
        {iosHint && <IosInstallHint onClose={dismissIosHint} />}
      </div>
    );
  }

  const c = me.customer;
  const s: PortalSettings = me.settings || pageSettings;
  const showBalance = s.showBalance !== false;
  const showInvoices = s.showInvoices !== false;
  const showTickets = s.showTickets !== false;
  const showCompany = s.showCompany !== false;
  const billingTabs = BILLING_TABS.filter((t) => t.id !== 'statement' || showInvoices);
  // The ISP can turn the statement off in portal settings, which would strand
  // the default tab on an empty panel.
  const activeBillingTab = billingTabs.some((t) => t.id === billingTab)
    ? billingTab
    : billingTabs[0].id;
  const paymentLink: PaymentLink | null = me.paymentLink || null;
  const balance = Number(me.balance) || 0;
  const company = me.company || {};
  const portalLogo = company.logo || brandCompany?.logo || DEFAULT_LOGO;
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
      <div className="subscriber-portal subscriber-portal--login relative min-h-full flex items-center justify-center p-6 overflow-hidden">
        <PortalBackdrop theme={portalTheme} />
        <form
          onSubmit={submitNewPassword}
          className="portal-glass portal-glass-strong relative z-[1] w-full max-w-md rounded-3xl p-8 space-y-5"
        >
          <div className="text-center space-y-2">
            <div className="portal-brand-glow inline-flex">
              <Logo size="md" variant="dark" />
            </div>
            <h1 className="text-2xl font-bold text-white tracking-tight">Set your password</h1>
            <p className="text-sm text-portal-muted leading-relaxed">
              You signed in with a temporary or default password. Choose a new one, or keep your current
              password — including your phone number.
            </p>
            {c?.accountNumber && (
              <p className="text-xs text-portal-dim font-mono">Account {c.accountNumber}</p>
            )}
          </div>
          {pwMsg && (
            <div
              className={`text-sm rounded-xl px-3 py-2 border ${
                pwMsg.includes('updated') || pwMsg.includes('kept') || pwMsg.includes('Welcome')
                  ? 'text-emerald-200 bg-emerald-500/15 border-emerald-400/25'
                  : 'text-rose-200 bg-rose-500/15 border-rose-400/25'
              }`}
            >
              {pwMsg}
            </div>
          )}
          <label className="block text-sm font-medium text-portal-muted">
            New password
            <div className="relative mt-1.5">
              <input
                className="portal-field w-full px-3 py-2.5 pr-11"
                type={showNewPassword ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                minLength={6}
                maxLength={64}
                autoComplete="new-password"
                placeholder="At least 6 characters, or your phone number"
              />
              <button
                type="button"
                onClick={() => setShowNewPassword((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-portal-dim hover:text-white"
                aria-label={showNewPassword ? 'Hide password' : 'Show password'}
              >
                {showNewPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </label>
          <label className="block text-sm font-medium text-portal-muted">
            Confirm password
            <input
              className="portal-field mt-1.5 w-full px-3 py-2.5"
              type={showNewPassword ? 'text' : 'password'}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              minLength={6}
              maxLength={64}
              autoComplete="new-password"
            />
          </label>
          <button
            className="portal-cta w-full inline-flex items-center justify-center gap-2 rounded-xl py-3 min-h-[48px]"
            disabled={pwBusy}
          >
            {pwBusy ? 'Saving…' : 'Save password & continue'}
          </button>
          <button
            type="button"
            onClick={() => void keepCurrentPassword()}
            disabled={pwBusy}
            className="portal-btn-ghost w-full inline-flex items-center justify-center gap-2 rounded-xl font-semibold py-3 min-h-[48px]"
          >
            Keep my current password
          </button>
          <button
            type="button"
            onClick={() => void logout()}
            className="w-full text-sm text-portal-dim hover:text-white py-1 transition"
          >
            Sign out
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="subscriber-portal min-h-full flex flex-col">
      <PortalBackdrop theme={portalTheme} />

      <div className="subscriber-portal-hero relative z-[1]">
        <header className="max-w-3xl mx-auto px-4 pt-4 sm:pt-5 pb-6">
          <div className="portal-glass portal-glass-strong rounded-2xl p-4 sm:p-5">
            <PortalAccountBrandRow
              name={c.name}
              accountNumber={c.accountNumber}
              status={c.status}
              logoSrc={portalLogo}
              logoAlt={company.name || brandCompany?.name || brandTitle}
              brandTitle={brandTitle}
              brandSubtitle={brandSubtitle}
              onSignOut={logout}
            />

            {showInstallButton && (
              <div className="mt-4">
                <button
                  type="button"
                  onClick={() => void install()}
                  className="w-full flex items-center gap-3 rounded-2xl border border-orange-400/35 bg-orange-500/15 hover:bg-orange-500/25 px-4 py-3 text-left transition"
                >
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-500 text-slate-950 shrink-0">
                    <Download size={18} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold text-white text-sm">Install PANORTH to Home Screen</span>
                    <span className="block text-xs text-portal-muted mt-0.5">
                      Faster access — works offline for the login page.
                    </span>
                  </span>
                  <ChevronRight size={18} className="text-orange-200 shrink-0" />
                </button>
              </div>
            )}

            {/* Line vitals sit here rather than in their own section further
                down: "am I online?" is the question the portal gets opened for. */}
            <PortalConnectionStrip refreshKey={extrasRefresh} />

            {s.welcomeText && (
              <p className="mt-4 text-sm text-portal-muted leading-relaxed border-l-2 border-orange-400/70 pl-3">
                {s.welcomeText}
              </p>
            )}
          </div>

          {showBalance && (
            <div className="mt-3 sm:mt-4 portal-glass rounded-2xl p-4 flex flex-col text-left">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-portal-muted text-[11px] uppercase tracking-[0.14em] font-semibold leading-none">
                  <Wallet size={13} className="text-orange-300 shrink-0" /> Balance due
                </div>
                {paymentLink?.status && (
                  <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full bg-white/10 text-white capitalize ring-1 ring-white/15">
                    {paymentLink.status === 'submitted' ? 'Awaiting review' : paymentLink.status}
                  </span>
                )}
              </div>
              <div
                className={`mt-1.5 text-3xl font-bold tabular-nums leading-none ${balance > 0 ? 'text-rose-300' : 'text-emerald-300'}`}
              >
                {peso(paymentLink?.amount || balance)}
              </div>
              <div className="mt-1 text-sm text-portal-muted leading-snug">
                due {c.due || '—'}
              </div>
              {canPay && (
                <div className="mt-2 space-y-2">
                  {paymongoEnabled && paymentLink?.status !== 'paid' && (
                    <button
                      type="button"
                      onClick={() => void openPayOnline()}
                      disabled={payOnlineBusy || payBusy}
                      className="w-full portal-cta inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 min-h-[44px] text-sm font-semibold"
                    >
                      {payOnlineBusy ? (
                        <>
                          <Loader2 size={16} className="animate-spin" /> Opening PayMongo…
                        </>
                      ) : (
                        <>
                          Pay Online
                          <ExternalLink size={15} />
                        </>
                      )}
                    </button>
                  )}
                  <div className="flex flex-nowrap items-center justify-between gap-3">
                    <div className="text-xs text-portal-dim min-w-0 flex-1 leading-snug truncate">
                      {paymentLink?.expiresAt && paymentLink.status === 'pending'
                        ? `Link expires ${String(paymentLink.expiresAt).replace('T', ' ').slice(0, 16)}`
                        : paymongoEnabled
                          ? 'Or open the full payment page'
                          : '\u00a0'}
                    </div>
                    <button
                      type="button"
                      onClick={() => void openPayment()}
                      disabled={payBusy || payOnlineBusy}
                      className={`${
                        paymongoEnabled
                          ? 'inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/20 bg-white/10 hover:bg-white/15 text-white px-3 py-2 min-h-[40px] text-sm shrink-0 whitespace-nowrap transition'
                          : 'portal-cta inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 min-h-[40px] text-sm shrink-0 whitespace-nowrap'
                      }`}
                    >
                      {payBusy ? 'Opening…' : paymongoEnabled ? 'Payment page' : payCtaLabel}
                      <ExternalLink size={15} />
                    </button>
                  </div>
                </div>
              )}
              {canPay && !paymentLink && !paymongoEnabled && (
                <p className="mt-2 text-xs text-portal-dim leading-relaxed">
                  Already paid? Send your GCash/Maya details here — your ISP will see it under Payment Links.
                </p>
              )}
              {payMsg && <p className="mt-2 text-sm text-rose-300 font-medium">{payMsg}</p>}
            </div>
          )}

          {/* Directly under Balance due: both requests are what a subscriber
              reaches for at that exact moment. Collapsed until tapped. */}
          <PortalRequestTabs status={c.status} refreshKey={extrasRefresh} />
        </header>
      </div>

      <main className="relative z-[1] max-w-3xl mx-auto px-3 sm:px-4 pb-12 space-y-3 sm:space-y-4 flex-1 w-full">
        {plans.length > 0 && (
          <section className="portal-glass portal-section">
            <div className="flex items-start justify-between gap-3 mb-1">
              <div>
                <h2 className="font-semibold text-white flex items-center gap-2">
                  <Zap size={16} className="text-orange-400" /> Change plan
                </h2>
                <p className="text-sm text-portal-muted mt-1 leading-relaxed">
                  Request a new plan — your ISP must accept it. Mid-cycle changes are prorated (30-day month).
                </p>
              </div>
            </div>

            {pendingPlan && (
              <div className="mt-3 mb-4 rounded-xl border border-amber-400/30 bg-amber-500/15 px-3 py-2.5 text-sm text-amber-100">
                Pending: <b>{pendingPlan.fromPlan || '—'}</b> → <b>{pendingPlan.toPlan}</b>
                {' '}· estimated due {peso(pendingPlan.proratedBalance)}
                <span className="block text-xs text-amber-200/80 mt-0.5">
                  {pendingPlan.consumedDays}d @ {peso(pendingPlan.fromPrice)} + {pendingPlan.remainingDays}d @ {peso(pendingPlan.toPrice)}
                </span>
                <PortalPlanCancelButton
                  pending={pendingPlan}
                  onCancelled={() => {
                    setPlanMsg('Plan change request cancelled.');
                    void loadMe();
                  }}
                />
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
                        <div className="font-bold text-white tracking-tight truncate group-hover:text-orange-300 transition-colors">
                          {p.name}
                        </div>
                        {p.rateLimit && (
                          <div
                            className="mt-1 inline-flex items-start gap-1 text-xs text-portal-dim"
                            title={p.rateLimit}
                          >
                            <Gauge size={12} className="shrink-0 mt-0.5" />
                            {/* Formatted, not raw: a MikroTik rate-limit carries
                                the whole burst spec, and printing it verbatim
                                made the sustained rate look like the plan speed. */}
                            <span className="leading-snug">{formatRateLimit(p.rateLimit)}</span>
                          </div>
                        )}
                      </div>
                      <div className="text-lg font-bold text-white tabular-nums shrink-0">
                        {peso(p.price)}
                      </div>
                    </div>
                    <div className="mt-3 text-[11px] text-portal-dim">
                      {current && <span className="text-emerald-300 font-semibold">Current plan</span>}
                      {!current && preview && (
                        <span>
                          Est. balance if accepted today: <b className="text-slate-100">{peso(preview.total)}</b>
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
            {planMsg && <p className="text-sm text-portal-muted mt-3">{planMsg}</p>}
          </section>
        )}

        {/* Requested position: directly under Change plan. */}
        <PortalAddonsPanel />

        {/* Statement / Payments / Activity share one container — three separate
            full-height sections made the page a long scroll of lists that a
            subscriber rarely needs at the same time. */}
        <section className="portal-glass portal-section">
          <div
            role="tablist"
            aria-label="Billing"
            className="flex items-center gap-1 p-1 rounded-xl bg-black/25 border border-white/10 mb-4 overflow-x-auto"
          >
            {billingTabs.map((t) => {
              const Icon = t.icon;
              const active = activeBillingTab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`billing-tab-${t.id}`}
                  aria-selected={active}
                  aria-controls={`billing-panel-${t.id}`}
                  onClick={() => setBillingTab(t.id)}
                  className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-2 min-h-[42px] text-sm font-semibold whitespace-nowrap transition ${
                    active
                      ? 'bg-orange-500/25 text-orange-100 ring-1 ring-orange-400/40'
                      : 'text-portal-muted hover:text-white'
                  }`}
                >
                  <Icon size={15} className="shrink-0" />
                  <span className="truncate">{t.label}</span>
                </button>
              );
            })}
          </div>

          <div
            role="tabpanel"
            id={`billing-panel-${activeBillingTab}`}
            aria-labelledby={`billing-tab-${activeBillingTab}`}
          >
            {activeBillingTab === 'activity' && <PortalActivityBody refreshKey={extrasRefresh} />}
            {activeBillingTab === 'payments' && <PortalPaymentHistoryBody />}
            {activeBillingTab === 'statement' && showInvoices && (
          <>
            <div className="sm:hidden space-y-2.5">
              {(me.invoices || [])
                .filter((inv: any) => String(inv.status || '') !== 'void')
                .map((inv: any) => (
                  <div
                    key={inv.id}
                    className="rounded-xl border border-white/12 bg-white/[0.04] px-3.5 py-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-mono text-sm font-semibold text-white truncate">
                          {inv.number}
                        </div>
                        <div className="text-xs text-portal-dim mt-0.5">
                          Due {inv.due_date || '—'} ·{' '}
                          <span className="capitalize font-medium text-portal-muted">{inv.status}</span>
                        </div>
                      </div>
                      <div className="text-base font-bold tabular-nums text-white shrink-0">
                        {peso(inv.amount - inv.amount_paid)}
                      </div>
                    </div>
                    <div className="mt-2.5 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        className="portal-btn-ghost inline-flex items-center justify-center gap-1.5 text-sm font-semibold rounded-lg py-2.5 min-h-[44px] disabled:opacity-50"
                        disabled={invoiceBusy === inv.id}
                        onClick={() => void viewInvoiceDetail(inv.id)}
                      >
                        {invoiceBusy === inv.id ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />}
                        View
                      </button>
                      <button
                        type="button"
                        className="portal-btn-ghost inline-flex items-center justify-center gap-1.5 text-sm font-semibold rounded-lg py-2.5 min-h-[44px] disabled:opacity-50"
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
                <p className="py-8 text-center text-portal-dim text-sm">No invoices yet.</p>
              )}
            </div>
            <div className="hidden sm:block overflow-x-auto -mx-1">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wider text-portal-dim border-b border-white/10">
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
                    <tr key={inv.id} className="border-b border-white/[0.06] last:border-0">
                      <td className="py-2.5 px-1 font-mono text-xs text-slate-200">{inv.number}</td>
                      <td className="py-2.5 px-1 text-portal-muted">{inv.due_date || '—'}</td>
                      <td className="py-2.5 px-1 text-right tabular-nums font-semibold text-white">
                        {peso(inv.amount - inv.amount_paid)}
                      </td>
                      <td className="py-2.5 px-1">
                        <span className="capitalize text-xs font-semibold text-portal-muted">{inv.status}</span>
                      </td>
                      <td className="py-2.5 px-1 text-right whitespace-nowrap">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-xs font-semibold text-portal-muted hover:text-orange-300 px-2 py-1.5 rounded-lg hover:bg-orange-500/10 transition disabled:opacity-50"
                          disabled={invoiceBusy === inv.id}
                          onClick={() => void viewInvoiceDetail(inv.id)}
                          title="View invoice"
                        >
                          {invoiceBusy === inv.id ? <Loader2 size={13} className="animate-spin" /> : <Eye size={13} />}
                          View
                        </button>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-xs font-semibold text-portal-muted hover:text-orange-300 px-2 py-1.5 rounded-lg hover:bg-orange-500/10 transition disabled:opacity-50"
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
                      <td colSpan={5} className="py-8 text-center text-portal-dim">No invoices yet.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
            )}
          </div>
        </section>

        {showTickets && (
          <section className="portal-glass portal-section">
            <h2 className="font-semibold text-white flex items-center gap-2 mb-1 text-base">
              <LifeBuoy size={16} className="text-orange-400" /> Request support
            </h2>
            <p className="text-sm text-portal-muted mb-3 leading-relaxed">
              Select apps or services that are down (optional), then describe the issue. Service outages also appear on the ISP Outage Monitor.
            </p>
            {outageServices.length > 0 && (
              <div className="mb-3 rounded-xl border border-white/12 bg-black/25 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-portal-dim">
                    Affected services
                    {selectedServices.length > 0 && (
                      <span className="ml-1 normal-case font-semibold text-orange-300">
                        ({selectedServices.length} selected)
                      </span>
                    )}
                  </div>
                  {selectedServices.length > 0 && (
                    <button
                      type="button"
                      className="text-xs font-semibold text-portal-dim hover:text-white py-1"
                      onClick={() => setSelectedServices([])}
                    >
                      Clear
                    </button>
                  )}
                </div>
                <input
                  className="portal-field w-full px-3 py-2.5 mb-2"
                  placeholder="Filter services (GCash, Facebook…)"
                  value={serviceFilter}
                  onChange={(e) => setServiceFilter(e.target.value)}
                />
                <div className="max-h-52 overflow-y-auto space-y-3 pr-1">
                  {servicesByCategory.map(([cat, items]) => (
                    <div key={cat}>
                      <div className="text-[11px] font-bold uppercase tracking-wider text-portal-dim mb-1.5">{cat}</div>
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
                                  ? 'bg-rose-500/25 border-rose-400/45 text-rose-100 font-semibold'
                                  : 'bg-white/[0.04] border-white/12 text-portal-muted hover:border-orange-400/40 hover:text-white'
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
                    <p className="text-xs text-portal-dim py-2">No services match that filter.</p>
                  )}
                </div>
              </div>
            )}
            <textarea
              className="portal-field w-full px-3 py-2.5 mb-2"
              placeholder="Describe the issue (no signal, slow, relocation…)"
              value={ticket}
              onChange={(e) => setTicket(e.target.value)}
            />
            <button
              className="portal-cta w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 min-h-[48px] text-sm disabled:opacity-50"
              disabled={!ticket.trim() && !selectedServices.length}
              onClick={submitTicket}
            >
              Submit report <ChevronRight size={16} />
            </button>
            {ticketMsg && <p className="text-sm text-portal-muted font-medium mt-2">{ticketMsg}</p>}
            {(me.openJobs || []).length > 0 && (
              <ul className="mt-4 space-y-2 text-sm">
                {me.openJobs.map((j: any) => (
                  <li key={j.id}>
                    <button
                      type="button"
                      onClick={() => setTicketThreadId(Number(j.id))}
                      className="w-full flex justify-between items-center border-t border-white/10 pt-2 text-left hover:text-orange-200"
                    >
                      <span className="font-mono text-xs text-slate-200 font-semibold">{j.number}</span>
                      <span className="capitalize text-portal-dim font-medium inline-flex items-center gap-1">
                        {j.status} <ChevronRight size={14} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <PortalExtrasStack
          me={me}
          refreshKey={extrasRefresh}
          onReloadMe={() => void loadMe()}
        />
      </main>

      {ticketThreadId != null && (
        <PortalTicketThread jobId={ticketThreadId} onClose={() => setTicketThreadId(null)} />
      )}

      {showCompany && (
        <footer className="relative z-[1] mt-auto">
          <div className="max-w-3xl mx-auto px-3 sm:px-4 pb-6">
            <div className="portal-glass portal-section">
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-orange-500/20 text-orange-300 ring-1 ring-orange-400/30 shrink-0">
                  <Building2 size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-white">
                    {company.name || title}
                  </div>
                  <div className="mt-2 space-y-1.5 text-sm text-portal-muted">
                    {company.address && (
                      <div className="flex items-start gap-2">
                        <MapPin size={14} className="mt-0.5 text-orange-300/80 shrink-0" />
                        <span>{company.address}</span>
                      </div>
                    )}
                    {company.phone && (
                      <div className="flex items-center gap-2">
                        <Phone size={14} className="text-orange-300/80 shrink-0" />
                        <a href={`tel:${company.phone}`} className="hover:text-orange-300">{company.phone}</a>
                      </div>
                    )}
                    {company.email && (
                      <div className="flex items-center gap-2">
                        <Mail size={14} className="text-orange-300/80 shrink-0" />
                        <a href={`mailto:${company.email}`} className="hover:text-orange-300 break-all">{company.email}</a>
                      </div>
                    )}
                    {(company.gcash_number || company.maya_number) && (
                      <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs text-portal-dim">
                        {company.gcash_number && <span>GCash: <span className="font-mono text-slate-200">{company.gcash_number}</span></span>}
                        {company.maya_number && <span>Maya: <span className="font-mono text-slate-200">{company.maya_number}</span></span>}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <p className="text-center text-[11px] text-portal-dim mt-5 pt-4 border-t border-white/10">
                {PRODUCT_TITLE}
              </p>
            </div>
          </div>
        </footer>
      )}

      {!showCompany && (
        <p className="relative z-[1] text-center text-[11px] text-portal-dim py-4 mt-auto">{PRODUCT_TITLE}</p>
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

  // Portal to body: `.subscriber-portal > *` CSS forces `position:relative`, which
  // overrides Tailwind `fixed` and makes the View invoice overlay a no-op on-screen.
  return createPortal(
    <div className="portal-modal-root fixed inset-0 z-[90] flex items-end sm:items-center justify-center p-0 sm:p-4">
      <button type="button" className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} aria-label="Close" />
      <div className="portal-modal-panel portal-invoice-preview relative w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl max-h-[90dvh] overflow-y-auto">
        <div className="sticky top-0 border-b border-white/10 px-5 py-4 flex items-start justify-between gap-3 bg-[rgba(4,14,12,0.92)] backdrop-blur-xl">
          <div>
            <div className="text-[11px] uppercase tracking-wider font-bold text-orange-300/90">
              Invoice
            </div>
            <h3 className="text-xl font-bold font-mono text-white">
              {inv.number || '—'}
            </h3>
            <span className="inline-block mt-1 text-[11px] font-bold uppercase tracking-wide px-2.5 py-0.5 rounded-full capitalize bg-white/10 text-slate-100 ring-1 ring-white/15">
              {inv.status || 'unpaid'}
            </span>
          </div>
          <button
            type="button"
            className="p-2 rounded-lg text-portal-dim hover:text-white hover:bg-white/10 transition"
            onClick={onClose}
            aria-label="Close invoice"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 text-slate-100">
          {company.name && (
            <div className="text-sm">
              <div className="font-bold text-white">{company.name}</div>
              {company.address && (
                <div className="text-sm mt-0.5 text-portal-muted">{company.address}</div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-xl border border-white/12 bg-white/[0.04] p-3">
              <div className="text-[11px] uppercase tracking-wider font-bold text-portal-dim">
                Bill to
              </div>
              <div className="font-bold mt-0.5 text-white">{inv.customer_name || '—'}</div>
              <div className="text-sm font-mono mt-0.5 text-portal-muted">
                #{inv.account_number || '—'}
              </div>
            </div>
            <div className="rounded-xl border border-white/12 bg-white/[0.04] p-3">
              <div className="text-[11px] uppercase tracking-wider font-bold text-portal-dim">
                Period
              </div>
              <div className="mt-0.5 font-medium text-white">
                {inv.period_start || '—'} → {inv.period_end || '—'}
              </div>
              <div className="text-sm mt-0.5 font-medium text-portal-muted">
                Due {inv.due_date || '—'}
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-orange-400/25 bg-orange-500/5 p-3">
            <div className="flex justify-between text-sm py-1.5">
              <span className="text-portal-muted">Service charge</span>
              <span className="font-bold tabular-nums text-white">{peso(inv.amount)}</span>
            </div>
            <div className="flex justify-between text-sm py-1.5">
              <span className="text-portal-muted">Amount paid</span>
              <span className="font-bold tabular-nums text-white">{peso(inv.amount_paid)}</span>
            </div>
            <div className="flex justify-between text-base font-bold pt-2.5 mt-1 border-t border-white/10">
              <span className="text-white">Balance due</span>
              <span className={`tabular-nums ${balance > 0 ? 'text-rose-300' : 'text-emerald-300'}`}>
                {peso(balance)}
              </span>
            </div>
            {inv.notes && (
              <p className="text-sm mt-2 text-portal-muted">{inv.notes}</p>
            )}
          </div>

          {payments.length > 0 && (
            <div>
              <div className="text-[11px] uppercase tracking-wider font-bold mb-2 text-portal-dim">
                Payment history
              </div>
              <ul className="space-y-1.5 text-sm">
                {payments.map((p: any, i: number) => (
                  <li
                    key={p.id || i}
                    className="flex justify-between gap-3 rounded-lg border border-white/12 bg-white/[0.03] px-3 py-2.5"
                  >
                    <div>
                      <div className="capitalize font-semibold text-white">
                        {p.method || 'Payment'}
                      </div>
                      <div className="text-xs font-medium mt-0.5 text-portal-dim">
                        {String(p.paid_at || p.created_at || '').replace('T', ' ').slice(0, 16)}
                      </div>
                    </div>
                    <div className="font-bold tabular-nums text-white">{peso(p.amount)}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="sticky bottom-0 border-t border-white/10 px-5 py-3 flex gap-2 bg-[rgba(4,14,12,0.95)] backdrop-blur-xl">
          <button
            type="button"
            className="portal-btn-ghost flex-1 inline-flex items-center justify-center gap-2 rounded-xl font-bold py-2.5 text-sm"
            onClick={onClose}
          >
            Close
          </button>
          <button
            type="button"
            className="portal-cta flex-1 inline-flex items-center justify-center gap-2 rounded-xl font-bold py-2.5 text-sm"
            onClick={onPrint}
          >
            <Printer size={16} /> Print
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function IosInstallHint({ onClose }: { onClose: () => void }) {
  return createPortal(
    <div className="portal-modal-root fixed inset-0 z-[90] flex items-end sm:items-center justify-center p-0 sm:p-4">
      <button type="button" className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} aria-label="Close" />
      <div className="portal-modal-panel relative w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-5 sm:p-6">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h3 className="text-lg font-bold text-white">
              Install PANORTH
            </h3>
            <p className="text-sm text-portal-muted mt-1">Add PANORTH to your Home Screen.</p>
          </div>
          <button type="button" className="p-2 rounded-lg hover:bg-white/10 text-portal-dim hover:text-white" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <ol className="space-y-3 text-sm text-portal-muted">
          <li className="flex gap-3">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-500/20 text-orange-300 ring-1 ring-orange-400/30 font-semibold text-xs shrink-0">1</span>
            <span>
              Tap the <Share size={14} className="inline -mt-0.5 text-orange-300" /> <b className="text-white">Share</b> button in Safari.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-500/20 text-orange-300 ring-1 ring-orange-400/30 font-semibold text-xs shrink-0">2</span>
            <span>
              Scroll and tap <b className="text-white">Add to Home Screen</b>.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-500/20 text-orange-300 ring-1 ring-orange-400/30 font-semibold text-xs shrink-0">3</span>
            <span>
              Tap <b className="text-white">Add</b> — open the Portal icon anytime without the browser chrome.
            </span>
          </li>
        </ol>
        <button
          type="button"
          onClick={onClose}
          className="portal-cta mt-5 w-full rounded-xl font-semibold py-2.5 text-sm"
        >
          Got it
        </button>
      </div>
    </div>,
    document.body
  );
}
