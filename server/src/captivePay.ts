/**
 * Captive (non-payment webproxy) PayMongo checkout helpers.
 *
 * Subscribers are often behind a CPE, so the browser only sees a LAN IP —
 * not the PPPoE address on MikroTik. Identity comes from:
 *  1) clientIp in the body when the page can detect the non-pay pool address
 *  2) otherwise the HTTP peer / X-Forwarded-For when the request is made
 *     through MikroTik transparent webproxy (anonymous=no) to the billing LAN
 *
 * We resolve that address via MikroTik /ppp/active, then create/reuse a
 * payment link and start PayMongo hosted checkout.
 */
import { db } from './db.js';
import { fetchPppActive, withRouter, DEFAULT_LANDING_ADDRESS, type RouterConn } from './mikrotik.js';
import { ensureFreshPayLink, resolvePublicBaseUrl } from './billing.js';
import { createPaymongoCheckout, ensurePaymongoColumns, getPublicPayOptions } from './paymongo.js';

const DEFAULT_NONPAY_CIDR = '172.15.10.0/24';

export type CaptiveMatchBy = 'ip' | 'username' | 'account';

function routerConn(r: any): RouterConn | null {
  const host = String(r?.host || '').trim();
  const api_user = String(r?.api_user || '').trim();
  if (!host || !api_user) return null;
  return {
    host,
    port: Number(r.port) || 8728,
    api_user,
    api_pass: String(r.api_pass || ''),
  };
}

/** Parse IPv4 "a.b.c.d" → uint32 or null. */
function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

/** True if ip is inside cidr (e.g. 172.15.10.0/24). */
export function ipv4InCidr(ip: string, cidr: string): boolean {
  const [net, bitsRaw] = String(cidr || '').trim().split('/');
  const bits = Math.min(32, Math.max(0, Number(bitsRaw) || 0));
  const ipN = ipv4ToInt(ip);
  const netN = ipv4ToInt(net);
  if (ipN == null || netN == null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (ipN & mask) === (netN & mask);
}

export function normalizeIp(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/^::ffff:/i, '');
}

/**
 * Pick the subscriber PPP IP from the HTTP request.
 * Prefer X-Forwarded-For entries that fall in the non-pay pool (MikroTik
 * webproxy sets this when anonymous=no), then req.ip / socket.
 */
export function captivePeerIp(
  req: { ip?: string; headers?: Record<string, unknown>; socket?: { remoteAddress?: string } },
  nonPayCidr: string = DEFAULT_NONPAY_CIDR
): string | null {
  const cidr = String(nonPayCidr || DEFAULT_NONPAY_CIDR).trim() || DEFAULT_NONPAY_CIDR;
  const candidates: string[] = [];
  const xff = String(req.headers?.['x-forwarded-for'] || '');
  for (const part of xff.split(',')) {
    const ip = normalizeIp(part);
    if (ipv4ToInt(ip)) candidates.push(ip);
  }
  const xri = normalizeIp(String(req.headers?.['x-real-ip'] || ''));
  if (ipv4ToInt(xri)) candidates.push(xri);
  const rip = normalizeIp(String(req.ip || req.socket?.remoteAddress || ''));
  if (ipv4ToInt(rip)) candidates.push(rip);
  for (const ip of candidates) {
    if (ipv4InCidr(ip, cidr)) return ip;
  }
  return null;
}

export async function findPppUsernameByAddress(
  ip: string,
  opts?: { routerId?: number | null; timeoutMs?: number }
): Promise<{ username: string; routerId: number; address: string } | null> {
  const want = normalizeIp(ip);
  if (!ipv4ToInt(want)) return null;

  let routers = db.prepare('SELECT * FROM routers ORDER BY id ASC').all() as any[];
  if (opts?.routerId) {
    routers = routers.filter((r) => Number(r.id) === Number(opts.routerId));
  }

  const timeoutMs = Math.max(2000, Math.min(20000, Number(opts?.timeoutMs) || 8000));

  for (const r of routers) {
    const conn = routerConn(r);
    if (!conn) continue;
    try {
      const sessions = await Promise.race([
        fetchPppActive(conn),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
      ]);
      const hit = (sessions || []).find((s) => normalizeIp(s.address) === want);
      if (hit?.name) {
        return { username: hit.name, routerId: Number(r.id), address: normalizeIp(hit.address) };
      }
    } catch {
      /* try next router */
    }
  }
  return null;
}

/**
 * When the browser is behind a CPE, WebRTC cannot see the PPPoE IP and LAN
 * proxy X-Forwarded-For may be overwritten by nginx. Fall back: look at who
 * is actively hitting the captive webproxy (1.1.10.1:8080) on the non-pay
 * pool. If exactly one PPPoE username maps to those connections, use it.
 */
export async function findCaptiveIdentityFromProxyActivity(opts?: {
  nonPayCidr?: string;
  landingAddress?: string;
  proxyPort?: number;
  timeoutMs?: number;
}): Promise<{ username: string; address: string; routerId: number } | null> {
  const nonPayCidr = String(opts?.nonPayCidr || DEFAULT_NONPAY_CIDR).trim() || DEFAULT_NONPAY_CIDR;
  const landing = String(opts?.landingAddress || DEFAULT_LANDING_ADDRESS).trim() || DEFAULT_LANDING_ADDRESS;
  const proxyPort = String(opts?.proxyPort || 8080);
  const timeoutMs = Math.max(2000, Math.min(15000, Number(opts?.timeoutMs) || 6000));
  const routers = db.prepare('SELECT * FROM routers ORDER BY id ASC').all() as any[];

  for (const r of routers) {
    const conn = routerConn(r);
    if (!conn) continue;
    try {
      const result = await Promise.race([
        withRouter(
          conn,
          async (api) => {
            const [conns, sessions] = await Promise.all([
              api.write('/ip/firewall/connection/print') as Promise<Record<string, string>[]>,
              api.write('/ppp/active/print') as Promise<Record<string, string>[]>,
            ]);

            const nonpaySessions = (sessions || [])
              .map((s) => ({
                username: String(s.name || '').trim(),
                address: normalizeIp(s.address || ''),
              }))
              .filter((s) => s.username && s.address && ipv4InCidr(s.address, nonPayCidr));

            // Common case: only one subscriber on the non-pay pool right now.
            if (nonpaySessions.length === 1) {
              return nonpaySessions;
            }

            const activeIps = new Set<string>();
            for (const c of conns || []) {
              const src = normalizeIp(String(c['src-address'] || '').split(':')[0] || '');
              const dst = normalizeIp(String(c['dst-address'] || '').split(':')[0] || '');
              const dport = String(c['dst-port'] || '');
              if (!src || !ipv4InCidr(src, nonPayCidr)) continue;
              if (dport === proxyPort || dport === '9080' || dst === landing) {
                activeIps.add(src);
              }
            }

            const matches = nonpaySessions.filter((s) => activeIps.has(s.address));
            // Dedupe by username
            const seen = new Set<string>();
            return matches.filter((s) => {
              const k = s.username.toLowerCase();
              if (seen.has(k)) return false;
              seen.add(k);
              return true;
            });
          },
          { timeoutSec: Math.ceil(timeoutMs / 1000) }
        ),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
      ]);

      if (result.length === 1) {
        return { ...result[0], routerId: Number(r.id) };
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

function findPppoeUser(opts: {
  username?: string | null;
  account?: string | null;
}): any | null {
  const username = String(opts.username || '').trim();
  const account = String(opts.account || '').trim();
  if (username) {
    const byUser = db
      .prepare(`SELECT * FROM pppoe_users WHERE lower(username) = lower(?) LIMIT 1`)
      .get(username) as any;
    if (byUser) return byUser;
  }
  if (account) {
    const byAcct = db
      .prepare(
        `SELECT * FROM pppoe_users
         WHERE cast(account_number as text) = ?
            OR lower(cast(account_number as text)) = lower(?)
         LIMIT 1`
      )
      .get(account, account) as any;
    if (byAcct) return byAcct;
    // Captive form may put PPPoE username in the account field
    const byUserAsAcct = db
      .prepare(`SELECT * FROM pppoe_users WHERE lower(username) = lower(?) LIMIT 1`)
      .get(account) as any;
    if (byUserAsAcct) return byUserAsAcct;
  }
  return null;
}

export async function resolveCaptiveSubscriber(opts: {
  clientIp?: string | null;
  username?: string | null;
  account?: string | null;
  nonPayCidr?: string;
}): Promise<{
  user: any;
  matchedBy: CaptiveMatchBy;
  clientIp?: string;
}> {
  const nonPayCidr = String(opts.nonPayCidr || DEFAULT_NONPAY_CIDR).trim() || DEFAULT_NONPAY_CIDR;
  const clientIp = normalizeIp(String(opts.clientIp || ''));
  const username = String(opts.username || '').trim();
  const account = String(opts.account || '').trim();

  if (clientIp) {
    if (!ipv4InCidr(clientIp, nonPayCidr)) {
      throw Object.assign(new Error(`IP must be in the non-payment pool (${nonPayCidr})`), {
        status: 400,
        code: 'IP_NOT_NONPAY',
      });
    }
    const session = await findPppUsernameByAddress(clientIp);
    if (!session) {
      throw Object.assign(
        new Error('No active PPPoE session found for that IP. Reconnect, then try again.'),
        { status: 404, code: 'PPP_SESSION_NOT_FOUND' }
      );
    }
    const user = findPppoeUser({ username: session.username });
    if (!user) {
      throw Object.assign(
        new Error(`Session "${session.username}" is online but not in the billing panel.`),
        { status: 404, code: 'USER_NOT_IN_PANEL' }
      );
    }
    return { user, matchedBy: 'ip', clientIp };
  }

  if (username) {
    const user = findPppoeUser({ username });
    if (!user) {
      throw Object.assign(new Error('Account / username not found'), {
        status: 404,
        code: 'USER_NOT_FOUND',
      });
    }
    return { user, matchedBy: 'username' };
  }

  if (account) {
    const user = findPppoeUser({ account });
    if (!user) {
      throw Object.assign(new Error('Account / username not found'), {
        status: 404,
        code: 'USER_NOT_FOUND',
      });
    }
    return { user, matchedBy: 'account' };
  }

  // CPE / nginx may hide the PPP IP — infer from who is on the captive portal now.
  const inferred = await findCaptiveIdentityFromProxyActivity({ nonPayCidr });
  if (inferred) {
    const user = findPppoeUser({ username: inferred.username });
    if (user) {
      return { user, matchedBy: 'ip', clientIp: inferred.address };
    }
  }

  throw Object.assign(
    new Error(
      'Could not identify your session. Reconnect PPPoE, open this page over HTTP on the non-payment connection, then try again.'
    ),
    { status: 400, code: 'MISSING_IDENTITY' }
  );
}

export async function startCaptivePaymongoCheckout(opts: {
  clientIp?: string | null;
  username?: string | null;
  account?: string | null;
  nonPayCidr?: string;
  publicBaseUrl?: string;
}): Promise<{
  checkoutUrl: string;
  checkoutId?: string;
  token: string;
  amount: number;
  months: number;
  username: string;
  account: string | null;
  customer: string | null;
  matchedBy: CaptiveMatchBy;
  clientIp?: string;
  payUrl: string;
}> {
  ensurePaymongoColumns();
  const payOpts = getPublicPayOptions();
  if (!payOpts.paymongo) {
    throw Object.assign(new Error('PayMongo is not enabled on this panel'), {
      status: 400,
      code: 'PAYMONGO_DISABLED',
    });
  }

  const resolved = await resolveCaptiveSubscriber(opts);
  const user = resolved.user;

  const baseResolved = resolvePublicBaseUrl(opts.publicBaseUrl);
  const base =
    baseResolved.baseUrl ||
    String(
      (db.prepare('SELECT public_base_url FROM app_settings WHERE id = 1').get() as any)
        ?.public_base_url || ''
    ).replace(/\/$/, '') ||
    'https://panorth.tsogs.cloud';

  const link = ensureFreshPayLink(Number(user.id), base, { createdBy: 'portal' });
  const successUrl = `${base}/pay/${link.token}?paid=1`;
  const cancelUrl = `${base}/pay/${link.token}?canceled=1`;
  const checkout = await createPaymongoCheckout({
    token: link.token,
    successUrl,
    cancelUrl,
  });

  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
    'info',
    'captive',
    `Captive PayMongo checkout for ${user.username} via ${resolved.matchedBy}` +
      (resolved.clientIp ? ` ip=${resolved.clientIp}` : '')
  );

  return {
    checkoutUrl: checkout.checkoutUrl!,
    checkoutId: checkout.checkoutId,
    token: link.token,
    amount: Number(link.amount) || 0,
    months: Number(link.months) || 1,
    username: String(user.username || ''),
    account: user.account_number != null ? String(user.account_number) : null,
    customer: user.customer_name != null ? String(user.customer_name) : null,
    matchedBy: resolved.matchedBy,
    clientIp: resolved.clientIp,
    payUrl: link.url || `${base}/pay/${link.token}`,
  };
}
