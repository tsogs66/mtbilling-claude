/**
 * POS-58 thermal receipt (cnfujun POS-5890U-L).
 * PC print: narrow inner column + left inset (Windows drivers use a wide
 * virtual page; content must stay inside ~42mm). Android: plain-text Share.
 */
import { isNativeApp } from '../config';

/** Screen preview / popup outer width (px). */
const RECEIPT_OUTER_PX = 190;
/** Content column width (px) — ~42mm safe zone on 58mm roll. */
const RECEIPT_INNER_PX = 158;
/** Push content right from roll edge so the driver does not clip the right side. */
const RECEIPT_INSET_LEFT_PX = 22;
const RECEIPT_PAD_RIGHT_PX = 6;
/** Plain-text line width for Bluetooth / RawBT. */
const RECEIPT_TEXT_CHARS = 32;
/** Wrap long centered header/footer lines (chars). */
const RECEIPT_WRAP_CHARS = 22;

export type PaymentReceipt = {
  company?: string;
  companyAddress?: string;
  companyPhone?: string;
  companyEmail?: string;
  account?: string;
  customer?: string;
  plan?: string;
  months?: number;
  newDue?: string;
  discountDays?: number;
  subtotal?: number;
  discount?: number;
  total?: number;
  transactionAt?: string;
  paymentDate?: string;
};

function escapeReceiptHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(n: number): string {
  return `\u20b1${Number(n || 0).toFixed(2)}`;
}

function extensionLabel(months: number): string {
  return months === 1 ? '1 month' : `${months} months`;
}

function receiptWhen(receipt: PaymentReceipt): string {
  const txRaw = receipt.transactionAt || receipt.paymentDate || new Date().toISOString();
  const txDate = new Date(txRaw);
  if (!Number.isFinite(txDate.getTime())) return String(txRaw);
  return txDate.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function headerAddressLines(address?: string | null): string[] {
  if (!address?.trim()) return [];
  const byNewline = address.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (byNewline.length > 1) return byNewline;
  const single = byNewline[0] || address.trim();
  const parts = single.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 3) return [`${parts[0]}, ${parts[1]}`, parts.slice(2).join(', ')];
  if (parts.length === 2) return [parts.join(', ')];
  return [single];
}

function multilineField(text?: string | null): string[] {
  if (!text?.trim()) return [];
  return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function wrapText(text: string, width: number): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= width) return [t];
  const words = t.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if (next.length > width) {
      if (cur) lines.push(cur);
      if (word.length > width) {
        for (let i = 0; i < word.length; i += width) lines.push(word.slice(i, i + width));
        cur = '';
      } else {
        cur = word;
      }
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

const RULE_TEXT = '-'.repeat(RECEIPT_TEXT_CHARS);

function rightAlignLine(text: string, width = RECEIPT_TEXT_CHARS): string {
  const t = text.trim();
  if (!t) return '';
  if (t.length >= width) return t.slice(0, width);
  return `${' '.repeat(width - t.length)}${t}`;
}

function stackedFieldText(label: string, value: string): string[] {
  if (!value.trim()) return [];
  const rows = [label];
  for (const line of wrapText(value, RECEIPT_TEXT_CHARS)) rows.push(rightAlignLine(line));
  return rows;
}

function amountLineText(label: string, amount: string): string {
  const gap = RECEIPT_TEXT_CHARS - label.length - amount.length;
  return `${label}${' '.repeat(Math.max(1, gap))}${amount}`;
}

/** Plain-text receipt for Android Share → printer apps. */
export function buildReceiptText(receipt: PaymentReceipt): string {
  const company = (receipt.company || 'ISP Billing').toUpperCase();
  const months = Number(receipt.months) || 1;
  const extension = extensionLabel(months);
  const subtotal = Number(receipt.subtotal) || 0;
  const discount = Number(receipt.discount) || 0;
  const total = Number(receipt.total) || 0;
  const discountDays = Number(receipt.discountDays) || 0;
  const when = receiptWhen(receipt);
  const addressLines = headerAddressLines(receipt.companyAddress);
  const phones = multilineField(receipt.companyPhone);
  const emails = multilineField(receipt.companyEmail);

  const lines: string[] = [];
  lines.push(...wrapText(company, RECEIPT_TEXT_CHARS));
  for (const line of addressLines) lines.push(...wrapText(line, RECEIPT_TEXT_CHARS));
  lines.push('');
  lines.push(when);
  lines.push(RULE_TEXT);

  lines.push(...stackedFieldText('Account #:', String(receipt.account || '')));
  lines.push(...stackedFieldText('Customer:', String(receipt.customer || '')));
  lines.push(...stackedFieldText('Extension:', extension));
  lines.push(...stackedFieldText('Plan:', String(receipt.plan || '')));
  lines.push(...stackedFieldText('Next due:', String(receipt.newDue || '')));

  lines.push(RULE_TEXT);
  lines.push(amountLineText('Subtotal:', money(subtotal)));
  if (discount > 0) lines.push(amountLineText(`Discount (${discountDays}d):`, `-${money(discount)}`));
  lines.push(amountLineText('TOTAL:', money(total)));
  lines.push(RULE_TEXT);
  lines.push('Thank you for your payment.');
  lines.push(RULE_TEXT);

  lines.push(...wrapText(company, RECEIPT_TEXT_CHARS));
  for (const line of addressLines) lines.push(...wrapText(line, RECEIPT_TEXT_CHARS));
  for (const line of phones) lines.push(...wrapText(line, RECEIPT_TEXT_CHARS));
  for (const line of emails) lines.push(...wrapText(line, RECEIPT_TEXT_CHARS));

  lines.push(RULE_TEXT);
  lines.push('THIS IS NOT AN OFFICIAL RECEIPT');
  return lines.join('\n');
}

function fieldHtml(label: string, value: string, bold = false): string {
  if (!value.trim()) return '';
  const valClass = bold ? 'val val-bold' : 'val';
  const vals = wrapText(value, RECEIPT_WRAP_CHARS)
    .map((line) => `<div class="${valClass}">${escapeReceiptHtml(line)}</div>`)
    .join('');
  return `<div class="field"><div class="lab">${label}</div>${vals}</div>`;
}

function amountRowHtml(label: string, amount: string, total = false): string {
  return `<div class="amount-row${total ? ' amount-row-total' : ''}"><span class="amount-lab">${label}</span><span class="amount-val">${escapeReceiptHtml(amount)}</span></div>`;
}

function centerHtml(text: string, cls = 'line'): string {
  return wrapText(text, RECEIPT_WRAP_CHARS)
    .map((line) => `<div class="${cls}">${escapeReceiptHtml(line)}</div>`)
    .join('');
}

export function buildReceiptHtml(receipt: PaymentReceipt, opts?: { autoPrint?: boolean }): string {
  const autoPrint = opts?.autoPrint !== false;
  const companyRaw = (receipt.company || 'ISP Billing').toUpperCase();
  const months = Number(receipt.months) || 1;
  const extension = extensionLabel(months);
  const discountDays = Number(receipt.discountDays) || 0;
  const subtotal = Number(receipt.subtotal) || 0;
  const discount = Number(receipt.discount) || 0;
  const total = Number(receipt.total) || 0;
  const when = escapeReceiptHtml(receiptWhen(receipt));
  const addressLines = headerAddressLines(receipt.companyAddress);
  const phones = multilineField(receipt.companyPhone);
  const emails = multilineField(receipt.companyEmail);
  const accountTitle = escapeReceiptHtml(receipt.account);
  const outer = RECEIPT_OUTER_PX;
  const inner = RECEIPT_INNER_PX;
  const inset = RECEIPT_INSET_LEFT_PX;
  const pr = RECEIPT_PAD_RIGHT_PX;
  const rule = '-'.repeat(20);

  const discountBlock =
    discount > 0
      ? amountRowHtml(`Discount (${discountDays}d):`, `-${money(discount)}`)
      : '';

  const printScript = autoPrint
    ? `<script>
    (function () {
      function closeWin() { try { window.close(); } catch (e) {} }
      window.addEventListener('afterprint', function () { setTimeout(closeWin, 120); });
      try {
        var mql = window.matchMedia('print');
        mql.addEventListener('change', function (mq) { if (!mq.matches) setTimeout(closeWin, 200); });
      } catch (e) {}
      window.onload = function () {
        setTimeout(function () {
          try { window.focus(); window.print(); } catch (e) { closeWin(); }
        }, 300);
      };
    })();
  </script>`
    : '';

  const headerAddr = addressLines.map((l) => `<div class="addr">${escapeReceiptHtml(l)}</div>`).join('');
  const footerAddr = addressLines.map((l) => `<div class="biz">${escapeReceiptHtml(l)}</div>`).join('');
  const footerPhones = phones.map((l) => `<div class="biz">${escapeReceiptHtml(l)}</div>`).join('');
  const footerEmails = emails.map((l) => `<div class="biz">${escapeReceiptHtml(l)}</div>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=${outer}, initial-scale=1" />
  <title>Receipt ${accountTitle}</title>
  <style>
    @page { margin: 0; size: 58mm auto; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      background: #fff;
      color: #000;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 11px;
      line-height: 1.3;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .page {
      width: ${outer}px;
      max-width: ${outer}px;
      margin: 0;
      padding: 4px ${pr}px 6px ${inset}px;
      overflow: hidden;
    }
    .ticket {
      width: ${inner}px;
      max-width: ${inner}px;
      overflow: hidden;
    }
    .brand {
      text-align: center;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      line-height: 1.2;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .addr, .biz, .when, .thanks, .disclaimer, .rule {
      text-align: center;
      word-break: break-word;
      overflow-wrap: anywhere;
      max-width: 100%;
    }
    .addr, .biz { font-size: 10px; font-weight: 600; margin-top: 2px; }
    .when { font-size: 10px; font-weight: 700; margin: 6px 0 5px; }
    .rule { font-size: 10px; margin: 6px 0; }
    .field { margin: 5px 0; max-width: 100%; }
    .lab { font-size: 11px; font-weight: 600; text-align: left; line-height: 1.2; }
    .val {
      font-size: 11px;
      font-weight: 700;
      text-align: right;
      padding-right: 2px;
      margin-top: 1px;
      word-break: break-word;
      overflow-wrap: anywhere;
      max-width: 100%;
    }
    .val-bold { font-size: 12px; font-weight: 800; }
    .amount-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 8px;
      margin: 4px 0;
      max-width: 100%;
    }
    .amount-lab {
      flex: 0 0 auto;
      font-size: 11px;
      font-weight: 600;
      text-align: left;
    }
    .amount-val {
      flex: 1 1 auto;
      min-width: 0;
      font-size: 11px;
      font-weight: 700;
      text-align: right;
      padding-right: 2px;
      word-break: break-word;
      overflow-wrap: anywhere;
    }
    .amount-row-total { margin-top: 5px; }
    .amount-row-total .amount-lab,
    .amount-row-total .amount-val { font-size: 12px; font-weight: 800; }
    .thanks { font-size: 11px; font-weight: 700; margin: 5px 0; }
    .disclaimer {
      font-size: 9px;
      font-weight: 800;
      text-transform: uppercase;
      margin-top: 3px;
    }
    @media screen {
      html { background: #e5e7eb; }
      body { padding: 12px 0; }
      .page {
        margin: 0 auto;
        background: #fff;
        box-shadow: 0 4px 16px rgba(0,0,0,0.12);
      }
    }
    @media print {
      html, body {
        width: ${outer}px !important;
        max-width: ${outer}px !important;
        margin: 0 !important;
        padding: 0 !important;
      }
      .page {
        width: ${outer}px !important;
        max-width: ${outer}px !important;
        padding: 2px ${pr}px 4px ${inset}px !important;
        margin: 0 !important;
        zoom: 0.92;
      }
      .ticket {
        width: ${inner}px !important;
        max-width: ${inner}px !important;
      }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="ticket">
    ${centerHtml(companyRaw, 'brand')}
    ${headerAddr}
    <div class="when">${when}</div>
    <div class="rule">${rule}</div>
    ${fieldHtml('Account #:', String(receipt.account || ''))}
    ${fieldHtml('Customer:', String(receipt.customer || ''))}
    ${fieldHtml('Extension:', extension)}
    ${fieldHtml('Plan:', String(receipt.plan || ''))}
    ${fieldHtml('Next due:', String(receipt.newDue || ''))}
    <div class="rule">${rule}</div>
    ${amountRowHtml('Subtotal:', money(subtotal))}
    ${discountBlock}
    ${amountRowHtml('TOTAL:', money(total), true)}
    <div class="rule">${rule}</div>
    <div class="thanks">Thank you for your payment.</div>
    <div class="rule">${rule}</div>
    ${centerHtml(companyRaw, 'brand')}
    ${footerAddr}
    ${footerPhones}
    ${footerEmails}
    <div class="rule">${rule}</div>
    <div class="disclaimer">THIS IS NOT AN OFFICIAL RECEIPT</div>
    </div>
  </div>
  ${printScript}
</body>
</html>`;
}

/** Desktop browser: popup print window. Returns false if blocked (caller should show modal). */
export function printReceiptInBrowser(receipt: PaymentReceipt): boolean {
  const html = buildReceiptHtml(receipt, { autoPrint: true });
  const popup = window.open('', '_blank', `width=${RECEIPT_OUTER_PX + 32},height=760,left=0,top=0`);
  if (!popup) return false;
  popup.document.open();
  popup.document.write(html);
  popup.document.close();
  return true;
}

/** Open receipt in browser print dialog or in-app modal (Android/Capacitor). */
export function openReceiptForPrint(
  receipt: PaymentReceipt,
  onModal: (receipt: PaymentReceipt) => void
): void {
  if (shouldUseReceiptModal() || !printReceiptInBrowser(receipt)) {
    onModal(receipt);
  }
}

/** Prefer in-app receipt UI on Capacitor — Android WebView print dialog often freezes the app. */
export function shouldUseReceiptModal(): boolean {
  return isNativeApp();
}
