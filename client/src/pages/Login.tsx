import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useCompany } from '../context/CompanyContext';
import {
  Loader2, Lock, User, ArrowRight, Shield, Copy, CheckCircle2, KeyRound, ArrowLeft,
  Network, Users, BarChart3, TerminalSquare, Wifi, Map, Bot, X, Menu, Sparkles,
  LayoutDashboard, Share2, PieChart, ShieldAlert, FileText, TrendingUp, Link2, Bell,
  ClipboardList, Boxes, Cable, ScanSearch, FileCode2, ServerCog, Globe2, Globe, Cloud,
  Activity, Satellite, RadioTower, ScrollText, Building2, Settings, ShieldCheck, DownloadCloud,
} from 'lucide-react';
import { FormField } from '../components/ui';
import Logo from '../components/Logo';
import { BRAND_SHORT, PRODUCT_NAME, PRODUCT_TITLE } from '../branding';
import { copyText } from '../lib/clipboard';
import { publicApi } from '../api';
import { isNativeApp, setStoredServerUrl, getStoredServerUrl } from '../config';

/** Real-panel snapshots (generated from the live Snapshot UI look). */
const SNAPSHOTS = [
  {
    id: 'dashboard',
    title: 'Dashboard & account health',
    blurb:
      'Live Online / Offline / Active / Expired counts, projected MRR, host panel vitals (CPU, RAM, SD), and router reachability — your morning ops board.',
    icon: LayoutDashboard,
    image: '/landing/landing-dashboard.png',
    accent: 'from-orange-400/30 to-cyan-400/10',
  },
  {
    id: 'pppoe',
    title: 'PPPoE management',
    blurb:
      'Create and edit secrets, sync MikroTik profiles, process payments, disable for non-payment, and resend pay links by email or SMS for near-expiry accounts.',
    icon: Users,
    image: '/landing/landing-pppoe-real.png',
    accent: 'from-cyan-400/25 to-sky-500/10',
  },
  {
    id: 'billing',
    title: 'Billing & payment links',
    blurb:
      'Sales reports, invoices & AR, finance/MRR, and public payment links with proof upload — subscribers pay on Cloudflare while staff collect on LAN.',
    icon: BarChart3,
    image: '/landing/landing-billing-real.png',
    accent: 'from-amber-400/25 to-orange-500/10',
  },
  {
    id: 'network',
    title: 'Network, topology & NOC',
    blurb:
      'Router inventory, live topology map, NOC probes, Twingate / ZeroTier / Cloudflare tunnels, and interface traffic graphs in one place.',
    icon: Network,
    image: '/landing/landing-network-real.png',
    accent: 'from-teal-400/25 to-cyan-500/10',
  },
];

/** Brief catalog of every major panel feature (matches sidebar purpose groups). */
const ALL_FEATURES: { icon: typeof Users; title: string; text: string; group: string }[] = [
  { group: 'Overview', icon: LayoutDashboard, title: 'Dashboard', text: 'Subscriber status tiles, MRR/AR snapshot, host health, and live interface traffic.' },
  { group: 'Subscribers & Access', icon: Users, title: 'PPPoE Management', text: 'Secrets, plans, expiry protocols, bulk actions, and payment processing.' },
  { group: 'Subscribers & Access', icon: Share2, title: 'IPoE Management', text: 'DHCP leases and IPoE plans alongside PPPoE for hybrid access networks.' },
  { group: 'Subscribers & Access', icon: Wifi, title: 'Hotspot', text: 'Vouchers, user profiles, and guest Wi‑Fi without a separate portal stack.' },
  { group: 'Subscribers & Access', icon: PieChart, title: 'Usage Stats', text: 'Per-subscriber download/upload trends to spot heavy users early.' },
  { group: 'Subscribers & Access', icon: ShieldAlert, title: 'Fair Use Alerts', text: 'Threshold alerts when a plan’s fair-use cap is approached or exceeded.' },
  { group: 'Billing & Payments', icon: BarChart3, title: 'Sales Report', text: 'Daily/period collections with charts for cashiers and owners.' },
  { group: 'Billing & Payments', icon: FileText, title: 'Invoices & AR', text: 'Accounts receivable and printable invoices tied to subscribers.' },
  { group: 'Billing & Payments', icon: TrendingUp, title: 'Finance & MRR', text: 'Projected monthly recurring revenue, income, and expense tracking.' },
  { group: 'Billing & Payments', icon: Link2, title: 'Payment Links', text: '15-day public pay links, proof review, and resend to near-expiry clients.' },
  { group: 'Billing & Payments', icon: Bell, title: 'Notifications', text: 'Email/SMS templates for expiry, payment, and operational alerts.' },
  { group: 'Field Operations', icon: ClipboardList, title: 'Job Orders', text: 'Install/repair tickets for field techs with status tracking.' },
  { group: 'Field Operations', icon: Boxes, title: 'Stock & Inventory', text: 'Fiber, ONU, and materials on hand for jobs and installs.' },
  { group: 'Field Operations', icon: Cable, title: 'Tech Tools', text: 'Splitter loss and field calculators for outdoor teams.' },
  { group: 'Field Operations', icon: ScanSearch, title: 'Rogue MACs', text: 'Find unexpected MAC addresses on the access network.' },
  { group: 'Network & Infrastructure', icon: Network, title: 'Network', text: 'MikroTik routers, credentials, and sync status.' },
  { group: 'Network & Infrastructure', icon: Map, title: 'Topology', text: 'Map of clients, NAPs, and links for planning and fault find.' },
  { group: 'Network & Infrastructure', icon: TerminalSquare, title: 'Network Terminal', text: 'In-browser terminal to routers for quick diagnostics.' },
  { group: 'Network & Infrastructure', icon: Bot, title: 'AI Scripting', text: 'Generate and review RouterOS scripts with AI assistance.' },
  { group: 'Network & Infrastructure', icon: FileCode2, title: 'Mikrotik Files', text: 'Browse and manage files on connected routers.' },
  { group: 'Network & Infrastructure', icon: ServerCog, title: 'Super Router', text: 'Advanced multi-WAN / edge router helpers.' },
  { group: 'Remote Access', icon: Globe2, title: 'Twingate', text: 'Zero-trust remote access for staff without exposing the LAN.' },
  { group: 'Remote Access', icon: Globe, title: 'ZeroTier', text: 'Overlay network for routers and technicians.' },
  { group: 'Remote Access', icon: Cloud, title: 'Cloudflare Tunnel', text: 'Public pay links (and staff login when nginx is full-panel) without opening ports.' },
  { group: 'Monitoring', icon: Activity, title: 'NOC Suite', text: 'Probe custom hosts, linked routers, and OLTs for up/down state.' },
  { group: 'Monitoring', icon: Activity, title: 'Uptime Monitor', text: 'Continuous reachability checks with history.' },
  { group: 'Monitoring', icon: Satellite, title: 'Status Hub', text: 'Public-facing status groups for outages and maintenance.' },
  { group: 'Monitoring', icon: RadioTower, title: 'Outage Monitor', text: 'Correlate mass offline events across the access network.' },
  { group: 'Monitoring', icon: ScrollText, title: 'System Logs', text: 'Panel and router-related audit/event logs.' },
  { group: 'System', icon: Building2, title: 'Company', text: 'Branding, logo, and business details on receipts and login.' },
  { group: 'System', icon: Settings, title: 'System Settings', text: 'Currency, theme, AI keys, timezone, and panel preferences.' },
  { group: 'System', icon: ShieldCheck, title: 'Panel Roles', text: 'Staff users with role-based menu permissions (including read-only).' },
  { group: 'System', icon: DownloadCloud, title: 'Updater', text: 'Pull the latest panel build from GitHub onto the appliance.' },
  { group: 'System', icon: KeyRound, title: 'License', text: 'Activate hardware-bound licenses to unlock write access.' },
  { group: 'System', icon: Shield, title: 'Security', text: 'JWT sessions, optional 2FA, and vendor password-reset codes.' },
];

export default function Login() {
  const { login, completeTotpLogin } = useAuth();
  const { company } = useCompany();
  const nav = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [pendingToken, setPendingToken] = useState('');
  const [loginOpen, setLoginOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const businessName = company?.name?.trim() || BRAND_SHORT;

  useEffect(() => {
    document.title = PRODUCT_TITLE;
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('login') === '1' || params.get('signin') === '1') setLoginOpen(true);
  }, []);

  const openLogin = () => {
    setLoginOpen(true);
    setMobileNav(false);
    setForgotOpen(false);
    setError('');
  };

  const closeLogin = () => {
    if (loading) return;
    setLoginOpen(false);
    setForgotOpen(false);
    setPendingToken('');
    setError('');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await login(username, password);
      if (result.requiresTotp) {
        setPendingToken(result.pendingToken);
      } else {
        nav('/');
      }
    } catch (err: any) {
      const apiMsg = err?.response?.data?.error;
      const status = err?.response?.status;
      const ct = String(err?.response?.headers?.['content-type'] || '');
      const raw =
        typeof err?.response?.data === 'string'
          ? err.response.data
          : typeof err?.response?.data === 'object'
            ? JSON.stringify(err.response.data)
            : '';
      if (
        /text\/html/i.test(ct) ||
        /cloudflareaccess\.com|CF_Authorization|cf-browser-verification|Just a moment|Attention Required/i.test(
          raw
        )
      ) {
        setError(
          'Cloudflare is blocking login (Access app or Bot Fight). Open the panel by LAN IP (http://<server-ip>/login), and disable Access/Bot Fight on the tunnel hostname.'
        );
      } else if (status === 404) {
        setError(
          'Login API is not available on this hostname (pay-only public host). Use the panel LAN IP for staff login.'
        );
      } else if (apiMsg) setError(apiMsg);
      else if (!err?.response) setError('Cannot reach the API. Is the server running? Try the LAN IP if you used a Cloudflare URL.');
      else setError('Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="landing-root h-full min-h-[100dvh] overflow-x-hidden overflow-y-auto bg-[#050a14] text-slate-100 font-landing">
      <div className="pointer-events-none fixed inset-0 landing-aurora" aria-hidden />
      <div className="pointer-events-none fixed inset-0 landing-grid opacity-40" aria-hidden />
      <div className="pointer-events-none fixed -top-24 left-1/2 h-[28rem] w-[48rem] -translate-x-1/2 rounded-full bg-orange-500/15 blur-3xl animate-pulse-soft" aria-hidden />
      <div className="pointer-events-none fixed bottom-0 right-0 h-80 w-80 rounded-full bg-cyan-400/10 blur-3xl animate-float" aria-hidden />

      {/* Top nav */}
      <header className="sticky top-0 z-40 border-b border-white/5 bg-[#050a14]/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <a href="#top" className="flex items-center gap-3 min-w-0">
            <Logo size="sm" brandMode variant="dark" className="items-center gap-2.5" />
          </a>
          <nav className="hidden md:flex items-center gap-1 text-sm text-slate-300">
            {[
              ['#snapshots', 'Snapshots'],
              ['#features', 'All features'],
              ['#purpose', 'Purpose'],
            ].map(([href, label]) => (
              <a
                key={href}
                href={href}
                className="rounded-full px-3 py-1.5 transition-colors hover:bg-white/5 hover:text-white"
              >
                {label}
              </a>
            ))}
            <button
              type="button"
              onClick={openLogin}
              className="ml-2 inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-orange-500 to-amber-400 px-4 py-2 font-semibold text-slate-950 shadow-[0_0_24px_-6px_rgba(249,115,22,0.65)] transition-transform hover:scale-[1.03] active:scale-[0.98]"
            >
              Login
              <ArrowRight size={16} />
            </button>
          </nav>
          <div className="flex md:hidden items-center gap-2">
            <button
              type="button"
              onClick={openLogin}
              className="rounded-full bg-gradient-to-r from-orange-500 to-amber-400 px-3.5 py-1.5 text-sm font-semibold text-slate-950"
            >
              Login
            </button>
            <button
              type="button"
              aria-label="Menu"
              onClick={() => setMobileNav((v) => !v)}
              className="rounded-xl border border-white/10 bg-white/5 p-2 text-slate-200"
            >
              {mobileNav ? <X size={18} /> : <Menu size={18} />}
            </button>
          </div>
        </div>
        {mobileNav && (
          <div className="md:hidden border-t border-white/5 px-4 py-3 space-y-1 animate-fade-in">
            {[
              ['#snapshots', 'Snapshots'],
              ['#features', 'All features'],
              ['#purpose', 'Purpose'],
            ].map(([href, label]) => (
              <a
                key={href}
                href={href}
                onClick={() => setMobileNav(false)}
                className="block rounded-xl px-3 py-2.5 text-sm text-slate-200 hover:bg-white/5"
              >
                {label}
              </a>
            ))}
          </div>
        )}
      </header>

      <main id="top">
        {/* Hero — one composition */}
        <section className="relative mx-auto max-w-6xl px-4 sm:px-6 pt-10 sm:pt-16 pb-16 sm:pb-24">
          <div className="relative grid lg:grid-cols-[1.05fr_0.95fr] gap-10 lg:gap-12 items-center">
            <div className="relative z-10 animate-fade-in-up">
              <p className="font-display text-xs sm:text-sm uppercase tracking-[0.22em] text-cyan-300/90 mb-4 flex items-center gap-2">
                <Sparkles size={14} className="text-orange-400" />
                {businessName}
              </p>
              <h1 className="font-display text-[clamp(2.1rem,5vw,3.6rem)] font-bold leading-[1.05] tracking-tight text-white">
                {BRAND_SHORT}
                <span className="block mt-2 text-transparent bg-clip-text bg-[linear-gradient(110deg,#fb923c_0%,#f8fafc_45%,#22d3ee_100%)] bg-[length:200%_auto] animate-shine">
                  ISP ops, reimagined.
                </span>
              </h1>
              <p className="mt-5 max-w-xl text-base sm:text-lg text-slate-400 leading-relaxed">
                One panel for MikroTik subscribers, live network monitoring, billing, and field work —
                built for operators who need speed on LAN and clean public pay links.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={openLogin}
                  className="group inline-flex items-center gap-2 rounded-2xl bg-gradient-to-r from-orange-500 via-amber-400 to-orange-500 bg-[length:200%_auto] px-5 py-3 text-sm font-bold text-slate-950 shadow-[0_12px_40px_-12px_rgba(249,115,22,0.7)] transition-all hover:bg-right hover:scale-[1.02] active:scale-[0.98]"
                >
                  Open staff login
                  <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
                </button>
                <a
                  href="#snapshots"
                  className="inline-flex items-center gap-2 rounded-2xl border border-white/15 bg-white/5 px-5 py-3 text-sm font-semibold text-slate-100 backdrop-blur transition-colors hover:bg-white/10"
                >
                  See feature snapshots
                </a>
              </div>
            </div>

            {/* 3D hero stage */}
            <div className="relative h-[320px] sm:h-[400px] lg:h-[440px] perspective-[1400px] animate-tilt-in">
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="landing-orbit h-56 w-56 sm:h-72 sm:w-72 rounded-full border border-cyan-400/20 animate-orbit" />
                <div
                  className="landing-orbit absolute h-40 w-40 sm:h-52 sm:w-52 rounded-full border border-orange-400/25 animate-orbit"
                  style={{ animationDuration: '12s', animationDirection: 'reverse' }}
                />
              </div>
              <div className="absolute inset-6 sm:inset-10 landing-panel rounded-3xl border border-white/10 bg-gradient-to-br from-white/10 via-white/[0.04] to-cyan-400/5 p-3 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)] backdrop-blur-md transform-gpu [transform:perspective(1200px)_rotateY(-8deg)_rotateX(6deg)] hover:[transform:perspective(1200px)_rotateY(0deg)_rotateX(0deg)] transition-transform duration-700">
                <img
                  src="/landing/landing-dashboard.png"
                  alt="Live Dashboard snapshot"
                  className="h-full w-full rounded-2xl object-cover object-top shadow-inner"
                />
                <div className="pointer-events-none absolute inset-0 rounded-3xl ring-1 ring-inset ring-white/20" />
              </div>
              <div className="absolute -bottom-2 left-4 sm:left-8 landing-float-card animate-float rounded-2xl border border-white/10 bg-slate-950/80 px-3 py-2 text-xs text-slate-200 backdrop-blur">
                Real panel · Dashboard
              </div>
              <div
                className="absolute top-4 right-2 sm:right-6 landing-float-card animate-float rounded-2xl border border-orange-400/20 bg-orange-500/10 px-3 py-2 text-xs text-orange-100 backdrop-blur"
                style={{ animationDelay: '1.2s' }}
              >
                PPPoE · Billing · NOC
              </div>
            </div>
          </div>
        </section>

        {/* Snapshots of the real system */}
        <section id="snapshots" className="relative border-t border-white/5 py-16 sm:py-24">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div className="max-w-2xl mb-12">
              <h2 className="font-display text-3xl sm:text-4xl font-bold text-white tracking-tight">Inside the real panel</h2>
              <p className="mt-3 text-slate-300">
                Snapshots styled after the live Snapshot UI — Dashboard, PPPoE, billing, and network/NOC.
              </p>
            </div>
            <div className="space-y-14 sm:space-y-20">
              {SNAPSHOTS.map((f, i) => {
                const reverse = i % 2 === 1;
                return (
                  <article
                    key={f.id}
                    className={`grid lg:grid-cols-2 gap-8 lg:gap-12 items-center ${reverse ? 'lg:[&>*:first-child]:order-2' : ''}`}
                  >
                    <div>
                      <div className={`inline-flex items-center gap-2 rounded-full bg-gradient-to-r ${f.accent} px-3 py-1 text-xs font-semibold text-cyan-100 ring-1 ring-white/10 mb-4`}>
                        <f.icon size={14} />
                        {f.title}
                      </div>
                      <h3 className="font-display text-2xl sm:text-3xl font-bold text-white tracking-tight">{f.title}</h3>
                      <p className="mt-3 text-slate-300 leading-relaxed">{f.blurb}</p>
                    </div>
                    <div className="relative group">
                      <div className={`absolute -inset-3 rounded-[1.6rem] bg-gradient-to-br ${f.accent} blur-2xl opacity-60 transition-opacity group-hover:opacity-90`} />
                      <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-slate-950/60 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.9)] transition-transform duration-500 group-hover:-translate-y-1 group-hover:scale-[1.015]">
                        <img src={f.image} alt={f.title} className="w-full aspect-[16/10] object-cover object-top" loading="lazy" />
                        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-[#050a14]/50 via-transparent to-transparent" />
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        </section>

        {/* All features */}
        <section id="features" className="relative border-t border-white/5 py-16 sm:py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div className="max-w-2xl mb-10">
              <h2 className="font-display text-3xl sm:text-4xl font-bold text-white tracking-tight">All features</h2>
              <p className="mt-3 text-slate-300">
                Every major module in the panel, grouped by purpose — with a short explanation of what each does.
              </p>
            </div>
            {(['Overview', 'Subscribers & Access', 'Billing & Payments', 'Field Operations', 'Network & Infrastructure', 'Remote Access', 'Monitoring', 'System'] as const).map((group) => {
              const items = ALL_FEATURES.filter((f) => f.group === group);
              if (!items.length) return null;
              return (
                <div key={group} className="mb-10">
                  <h3 className="font-display text-sm font-semibold uppercase tracking-[0.18em] text-cyan-300/90 mb-4">{group}</h3>
                  <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
                    {items.map((p) => (
                      <div
                        key={`${group}-${p.title}`}
                        className="group rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5 transition-all duration-300 hover:-translate-y-0.5 hover:border-cyan-400/30 hover:bg-white/[0.06]"
                      >
                        <div className="mb-3 inline-flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-orange-500/20 to-cyan-400/10 text-cyan-200 ring-1 ring-white/10">
                          <p.icon size={17} />
                        </div>
                        <h4 className="font-display text-base font-semibold text-white">{p.title}</h4>
                        <p className="mt-1 text-sm text-slate-300 leading-relaxed">{p.text}</p>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Purpose */}
        <section id="purpose" className="relative border-t border-white/5 py-16 sm:py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-gradient-to-br from-white/[0.07] via-white/[0.02] to-cyan-500/10 p-8 sm:p-12">
              <div className="absolute -right-16 -top-16 h-56 w-56 rounded-full bg-orange-500/20 blur-3xl" />
              <div className="relative max-w-2xl">
                <h2 className="font-display text-3xl sm:text-4xl font-bold text-white tracking-tight">Why this panel exists</h2>
                <p className="mt-4 text-slate-300 leading-relaxed">
                  {PRODUCT_NAME} brings billing, MikroTik access, monitoring, and field tools into a single
                  operator cockpit — so your team spends less time switching apps and more time keeping
                  subscribers online.
                </p>
                <button
                  type="button"
                  onClick={openLogin}
                  className="mt-8 inline-flex items-center gap-2 rounded-2xl bg-white text-slate-950 px-5 py-3 text-sm font-bold transition-transform hover:scale-[1.02] active:scale-[0.98]"
                >
                  Sign in to your panel
                  <ArrowRight size={16} />
                </button>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/5 py-8 px-4 text-center text-xs text-slate-500">
        <p>{PRODUCT_TITLE}</p>
      </footer>

      {/* Login modal */}
      {loginOpen && (
        <div
          className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-slate-950/70 backdrop-blur-md p-0 sm:p-4 animate-fade-in"
          onClick={closeLogin}
        >
          <div
            className="theme-modal relative w-full max-w-md max-h-[min(92dvh,720px)] overflow-y-auto rounded-t-3xl sm:rounded-3xl border border-white/15 bg-white text-slate-900 shadow-2xl animate-scale-in"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={closeLogin}
              className="absolute right-3 top-3 z-10 rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              aria-label="Close"
            >
              <X size={18} />
            </button>
            <div className="p-5 sm:p-8 md:p-9">
              {pendingToken ? (
                <TotpStepForm
                  pendingToken={pendingToken}
                  onBack={() => {
                    setPendingToken('');
                    setPassword('');
                  }}
                  onSubmit={async (code) => {
                    await completeTotpLogin(pendingToken, code);
                    nav('/');
                  }}
                />
              ) : !forgotOpen ? (
                <>
                  <div className="mb-6 sm:mb-8 min-w-0 pr-8">
                    <h2
                      className="font-display font-bold text-slate-900 tracking-tight leading-tight break-words [overflow-wrap:anywhere] text-[clamp(1.15rem,0.85rem+2.2vw,1.75rem)]"
                      title={businessName}
                    >
                      {businessName}
                    </h2>
                    <p className="text-slate-500 text-sm mt-1">Staff sign-in · use LAN IP when possible</p>
                  </div>

                  <form onSubmit={submit} className="space-y-5" autoComplete="on">
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-1.5" htmlFor="login-username">
                        Username
                      </label>
                      <div className="relative">
                        <User size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                        <input
                          id="login-username"
                          name="username"
                          value={username}
                          onChange={(e) => setUsername(e.target.value)}
                          className="input pl-10 text-base sm:text-sm"
                          autoFocus
                          autoComplete="username"
                          inputMode="text"
                          autoCapitalize="none"
                          autoCorrect="off"
                          spellCheck={false}
                          placeholder="Username"
                        />
                      </div>
                    </div>
                    <div>
                      <div className="flex items-center justify-between mb-1.5 gap-2">
                        <label className="text-sm font-medium text-slate-700" htmlFor="login-password">
                          Password
                        </label>
                        <button
                          type="button"
                          onClick={() => setForgotOpen(true)}
                          className="text-xs font-medium text-brand-600 hover:text-brand-700 shrink-0 py-1"
                        >
                          Forgot password?
                        </button>
                      </div>
                      <div className="relative">
                        <Lock size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                        <input
                          id="login-password"
                          name="password"
                          type="password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          className="input pl-10 text-base sm:text-sm"
                          autoComplete="current-password"
                          placeholder="Password"
                        />
                      </div>
                    </div>

                    {error && (
                      <div className="text-sm text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-4 py-3 animate-fade-in">
                        {error}
                      </div>
                    )}

                    <button type="submit" disabled={loading || !username.trim() || !password} className="btn-primary w-full py-3 text-base min-h-12">
                      {loading ? (
                        <Loader2 size={18} className="animate-spin" />
                      ) : (
                        <>
                          Sign in
                          <ArrowRight size={18} />
                        </>
                      )}
                    </button>
                  </form>
                  {isNativeApp() && (
                    <p className="text-xs text-slate-400 mt-6 text-center leading-relaxed">
                      Panel: <span className="font-medium text-slate-500">{getStoredServerUrl() || 'not set'}</span>
                      <button
                        type="button"
                        className="block mx-auto mt-2 text-brand-600 hover:text-brand-700 font-medium"
                        onClick={() => {
                          setStoredServerUrl('');
                          window.location.reload();
                        }}
                      >
                        Change server URL
                      </button>
                    </p>
                  )}
                </>
              ) : (
                <ForgotPasswordForm
                  onBack={() => setForgotOpen(false)}
                  onSuccess={(u) => {
                    setUsername(u);
                    setPassword('');
                    setForgotOpen(false);
                  }}
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ForgotPasswordForm({ onBack, onSuccess }: { onBack: () => void; onSuccess: (username: string) => void }) {
  const [panelId, setPanelId] = useState('');
  const [defaultUser, setDefaultUser] = useState('admin');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    publicApi
      .get('/auth/panel-id')
      .then((r) => {
        setPanelId(r.data.panelId);
        setDefaultUser(r.data.defaultUser || 'admin');
        setError('');
      })
      .catch((err: any) => {
        const apiMsg = err?.response?.data?.error;
        if (apiMsg) setError(apiMsg);
        else if (!err?.response) setError('Cannot reach the API — Panel ID unavailable until the server is running.');
        else setError('Could not load Panel ID.');
      });
  }, []);

  const copyId = async () => {
    if (!panelId) return;
    const ok = await copyText(panelId);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const reset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);
    try {
      const r = await publicApi.post('/auth/forgot-password-reset', { code: code.trim() });
      setSuccess(r.data.message || 'Password reset successful.');
      onSuccess(r.data.username || defaultUser);
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Reset failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <button type="button" onClick={onBack} className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 mb-4">
        <ArrowLeft size={16} /> Back to sign in
      </button>

      <div className="mb-6">
        <h2 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
          <KeyRound size={22} className="text-brand-500" />
          Reset panel login
        </h2>
        <p className="text-slate-500 text-sm mt-1 leading-relaxed">
          Send your <strong>Panel ID</strong> to your vendor. They run the activator (same tool used for license keys) to give you a reset code. Enter it below to restore the default username and password.
        </p>
      </div>

      <FormField label="Panel ID" hint="Copy this ID and send it to your vendor.">
        <div className="flex items-center gap-2">
          <code className="input font-mono text-sm bg-slate-50 flex-1">{panelId || 'Loading…'}</code>
          <button type="button" className="btn-secondary shrink-0" onClick={copyId} disabled={!panelId}>
            {copied ? <CheckCircle2 size={15} className="text-emerald-600" /> : <Copy size={15} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </FormField>

      <form onSubmit={reset} className="space-y-4 mt-5">
        <FormField label="Authentication reset code" hint="Format: RST-XXXX-XXXX-XXXX-XXXX (from vendor activator)">
          <input
            className="input font-mono uppercase"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="RST-XXXX-XXXX-XXXX-XXXX"
            autoFocus
          />
        </FormField>

        {error && (
          <div className="text-sm text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-4 py-3">{error}</div>
        )}
        {success && (
          <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-xl px-4 py-3">{success}</div>
        )}

        <button type="submit" disabled={loading || !code.trim()} className="btn-primary w-full py-3">
          {loading ? <Loader2 size={18} className="animate-spin" /> : 'Reset to default credentials'}
        </button>
      </form>

      <p className="text-xs text-slate-400 mt-6 text-center">
        After reset, sign in with username <span className="font-medium text-slate-500">{defaultUser}</span> and the restored password from your vendor.
      </p>
    </div>
  );
}

function TotpStepForm({
  pendingToken,
  onBack,
  onSubmit,
}: {
  pendingToken: string;
  onBack: () => void;
  onSubmit: (code: string) => Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingToken) return;
    setError('');
    setLoading(true);
    try {
      await onSubmit(code.trim());
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Invalid code.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <button type="button" onClick={onBack} className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 mb-4">
        <ArrowLeft size={16} /> Back to sign in
      </button>

      <div className="mb-6">
        <h2 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
          <Shield size={22} className="text-brand-500" />
          Two-factor authentication
        </h2>
        <p className="text-slate-500 text-sm mt-1 leading-relaxed">
          Enter the 6-digit code from your authenticator app, or one of your backup codes.
        </p>
      </div>

      <form onSubmit={submit} className="space-y-4">
        <FormField label="Authentication code">
          <input
            className="input font-mono text-lg tracking-widest text-center"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
            inputMode="text"
            autoFocus
            maxLength={11}
          />
        </FormField>

        {error && (
          <div className="text-sm text-rose-700 bg-rose-50 border border-rose-100 rounded-xl px-4 py-3">{error}</div>
        )}

        <button type="submit" disabled={loading || !code.trim()} className="btn-primary w-full py-3">
          {loading ? <Loader2 size={18} className="animate-spin" /> : 'Verify & sign in'}
        </button>
      </form>
    </div>
  );
}
