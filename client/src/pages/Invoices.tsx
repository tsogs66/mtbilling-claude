import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, KeyRound, Plus, Printer, RefreshCw, Sparkles } from 'lucide-react';
import Layout from '../components/Layout';
import { Modal, ModalFooter, FormField } from '../components/ui';
import {
  Col, downloadCsv, moneyExact, money, num, PageBar, PanelHead, Pill, Reading, Readings, SearchBox, Table, Tabs, TONE_VAR,
} from '../components/command/kit';
import type { Tone } from '../lib/commandModel';
import { api, peso } from '../api';
import { openInvoicePrint } from '../lib/invoicePrint';

type Bucket = 'all' | 'current' | 'd1_30' | 'd31_60' | 'd61_plus';
type TabKey = 'open' | 'overdue' | 'paid' | 'void' | 'all';

const BUCKETS: { key: Exclude<Bucket, 'all'>; label: string; tone: Tone }[] = [
  { key: 'current', label: 'Current', tone: 'good' },
  { key: 'd1_30', label: '1\u201330 days', tone: 'warn' },
  { key: 'd31_60', label: '31\u201360 days', tone: 'hot' },
  { key: 'd61_plus', label: '61+ days', tone: 'bad' },
];

const todayStr = () => new Date().toISOString().slice(0, 10);

const daysBetween = (from: string, to: string) =>
  Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000);

const isOpen = (inv: any) => ['unpaid', 'partial', 'overdue'].includes(String(inv.status));
const balanceOf = (inv: any) => Math.max(0, Number(inv.amount || 0) - Number(inv.amount_paid || 0));

/** Same aging rule the server uses for the totals. */
function bucketOf(inv: any, today: string): Exclude<Bucket, 'all'> {
  if (!inv.due_date || inv.due_date >= today) return 'current';
  const late = daysBetween(inv.due_date, today);
  if (late <= 30) return 'd1_30';
  if (late <= 60) return 'd31_60';
  return 'd61_plus';
}

function effective(inv: any, today: string): 'paid' | 'void' | 'overdue' | 'partial' | 'unpaid' {
  const s = String(inv.status || 'unpaid');
  if (s === 'paid' || s === 'void') return s;
  if (s === 'overdue' || (inv.due_date && inv.due_date < today)) return 'overdue';
  return s === 'partial' ? 'partial' : 'unpaid';
}

const STATUS_TONE: Record<string, Tone> = { paid: 'good', void: 'mute', overdue: 'bad', partial: 'warn', unpaid: 'info' };

export default function Invoices() {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [aging, setAging] = useState<any>({});
  const [loaded, setLoaded] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [payId, setPayId] = useState<number | null>(null);
  const [subs, setSubs] = useState<any[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState<number | null>(null);
  const [tab, setTab] = useState<TabKey>('open');
  const [bucket, setBucket] = useState<Bucket>('all');
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const today = useMemo(todayStr, []);

  const load = useCallback(
    () =>
      api.get('/invoices').then((r) => {
        setInvoices(r.data.invoices || []);
        setAging(r.data.aging || {});
        setLoaded(true);
      }),
    [],
  );

  useEffect(() => {
    load();
    api.get('/pppoe/users?service=pppoe').then((r) => {
      const rows = Array.isArray(r.data) ? r.data : r.data.users || [];
      setSubs(rows.map((s: any) => ({
        ...s,
        customer_name: s.customer_name || s.customer,
        account_number: s.account_number || s.account,
      })));
    }).catch(() => {});
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(el.tagName)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const term = search.trim().toLowerCase();
  const matchesSearch = useCallback(
    (inv: any) =>
      !term ||
      [inv.number, inv.customer_name, inv.account_number].some((v) => String(v || '').toLowerCase().includes(term)),
    [term],
  );

  const searched = useMemo(() => invoices.filter(matchesSearch), [invoices, matchesSearch]);

  const tabCounts = useMemo(() => {
    const c: Record<TabKey, number> = { open: 0, overdue: 0, paid: 0, void: 0, all: searched.length };
    for (const inv of searched) {
      const e = effective(inv, today);
      if (isOpen(inv)) c.open++;
      if (e === 'overdue') c.overdue++;
      if (e === 'paid') c.paid++;
      if (e === 'void') c.void++;
    }
    return c;
  }, [searched, today]);

  const rows = useMemo(() => {
    return searched.filter((inv) => {
      const e = effective(inv, today);
      if (tab === 'open' && !isOpen(inv)) return false;
      if (tab === 'overdue' && e !== 'overdue') return false;
      if (tab === 'paid' && e !== 'paid') return false;
      if (tab === 'void' && e !== 'void') return false;
      if (bucket !== 'all' && (!isOpen(inv) || bucketOf(inv, today) !== bucket)) return false;
      return true;
    });
  }, [searched, tab, bucket, today]);

  const agingParts = useMemo(
    () =>
      BUCKETS.map((b) => ({ ...b, value: Number(aging[b.key] || 0) })),
    [aging],
  );
  const agingTotal = agingParts.reduce((s, p) => s + p.value, 0);

  const debtors = useMemo(() => {
    const map = new Map<string, { name: string; account: string; owed: number; oldest: string; count: number }>();
    for (const inv of invoices) {
      if (!isOpen(inv)) continue;
      const key = String(inv.account_number || inv.customer_name || inv.id);
      const cur = map.get(key) || { name: inv.customer_name || '\u2014', account: inv.account_number || '', owed: 0, oldest: inv.due_date || today, count: 0 };
      cur.owed += balanceOf(inv);
      cur.count += 1;
      if (inv.due_date && inv.due_date < cur.oldest) cur.oldest = inv.due_date;
      map.set(key, cur);
    }
    return [...map.values()].sort((a, b) => b.owed - a.owed).slice(0, 6);
  }, [invoices, today]);

  const openCount = invoices.filter(isOpen).length;
  const overdueCount = invoices.filter((i) => effective(i, today) === 'overdue').length;
  const truncated = invoices.length >= 500;

  const pickBucket = (b: Bucket) => {
    setBucket((cur) => (cur === b ? 'all' : b));
    setTab('open');
  };

  const batch = async () => {
    if (!confirm('Generate unpaid invoices for all active subscribers with a plan price?')) return;
    setBatchBusy(true);
    try {
      const r = await api.post('/invoices/batch', {});
      alert(`Created ${r.data.created} invoice(s).`);
      load();
    } finally {
      setBatchBusy(false);
    }
  };

  const voidInv = async (id: number) => {
    if (!confirm('Void this invoice?')) return;
    await api.post(`/invoices/${id}/void`);
    load();
  };

  const printInvoice = async (id: number) => {
    setPreviewBusy(id);
    try {
      const r = await api.get(`/invoices/${id}/soa`);
      openInvoicePrint({
        company: r.data.company,
        invoice: r.data.invoice,
        history: (r.data.history || []).map((h: any) => ({
          amount: h.amount,
          method: h.method,
          paid_at: h.paid_at || h.created_at,
          note: h.note || h.reference,
        })),
      });
    } catch (e: any) {
      const inv = invoices.find((x) => x.id === id);
      if (inv) openInvoicePrint({ invoice: inv, history: [] });
      else alert(e?.response?.data?.error || 'Could not load invoice for print');
    } finally {
      setPreviewBusy(null);
    }
  };

  const exportCsv = () =>
    downloadCsv(
      `invoices-${today}.csv`,
      ['Invoice', 'Customer', 'Account', 'Due', 'Amount', 'Paid', 'Balance', 'Status'],
      rows.map((i) => [i.number, i.customer_name, i.account_number, i.due_date, i.amount, i.amount_paid, balanceOf(i), effective(i, today)]),
    );

  const columns: Col<any>[] = [
    { key: 'number', label: 'Invoice', render: (i) => <span className="font-mono text-xs font-semibold">{i.number}</span> },
    {
      key: 'customer',
      label: 'Customer',
      render: (i) => (
        <div className="min-w-0">
          <div className="truncate font-medium">{i.customer_name || '\u2014'}</div>
          <div className="text-[11px] opacity-55">{i.account_number || ''}</div>
        </div>
      ),
    },
    {
      key: 'due',
      label: 'Due',
      render: (i) => {
        const late = i.due_date && isOpen(i) && i.due_date < today ? daysBetween(i.due_date, today) : 0;
        return (
          <div>
            <div>{i.due_date || '\u2014'}</div>
            {late > 0 && <div className="text-[11px]" style={{ color: TONE_VAR[late > 30 ? 'bad' : 'warn'] }}>{late}d late</div>}
          </div>
        );
      },
    },
    { key: 'amount', label: 'Amount', align: 'right', render: (i) => peso(i.amount) },
    { key: 'paid', label: 'Paid', align: 'right', render: (i) => <span className="opacity-70">{peso(i.amount_paid)}</span> },
    {
      key: 'balance',
      label: 'Balance',
      align: 'right',
      render: (i) => {
        const b = isOpen(i) ? balanceOf(i) : 0;
        return <span className="font-semibold">{b > 0 ? peso(b) : '\u2014'}</span>;
      },
    },
    {
      key: 'status',
      label: 'Status',
      render: (i) => {
        const e = effective(i, today);
        return <Pill tone={STATUS_TONE[e]}>{e}</Pill>;
      },
    },
    {
      key: 'actions',
      label: '',
      align: 'right',
      render: (i) => (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <button type="button" className="cc-link" onClick={() => printInvoice(i.id)} disabled={previewBusy === i.id} title="Preview and print invoice">
            <Printer size={12} /> Print
          </button>
          {i.status !== 'paid' && i.status !== 'void' && (
            <button type="button" className="cc-link" onClick={() => setPayId(i.id)}>Record pay</button>
          )}
          {i.status !== 'paid' && i.status !== 'void' && (
            <button type="button" className="cc-link" style={{ color: TONE_VAR.bad }} onClick={() => voidInv(i.id)}>Void</button>
          )}
        </div>
      ),
    },
  ];

  return (
    <Layout title="Invoices & AR">
      <div className="cc space-y-5 pb-10">
        <header className="space-y-3">
          <PageBar
            title="Invoices & receivables"
            subtitle={loaded ? `${num(invoices.length)} invoices loaded \u00b7 ${num(openCount)} open \u00b7 ${num(overdueCount)} overdue` : 'Loading receivables'}
          >
            <SearchBox inputRef={searchRef} value={search} onChange={setSearch} placeholder="Invoice, customer or account" />
            <button type="button" className="cc-btn" onClick={() => load()} title="Refresh">
              <RefreshCw size={14} />
            </button>
            <button type="button" className="cc-btn" onClick={exportCsv} disabled={rows.length === 0} title="Export the rows shown as CSV">
              <Download size={14} /> <span className="hidden md:inline">CSV</span>
            </button>
            <Link to="/subscriber-portal" className="cc-btn">
              <KeyRound size={14} /> <span className="hidden md:inline">Subscriber Portal</span>
            </Link>
            <button type="button" className="cc-btn" onClick={batch} disabled={batchBusy}>
              <Sparkles size={14} /> {batchBusy ? 'Generating\u2026' : 'Batch generate'}
            </button>
            <button type="button" className="cc-btn is-on" onClick={() => setCreateOpen(true)}>
              <Plus size={14} /> New invoice
            </button>
          </PageBar>

          <Readings count={6}>
            <Reading
              label="Total AR"
              tone="bad"
              value={money(aging.total_ar || 0)}
              sub={`${num(openCount)} open invoices`}
              on={tab === 'open' && bucket === 'all'}
              onClick={() => { setBucket('all'); setTab('open'); }}
            />
            {BUCKETS.map((b) => (
              <Reading
                key={b.key}
                label={b.label}
                tone={b.tone}
                value={money(aging[b.key] || 0)}
                sub={agingTotal > 0 ? `${Math.round(((aging[b.key] || 0) / agingTotal) * 100)}% of AR` : 'nothing open'}
                bar={agingTotal > 0 ? (aging[b.key] || 0) / agingTotal : 0}
                on={bucket === b.key}
                onClick={() => pickBucket(b.key)}
              />
            ))}
            <Reading
              label="Paid this month"
              tone="good"
              value={money(aging.paid_this_month || 0)}
              sub="paid invoices since the 1st"
              on={tab === 'paid'}
              onClick={() => { setBucket('all'); setTab('paid'); }}
            />
          </Readings>
        </header>

        <div className="grid gap-x-8 gap-y-5 lg:grid-cols-5">
          <section className="lg:col-span-3">
            <PanelHead title="How old is the money owed" note="Click a segment to list only those invoices" />
            {agingTotal === 0 ? (
              <p className="cc-empty">No open receivables.</p>
            ) : (
              <>
                <div className={`cc-stack ${bucket !== 'all' ? 'has-pick' : ''}`}>
                  {agingParts.filter((p) => p.value > 0).map((p) => (
                    <button
                      key={p.key}
                      type="button"
                      className={bucket === p.key ? 'is-on' : ''}
                      style={{ width: `${(p.value / agingTotal) * 100}%`, background: TONE_VAR[p.tone] }}
                      title={`${p.label}: ${moneyExact(p.value)}`}
                      aria-label={`${p.label}: ${moneyExact(p.value)}`}
                      onClick={() => pickBucket(p.key)}
                    />
                  ))}
                </div>
                <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
                  {agingParts.map((p) => (
                    <li key={p.key} className="flex items-center gap-1.5">
                      <i className="h-2 w-2 shrink-0 rounded-full" style={{ background: TONE_VAR[p.tone] }} />
                      <span className="opacity-70">{p.label}</span>
                      <span className="ml-auto font-semibold">{money(p.value)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>

          <section className="lg:col-span-2">
            <PanelHead title="Largest balances" note="Open invoices, grouped by subscriber" />
            {debtors.length === 0 ? (
              <p className="cc-empty">Nobody owes anything on the loaded invoices.</p>
            ) : (
              <ul className="space-y-0.5">
                {debtors.map((d) => (
                  <li key={d.account || d.name}>
                    <button type="button" className="cc-seg-row flex w-full items-center gap-3 text-sm" onClick={() => { setSearch(d.account || d.name); setTab('open'); setBucket('all'); }}>
                      <span className="min-w-0 flex-1 truncate font-medium">{d.name}</span>
                      <span className="text-[11px] opacity-55">
                        {d.count} inv · since {d.oldest}
                      </span>
                      <span className="w-24 text-right font-semibold" style={{ color: TONE_VAR[d.oldest < today && daysBetween(d.oldest, today) > 30 ? 'bad' : 'warn'] }}>{money(d.owed)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <section>
          <PanelHead
            title="Invoices"
            note={
              truncated
                ? 'Showing the newest 500 invoices. The readings above cover every invoice, so older ones may not appear in the list.'
                : bucket !== 'all'
                  ? `Filtered to the ${BUCKETS.find((b) => b.key === bucket)?.label} bucket`
                  : 'Latest first'
            }
            actions={
              (bucket !== 'all' || search) ? (
                <button type="button" className="cc-link" onClick={() => { setBucket('all'); setSearch(''); }}>Clear filters</button>
              ) : undefined
            }
          />
          <Tabs
            value={tab}
            onChange={(k) => { setTab(k); setBucket('all'); }}
            tabs={[
              { key: 'open', label: 'Open', count: tabCounts.open },
              { key: 'overdue', label: 'Overdue', count: tabCounts.overdue },
              { key: 'paid', label: 'Paid', count: tabCounts.paid },
              { key: 'void', label: 'Void', count: tabCounts.void },
              { key: 'all', label: 'All', count: tabCounts.all },
            ]}
          />
          <Table
            columns={columns}
            rows={rows}
            rowKey={(i) => i.id}
            empty={loaded ? 'No invoices here. Batch-generate for the month or create one.' : 'Loading\u2026'}
          />
        </section>
      </div>

      {createOpen && (
        <CreateInvoiceModal
          subs={subs}
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            setCreateOpen(false);
            load();
          }}
        />
      )}
      {payId != null && (
        <PayModal
          invoiceId={payId}
          onClose={() => setPayId(null)}
          onSaved={() => {
            setPayId(null);
            load();
          }}
        />
      )}
    </Layout>
  );
}

function CreateInvoiceModal({ subs, onClose, onSaved }: any) {
  const [form, setForm] = useState<any>({ pppoe_user_id: '', due_date: new Date().toISOString().slice(0, 10) });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post('/invoices', form);
      onSaved();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="New invoice" onClose={onClose} footer={<ModalFooter onCancel={onClose} onConfirm={save} busy={busy} />}>
      <div className="space-y-3">
        <FormField label="Subscriber" required>
          <select className="input" value={form.pppoe_user_id} onChange={(e) => setForm({ ...form, pppoe_user_id: Number(e.target.value) })}>
            <option value="">Select…</option>
            {subs.map((s: any) => (
              <option key={s.id} value={s.id}>{s.customer_name || s.username} — {peso(s.price)}</option>
            ))}
          </select>
        </FormField>
        <FormField label="Due date">
          <input type="date" className="input" value={form.due_date || ''} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
        </FormField>
        <FormField label="Amount override (optional)">
          <input type="number" className="input" value={form.amount ?? ''} onChange={(e) => setForm({ ...form, amount: e.target.value === '' ? undefined : Number(e.target.value) })} />
        </FormField>
      </div>
    </Modal>
  );
}

function PayModal({ invoiceId, onClose, onSaved }: any) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.post(`/invoices/${invoiceId}/pay`, { amount: amount ? Number(amount) : undefined, method });
      onSaved();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="Record payment" onClose={onClose} footer={<ModalFooter onCancel={onClose} onConfirm={save} busy={busy} confirmLabel="Apply" />}>
      <div className="space-y-3">
        <FormField label="Amount (blank = remaining balance)">
          <input type="number" className="input" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </FormField>
        <FormField label="Method">
          <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="cash">Cash</option>
            <option value="gcash">GCash</option>
            <option value="maya">Maya</option>
            <option value="bank">Bank</option>
          </select>
        </FormField>
      </div>
    </Modal>
  );
}
