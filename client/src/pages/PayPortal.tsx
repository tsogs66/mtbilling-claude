import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, Link2, Plus, Trash2, RefreshCw, Globe2, Save, Network, Check, X, ImageIcon, Send, Mail, MessageSquare, Wallet, CreditCard, BarChart3 } from 'lucide-react';
import Layout from '../components/Layout';
import { Card, Toolbar, StatusBadge, IconAction, TabPills, FormField } from '../components/ui';
import { api, peso } from '../api';
import { copyTextOrPrompt } from '../lib/clipboard';

const PAYMONGO_METHODS = ['gcash', 'paymaya', 'qrph'] as const;

const LINK_TTL_DAYS = 15;
const RESEND_WITHIN_DAYS = 10;

/** Open-link statuses: for-approval (submitted) first, then pending, rejected, expired. */
function sortOpenPaymentLinks(rows: any[]) {
  const rank: Record<string, number> = {
    submitted: 0,
    pending: 1,
    rejected: 2,
    expired: 3,
  };
  return [...rows].sort((a, b) => {
    const ra = rank[String(a.status)] ?? 9;
    const rb = rank[String(b.status)] ?? 9;
    if (ra !== rb) return ra - rb;
    return Number(b.id) - Number(a.id);
  });
}

export default function PayPortal() {
  const [links, setLinks] = useState<any[]>([]);
  const [paidLinks, setPaidLinks] = useState<any[]>([]);
  const [linksTab, setLinksTab] = useState<'open' | 'paid'>('open');
  const [clients, setClients] = useState<any[]>([]);
  const [resendClients, setResendClients] = useState<any[]>([]);
  const [userId, setUserId] = useState('');
  const [months, setMonths] = useState(1);
  const [busy, setBusy] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [resendBusy, setResendBusy] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [resendIds, setResendIds] = useState<Set<number>>(new Set());
  const [resendSearch, setResendSearch] = useState('');
  const [toast, setToast] = useState('');
  const [publicBaseUrl, setPublicBaseUrl] = useState('');
  const [effective, setEffective] = useState<string | null>(null);
  const [source, setSource] = useState('none');
  const [warning, setWarning] = useState<string | null>(null);
  const [lanBaseUrl, setLanBaseUrl] = useState<string | null>(null);
  const [lanIp, setLanIp] = useState<string | null>(null);
  const [savingUrl, setSavingUrl] = useState(false);
  const [proofPreview, setProofPreview] = useState<string | null>(null);
  const [cashierDeposits, setCashierDeposits] = useState<any[]>([]);
  const [depositBusyId, setDepositBusyId] = useState<number | null>(null);
  const [depositProofPreview, setDepositProofPreview] = useState<string | null>(null);

  const [paymongoEnabled, setPaymongoEnabled] = useState(false);
  const [paymongoSecret, setPaymongoSecret] = useState('');
  const [paymongoPublic, setPaymongoPublic] = useState('');
  const [paymongoWebhookSecret, setPaymongoWebhookSecret] = useState('');
  const [paymongoSecretSet, setPaymongoSecretSet] = useState(false);
  const [paymongoPublicSet, setPaymongoPublicSet] = useState(false);
  const [paymongoWebhookSet, setPaymongoWebhookSet] = useState(false);
  const [paymongoMethods, setPaymongoMethods] = useState<string[]>(['gcash', 'paymaya', 'qrph']);
  const [paymongoWebhookUrl, setPaymongoWebhookUrl] = useState('');
  const [paymongoBusy, setPaymongoBusy] = useState(false);
  const [settlement, setSettlement] = useState<any>(null);

  const show = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(''), 5000);
  };

  const loadConfig = () =>
    api.get('/payment-links/config').then((r) => {
      setPublicBaseUrl(r.data.publicBaseUrl || '');
      setEffective(r.data.effective || null);
      setSource(r.data.source || 'none');
      setWarning(r.data.warning || null);
      setLanBaseUrl(r.data.lanBaseUrl || null);
      setLanIp(r.data.lanIp || null);
    });

  const load = () => {
    api.get('/payment-links').then((r) => {
      const open = (r.data.links || []).filter((l: any) => l.status !== 'paid');
      const paid =
        r.data.paid ||
        (r.data.links || []).filter((l: any) => l.status === 'paid');
      setLinks(sortOpenPaymentLinks(open));
      setPaidLinks(paid);
      setSelected(new Set());
      if (r.data.effective !== undefined) setEffective(r.data.effective);
      if (r.data.warning !== undefined) setWarning(r.data.warning);
      if (r.data.source) setSource(r.data.source);
    });
    api.get('/clients').then((r) => setClients(r.data || [])).catch(() => setClients([]));
    api
      .get('/payment-links/resend-candidates', { params: { withinDays: RESEND_WITHIN_DAYS } })
      .then((r) => {
        setResendClients(r.data.clients || []);
        setResendIds(new Set());
      })
      .catch(() => setResendClients([]));
    loadConfig().catch(() => undefined);
    api
      .get('/merchant-deposits', { params: { status: 'pending,accepted' } })
      .then((r) => setCashierDeposits(r.data.deposits || []))
      .catch(() => setCashierDeposits([]));
    api
      .get('/paymongo/settings')
      .then((r) => {
        const s = r.data || {};
        setPaymongoEnabled(!!s.enabled);
        setPaymongoMethods(Array.isArray(s.methods) && s.methods.length ? s.methods : ['gcash', 'paymaya', 'qrph']);
        setPaymongoSecretSet(!!s.secretKeySet);
        setPaymongoPublicSet(!!s.publicKeySet);
        setPaymongoWebhookSet(!!s.webhookSecretSet);
        setPaymongoWebhookUrl(s.webhookUrl || '');
        setPaymongoSecret('');
        setPaymongoPublic('');
        setPaymongoWebhookSecret('');
      })
      .catch(() => undefined);
    api
      .get('/merchant-settlement')
      .then((r) => setSettlement(r.data))
      .catch(() => setSettlement(null));
  };

  const savePaymongo = async () => {
    setPaymongoBusy(true);
    try {
      const body: Record<string, unknown> = {
        enabled: paymongoEnabled,
        methods: paymongoMethods,
      };
      if (paymongoSecret.trim()) body.secretKey = paymongoSecret.trim();
      if (paymongoPublic.trim()) body.publicKey = paymongoPublic.trim();
      if (paymongoWebhookSecret.trim()) body.webhookSecret = paymongoWebhookSecret.trim();
      const r = await api.put('/paymongo/settings', body);
      const s = r.data?.settings || r.data || {};
      setPaymongoEnabled(!!s.enabled);
      setPaymongoMethods(Array.isArray(s.methods) && s.methods.length ? s.methods : paymongoMethods);
      setPaymongoSecretSet(!!s.secretKeySet);
      setPaymongoPublicSet(!!s.publicKeySet);
      setPaymongoWebhookSet(!!s.webhookSecretSet);
      setPaymongoSecret('');
      setPaymongoPublic('');
      setPaymongoWebhookSecret('');
      show('PayMongo settings saved');
      const cfg = await api.get('/paymongo/settings').catch(() => null);
      if (cfg?.data?.webhookUrl) setPaymongoWebhookUrl(cfg.data.webhookUrl);
    } catch (e: any) {
      show(e?.response?.data?.error || 'Could not save PayMongo settings');
    } finally {
      setPaymongoBusy(false);
    }
  };

  const togglePaymongoMethod = (m: string) => {
    setPaymongoMethods((prev) => {
      if (prev.includes(m)) return prev.filter((x) => x !== m);
      return [...prev, m];
    });
  };

  useEffect(() => {
    load();
  }, []);

  const visibleLinks = linksTab === 'paid' ? paidLinks : links;
  const awaitingCount = useMemo(
    () => links.filter((l) => l.status === 'submitted').length,
    [links]
  );

  const allSelected = visibleLinks.length > 0 && selected.size === visibleLinks.length;
  const someSelected = selected.size > 0;

  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(visibleLinks.map((l) => Number(l.id))));
  };

  const switchLinksTab = (key: string) => {
    setLinksTab(key === 'paid' ? 'paid' : 'open');
    setSelected(new Set());
  };

  const savePublicUrl = async () => {
    setSavingUrl(true);
    try {
      const r = await api.put('/payment-links/config', { publicBaseUrl: publicBaseUrl.trim() });
      setPublicBaseUrl(r.data.publicBaseUrl || '');
      setEffective(r.data.effective || null);
      setSource(r.data.source || 'none');
      setWarning(r.data.warning || null);
      if (r.data.lanBaseUrl) setLanBaseUrl(r.data.lanBaseUrl);
      show(r.data.effective ? `Public pay URL saved: ${r.data.effective}` : 'Public pay URL cleared');
      load();
    } catch (e: any) {
      show(e?.response?.data?.error || 'Could not save public URL');
    } finally {
      setSavingUrl(false);
    }
  };

  const useLanIp = async () => {
    setSavingUrl(true);
    try {
      const r = await api.post('/payment-links/config/use-lan');
      setPublicBaseUrl(r.data.publicBaseUrl || '');
      setEffective(r.data.effective || r.data.lanBaseUrl || null);
      setSource(r.data.source || 'public_base_url');
      setWarning(r.data.warning || null);
      setLanBaseUrl(r.data.lanBaseUrl || null);
      setLanIp(r.data.lanIp || null);
      show(`Pay links now use LAN IP: ${r.data.publicBaseUrl}`);
      load();
    } catch (e: any) {
      show(e?.response?.data?.error || 'Could not detect LAN IP');
    } finally {
      setSavingUrl(false);
    }
  };

  const resolvePayUrl = (data: { url?: string; path?: string; token?: string }) => {
    if (typeof data.url === 'string' && /^https?:\/\//i.test(data.url)) return data.url;
    const path = data.path || (data.token ? `/pay/${data.token}` : '');
    if (!path) return '';
    const base = effective || window.location.origin;
    return `${base.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
  };

  const create = async () => {
    if (!userId) return;
    setBusy(true);
    try {
      const r = await api.post('/payment-links', {
        userId: Number(userId),
        months,
        ttlHours: LINK_TTL_DAYS * 24,
        fallbackOrigin: window.location.origin,
      });
      const full = resolvePayUrl(r.data);
      if (r.data.warning) show(r.data.warning);
      const ok = full ? await copyTextOrPrompt(full, 'Pay link — copy:') : false;
      show(
        ok
          ? `Pay link created (${LINK_TTL_DAYS} days) and copied: ${full}`
          : full
            ? `Pay link created (${LINK_TTL_DAYS} days): ${full}`
            : 'Pay link created'
      );
      load();
    } catch (e: any) {
      show(e?.response?.data?.error || e?.response?.data?.message || 'Failed');
    } finally {
      setBusy(false);
    }
  };

  const toggleResend = (id: number) => {
    setResendIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const filteredResendClients = useMemo(() => {
    const q = resendSearch.trim().toLowerCase();
    if (!q) return resendClients;
    return resendClients.filter((c: any) => {
      const hay = [c.username, c.customer, c.customer_name, c.account, c.account_number, c.contact, c.email]
        .map((x) => String(x || '').toLowerCase())
        .join(' ');
      return hay.includes(q);
    });
  }, [resendClients, resendSearch]);

  const allResendSelected =
    filteredResendClients.length > 0 &&
    filteredResendClients.every((c: any) => resendIds.has(Number(c.id)));

  const toggleResendAll = () => {
    if (allResendSelected) {
      setResendIds((prev) => {
        const next = new Set(prev);
        filteredResendClients.forEach((c: any) => next.delete(Number(c.id)));
        return next;
      });
    } else {
      setResendIds((prev) => {
        const next = new Set(prev);
        filteredResendClients.forEach((c: any) => next.add(Number(c.id)));
        return next;
      });
    }
  };

  const resendSelected = async (channels: ('email' | 'sms')[] | 'copy') => {
    const ids = [...resendIds];
    if (!ids.length) {
      show('Select one or more near-expiry / expired subscribers.');
      return;
    }
    setResendBusy(true);
    try {
      const r = await api.post('/payment-links/resend', {
        userIds: ids,
        months,
        withinDays: RESEND_WITHIN_DAYS,
        channels: channels === 'copy' ? [] : channels,
        fallbackOrigin: window.location.origin,
      });
      const list = r.data.links || [];
      const skipped = r.data.skipped?.length || 0;
      const lines = list
        .map((l: any) => `${l.username || l.customer || l.account}: ${resolvePayUrl(l)}`)
        .join('\n');
      if (channels === 'copy' && lines) await copyTextOrPrompt(lines, 'Resent pay links — copy:');
      const via =
        channels === 'copy'
          ? 'copied'
          : channels.join('+');
      show(
        `Resent ${list.length} link(s) (${via}) · valid ${LINK_TTL_DAYS} days` +
          (skipped ? ` · skipped ${skipped} (not near expiry)` : '')
      );
      setResendIds(new Set());
      load();
    } catch (e: any) {
      show(e?.response?.data?.error || 'Resend failed');
    } finally {
      setResendBusy(false);
    }
  };

  const resendLabel = useMemo(() => {
    if (!resendClients.length) return 'No near-expiry / expired clients';
    return `${resendClients.length} eligible (expired or ≤${RESEND_WITHIN_DAYS} days)`;
  }, [resendClients.length]);

  const copy = async (link: any) => {
    const full = resolvePayUrl(link);
    if (!full) {
      show('No link to copy');
      return;
    }
    const ok = await copyTextOrPrompt(full, 'Pay link — copy:');
    show(ok ? 'Copied to clipboard' : 'Copy from the dialog, then share with the subscriber');
  };

  const remove = async (id: number) => {
    if (!confirm('Delete this payment link?')) return;
    await api.delete(`/payment-links/${id}`);
    load();
  };

  const bulkDelete = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} selected payment link(s)? This cannot be undone.`)) return;
    setBulkBusy(true);
    try {
      const r = await api.post('/payment-links/bulk-delete', { ids });
      show(`Deleted ${r.data.count} payment link(s).`);
      setSelected(new Set());
      load();
    } catch (e: any) {
      show(e?.response?.data?.error || 'Bulk delete failed');
    } finally {
      setBulkBusy(false);
    }
  };

  const approve = async (id: number) => {
    if (!confirm('Approve this payment and restore the subscriber’s internet?')) return;
    try {
      await api.post(`/payment-links/${id}/approve`);
      show('Payment approved — service restored.');
      load();
    } catch (e: any) {
      show(e?.response?.data?.error || 'Approve failed');
    }
  };

  const reject = async (id: number) => {
    const note = window.prompt('Optional reject note for your records:') || '';
    try {
      await api.post(`/payment-links/${id}/reject`, { note });
      show('Payment proof rejected.');
      load();
    } catch (e: any) {
      show(e?.response?.data?.error || 'Reject failed');
    }
  };

  const openProof = async (link: any) => {
    if (!link.proofUrl && !link.proofImage) {
      show('No screenshot uploaded');
      return;
    }
    try {
      const r = await api.get(`/payment-links/${link.id}/proof`, { responseType: 'blob' });
      const url = URL.createObjectURL(r.data);
      setProofPreview(url);
    } catch {
      show('Could not load screenshot');
    }
  };

  const sourceLabel =
    source === 'public_base_url'
      ? 'saved public URL'
      : source === 'env'
        ? 'PUBLIC_BASE_URL env'
        : source === 'cloudflare'
          ? 'Cloudflare Tunnel'
          : source === 'ngrok'
            ? 'ngrok tunnel'
            : source === 'lan'
              ? 'detected LAN IP'
              : source === 'preferred'
                ? 'panel origin (local)'
                : 'not configured';

  return (
    <Layout title="Payment Links">
      {toast && (
        <div className="mb-4 text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">{toast}</div>
      )}

      <Card className="mb-5">
        <div className="flex items-start gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center shrink-0">
            <Link2 size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-slate-800">Pay portal public base</div>
            <p className="text-sm text-slate-500 mt-0.5">
              Subscriber payment links (Cloudflare Tunnel / public base). Staff admin login stays on the LAN IP — see{' '}
              <Link to="/cloudflare" className="text-brand-600 hover:underline font-medium">
                Cloudflare Tunnel
              </Link>
              .
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 items-center">
          <div className="flex-1 min-w-[240px] input font-mono text-sm bg-slate-50 truncate">
            {effective ? `${String(effective).replace(/\/$/, '')}/pay/` : '(No public URL yet)'}
          </div>
          <button
            type="button"
            className="btn-primary"
            disabled={!effective}
            onClick={async () => {
              const url = `${String(effective).replace(/\/$/, '')}/pay/`;
              const ok = await copyTextOrPrompt(url, 'Pay portal base — copy:');
              show(ok ? 'Pay portal base copied' : 'Copy from the dialog');
            }}
          >
            <Copy size={16} /> Copy pay base
          </button>
        </div>
      </Card>

      <Card className="mb-5">
        <div className="flex items-start gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl bg-sky-50 text-sky-600 flex items-center justify-center shrink-0">
            <Globe2 size={20} />
          </div>
          <div className="min-w-0">
            <div className="font-semibold text-slate-800">Pay portal URL</div>
            <p className="text-sm text-slate-500 mt-0.5">
              For collectors on your LAN/VPN, use this panel’s <span className="font-medium text-slate-700">LAN IP</span>.
              For internet subscribers, use Cloudflare Tunnel or DynDNS.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 items-end">
          <label className="text-sm flex-1 min-w-[240px]">
            <span className="text-xs text-slate-500">Base URL</span>
            <input
              className="input mt-1 font-mono text-sm"
              placeholder={lanBaseUrl || 'http://192.168.x.x'}
              value={publicBaseUrl}
              onChange={(e) => setPublicBaseUrl(e.target.value)}
            />
          </label>
          <button type="button" className="btn-secondary" disabled={savingUrl || !lanBaseUrl} onClick={useLanIp} title={lanBaseUrl || 'No LAN IP detected'}>
            <Network size={16} /> Use LAN IP{lanIp ? ` (${lanIp})` : ''}
          </button>
          <button type="button" className="btn-primary" disabled={savingUrl} onClick={savePublicUrl}>
            <Save size={16} /> Save URL
          </button>
        </div>
        <div className="mt-3 text-xs text-slate-500 space-y-1">
          <div>
            Active base:{' '}
            <span className="font-mono text-slate-700">{effective || '(none — links will use this panel’s address)'}</span>
            {' · '}
            source <span className="font-medium text-slate-700">{sourceLabel}</span>
          </div>
          {lanBaseUrl && (
            <div>
              Detected LAN:{' '}
              <span className="font-mono text-slate-700">{lanBaseUrl}</span>
            </div>
          )}
          {warning && <div className="text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">{warning}</div>}
        </div>
      </Card>

      <Card className="mb-5">
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center shrink-0">
            <CreditCard size={20} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-slate-800">PayMongo (GCash / Maya / QR Ph)</div>
            <p className="text-sm text-slate-500 mt-0.5">
              Hosted checkout for subscriber pay links. Leave secret fields blank to keep the saved value.
            </p>
          </div>
          <label className="inline-flex items-center gap-2 text-sm font-medium text-slate-700 shrink-0">
            <input
              type="checkbox"
              className="rounded border-slate-300"
              checked={paymongoEnabled}
              onChange={(e) => setPaymongoEnabled(e.target.checked)}
            />
            Enabled
          </label>
        </div>
        <div className="grid sm:grid-cols-3 gap-3 mb-3">
          <FormField label={`Secret key${paymongoSecretSet ? ' (saved)' : ''}`}>
            <input
              className="input font-mono text-sm"
              type="password"
              autoComplete="off"
              placeholder={paymongoSecretSet ? '••••••• (leave blank to keep)' : 'sk_live_… or sk_test_…'}
              value={paymongoSecret}
              onChange={(e) => setPaymongoSecret(e.target.value)}
            />
          </FormField>
          <FormField label={`Public key${paymongoPublicSet ? ' (saved)' : ''}`}>
            <input
              className="input font-mono text-sm"
              type="password"
              autoComplete="off"
              placeholder={paymongoPublicSet ? '••••••• (leave blank to keep)' : 'pk_live_… or pk_test_…'}
              value={paymongoPublic}
              onChange={(e) => setPaymongoPublic(e.target.value)}
            />
          </FormField>
          <FormField label={`Webhook secret${paymongoWebhookSet ? ' (saved)' : ''}`}>
            <input
              className="input font-mono text-sm"
              type="password"
              autoComplete="off"
              placeholder={paymongoWebhookSet ? '••••••• (leave blank to keep)' : 'whsk_…'}
              value={paymongoWebhookSecret}
              onChange={(e) => setPaymongoWebhookSecret(e.target.value)}
            />
          </FormField>
        </div>
        <div className="mb-3">
          <div className="text-xs text-slate-500 mb-1.5">Payment methods</div>
          <div className="flex flex-wrap gap-2">
            {PAYMONGO_METHODS.map((m) => (
              <label
                key={m}
                className={`inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border cursor-pointer ${
                  paymongoMethods.includes(m)
                    ? 'bg-indigo-50 border-indigo-200 text-indigo-800'
                    : 'bg-white border-slate-200 text-slate-600'
                }`}
              >
                <input
                  type="checkbox"
                  className="rounded border-slate-300"
                  checked={paymongoMethods.includes(m)}
                  onChange={() => togglePaymongoMethod(m)}
                />
                {m}
              </label>
            ))}
          </div>
          <input
            className="input mt-2 font-mono text-xs"
            placeholder="Or comma list: gcash,paymaya,qrph"
            value={paymongoMethods.join(',')}
            onChange={(e) =>
              setPaymongoMethods(
                e.target.value
                  .split(',')
                  .map((s) => s.trim().toLowerCase())
                  .filter(Boolean)
              )
            }
          />
        </div>
        <div className="flex flex-wrap gap-2 items-end">
          <label className="text-sm flex-1 min-w-[240px]">
            <span className="text-xs text-slate-500">Webhook URL</span>
            <input className="input mt-1 font-mono text-sm bg-slate-50" readOnly value={paymongoWebhookUrl || '—'} />
          </label>
          <button
            type="button"
            className="btn-secondary"
            disabled={!paymongoWebhookUrl}
            onClick={async () => {
              const ok = await copyTextOrPrompt(paymongoWebhookUrl, 'PayMongo webhook URL — copy:');
              show(ok ? 'Webhook URL copied' : 'Copy from the dialog');
            }}
          >
            <Copy size={16} /> Copy
          </button>
          <button type="button" className="btn-primary" disabled={paymongoBusy} onClick={savePaymongo}>
            <Save size={16} /> {paymongoBusy ? 'Saving…' : 'Save PayMongo'}
          </button>
        </div>
      </Card>

      <Card>
        <div className="text-sm text-slate-500 mb-4">
          Subscribers submit GCash, Maya, or Cash proof on the pay page. Items <b>For approval</b> sort to the top of the Links tab — Approve restores internet.
          Paid subscribers are listed under the <b>Paid</b> tab.
          Manage QR photos and cash merchants under{' '}
          <a href="/subscriber-portal?tab=payments" className="text-brand-600 font-semibold hover:underline">
            Subscriber Portal → Payments
          </a>
          .
          New links are valid for <b>{LINK_TTL_DAYS} days</b>.
          Entries tagged <b>Portal</b> were opened by the subscriber (no admin link required).
        </div>
        <div className="flex flex-wrap gap-2 items-end mb-6">
          <label className="text-sm flex-1 min-w-[200px]">
            <span className="text-xs text-slate-500">Subscriber</span>
            <select className="input mt-1" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Select…</option>
              {clients.map((c: any) => (
                <option key={c.id} value={c.id}>
                  {c.username} — {c.customer_name || c.customer || ''}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm w-28">
            <span className="text-xs text-slate-500">Months</span>
            <input type="number" min={1} className="input mt-1" value={months} onChange={(e) => setMonths(Number(e.target.value) || 1)} />
          </label>
          <button type="button" className="btn-primary" disabled={busy || !userId} onClick={create}>
            <Plus size={16} /> Create & copy link
          </button>
          <button type="button" className="btn-secondary" onClick={load}>
            <RefreshCw size={16} /> Refresh
          </button>
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-4 mb-6">
          <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
            <div>
              <div className="font-semibold text-slate-800 text-sm">Resend payment links</div>
              <p className="text-xs text-slate-500 mt-0.5">
                Only <b>expired</b> accounts or those due within <b>{RESEND_WITHIN_DAYS} days</b>. Fresh links last{' '}
                {LINK_TTL_DAYS} days. Send by email and/or SMS, or copy.
              </p>
              <p className="text-xs text-brand-700 mt-1">{resendLabel}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="btn-secondary text-sm"
                disabled={resendBusy || resendIds.size === 0}
                onClick={() => resendSelected('copy')}
              >
                <Copy size={14} /> {resendBusy ? 'Working…' : 'Copy links'}
              </button>
              <button
                type="button"
                className="btn-secondary text-sm"
                disabled={resendBusy || resendIds.size === 0}
                onClick={() => resendSelected(['email'])}
              >
                <Mail size={14} /> Email
              </button>
              <button
                type="button"
                className="btn-secondary text-sm"
                disabled={resendBusy || resendIds.size === 0}
                onClick={() => resendSelected(['sms'])}
              >
                <MessageSquare size={14} /> SMS
              </button>
              <button
                type="button"
                className="btn-primary text-sm"
                disabled={resendBusy || resendIds.size === 0}
                onClick={() => resendSelected(['email', 'sms'])}
              >
                <Send size={14} /> {resendBusy ? 'Sending…' : `Email + SMS (${resendIds.size})`}
              </button>
            </div>
          </div>
          <label className="flex items-center gap-2 px-1 pb-2 text-sm font-medium text-slate-700 cursor-pointer">
            <input
              type="checkbox"
              className="rounded border-slate-300"
              checked={allResendSelected}
              disabled={!filteredResendClients.length}
              onChange={toggleResendAll}
            />
            Select all{resendSearch.trim() ? ' matching' : ' eligible'} clients
            {resendSearch.trim() ? (
              <span className="text-xs font-normal text-slate-400">
                ({filteredResendClients.length} of {resendClients.length})
              </span>
            ) : null}
          </label>
          <div className="mb-2">
            <input
              className="input text-sm"
              value={resendSearch}
              onChange={(e) => setResendSearch(e.target.value)}
              placeholder="Search username, customer, account, mobile…"
              aria-label="Search resend payment links"
            />
          </div>
          <div className="max-h-48 overflow-auto rounded-lg border border-slate-200 bg-white divide-y divide-slate-100">
            {resendClients.length === 0 ? (
              <div className="text-xs text-slate-400 px-3 py-4 text-center">
                No expired or near-expiry (≤{RESEND_WITHIN_DAYS} days) subscribers.
              </div>
            ) : filteredResendClients.length === 0 ? (
              <div className="text-xs text-slate-400 px-3 py-4 text-center">
                No matches for “{resendSearch.trim()}”.
              </div>
            ) : (
              filteredResendClients.map((c: any) => (
                <label key={c.id} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50 cursor-pointer">
                  <input
                    type="checkbox"
                    className="rounded border-slate-300"
                    checked={resendIds.has(Number(c.id))}
                    onChange={() => toggleResend(Number(c.id))}
                  />
                  <span className="font-medium text-slate-800 truncate">{c.username}</span>
                  <span className="text-slate-400 truncate text-xs flex-1">{c.customer || ''}</span>
                  <span
                    className={`text-[11px] shrink-0 ${
                      c.expired || (c.daysUntilDue != null && c.daysUntilDue < 0)
                        ? 'text-rose-600'
                        : 'text-amber-700'
                    }`}
                  >
                    {c.expired || (c.daysUntilDue != null && c.daysUntilDue < 0)
                      ? 'Expired'
                      : c.daysUntilDue === 0
                        ? 'Due today'
                        : `${c.daysUntilDue}d left`}
                    {c.subscriptionDue ? ` · ${String(c.subscriptionDue).slice(0, 10)}` : ''}
                  </span>
                </label>
              ))
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <TabPills
            active={linksTab}
            onChange={switchLinksTab}
            tabs={[
              {
                key: 'open',
                label:
                  awaitingCount > 0
                    ? `Links (${links.length}) · ${awaitingCount} for approval`
                    : `Links (${links.length})`,
              },
              { key: 'paid', label: `Paid (${paidLinks.length})` },
            ]}
          />
        </div>

        <Toolbar
          left={
            <span>
              {linksTab === 'paid' ? 'Paid subscribers' : 'Links'}{' '}
              <span className="font-semibold">{visibleLinks.length}</span>
              {linksTab === 'open' && awaitingCount > 0 ? (
                <span className="text-sky-600"> · {awaitingCount} for approval (top)</span>
              ) : null}
              {someSelected ? <span className="text-slate-400"> · {selected.size} selected</span> : null}
            </span>
          }
          right={
            someSelected ? (
              <button
                type="button"
                className="btn-secondary text-rose-700 border-rose-200 hover:bg-rose-50"
                disabled={bulkBusy}
                onClick={bulkDelete}
              >
                <Trash2 size={16} />
                {bulkBusy ? 'Deleting…' : `Delete selected (${selected.size})`}
              </button>
            ) : null
          }
        />
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b border-slate-100">
                <th className="py-2 pr-2 w-10">
                  <input
                    type="checkbox"
                    className="rounded border-slate-300"
                    checked={allSelected}
                    disabled={!visibleLinks.length}
                    onChange={toggleAll}
                    aria-label={linksTab === 'paid' ? 'Select all paid links' : 'Select all payment links'}
                  />
                </th>
                <th className="py-2">Subscriber</th>
                <th className="py-2">Amount</th>
                <th className="py-2">From</th>
                <th className="py-2">Status</th>
                <th className="py-2">Proof / Ref</th>
                <th className="py-2">{linksTab === 'paid' ? 'Paid' : 'Expires'}</th>
                <th className="py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleLinks.map((l) => (
                <tr key={l.id} className={`border-b border-slate-50 align-top ${selected.has(l.id) ? 'bg-sky-50/40' : ''} ${l.status === 'submitted' ? 'bg-sky-50/30' : ''}`}>
                  <td className="py-2.5 pr-2">
                    <input
                      type="checkbox"
                      className="rounded border-slate-300"
                      checked={selected.has(l.id)}
                      onChange={() => toggleOne(l.id)}
                      aria-label={`Select ${l.username}`}
                    />
                  </td>
                  <td className="py-2.5">
                    <div className="font-semibold">{l.username}</div>
                    <div className="text-xs text-slate-400">{l.customer} · {l.account}</div>
                  </td>
                  <td className="py-2.5">{peso(l.amount)} · {l.months}mo</td>
                  <td className="py-2.5">
                    {String(l.createdBy || l.created_by || 'admin') === 'portal' ? (
                      <span className="inline-flex text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded bg-violet-50 text-violet-700 ring-1 ring-violet-200">
                        Portal
                      </span>
                    ) : String(l.createdBy || l.created_by || '') === 'system' ? (
                      <span className="inline-flex text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded bg-slate-100 text-slate-600 ring-1 ring-slate-200">
                        System
                      </span>
                    ) : String(l.createdBy || l.created_by || '') === 'cashier' ? (
                      <span
                        className="inline-flex text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded bg-amber-50 text-amber-800 ring-1 ring-amber-200"
                        title={l.cashierUsername || ''}
                      >
                        Merchant{l.cashierUsername ? `: ${l.cashierUsername}` : ''}
                      </span>
                    ) : (
                      <span className="inline-flex text-[11px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded bg-sky-50 text-sky-700 ring-1 ring-sky-200">
                        Admin
                      </span>
                    )}
                  </td>
                  <td className="py-2.5">
                    <StatusBadge status={l.status === 'submitted' ? 'For approval' : l.status} />
                  </td>
                  <td className="py-2.5 text-xs text-slate-600 min-w-[140px]">
                    {l.payChannel || l.externalRef || l.proofImage ? (
                      <div className="space-y-0.5">
                        {l.payChannel && (
                          <div className="uppercase font-semibold text-slate-700">
                            {l.payChannel}
                            {l.merchantName ? ` · ${l.merchantName}` : ''}
                          </div>
                        )}
                        {l.externalRef && <div className="font-mono text-[11px] break-all">{l.externalRef}</div>}
                        {l.submittedAt && <div className="text-slate-400">{String(l.submittedAt).slice(0, 16).replace('T', ' ')}</div>}
                        {(l.proofImage || l.proofUrl) && (
                          <button type="button" className="inline-flex items-center gap-1 text-sky-600 hover:underline" onClick={() => openProof(l)}>
                            <ImageIcon size={12} /> Screenshot
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="py-2.5 text-xs text-slate-500">
                    {linksTab === 'paid'
                      ? String(l.paidAt || l.paid_at || l.reviewedAt || '').slice(0, 16).replace('T', ' ')
                      : String(l.expiresAt || l.expires_at || '').slice(0, 16).replace('T', ' ')}
                  </td>
                  <td className="py-2.5">
                    <div className="flex justify-end gap-1 flex-wrap">
                      {(l.status === 'submitted' || l.status === 'rejected') && (
                        <IconAction icon={Check} title="Approve & restore" tone="emerald" onClick={() => approve(l.id)} />
                      )}
                      {l.status === 'submitted' && (
                        <IconAction icon={X} title="Reject" tone="rose" onClick={() => reject(l.id)} />
                      )}
                      <IconAction icon={Copy} title="Copy link" tone="sky" onClick={() => copy(l)} />
                      <IconAction
                        icon={Link2}
                        title="Open"
                        tone="emerald"
                        onClick={() => window.open(resolvePayUrl(l) || `/pay/${l.token}`, '_blank')}
                      />
                      <IconAction icon={Trash2} title="Delete" tone="rose" onClick={() => remove(l.id)} />
                    </div>
                  </td>
                </tr>
              ))}
              {visibleLinks.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-slate-400">
                    {linksTab === 'paid' ? 'No paid subscribers yet.' : 'No open payment links.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
          <div>
            <div className="font-semibold text-slate-800 inline-flex items-center gap-2">
              <Wallet size={18} className="text-amber-600" /> Merchant deposits
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Merchant partners activate subscribers immediately. Accept a deposit when the merchant remits collections (single or bulk) with optional proof.
            </p>
          </div>
          <button type="button" className="btn-secondary text-sm" onClick={load}>
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
        <div className="overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b border-slate-100">
                <th className="py-2">Deposit</th>
                <th className="py-2">Merchant</th>
                <th className="py-2">Mode</th>
                <th className="py-2">Items</th>
                <th className="py-2">Amount</th>
                <th className="py-2">Status</th>
                <th className="py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {cashierDeposits.map((d) => (
                <tr key={d.id} className="border-b border-slate-50 align-top">
                  <td className="py-2.5">
                    <div className="font-semibold">#{d.id}</div>
                    <div className="text-[11px] text-slate-400">
                      {String(d.createdAt || '').slice(0, 16).replace('T', ' ')}
                    </div>
                    {d.note && <div className="text-xs text-slate-500 mt-0.5">{d.note}</div>}
                  </td>
                  <td className="py-2.5 text-xs font-mono">{d.cashierUsername}</td>
                  <td className="py-2.5 capitalize text-xs">{d.mode}</td>
                  <td className="py-2.5">{d.itemCount}</td>
                  <td className="py-2.5 font-semibold">{peso(d.amountTotal)}</td>
                  <td className="py-2.5">
                    <StatusBadge status={d.status === 'pending' ? 'For approval' : d.status} />
                  </td>
                  <td className="py-2.5">
                    <div className="flex justify-end gap-1 flex-wrap">
                      {(d.proofUrl || d.proofImage) && (
                        <IconAction
                          icon={ImageIcon}
                          title="View deposit proof"
                          tone="sky"
                          onClick={async () => {
                            try {
                              const r = await api.get(`/merchant-deposits/${d.id}/proof`, {
                                responseType: 'blob',
                              });
                              const url = URL.createObjectURL(r.data);
                              setDepositProofPreview(url);
                            } catch {
                              show('Could not load deposit proof');
                            }
                          }}
                        />
                      )}
                      {d.status === 'pending' && (
                        <>
                          <IconAction
                            icon={Check}
                            title="Accept as collected"
                            tone="emerald"
                            onClick={async () => {
                              if (!confirm(`Accept deposit #${d.id} (${peso(d.amountTotal)}) from ${d.cashierUsername}?`)) return;
                              setDepositBusyId(d.id);
                              try {
                                await api.post(`/merchant-deposits/${d.id}/accept`);
                                show(`Deposit #${d.id} accepted`);
                                load();
                              } catch (e: any) {
                                show(e?.response?.data?.error || 'Accept failed');
                              } finally {
                                setDepositBusyId(null);
                              }
                            }}
                          />
                          <IconAction
                            icon={X}
                            title="Reject (return to cashier)"
                            tone="rose"
                            onClick={async () => {
                              const note = prompt('Reject reason (optional)') || '';
                              setDepositBusyId(d.id);
                              try {
                                await api.post(`/merchant-deposits/${d.id}/reject`, { note });
                                show(`Deposit #${d.id} rejected — items returned to cashier`);
                                load();
                              } catch (e: any) {
                                show(e?.response?.data?.error || 'Reject failed');
                              } finally {
                                setDepositBusyId(null);
                              }
                            }}
                          />
                        </>
                      )}
                      {depositBusyId === d.id && (
                        <span className="text-xs text-slate-400 self-center">…</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {cashierDeposits.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-400">
                    No merchant deposits yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
          <div>
            <div className="font-semibold text-slate-800 inline-flex items-center gap-2">
              <BarChart3 size={18} className="text-sky-600" /> Settlement report
            </div>
            <p className="text-xs text-slate-500 mt-1">
              Collectibles and deposit totals by merchant/cashier.
            </p>
          </div>
          <button
            type="button"
            className="btn-secondary text-sm"
            onClick={() =>
              api
                .get('/merchant-settlement')
                .then((r) => setSettlement(r.data))
                .catch(() => setSettlement(null))
            }
          >
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
        <div className="overflow-auto mb-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-400 border-b border-slate-100">
                <th className="py-2">Cashier</th>
                <th className="py-2 text-right">Open</th>
                <th className="py-2 text-right">Submitted</th>
                <th className="py-2 text-right">Collected</th>
                <th className="py-2 text-right">Rejected</th>
                <th className="py-2 text-right">Items</th>
              </tr>
            </thead>
            <tbody>
              {(settlement?.byCashier || []).map((row: any) => (
                <tr key={row.cashierUserId || row.cashierUsername} className="border-b border-slate-50">
                  <td className="py-2.5 font-mono text-xs">{row.cashierUsername || '—'}</td>
                  <td className="py-2.5 text-right">{peso(Number(row.openTotal) || 0)}</td>
                  <td className="py-2.5 text-right">{peso(Number(row.submittedTotal) || 0)}</td>
                  <td className="py-2.5 text-right">{peso(Number(row.collectedTotal) || 0)}</td>
                  <td className="py-2.5 text-right">{peso(Number(row.rejectedTotal) || 0)}</td>
                  <td className="py-2.5 text-right text-slate-500">{row.items ?? 0}</td>
                </tr>
              ))}
              {(!settlement?.byCashier || settlement.byCashier.length === 0) && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-slate-400">
                    No settlement data yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {(settlement?.depositsByStatus || []).length > 0 && (
          <div>
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Deposit status totals</div>
            <div className="flex flex-wrap gap-2">
              {(settlement.depositsByStatus || []).map((d: any) => (
                <div
                  key={String(d.status)}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm"
                >
                  <span className="capitalize text-slate-600">{d.status}</span>
                  <span className="mx-1.5 text-slate-300">·</span>
                  <span className="font-semibold text-slate-800">{peso(Number(d.total) || 0)}</span>
                  <span className="text-xs text-slate-400 ml-1">({d.count})</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {proofPreview && (
        <div
          className="fixed inset-0 z-[80] bg-black/60 flex items-center justify-center p-4"
          onClick={() => {
            URL.revokeObjectURL(proofPreview);
            setProofPreview(null);
          }}
        >
          <img src={proofPreview} alt="Payment proof" className="max-h-[90vh] max-w-full rounded-xl shadow-2xl" onClick={(e) => e.stopPropagation()} />
        </div>
      )}
      {depositProofPreview && (
        <div
          className="fixed inset-0 z-[80] bg-black/60 flex items-center justify-center p-4"
          onClick={() => {
            URL.revokeObjectURL(depositProofPreview);
            setDepositProofPreview(null);
          }}
        >
          <img
            src={depositProofPreview}
            alt="Merchant deposit proof"
            className="max-h-[90vh] max-w-full rounded-xl shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </Layout>
  );
}
