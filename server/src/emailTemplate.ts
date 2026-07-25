import { db } from './db.js';

export type CompanyBrand = {
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  logo: string | null;
};

export function getCompanyBrand(): CompanyBrand {
  const row = db.prepare('SELECT name, address, phone, email, logo FROM company WHERE id = 1').get() as
    | { name?: string; address?: string | null; phone?: string | null; email?: string | null; logo?: string | null }
    | undefined;
  return {
    name: row?.name || 'ISP Billing',
    address: row?.address || null,
    phone: row?.phone || null,
    email: row?.email || null,
    logo: row?.logo || null,
  };
}

export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function parseLogoDataUrl(logo: string | null | undefined): {
  mime: string;
  buffer: Buffer;
  ext: string;
} | null {
  if (!logo || typeof logo !== 'string') return null;
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(logo.trim());
  if (!m) return null;
  const mime = m[1].toLowerCase();
  const ext = mime.includes('png')
    ? 'png'
    : mime.includes('jpeg') || mime.includes('jpg')
      ? 'jpg'
      : mime.includes('gif')
        ? 'gif'
        : mime.includes('webp')
          ? 'webp'
          : mime.includes('svg')
            ? 'svg'
            : 'png';
  try {
    return { mime, buffer: Buffer.from(m[2].replace(/\s+/g, ''), 'base64'), ext };
  } catch {
    return null;
  }
}

const LOGO_CID = 'company-logo@mt-billing';

function nl2br(text: string): string {
  return escapeHtml(text).replace(/\r\n|\n|\r/g, '<br/>');
}

/** Wrap plain or HTML body in branded header + footer (logo + business details). */
export function buildBrandedEmail(opts: {
  subject?: string;
  /** Pre-escaped or trusted HTML body content (inner). If plainText is set and bodyHtml omitted, plain is converted. */
  bodyHtml?: string;
  plainText?: string;
  company?: CompanyBrand;
  /** Show “not an official receipt” footer — only for payment confirmation emails. */
  isPaymentConfirmation?: boolean;
}): { html: string; text: string; logoCid: string | null; logo: ReturnType<typeof parseLogoDataUrl> } {
  const company = opts.company || getCompanyBrand();
  const logo = parseLogoDataUrl(company.logo);
  const logoCid = logo ? LOGO_CID : null;
  const name = escapeHtml(company.name);
  const address = company.address ? nl2br(escapeHtml(company.address)) : '';
  const phone = company.phone ? nl2br(escapeHtml(company.phone)) : '';
  const email = company.email ? nl2br(escapeHtml(company.email)) : '';
  const showUnofficial = Boolean(opts.isPaymentConfirmation);

  const bodyHtml =
    opts.bodyHtml ||
    (opts.plainText ? `<div style="font-size:14px;line-height:1.55;color:#111827;">${nl2br(opts.plainText)}</div>` : '');

  const textParts = [
    company.name,
    opts.plainText || stripTags(opts.bodyHtml || ''),
    '',
    [company.address, company.phone || '', company.email].filter(Boolean).join('\n'),
    showUnofficial ? '' : null,
    showUnofficial ? 'This is not an official receipt / formal notice unless stated otherwise.' : null,
  ].filter((p) => p != null && String(p).length);

  const logoBlock = logoCid
    ? `<img src="cid:${logoCid}" alt="${name}" width="72" height="72" style="display:block;margin:0 auto 10px;max-width:72px;height:auto;border:0;border-radius:10px;" />`
    : '';

  const unofficialFooter = showUnofficial
    ? `<div style="font-size:11px;font-weight:700;margin-top:12px;text-transform:uppercase;color:#111827;">This is not an official receipt</div>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(opts.subject || company.name)}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;color:#111827;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
          <tr>
            <td style="padding:22px 24px 16px;text-align:center;background:#0f172a;color:#ffffff;">
              ${logoBlock}
              <div style="font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:800;letter-spacing:0.02em;text-transform:uppercase;color:#ffffff;">${name}</div>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 24px;font-family:Arial,Helvetica,sans-serif;color:#111827;">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 24px 22px;background:#f8fafc;border-top:1px solid #e5e7eb;text-align:center;font-family:Arial,Helvetica,sans-serif;color:#111827;">
              <div style="font-size:13px;font-weight:800;text-transform:uppercase;margin-bottom:6px;">${name}</div>
              ${address ? `<div style="font-size:12px;line-height:1.4;margin:2px 0;">${address}</div>` : ''}
              ${phone ? `<div style="font-size:12px;margin:2px 0;line-height:1.4;">${phone}</div>` : ''}
              ${email ? `<div style="font-size:12px;margin:2px 0;">${email}</div>` : ''}
              ${unofficialFooter}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return {
    html,
    text: textParts.join('\n'),
    logoCid,
    logo,
  };
}

function stripTags(html: string): string {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

function money(n: number): string {
  return `\u20b1${Number(n || 0).toFixed(2)}`;
}

/** HTML body for a payment receipt (placed inside branded wrapper). */
export function buildReceiptEmailBody(receipt: any): { bodyHtml: string; plainText: string } {
  const months = Number(receipt.months) || 1;
  const extension = months === 1 ? '1 month' : `${months} months`;
  const txRaw = receipt.transactionAt || receipt.paymentDate || new Date().toISOString();
  const txDate = new Date(txRaw);
  const when = Number.isFinite(txDate.getTime())
    ? txDate.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : String(txRaw);

  const rows: [string, string][] = [
    ['Account #', String(receipt.account ?? '')],
    ['Customer Name', String(receipt.customer ?? '')],
    ['Extension Availed', extension],
    ['Plan', String(receipt.plan ?? '')],
    ['Next Due Date', String(receipt.newDue ?? '')],
    ['Subtotal', money(Number(receipt.subtotal) || 0)],
  ];
  if (Number(receipt.discount) > 0) {
    rows.push([`Discount (${Number(receipt.discountDays) || 0} day/s)`, `- ${money(Number(receipt.discount))}`]);
  }
  rows.push(['TOTAL', money(Number(receipt.total) || 0)]);

  const rowHtml = rows
    .map(
      ([lab, val]) =>
        `<tr>
          <td style="padding:6px 0;font-size:12px;font-weight:700;text-transform:uppercase;color:#111827;border-bottom:1px dashed #d1d5db;">${escapeHtml(lab)}</td>
          <td style="padding:6px 0;font-size:14px;font-weight:700;text-align:right;color:#111827;border-bottom:1px dashed #d1d5db;">${escapeHtml(val)}</td>
        </tr>`
    )
    .join('');

  const bodyHtml = `
    <div style="text-align:center;margin-bottom:14px;">
      <div style="font-size:15px;font-weight:800;color:#111827;">PAYMENT RECEIPT</div>
      <div style="font-size:12px;font-weight:700;margin-top:4px;color:#111827;">${escapeHtml(when)}</div>
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rowHtml}</table>
    <p style="margin:16px 0 0;text-align:center;font-size:13px;font-weight:700;color:#111827;">Thank you for your payment.</p>
  `;

  const plainText = [
    'PAYMENT RECEIPT',
    when,
    '',
    ...rows.map(([l, v]) => `${l}: ${v}`),
    '',
    'Thank you for your payment.',
  ].join('\n');

  return { bodyHtml, plainText };
}
