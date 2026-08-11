import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Globe2, KeyRound, Pencil, Plus, Save, Search, Settings2, Users, ExternalLink, Zap, Check, X,
  Binary, Satellite, Wallet, CalendarClock,
} from 'lucide-react';
import Layout from '../components/Layout';
import { Card, FormField, Modal, ModalFooter, PageHeader, StatusBadge, Toolbar } from '../components/ui';
import { api, peso } from '../api';
import { subscribePortalLive } from '../lib/portalLive';
import { PortalPaymentsPanel } from '../components/portal/PortalPaymentsPanel';

type PortalThemeId = 'matrix' | 'orbital';

type PortalSettings = {
  title: string;
  subtitle: string;
  helpText: string;
  welcomeText: string;
  showBalance: boolean;
  showInvoices: boolean;
  showTickets: boolean;
  showCompany: boolean;
  sessionDays: number;
  /** Manual public portal link for SMS (no https://). Blank = auto-detect. */
  portalLink: string;
  /** Server-computed fallback when portalLink is blank */
  autoPortalLink?: string;
  /** Public /portal appearance */
  theme: PortalThemeId;
};

type PortalAccount = {
  id: number;
  username: string;
  customer_name?: string;
  account_number?: string;
  status?: string;
  contact?: string;
  email?: string;
  profile?: string;
  price?: number;
  portal_enabled: number;
  has_pin: number;
  portal_must_change_password?: number;
  portal_last_login_at?: string | null;
  portal_session_active?: number;
};

function formatPortalLoginAt(raw?: string | null) {
  if (!raw) return 'Never';
  const s = String(raw).replace('T', ' ').slice(0, 16);
  return s || 'Never';
}

const DEFAULT_SETTINGS: PortalSettings = {
  title: 'PANORTH',
  subtitle: 'Internet Solutions',
  helpText:
    'Sign in with your account number and password. First time: use your phone number, then set a new password. Forgot it? Request a temporary password by SMS.',
  welcomeText: '',
  showBalance: true,
  showInvoices: true,
  showTickets: true,
  showCompany: true,
  sessionDays: 7,
  portalLink: '',
  autoPortalLink: '',
  theme: 'matrix',
};

const PORTAL_THEMES: { key: PortalThemeId; label: string; hint: string; Icon: typeof Binary }[] = [
  { key: 'matrix', label: 'Matrix Glass', hint: 'Current portal look · orange glass + matrix rain', Icon: Binary },
  { key: 'orbital', label: 'Orbital Net', hint: 'Satellites & towers · optical signal routing', Icon: Satellite },
];

function PortalRequestsPanel() {
  const [addons, setAddons] = useState<any[]>([]);
  const [reconnects, setReconnects] = useState<any[]>([]);
  const [extensions, setExtensions] = useState<any[]>([]);
  const [referrals, setReferrals] = useState<any[]>([]);
  const [msg, setMsg] = useState('');
  /** Staff may grant fewer days than asked; keyed by request id. */
  const [grantDays, setGrantDays] = useState<Record<number, number>>({});

  const load = () => {
    void api.get('/portal-requests/addons').then((r) => setAddons(r.data.items || [])).catch(() => setAddons([]));
    void api
      .get('/portal-requests/reconnects')
      .then((r) => setReconnects(r.data.items || []))
      .catch(() => setReconnects([]));
    void api
      .get('/portal-requests/extensions')
      .then((r) => setExtensions(r.data.items || []))
      .catch(() => setExtensions([]));
    void api
      .get('/portal-requests/referrals')
      .then((r) => setReferrals(r.data.items || []))
      .catch(() => setReferrals([]));
  };

  useEffect(() => {
    load();
  }, []);

  const decideAddon = async (id: number, decision: 'accept' | 'reject') => {
    await api.post(`/portal-requests/addons/${id}/decide`, { decision });
    setMsg(`Add-on ${decision}ed`);
    load();
  };
  const decideReconnect = async (id: number, decision: 'accept' | 'reject') => {
    await api.post(`/portal-requests/reconnects/${id}/decide`, { decision });
    setMsg(`Reconnect ${decision}ed`);
    load();
  };
  const decideExtension = async (id: number, decision: 'accept' | 'reject', days?: number) => {
    const r = await api.post(`/portal-requests/extensions/${id}/decide`, { decision, days });
    setMsg(
      decision === 'accept'
        ? `Extension granted — ${r.data?.grantedDays} day(s), new due ${r.data?.newDue}`
        : 'Extension rejected'
    );
    load();
  };

  return (
    <div className="space-y-4">
      {msg && (
        <div className="text-sm rounded-lg px-3 py-2 bg-brand-50 text-brand-800 border border-brand-100">{msg}</div>
      )}
      <Card title="Add-on requests" icon={Zap}>
        <ul className="divide-y divide-slate-100">
          {addons.map((a) => (
            <li key={a.id} className="py-2.5 flex flex-wrap items-center gap-2 justify-between">
              <div className="text-sm">
                <div className="font-medium text-slate-800">
                  {a.customerName || 'Subscriber'}{' '}
                  <span className="font-mono text-xs text-slate-400">{a.accountNumber}</span>
                </div>
                <div className="text-xs text-slate-500">
                  {a.addonName} · {peso(a.price)}
                </div>
              </div>
              <div className="flex gap-1">
                <button type="button" className="btn-primary text-xs" onClick={() => void decideAddon(a.id, 'accept')}>
                  <Check size={14} /> Accept
                </button>
                <button type="button" className="btn-secondary text-xs" onClick={() => void decideAddon(a.id, 'reject')}>
                  <X size={14} /> Reject
                </button>
              </div>
            </li>
          ))}
          {!addons.length && <li className="py-6 text-center text-slate-400 text-sm">No pending add-ons.</li>}
        </ul>
      </Card>
      <Card title="Reconnect requests" icon={KeyRound}>
        <ul className="divide-y divide-slate-100">
          {reconnects.map((r) => (
            <li key={r.id} className="py-2.5 flex flex-wrap items-center gap-2 justify-between">
              <div className="text-sm">
                <div className="font-medium text-slate-800">
                  {r.customerName || 'Subscriber'}{' '}
                  <span className="font-mono text-xs text-slate-400">{r.accountNumber}</span>
                </div>
                <div className="text-xs text-slate-500">
                  Status {r.accountStatus || '—'}
                  {r.reason ? ` · ${r.reason}` : ''}
                </div>
              </div>
              <div className="flex gap-1">
                <button
                  type="button"
                  className="btn-primary text-xs"
                  onClick={() => void decideReconnect(r.id, 'accept')}
                >
                  <Check size={14} /> Accept
                </button>
                <button
                  type="button"
                  className="btn-secondary text-xs"
                  onClick={() => void decideReconnect(r.id, 'reject')}
                >
                  <X size={14} /> Reject
                </button>
              </div>
            </li>
          ))}
          {!reconnects.length && (
            <li className="py-6 text-center text-slate-400 text-sm">No pending reconnects.</li>
          )}
        </ul>
      </Card>
      <Card title="Service extension requests" icon={CalendarClock}>
        <ul className="divide-y divide-slate-100">
          {extensions.map((e) => {
            const days = grantDays[e.id] ?? e.daysRequested ?? 3;
            return (
              <li key={e.id} className="py-2.5 flex flex-wrap items-center gap-2 justify-between">
                <div className="text-sm">
                  <div className="font-medium text-slate-800">
                    {e.customerName || 'Subscriber'}{' '}
                    <span className="font-mono text-xs text-slate-400">{e.accountNumber}</span>
                  </div>
                  <div className="text-xs text-slate-500">
                    Asked for {e.daysRequested} day{e.daysRequested === 1 ? '' : 's'} · status{' '}
                    {e.accountStatus || '—'} · due {e.subscriptionDue || '—'}
                    {e.reason ? ` · ${e.reason}` : ''}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <label className="text-xs text-slate-500 flex items-center gap-1">
                    Grant
                    <input
                      type="number"
                      min={1}
                      max={14}
                      className="input w-16 text-xs py-1"
                      value={days}
                      onChange={(ev) =>
                        setGrantDays((g) => ({ ...g, [e.id]: Number(ev.target.value) || 1 }))
                      }
                    />
                    d
                  </label>
                  <button
                    type="button"
                    className="btn-primary text-xs"
                    onClick={() => void decideExtension(e.id, 'accept', days)}
                  >
                    <Check size={14} /> Accept
                  </button>
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    onClick={() => void decideExtension(e.id, 'reject')}
                  >
                    <X size={14} /> Reject
                  </button>
                </div>
              </li>
            );
          })}
          {!extensions.length && (
            <li className="py-6 text-center text-slate-400 text-sm">No pending extensions.</li>
          )}
        </ul>
        <p className="text-xs text-slate-400 pt-2 border-t border-slate-100">
          Accepting moves the subscriber&rsquo;s due date forward, sets the account back to Active,
          and re-arms the router grace/disable schedule against the new date.
        </p>
      </Card>
      <Card title="Referral leads" icon={Users}>
        <ul className="divide-y divide-slate-100">
          {referrals.map((r) => (
            <li key={r.id} className="py-2.5 text-sm">
              <div className="font-medium text-slate-800">
                {r.name} · {r.contact}
              </div>
              <div className="text-xs text-slate-500">
                via {r.referrerName || '—'} ({r.referrerAccount || r.code}) · {r.status}
                {r.address ? ` · ${r.address}` : ''}
              </div>
            </li>
          ))}
          {!referrals.length && <li className="py-6 text-center text-slate-400 text-sm">No referrals yet.</li>}
        </ul>
      </Card>
    </div>
  );
}

export default function PortalAdmin() {
  const [tab, setTab] = useState<'accounts' | 'plans' | 'settings' | 'requests' | 'payments'>(() => {
    try {
      const t = new URLSearchParams(window.location.search).get('tab');
      if (t === 'plans' || t === 'settings' || t === 'accounts' || t === 'requests' || t === 'payments') return t;
    } catch {
      /* ignore */
    }
    return 'accounts';
  });
  const [accounts, setAccounts] = useState<PortalAccount[]>([]);
  const [planRequests, setPlanRequests] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [settings, setSettings] = useState<PortalSettings>(DEFAULT_SETTINGS);
  const [busySettings, setBusySettings] = useState(false);
  const [toast, setToast] = useState('');
  const [edit, setEdit] = useState<Partial<PortalAccount> & { password?: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [liveStatus, setLiveStatus] = useState<'connecting' | 'live' | 'retry'>('connecting');
  const [autoBusy, setAutoBusy] = useState(false);

  const show = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(''), 4000);
  };

  const loadAccounts = () =>
    api
      .get('/client-portal/accounts')
      .then((r) => setAccounts(r.data || []))
      .catch(() => setAccounts([]));

  const loadPlanRequests = () =>
    api
      .get('/client-portal/plan-changes', { params: { status: 'all' } })
      .then((r) => setPlanRequests(r.data.requests || []))
      .catch(() => setPlanRequests([]));

  const loadSettings = () =>
    api
      .get('/client-portal/settings')
      .then((r) => {
        const theme = r.data?.theme === 'orbital' ? 'orbital' : 'matrix';
        setSettings({ ...DEFAULT_SETTINGS, ...r.data, theme });
      })
      .catch(() => undefined);

  useEffect(() => {
    loadAccounts();
    loadSettings();
    loadPlanRequests();
  }, []);

  // Realtime: new/updated portal plan-change requests without refresh.
  useEffect(() => {
    const token = localStorage.getItem('mt_token') || '';
    const stop = subscribePortalLive({
      path: '/client-portal/events',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      onStatus: setLiveStatus,
      onEvent: (event, data) => {
        if (event === 'plan_change' || data?.type === 'plan_change') {
          loadPlanRequests();
          if (data?.action === 'created') {
            show(`New plan-change request${data?.payload?.toPlan ? `: → ${data.payload.toPlan}` : ''}`);
          }
        }
        if (event === 'ticket' || data?.type === 'ticket') {
          // Keep list fresh if staff is watching portal admin; Job Orders also benefits from toast.
          if (data?.action === 'created') {
            show(`New portal support ticket${data?.payload?.number ? ` ${data.payload.number}` : ''}`);
          }
        }
      },
    });
    return stop;
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return accounts.filter((a) => {
      if (filter === 'enabled' && !a.portal_enabled) return false;
      if (filter === 'disabled' && a.portal_enabled) return false;
      if (!needle) return true;
      const hay = [a.username, a.customer_name, a.account_number, a.contact, a.email, a.status]
        .map((x) => String(x || '').toLowerCase())
        .join(' ');
      return hay.includes(needle);
    });
  }, [accounts, q, filter]);

  const enabledCount = accounts.filter((a) => a.portal_enabled).length;

  const saveSettings = async () => {
    setBusySettings(true);
    try {
      const r = await api.put('/client-portal/settings', settings);
      const theme = r.data?.theme === 'orbital' ? 'orbital' : 'matrix';
      setSettings({ ...DEFAULT_SETTINGS, ...r.data, theme });
      show('Portal page settings saved');
    } catch (e: any) {
      show(e?.response?.data?.error || 'Could not save settings');
    } finally {
      setBusySettings(false);
    }
  };

  const saveAccount = async () => {
    if (!edit?.id) return;
    const body: any = {
      customer_name: edit.customer_name,
      account_number: edit.account_number,
      contact: edit.contact,
      email: edit.email,
      portal_enabled: !!edit.portal_enabled,
    };
    if (edit.password && String(edit.password).trim()) body.password = String(edit.password).trim();
    try {
      await api.put(`/client-portal/accounts/${edit.id}`, body);
      setEdit(null);
      show('Portal account updated');
      loadAccounts();
    } catch (e: any) {
      show(e?.response?.data?.error || 'Could not update account');
    }
  };

  const createAccount = async (form: {
    pppoe_user_id: string;
    password: string;
    account_number: string;
    useDefaultPassword: boolean;
  }) => {
    const id = Number(form.pppoe_user_id);
    if (!id) {
      show('Select a subscriber');
      return;
    }
    try {
      await api.put(`/client-portal/accounts/${id}`, {
        portal_enabled: true,
        useDefaultPassword: form.useDefaultPassword,
        ...(form.useDefaultPassword ? {} : { password: form.password }),
        ...(form.account_number.trim() ? { account_number: form.account_number.trim() } : {}),
      });
      setCreateOpen(false);
      show(
        form.useDefaultPassword
          ? 'Portal access enabled — default password is their phone number'
          : 'Portal access enabled'
      );
      loadAccounts();
    } catch (e: any) {
      show(e?.response?.data?.error || 'Could not enable portal');
    }
  };

  const disable = async (id: number) => {
    if (!confirm('Disable portal access and clear password for this subscriber?')) return;
    try {
      await api.post('/client-portal/disable', { pppoe_user_id: id });
      show('Portal disabled');
      loadAccounts();
    } catch (e: any) {
      show(e?.response?.data?.error || 'Failed');
    }
  };

  const resetDefaultPassword = async (id: number) => {
    if (!confirm('Reset portal password to the subscriber’s phone number? They must set a new password on next login.')) {
      return;
    }
    try {
      await api.post(`/client-portal/accounts/${id}/reset-default-password`);
      show('Password reset to phone number');
      loadAccounts();
      setEdit(null);
    } catch (e: any) {
      show(e?.response?.data?.error || 'Could not reset password');
    }
  };

  const autoProvision = async () => {
    if (
      !confirm(
        'Auto-create portal logins for all subscribers with an account number and phone?\n\nUsername = account number\nDefault password = phone number (must change on first login)'
      )
    ) {
      return;
    }
    setAutoBusy(true);
    try {
      const r = await api.post('/client-portal/auto-provision');
      show(`Auto-created ${r.data?.created ?? 0} portal login(s)`);
      loadAccounts();
    } catch (e: any) {
      show(e?.response?.data?.error || 'Auto-create failed');
    } finally {
      setAutoBusy(false);
    }
  };

  const pendingPlans = planRequests.filter((r) => r.status === 'pending').length;

  const acceptPlan = async (id: number) => {
    if (!confirm('Accept this plan change? Prorated balance will replace open invoices.')) return;
    try {
      const r = await api.post(`/client-portal/plan-changes/${id}/accept`, {});
      show(`Plan updated · new balance ${peso(r.data?.proration?.proratedBalance || 0)}`);
      loadPlanRequests();
    } catch (e: any) {
      show(e?.response?.data?.error || 'Accept failed');
    }
  };

  const rejectPlan = async (id: number) => {
    const note = prompt('Reject reason (optional)') || '';
    try {
      await api.post(`/client-portal/plan-changes/${id}/reject`, { note });
      show('Plan change rejected');
      loadPlanRequests();
    } catch (e: any) {
      show(e?.response?.data?.error || 'Reject failed');
    }
  };

  return (
    <Layout title="Subscriber Portal">
      <PageHeader
        title="Subscriber Portal"
        description="Portal logins auto-use account number + phone. Subscribers set their own password after first login."
        icon={Globe2}
      />

      {toast && (
        <div className="mb-4 text-sm rounded-lg px-3 py-2 bg-brand-50 text-brand-800 border border-brand-100">
          {toast}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button
          type="button"
          className={tab === 'accounts' ? 'btn-primary' : 'btn-secondary'}
          onClick={() => setTab('accounts')}
        >
          <Users size={16} /> Accounts
          <span className="ml-1 text-xs opacity-80">({enabledCount}/{accounts.length})</span>
        </button>
        <button
          type="button"
          className={tab === 'plans' ? 'btn-primary' : 'btn-secondary'}
          onClick={() => setTab('plans')}
        >
          <Zap size={16} /> Plan changes
          {pendingPlans > 0 && (
            <span className="ml-1 text-xs opacity-80">({pendingPlans})</span>
          )}
        </button>
        <button
          type="button"
          className={tab === 'requests' ? 'btn-primary' : 'btn-secondary'}
          onClick={() => setTab('requests')}
        >
          <Globe2 size={16} /> Requests
        </button>
        <button
          type="button"
          className={tab === 'payments' ? 'btn-primary' : 'btn-secondary'}
          onClick={() => setTab('payments')}
        >
          <Wallet size={16} /> Payments
        </button>
        <button
          type="button"
          className={tab === 'settings' ? 'btn-primary' : 'btn-secondary'}
          onClick={() => setTab('settings')}
        >
          <Settings2 size={16} /> Portal page
        </button>
        <a
          href="/portal"
          target="_blank"
          rel="noreferrer"
          className="btn-secondary ml-auto"
        >
          <ExternalLink size={16} /> Open /portal
        </a>
        <span
          className={`text-[11px] font-medium px-2 py-1 rounded-full ring-1 ${
            liveStatus === 'live'
              ? 'text-emerald-700 bg-emerald-50 ring-emerald-200'
              : liveStatus === 'retry'
                ? 'text-amber-700 bg-amber-50 ring-amber-200'
                : 'text-slate-500 bg-slate-50 ring-slate-200'
          }`}
          title="Live updates from subscriber portal"
        >
          {liveStatus === 'live' ? '● Live' : liveStatus === 'retry' ? '○ Reconnecting…' : '○ Connecting…'}
        </span>
      </div>

      {tab === 'accounts' && (
        <Card
          title="Portal accounts"
          icon={KeyRound}
          right={
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-secondary" disabled={autoBusy} onClick={() => void autoProvision()}>
                <KeyRound size={16} /> {autoBusy ? 'Creating…' : 'Auto-create all'}
              </button>
              <button type="button" className="btn-primary" onClick={() => setCreateOpen(true)}>
                <Plus size={16} /> Enable access
              </button>
            </div>
          }
        >
          <Toolbar
            left={
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    className="input pl-8 w-56"
                    placeholder="Search name, account, contact…"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                  />
                </div>
                <select className="input w-36" value={filter} onChange={(e) => setFilter(e.target.value as any)}>
                  <option value="all">All</option>
                  <option value="enabled">Portal on</option>
                  <option value="disabled">Portal off</option>
                </select>
              </div>
            }
            right={
              <p className="text-xs text-slate-500 max-w-md text-right">
                Default login: <span className="font-medium text-slate-700">account number</span> +{' '}
                <span className="font-medium text-slate-700">phone</span>. After first login they set a new password.
                Manage contacts in <Link to="/pppoe" className="text-brand-600 hover:underline">PPPoE</Link>.
              </p>
            }
          />

          <div className="overflow-x-auto mt-3">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 bg-slate-50 border-b border-slate-100">
                  <th className="px-3 py-2.5">Subscriber</th>
                  <th className="px-3 py-2.5">Account #</th>
                  <th className="px-3 py-2.5">Contact</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Portal</th>
                  <th className="px-3 py-2.5">Login</th>
                  <th className="px-3 py-2.5">Last logged in</th>
                  <th className="px-3 py-2.5 w-28" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => (
                  <tr key={a.id} className="border-b border-slate-50">
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-slate-800">{a.customer_name || a.username}</div>
                      <div className="text-xs text-slate-400 font-mono">{a.username}</div>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs">{a.account_number || '—'}</td>
                    <td className="px-3 py-2.5 text-slate-600">
                      <div>{a.contact || '—'}</div>
                      {a.email && <div className="text-xs text-slate-400">{a.email}</div>}
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={a.status || '—'} />
                    </td>
                    <td className="px-3 py-2.5">
                      {a.portal_enabled ? (
                        <div className="space-y-1">
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">
                            On{a.has_pin ? '' : ' (no password)'}
                          </span>
                          {!!a.portal_must_change_password && (
                            <div className="text-[11px] text-amber-700">Must change password</div>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400">Off</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {a.portal_enabled ? (
                        a.portal_session_active ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">
                            Logged in
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 bg-slate-100 px-2 py-0.5 rounded">
                            Offline
                          </span>
                        )
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-slate-600 whitespace-nowrap">
                      {formatPortalLoginAt(a.portal_last_login_at)}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap space-x-1">
                      <button
                        type="button"
                        className="btn-ghost"
                        title="Edit"
                        onClick={() => setEdit({ ...a, password: '' })}
                      >
                        <Pencil size={14} />
                      </button>
                      {!!a.portal_enabled && (
                        <button type="button" className="btn-ghost text-rose-600" onClick={() => disable(a.id)}>
                          Disable
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {!filtered.length && (
                  <tr>
                    <td colSpan={8} className="px-3 py-10 text-center text-slate-400">
                      No subscribers match. Enable access for a PPPoE user to create a portal login.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {tab === 'plans' && (
        <Card title="Plan change requests" icon={Zap}>
          <p className="text-sm text-slate-500 mb-3">
            Subscribers request plan changes from <code className="text-brand-600">/portal</code>.
            Accepting applies the new plan and replaces open invoices with a 30-day proration
            (consumed days × old rate + remaining days × new rate).
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 bg-slate-50 border-b border-slate-100">
                  <th className="px-3 py-2.5">Subscriber</th>
                  <th className="px-3 py-2.5">Change</th>
                  <th className="px-3 py-2.5">Proration</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5 w-36" />
                </tr>
              </thead>
              <tbody>
                {planRequests.map((r) => (
                  <tr key={r.id} className="border-b border-slate-50">
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-slate-800">{r.customer_name || r.username || '—'}</div>
                      <div className="text-xs text-slate-400 font-mono">{r.account_number || r.username}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-slate-800">
                        {r.from_plan || '—'} → {r.to_plan}
                      </div>
                      <div className="text-xs text-slate-500">
                        {peso(r.from_price)} → {peso(r.to_price)} · due {r.subscription_due || '—'}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-slate-600">
                      <div className="font-semibold text-slate-800">{peso(r.prorated_balance)}</div>
                      <div className="text-xs">
                        {r.consumed_days}d @ old + {r.remaining_days}d @ new
                      </div>
                    </td>
                    <td className="px-3 py-2.5 capitalize">
                      <StatusBadge status={r.status} />
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        {String(r.created_at || '').replace('T', ' ').slice(0, 16)}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap space-x-1">
                      {r.status === 'pending' && (
                        <>
                          <button type="button" className="btn-primary !px-2 !py-1 text-xs" onClick={() => acceptPlan(r.id)}>
                            <Check size={14} /> Accept
                          </button>
                          <button type="button" className="btn-ghost text-rose-600" onClick={() => rejectPlan(r.id)}>
                            <X size={14} />
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
                {!planRequests.length && (
                  <tr>
                    <td colSpan={5} className="px-3 py-10 text-center text-slate-400">
                      No plan-change requests yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {tab === 'requests' && <PortalRequestsPanel />}

      {tab === 'payments' && <PortalPaymentsPanel onToast={show} />}

      {tab === 'settings' && (
        <Card title="Portal page settings" icon={Settings2}>
          <p className="text-sm text-slate-500 mb-4">
            These appear on the public subscriber login at <code className="text-brand-600">/portal</code>.
            Company name and pay numbers still come from Company settings.
          </p>
          <div className="grid md:grid-cols-2 gap-4">
            <FormField
              label="Portal link"
              hint="Used in SMS / notifications as {portal_url}. Leave blank to auto-detect from Public URL / Cloudflare. Prefer without https://"
            >
              <input
                className="input font-mono text-sm"
                value={settings.portalLink}
                onChange={(e) => setSettings({ ...settings, portalLink: e.target.value })}
                placeholder={settings.autoPortalLink || 'billing.example.com/portal'}
              />
              <p className="text-xs text-slate-400 mt-1">
                Effective link:{' '}
                <code className="text-slate-600">
                  {settings.portalLink?.trim() || settings.autoPortalLink || 'portal'}
                </code>
                {!settings.portalLink?.trim() && settings.autoPortalLink ? ' (auto)' : ''}
              </p>
            </FormField>
            <FormField label="Login title">
              <input
                className="input"
                value={settings.title}
                onChange={(e) => setSettings({ ...settings, title: e.target.value })}
              />
            </FormField>
            <FormField label="Subtitle" hint="Shown under the title (defaults to product name if blank)">
              <input
                className="input"
                value={settings.subtitle}
                onChange={(e) => setSettings({ ...settings, subtitle: e.target.value })}
                placeholder="Optional"
              />
            </FormField>
            <FormField label="Help text under sign-in">
              <input
                className="input"
                value={settings.helpText}
                onChange={(e) => setSettings({ ...settings, helpText: e.target.value })}
              />
            </FormField>
            <FormField label="Session length (days)" hint="1–90">
              <input
                type="number"
                min={1}
                max={90}
                className="input"
                value={settings.sessionDays}
                onChange={(e) => setSettings({ ...settings, sessionDays: Number(e.target.value) || 7 })}
              />
            </FormField>
            <FormField label="Welcome note (after login)">
              <textarea
                className="input min-h-[80px]"
                value={settings.welcomeText}
                onChange={(e) => setSettings({ ...settings, welcomeText: e.target.value })}
                placeholder="Optional message shown on the dashboard"
              />
            </FormField>
            <div className="space-y-2">
              <div className="text-sm font-medium text-slate-700">Dashboard sections</div>
              {(
                [
                  ['showBalance', 'Balance due'],
                  ['showInvoices', 'Statement of account'],
                  ['showTickets', 'Support tickets'],
                  ['showCompany', 'Company / payment contacts'],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={!!settings[key]}
                    onChange={(e) => setSettings({ ...settings, [key]: e.target.checked })}
                  />
                  {label}
                </label>
              ))}
            </div>
            <div className="md:col-span-2 space-y-2">
              <div className="text-sm font-medium text-slate-700">Portal theme</div>
              <p className="text-xs text-slate-500">
                Changes the look of the public subscriber portal at <code className="text-brand-600">/portal</code>.
              </p>
              <div className="grid sm:grid-cols-2 gap-3">
                {PORTAL_THEMES.map(({ key, label, hint, Icon }) => {
                  const active = settings.theme === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setSettings({ ...settings, theme: key })}
                      className={`flex items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition ${
                        active
                          ? 'border-brand-500 bg-brand-50/40 ring-1 ring-brand-400/40'
                          : 'border-slate-200 bg-slate-50/60 hover:border-slate-300 hover:bg-white'
                      }`}
                    >
                      <span
                        className={`mt-0.5 flex h-9 w-9 items-center justify-center rounded-lg shrink-0 ${
                          active ? 'bg-brand-500 text-white' : 'bg-white text-slate-500 border border-slate-200'
                        }`}
                      >
                        <Icon size={18} />
                      </span>
                      <span className="min-w-0">
                        <span className={`block text-sm font-semibold ${active ? 'text-brand-700' : 'text-slate-800'}`}>
                          {label}
                        </span>
                        <span className="block text-xs text-slate-500 mt-0.5 leading-relaxed">{hint}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="mt-4 flex justify-end">
            <button type="button" className="btn-primary" disabled={busySettings} onClick={saveSettings}>
              <Save size={16} /> {busySettings ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </Card>
      )}

      {edit && (
        <Modal
          title="Edit portal account"
          onClose={() => setEdit(null)}
          footer={<ModalFooter onCancel={() => setEdit(null)} onConfirm={saveAccount} confirmLabel="Save" />}
        >
          <div className="space-y-3">
            <p className="text-sm text-slate-500">
              PPPoE user: <span className="font-mono text-slate-700">{edit.username}</span>
            </p>
            <FormField label="Customer name">
              <input
                className="input"
                value={edit.customer_name || ''}
                onChange={(e) => setEdit({ ...edit, customer_name: e.target.value })}
              />
            </FormField>
            <FormField label="Account number" hint="Used to sign in at /portal">
              <input
                className="input"
                value={edit.account_number || ''}
                onChange={(e) => setEdit({ ...edit, account_number: e.target.value })}
              />
            </FormField>
            <FormField label="Contact">
              <input
                className="input"
                value={edit.contact || ''}
                onChange={(e) => setEdit({ ...edit, contact: e.target.value })}
              />
            </FormField>
            <FormField label="Email">
              <input
                className="input"
                type="email"
                value={edit.email || ''}
                onChange={(e) => setEdit({ ...edit, email: e.target.value })}
              />
            </FormField>
            <FormField
              label="New password"
              hint="Leave blank to keep current. Or reset to phone number below."
            >
              <input
                className="input"
                type="password"
                value={edit.password || ''}
                onChange={(e) => setEdit({ ...edit, password: e.target.value })}
                placeholder={edit.has_pin ? '••••••••' : 'Set a password'}
                autoComplete="new-password"
              />
            </FormField>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={!!edit.portal_enabled}
                onChange={(e) => setEdit({ ...edit, portal_enabled: e.target.checked ? 1 : 0 })}
              />
              Portal access enabled
            </label>
            {!!edit.portal_enabled && (
              <button
                type="button"
                className="btn-secondary w-full"
                onClick={() => edit.id && void resetDefaultPassword(edit.id)}
              >
                Reset password to phone number
              </button>
            )}
            {!!edit.portal_must_change_password && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                Subscriber must set a new password on next portal login.
              </p>
            )}
          </div>
        </Modal>
      )}

      {createOpen && (
        <EnablePortalModal
          accounts={accounts}
          onClose={() => setCreateOpen(false)}
          onSave={createAccount}
        />
      )}
    </Layout>
  );
}

function EnablePortalModal({
  accounts,
  onClose,
  onSave,
}: {
  accounts: PortalAccount[];
  onClose: () => void;
  onSave: (form: {
    pppoe_user_id: string;
    password: string;
    account_number: string;
    useDefaultPassword: boolean;
  }) => Promise<void>;
}) {
  const [pppoe_user_id, setId] = useState('');
  const [password, setPassword] = useState('');
  const [account_number, setAccount] = useState('');
  const [useDefaultPassword, setUseDefault] = useState(true);
  const [busy, setBusy] = useState(false);
  const [phonePreview, setPhonePreview] = useState('');

  const candidates = accounts.filter((a) => !a.portal_enabled);

  useEffect(() => {
    const row = accounts.find((a) => String(a.id) === pppoe_user_id);
    if (row) {
      setAccount(row.account_number || '');
      setPhonePreview(String(row.contact || '').trim());
    }
  }, [pppoe_user_id, accounts]);

  const save = async () => {
    setBusy(true);
    try {
      await onSave({ pppoe_user_id, password, account_number, useDefaultPassword });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Enable portal access"
      onClose={onClose}
      footer={<ModalFooter onCancel={onClose} onConfirm={save} busy={busy} confirmLabel="Enable" />}
    >
      <div className="space-y-3">
        <p className="text-sm text-slate-500">
          Default login is <strong>account number</strong> + <strong>phone number</strong>. The subscriber sets a new
          password after first sign-in at <code className="text-brand-600">/portal</code>.
        </p>
        <FormField label="Subscriber" required>
          <select className="input" value={pppoe_user_id} onChange={(e) => setId(e.target.value)}>
            <option value="">Select…</option>
            {(candidates.length ? candidates : accounts).map((s) => (
              <option key={s.id} value={s.id}>
                {s.customer_name || s.username}
                {s.portal_enabled ? ' (already on)' : ''} — {s.account_number || s.username}
                {s.contact ? ` · ${s.contact}` : ' · no phone'}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Account number" hint="Username for /portal">
          <input className="input" value={account_number} onChange={(e) => setAccount(e.target.value)} />
        </FormField>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={useDefaultPassword}
            onChange={(e) => setUseDefault(e.target.checked)}
          />
          Use phone number as default password
        </label>
        {useDefaultPassword ? (
          <p className="text-xs text-slate-600 bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
            Default password:{' '}
            <span className="font-mono font-semibold text-slate-800">{phonePreview || '(add phone/contact first)'}</span>
          </p>
        ) : (
          <FormField label="Custom password" required hint="At least 6 characters">
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </FormField>
        )}
      </div>
    </Modal>
  );
}
