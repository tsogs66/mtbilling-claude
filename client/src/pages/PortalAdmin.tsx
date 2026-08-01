import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Globe2, KeyRound, Pencil, Plus, Save, Search, Settings2, Users, ExternalLink, Zap, Check, X,
} from 'lucide-react';
import Layout from '../components/Layout';
import { Card, FormField, Modal, ModalFooter, PageHeader, StatusBadge, Toolbar } from '../components/ui';
import { api, peso } from '../api';

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
};

const DEFAULT_SETTINGS: PortalSettings = {
  title: 'Subscriber Portal',
  subtitle: '',
  helpText: 'Ask your ISP for portal access (account + PIN).',
  welcomeText: '',
  showBalance: true,
  showInvoices: true,
  showTickets: true,
  showCompany: true,
  sessionDays: 7,
};

export default function PortalAdmin() {
  const [tab, setTab] = useState<'accounts' | 'plans' | 'settings'>('accounts');
  const [accounts, setAccounts] = useState<PortalAccount[]>([]);
  const [planRequests, setPlanRequests] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [settings, setSettings] = useState<PortalSettings>(DEFAULT_SETTINGS);
  const [busySettings, setBusySettings] = useState(false);
  const [toast, setToast] = useState('');
  const [edit, setEdit] = useState<Partial<PortalAccount> & { pin?: string } | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

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
      .then((r) => setSettings({ ...DEFAULT_SETTINGS, ...r.data }))
      .catch(() => undefined);

  useEffect(() => {
    loadAccounts();
    loadSettings();
    loadPlanRequests();
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
      setSettings({ ...DEFAULT_SETTINGS, ...r.data });
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
    if (edit.pin && String(edit.pin).trim()) body.pin = String(edit.pin).trim();
    try {
      await api.put(`/client-portal/accounts/${edit.id}`, body);
      setEdit(null);
      show('Portal account updated');
      loadAccounts();
    } catch (e: any) {
      show(e?.response?.data?.error || 'Could not update account');
    }
  };

  const createAccount = async (form: { pppoe_user_id: string; pin: string; account_number: string }) => {
    const id = Number(form.pppoe_user_id);
    if (!id || !/^\d{4,8}$/.test(form.pin)) {
      show('Select a subscriber and enter a 4–8 digit PIN');
      return;
    }
    try {
      await api.put(`/client-portal/accounts/${id}`, {
        pin: form.pin,
        portal_enabled: true,
        ...(form.account_number.trim() ? { account_number: form.account_number.trim() } : {}),
      });
      setCreateOpen(false);
      show('Portal access enabled');
      loadAccounts();
    } catch (e: any) {
      show(e?.response?.data?.error || 'Could not enable portal');
    }
  };

  const disable = async (id: number) => {
    if (!confirm('Disable portal access and clear PIN for this subscriber?')) return;
    try {
      await api.post('/client-portal/disable', { pppoe_user_id: id });
      show('Portal disabled');
      loadAccounts();
    } catch (e: any) {
      show(e?.response?.data?.error || 'Failed');
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
        description="Create and edit portal logins, set PINs, review plan-change requests, and customize /portal."
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
      </div>

      {tab === 'accounts' && (
        <Card
          title="Portal accounts"
          icon={KeyRound}
          right={
            <button type="button" className="btn-primary" onClick={() => setCreateOpen(true)}>
              <Plus size={16} /> Enable access
            </button>
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
              <p className="text-xs text-slate-500">
                Login uses <span className="font-medium text-slate-700">account number</span> (or PPPoE username) + PIN.
                Manage full subscriber records in{' '}
                <Link to="/pppoe" className="text-brand-600 hover:underline">PPPoE</Link>.
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
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">
                          On{a.has_pin ? '' : ' (no PIN)'}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">Off</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap space-x-1">
                      <button
                        type="button"
                        className="btn-ghost"
                        title="Edit"
                        onClick={() => setEdit({ ...a, pin: '' })}
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
                    <td colSpan={6} className="px-3 py-10 text-center text-slate-400">
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

      {tab === 'settings' && (
        <Card title="Portal page settings" icon={Settings2}>
          <p className="text-sm text-slate-500 mb-4">
            These appear on the public subscriber login at <code className="text-brand-600">/portal</code>.
            Company name and pay numbers still come from Company settings.
          </p>
          <div className="grid md:grid-cols-2 gap-4">
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
            <FormField label="New PIN (4–8 digits)" hint="Leave blank to keep current PIN">
              <input
                className="input"
                inputMode="numeric"
                value={edit.pin || ''}
                onChange={(e) => setEdit({ ...edit, pin: e.target.value })}
                placeholder={edit.has_pin ? '••••' : 'Set a PIN'}
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
  onSave: (form: { pppoe_user_id: string; pin: string; account_number: string }) => Promise<void>;
}) {
  const [pppoe_user_id, setId] = useState('');
  const [pin, setPin] = useState('');
  const [account_number, setAccount] = useState('');
  const [busy, setBusy] = useState(false);

  const candidates = accounts.filter((a) => !a.portal_enabled);

  useEffect(() => {
    const row = accounts.find((a) => String(a.id) === pppoe_user_id);
    if (row) setAccount(row.account_number || '');
  }, [pppoe_user_id, accounts]);

  const save = async () => {
    setBusy(true);
    try {
      await onSave({ pppoe_user_id, pin, account_number });
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
          Share the account number and PIN with the subscriber. They sign in at{' '}
          <code className="text-brand-600">/portal</code>.
        </p>
        <FormField label="Subscriber" required>
          <select className="input" value={pppoe_user_id} onChange={(e) => setId(e.target.value)}>
            <option value="">Select…</option>
            {(candidates.length ? candidates : accounts).map((s) => (
              <option key={s.id} value={s.id}>
                {s.customer_name || s.username}
                {s.portal_enabled ? ' (already on)' : ''} — {s.account_number || s.username}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Account number" hint="Optional override; defaults to current value">
          <input className="input" value={account_number} onChange={(e) => setAccount(e.target.value)} />
        </FormField>
        <FormField label="PIN (4–8 digits)" required>
          <input
            className="input"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            placeholder="1234"
          />
        </FormField>
      </div>
    </Modal>
  );
}
