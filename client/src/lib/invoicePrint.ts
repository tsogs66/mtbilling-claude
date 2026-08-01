/**
 * A4 business printouts — elegant header using Company branding.
 */
export type CompanyPrint = {
  name?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  logo?: string | null;
};

export type InvoicePrintData = {
  company?: CompanyPrint | null;
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

/** Shared A4 stylesheet — teal brand accent matching the panel. */
function printStyles(): string {
  return `
  @page { size: A4; margin: 12mm 14mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    color: #0f172a;
    font-size: 12.5px;
    line-height: 1.45;
    margin: 0;
  }
  .brand-bar {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 20px;
    padding-bottom: 14px; margin-bottom: 18px;
    border-bottom: 3px solid #0d9488;
  }
  .brand-left { display: flex; gap: 14px; align-items: flex-start; min-width: 0; }
  .logo {
    width: 56px; height: 56px; object-fit: contain; border-radius: 10px;
    border: 1px solid #e2e8f0; background: #f8fafc; flex-shrink: 0;
  }
  .logo-fallback {
    width: 56px; height: 56px; border-radius: 10px; background: linear-gradient(135deg,#0d9488,#0ea5e9);
    color: #fff; font-weight: 800; font-size: 18px; display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .brand-name { font-size: 20px; font-weight: 800; letter-spacing: -0.02em; color: #0f172a; margin: 0; }
  .brand-tag { font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em; color: #0d9488; font-weight: 700; margin-top: 2px; }
  .brand-meta { color: #64748b; font-size: 11px; margin-top: 4px; }
  .doc-title { text-align: right; }
  .doc-title h2 { margin: 0; font-size: 22px; font-weight: 800; color: #0f172a; letter-spacing: -0.02em; }
  .doc-title .sub { color: #64748b; font-size: 11px; margin-top: 4px; }
  .muted { color: #64748b; }
  .badge {
    display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 10px;
    font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; background: #e2e8f0; margin-top: 6px;
  }
  .badge.paid { background: #ccfbf1; color: #0f766e; }
  .badge.overdue { background: #fee2e2; color: #991b1b; }
  .badge.unpaid, .badge.partial, .badge.pending { background: #fef3c7; color: #92400e; }
  .grid2 { display: flex; gap: 32px; flex-wrap: wrap; margin-bottom: 16px; }
  .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #94a3b8; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  th, td { text-align: left; padding: 9px 8px; border-bottom: 1px solid #e2e8f0; }
  th { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; background: #f8fafc; }
  .r { text-align: right; }
  .totals { margin-top: 14px; width: 260px; margin-left: auto; }
  .totals td { border: 0; padding: 4px 0; }
  .totals .grand { font-size: 15px; font-weight: 800; border-top: 2px solid #0f172a; padding-top: 8px; color: #0d9488; }
  .foot {
    margin-top: 28px; padding-top: 12px; border-top: 1px solid #e2e8f0;
    font-size: 10px; color: #94a3b8; display: flex; justify-content: space-between; gap: 12px;
  }
  .accent-strip { height: 4px; background: linear-gradient(90deg,#0d9488,#0ea5e9,#38bdf8); border-radius: 2px; margin-bottom: 16px; }
  @media print { .no-print { display: none !important; } }
`;
}

function businessHeader(company: CompanyPrint | null | undefined, docTitle: string, docSub?: string): string {
  const c = company || {};
  const initials = String(c.name || 'ISP')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || '')
    .join('');
  const logo = c.logo
    ? `<img class="logo" src="${esc(c.logo)}" alt=""/>`
    : `<div class="logo-fallback">${esc(initials || 'ISP')}</div>`;
  return `
  <div class="accent-strip"></div>
  <div class="brand-bar">
    <div class="brand-left">
      ${logo}
      <div>
        <p class="brand-name">${esc(c.name || 'ISP Billing')}</p>
        <div class="brand-tag">Internet · Billing · Support</div>
        <div class="brand-meta">${esc(c.address || '')}</div>
        <div class="brand-meta">${[c.phone, c.email].filter(Boolean).map(esc).join(' · ')}</div>
      </div>
    </div>
    <div class="doc-title">
      <h2>${esc(docTitle)}</h2>
      ${docSub ? `<div class="sub">${esc(docSub)}</div>` : ''}
    </div>
  </div>`;
}

function openPrintWindow(html: string, title: string) {
  const w = window.open('', '_blank', 'noopener,noreferrer,width=860,height=1100');
  if (!w) {
    alert('Pop-up blocked — allow pop-ups to print.');
    return;
  }
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.document.title = title;
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
<style>${printStyles()}</style></head><body>
  ${businessHeader(c, 'INVOICE', inv.number || '')}
  <div style="text-align:right;margin-top:-8px;margin-bottom:12px">
    <span class="badge ${esc(String(inv.status || '').toLowerCase())}">${esc(inv.status || 'unpaid')}</span>
  </div>
  <div class="grid2">
    <div>
      <div class="label">Bill to</div>
      <div style="font-weight:700;font-size:15px;margin-top:2px">${esc(inv.customer_name || '—')}</div>
      <div>Account #${esc(inv.account_number || '—')}</div>
    </div>
    <div>
      <div class="label">Service period</div>
      <div style="margin-top:2px">${esc(inv.period_start || '—')} → ${esc(inv.period_end || '—')}</div>
      <div>Due date: <b>${esc(inv.due_date || '—')}</b></div>
    </div>
  </div>
  <table>
    <thead><tr><th>Description</th><th class="r">Amount</th></tr></thead>
    <tbody>
      <tr>
        <td>Internet service${inv.period_start ? ` (${esc(inv.period_start)} – ${esc(inv.period_end)})` : ''}</td>
        <td class="r">${money(Number(inv.amount || 0))}</td>
      </tr>
      ${inv.notes ? `<tr><td colspan="2" class="muted">${esc(inv.notes)}</td></tr>` : ''}
    </tbody>
  </table>
  <table class="totals">
    <tr><td>Subtotal</td><td class="r">${money(Number(inv.amount || 0))}</td></tr>
    <tr><td>Amount paid</td><td class="r">${money(Number(inv.amount_paid || 0))}</td></tr>
    <tr class="grand"><td>Balance due</td><td class="r">${money(balance)}</td></tr>
  </table>
  ${
    hist.length
      ? `<h3 style="margin-top:26px;font-size:13px;letter-spacing:0.04em;text-transform:uppercase;color:#64748b">Payment history</h3>
  <table><thead><tr><th>Date</th><th>Method</th><th class="r">Amount</th><th>Note</th></tr></thead><tbody>${rows}</tbody></table>`
      : ''
  }
  <div class="foot">
    <span>Thank you for choosing ${esc(c.name || 'us')}.</span>
    <span>Generated ${esc(new Date().toLocaleString())}</span>
  </div>
  <script>window.onload=function(){setTimeout(function(){window.print()},250)}</script>
</body></html>`;
}

export function openInvoicePrint(data: InvoicePrintData) {
  openPrintWindow(buildInvoiceHtml(data), `Invoice ${data.invoice?.number || ''}`);
}

export function openSalesReportPrint(opts: {
  title: string;
  company?: CompanyPrint | null;
  companyName?: string;
  rangeLabel: string;
  total: number;
  rows: Array<{ label: string; value: number }>;
  meta?: string;
  transactions?: Array<{
    date?: string;
    customer?: string;
    amount?: number;
    type?: string;
  }>;
}) {
  const company = opts.company || { name: opts.companyName };
  const bars = opts.rows
    .map((r) => `<tr><td>${esc(r.label)}</td><td class="r">${money(r.value)}</td></tr>`)
    .join('');
  const txRows = (opts.transactions || [])
    .map(
      (t) =>
        `<tr><td>${esc(t.date || '—')}</td><td>${esc(t.customer || '—')}</td><td>${esc(t.type || '—')}</td><td class="r">${money(Number(t.amount || 0))}</td></tr>`
    )
    .join('');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${esc(opts.title)}</title>
<style>${printStyles()}</style></head><body>
  ${businessHeader(company, opts.title, opts.rangeLabel)}
  ${opts.meta ? `<div class="muted" style="margin-bottom:8px">${esc(opts.meta)}</div>` : ''}
  <div style="font-size:18px;font-weight:800;color:#0d9488;margin:8px 0 4px">Total ${money(opts.total)}</div>
  <table><thead><tr><th>Period</th><th class="r">Amount</th></tr></thead><tbody>${bars || '<tr><td colspan="2" class="muted">No period totals</td></tr>'}</tbody></table>
  ${
    txRows
      ? `<h3 style="margin-top:26px;font-size:13px;letter-spacing:0.04em;text-transform:uppercase;color:#64748b">Transactions</h3>
  <table><thead><tr><th>Date</th><th>Customer</th><th>Type</th><th class="r">Amount</th></tr></thead><tbody>${txRows}</tbody></table>`
      : ''
  }
  <div class="foot">
    <span>${esc(company?.name || '')}</span>
    <span>Generated ${esc(new Date().toLocaleString())}</span>
  </div>
  <script>window.onload=function(){setTimeout(function(){window.print()},250)}</script>
</body></html>`;
  openPrintWindow(html, opts.title);
}
