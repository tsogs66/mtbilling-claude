import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useSearchParams } from 'react-router-dom';
import {
  LogOut, Search, Upload, CheckCircle2, Loader2, Palette, KeyRound, Wallet, ArrowLeft, Send,
  Download, Share, X, CloudOff, ArrowRightLeft, Ban,
} from 'lucide-react';
import { api, publicApi, peso } from '../api';
import { useAuth } from '../context/AuthContext';
import { useCompany } from '../context/CompanyContext';
import Logo from '../components/Logo';
import QrphLogo from '../components/QrphLogo';
import { MatrixRain } from '../components/portal/MatrixRain';
import { OrbitalNetwork } from '../components/themes/OrbitalNetwork';
import { usePortalInstall, type PortalThemeId } from '../lib/portalInstall';
import {
  enqueue as enqueueOffline,
  listPending,
  flush as flushOfflineQueue,
  isNetworkFailure,
} from '../lib/merchantOfflineQueue';

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
  const [searchParams, setSearchParams] = useSearchParams();
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
  const [collectionType, setCollectionType] = useState<'cash' | 'online' | 'paymongo'>('cash');
  const [channel, setChannel] = useState<'gcash' | 'maya' | 'cash'>('cash');
  const [reference, setReference] = useState('');
  const [merchantId, setMerchantId] = useState('');
  const [merchants, setMerchants] = useState<any[]>([]);
  const [proof, setProof] = useState<string | null>(null);
  const [recent, setRecent] = useState<any[]>([]);
  const [collectBusy, setCollectBusy] = useState(false);
  const [paymongoEnabled, setPaymongoEnabled] = useState(false);
  const [paymongoBusy, setPaymongoBusy] = useState(false);
  const [openCollectibles, setOpenCollectibles] = useState<any[]>([]);
  const [depositSummary, setDepositSummary] = useState<any>(null);
  const [selectedCollectibleIds, setSelectedCollectibleIds] = useState<Set<number>>(new Set());
  const [depositNote, setDepositNote] = useState('');
  const [depositProof, setDepositProof] = useState<string | null>(null);
  const [depositBusy, setDepositBusy] = useState(false);
  const [myDeposits, setMyDeposits] = useState<any[]>([]);
  const [offlinePending, setOfflinePending] = useState(0);
  const [reassignId, setReassignId] = useState<number | null>(null);
  const [reassignQ, setReassignQ] = useState('');
  const [reassignHits, setReassignHits] = useState<any[]>([]);
  const [reassignBusy, setReassignBusy] = useState(false);
  const [cancelBusyId, setCancelBusyId] = useState<number | null>(null);
  /** In-app confirm — window.confirm is unreliable on iOS Safari / Home Screen PWAs. */
  const [actionConfirm, setActionConfirm] = useState<null | {
    title: string;
    body: string;
    confirmLabel: string;
    danger?: boolean;
    run: () => Promise<void>;
  }>(null);

  const { showInstallButton, installed, iosHint, dismissIosHint, install } = usePortalInstall(theme, 'merchant');

  const show = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(''), 5000);
  };

  const signedIn = !!user && isMerchantPartnerRole(user.role);

  const refreshOfflineCount = async () => {
    try {
      const pending = await listPending();
      setOfflinePending(pending.length);
    } catch {
      setOfflinePending(0);
    }
  };

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

  const tryFlushOffline = async () => {
    if (!signedIn || (typeof navigator !== 'undefined' && !navigator.onLine)) return;
    try {
      const result = await flushOfflineQueue(api);
      await refreshOfflineCount();
      if (result.synced > 0) {
        show(`Synced ${result.synced} offline payment(s)`);
        await loadCollectibles();
        const recentR = await api.get('/merchant/recent').catch(() => null);
        if (recentR?.data?.payments) setRecent(recentR.data.payments);
      }
    } catch {
      /* keep queue */
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
    api
      .get('/merchant/paymongo/status')
      .then((r) => setPaymongoEnabled(!!r.data?.paymongo))
      .catch(() => setPaymongoEnabled(false));
    void loadCollectibles();
    void refreshOfflineCount();
    void tryFlushOffline();
  }, [signedIn]);

  useEffect(() => {
    const paid = searchParams.get('paid');
    const canceled = searchParams.get('canceled');
    const fromPm = searchParams.get('paymongo');
    const fromRemit = searchParams.get('remit');
    if (fromPm === '1') {
      if (paid === '1') {
        show('PayMongo payment received — subscriber will activate shortly. Online funds settle to the ISP (no remittance).');
        void loadCollectibles();
        api.get('/merchant/recent').then((r) => setRecent(r.data.payments || [])).catch(() => undefined);
      } else if (canceled === '1') {
        show('PayMongo checkout was canceled');
      }
    } else if (fromRemit === '1') {
      if (paid === '1') {
        show('Cash remittance paid via PayMongo — marked collected.');
        void loadCollectibles();
      } else if (canceled === '1') {
        const depositId = Number(searchParams.get('deposit') || 0);
        show('PayMongo remittance canceled — cash items returned to open queue.');
        if (depositId) {
          api
            .post(`/merchant/deposits/${depositId}/cancel-paymongo`)
            .then(() => loadCollectibles())
            .catch(() => loadCollectibles());
        } else {
          void loadCollectibles();
        }
      }
    } else {
      return;
    }
    searchParams.delete('paid');
    searchParams.delete('canceled');
    searchParams.delete('paymongo');
    searchParams.delete('remit');
    searchParams.delete('deposit');
    setSearchParams(searchParams, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    const onOnline = () => {
      void tryFlushOffline();
    };
    window.addEventListener('online', onOnline);
    const interval = window.setInterval(() => {
      void tryFlushOffline();
    }, 30000);
    return () => {
      window.removeEventListener('online', onOnline);
      window.clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  useEffect(() => {
    if (!signedIn || reassignId == null || reassignQ.trim().length < 2) {
      setReassignHits([]);
      return;
    }
    const t = setTimeout(() => {
      api
        .get('/merchant/subscribers', { params: { q: reassignQ.trim() } })
        .then((r) => setReassignHits(r.data.subscribers || []))
        .catch(() => setReassignHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [reassignQ, reassignId, signedIn]);

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
    if (collectionType === 'paymongo') {
      await startPaymongo();
      return;
    }
    setCollectBusy(true);
    const payload = {
      userId: selected.id,
      months,
      collectionType: collectionType === 'online' ? 'online' : 'cash',
      channel: collectionType === 'cash' ? 'cash' : channel,
      reference,
      merchantId: collectionType === 'cash' && merchantId ? Number(merchantId) : null,
      proofImage: proof,
    };
    try {
      const r = await api.post('/merchant/collect', payload);
      show(
        collectionType === 'online'
          ? `Payment posted (online): ${peso(r.data.amount)} · ${r.data.months}mo for ${selected.username}. Subscriber activated — SMS sent if phone is on file. Online funds settle to the ISP (no remittance).`
          : `Payment posted (cash): ${peso(r.data.amount)} · ${r.data.months}mo for ${selected.username}. Subscriber activated — SMS sent if phone is on file. Queued for cash remittance.`
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
      if (isNetworkFailure(err)) {
        await enqueueOffline({ type: 'collect', payload });
        await refreshOfflineCount();
        show('Saved offline — will sync when online');
        setSelected(null);
        setQ('');
        setHits([]);
        setReference('');
        setProof(null);
        setMonths(1);
      } else {
        show(err?.response?.data?.error || 'Payment failed');
      }
    } finally {
      setCollectBusy(false);
    }
  };

  const startPaymongo = async () => {
    if (!selected) return;
    setPaymongoBusy(true);
    try {
      const r = await api.post('/merchant/collect/paymongo', {
        userId: selected.id,
        months,
      });
      const url = r.data?.checkoutUrl;
      if (!url) throw new Error('No checkout URL returned');
      show(`Opening PayMongo for ${selected.username} · ${peso(r.data.amount)}…`);
      window.location.href = url;
    } catch (err: any) {
      show(err?.response?.data?.error || err?.message || 'Could not start PayMongo');
      setPaymongoBusy(false);
    }
  };

  const confirmReassign = (payment: any, target: any) => {
    if (!payment?.id || !target?.id) return;
    if (Number(payment.pppoeUserId) === Number(target.id)) {
      show('Select a different subscriber');
      return;
    }
    setActionConfirm({
      title: 'Change subscriber',
      body:
        `Move this payment (${peso(payment.amount)} · ${payment.months || 1} mo) from ${payment.username} to ${target.username}?\n\n` +
        `• ${target.username} gets the due date extension\n` +
        `• ${payment.username} due date is reversed`,
      confirmLabel: 'Change subscriber',
      run: async () => {
        setReassignBusy(true);
        try {
          const r = await api.post(`/merchant/payments/${payment.id}/reassign`, { userId: target.id });
          show(
            `Reassigned: ${r.data.from?.username} due → ${String(r.data.from?.subscriptionDue || '').slice(0, 10)}; ` +
              `${r.data.to?.username} due → ${String(r.data.to?.subscriptionDue || '').slice(0, 10)}`
          );
          setReassignId(null);
          setReassignQ('');
          setReassignHits([]);
          const recentR = await api.get('/merchant/recent');
          setRecent(recentR.data.payments || []);
        } catch (err: any) {
          show(err?.response?.data?.error || 'Reassign failed');
        } finally {
          setReassignBusy(false);
        }
      },
    });
  };

  const confirmCancelCash = (payment: any) => {
    if (!payment?.id) return;
    if (String(payment.payChannel || '').toLowerCase() !== 'cash') {
      show('Only cash payments can be cancelled');
      return;
    }
    setActionConfirm({
      title: 'Cancel cash payment',
      body:
        `Cancel this cash payment for ${payment.username} (${peso(payment.amount)} · ${payment.months || 1} mo)?\n\n` +
        `• Due date will be reversed\n` +
        `• Subscriber will get an SMS if a phone is on file\n` +
        `• Remittance queue item will be removed (if still open)`,
      confirmLabel: 'Cancel payment',
      danger: true,
      run: async () => {
        setCancelBusyId(payment.id);
        try {
          const r = await api.post(`/merchant/payments/${payment.id}/cancel`);
          const smsNote = r.data?.sms?.sent
            ? 'SMS sent'
            : `SMS not sent (${r.data?.sms?.detail || 'n/a'})`;
          show(
            `Cancelled ${r.data.username}: due ${String(r.data.previousDue || '').slice(0, 10)} → ${String(r.data.subscriptionDue || '').slice(0, 10)}` +
              (r.data.status ? ` · ${r.data.status}` : '') +
              `. ${smsNote}.`
          );
          if (reassignId === payment.id) {
            setReassignId(null);
            setReassignQ('');
            setReassignHits([]);
          }
          const recentR = await api.get('/merchant/recent');
          setRecent(recentR.data.payments || []);
          await loadCollectibles();
        } catch (err: any) {
          show(err?.response?.data?.error || 'Cancel failed');
        } finally {
          setCancelBusyId(null);
        }
      },
    });
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
            <div className="min-w-0">
              <div className="font-bold text-lg truncate">{company?.name?.trim() || 'Merchant'}</div>
              <div className="text-xs text-slate-300/80 truncate">Merchant Portal</div>
            </div>
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
                {offlinePending > 0 && (
                  <span
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-200 bg-amber-500/20 border border-amber-400/30 rounded-full px-2 py-0.5"
                    title="Pending offline payments"
                  >
                    <CloudOff size={12} />
                    {offlinePending} offline
                  </span>
                )}
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
                  Search a subscriber, then choose <b>cash</b>, <b>online</b> (GCash/Maya proof), or <b>PayMongo</b> (unique QR Ph checkout).
                  Online and PayMongo settle to the ISP immediately (no remittance). Only <b>cash</b> is queued below for remittance — remit with deposit proof or PayMongo.
                  Logged as <b>{user?.username}</b>.
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
                      {(
                        [
                          'cash',
                          'online',
                          ...(paymongoEnabled ? (['paymongo'] as const) : []),
                        ] as const
                      ).map((c) => (
                        <button
                          key={c}
                          type="button"
                          className={`px-3 py-1.5 rounded-lg text-xs font-semibold uppercase inline-flex items-center gap-1.5 ${
                            collectionType === c ? 'bg-emerald-500/30 ring-1 ring-emerald-300/50' : 'bg-white/5'
                          }`}
                          onClick={() => {
                            setCollectionType(c);
                            setChannel(c === 'cash' ? 'cash' : 'gcash');
                          }}
                        >
                          {c === 'paymongo' ? (
                            <>
                              <QrphLogo className="h-5 w-auto" />
                              PayMongo
                            </>
                          ) : (
                            c
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                  {collectionType === 'paymongo' && (
                    <div className="rounded-xl border border-sky-400/30 bg-sky-500/10 px-3 py-2.5 text-sm text-sky-100 space-y-2">
                      <p>
                        Opens a <b>unique PayMongo checkout</b> for <b>{selected.username}</b> (
                        {peso(amountPreview)} · {months} mo). Subscriber pays via QR Ph / GCash / Maya. Account
                        activates on success; SMS confirmation is sent. Funds settle online — <b>no remittance</b>.
                      </p>
                      <button
                        type="button"
                        className="w-full inline-flex items-center justify-center gap-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold text-sm px-4 py-3.5 shadow-lg shadow-sky-600/25 transition disabled:opacity-60"
                        disabled={paymongoBusy}
                        onClick={() => void startPaymongo()}
                      >
                        {paymongoBusy ? (
                          <Loader2 className="animate-spin" size={18} />
                        ) : (
                          <QrphLogo className="h-9 w-auto shrink-0" />
                        )}
                        {paymongoBusy ? 'Opening PayMongo…' : 'Pay Online'}
                      </button>
                    </div>
                  )}
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
                  {collectionType !== 'paymongo' && (
                    <>
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
                    </>
                  )}
                </form>
              )}
            </div>

            <div className="portal-glass-strong rounded-2xl p-4 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-semibold text-sm">Open cash remittances</div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Only cash collections appear here. Online / PayMongo subscriber payments settle to the ISP and are not queued.
                    Select one or more, then remit with deposit proof or PayMongo.
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
                <div className="text-xs text-slate-400 py-3 text-center">No open cash remittances.</div>
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
                        const payload = {
                          collectibleIds: [...selectedCollectibleIds],
                          note: depositNote,
                          proofImage: depositProof,
                        };
                        try {
                          const r = await api.post('/merchant/deposits', payload);
                          show(
                            `Submitted ${r.data.deposit.itemCount} payment(s) · ${peso(r.data.deposit.amountTotal)} for admin acceptance`
                          );
                          setDepositNote('');
                          setDepositProof(null);
                          await loadCollectibles();
                        } catch (err: any) {
                          if (isNetworkFailure(err)) {
                            await enqueueOffline({ type: 'deposit', payload });
                            await refreshOfflineCount();
                            show('Saved offline — will sync when online');
                            setDepositNote('');
                            setDepositProof(null);
                            setSelectedCollectibleIds(new Set());
                          } else {
                            show(err?.response?.data?.error || 'Submit failed');
                          }
                        } finally {
                          setDepositBusy(false);
                        }
                      }}
                    >
                      {depositBusy ? <Loader2 className="animate-spin" size={16} /> : <Send size={16} />}
                      {depositBusy
                        ? 'Submitting…'
                        : `Submit ${selectedCollectibleIds.size || ''} cash payment(s) to admin`}
                    </button>
                    {paymongoEnabled && (
                      <button
                        type="button"
                        className="w-full inline-flex items-center justify-center gap-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold text-sm px-4 py-3 shadow-lg shadow-sky-600/25 transition disabled:opacity-60"
                        disabled={depositBusy || selectedCollectibleIds.size === 0}
                        onClick={async () => {
                          setDepositBusy(true);
                          try {
                            const r = await api.post('/merchant/deposits/paymongo', {
                              collectibleIds: [...selectedCollectibleIds],
                              note: depositNote || undefined,
                            });
                            const url = r.data?.checkoutUrl;
                            if (!url) throw new Error('No checkout URL');
                            show('Opening PayMongo to remit cash collections…');
                            window.location.href = url;
                          } catch (err: any) {
                            show(err?.response?.data?.error || err?.message || 'PayMongo remittance failed');
                            setDepositBusy(false);
                          }
                        }}
                      >
                        {depositBusy ? (
                          <Loader2 className="animate-spin" size={18} />
                        ) : (
                          <QrphLogo className="h-8 w-auto shrink-0" />
                        )}
                        {depositBusy
                          ? 'Opening PayMongo…'
                          : `Remit ${selectedCollectibleIds.size || ''} via PayMongo`}
                      </button>
                    )}
                  </div>
                </>
              )}

              {myDeposits.filter((d) => d.status === 'pending' || d.status === 'awaiting_payment').length > 0 && (
                <div className="border-t border-white/10 pt-3">
                  <div className="text-xs font-semibold text-slate-300 mb-1">Pending remittances</div>
                  <ul className="text-xs space-y-1">
                    {myDeposits
                      .filter((d) => d.status === 'pending' || d.status === 'awaiting_payment')
                      .slice(0, 8)
                      .map((d) => (
                        <li key={d.id} className="flex justify-between gap-2 text-slate-400">
                          <span>
                            #{d.id} · {d.mode} · {d.itemCount} item(s)
                            {d.payChannel === 'paymongo' || d.status === 'awaiting_payment'
                              ? ' · PayMongo'
                              : ' · admin'}
                          </span>
                          <span className="text-amber-200">{peso(d.amountTotal)}</span>
                        </li>
                      ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="portal-glass rounded-2xl p-4">
              <div className="font-semibold text-sm mb-1">Your recent activations</div>
              <p className="text-xs text-slate-400 mb-2">
                Wrong subscriber? Use <b>Change subscriber</b>. Cash payments can also be <b>cancelled</b> (due date reversed + SMS).
              </p>
              {recent.length === 0 ? (
                <div className="text-xs text-slate-400 py-3 text-center">No payments posted yet.</div>
              ) : (
                <ul className="divide-y divide-white/5 text-sm">
                  {recent.map((p) => {
                    const isCash = String(p.payChannel || '').toLowerCase() === 'cash';
                    const busy = reassignBusy || cancelBusyId === p.id;
                    return (
                    <li key={p.id} className="py-2 space-y-2">
                      <div className="flex justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium truncate">{p.username}</div>
                          <div className="text-xs text-slate-400 truncate">
                            {p.customer} · {String(p.payChannel || '').toUpperCase()} · {p.externalRef || '—'}
                            {p.months ? ` · ${p.months}mo` : ''}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="font-semibold">{peso(p.amount)}</div>
                          <div className="text-[11px] text-slate-400">
                            {String(p.paidAt || '').slice(0, 16).replace('T', ' ')}
                          </div>
                          <div className="mt-1 flex flex-col items-end gap-0.5">
                            <button
                              type="button"
                              className="text-[11px] text-sky-300 hover:text-sky-200 inline-flex items-center gap-1"
                              disabled={busy}
                              onClick={() => {
                                if (reassignId === p.id) {
                                  setReassignId(null);
                                  setReassignQ('');
                                  setReassignHits([]);
                                } else {
                                  setReassignId(p.id);
                                  setReassignQ('');
                                  setReassignHits([]);
                                }
                              }}
                            >
                              <ArrowRightLeft size={12} />
                              {reassignId === p.id ? 'Close' : 'Change subscriber'}
                            </button>
                            {isCash && (
                              <button
                                type="button"
                                className="text-[11px] text-rose-300 hover:text-rose-200 inline-flex items-center gap-1"
                                disabled={busy}
                                onClick={() => void confirmCancelCash(p)}
                              >
                                {cancelBusyId === p.id ? (
                                  <Loader2 className="animate-spin" size={12} />
                                ) : (
                                  <Ban size={12} />
                                )}
                                {cancelBusyId === p.id ? 'Cancelling…' : 'Cancel payment'}
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                      {reassignId === p.id && (
                        <div className="rounded-xl border border-white/10 bg-black/25 p-2.5 space-y-2">
                          <label className="block">
                            <span className="text-[11px] text-slate-400">Search new subscriber</span>
                            <div className="relative mt-1">
                              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                              <input
                                className="input pl-8 text-sm bg-black/30 border-white/10 text-white"
                                value={reassignQ}
                                onChange={(e) => setReassignQ(e.target.value)}
                                placeholder="Username, customer, account…"
                                autoFocus
                              />
                            </div>
                          </label>
                          {reassignHits.length > 0 && (
                            <ul className="rounded-lg border border-white/10 divide-y divide-white/5 max-h-40 overflow-auto">
                              {reassignHits
                                .filter((s) => Number(s.id) !== Number(p.pppoeUserId))
                                .map((s) => (
                                  <li key={s.id}>
                                    <button
                                      type="button"
                                      className="w-full text-left px-2.5 py-2 hover:bg-white/5 disabled:opacity-50"
                                      disabled={busy}
                                      onClick={() => void confirmReassign(p, s)}
                                    >
                                      <div className="font-medium text-sm">{s.username}</div>
                                      <div className="text-[11px] text-slate-400">
                                        {s.customer} · {s.account} · due{' '}
                                        {String(s.subscriptionDue || '—').slice(0, 10)}
                                      </div>
                                    </button>
                                  </li>
                                ))}
                            </ul>
                          )}
                          {reassignBusy && (
                            <div className="text-xs text-slate-400 inline-flex items-center gap-1">
                              <Loader2 className="animate-spin" size={12} /> Reassigning…
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </>
        )}
      </div>
      {iosHint && <MerchantIosInstallHint onClose={dismissIosHint} />}
      {actionConfirm && (
        <MerchantActionConfirm
          title={actionConfirm.title}
          body={actionConfirm.body}
          confirmLabel={actionConfirm.confirmLabel}
          danger={actionConfirm.danger}
          busy={reassignBusy || cancelBusyId != null}
          onClose={() => {
            if (reassignBusy || cancelBusyId != null) return;
            setActionConfirm(null);
          }}
          onConfirm={async () => {
            const run = actionConfirm.run;
            try {
              await run();
            } finally {
              setActionConfirm(null);
            }
          }}
        />
      )}
    </div>
  );
}

function MerchantActionConfirm({
  title,
  body,
  confirmLabel,
  danger,
  busy,
  onClose,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  const [working, setWorking] = useState(false);
  const locked = busy || working;
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center p-0 sm:p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
        aria-label="Close"
        disabled={locked}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="merchant-action-confirm-title"
        className="relative w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl p-5 sm:p-6 portal-glass-strong border border-white/10 pb-[max(1.25rem,env(safe-area-inset-bottom))]"
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <h3 id="merchant-action-confirm-title" className="text-lg font-bold text-white">
            {title}
          </h3>
          <button
            type="button"
            className="p-2 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white disabled:opacity-50"
            onClick={onClose}
            disabled={locked}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <p className="text-sm text-slate-300/90 whitespace-pre-line leading-relaxed">{body}</p>
        <div className="mt-5 flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
          <button
            type="button"
            className="px-4 py-3 sm:py-2.5 rounded-xl text-sm font-semibold bg-white/10 hover:bg-white/15 text-white disabled:opacity-50"
            onClick={onClose}
            disabled={locked}
          >
            Keep
          </button>
          <button
            type="button"
            className={`px-4 py-3 sm:py-2.5 rounded-xl text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-50 ${
              danger
                ? 'bg-rose-600 hover:bg-rose-500 text-white'
                : 'bg-sky-600 hover:bg-sky-500 text-white'
            }`}
            disabled={locked}
            onClick={() => {
              void (async () => {
                setWorking(true);
                try {
                  await onConfirm();
                } finally {
                  setWorking(false);
                }
              })();
            }}
          >
            {locked ? <Loader2 className="animate-spin" size={16} /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
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
