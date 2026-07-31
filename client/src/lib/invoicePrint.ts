/**
 * A4 / browser invoice printout (SOA-style). Opens a print window like receipts.
 */
export type InvoicePrintData = {
  company?: {
    name?: string;
    address?: string;
    phone?: string;
    email?: string;
  } | null;
  invoice: {
    number?: string;
    customer_name?: string;
    account_number?: string;
    period_start?: string;
    period_end?: string;
    due_date?: string;
    amount?: number;
    amount_paid?: number;
    status?: string;
    notes?: string;
    paid_at?: string;
    created_at?: string;
  };
  history?: Array<{
    amount?: number;
    method?: string;
    paid_at?: string;
    note?: string;
  }>;
};

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(n: number): string {
  return `\u20b1${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function buildInvoiceHtml(data: InvoicePrintData): string {
  const c = data.company || {};
  const inv = data.invoice || {};
  const balance = Math.max(0, Number(inv.amount || 0) - Number(inv.amount_paid || 0));
  const hist = data.history || [];
  const rows = hist
    .map(
      (h) =>
        `<tr><td>${esc(h.paid_at || '—')}</td><td>${esc(h.method || '—')}</td><td class="r">${money(Number(h.amount || 0))}</td><td>${esc(h.note || '')}</td></tr>`
    )
    .join('');

  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Invoice ${esc(inv.number)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  body { font-family: "Segoe UI", system-ui, sans-serif; color: #0f172a; font-size: 13px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .muted { color: #64748b; }
  .head { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #0ea5e9; padding-bottom: 12px; margin-bottom: 16px; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; background: #e2e8f0; }
  .badge.paid { background: #d1fae5; color: #065f46; }
  .badge.overdue { background: #fee2e2; color: #991b1b; }
  .badge.unpaid, .badge.partial { background: #fef3c7; color: #92400e; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #e2e8f0; }
  th { font-size: 11px; text-transform: uppercase; color: #64748b; }
  .r { text-align: right; }
  .totals { margin-top: 16px; width: 280px; margin-left: auto; }
  .totals td { border: 0; padding: 4px 0; }
  .totals .grand { font-size: 16px; font-weight: 700; border-top: 2px solid #0f172a; padding-top: 8px; }
  .foot { margin-top: 28px; font-size: 11px; color: #64748b; }
  @media print { .no-print { display: none !important; } }
</style></head><body>
  <div class="head">
    <div>
      <h1>${esc(c.name || 'ISP Billing')}</h1>
      <div class="muted">${esc(c.address || '')}</div>
      <div class="muted">${[c.phone, c.email].filter(Boolean).map(esc).join(' · ')}</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:18px;font-weight:700">INVOICE</div>
      <div><b>${esc(inv.number || '—')}</b></div>
      <div class="badge ${esc(String(inv.status || '').toLowerCase())}">${esc(inv.status || 'unpaid')}</div>
    </div>
  </div>
  <div style="display:flex;gap:40px;flex-wrap:wrap">
    <div>
      <div class="muted" style="font-size:11px;text-transform:uppercase">Bill to</div>
      <div style="font-weight:700;font-size:15px">${esc(inv.customer_name || '—')}</div>
      <div>Account #${esc(inv.account_number || '—')}</div>
    </div>
    <div>
      <div class="muted" style="font-size:11px;text-transform:uppercase">Period</div>
      <div>${esc(inv.period_start || '—')} → ${esc(inv.period_end || '—')}</div>
      <div>Due: <b>${esc(inv.due_date || '—')}</b></div>
    </div>
  </div>
  <table>
    <thead><tr><th>Description</th><th class="r">Amount</th></tr></thead>
    <tbody>
      <tr><td>Internet service${inv.period_start ? ` (${esc(inv.period_start)} – ${esc(inv.period_end)})` : ''}</td><td class="r">${money(Number(inv.amount || 0))}</td></tr>
      ${inv.notes ? `<tr><td colspan="2" class="muted">${esc(inv.notes)}</td></tr>` : ''}
    </tbody>
  </table>
  <table class="totals">
    <tr><td>Subtotal</td><td class="r">${money(Number(inv.amount || 0))}</td></tr>
    <tr><td>Paid</td><td class="r">${money(Number(inv.amount_paid || 0))}</td></tr>
    <tr class="grand"><td>Balance due</td><td class="r">${money(balance)}</td></tr>
  </table>
  ${
    hist.length
      ? `<h3 style="margin-top:28px;font-size:14px">Payment history</h3>
  <table><thead><tr><th>Date</th><th>Method</th><th class="r">Amount</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table>`
      : ''
  }
  <div class="foot">Generated ${esc(new Date().toLocaleString())}. Thank you for your business.</div>
  <script>window.onload=function(){setTimeout(function(){window.print()},200)}</script>
</body></html>`;
}

export function openInvoicePrint(data: InvoicePrintData) {
  const html = buildInvoiceHtml(data);
  const w = window.open('', '_blank', 'noopener,noreferrer,width=800,height=1000');
  if (!w) {
    alert('Pop-up blocked — allow pop-ups to print the invoice.');
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

/** Sales / finance summary print (A4 landscape-friendly). */
export function openSalesReportPrint(opts: {
  title: string;
  companyName?: string;
  rangeLabel: string;
  total: number;
  rows: Array<{ label: string; value: number }>;
  meta?: string;
}) {
  const bars = opts.rows
    .map((r) => `<tr><td>${esc(r.label)}</td><td class="r">${money(r.value)}</td></tr>`)
    .join('');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${esc(opts.title)}</title>
<style>
  @page { size: A4; margin: 12mm; }
  body { font-family: "Segoe UI", system-ui, sans-serif; color: #0f172a; font-size: 13px; }
  h1 { margin: 0 0 4px; font-size: 20px; }
  .muted { color: #64748b; }
  table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th, td { padding: 8px 6px; border-bottom: 1px solid #e2e8f0; text-align: left; }
  .r { text-align: right; }
  .total { font-size: 18px; font-weight: 700; margin-top: 12px; }
</style></head><body>
  <h1>${esc(opts.title)}</h1>
  <div class="muted">${esc(opts.companyName || '')} · ${esc(opts.rangeLabel)}</div>
  ${opts.meta ? `<div class="muted">${esc(opts.meta)}</div>` : ''}
  <div class="total">Total: ${money(opts.total)}</div>
  <table><thead><tr><th>Period</th><th class="r">Amount</th></tr></thead><tbody>${bars}</tbody></table>
  <script>window.onload=function(){setTimeout(function(){window.print()},200)}</script>
</body></html>`;
  const w = window.open('', '_blank', 'noopener,noreferrer,width=900,height=1000');
  if (!w) {
    alert('Pop-up blocked — allow pop-ups to print.');
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
}
