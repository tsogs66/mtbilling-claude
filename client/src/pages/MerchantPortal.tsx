import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  LogOut, Search, Upload, CheckCircle2, Loader2, Palette, KeyRound, Wallet, ArrowLeft, Send,
  Download, Share, X,
} from 'lucide-react';
import { api, publicApi, peso } from '../api';
import { useAuth } from '../context/AuthContext';
import { useCompany } from '../context/CompanyContext';
import Logo from '../components/Logo';
import { MatrixRain } from '../components/portal/MatrixRain';
import { OrbitalNetwork } from '../components/themes/OrbitalNetwork';
import { usePortalInstall, type PortalThemeId } from '../lib/portalInstall';

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

function isMerchantPartnerRole(role?: string | null) {
  const r = String(role || '').trim().toLowerCase();
  return r === 'cashier' || r === 'merchant';
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

export default function MerchantPortal() {
  const { user, loading, login, logout, refresh } = useAuth();
  const [theme, setTheme] = useState<PortalThemeId>('matrix');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [mustChange, setMustChange] = useState(false);
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotMobile, setForgotMobile] = useState('');
  const [changeCurrent, setChangeCurrent] = useState('');
  const [changeNext, setChangeNext] = useState('');

  const [q, setQ] = useState('');
  const [hits, setHits] = useState<any[]>([]);
  const [selected, setSelected] = useState<any | null>(null);
  const [months, setMonths] = useState(1);
  const [collectionType, setCollectionType] = useState<'cash' | 'online'>('cash');
  const [channel, setChannel] = useState<'gcash' | 'maya' | 'cash'>('cash');
  const [reference, setReference] = useState('');
  const [merchantId, setMerchantId] = useState('');
  const [merchants, setMerchants] = useState<any[]>([]);
  const [proof, setProof] = useState<string | null>(null);
  const [recent, setRecent] = useState<any[]>([]);
  const [collectBusy, setCollectBusy] = useState(false);
  const [openCollectibles, setOpenCollectibles] = useState<any[]>([]);
  const [depositSummary, setDepositSummary] = useState<any>(null);
  const [selectedCollectibleIds, setSelectedCollectibleIds] = useState<Set<number>>(new Set());
  const [depositNote, setDepositNote] = useState('');
  const [depositProof, setDepositProof] = useState<string | null>(null);
  const [depositBusy, setDepositBusy] = useState(false);
  const [myDeposits, setMyDeposits] = useState<any[]>([]);

  const { showInstallButton, installed, iosHint, dismissIosHint, install } = usePortalInstall(theme, 'merchant');

  const show = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(''), 5000);
  };

  const signedIn = !!user && isMerchantPartnerRole(user.role);

  const loadCollectibles = async () => {
    try {
      const r = await api.get('/merchant/collectibles', { params: { status: 'open' } });
      setOpenCollectibles(r.data.collectibles || []);
      setDepositSummary(r.data.summary || null);
      setSelectedCollectibleIds(new Set());
    } catch {
      setOpenCollectibles([]);
    }
    try {
      const d = await api.get('/merchant/deposits');
      setMyDeposits(d.data.deposits || []);
    } catch {
      setMyDeposits([]);
    }
  };

  useEffect(() => {
    if (!signedIn) return;
    api
      .get('/merchant/me')
      .then((r) => {
        setTheme(r.data.theme === 'orbital' ? 'orbital' : 'matrix');
        setMustChange(!!r.data.mustChangePassword);
      })
      .catch(() => undefined);
    api.get('/merchant/payment-merchants').then((r) => setMerchants(r.data.merchants || [])).catch(() => setMerchants([]));
    api.get('/merchant/recent').then((r) => setRecent(r.data.payments || [])).catch(() => setRecent([]));
    void loadCollectibles();
  }, [signedIn]);

  useEffect(() => {
    if (!signedIn || q.trim().length < 2) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      api
        .get('/merchant/subscribers', { params: { q: q.trim() } })
        .then((r) => setHits(r.data.subscribers || []))
        .catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q, signedIn]);

  const amountPreview = useMemo(() => {
    if (!selected) return 0;
    return (Number(selected.price) || 0) * Math.max(1, months);
  }, [selected, months]);

  const doLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const result = await login(email.trim(), password);
      if ('requiresTotp' in result && result.requiresTotp) {
        show('This merchant account has 2FA enabled — use the staff login page.');
        return;
      }
      await refresh();
      const me = await api.get('/merchant/me').catch(() => null);
      if (me?.data) {
        setTheme(me.data.theme === 'orbital' ? 'orbital' : 'matrix');
        setMustChange(!!me.data.mustChangePassword);
      }
    } catch (err: any) {
      show(err?.response?.data?.error || 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  const doForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await publicApi.post('/public/merchant/forgot-password', {
        email: email.trim(),
        mobile: forgotMobile.trim(),
      });
      show(r.data.message || 'Check your email/SMS for a temporary password');
      setForgotOpen(false);
    } catch (err: any) {
      show(err?.response?.data?.error || 'Reset failed');
    } finally {
      setBusy(false);
    }
  };

  const saveTheme = async (next: PortalThemeId) => {
    setTheme(next);
    try {
      await api.put('/merchant/theme', { theme: next });
    } catch {
      /* local theme still applies */
    }
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/merchant/change-password', {
        currentPassword: changeCurrent,
        newPassword: changeNext,
      });
      setMustChange(false);
      setChangeCurrent('');
      setChangeNext('');
      show('Password updated');
    } catch (err: any) {
      show(err?.response?.data?.error || 'Could not change password');
    } finally {
      setBusy(false);
    }
  };

  const collect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setCollectBusy(true);
    try {
      const r = await api.post('/merchant/collect', {
        userId: selected.id,
        months,
        collectionType,
        channel: collectionType === 'cash' ? 'cash' : channel,
        reference,
        merchantId: collectionType === 'cash' && merchantId ? Number(merchantId) : null,
        proofImage: proof,
      });
      show(
        `Payment posted (${r.data.collectionType}): ${peso(r.data.amount)} · ${r.data.months}mo for ${selected.username}. Subscriber activated — add to a deposit when ready.`
      );
      setSelected(null);
      setQ('');
      setHits([]);
      setReference('');
      setProof(null);
      setMonths(1);
      const recentR = await api.get('/merchant/recent');
      setRecent(recentR.data.payments || []);
      await loadCollectibles();
    } catch (err: any) {
      show(err?.response?.data?.error || 'Payment failed');
    } finally {
      setCollectBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-300 gap-2">
        <Loader2 className="animate-spin" size={18} /> Loading…
      </div>
    );
  }

  // Staff (Admin/etc.) already signed into the panel — do not bounce them away from /merchant
  // (that looked like the page was broken). Offer sign-out so they can use a merchant account.
  const staffBlockingMerchant = !!user && !isMerchantPartnerRole(user.role);

  return (
    <div className="subscriber-portal min-h-screen relative text-slate-100">
      <PortalBackdrop theme={theme} />
      <div className="relative z-10 max-w-3xl mx-auto px-4 py-8 space-y-5">
        <header className="portal-glass-strong rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Logo size="sm" variant="dark" showText={false} />
            <div className="font-bold text-lg truncate">Merchant portal</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {showInstallButton && (
              <button
                type="button"
                className="portal-cta inline-flex items-center gap-1.5 text-xs font-semibold"
                onClick={() => void install()}
                title="Install Merchant to Home Screen"
              >
                <Download size={14} /> Install
              </button>
            )}
            {installed && (
              <span className="text-[11px] text-emerald-300/90 px-1">Installed</span>
            )}
            {signedIn ? (
              <>
                <button
                  type="button"
                  className="portal-cta inline-flex items-center gap-1.5 text-xs"
                  onClick={() => void saveTheme(theme === 'matrix' ? 'orbital' : 'matrix')}
                  title="Toggle portal theme"
                >
                  <Palette size={14} /> {theme === 'matrix' ? 'Matrix' : 'Orbital'}
                </button>
                <button
                  type="button"
                  className="portal-cta inline-flex items-center gap-1.5 text-xs"
                  onClick={() => {
                    logout();
                    setSelected(null);
                  }}
                >
                  <LogOut size={14} /> Sign out
                </button>
              </>
            ) : (
              <Link to="/login" className="text-xs text-slate-300 hover:text-white inline-flex items-center gap-1">
                <ArrowLeft size={12} /> Staff panel
              </Link>
            )}
          </div>
        </header>

        {showInstallButton && (
          <button
            type="button"
            onClick={() => void install()}
            className="w-full flex items-center gap-3 rounded-2xl border border-orange-400/35 bg-orange-500/15 hover:bg-orange-500/25 px-4 py-3 text-left transition portal-glass-strong"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-500 text-slate-950 shrink-0">
              <Download size={18} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold text-white text-sm">Install Merchant</span>
              <span className="block text-xs text-slate-300/80 mt-0.5">
                Add to Home Screen for faster collection — opens straight to this portal.
              </span>
            </span>
          </button>
        )}

        {toast && (
          <div className="portal-glass rounded-xl px-4 py-3 text-sm text-emerald-100 border border-emerald-400/30">
            {toast}
          </div>
        )}

        {staffBlockingMerchant && (
          <div className="portal-glass-strong rounded-2xl p-5 space-y-4">
            <div>
              <h1 className="text-xl font-bold">Merchant portal</h1>
              <p className="text-sm text-slate-300/80 mt-1">
                You are signed in as <span className="text-white font-medium">{user?.username}</span> (
                {user?.role}). Merchant partners use a separate email login created under Panel Roles.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="portal-cta inline-flex items-center gap-1.5 text-sm"
                onClick={() => {
                  logout();
                  setSelected(null);
                }}
              >
                <LogOut size={14} /> Sign out staff session
              </button>
              <Link to="/" className="portal-cta inline-flex items-center gap-1.5 text-sm opacity-80">
                <ArrowLeft size={14} /> Back to panel
              </Link>
            </div>
          </div>
        )}

        {!signedIn && !staffBlockingMerchant && (
          <div className="portal-glass-strong rounded-2xl p-5 space-y-4">
            <div>
              <h1 className="text-xl font-bold">Merchant sign-in</h1>
              <p className="text-sm text-slate-300/80 mt-1">Use the email and password provided by your admin.</p>
            </div>
            {!forgotOpen ? (
              <form className="space-y-3" onSubmit={doLogin}>
                <label className="block text-sm">
                  <span className="text-xs text-slate-400">Email</span>
                  <input
                    className="input mt-1 bg-black/30 border-white/10 text-white"
                    type="email"
                    autoComplete="username"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-xs text-slate-400">Password</span>
                  <input
                    className="input mt-1 bg-black/30 border-white/10 text-white"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                </label>
                <button type="submit" className="btn-primary w-full justify-center" disabled={busy}>
                  {busy ? <Loader2 className="animate-spin" size={16} /> : <Wallet size={16} />}
                  {busy ? 'Signing in…' : 'Sign in'}
                </button>
                <button type="button" className="text-xs text-sky-300 hover:underline" onClick={() => setForgotOpen(true)}>
                  Forgot password? Use email + mobile
                </button>
              </form>
            ) : (
              <form className="space-y-3" onSubmit={doForgot}>
                <p className="text-sm text-slate-300">
                  Enter the merchant email and the mobile number on file. A temporary password is sent by email and/or SMS.
                </p>
                <label className="block text-sm">
                  <span className="text-xs text-slate-400">Email</span>
                  <input
                    className="input mt-1 bg-black/30 border-white/10 text-white"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-xs text-slate-400">Mobile number</span>
                  <input
                    className="input mt-1 bg-black/30 border-white/10 text-white"
                    value={forgotMobile}
                    onChange={(e) => setForgotMobile(e.target.value)}
                    required
                  />
                </label>
                <button type="submit" className="btn-primary w-full justify-center" disabled={busy}>
                  {busy ? 'Sending…' : 'Send temporary password'}
                </button>
                <button type="button" className="text-xs text-slate-300 hover:underline" onClick={() => setForgotOpen(false)}>
                  Back to sign-in
                </button>
              </form>
            )}
          </div>
        )}

        {signedIn && mustChange && (
          <form className="portal-glass-strong rounded-2xl p-5 space-y-3" onSubmit={changePassword}>
            <div className="flex items-center gap-2 font-semibold">
              <KeyRound size={18} /> Set a new password
            </div>
            <p className="text-xs text-amber-200/90">Your account still uses the initial mobile-number password. Change it before collecting payments.</p>
            <input
              className="input bg-black/30 border-white/10 text-white"
              type="password"
              placeholder="Current password"
              value={changeCurrent}
              onChange={(e) => setChangeCurrent(e.target.value)}
              required
            />
            <input
              className="input bg-black/30 border-white/10 text-white"
              type="password"
              placeholder="New password (min 6)"
              value={changeNext}
              onChange={(e) => setChangeNext(e.target.value)}
              required
              minLength={6}
            />
            <button type="submit" className="btn-primary" disabled={busy}>
              Save password
            </button>
          </form>
        )}

        {signedIn && !mustChange && (
          <>
            <div className="portal-glass-strong rounded-2xl p-5 space-y-4">
              <div>
                <h2 className="font-bold text-lg">Collect payment</h2>
                <p className="text-sm text-slate-300/80 mt-0.5">
                  Search a subscriber, choose <b>cash</b> or <b>online</b>, and post payment. The account activates immediately.
                  Remit collections below (select multiple) with deposit proof for admin acceptance. Logged as <b>{user?.username}</b>.
                </p>
              </div>

              <label className="block">
                <span className="text-xs text-slate-400">Search subscriber</span>
                <div className="relative mt-1">
                  <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    className="input pl-9 bg-black/30 border-white/10 text-white"
                    value={q}
                    onChange={(e) => {
                      setQ(e.target.value);
                      setSelected(null);
                    }}
                    placeholder="Username, customer, account, mobile…"
                  />
                </div>
              </label>

              {!selected && hits.length > 0 && (
                <ul className="rounded-xl border border-white/10 divide-y divide-white/5 max-h-56 overflow-auto bg-black/20">
                  {hits.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        className="w-full text-left px-3 py-2.5 hover:bg-white/5"
                        onClick={() => {
                          setSelected(s);
                          setQ(s.username);
                          setHits([]);
                        }}
                      >
                        <div className="font-semibold">{s.username}</div>
                        <div className="text-xs text-slate-400">
                          {s.customer} · {s.account} · {s.status} · due {String(s.subscriptionDue || '—').slice(0, 10)}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {selected && (
                <form className="space-y-3 border-t border-white/10 pt-4" onSubmit={collect}>
                  <div className="rounded-xl bg-black/25 px-3 py-2 text-sm">
                    <div className="font-semibold">{selected.username}</div>
                    <div className="text-xs text-slate-400">
                      {selected.customer} · {selected.account} · {selected.profile} · {peso(selected.price)}/mo
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="text-sm">
                      <span className="text-xs text-slate-400">Months</span>
                      <input
                        type="number"
                        min={1}
                        className="input mt-1 bg-black/30 border-white/10 text-white"
                        value={months}
                        onChange={(e) => setMonths(Math.max(1, Number(e.target.value) || 1))}
                      />
                    </label>
                    <div className="text-sm">
                      <span className="text-xs text-slate-400">Amount</span>
                      <div className="mt-1 font-bold text-lg">{peso(amountPreview)}</div>
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-400 mb-1.5">Payment received as</div>
                    <div className="flex flex-wrap gap-2">
                      {(['cash', 'online'] as const).map((c) => (
                        <button
                          key={c}
                          type="button"
                          className={`px-3 py-1.5 rounded-lg text-xs font-semibold uppercase ${
                            collectionType === c ? 'bg-emerald-500/30 ring-1 ring-emerald-300/50' : 'bg-white/5'
                          }`}
                          onClick={() => {
                            setCollectionType(c);
                            setChannel(c === 'cash' ? 'cash' : 'gcash');
                          }}
                        >
                          {c}
                        </button>
                      ))}
                    </div>
                  </div>
                  {collectionType === 'online' && (
                    <div className="flex flex-wrap gap-2">
                      {(['gcash', 'maya'] as const).map((c) => (
                        <button
                          key={c}
                          type="button"
                          className={`px-3 py-1.5 rounded-lg text-xs font-semibold uppercase ${
                            channel === c ? 'bg-sky-500/30 ring-1 ring-sky-300/50' : 'bg-white/5'
                          }`}
                          onClick={() => setChannel(c)}
                        >
                          {c}
                        </button>
                      ))}
                    </div>
                  )}
                  {collectionType === 'cash' && merchants.length > 0 && (
                    <label className="block text-sm">
                      <span className="text-xs text-slate-400">Cash merchant</span>
                      <select
                        className="input mt-1 bg-black/30 border-white/10 text-white"
                        value={merchantId}
                        onChange={(e) => setMerchantId(e.target.value)}
                      >
                        <option value="">Optional…</option>
                        {merchants.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="block text-sm">
                    <span className="text-xs text-slate-400">
                      {collectionType === 'cash' ? 'Note / receipt ref (optional)' : 'Reference number'}
                    </span>
                    <input
                      className="input mt-1 bg-black/30 border-white/10 text-white"
                      value={reference}
                      onChange={(e) => setReference(e.target.value)}
                      required={collectionType === 'online'}
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="text-xs text-slate-400">
                      Subscriber payment proof {collectionType === 'cash' ? '(optional)' : '(required)'}
                    </span>
                    <input
                      type="file"
                      accept="image/*"
                      className="mt-1 block w-full text-xs"
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        if (!f) {
                          setProof(null);
                          return;
                        }
                        try {
                          setProof(await fileToDataUrl(f));
                        } catch {
                          show('Could not read image');
                        }
                      }}
                    />
                    {proof && (
                      <div className="mt-2 text-xs text-emerald-300 inline-flex items-center gap-1">
                        <Upload size={12} /> Screenshot attached
                      </div>
                    )}
                  </label>
                  <button type="submit" className="btn-primary w-full justify-center" disabled={collectBusy}>
                    {collectBusy ? <Loader2 className="animate-spin" size={16} /> : <CheckCircle2 size={16} />}
                    {collectBusy ? 'Posting…' : 'Post payment & activate'}
                  </button>
                </form>
              )}
            </div>

            <div className="portal-glass-strong rounded-2xl p-4 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-semibold text-sm">Open collectibles</div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Subscriber accounts are already activated. Select one or more payments, upload deposit proof, and submit for admin acceptance.
                  </p>
                  {depositSummary?.open && (
                    <p className="text-xs text-amber-200/90 mt-1">
                      Open: {depositSummary.open.count} · {peso(depositSummary.open.total)}
                      {depositSummary.submitted?.count
                        ? ` · Pending admin: ${depositSummary.submitted.count}`
                        : ''}
                    </p>
                  )}
                </div>
                <button type="button" className="portal-cta text-xs" onClick={() => void loadCollectibles()}>
                  Refresh
                </button>
              </div>

              {openCollectibles.length === 0 ? (
                <div className="text-xs text-slate-400 py-3 text-center">No open collectibles.</div>
              ) : (
                <>
                  <label className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={
                        openCollectibles.length > 0 &&
                        openCollectibles.every((c) => selectedCollectibleIds.has(Number(c.id)))
                      }
                      onChange={() => {
                        const allSelected = openCollectibles.every((c) =>
                          selectedCollectibleIds.has(Number(c.id))
                        );
                        if (allSelected) setSelectedCollectibleIds(new Set());
                        else setSelectedCollectibleIds(new Set(openCollectibles.map((c) => Number(c.id))));
                      }}
                    />
                    Select all ({openCollectibles.length})
                  </label>
                  <ul className="divide-y divide-white/5 text-sm max-h-64 overflow-auto rounded-xl border border-white/10 bg-black/20">
                    {openCollectibles.map((c) => (
                      <li key={c.id}>
                        <label className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-white/5">
                          <input
                            type="checkbox"
                            checked={selectedCollectibleIds.has(Number(c.id))}
                            onChange={() => {
                              setSelectedCollectibleIds((prev) => {
                                const next = new Set(prev);
                                const id = Number(c.id);
                                if (next.has(id)) next.delete(id);
                                else next.add(id);
                                return next;
                              });
                            }}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="font-medium truncate">{c.subscriberUsername}</div>
                            <div className="text-xs text-slate-400 truncate">
                              {c.customerName} · {String(c.collectionType || '').toUpperCase()}
                              {c.payChannel ? ` / ${String(c.payChannel).toUpperCase()}` : ''}
                              {c.externalRef ? ` · ${c.externalRef}` : ''}
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="font-semibold">{peso(c.amount)}</div>
                            <div className="text-[11px] text-slate-400">
                              {String(c.createdAt || '').slice(0, 16).replace('T', ' ')}
                            </div>
                          </div>
                        </label>
                      </li>
                    ))}
                  </ul>

                  <div className="space-y-2 border-t border-white/10 pt-3">
                    <div className="text-xs text-slate-300">
                      Selected: <b>{selectedCollectibleIds.size}</b>
                      {selectedCollectibleIds.size > 0
                        ? ` · ${peso(
                            openCollectibles
                              .filter((c) => selectedCollectibleIds.has(Number(c.id)))
                              .reduce((s, c) => s + (Number(c.amount) || 0), 0)
                          )}`
                        : ''}
                      {selectedCollectibleIds.size > 1 ? ' (bulk)' : selectedCollectibleIds.size === 1 ? ' (single)' : ''}
                    </div>
                    <label className="block text-sm">
                      <span className="text-xs text-slate-400">Deposit / remittance note (optional)</span>
                      <input
                        className="input mt-1 bg-black/30 border-white/10 text-white"
                        value={depositNote}
                        onChange={(e) => setDepositNote(e.target.value)}
                        placeholder="e.g. Bank deposit slip #123"
                      />
                    </label>
                    <label className="block text-sm">
                      <span className="text-xs text-slate-400">Deposit proof for admin (optional but recommended)</span>
                      <input
                        type="file"
                        accept="image/*"
                        className="mt-1 block w-full text-xs"
                        onChange={async (e) => {
                          const f = e.target.files?.[0];
                          if (!f) {
                            setDepositProof(null);
                            return;
                          }
                          try {
                            setDepositProof(await fileToDataUrl(f));
                          } catch {
                            show('Could not read deposit proof');
                          }
                        }}
                      />
                      {depositProof && (
                        <div className="mt-1 text-xs text-emerald-300 inline-flex items-center gap-1">
                          <Upload size={12} /> Deposit proof attached
                        </div>
                      )}
                    </label>
                    <button
                      type="button"
                      className="btn-primary w-full justify-center"
                      disabled={depositBusy || selectedCollectibleIds.size === 0}
                      onClick={async () => {
                        setDepositBusy(true);
                        try {
                          const r = await api.post('/merchant/deposits', {
                            collectibleIds: [...selectedCollectibleIds],
                            note: depositNote,
                            proofImage: depositProof,
                          });
                          show(
                            `Submitted ${r.data.deposit.itemCount} payment(s) · ${peso(r.data.deposit.amountTotal)} for admin acceptance`
                          );
                          setDepositNote('');
                          setDepositProof(null);
                          await loadCollectibles();
                        } catch (err: any) {
                          show(err?.response?.data?.error || 'Submit failed');
                        } finally {
                          setDepositBusy(false);
                        }
                      }}
                    >
                      {depositBusy ? <Loader2 className="animate-spin" size={16} /> : <Send size={16} />}
                      {depositBusy
                        ? 'Submitting…'
                        : `Submit ${selectedCollectibleIds.size || ''} payment(s) to admin`}
                    </button>
                  </div>
                </>
              )}

              {myDeposits.filter((d) => d.status === 'pending').length > 0 && (
                <div className="border-t border-white/10 pt-3">
                  <div className="text-xs font-semibold text-slate-300 mb-1">Awaiting admin acceptance</div>
                  <ul className="text-xs space-y-1">
                    {myDeposits
                      .filter((d) => d.status === 'pending')
                      .slice(0, 8)
                      .map((d) => (
                        <li key={d.id} className="flex justify-between gap-2 text-slate-400">
                          <span>
                            #{d.id} · {d.mode} · {d.itemCount} item(s)
                          </span>
                          <span className="text-amber-200">{peso(d.amountTotal)}</span>
                        </li>
                      ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="portal-glass rounded-2xl p-4">
              <div className="font-semibold text-sm mb-2">Your recent activations</div>
              {recent.length === 0 ? (
                <div className="text-xs text-slate-400 py-3 text-center">No payments posted yet.</div>
              ) : (
                <ul className="divide-y divide-white/5 text-sm">
                  {recent.map((p) => (
                    <li key={p.id} className="py-2 flex justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium truncate">{p.username}</div>
                        <div className="text-xs text-slate-400 truncate">
                          {p.customer} · {String(p.payChannel || '').toUpperCase()} · {p.externalRef || '—'}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-semibold">{peso(p.amount)}</div>
                        <div className="text-[11px] text-slate-400">{String(p.paidAt || '').slice(0, 16).replace('T', ' ')}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
      {iosHint && <MerchantIosInstallHint onClose={dismissIosHint} />}
    </div>
  );
}

function MerchantIosInstallHint({ onClose }: { onClose: () => void }) {
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center p-0 sm:p-4">
      <button type="button" className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} aria-label="Close" />
      <div className="relative w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-5 sm:p-6 portal-glass-strong border border-white/10">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <h3 className="text-lg font-bold text-white">Install Merchant</h3>
            <p className="text-sm text-slate-300/80 mt-1">Add Merchant to your Home Screen.</p>
          </div>
          <button type="button" className="p-2 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <ol className="space-y-3 text-sm text-slate-300/90">
          <li className="flex gap-3">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-500/20 text-orange-300 ring-1 ring-orange-400/30 font-semibold text-xs shrink-0">
              1
            </span>
            <span>
              Tap the <Share size={14} className="inline -mt-0.5 text-orange-300" /> <b className="text-white">Share</b> button in Safari.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-500/20 text-orange-300 ring-1 ring-orange-400/30 font-semibold text-xs shrink-0">
              2
            </span>
            <span>
              Scroll and tap <b className="text-white">Add to Home Screen</b>.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-orange-500/20 text-orange-300 ring-1 ring-orange-400/30 font-semibold text-xs shrink-0">
              3
            </span>
            <span>
              Tap <b className="text-white">Add</b> — open Merchant anytime without the browser chrome.
            </span>
          </li>
        </ol>
        <button type="button" onClick={onClose} className="portal-cta mt-5 w-full rounded-xl font-semibold py-2.5 text-sm">
          Got it
        </button>
      </div>
    </div>,
    document.body
  );
}
