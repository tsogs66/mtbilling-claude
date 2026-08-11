import { useEffect, useMemo, useState } from 'react';
import {
  Bell,
  Wifi,
  Router,
  CalendarClock,
  Gift,
  UserRound,
  History,
  LifeBuoy,
  Share2,
  ShieldAlert,
  ChevronRight,
  ChevronDown,
  CalendarPlus,
  X,
  Loader2,
  CheckCircle2,
} from 'lucide-react';
import { peso } from '../../api';
import { getApiBase } from '../../config';
import { HUAWEI_ONT_GUIDES } from '../../lib/huaweiOntGuides';

const TOKEN_KEY = 'mt_portal_token';

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

function Section({
  title,
  icon: Icon,
  children,
  hint,
}: {
  title: string;
  icon: typeof Bell;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <section className="portal-glass portal-section">
      <h2 className="font-semibold text-white flex items-center gap-2 mb-1 text-base">
        <Icon size={16} className="text-orange-400" /> {title}
      </h2>
      {hint && <p className="text-sm text-portal-muted mb-3 leading-relaxed">{hint}</p>}
      {children}
    </section>
  );
}

/** Body only — the tabbed Billing container supplies the heading. */
export function PortalActivityBody({ refreshKey }: { refreshKey?: number }) {
  const [items, setItems] = useState<any[]>([]);
  const [unread, setUnread] = useState(0);

  const load = () => {
    void portalFetch('/public/portal/activity')
      .then((d) => {
        setItems(d.items || []);
        setUnread(d.unread || 0);
      })
      .catch(() => {});
  };

  useEffect(() => {
    load();
  }, [refreshKey]);

  return (
    <>
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-sm text-portal-muted">
          {unread ? `${unread} unread update${unread === 1 ? '' : 's'}` : 'Payments, tickets, outages, and plan updates.'}
        </p>
        {unread > 0 && (
          <button
            type="button"
            className="text-xs font-semibold text-orange-300 hover:text-orange-200 shrink-0"
            onClick={() => void portalFetch('/public/portal/activity/read', { method: 'POST', body: '{}' }).then(load)}
          >
            Mark all read
          </button>
        )}
      </div>
      <ul className="space-y-2 max-h-80 overflow-y-auto">
        {items.map((it) => (
          <li
            key={it.id}
            className={`rounded-xl border px-3 py-2.5 ${
              it.readAt ? 'border-white/10 bg-white/[0.03]' : 'border-orange-400/30 bg-orange-500/10'
            }`}
          >
            <div className="text-sm font-semibold text-white">{it.title}</div>
            {it.body && <p className="text-xs text-portal-muted mt-0.5 leading-relaxed">{it.body}</p>}
            <div className="text-[11px] text-portal-dim mt-1">
              {String(it.createdAt || '').replace('T', ' ').slice(0, 16)}
            </div>
          </li>
        ))}
        {!items.length && <li className="text-sm text-portal-dim py-2">No activity yet.</li>}
      </ul>
    </>
  );
}

export function PortalOutageNoticesPanel({ refreshKey }: { refreshKey?: number }) {
  const [notices, setNotices] = useState<any[]>([]);
  useEffect(() => {
    void portalFetch('/public/portal/outage-notices')
      .then((d) => setNotices(d.notices || []))
      .catch(() => setNotices([]));
  }, [refreshKey]);
  if (!notices.length) return null;
  return (
    <Section title="Network notices" icon={ShieldAlert} hint="Outage updates for your NAP area.">
      <ul className="space-y-2">
        {notices.slice(0, 5).map((n) => (
          <li key={n.id} className="rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2.5">
            <div className="text-sm font-semibold text-amber-50">{n.title}</div>
            <p className="text-xs text-amber-100/90 mt-0.5 whitespace-pre-wrap">{n.body}</p>
            <div className="text-[11px] text-amber-200/70 mt-1">
              {String(n.sentAt || n.createdAt || '').replace('T', ' ').slice(0, 16)}
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function fmtRate(bps: number): string {
  const b = Number(bps) || 0;
  if (b >= 1_000_000) return `${(b / 1_000_000).toFixed(1)} Mbps`;
  if (b >= 1_000) return `${Math.round(b / 1_000)} kbps`;
  return `${Math.round(b)} bps`;
}

/**
 * Live line vitals, rendered as a strip inside the portal header card rather
 * than as its own section further down the page — an "am I online?" answer is
 * the first thing a subscriber opens the portal for, so it belongs above the
 * fold next to their name.
 */
export function PortalConnectionStrip({ refreshKey }: { refreshKey?: number }) {
  const [conn, setConn] = useState<any>(null);
  useEffect(() => {
    void portalFetch('/public/portal/connection')
      .then(setConn)
      .catch(() => setConn(null));
  }, [refreshKey]);

  if (!conn) return null;
  const online = !!conn.online;

  // Speeds are only meaningful while a session is up; showing "0 bps" on an
  // offline line reads as a fault rather than an absence.
  const cells: { label: string; value: string; mono?: boolean }[] = [];
  if (conn.address) cells.push({ label: 'IP address', value: String(conn.address), mono: true });
  if (conn.uptime) cells.push({ label: 'Uptime', value: String(conn.uptime) });
  if (online) {
    cells.push({ label: 'Download', value: fmtRate(conn.downloadBps) });
    cells.push({ label: 'Upload', value: fmtRate(conn.uploadBps) });
  }

  return (
    <div className="mt-4 rounded-2xl border border-white/12 bg-black/25 px-3.5 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`relative flex h-2.5 w-2.5 shrink-0 rounded-full ${
              online ? 'bg-emerald-400' : 'bg-rose-400'
            }`}
          >
            {online && (
              <span className="absolute inset-0 rounded-full bg-emerald-400 animate-ping opacity-70" />
            )}
          </span>
          <span className="text-[11px] uppercase tracking-[0.14em] font-semibold text-portal-muted leading-none">
            Connection
          </span>
        </div>
        <span
          className={`text-sm font-bold shrink-0 ${online ? 'text-emerald-300' : 'text-rose-300'}`}
        >
          {online ? 'Online' : 'Offline'}
        </span>
      </div>

      {/* Two up on a phone, one row once there is width for it. */}
      {cells.length > 0 && (
        <dl className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-2.5">
          {cells.map((cell) => (
            <div key={cell.label} className="min-w-0">
              <dt className="text-[10px] uppercase tracking-wider text-portal-dim leading-none">
                {cell.label}
              </dt>
              <dd
                className={`mt-1 text-sm font-semibold text-white truncate ${
                  cell.mono ? 'font-mono text-xs' : 'tabular-nums'
                }`}
              >
                {cell.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {conn.nap && (
        <div className="mt-2.5 pt-2.5 border-t border-white/10 text-[11px] text-portal-dim">
          NAP <span className="text-portal-muted font-medium">{conn.nap.name}</span>
          {conn.nap.code ? ` (${conn.nap.code})` : ''}
        </div>
      )}
    </div>
  );
}

export function PortalDeviceHelperPanel() {
  // Starts unset on purpose: showing one model's steps by default reads as
  // "these are your steps", and a subscriber with a different ONT follows them
  // anyway. Nothing is shown until they pick their own.
  const [active, setActive] = useState<string | null>(null);
  const guide = HUAWEI_ONT_GUIDES.find((g) => g.id === active) || null;
  return (
    <Section
      title="Device helper"
      icon={Router}
      hint="Reconnect steps for Huawei ONTs used on our network."
    >
      <p className="text-xs text-portal-dim mb-2">
        Pick the model printed on the sticker underneath your modem.
      </p>
      <div className="flex flex-wrap gap-1.5 mb-3">
        {HUAWEI_ONT_GUIDES.map((g) => (
          <button
            key={g.id}
            type="button"
            onClick={() => setActive((cur) => (cur === g.id ? null : g.id))}
            aria-pressed={active === g.id}
            className={`text-xs px-2.5 py-2 min-h-[36px] rounded-lg border transition ${
              active === g.id
                ? 'bg-orange-500/25 border-orange-400/45 text-orange-100 font-semibold'
                : 'border-white/12 text-portal-muted hover:text-white'
            }`}
          >
            {g.model.replace('Huawei ', '').replace('OptiXstar ', '')}
          </button>
        ))}
      </div>
      {!guide ? (
        <p className="text-sm text-portal-dim">
          Select your router model above to see its reconnect and Wi‑Fi steps.
        </p>
      ) : (
      <>
      <div className="text-sm font-semibold text-white">{guide.model}</div>
      <p className="text-xs text-portal-muted mt-0.5 mb-2">{guide.blurb}</p>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-orange-300/80 mb-1.5">
        Reconnect
      </p>
      <ol className="space-y-1.5 text-sm text-portal-muted list-decimal pl-4">
        {guide.steps.map((s) => (
          <li key={s} className="leading-relaxed">
            {s}
          </li>
        ))}
      </ol>
      <ul className="mt-3 space-y-1 text-xs text-portal-dim">
        {guide.tips.map((t) => (
          <li key={t}>• {t}</li>
        ))}
      </ul>
      {guide.wifiSteps && guide.wifiSteps.length > 0 && (
        <>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-sky-300/90 mt-4 mb-1.5">
            Change Wi‑Fi name & password (2.4G + 5G)
          </p>
          <p className="text-[11px] text-portal-dim mb-2">
            Firmware R022 / R024 — OptiXstar menus match on EG8145X6-10 and EG8041X6-10.
          </p>
          <ol className="space-y-1.5 text-sm text-portal-muted list-decimal pl-4">
            {guide.wifiSteps.map((s) => (
              <li key={s} className="leading-relaxed">
                {s}
              </li>
            ))}
          </ol>
          {guide.wifiTips && guide.wifiTips.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-portal-dim">
              {guide.wifiTips.map((t) => (
                <li key={t}>• {t}</li>
              ))}
            </ul>
          )}
        </>
      )}
      </>
      )}
    </Section>
  );
}

export function PortalRemindersPanel() {
  const [prefs, setPrefs] = useState({
    dueReminderEnabled: true,
    dueReminderDays: 3,
    smsEnabled: true,
    emailEnabled: true,
  });
  const [msg, setMsg] = useState('');
  useEffect(() => {
    void portalFetch('/public/portal/reminders')
      .then((d) => d.prefs && setPrefs(d.prefs))
      .catch(() => {});
  }, []);
  const save = async () => {
    setMsg('');
    try {
      await portalFetch('/public/portal/reminders', {
        method: 'PUT',
        body: JSON.stringify(prefs),
      });
      setMsg('Reminder preferences saved.');
    } catch (e: any) {
      setMsg(e.message || 'Could not save');
    }
  };
  return (
    <Section title="Payment reminders" icon={Bell} hint="Opt in to due-date reminders by SMS/email.">
      <label className="flex items-center gap-2 text-sm text-portal-muted">
        <input
          type="checkbox"
          checked={prefs.dueReminderEnabled}
          onChange={(e) => setPrefs((p) => ({ ...p, dueReminderEnabled: e.target.checked }))}
        />
        Remind me before due date
      </label>
      <label className="block mt-2 text-xs text-portal-dim">
        Days before due
        <input
          type="number"
          min={1}
          max={14}
          className="portal-field mt-1 w-24 px-2 py-1.5"
          value={prefs.dueReminderDays}
          onChange={(e) => setPrefs((p) => ({ ...p, dueReminderDays: Number(e.target.value) || 3 }))}
        />
      </label>
      <div className="flex flex-wrap gap-4 mt-2 text-sm text-portal-muted">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={prefs.smsEnabled}
            onChange={(e) => setPrefs((p) => ({ ...p, smsEnabled: e.target.checked }))}
          />
          SMS
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={prefs.emailEnabled}
            onChange={(e) => setPrefs((p) => ({ ...p, emailEnabled: e.target.checked }))}
          />
          Email
        </label>
      </div>
      <button type="button" className="portal-cta mt-3 rounded-xl px-4 py-2.5 text-sm" onClick={() => void save()}>
        Save preferences
      </button>
      {msg && <p className="text-xs text-portal-muted mt-2">{msg}</p>}
    </Section>
  );
}

export function PortalContactPanel({
  contact,
  email,
  onUpdated,
}: {
  contact?: string | null;
  email?: string | null;
  onUpdated?: () => void;
}) {
  const [channel, setChannel] = useState<'sms' | 'email'>('sms');
  const [target, setTarget] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'edit' | 'code'>('edit');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const request = async () => {
    setBusy(true);
    setMsg('');
    try {
      await portalFetch('/public/portal/contact/request-otp', {
        method: 'POST',
        body: JSON.stringify({ channel, target }),
      });
      setStep('code');
      setMsg('Verification code sent.');
    } catch (e: any) {
      setMsg(e.message || 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setMsg('');
    try {
      await portalFetch('/public/portal/contact/verify', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      setMsg('Contact updated.');
      setStep('edit');
      setCode('');
      onUpdated?.();
    } catch (e: any) {
      setMsg(e.message || 'Failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Update contact" icon={UserRound} hint="Change phone or email with a one-time code.">
      <div className="text-xs text-portal-dim mb-2">
        Current phone: <span className="text-portal-muted">{contact || '—'}</span>
        <br />
        Current email: <span className="text-portal-muted">{email || '—'}</span>
      </div>
      {step === 'edit' ? (
        <>
          <div className="flex gap-2 mb-2">
            <button
              type="button"
              className={`text-xs px-2.5 py-1.5 rounded-lg border ${channel === 'sms' ? 'border-orange-400/50 text-orange-200' : 'border-white/12 text-portal-dim'}`}
              onClick={() => setChannel('sms')}
            >
              Phone
            </button>
            <button
              type="button"
              className={`text-xs px-2.5 py-1.5 rounded-lg border ${channel === 'email' ? 'border-orange-400/50 text-orange-200' : 'border-white/12 text-portal-dim'}`}
              onClick={() => setChannel('email')}
            >
              Email
            </button>
          </div>
          <input
            className="portal-field w-full px-3 py-2.5"
            placeholder={channel === 'sms' ? 'New mobile number' : 'New email'}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          />
          <button
            type="button"
            disabled={busy || !target.trim()}
            className="portal-cta mt-2 rounded-xl px-4 py-2.5 text-sm disabled:opacity-50"
            onClick={() => void request()}
          >
            {busy ? 'Sending…' : 'Send code'}
          </button>
        </>
      ) : (
        <>
          <input
            className="portal-field w-full px-3 py-2.5"
            placeholder="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <div className="flex gap-2 mt-2">
            <button
              type="button"
              disabled={busy || code.length < 4}
              className="portal-cta rounded-xl px-4 py-2.5 text-sm disabled:opacity-50"
              onClick={() => void verify()}
            >
              Verify
            </button>
            <button type="button" className="portal-btn-ghost rounded-xl px-3 py-2 text-sm" onClick={() => setStep('edit')}>
              Back
            </button>
          </div>
        </>
      )}
      {msg && <p className="text-xs text-portal-muted mt-2">{msg}</p>}
    </Section>
  );
}

/** How many payments show before the list has to be expanded. */
const PAYMENT_HISTORY_PREVIEW = 5;

/**
 * Body only — no <Section> wrapper, because this renders inside the portal's
 * tabbed Billing container which supplies its own heading.
 */
export function PortalPaymentHistoryBody() {
  const [rows, setRows] = useState<any[]>([]);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    void portalFetch('/public/portal/payments')
      .then((d) => {
        const tx = (d.transactions || []).map((t: any) => ({
          key: `tx-${t.transactionId}`,
          amount: t.amount,
          method: t.type || 'payment',
          paidAt: t.paidAt,
          transactionId: t.transactionId,
          invoiceNumber: null,
        }));
        const inv = (d.invoicePayments || []).map((p: any) => ({
          key: `ip-${p.id}`,
          amount: p.amount,
          method: p.method || 'payment',
          paidAt: p.paidAt,
          transactionId: p.transactionId,
          invoiceNumber: p.invoiceNumber,
        }));
        const merged = [...tx, ...inv].sort(
          (a, b) => Date.parse(b.paidAt || 0) - Date.parse(a.paidAt || 0)
        );
        setRows(merged.slice(0, 30));
      })
      .catch(() => {});
  }, []);

  const visible = expanded ? rows : rows.slice(0, PAYMENT_HISTORY_PREVIEW);
  const hidden = rows.length - visible.length;

  return (
    <>
      <ul className="space-y-2">
        {visible.map((r) => (
          <li key={r.key} className="flex items-center justify-between gap-2 rounded-xl border border-white/10 px-3 py-2">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-white tabular-nums">{peso(r.amount)}</div>
              <div className="text-[11px] text-portal-dim">
                {String(r.paidAt || '').replace('T', ' ').slice(0, 16)}
                {r.invoiceNumber ? ` · ${r.invoiceNumber}` : ''}
                {r.method ? ` · ${r.method}` : ''}
              </div>
            </div>
          </li>
        ))}
        {!rows.length && <li className="text-sm text-portal-dim">No payments yet.</li>}
      </ul>
      {rows.length > PAYMENT_HISTORY_PREVIEW && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="portal-btn-ghost mt-2 w-full inline-flex items-center justify-center gap-1.5 rounded-lg py-2.5 min-h-[44px] text-sm font-semibold text-portal-muted hover:text-white"
        >
          {expanded ? 'Show less' : `Show all ${rows.length} payments`}
          <ChevronDown
            size={15}
            className={`transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          />
        </button>
      )}
      {hidden > 0 && !expanded && (
        <p className="text-[11px] text-portal-dim mt-1 text-center">{hidden} more not shown</p>
      )}
    </>
  );
}

export function PortalAddonsPanel() {
  const [catalog, setCatalog] = useState<any[]>([]);
  const [pending, setPending] = useState<any[]>([]);
  const [msg, setMsg] = useState('');
  const load = () => {
    void portalFetch('/public/portal/addons')
      .then((d) => {
        setCatalog(d.catalog || []);
        setPending(d.pending || []);
      })
      .catch(() => {});
  };
  useEffect(() => {
    load();
  }, []);
  const request = async (addonId: number) => {
    setMsg('');
    try {
      await portalFetch('/public/portal/addons/request', {
        method: 'POST',
        body: JSON.stringify({ addonId }),
      });
      setMsg('Request sent — awaiting ISP approval.');
      load();
    } catch (e: any) {
      setMsg(e.message || 'Failed');
    }
  };
  return (
    <Section title="Add-ons & promos" icon={Gift} hint="Request extras like static IP or temporary boosts.">
      {pending.length > 0 && (
        <div className="mb-3 rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
          Pending: {pending.map((p) => p.name).join(', ')}
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {catalog.map((a) => (
          <div key={a.id} className="rounded-xl border border-white/12 p-3">
            <div className="font-semibold text-white text-sm">{a.name}</div>
            <p className="text-xs text-portal-dim mt-0.5">{a.description}</p>
            <div className="flex items-center justify-between mt-2">
              <span className="text-sm font-bold text-white">{Number(a.price) > 0 ? peso(a.price) : 'Ask ISP'}</span>
              <button
                type="button"
                className="text-xs font-semibold text-orange-300"
                onClick={() => void request(a.id)}
              >
                Request
              </button>
            </div>
          </div>
        ))}
      </div>
      {msg && <p className="text-xs text-portal-muted mt-2">{msg}</p>}
    </Section>
  );
}

export function PortalReconnectPanel({ status }: { status?: string | null }) {
  const [req, setReq] = useState<any>(null);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState('');
  const st = String(status || '').toLowerCase();
  const eligible = st.includes('non') || st === 'disabled' || st === 'expired' || st === 'suspended';
  useEffect(() => {
    void portalFetch('/public/portal/reconnect-request')
      .then((d) => setReq(d.request))
      .catch(() => {});
  }, []);
  if (!eligible && !(req && req.status === 'pending')) return null;
  const submit = async () => {
    setMsg('');
    try {
      await portalFetch('/public/portal/reconnect-request', {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      setMsg('Request sent.');
      const d = await portalFetch('/public/portal/reconnect-request');
      setReq(d.request);
    } catch (e: any) {
      setMsg(e.message || 'Failed');
    }
  };
  return (
    <Section
      title="Temporary reconnect"
      icon={ShieldAlert}
      hint="Ask for short-term restore while you settle your balance."
    >
      {req?.status === 'pending' ? (
        <p className="text-sm text-amber-100">Pending review{req.reason ? `: ${req.reason}` : ''}.</p>
      ) : (
        <>
          <textarea
            className="portal-field w-full px-3 py-2.5"
            placeholder="Reason (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button type="button" className="portal-cta mt-2 rounded-xl px-4 py-2.5 text-sm" onClick={() => void submit()}>
            Request reconnect
          </button>
        </>
      )}
      {msg && <p className="text-xs text-portal-muted mt-2">{msg}</p>}
    </Section>
  );
}

/**
 * Ask the ISP for more days before the line is cut, or to bring a lapsed line
 * back. Eligibility is decided server-side (lapsed, or inside the pre-due
 * window) and echoed here, so the panel simply hides itself when it does not
 * apply rather than duplicating the rule.
 */
export function PortalExtensionPanel({ refreshKey }: { refreshKey?: number }) {
  const [state, setState] = useState<{
    request: any;
    eligible: boolean;
    daysUntilDue: number | null;
    due: string | null;
    maxDays: number;
  } | null>(null);
  const [days, setDays] = useState(3);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    void portalFetch('/public/portal/extension-request')
      .then((d) => setState(d))
      .catch(() => setState(null));
  };
  useEffect(load, [refreshKey]);

  const pending = state?.request?.status === 'pending';
  if (!state) return null;
  if (!state.eligible && !pending) return null;

  const submit = async () => {
    setMsg('');
    setBusy(true);
    try {
      await portalFetch('/public/portal/extension-request', {
        method: 'POST',
        body: JSON.stringify({ days, reason }),
      });
      setMsg('Request sent — your ISP will review it.');
      load();
    } catch (e: any) {
      setMsg(e.message || 'Could not send request');
    } finally {
      setBusy(false);
    }
  };

  const d = state.daysUntilDue;
  const window =
    d == null
      ? 'Your account is due for renewal.'
      : d < 0
        ? `Your service lapsed ${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} ago.`
        : d === 0
          ? 'Your service is due today.'
          : `Your service is due in ${d} day${d === 1 ? '' : 's'}.`;

  const last = state.request;

  return (
    <Section
      title="Extend my service"
      icon={CalendarPlus}
      hint="Need a few more days before you can pay? Ask your ISP to move your due date."
    >
      <p className="text-sm text-portal-muted mb-3">
        {window}
        {state.due ? <span className="text-portal-dim"> Due date {String(state.due).slice(0, 10)}.</span> : null}
      </p>

      {pending ? (
        <div className="rounded-xl border border-amber-400/30 bg-amber-500/15 px-3 py-2.5 text-sm text-amber-100">
          Pending review — you asked for <b>{last.daysRequested} day{last.daysRequested === 1 ? '' : 's'}</b>
          {last.reason ? `: ${last.reason}` : ''}.
        </div>
      ) : (
        <>
          {last?.status === 'accepted' && (
            <div className="mb-3 rounded-xl border border-emerald-400/30 bg-emerald-500/15 px-3 py-2.5 text-sm text-emerald-100">
              Last request approved — {last.grantedDays} day{last.grantedDays === 1 ? '' : 's'} added
              {last.newDue ? `, new due date ${String(last.newDue).slice(0, 10)}` : ''}.
            </div>
          )}
          {last?.status === 'rejected' && (
            <div className="mb-3 rounded-xl border border-rose-400/30 bg-rose-500/15 px-3 py-2.5 text-sm text-rose-100">
              Last request was declined{last.reviewNote ? `: ${last.reviewNote}` : ''}.
            </div>
          )}
          <label className="block text-xs text-portal-dim mb-2">
            How many extra days?
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {[3, 5, 7, 14]
                .filter((n) => n <= (state.maxDays || 14))
                .map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setDays(n)}
                    className={`text-sm px-3 py-2 min-h-[40px] rounded-lg border transition ${
                      days === n
                        ? 'bg-orange-500/25 border-orange-400/45 text-orange-100 font-semibold'
                        : 'border-white/12 text-portal-muted hover:text-white'
                    }`}
                  >
                    {n} days
                  </button>
                ))}
            </div>
          </label>
          <textarea
            className="portal-field w-full px-3 py-2.5 mt-1"
            placeholder="Reason (optional) — e.g. salary comes in on Friday"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            type="button"
            className="portal-cta mt-2 rounded-xl px-4 py-2.5 text-sm disabled:opacity-50"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? 'Sending…' : `Request ${days} more days`}
          </button>
          <p className="text-[11px] text-portal-dim mt-2 leading-relaxed">
            An extension moves your due date — it does not clear your balance.
          </p>
        </>
      )}
      {msg && <p className="text-xs text-portal-muted mt-2">{msg}</p>}
    </Section>
  );
}

export function PortalVisitsPanel({ openJobs }: { openJobs?: any[] }) {
  const visits = useMemo(
    () =>
      (openJobs || []).filter((j) => j.scheduled_at || j.scheduledAt).sort((a, b) => {
        const ta = Date.parse(a.scheduled_at || a.scheduledAt || 0);
        const tb = Date.parse(b.scheduled_at || b.scheduledAt || 0);
        return ta - tb;
      }),
    [openJobs]
  );
  const [extra, setExtra] = useState<any[]>([]);
  useEffect(() => {
    void portalFetch('/public/portal/visits')
      .then((d) => setExtra(d.visits || []))
      .catch(() => {});
  }, []);
  const list = extra.length ? extra : visits;
  if (!list.length) return null;
  return (
    <Section title="Technician visits" icon={CalendarClock} hint="Scheduled job orders for your account.">
      <ul className="space-y-2">
        {list.map((v: any) => (
          <li key={v.id} className="rounded-xl border border-white/12 px-3 py-2.5 text-sm">
            <div className="font-semibold text-white">{v.number}</div>
            <div className="text-xs text-portal-muted mt-0.5 capitalize">
              {v.type} · {v.status}
              {(v.assignedTo || v.assigned_to) && ` · ${v.assignedTo || v.assigned_to}`}
            </div>
            <div className="text-xs text-orange-300 mt-1 font-medium">
              {(v.scheduledAt || v.scheduled_at || '').replace('T', ' ').slice(0, 16)}
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function PortalReferralPanel() {
  const [code, setCode] = useState('');
  const [leads, setLeads] = useState<any[]>([]);
  const [form, setForm] = useState({ name: '', contact: '', address: '' });
  const [msg, setMsg] = useState('');
  const load = () => {
    void portalFetch('/public/portal/referral')
      .then((d) => {
        setCode(d.code || '');
        setLeads(d.leads || []);
      })
      .catch(() => {});
  };
  useEffect(() => {
    load();
  }, []);
  const submit = async () => {
    setMsg('');
    try {
      await portalFetch('/public/portal/referral', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setForm({ name: '', contact: '', address: '' });
      setMsg('Referral submitted — thank you!');
      load();
    } catch (e: any) {
      setMsg(e.message || 'Failed');
    }
  };
  return (
    <Section title="Refer a neighbor" icon={Share2} hint="Share your code or submit a lead for a new install.">
      {code && (
        <div className="mb-3 rounded-xl border border-white/12 bg-white/[0.04] px-3 py-2 text-sm">
          Your code: <span className="font-mono font-bold text-orange-300">{code}</span>
        </div>
      )}
      <div className="space-y-2">
        <input
          className="portal-field w-full px-3 py-2.5"
          placeholder="Friend’s name"
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
        <input
          className="portal-field w-full px-3 py-2.5"
          placeholder="Mobile number"
          value={form.contact}
          onChange={(e) => setForm((f) => ({ ...f, contact: e.target.value }))}
        />
        <input
          className="portal-field w-full px-3 py-2.5"
          placeholder="Address (optional)"
          value={form.address}
          onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
        />
        <button type="button" className="portal-cta rounded-xl px-4 py-2.5 text-sm" onClick={() => void submit()}>
          Submit referral
        </button>
      </div>
      {msg && <p className="text-xs text-portal-muted mt-2">{msg}</p>}
      {leads.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-portal-dim">
          {leads.slice(0, 5).map((l) => (
            <li key={l.id}>
              {l.name} · {l.status}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function PortalTicketThread({
  jobId,
  onClose,
}: {
  jobId: number;
  onClose: () => void;
}) {
  const [job, setJob] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [body, setBody] = useState('');
  const [fileData, setFileData] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = () => {
    void portalFetch(`/public/portal/tickets/${jobId}/messages`)
      .then((d) => {
        setJob(d.job);
        setMessages(d.messages || []);
      })
      .catch((e) => setErr(e.message));
  };

  useEffect(() => {
    load();
  }, [jobId]);

  const send = async () => {
    setBusy(true);
    setErr('');
    try {
      await portalFetch(`/public/portal/tickets/${jobId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body, attachment: fileData }),
      });
      setBody('');
      setFileData(null);
      load();
    } catch (e: any) {
      setErr(e.message || 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const onFile = (file: File | null) => {
    if (!file) return setFileData(null);
    const reader = new FileReader();
    reader.onload = () => setFileData(String(reader.result || ''));
    reader.readAsDataURL(file);
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center p-0 sm:p-4">
      <button type="button" className="absolute inset-0 bg-black/70" onClick={onClose} aria-label="Close" />
      <div className="portal-modal-panel relative w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl flex flex-col max-h-[90vh]">
        <div className="flex items-start justify-between gap-2 p-4 border-b border-white/10">
          <div>
            <h3 className="font-bold text-white flex items-center gap-2">
              <LifeBuoy size={16} className="text-orange-400" />
              {job?.number || 'Ticket'}
            </h3>
            <p className="text-xs text-portal-dim capitalize mt-0.5">{job?.status}</p>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-portal-dim">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {job?.description && (
            <div className="rounded-xl border border-white/10 px-3 py-2 text-xs text-portal-muted">
              {job.description}
            </div>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              className={`rounded-xl px-3 py-2 text-sm ${
                m.authorRole === 'subscriber'
                  ? 'bg-orange-500/15 border border-orange-400/25 ml-6'
                  : 'bg-white/[0.05] border border-white/10 mr-6'
              }`}
            >
              <div className="text-[11px] text-portal-dim mb-0.5">
                {m.authorName || m.authorRole} · {String(m.createdAt || '').replace('T', ' ').slice(0, 16)}
              </div>
              <div className="text-portal-muted whitespace-pre-wrap">{m.body}</div>
            </div>
          ))}
          {!messages.length && <p className="text-sm text-portal-dim">No replies yet — send a message below.</p>}
        </div>
        <div className="p-4 border-t border-white/10 space-y-2">
          <textarea
            className="portal-field w-full px-3 py-2"
            rows={2}
            placeholder="Write a reply…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <input
            type="file"
            accept="image/*"
            className="text-xs text-portal-dim w-full"
            onChange={(e) => onFile(e.target.files?.[0] || null)}
          />
          {err && <p className="text-xs text-rose-300">{err}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy || !body.trim()}
              className="portal-cta flex-1 rounded-xl py-2.5 text-sm disabled:opacity-50 inline-flex items-center justify-center gap-2"
              onClick={() => void send()}
            >
              {busy ? <Loader2 size={16} className="animate-spin" /> : <ChevronRight size={16} />}
              Send
            </button>
            <button
              type="button"
              className="portal-btn-ghost rounded-xl px-3 py-2 text-xs"
              onClick={() =>
                void portalFetch(`/public/portal/tickets/${jobId}/close`, { method: 'POST', body: '{}' }).then(
                  onClose
                )
              }
            >
              Close ticket
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function PortalPlanCancelButton({
  pending,
  onCancelled,
}: {
  pending: any;
  onCancelled: () => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!pending) return null;
  return (
    <button
      type="button"
      disabled={busy}
      className="mt-2 text-xs font-semibold text-rose-300 hover:text-rose-200"
      onClick={() => {
        setBusy(true);
        void portalFetch('/public/portal/plan-change/cancel', { method: 'POST', body: '{}' })
          .then(onCancelled)
          .catch(() => {})
          .finally(() => setBusy(false));
      }}
    >
      {busy ? 'Cancelling…' : 'Cancel this request'}
    </button>
  );
}

export function PortalExtrasStack({
  me,
  refreshKey,
  onReloadMe,
}: {
  me: any;
  refreshKey?: number;
  onReloadMe?: () => void;
}) {
  // Activity, payment history and the statement now live in the tabbed Billing
  // container that ClientPortal renders directly under Change plan, and the
  // connection panel was folded into the header card — so none of the three
  // appear here any more.
  return (
    <>
      <PortalOutageNoticesPanel refreshKey={refreshKey} />
      <PortalExtensionPanel refreshKey={refreshKey} />
      <PortalReconnectPanel status={me?.customer?.status} />
      <PortalVisitsPanel openJobs={me?.openJobs} />
      <PortalRemindersPanel />
      <PortalContactPanel
        contact={me?.customer?.contact}
        email={me?.customer?.email}
        onUpdated={onReloadMe}
      />
      <PortalDeviceHelperPanel />
      <PortalReferralPanel />
      <p className="text-[11px] text-portal-dim text-center flex items-center justify-center gap-1 py-1">
        <CheckCircle2 size={12} className="text-emerald-400" /> Self-service tools for your PANORTH account
      </p>
    </>
  );
}
