/**
 * A4 business printouts — high-contrast branding for readable print preview.
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

/** Shared A4 stylesheet — dark ink on white for print-preview readability. */
function printStyles(): string {
  return `
  @page { size: A4; margin: 12mm 14mm; }
  * { box-sizing: border-box; }
  html, body {
    background: #ffffff !important;
    color: #0f172a !important;
  }
  body {
    font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    font-size: 13.5px;
    line-height: 1.5;
    margin: 0;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .brand-bar {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 20px;
    padding-bottom: 14px; margin-bottom: 18px;
    border-bottom: 3px solid #0f766e;
  }
  .brand-left { display: flex; gap: 14px; align-items: flex-start; min-width: 0; }
  .logo {
    width: 56px; height: 56px; object-fit: contain; border-radius: 10px;
    border: 1px solid #cbd5e1; background: #f8fafc; flex-shrink: 0;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .logo-fallback {
    width: 56px; height: 56px; border-radius: 10px; background: #0f766e;
    color: #ffffff; font-weight: 800; font-size: 18px; display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .brand-name { font-size: 22px; font-weight: 800; letter-spacing: -0.02em; color: #0f172a !important; margin: 0; }
  .brand-tag { font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: #0f766e !important; font-weight: 800; margin-top: 2px; }
  .brand-meta { color: #1e293b !important; font-size: 12px; margin-top: 4px; font-weight: 500; }
  .doc-title { text-align: right; }
  .doc-title h2 { margin: 0; font-size: 24px; font-weight: 800; color: #0f172a !important; letter-spacing: -0.02em; }
  .doc-title .sub { color: #1e293b !important; font-size: 13px; margin-top: 4px; font-weight: 600; }
  .muted { color: #334155 !important; }
  .badge {
    display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 11px;
    font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em;
    background: #e2e8f0; color: #0f172a !important; margin-top: 6px;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .badge.paid { background: #99f6e4; color: #115e59 !important; }
  .badge.overdue { background: #fecaca; color: #7f1d1d !important; }
  .badge.unpaid, .badge.partial, .badge.pending { background: #fde68a; color: #78350f !important; }
  .grid2 { display: flex; gap: 32px; flex-wrap: wrap; margin-bottom: 16px; }
  .label {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em;
    color: #334155 !important; font-weight: 800;
  }
  .value { color: #0f172a !important; font-weight: 600; }
  .value-strong { color: #0f172a !important; font-weight: 800; font-size: 16px; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; }
  th, td {
    text-align: left; padding: 10px 8px; border-bottom: 1px solid #cbd5e1;
    color: #0f172a !important; font-size: 13px;
  }
  th {
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
    color: #1e293b !important; font-weight: 800; background: #f1f5f9;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .r { text-align: right; }
  .totals { margin-top: 14px; width: 280px; margin-left: auto; }
  .totals td { border: 0; padding: 5px 0; color: #0f172a !important; font-weight: 600; }
  .totals .grand {
    font-size: 16px; font-weight: 800; border-top: 2px solid #0f172a;
    padding-top: 8px; color: #0f172a !important;
  }
  .section-title {
    margin-top: 26px; margin-bottom: 0; font-size: 12px; letter-spacing: 0.06em;
    text-transform: uppercase; color: #1e293b !important; font-weight: 800;
  }
  .foot {
    margin-top: 28px; padding-top: 12px; border-top: 1px solid #cbd5e1;
    font-size: 11px; color: #334155 !important; font-weight: 600;
    display: flex; justify-content: space-between; gap: 12px;
  }
  .accent-strip {
    height: 5px; background: #0f766e; border-radius: 2px; margin-bottom: 16px;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  @media print {
    .no-print { display: none !important; }
    body { color: #000000 !important; }
    .brand-name, .doc-title h2, .value, .value-strong, th, td, .totals td, .totals .grand {
      color: #000000 !important;
    }
  }
`;
}

/** Make logo URLs work inside about:blank print iframes. */
function resolveLogoSrc(logo: string | null | undefined): string | null {
  const raw = String(logo || '').trim();
  if (!raw) return null;
  if (raw.startsWith('data:') || raw.startsWith('blob:') || /^https?:\/\//i.test(raw)) return raw;
  try {
    return new URL(raw, window.location.origin).href;
  } catch {
    return raw;
  }
}

function businessHeader(company: CompanyPrint | null | undefined, docTitle: string, docSub?: string): string {
  const c = company || {};
  const initials = String(c.name || 'ISP')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || '')
    .join('');
  const logoSrc = resolveLogoSrc(c.logo);
  const logo = logoSrc
    ? `<img class="logo" src="${esc(logoSrc)}" alt=""/>`
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

/**
 * Print via a hidden iframe — no pop-up window.
 * (window.open + noopener returns null / blank about:blank after async clicks.)
 */
function openPrintWindow(html: string, _title: string) {
  // Strip auto-print scripts; we call print() ourselves after the iframe loads
  const bodyHtml = html.replace(/<script[\s\S]*?<\/script>/gi, '');

  const prev = document.getElementById('mt-a4-print-frame');
  if (prev) prev.remove();

  const iframe = document.createElement('iframe');
  iframe.id = 'mt-a4-print-frame';
  iframe.setAttribute('title', 'Print');
  // Keep a readable on-screen size during render so print engines measure text correctly,
  // then hide after print is triggered.
  iframe.style.cssText =
    'position:fixed;right:0;bottom:0;width:794px;height:1123px;border:0;opacity:0.01;pointer-events:none;z-index:-1;';
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!doc) {
    // Last resort: same-tab blob (still no popup)
    const blob = new Blob([bodyHtml], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }

  // Inject <base> so relative assets (/logo.png) resolve against the app origin
  // inside this about:blank iframe document.
  const baseHref = `${window.location.origin}/`;
  const htmlWithBase = /<head[^>]*>/i.test(bodyHtml)
    ? bodyHtml.replace(/<head([^>]*)>/i, `<head$1><base href="${esc(baseHref)}">`)
    : `<!DOCTYPE html><html><head><base href="${esc(baseHref)}"></head><body>${bodyHtml}</body></html>`;

  doc.open();
  doc.write(htmlWithBase);
  doc.close();

  const doPrint = () => {
    try {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
    } catch {
      /* ignore */
    }
    // Keep iframe briefly so the print dialog can read it
    window.setTimeout(() => {
      try {
        iframe.remove();
      } catch {
        /* ignore */
      }
    }, 60_000);
  };

  // Wait for images (logo) then print
  const imgs = Array.from(doc.images || []);
  if (!imgs.length) {
    window.setTimeout(doPrint, 150);
    return;
  }
  let left = imgs.length;
  const tick = () => {
    left -= 1;
    if (left <= 0) window.setTimeout(doPrint, 100);
  };
  imgs.forEach((img) => {
    if (img.complete) tick();
    else {
      img.onload = tick;
      img.onerror = tick;
    }
  });
  // Safety timeout if a logo never loads
  window.setTimeout(() => {
    if (document.getElementById('mt-a4-print-frame') === iframe) doPrint();
  }, 2500);
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
      <div class="value-strong" style="margin-top:2px">${esc(inv.customer_name || '—')}</div>
      <div class="value">Account #${esc(inv.account_number || '—')}</div>
    </div>
    <div>
      <div class="label">Service period</div>
      <div class="value" style="margin-top:2px">${esc(inv.period_start || '—')} → ${esc(inv.period_end || '—')}</div>
      <div class="value">Due date: <b>${esc(inv.due_date || '—')}</b></div>
    </div>
  </div>
  <table>
    <thead><tr><th>Description</th><th class="r">Amount</th></tr></thead>
    <tbody>
      <tr>
        <td>Internet service${inv.period_start ? ` (${esc(inv.period_start)} – ${esc(inv.period_end)})` : ''}</td>
        <td class="r"><b>${money(Number(inv.amount || 0))}</b></td>
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
      ? `<h3 class="section-title">Payment history</h3>
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
  <div style="font-size:18px;font-weight:800;color:#0f172a;margin:8px 0 4px">Total ${money(opts.total)}</div>
  <table><thead><tr><th>Period</th><th class="r">Amount</th></tr></thead><tbody>${bars || '<tr><td colspan="2" class="muted">No period totals</td></tr>'}</tbody></table>
  ${
    txRows
      ? `<h3 class="section-title">Transactions</h3>
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
