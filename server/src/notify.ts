import { db } from './db.js';
import { buildBrandedEmail, buildReceiptEmailBody, getCompanyBrand, parseLogoDataUrl } from './emailTemplate.js';

export interface NotifySettings {
  reminder_enabled: number;
  days_before: number;
  email_enabled: number;
  sms_enabled: number;
  autodisable_enabled: number;
  autodisable_hours: number;
  email_from: string;
  sms_sender: string;
  smtp_host?: string | null;
  smtp_port?: number | null;
  smtp_secure?: number | null;
  smtp_user?: string | null;
  smtp_pass?: string | null;
  smtp_from?: string | null;
  sms_api_url?: string | null;
  sms_api_user?: string | null;
  sms_api_pass?: string | null;
  sms_type?: number | null;
  sms_provider?: string | null;
}

export function getSettings(): NotifySettings {
  return db.prepare('SELECT * FROM notify_settings WHERE id = 1').get() as NotifySettings;
}

// Never leak stored secrets to the client; report only whether they are set.
export function getPublicSettings() {
  const s = getSettings();
  return {
    ...s,
    smtp_pass: undefined,
    sms_api_pass: undefined,
    smtp_pass_set: !!s.smtp_pass,
    sms_api_pass_set: !!s.sms_api_pass,
  };
}

const COLS = [
  'reminder_enabled', 'days_before', 'email_enabled', 'sms_enabled', 'autodisable_enabled',
  'autodisable_hours', 'email_from', 'sms_sender', 'smtp_host', 'smtp_port', 'smtp_secure',
  'smtp_user', 'smtp_pass', 'smtp_from', 'sms_api_url', 'sms_api_user', 'sms_api_pass', 'sms_type', 'sms_provider',
];
const BOOL_COLS = new Set(['reminder_enabled', 'email_enabled', 'sms_enabled', 'autodisable_enabled', 'smtp_secure']);

export function updateSettings(patch: Record<string, any>) {
  const cur = getSettings() as Record<string, any>;
  for (const col of COLS) {
    if (!(col in patch)) continue;
    // Ignore blank password fields so a save doesn't wipe stored secrets.
    if ((col === 'smtp_pass' || col === 'sms_api_pass') && (patch[col] == null || patch[col] === '')) continue;
    let val = patch[col];
    if (BOOL_COLS.has(col)) val = val ? 1 : 0;
    cur[col] = val;
  }
  db.prepare(
    `UPDATE notify_settings SET
       reminder_enabled=@reminder_enabled, days_before=@days_before, email_enabled=@email_enabled,
       sms_enabled=@sms_enabled, autodisable_enabled=@autodisable_enabled, autodisable_hours=@autodisable_hours,
       email_from=@email_from, sms_sender=@sms_sender, smtp_host=@smtp_host, smtp_port=@smtp_port,
       smtp_secure=@smtp_secure, smtp_user=@smtp_user, smtp_pass=@smtp_pass, smtp_from=@smtp_from,
       sms_api_url=@sms_api_url, sms_api_user=@sms_api_user, sms_api_pass=@sms_api_pass, sms_type=@sms_type,
       sms_provider=@sms_provider
     WHERE id=1`
  ).run({
    reminder_enabled: cur.reminder_enabled ? 1 : 0,
    days_before: Number(cur.days_before) || 3,
    email_enabled: cur.email_enabled ? 1 : 0,
    sms_enabled: cur.sms_enabled ? 1 : 0,
    autodisable_enabled: cur.autodisable_enabled ? 1 : 0,
    autodisable_hours: Number(cur.autodisable_hours) || 24,
    email_from: cur.email_from || 'billing@pa-north.net',
    sms_sender: cur.sms_sender || 'PA-NORTH',
    smtp_host: cur.smtp_host || null,
    smtp_port: Number(cur.smtp_port) || 587,
    smtp_secure: cur.smtp_secure ? 1 : 0,
    smtp_user: cur.smtp_user || null,
    smtp_pass: cur.smtp_pass || null,
    smtp_from: cur.smtp_from || null,
    sms_api_url: cur.sms_api_url || null,
    sms_api_user: cur.sms_api_user || null,
    sms_api_pass: cur.sms_api_pass || null,
    sms_type: Number(cur.sms_type) || 1,
    sms_provider: cur.sms_provider || 'isms',
  });
  return getPublicSettings();
}

async function getMailer(): Promise<any> {
  try {
    const spec = 'nodemailer';
    const m: any = await import(spec);
    return m.default || m;
  } catch {
    return null;
  }
}

/** Append company name as an SMS footer signature (Company settings → name). */
export function formatSmsMessage(message: string): string {
  const body = String(message ?? '').replace(/\s+$/, '');
  if (!body) return body;
  const name = getCompanyBrand().name.trim();
  if (!name) return body;
  const signature = `— ${name}`;
  const lower = body.toLowerCase();
  if (lower.endsWith(signature.toLowerCase()) || lower.endsWith(name.toLowerCase())) return body;
  return `${body}\n\n${signature}`;
}

// Normalize a PH mobile number to international format for the SMS gateway.
function normalizePhone(n: string): string {
  const digits = (n || '').replace(/[^0-9]/g, '');
  if (digits.startsWith('63')) return digits;
  if (digits.startsWith('0')) return `63${digits.slice(1)}`;
  if (digits.startsWith('9') && digits.length === 10) return `63${digits}`;
  return digits;
}

function normalizePhoneE164(n: string): string {
  const digits = normalizePhone(n);
  return digits ? `+${digits}` : '';
}

const SMSGATE_DEFAULT_URL = 'https://api.sms-gate.app/3rdparty/v1/messages';

/** Resolve SMSGate send URL — cloud default or local Android server base. */
function resolveSmsgateMessagesUrl(apiUrl?: string | null): string {
  const raw = (apiUrl || SMSGATE_DEFAULT_URL).trim().replace(/\/+$/, '');
  if (/\/message(s)?$/i.test(raw)) return raw;
  if (/^https?:\/\//i.test(raw)) return `${raw}/message`;
  return SMSGATE_DEFAULT_URL;
}

async function sendEmailSmtp(
  s: NotifySettings,
  to: string,
  subject: string,
  message: string,
  opts?: { html?: string; logo?: ReturnType<typeof parseLogoDataUrl>; logoCid?: string | null }
) {
  const mailer = await getMailer();
  if (!mailer) return { status: 'failed', detail: 'SMTP configured but nodemailer not installed' };
  try {
    const transport = mailer.createTransport({
      host: s.smtp_host,
      port: Number(s.smtp_port) || 587,
      secure: !!s.smtp_secure,
      auth: s.smtp_user ? { user: s.smtp_user, pass: s.smtp_pass || '' } : undefined,
    });

    let html = opts?.html;
    let text = message;
    let logo = opts?.logo ?? null;
    let logoCid = opts?.logoCid ?? null;

    if (!html) {
      const branded = buildBrandedEmail({ subject, plainText: message });
      html = branded.html;
      text = branded.text;
      logo = branded.logo;
      logoCid = branded.logoCid;
    }

    const attachments =
      logo && logoCid
        ? [
            {
              filename: `logo.${logo.ext}`,
              content: logo.buffer,
              contentType: logo.mime,
              cid: logoCid,
            },
          ]
        : undefined;

    await transport.sendMail({
      from: s.smtp_from || s.email_from,
      to,
      subject,
      text,
      html,
      attachments,
    });
    return { status: 'sent', detail: `sent via SMTP ${s.smtp_host}` };
  } catch (e: any) {
    return { status: 'failed', detail: `SMTP error: ${e?.message || 'send failed'}` };
  }
}

const SEMAPHORE_DEFAULT_URL = 'https://semaphore.co/api/v4/messages';

async function sendSmsSemaphore(s: NotifySettings, to: string, message: string) {
  try {
    const url = s.sms_api_url || SEMAPHORE_DEFAULT_URL;
    const params = new URLSearchParams({
      apikey: s.sms_api_pass || '',
      number: normalizePhone(to),
      message,
    });
    if (s.sms_sender) params.set('sendername', s.sms_sender);
    const r = await fetch(url, { method: 'POST', body: params });
    const text = (await r.text()).trim();
    let data: any;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!r.ok) {
      const err = data?.message || data?.error || text.slice(0, 200);
      return { status: 'failed', detail: `Semaphore: ${err || `HTTP ${r.status}`}` };
    }
    const items = Array.isArray(data) ? data : data ? [data] : [];
    if (!items.length) {
      return { status: 'failed', detail: `Semaphore: unexpected response: ${text.slice(0, 200) || 'empty'}` };
    }
    const failed = items.filter((x: any) => String(x.status || '').toLowerCase() === 'failed');
    if (failed.length) {
      return { status: 'failed', detail: `Semaphore: delivery failed for ${failed.map((x: any) => x.recipient || 'recipient').join(', ')}` };
    }
    const ids = items.map((x: any) => x.message_id).filter(Boolean).join(', ');
    const statuses = [...new Set(items.map((x: any) => x.status).filter(Boolean))].join(', ');
    return { status: 'sent', detail: `Semaphore: ${statuses || 'ok'}${ids ? ` (#${ids})` : ''}` };
  } catch (e: any) {
    return { status: 'failed', detail: `Semaphore error: ${e?.message || 'unreachable'}` };
  }
}

async function sendSmsSmsgate(s: NotifySettings, to: string, message: string) {
  if (!s.sms_api_user || !s.sms_api_pass) {
    return { status: 'failed', detail: 'SMSGate: username and password required' };
  }
  try {
    const phone = normalizePhoneE164(to);
    if (!phone) return { status: 'failed', detail: 'SMSGate: invalid phone number' };
    const url = resolveSmsgateMessagesUrl(s.sms_api_url);
    const auth = Buffer.from(`${s.sms_api_user}:${s.sms_api_pass}`).toString('base64');
    const body: Record<string, unknown> = {
      textMessage: { text: message },
      phoneNumbers: [phone],
    };
    const sim = Number(s.sms_type);
    if (sim >= 1 && sim <= 3) body.simNumber = sim;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(body),
    });
    const text = (await r.text()).trim();
    let data: any;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!r.ok) {
      const err = data?.message || data?.error || text.slice(0, 200);
      return { status: 'failed', detail: `SMSGate: ${err || `HTTP ${r.status}`}` };
    }
    const item = Array.isArray(data) ? data[0] : data;
    const id = item?.id || item?.messageId || item?.message_id;
    const state = item?.state || item?.status || 'queued';
    return { status: 'sent', detail: `SMSGate: ${state}${id ? ` (#${id})` : ''}` };
  } catch (e: any) {
    return { status: 'failed', detail: `SMSGate error: ${e?.message || 'unreachable'}` };
  }
}

async function sendSmsBulk(s: NotifySettings, to: string, message: string) {
  try {
    const url = new URL(s.sms_api_url as string);
    url.searchParams.set('un', s.sms_api_user || '');
    url.searchParams.set('pwd', s.sms_api_pass || '');
    url.searchParams.set('dstno', normalizePhone(to));
    url.searchParams.set('msg', message);
    url.searchParams.set('type', String(Number(s.sms_type) || 1));
    url.searchParams.set('agreedterm', 'YES');
    if (s.sms_sender) url.searchParams.set('sendid', s.sms_sender);
    const r = await fetch(url.toString(), { method: 'GET' });
    const body = (await r.text()).trim();
    // iSMS returns a numeric status code (e.g. 2000 = success) in the body.
    const ok = r.ok && /2000|success|ok/i.test(body);
    return ok ? { status: 'sent', detail: `iSMS: ${body || 'ok'}` } : { status: 'failed', detail: `iSMS: ${body || `HTTP ${r.status}`}` };
  } catch (e: any) {
    return { status: 'failed', detail: `SMS gateway error: ${e?.message || 'unreachable'}` };
  }
}

function daysUntil(due?: string | null): number | null {
  if (!due) return null;
  const raw = String(due).trim();
  const day = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) return null;
    const dueDay = new Date(parsed).toISOString().slice(0, 10);
    const dueMs = new Date(`${dueDay}T00:00:00Z`).getTime();
    const todayMs = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`).getTime();
    return Math.round((dueMs - todayMs) / 86400000);
  }
  const dueMs = new Date(`${day}T00:00:00Z`).getTime();
  const todayMs = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`).getTime();
  return Math.round((dueMs - todayMs) / 86400000);
}

/** Hours past the end of the due date (positive = overdue). Null if no/invalid due or still on/before due day. */
export function hoursPastDue(due?: string | null): number | null {
  if (!due) return null;
  const raw = String(due).trim();
  let dueDay = raw.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDay)) {
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) return null;
    dueDay = new Date(parsed).toISOString().slice(0, 10);
  }
  // Account remains valid through the due date; overdue clock starts at next midnight UTC.
  const overdueFrom = new Date(`${dueDay}T00:00:00Z`).getTime() + 24 * 3600000;
  if (!Number.isFinite(overdueFrom)) return null;
  const hours = (Date.now() - overdueFrom) / 3600000;
  return hours > 0 ? hours : null;
}

/** True when the subscription due date has passed (account is expired / overdue). */
export function isSubscriptionExpired(due?: string | null): boolean {
  return hoursPastDue(due) != null;
}

/**
 * Dashboard “Expired” accounts: past due date, or billing status already marked
 * expired / non-payment / disabled-after-nonpayment.
 */
export function isExpiredAccount(row: {
  status?: string | null;
  panelStatus?: string | null;
  subscriptionDue?: string | null;
  subscription_due?: string | null;
  nonpaymentSince?: string | null;
  nonpayment_since?: string | null;
}): boolean {
  const panel = String(row.panelStatus ?? row.status ?? '')
    .toLowerCase()
    .replace(/\s+/g, '-');
  if (panel === 'expired' || panel === 'non-payment' || panel === 'nonpayment') return true;
  const due = row.subscriptionDue ?? row.subscription_due ?? null;
  const npSince = row.nonpaymentSince ?? row.nonpayment_since ?? null;
  if (panel === 'disabled' && (npSince || isSubscriptionExpired(due))) return true;
  return isSubscriptionExpired(due);
}

/**
 * Dashboard “Non-payment” accounts: limited / unpaid billing hold.
 * Includes explicit status, nonpayment_since (also after auto-disable), and
 * live MikroTik profile on the expire / non-payments profile.
 */
export function isNonPaymentAccount(row: {
  status?: string | null;
  panelStatus?: string | null;
  nonpaymentSince?: string | null;
  nonpayment_since?: string | null;
  mikrotikProfile?: string | null;
  expirationProfile?: string | null;
  expiration_profile?: string | null;
}): boolean {
  const panel = String(row.panelStatus ?? row.status ?? '')
    .toLowerCase()
    .replace(/\s+/g, '-');
  if (panel === 'non-payment' || panel === 'nonpayment' || panel === 'expired') return true;

  const npSince = row.nonpaymentSince ?? row.nonpayment_since ?? null;
  if (npSince) return true;

  const mt = String(row.mikrotikProfile || '').trim().toLowerCase();
  if (!mt) return false;
  if (/non[-_\s]?pay/.test(mt)) return true;
  const exp = String(row.expirationProfile ?? row.expiration_profile ?? '')
    .trim()
    .toLowerCase();
  if (exp && mt === exp && /non[-_\s]?pay/.test(exp)) return true;
  return false;
}

/** Billing-active accounts — shared by Account Status + Router Status tiles. */
export function isBillingActiveAccount(row: {
  status?: string | null;
  panelStatus?: string | null;
  nonpaymentSince?: string | null;
  nonpayment_since?: string | null;
  mikrotikProfile?: string | null;
  expirationProfile?: string | null;
  expiration_profile?: string | null;
}): boolean {
  const panel = String(row.panelStatus ?? row.status ?? '')
    .toLowerCase()
    .replace(/\s+/g, '-');
  if (panel !== 'active') return false;
  return !isNonPaymentAccount(row);
}

function statusKey(status?: string | null): string {
  return String(status || '').toLowerCase().replace(/\s+/g, '-');
}

/**
 * Deliver a single notification. Real delivery happens when a gateway webhook
 * is configured (NOTIFY_EMAIL_WEBHOOK / NOTIFY_SMS_WEBHOOK); otherwise the
 * message is recorded as simulated so the workflow is fully demonstrable
 * without external credentials.
 */
async function deliver(
  channel: 'email' | 'sms',
  recipient: string | null,
  subject: string,
  message: string,
  opts?: { html?: string; logo?: ReturnType<typeof parseLogoDataUrl>; logoCid?: string | null }
) {
  if (!recipient) return { status: 'failed', detail: `no ${channel} address on file` };
  const s = getSettings();
  const outbound = channel === 'sms' ? formatSmsMessage(message) : message;

  if (channel === 'email' && s.smtp_host) return sendEmailSmtp(s, recipient, subject, outbound, opts);
  if (channel === 'sms' && s.sms_api_pass) {
    const provider = String(s.sms_provider || 'isms').toLowerCase();
    if (provider === 'semaphore') return sendSmsSemaphore(s, recipient, outbound);
    if (provider === 'smsgate' && s.sms_api_user) return sendSmsSmsgate(s, recipient, outbound);
    if (s.sms_api_url && s.sms_api_user) return sendSmsBulk(s, recipient, outbound);
  }

  const webhook = channel === 'email' ? process.env.NOTIFY_EMAIL_WEBHOOK : process.env.NOTIFY_SMS_WEBHOOK;
  if (webhook) {
    try {
      const branded =
        channel === 'email' && !opts?.html
          ? buildBrandedEmail({ subject, plainText: outbound })
          : null;
      const r = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel,
          to: recipient,
          subject,
          message: outbound,
          html: opts?.html || branded?.html || undefined,
        }),
      });
      return r.ok ? { status: 'sent', detail: 'delivered via gateway' } : { status: 'failed', detail: `gateway HTTP ${r.status}` };
    } catch {
      return { status: 'failed', detail: 'gateway unreachable' };
    }
  }
  return { status: 'sent', detail: `simulated (no ${channel} gateway configured)` };
}

function record(n: {
  channel: string;
  recipient: string | null;
  client_id?: number | null;
  customer_name?: string | null;
  subject?: string;
  message: string;
  type: string;
  status: string;
  detail: string;
}) {
  db.prepare(
    `INSERT INTO notifications (channel, recipient, client_id, customer_name, subject, message, type, status, detail)
     VALUES (@channel, @recipient, @client_id, @customer_name, @subject, @message, @type, @status, @detail)`
  ).run({
    channel: n.channel,
    recipient: n.recipient,
    client_id: n.client_id ?? null,
    customer_name: n.customer_name ?? null,
    subject: n.subject ?? null,
    message: n.message,
    type: n.type,
    status: n.status,
    detail: n.detail,
  });
}

interface Client {
  id: number;
  username: string;
  customer_name: string;
  email: string | null;
  contact: string | null;
  subscription_due: string | null;
  account_number?: string | null;
  profile?: string | null;
  price?: number | null;
}

// Personalize template tokens with the recipient's own details.
function fillTemplate(text: string, client: Client): string {
  if (!text) return text;
  const amount = client.price != null ? `\u20b1${Number(client.price).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
  const map: Record<string, string> = {
    name: client.customer_name || client.username || '',
    account: client.account_number || '',
    plan: client.profile || '',
    amount,
    due: (client.subscription_due || '').slice(0, 10),
    username: client.username || '',
  };
  return text.replace(/\{(name|account|plan|amount|due|username)\}/gi, (_m, k) => map[String(k).toLowerCase()] ?? '');
}

async function notifyClient(client: Client, channels: ('email' | 'sms')[], subject: string, message: string, type: string) {
  const subjectF = fillTemplate(subject, client);
  const messageF = fillTemplate(message, client);
  const results: string[] = [];
  for (const ch of channels) {
    const recipient = ch === 'email' ? client.email : client.contact;
    const outbound = ch === 'sms' ? formatSmsMessage(messageF) : messageF;
    const emailOpts =
      ch === 'email'
        ? (() => {
            const branded = buildBrandedEmail({ subject: subjectF, plainText: messageF });
            return { html: branded.html, logo: branded.logo, logoCid: branded.logoCid };
          })()
        : undefined;
    const r = await deliver(ch, recipient || null, subjectF, messageF, emailOpts);
    record({
      channel: ch,
      recipient: recipient || null,
      client_id: client.id,
      customer_name: client.customer_name,
      subject: subjectF,
      message: outbound,
      type,
      status: r.status,
      detail: r.detail,
    });
    results.push(`${ch}:${r.status}`);
  }
  return results;
}

/** Public wrapper used by fair-use / billing modules. */
export async function notifyClientChannels(
  client: any,
  channels: ('email' | 'sms')[],
  subject: string,
  message: string,
  type: string
) {
  return notifyClient(client as Client, channels, subject, message, type);
}

/** Send a branded HTML payment receipt email to a subscriber. */
export async function sendPaymentReceiptEmail(opts: {
  to: string;
  clientId?: number;
  customerName?: string | null;
  receipt: any;
}): Promise<{ sent: boolean; detail: string }> {
  const subject = `Payment Receipt — ${opts.receipt?.account || opts.customerName || 'Account'}`;
  const { bodyHtml, plainText } = buildReceiptEmailBody(opts.receipt);
  const branded = buildBrandedEmail({ subject, bodyHtml, plainText, isPaymentConfirmation: true });
  const r = await deliver('email', opts.to, subject, plainText, {
    html: branded.html,
    logo: branded.logo,
    logoCid: branded.logoCid,
  });
  record({
    channel: 'email',
    recipient: opts.to,
    client_id: opts.clientId ?? null,
    customer_name: opts.customerName ?? opts.receipt?.customer ?? null,
    subject,
    message: plainText,
    type: 'payment_receipt',
    status: r.status,
    detail: r.detail,
  });
  return { sent: r.status === 'sent', detail: r.detail };
}

/** Manual broadcast/one-off send initiated from the Notifications page. */
export async function sendManual(opts: {
  channel: 'email' | 'sms' | 'both';
  target: 'all' | 'client' | 'selected';
  clientId?: number;
  clientIds?: number[];
  service?: string;
  subject?: string;
  message: string;
}) {
  const channels: ('email' | 'sms')[] = opts.channel === 'both' ? ['email', 'sms'] : [opts.channel];
  const base = 'SELECT id, username, customer_name, email, contact, subscription_due, account_number, profile, price FROM pppoe_users';
  let clients: Client[];
  if (opts.target === 'client' && opts.clientId) {
    clients = db.prepare(`${base} WHERE id = ?`).all(opts.clientId) as Client[];
  } else if (opts.target === 'selected' && opts.clientIds?.length) {
    const ph = opts.clientIds.map(() => '?').join(',');
    clients = db.prepare(`${base} WHERE id IN (${ph})`).all(...opts.clientIds) as Client[];
  } else {
    clients = db.prepare(base).all() as Client[];
  }
  let sent = 0;
  let skipped = 0;
  for (const c of clients) {
    const hasTarget = channels.some((ch) => (ch === 'email' ? c.email : c.contact));
    if (!hasTarget) {
      skipped++;
      continue;
    }
    await notifyClient(c, channels, opts.subject || 'Notice from Pa-North', opts.message, 'manual');
    sent++;
  }
  return { recipients: clients.length, sent, skipped };
}

/** Reminder (N days before expiry) + expire-profile switch + auto-disable on MikroTik. */
export async function runAutomations(opts?: { service?: string }) {
  const result = await executeBillingEnforcement({ service: opts?.service });
  return {
    remindersSent: result.remindersSent,
    marked: result.markedNonPayment,
    profileSwitched: result.profileSwitched,
    disabled: result.disabled,
    routerErrors: result.routerErrors,
  };
}

export type BillingCandidate = {
  id: number;
  username: string;
  customer: string;
  service: string;
  status: string;
  due: string | null;
  daysOverdue: number;
  hoursOverdue: number;
  hoursInNonPayment: number | null;
  profile: string;
  action: 'expire' | 'disable';
};

function classifyOverdueUser(
  u: any,
  graceHours: number
): BillingCandidate | null {
  const hoursOverdue = hoursPastDue(u.subscription_due);
  if (hoursOverdue == null) return null;
  const st = statusKey(u.status);
  if (st === 'disabled') return null;

  const d = daysUntil(u.subscription_due);
  const hoursInNp = u.nonpayment_since
    ? (Date.now() - Date.parse(u.nonpayment_since)) / 3600000
    : null;

  const base: BillingCandidate = {
    id: u.id,
    username: u.username,
    customer: u.customer_name || u.username,
    service: u.service || 'pppoe',
    status: u.status,
    due: u.subscription_due || null,
    daysOverdue: d != null && d < 0 ? Math.abs(d) : Math.floor(hoursOverdue / 24),
    hoursOverdue: Math.round(hoursOverdue * 10) / 10,
    hoursInNonPayment: hoursInNp != null && Number.isFinite(hoursInNp) ? Math.round(hoursInNp * 10) / 10 : null,
    profile: u.profile || '',
    action: 'expire',
  };

  // Grace is measured from the account due date (not from when we first marked non-payment).
  if (hoursOverdue >= graceHours) {
    return { ...base, action: 'disable' };
  }

  // Within grace: move/keep on non-payment expire profile (skip if already there)
  if (st === 'non-payment' || st === 'nonpayment') return null;
  return { ...base, action: 'expire' };
}

/** Preview overdue / past-grace accounts without mutating. */
export function previewBillingEnforcement(opts?: { service?: string }): {
  toExpire: BillingCandidate[];
  toDisable: BillingCandidate[];
  graceHours: number;
  autodisableEnabled: boolean;
} {
  const s = getSettings();
  const graceHours = Math.max(1, Number(s.autodisable_hours) || 24);
  const service = opts?.service ? String(opts.service).toLowerCase() : null;
  const all = (
    service
      ? db.prepare(`SELECT * FROM pppoe_users WHERE lower(coalesce(service, 'pppoe')) = ?`).all(service)
      : db.prepare(`SELECT * FROM pppoe_users`).all()
  ) as any[];

  const toExpire: BillingCandidate[] = [];
  const toDisable: BillingCandidate[] = [];

  for (const u of all) {
    const c = classifyOverdueUser(u, graceHours);
    if (!c) continue;
    if (c.action === 'disable') toDisable.push(c);
    else toExpire.push(c);
  }

  return {
    toExpire,
    toDisable,
    graceHours,
    autodisableEnabled: !!s.autodisable_enabled,
  };
}

/** Execute expiry + auto-disable protocols (same rules as the scheduler). */
export async function executeBillingEnforcement(opts?: {
  service?: string;
  /** Manual recheck: disable past-grace even if autodisable_enabled is off */
  forceDisable?: boolean;
}): Promise<{
  remindersSent: number;
  markedNonPayment: number;
  profileSwitched: number;
  disabled: number;
  routerErrors: number;
  expired: BillingCandidate[];
  disabledUsers: BillingCandidate[];
}> {
  const s = getSettings();
  const now = Date.now();
  const forceDisable = !!opts?.forceDisable;
  const graceHours = Math.max(1, Number(s.autodisable_hours) || 24);
  const summary = {
    remindersSent: 0,
    markedNonPayment: 0,
    profileSwitched: 0,
    disabled: 0,
    routerErrors: 0,
    expired: [] as BillingCandidate[],
    disabledUsers: [] as BillingCandidate[],
  };

  const { resolvePublicBaseUrl, ensureFreshPayLink, syncUserToRouter } = await import('./billing.js');
  const { baseUrl } = resolvePublicBaseUrl();
  const service = opts?.service ? String(opts.service).toLowerCase() : null;

  const all = (
    service
      ? db.prepare(`SELECT * FROM pppoe_users WHERE lower(coalesce(service, 'pppoe')) = ?`).all(service)
      : db.prepare(`SELECT * FROM pppoe_users`).all()
  ) as (Client & {
    status: string;
    profile: string;
    password?: string;
    expiration_profile?: string;
    router_id?: number;
    nonpayment_since: string | null;
    reminder_sent: string | null;
    address?: string;
    nap_id?: number;
    plc_port?: string;
    lat?: number;
    lng?: number;
    service?: string;
  })[];

  for (const u of all) {
    const d = daysUntil(u.subscription_due);
    if (d == null) continue;
    const st = statusKey(u.status);

    // Expiry reminder + pay link
    if (s.reminder_enabled && st === 'active' && d >= 0 && d <= s.days_before && u.reminder_sent !== u.subscription_due) {
      const channels: ('email' | 'sms')[] = [];
      if (s.email_enabled) channels.push('email');
      if (s.sms_enabled) channels.push('sms');
      if (channels.length) {
        let payUrl = '';
        try {
          const link = ensureFreshPayLink(u.id, baseUrl || undefined);
          payUrl = link.url.startsWith('http') ? link.url : baseUrl ? `${baseUrl.replace(/\/$/, '')}${link.path}` : link.path;
        } catch {
          /* optional */
        }
        const subject = 'Your internet plan is about to expire';
        const msg = `Hi ${u.customer_name || u.username}, your ${u.profile} plan expires on ${u.subscription_due} (in ${d} day${d === 1 ? '' : 's'}). Please settle your payment to avoid disconnection.${payUrl ? ` Pay online: ${payUrl}` : ''}`;
        await notifyClient(u, channels, subject, msg, 'expiry_reminder');
        db.prepare('UPDATE pppoe_users SET reminder_sent = ? WHERE id = ?').run(u.subscription_due, u.id);
        summary.remindersSent++;
      }
    }

    const classified = classifyOverdueUser(u, graceHours);
    if (!classified) continue;

    // Within grace → non-payment expire profile on MikroTik (comment preserved)
    if (classified.action === 'expire') {
      if (!u.nonpayment_since) {
        db.prepare("UPDATE pppoe_users SET nonpayment_since = ?, status = 'non-payment' WHERE id = ?").run(
          new Date(now).toISOString(),
          u.id
        );
      } else {
        db.prepare("UPDATE pppoe_users SET status = 'non-payment' WHERE id = ?").run(u.id);
      }
      summary.markedNonPayment++;
      const full = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(u.id) as any;
      const sync = await syncUserToRouter(full, 'expire');
      if (sync.ok) summary.profileSwitched++;
      else summary.routerErrors++;

      summary.expired.push({ ...classified, status: 'non-payment', action: 'expire' });

      const channels: ('email' | 'sms')[] = [];
      if (s.email_enabled) channels.push('email');
      if (s.sms_enabled) channels.push('sms');
      if (channels.length) {
        let payUrl = '';
        try {
          const link = ensureFreshPayLink(u.id, baseUrl || undefined);
          payUrl = link.url.startsWith('http') ? link.url : baseUrl ? `${baseUrl.replace(/\/$/, '')}${link.path}` : link.path;
        } catch {
          /* optional */
        }
        const msg = `Hi ${u.customer_name || u.username}, your subscription is overdue (due ${u.subscription_due}). Your account was moved to the non-payment profile. Pay now to restore full speed.${payUrl ? ` ${payUrl}` : ''}`;
        await notifyClient(u, channels, 'Payment overdue — limited access', msg, 'nonpayment_notice');
      }
      continue;
    }

    // Past grace (from due date) → disable secret only (do not rewrite comment)
    if (classified.action === 'disable' && (s.autodisable_enabled || forceDisable)) {
      if (!u.nonpayment_since) {
        db.prepare("UPDATE pppoe_users SET nonpayment_since = ? WHERE id = ?").run(new Date(now).toISOString(), u.id);
      }
      db.prepare("UPDATE pppoe_users SET status = 'disabled', online = 0 WHERE id = ?").run(u.id);
      const full = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(u.id) as any;
      const sync = await syncUserToRouter(full, 'disable');
      if (!sync.ok) summary.routerErrors++;

      summary.disabled++;
      summary.disabledUsers.push({
        ...classified,
        status: 'disabled',
        action: 'disable',
        hoursInNonPayment: classified.hoursOverdue,
      });

      const channels: ('email' | 'sms')[] = [];
      if (s.email_enabled) channels.push('email');
      if (s.sms_enabled) channels.push('sms');
      let payUrl = '';
      try {
        const link = ensureFreshPayLink(u.id, baseUrl || undefined);
        payUrl = link.url.startsWith('http') ? link.url : baseUrl ? `${baseUrl.replace(/\/$/, '')}${link.path}` : link.path;
      } catch {
        /* optional */
      }
      const msg = `Hi ${u.customer_name || u.username}, your service has been disabled — subscription overdue past the ${graceHours}h grace period (due ${u.subscription_due}). Settle your balance to restore your connection.${payUrl ? ` Pay: ${payUrl}` : ''}`;
      if (channels.length) await notifyClient(u, channels, 'Service disabled — payment overdue', msg, 'auto_disable');
      db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
        'warning',
        'billing',
        `Disabled ${u.username} — ${classified.hoursOverdue}h past due (grace ${graceHours}h)${sync.ok ? ' (MikroTik synced)' : ` (router: ${sync.error})`}`
      );
    }
  }
  return summary;
}

let started = false;
export function startNotifyScheduler(intervalMs = 5 * 60 * 1000) {
  if (started) return;
  started = true;
  runAutomations().catch(() => undefined);
  setInterval(() => runAutomations().catch(() => undefined), intervalMs);
}

export function listNotifications(limit = 200) {
  return db
    .prepare('SELECT id, channel, recipient, customer_name AS customer, subject, message, type, status, detail, created_at AS date FROM notifications ORDER BY id DESC LIMIT ?')
    .all(limit);
}
