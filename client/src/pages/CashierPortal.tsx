import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  LogOut, Search, Upload, CheckCircle2, Loader2, Palette, KeyRound, Wallet, ArrowLeft,
} from 'lucide-react';
import { api, publicApi, peso } from '../api';
import { useAuth } from '../context/AuthContext';
import { useCompany } from '../context/CompanyContext';
import Logo from '../components/Logo';
import { MatrixRain } from '../components/portal/MatrixRain';
import { OrbitalNetwork } from '../components/themes/OrbitalNetwork';
import { usePortalInstall, type PortalThemeId } from '../lib/portalInstall';
import { PRODUCT_TITLE } from '../branding';

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

function isCashierRole(role?: string | null) {
  return String(role || '').trim().toLowerCase() === 'cashier';
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

export default function CashierPortal() {
  const { user, loading, login, logout, refresh } = useAuth();
  const { company } = useCompany();
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
  const [channel, setChannel] = useState<'gcash' | 'maya' | 'cash'>('gcash');
  const [reference, setReference] = useState('');
  const [merchantId, setMerchantId] = useState('');
  const [merchants, setMerchants] = useState<any[]>([]);
  const [proof, setProof] = useState<string | null>(null);
  const [recent, setRecent] = useState<any[]>([]);
  const [collectBusy, setCollectBusy] = useState(false);

  usePortalInstall(theme);

  const show = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(''), 5000);
  };

  const signedIn = !!user && isCashierRole(user.role);

  useEffect(() => {
    if (!signedIn) return;
    api
      .get('/cashier/me')
      .then((r) => {
        setTheme(r.data.theme === 'orbital' ? 'orbital' : 'matrix');
        setMustChange(!!r.data.mustChangePassword);
      })
      .catch(() => undefined);
    api.get('/cashier/merchants').then((r) => setMerchants(r.data.merchants || [])).catch(() => setMerchants([]));
    api.get('/cashier/recent').then((r) => setRecent(r.data.payments || [])).catch(() => setRecent([]));
  }, [signedIn]);

  useEffect(() => {
    if (!signedIn || q.trim().length < 2) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      api
        .get('/cashier/subscribers', { params: { q: q.trim() } })
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
        show('This cashier account has 2FA enabled — use the staff login page.');
        return;
      }
      await refresh();
      const me = await api.get('/cashier/me').catch(() => null);
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
      const r = await publicApi.post('/public/cashier/forgot-password', {
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
      await api.put('/cashier/theme', { theme: next });
    } catch {
      /* local theme still applies */
    }
  };

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post('/cashier/change-password', {
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
      const r = await api.post('/cashier/collect', {
        userId: selected.id,
        months,
        channel,
        reference,
        merchantId: channel === 'cash' && merchantId ? Number(merchantId) : null,
        proofImage: proof,
      });
      show(
        `Payment posted: ${peso(r.data.amount)} · ${r.data.months}mo for ${selected.username} (logged as ${r.data.cashier})`
      );
      setSelected(null);
      setQ('');
      setHits([]);
      setReference('');
      setProof(null);
      setMonths(1);
      const recentR = await api.get('/cashier/recent');
      setRecent(recentR.data.payments || []);
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

  // Staff (non-cashier) who land here — send to panel
  if (user && !isCashierRole(user.role)) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="subscriber-portal min-h-screen relative text-slate-100">
      <PortalBackdrop theme={theme} />
      <div className="relative z-10 max-w-3xl mx-auto px-4 py-8 space-y-5">
        <header className="portal-glass-strong rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Logo size="sm" variant="dark" />
            <div className="min-w-0">
              <div className="font-bold text-lg truncate">{PRODUCT_TITLE}</div>
              <div className="text-xs text-slate-300/80">Cashier portal · {company?.name || 'Payments'}</div>
            </div>
          </div>
          {signedIn ? (
            <div className="flex flex-wrap items-center gap-2">
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
            </div>
          ) : (
            <Link to="/login" className="text-xs text-slate-300 hover:text-white inline-flex items-center gap-1">
              <ArrowLeft size={12} /> Staff panel
            </Link>
          )}
        </header>

        {toast && (
          <div className="portal-glass rounded-xl px-4 py-3 text-sm text-emerald-100 border border-emerald-400/30">
            {toast}
          </div>
        )}

        {!signedIn && (
          <div className="portal-glass-strong rounded-2xl p-5 space-y-4">
            <div>
              <h1 className="text-xl font-bold">Cashier sign-in</h1>
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
                  Enter the cashier email and the mobile number on file. A temporary password is sent by email and/or SMS.
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
                  Search a subscriber, upload proof, and post payment. Service is activated the same way as Payment Links approval.
                  Payments are logged under <b>{user?.username}</b>.
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
                  <div className="flex flex-wrap gap-2">
                    {(['gcash', 'maya', 'cash'] as const).map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold uppercase ${
                          channel === c ? 'bg-emerald-500/30 ring-1 ring-emerald-300/50' : 'bg-white/5'
                        }`}
                        onClick={() => setChannel(c)}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                  {channel === 'cash' && merchants.length > 0 && (
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
                      {channel === 'cash' ? 'Note / receipt ref (optional)' : 'Reference number'}
                    </span>
                    <input
                      className="input mt-1 bg-black/30 border-white/10 text-white"
                      value={reference}
                      onChange={(e) => setReference(e.target.value)}
                      required={channel !== 'cash'}
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="text-xs text-slate-400">
                      Proof screenshot {channel === 'cash' ? '(optional)' : '(required)'}
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

            <div className="portal-glass rounded-2xl p-4">
              <div className="font-semibold text-sm mb-2">Your recent payments</div>
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
    </div>
  );
}
