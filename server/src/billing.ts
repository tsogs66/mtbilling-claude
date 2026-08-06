import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { db } from './db.js';
import {
  updatePppSecret,
  setPppSecretEnabled,
  removePppActiveByName,
  buildPppSecretComment,
  ensurePppProfile,
  scheduleExpiryOnRouter,
  cancelExpiryScheduleOnRouter,
} from './mikrotik.js';
import { getSettings as getNotifySettings } from './notify.js';
import { notifyStaff, subscriberLabel } from './staffNotifications.js';
import { pushPortalActivity } from './portalExtras.js';
import { getPaymentMerchant, listPaymentMerchants } from './paymentMerchants.js';
import { createCashierCollectible } from './cashierCollectibles.js';

const SESSION_REFRESH_MS = 2000;
/** Cap how long any single request will wait on a router call before responding anyway. */
const ROUTER_CALL_BUDGET_MS = 8000;

/**
 * Race a promise against a timeout, resolving to `fallback` if it doesn't
 * settle in time. The original promise is never cancelled — it keeps running
 * and its eventual result/error is still observable to whoever awaits it
 * separately (e.g. for background logging) — this just stops it from
 * blocking the caller indefinitely.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(fallback);
      }
    }, ms);
    promise.then(
      (v) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(v);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(fallback);
        }
      }
    );
  });
}

function needsSessionRefresh(status?: string | null): boolean {
  const s = String(status || '').toLowerCase();
  return s === 'non-payment' || s === 'nonpayment' || s === 'expired' || s === 'disabled';
}

// Errors that mean "this router will never sync until an admin fixes the
// config" — not worth queuing for retry, unlike a plain unreachable/timeout.
const ROUTER_SYNC_PERMANENT_ERRORS = new Set(['no router', 'router-not-configured']);

/**
 * Remember that a user's MikroTik state (payment restore, non-payment
 * expire, disable...) couldn't be pushed because the router was slow or
 * unreachable, so the background poller (see startRouterSyncScheduler) can
 * retry once it's back. Upserts on (router_id, pppoe_user_id) — multiple
 * failures for the same user just bump the retry time rather than stacking
 * up duplicate entries, since the poller always re-derives the *current*
 * desired state from pppoe_users rather than replaying a stored action.
 */
export function enqueueRouterSync(routerId: number | null | undefined, pppoeUserId: number, reason: string): void {
  if (!routerId) return;
  if (ROUTER_SYNC_PERMANENT_ERRORS.has(reason)) return;
  db.prepare(
    `INSERT INTO router_sync_queue (router_id, pppoe_user_id, reason, next_attempt_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(router_id, pppoe_user_id) DO UPDATE SET reason = excluded.reason, next_attempt_at = CURRENT_TIMESTAMP`
  ).run(routerId, pppoeUserId, reason);
}

/** Clear a pending retry once a user's MikroTik state is confirmed in sync (any path, not just the poller). */
export function resolveRouterSync(routerId: number | null | undefined, pppoeUserId: number): void {
  if (!routerId) return;
  db.prepare('DELETE FROM router_sync_queue WHERE router_id = ? AND pppoe_user_id = ?').run(routerId, pppoeUserId);
}

/** Map a user's current billing status to the MikroTik action that should reflect it. */
function deriveRouterActionForUser(user: any): 'restore' | 'expire' | 'disable' | null {
  const status = String(user?.status || '').toLowerCase();
  if (status === 'active') return 'restore';
  if (status === 'non-payment' || status === 'nonpayment') return 'expire';
  if (status === 'disabled' || status === 'expired') return 'disable';
  return null;
}

/**
 * Retry every queued sync whose router is now configured and due for
 * another attempt. Re-reads each user's current status rather than
 * replaying whatever originally failed, so it always converges on the
 * latest intent even if several changes queued up while offline.
 */
export async function processRouterSyncQueue(): Promise<{ attempted: number; succeeded: number }> {
  const due = db
    .prepare(`SELECT * FROM router_sync_queue WHERE next_attempt_at <= CURRENT_TIMESTAMP ORDER BY id`)
    .all() as any[];
  let succeeded = 0;
  for (const job of due) {
    const user = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(job.pppoe_user_id) as any;
    if (!user) {
      db.prepare('DELETE FROM router_sync_queue WHERE id = ?').run(job.id);
      continue;
    }
    const router = db.prepare('SELECT * FROM routers WHERE id = ?').get(job.router_id) as any;
    if (!router?.host || !router?.api_user) continue; // still not configured — leave queued

    const action = deriveRouterActionForUser(user);
    if (!action) {
      db.prepare('DELETE FROM router_sync_queue WHERE id = ?').run(job.id);
      continue;
    }

    const result = await syncUserToRouter(user, action);
    if (result.ok) {
      succeeded++;
      db.prepare('DELETE FROM router_sync_queue WHERE id = ?').run(job.id);
      db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
        'info',
        'mikrotik',
        `Router sync caught up for ${user.username} (router back online) — applied ${action}`
      );
    } else {
      const attempts = (job.attempts || 0) + 1;
      const backoffMin = Math.min(30, 2 ** attempts); // 2, 4, 8, 16, 30, 30...
      db.prepare(
        `UPDATE router_sync_queue SET attempts = ?, last_error = ?, last_attempt_at = CURRENT_TIMESTAMP,
         next_attempt_at = datetime('now', ?) WHERE id = ?`
      ).run(attempts, result.error || 'unknown error', `+${backoffMin} minutes`, job.id);
    }
  }
  return { attempted: due.length, succeeded };
}

let routerSyncPollerStarted = false;
/** Poll for pending router syncs and retry the ones that are due. */
export function startRouterSyncScheduler(intervalMs = 3 * 60 * 1000) {
  if (routerSyncPollerStarted) return;
  routerSyncPollerStarted = true;
  processRouterSyncQueue().catch(() => undefined);
  setInterval(() => processRouterSyncQueue().catch(() => undefined), intervalMs);
}

/**
 * Briefly disable then re-enable the PPP secret so MikroTik drops and refreshes
 * any active session (picks up restored plan after non-payment / expiry).
 */
export async function bouncePppSessionForRefresh(
  router: any,
  username: string,
  waitMs = SESSION_REFRESH_MS
): Promise<{ bounced: boolean; waitMs: number; error?: string }> {
  try {
    await setPppSecretEnabled(router, username, false);
    try {
      await removePppActiveByName(router, username);
    } catch {
      /* best-effort session drop */
    }
    await new Promise((r) => setTimeout(r, Math.max(0, waitMs)));
    await setPppSecretEnabled(router, username, true);
    return { bounced: true, waitMs };
  } catch (e: any) {
    try {
      await setPppSecretEnabled(router, username, true);
    } catch {
      /* leave best-effort re-enable */
    }
    return { bounced: false, waitMs, error: e?.message || String(e) };
  }
}

/** Normalize a base URL (trim, no trailing slash, ensure scheme). */
export function normalizeBaseUrl(raw?: string | null): string | undefined {
  let s = String(raw || '').trim().replace(/\/$/, '');
  if (!s) return undefined;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname) return undefined;
    return `${u.protocol}//${u.host}`;
  } catch {
    return undefined;
  }
}

/** True for localhost / RFC1918 hosts — not reachable by subscribers on the internet. */
export function isPrivateBaseUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.local')) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
    return false;
  } catch {
    return true;
  }
}

function ipv4Score(ip: string): number {
  // Prefer typical LAN ranges used on Proxmox LXCs; deprioritize Docker/CGNAT-ish ranges.
  if (/^192\.168\./.test(ip)) return 100;
  if (/^10\./.test(ip)) return 90;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) {
    if (/^172\.17\./.test(ip)) return 10; // docker0
    return 70;
  }
  return 20;
}

/** Best non-loopback IPv4 on this host (LXC/VM LAN address). */
export function detectLanIpv4(): string | null {
  const ifaces = os.networkInterfaces();
  let best: { ip: string; score: number } | null = null;
  for (const list of Object.values(ifaces)) {
    for (const iface of list || []) {
      const fam = String(iface.family);
      if ((fam !== 'IPv4' && fam !== '4') || iface.internal) continue;
      const ip = iface.address;
      if (!ip || ip.startsWith('127.')) continue;
      const score = ipv4Score(ip);
      if (!best || score > best.score) best = { ip, score };
    }
  }
  return best?.ip || null;
}

/** Suggested pay-portal base using this host's LAN IP (http://x.x.x.x). */
export function detectLanBaseUrl(port?: number | null): string | undefined {
  const ip = detectLanIpv4();
  if (!ip) return undefined;
  const p = Number(port);
  if (p && p > 0 && p !== 80) return `http://${ip}:${p}`;
  return `http://${ip}`;
}

/**
 * Public base URL for subscriber pay links (SMS/email/share).
 * Prefer configured public URL over LAN panel origin.
 */
export function resolvePublicBaseUrl(preferred?: string | null): {
  baseUrl?: string;
  source: 'public_base_url' | 'env' | 'cloudflare' | 'ngrok' | 'lan' | 'preferred' | 'none';
  warning?: string;
} {
  const app = db
    .prepare(
      `SELECT public_base_url, ngrok_url, ngrok_status,
              cf_tunnel_url, cf_tunnel_status, cf_tunnel_hostname
       FROM app_settings WHERE id = 1`
    )
    .get() as {
    public_base_url?: string;
    ngrok_url?: string;
    ngrok_status?: string;
    cf_tunnel_url?: string;
    cf_tunnel_status?: string;
    cf_tunnel_hostname?: string;
  } | undefined;

  const cfUrl =
    app?.cf_tunnel_status === 'running'
      ? normalizeBaseUrl(app?.cf_tunnel_url) ||
        (app?.cf_tunnel_hostname
          ? normalizeBaseUrl(`https://${String(app.cf_tunnel_hostname).replace(/^https?:\/\//i, '')}`)
          : undefined)
      : undefined;

  const lanUrl = detectLanBaseUrl();

  const ordered: {
    url?: string;
    source: 'public_base_url' | 'env' | 'cloudflare' | 'ngrok' | 'lan' | 'preferred';
  }[] = [
    { url: normalizeBaseUrl(app?.public_base_url), source: 'public_base_url' },
    { url: normalizeBaseUrl(process.env.PUBLIC_BASE_URL), source: 'env' },
    { url: cfUrl, source: 'cloudflare' },
    {
      url: app?.ngrok_status === 'running' ? normalizeBaseUrl(app?.ngrok_url) : undefined,
      source: 'ngrok',
    },
    { url: normalizeBaseUrl(preferred), source: 'preferred' },
    { url: lanUrl, source: 'lan' },
  ];

  const publicHit = ordered.find((c) => c.url && !isPrivateBaseUrl(c.url!));
  if (publicHit?.url) return { baseUrl: publicHit.url, source: publicHit.source };

  const anyHit = ordered.find((c) => c.url);
  if (anyHit?.url) {
    return {
      baseUrl: anyHit.url,
      source: anyHit.source,
      warning:
        anyHit.source === 'lan' || isPrivateBaseUrl(anyHit.url)
          ? 'Pay links use this panel’s LAN IP (reachable on your local network / VPN). For internet subscribers, set Cloudflare Tunnel or a public hostname.'
          : 'Pay links use a local/private address. Set a public URL (domain, Cloudflare Tunnel, or ngrok) so subscribers can open them from anywhere.',
    };
  }
  return {
    baseUrl: undefined,
    source: 'none',
    warning: 'No public pay portal URL configured. Set one under Payment Links or System Settings.',
  };
}

/** Persist LAN IP as the configured pay-portal base (clears broken placeholder public URLs). */
export function applyLanPayBaseUrl(opts?: { port?: number | null; clearCloudflare?: boolean }): {
  baseUrl: string;
  ip: string;
} {
  const base = detectLanBaseUrl(opts?.port);
  const ip = detectLanIpv4();
  if (!base || !ip) throw new Error('Could not detect a LAN IPv4 address on this host.');

  db.prepare('UPDATE app_settings SET public_base_url = ? WHERE id = 1').run(base);

  if (opts?.clearCloudflare !== false) {
    // Stop preferring a failed / placeholder Cloudflare hostname for copied links
    db.prepare(
      `UPDATE app_settings SET
         cf_tunnel_status = CASE WHEN cf_tunnel_status = 'running' THEN cf_tunnel_status ELSE 'stopped' END,
         cf_tunnel_url = CASE WHEN cf_tunnel_status = 'running' THEN cf_tunnel_url ELSE NULL END
       WHERE id = 1`
    ).run();
  }

  try {
    const envPath = path.resolve(process.cwd(), '.env');
    if (fs.existsSync(envPath)) {
      let text = fs.readFileSync(envPath, 'utf8');
      if (/^PUBLIC_BASE_URL=/m.test(text)) {
        text = text.replace(/^PUBLIC_BASE_URL=.*$/m, `PUBLIC_BASE_URL=${base}`);
      } else {
        text = `${text.replace(/\s*$/, '')}\nPUBLIC_BASE_URL=${base}\n`;
      }
      fs.writeFileSync(envPath, text);
    }
  } catch {
    /* best-effort .env sync */
  }

  return { baseUrl: base, ip };
}

export function absolutePayUrl(pathOrToken: string, preferred?: string | null): string {
  const path = pathOrToken.startsWith('/pay/')
    ? pathOrToken
    : pathOrToken.startsWith('/')
      ? pathOrToken
      : `/pay/${pathOrToken}`;
  const { baseUrl } = resolvePublicBaseUrl(preferred);
  return baseUrl ? `${baseUrl}${path}` : path;
}

export function addMonthsPreserveDay(iso: string, months: number): string {
  const raw = String(iso || '').slice(0, 10);
  const [y, m, d] = raw.split('-').map(Number);
  if (!y || !m || !d) {
    const dt = new Date();
    dt.setUTCMonth(dt.getUTCMonth() + months);
    return dt.toISOString().slice(0, 10);
  }
  const targetMonth = m - 1 + months;
  const ny = y + Math.floor(targetMonth / 12);
  const nm = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const day = Math.min(d, lastDay);
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function commentFromUser(u: any): string {
  return buildPppSecretComment({
    plan: u.profile,
    dueDate: u.subscription_due,
    expireProfile: u.expiration_profile || 'non-payments',
    accountNumber: u.account_number,
    customer: {
      fullName: u.customer_name,
      address: u.address,
      contactNumber: u.contact,
      email: u.email,
      napId: u.nap_id,
      status: u.status,
      plcPort: u.plc_port,
      latitude: u.lat,
      longitude: u.lng,
    },
  });
}

/** Billing plan row + linked MikroTik PPP profile (must already exist on the router). */
export function getBillingPlan(planName: string): {
  name: string;
  price: number;
  rateLimit: string;
  pppProfile: string;
} | null {
  const plan = String(planName || '').trim();
  if (!plan) return null;
  // Prefer type=plan (panel billing). Fall back to legacy rows without type.
  const row = db
    .prepare(
      `SELECT name, price, rate_limit, ppp_profile FROM profiles
       WHERE name = ?
       ORDER BY CASE WHEN coalesce(type, '') = 'plan' THEN 0 ELSE 1 END
       LIMIT 1`
    )
    .get(plan) as { name: string; price: number; rate_limit?: string; ppp_profile?: string } | undefined;
  if (!row) return null;
  return {
    name: row.name,
    price: Number(row.price) || 0,
    rateLimit: String(row.rate_limit || '').trim(),
    // Linked MikroTik profile only — never fall back to the plan name (do not invent profiles).
    pppProfile: String(row.ppp_profile || '').trim(),
  };
}

/** MikroTik /ppp/secret profile name for a billing plan (never creates profiles). */
export function mikrotikProfileForPlan(planName: string): string {
  return getBillingPlan(planName)?.pppProfile || '';
}

/**
 * Change a user's billing plan: update DB, rewrite PPP secret comment + profile
 * on MikroTik, then briefly disable/enable so the active session picks up the plan.
 */
export async function changePppoeUserPlan(
  userId: number,
  planName: string,
  opts?: { bounce?: boolean }
): Promise<{
  ok: boolean;
  id: number;
  username: string;
  previousPlan: string;
  plan: string;
  sync: { ok: boolean; error?: string };
  sessionRefresh: { bounced: boolean; waitMs: number; error?: string } | null;
  error?: string;
}> {
  const plan = String(planName || '').trim();
  const user = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(userId) as any;
  if (!user) {
    return {
      ok: false,
      id: userId,
      username: '',
      previousPlan: '',
      plan,
      sync: { ok: false, error: 'not-found' },
      sessionRefresh: null,
      error: 'User not found',
    };
  }

  const previousPlan = String(user.profile || '');
  const prof = getBillingPlan(plan);
  if (!prof) {
    return {
      ok: false,
      id: userId,
      username: user.username,
      previousPlan,
      plan,
      sync: { ok: false, error: 'plan-not-found' },
      sessionRefresh: null,
      error: `Billing plan "${plan}" not found`,
    };
  }
  if (!String(prof.pppProfile || '').trim()) {
    return {
      ok: false,
      id: userId,
      username: user.username,
      previousPlan,
      plan,
      sync: { ok: false, error: 'plan-missing-profile' },
      sessionRefresh: null,
      error: `Billing plan "${plan}" has no MikroTik PPP profile linked`,
    };
  }

  const price = prof.price;
  db.prepare('UPDATE pppoe_users SET profile = ?, price = ? WHERE id = ?').run(plan, price, userId);
  const updated = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(userId) as any;

  let sync: { ok: boolean; error?: string } = { ok: false, error: 'no router' };
  let sessionRefresh: { bounced: boolean; waitMs: number; error?: string } | null = null;

  if (updated?.router_id) {
    const router = db.prepare('SELECT * FROM routers WHERE id = ?').get(updated.router_id) as any;
    if (router?.host && router?.api_user) {
      try {
        // Use the plan's linked MikroTik profile only — never create profiles here.
        await updatePppSecret(router, updated.username, {
          password: updated.password || '',
          profile: prof.pppProfile,
          comment: commentFromUser({ ...updated, profile: plan }),
          disabled: false,
        });
        const isDisabled = String(updated.status || '').toLowerCase() === 'disabled';
        if (isDisabled) {
          await setPppSecretEnabled(router, updated.username, false);
          sync = { ok: true };
        } else {
          await setPppSecretEnabled(router, updated.username, true);
          sync = { ok: true };
          if (opts?.bounce !== false) {
            sessionRefresh = await bouncePppSessionForRefresh(router, updated.username, SESSION_REFRESH_MS);
          }
        }
      } catch (e: any) {
        sync = { ok: false, error: e?.message || String(e) };
      }
    }
  }

  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
    sync.ok ? 'info' : 'warning',
    'billing',
    `Plan change for ${updated.username}: ${previousPlan || '—'} → ${plan} (MT profile ${prof.pppProfile})` +
      (sessionRefresh?.bounced ? ' (2s session bounce)' : sync.error ? ` (router: ${sync.error})` : '')
  );
  if (sync.ok) {
    resolveRouterSync(updated.router_id, userId);
  } else {
    enqueueRouterSync(updated.router_id, userId, sync.error || 'Plan change sync failed');
  }

  return {
    ok: true,
    id: userId,
    username: updated.username,
    previousPlan,
    plan,
    sync,
    sessionRefresh,
    error: undefined,
  };
}

export async function bulkChangePppoeUserPlans(
  ids: number[],
  planName: string
): Promise<{
  ok: boolean;
  plan: string;
  updated: number;
  bounced: number;
  failed: { id: number; username?: string; error: string }[];
  results: Awaited<ReturnType<typeof changePppoeUserPlan>>[];
}> {
  const plan = String(planName || '').trim();
  const uniqueIds = [...new Set(ids.filter((id) => Number.isFinite(id) && id > 0))];

  // Phase 1: update DB + MikroTik comment/profile (no bounce yet)
  const phase1: Awaited<ReturnType<typeof changePppoeUserPlan>>[] = [];
  for (const id of uniqueIds) {
    phase1.push(await changePppoeUserPlan(id, plan, { bounce: false }));
  }

  // Phase 2: bounce all enabled secrets in parallel (~2s total)
  const bounceJobs = phase1
    .filter((r) => r.ok && r.sync.ok)
    .map(async (r) => {
      const user = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(r.id) as any;
      if (!user?.router_id) return { ...r, sessionRefresh: null as typeof r.sessionRefresh };
      if (String(user.status || '').toLowerCase() === 'disabled') {
        return { ...r, sessionRefresh: null as typeof r.sessionRefresh };
      }
      const router = db.prepare('SELECT * FROM routers WHERE id = ?').get(user.router_id) as any;
      if (!router?.host || !router?.api_user) return { ...r, sessionRefresh: null as typeof r.sessionRefresh };
      const sessionRefresh = await bouncePppSessionForRefresh(router, user.username, SESSION_REFRESH_MS);
      return { ...r, sessionRefresh };
    });

  const results = phase1.map((r) => ({ ...r }));
  const bouncedResults = await Promise.all(bounceJobs);
  for (const br of bouncedResults) {
    const idx = results.findIndex((r) => r.id === br.id);
    if (idx >= 0) results[idx] = br;
  }

  const failed = results
    .filter((r) => {
      if (r.error) return true;
      if (!r.sync?.ok && r.sync?.error && r.sync.error !== 'no router') return true;
      return false;
    })
    .map((r) => ({
      id: r.id,
      username: r.username,
      error: r.error || r.sync?.error || 'failed',
    }));

  return {
    ok: failed.length === 0,
    plan,
    updated: results.filter((r) => !r.error).length,
    bounced: results.filter((r) => r.sessionRefresh?.bounced).length,
    failed,
    results,
  };
}

/**
 * Change only the MikroTik /ppp/secret profile for selected users.
 * Does not change billing plan, comment, or panel DB profile.
 */
export async function bulkChangePppoeMikrotikProfiles(
  ids: number[],
  profileName: string
): Promise<{
  ok: boolean;
  profile: string;
  updated: number;
  bounced: number;
  failed: { id: number; username?: string; error: string }[];
}> {
  const profile = String(profileName || '').trim();
  if (!profile) {
    return { ok: false, profile: '', updated: 0, bounced: 0, failed: [{ id: 0, error: 'Profile required' }] };
  }

  const uniqueIds = [...new Set(ids.filter((id) => Number.isFinite(id) && id > 0))];
  type Row = {
    id: number;
    username: string;
    ok: boolean;
    error?: string;
    bounceable: boolean;
    router: any | null;
  };

  const rows: Row[] = [];
  for (const id of uniqueIds) {
    const user = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(id) as any;
    if (!user) {
      rows.push({ id, username: '', ok: false, error: 'User not found', bounceable: false, router: null });
      continue;
    }
    if (!user.router_id) {
      rows.push({
        id,
        username: user.username,
        ok: false,
        error: 'No router assigned',
        bounceable: false,
        router: null,
      });
      continue;
    }
    const router = db.prepare('SELECT * FROM routers WHERE id = ?').get(user.router_id) as any;
    if (!router?.host || !router?.api_user) {
      rows.push({
        id,
        username: user.username,
        ok: false,
        error: 'Router API not configured',
        bounceable: false,
        router: null,
      });
      continue;
    }
    try {
      await updatePppSecret(router, user.username, { profile });
      const isDisabled = String(user.status || '').toLowerCase() === 'disabled';
      rows.push({
        id,
        username: user.username,
        ok: true,
        bounceable: !isDisabled,
        router,
      });
      db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
        'info',
        'mikrotik',
        `MT profile set for ${user.username} → ${profile}`
      );
    } catch (e: any) {
      rows.push({
        id,
        username: user.username,
        ok: false,
        error: e?.message || String(e),
        bounceable: false,
        router: null,
      });
    }
  }

  const bounceJobs = rows
    .filter((r) => r.ok && r.bounceable && r.router)
    .map(async (r) => {
      const sessionRefresh = await bouncePppSessionForRefresh(r.router, r.username, SESSION_REFRESH_MS);
      return { id: r.id, bounced: sessionRefresh.bounced };
    });
  const bounceResults = await Promise.all(bounceJobs);
  const bouncedIds = new Set(bounceResults.filter((b) => b.bounced).map((b) => b.id));

  const failed = rows
    .filter((r) => !r.ok)
    .map((r) => ({ id: r.id, username: r.username, error: r.error || 'failed' }));

  return {
    ok: failed.length === 0,
    profile,
    updated: rows.filter((r) => r.ok).length,
    bounced: bouncedIds.size,
    failed,
  };
}

/**
 * Provision RouterOS-side scheduler entries so grace/expiry take effect on the
 * router itself even if this panel is offline or unreachable when they're due.
 * Best-effort — a failure here never blocks the payment that was just recorded;
 * the server-side poller (notify.ts executeBillingEnforcement) remains the
 * fallback enforcement path whenever this can't reach the router right now.
 */
async function scheduleRouterExpiry(user: any, expirationProfile?: string | null): Promise<void> {
  if (!user?.router_id || !user?.username || !user?.subscription_due) return;
  const router = db.prepare('SELECT * FROM routers WHERE id = ?').get(user.router_id) as any;
  if (!router?.host || !router?.api_user) return;
  try {
    const graceHours = Math.max(1, Number(getNotifySettings().autodisable_hours) || 24);
    const dueDayUtc = Date.parse(`${String(user.subscription_due).slice(0, 10)}T00:00:00Z`);
    if (!Number.isFinite(dueDayUtc)) return;
    // Account remains valid through the due date; overdue clock starts at next midnight UTC
    // (must match hoursPastDue()'s convention in notify.ts, or the router and the panel would disagree).
    const graceAt = new Date(dueDayUtc + 24 * 3600000);
    const disableAt = new Date(graceAt.getTime() + graceHours * 3600000);
    const nonPaymentProfile = expirationProfile && expirationProfile !== 'default' ? expirationProfile : 'non-payments';
    await scheduleExpiryOnRouter(router, { username: user.username, graceAt, disableAt, nonPaymentProfile });
  } catch {
    /* best-effort */
  }
}

/** Best-effort removal of any pending router-side grace/disable schedule for a user. */
export async function cancelRouterExpirySchedule(user: any): Promise<void> {
  if (!user?.router_id || !user?.username) return;
  const router = db.prepare('SELECT * FROM routers WHERE id = ?').get(user.router_id) as any;
  if (!router?.host || !router?.api_user) return;
  try {
    await cancelExpiryScheduleOnRouter(router, user.username);
  } catch {
    /* best-effort */
  }
}

export async function syncUserToRouter(
  user: any,
  action: 'restore' | 'expire' | 'disable' | 'enable'
): Promise<{ ok: boolean; error?: string }> {
  if (!user?.router_id) return { ok: false, error: 'no router' };
  const router = db.prepare('SELECT * FROM routers WHERE id = ?').get(user.router_id) as any;
  if (!router?.host || !router?.api_user) return { ok: false, error: 'router-not-configured' };
  try {
    if (action === 'expire') {
      // Within grace: switch PPP profile to non-payment only.
      // Do NOT rewrite the secret comment — it keeps the original plan/due for payment restore.
      const expire =
        user.expiration_profile && user.expiration_profile !== 'default'
          ? user.expiration_profile
          : 'non-payments';
      try {
        await ensurePppProfile(router, expire);
      } catch {
        /* profile may already exist */
      }
      await updatePppSecret(router, user.username, {
        profile: expire,
        disabled: false,
      });
      await setPppSecretEnabled(router, user.username, true);
    } else if (action === 'disable') {
      // Past grace: disable only. Leave comment and profile untouched so payment
      // still reads the original plan/due from the preserved comment.
      await setPppSecretEnabled(router, user.username, false);
      try {
        await removePppActiveByName(router, user.username);
      } catch {
        /* best-effort */
      }
    } else if (action === 'enable' || action === 'restore') {
      const mtProfile = mikrotikProfileForPlan(user.profile);
      if (!mtProfile) {
        return {
          ok: false,
          error: `Billing plan "${user.profile}" has no linked MikroTik PPP profile — set it under Billing Plans`,
        };
      }
      // Apply existing profile only — never create /ppp/profile on the router.
      await updatePppSecret(router, user.username, {
        password: user.password || '',
        profile: mtProfile,
        comment: commentFromUser({ ...user, status: 'Active' }),
        disabled: false,
      });
      await setPppSecretEnabled(router, user.username, true);
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export async function recordPppoePayment(
  userId: number,
  opts: {
    months?: number;
    plan?: string;
    expiration_profile?: string;
    payment_date?: string;
    discount_days?: number;
    external_ref?: string;
    source?: string;
    cashierUserId?: number | null;
    cashierUsername?: string | null;
  } = {}
) {
  const user = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(userId) as any;
  if (!user) throw new Error('User not found');

  const previousStatus = String(user.status || '');
  const refreshSession = needsSessionRefresh(previousStatus);

  const months = Math.max(1, Math.floor(Number(opts.months) || 1));
  const previousDue: string = (user.subscription_due || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const newDue = addMonthsPreserveDay(previousDue, months);
  const plan = opts.plan || user.profile;
  const planMeta = getBillingPlan(plan);
  if (!planMeta) throw new Error(`Billing plan "${plan}" not found`);
  if (!planMeta.pppProfile) {
    throw new Error(
      `Billing plan "${plan}" has no linked MikroTik PPP profile. Edit the plan and select an existing profile.`
    );
  }
  const unit = planMeta.price || Number(user.price) || 0;
  const subtotal = unit * months;
  const discountDays = Math.max(0, Math.floor(Number(opts.discount_days) || 0));
  const discount = Math.round((unit / 30) * discountDays * 100) / 100;
  const total = Math.max(0, Math.round((subtotal - discount) * 100) / 100);
  const expirationProfile = opts.expiration_profile || user.expiration_profile || 'non-payments';
  const paymentDate = opts.payment_date
    ? new Date(`${String(opts.payment_date).slice(0, 10)}T00:00:00Z`).toISOString()
    : new Date().toISOString();

  db.prepare(
    `UPDATE pppoe_users SET subscription_due = ?, profile = ?, price = ?, expiration_profile = ?,
       status = 'Active', online = 1, nonpayment_since = NULL, reminder_sent = NULL WHERE id = ?`
  ).run(newDue, plan, unit, expirationProfile, userId);

  const updated = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(userId) as any;
  const company = db.prepare('SELECT * FROM company WHERE id = 1').get() as any;
  const transactionAt = new Date().toISOString();
  const receipt = {
    company: company?.name || 'ISP Billing',
    companyAddress: company?.address || null,
    companyPhone: company?.phone || null,
    companyEmail: company?.email || null,
    account: updated.account_number,
    customer: updated.customer_name || updated.username,
    plan,
    months,
    paymentDate: paymentDate.slice(0, 10),
    transactionAt,
    previousDue,
    newDue,
    subtotal,
    discount,
    discountDays,
    total,
  };

  const txInfo = db.prepare(
    'INSERT INTO transactions (pppoe_user_id, customer_name, amount, type, created_at, receipt_json, cashier_user_id, cashier_username) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    userId,
    user.customer_name || user.username,
    total,
    'payment',
    paymentDate,
    JSON.stringify(receipt),
    opts.cashierUserId != null ? Number(opts.cashierUserId) : null,
    opts.cashierUsername ? String(opts.cashierUsername) : null
  );
  const transactionId = Number(txInfo.lastInsertRowid);

  const cashierNote = opts.cashierUsername ? ` cashier=${opts.cashierUsername}` : '';
  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
    'info',
    'billing',
    `Payment for ${user.username}: ${plan} (MT profile ${planMeta.pppProfile}) +${months}mo, due ${previousDue} → ${newDue}, total ${total}${opts.source ? ` (${opts.source})` : ''}${opts.external_ref ? ` ref=${opts.external_ref}` : ''}${cashierNote}`
  );

  // The payment itself (DB update above) is already committed at this point.
  // A slow/unreachable router must never hold up the HTTP response for it —
  // that previously took up to ~35s (two sequential router-call timeouts),
  // long enough to trip an intermediary proxy's own timeout (nginx, Cloudflare
  // Tunnel, ngrok...), which then shows the admin "payment failed" even though
  // the subscription was already extended. Bound the wait instead; the router
  // call keeps running in the background regardless, and its outcome (if it
  // arrives after we've already responded) is logged for later review.
  let respondedAlready = false;
  const syncPromise = syncUserToRouter(updated, 'restore');
  syncPromise
    .then((r) => {
      if (r.ok) {
        resolveRouterSync(updated.router_id, updated.id);
      } else {
        enqueueRouterSync(updated.router_id, updated.id, r.error || 'Payment restore failed');
      }
      if (respondedAlready && !r.ok) {
        db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
          'warning',
          'mikrotik',
          `Payment for ${updated.username}: MikroTik restore sync finished after the response had already returned (router was slow) — ${r.error || 'failed'}. Queued for automatic retry once the router is reachable.`
        );
      }
    })
    .catch((e: any) => {
      enqueueRouterSync(updated.router_id, updated.id, e?.message || String(e));
      if (respondedAlready) {
        db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
          'warning',
          'mikrotik',
          `Payment for ${updated.username}: MikroTik restore sync threw after the response had already returned — ${e?.message || e}. Queued for automatic retry once the router is reachable.`
        );
      }
    });
  const sync = await withTimeout(syncPromise, ROUTER_CALL_BUDGET_MS, {
    ok: false,
    error: 'Router is slow to respond — continuing in the background. Check Logs shortly, or use Recheck Expiry.',
  });
  respondedAlready = true;

  // Cancels any pending grace/disable schedule from before this payment and
  // provisions a fresh one for the new due date — this is what makes "pay
  // before it fires" work, and covers grace/expiry even if the panel is
  // offline when they're due. Not awaited: best-effort, and a slow/unreachable
  // router here shouldn't add latency on top of the sync call above.
  scheduleRouterExpiry(updated, expirationProfile).catch(() => undefined);

  let sessionRefresh: { bounced: boolean; waitMs: number; error?: string } | null = null;
  if (refreshSession && sync.ok && updated?.router_id) {
    const router = db.prepare('SELECT * FROM routers WHERE id = ?').get(updated.router_id) as any;
    if (router?.host && router?.api_user) {
      sessionRefresh = await bouncePppSessionForRefresh(router, updated.username, SESSION_REFRESH_MS);
      db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
        sessionRefresh.bounced ? 'info' : 'warning',
        'mikrotik',
        sessionRefresh.bounced
          ? `Session refresh bounce for ${updated.username} after payment (was ${previousStatus}, ${SESSION_REFRESH_MS}ms)`
          : `Session refresh bounce failed for ${updated.username}: ${sessionRefresh.error || 'unknown'}`
      );
    }
  }

  return {
    ok: true,
    months,
    plan,
    previousDue,
    previousStatus,
    subscriptionDue: newDue,
    subtotal,
    discount,
    total,
    amount: total,
    transactionId,
    sync,
    sessionRefresh,
    receipt,
    user: updated,
  };
}

/** Load a stored receipt snapshot, or rebuild a best-effort receipt for older transactions. */
export function getTransactionReceipt(txId: number) {
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(txId) as any;
  if (!tx) return null;
  if (tx.receipt_json) {
    try {
      return JSON.parse(tx.receipt_json);
    } catch {
      /* fall through */
    }
  }
  const user = tx.pppoe_user_id
    ? (db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(tx.pppoe_user_id) as any)
    : null;
  const company = db.prepare('SELECT * FROM company WHERE id = 1').get() as any;
  const createdAt = String(tx.created_at || new Date().toISOString());
  const amount = Number(tx.amount) || 0;
  return {
    company: company?.name || 'ISP Billing',
    companyAddress: company?.address || null,
    companyPhone: company?.phone || null,
    companyEmail: company?.email || null,
    account: user?.account_number || null,
    customer: tx.customer_name || user?.customer_name || user?.username || 'Customer',
    plan: user?.profile || '',
    months: 1,
    paymentDate: createdAt.slice(0, 10),
    transactionAt: createdAt,
    newDue: user?.subscription_due || '',
    subtotal: amount,
    discount: 0,
    discountDays: 0,
    total: amount,
  };
}

function randomToken(): string {
  return crypto.randomBytes(18).toString('base64url');
}

export function createPaymentLink(opts: {
  pppoeUserId: number;
  months?: number;
  amount?: number | null;
  ttlHours?: number;
  baseUrl?: string;
  /** admin = panel create; portal = subscriber initiated; system = reminders; cashier = cashier portal */
  createdBy?: 'admin' | 'portal' | 'system' | 'cashier';
  cashierUserId?: number | null;
  cashierUsername?: string | null;
}) {
  const user = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(opts.pppoeUserId) as any;
  if (!user) throw new Error('User not found');
  const months = Math.max(1, Math.floor(Number(opts.months) || 1));
  const prof = db.prepare('SELECT price FROM profiles WHERE name = ?').get(user.profile) as { price: number } | undefined;
  const amount = opts.amount != null ? Number(opts.amount) : (Number(user.price) || prof?.price || 0) * months;
  const token = randomToken();
  // Default validity: 15 days (360 hours)
  const ttl = Math.max(1, Math.floor(Number(opts.ttlHours) || 15 * 24));
  const expiresAt = new Date(Date.now() + ttl * 3600000).toISOString();
  const createdBy =
    opts.createdBy === 'portal' ||
    opts.createdBy === 'system' ||
    opts.createdBy === 'admin' ||
    opts.createdBy === 'cashier'
      ? opts.createdBy
      : 'admin';
  const cashierUserId = opts.cashierUserId != null ? Number(opts.cashierUserId) : null;
  const cashierUsername = opts.cashierUsername ? String(opts.cashierUsername) : null;

  const info = db.prepare(
    `INSERT INTO payment_links (pppoe_user_id, token, amount, months, status, expires_at, created_by, cashier_user_id, cashier_username)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
  ).run(opts.pppoeUserId, token, amount, months, expiresAt, createdBy, cashierUserId, cashierUsername);

  const id = Number(info.lastInsertRowid);
  const path = `/pay/${token}`;
  const resolved = resolvePublicBaseUrl(opts.baseUrl);
  const url = resolved.baseUrl ? `${resolved.baseUrl}${path}` : path;

  // Staff inbox: only subscriber-initiated creates (exclude admin/system).
  if (createdBy === 'portal') {
    try {
      const who = subscriberLabel(opts.pppoeUserId);
      notifyStaff({
        type: 'payment_link_created',
        title: 'Payment link created',
        body: `${who} opened a ₱${Number(amount || 0).toLocaleString('en-PH', { maximumFractionDigits: 2 })} payment link`,
        entityType: 'payment_link',
        entityId: id,
        pppoeUserId: opts.pppoeUserId,
        status: 'pending',
        payload: { amount, months, account: user.account_number || null },
      });
    } catch {
      /* never block pay-link create on notify failure */
    }
  }

  return {
    id,
    token,
    path,
    url,
    baseUrl: resolved.baseUrl || null,
    source: resolved.source,
    warning: resolved.warning || null,
    amount,
    months,
    expiresAt,
    createdBy,
    username: user.username,
    customer: user.customer_name,
    account: user.account_number,
  };
}

export function getPaymentLinkPublic(token: string) {
  const link = db
    .prepare(
      `SELECT pl.*, u.username, u.customer_name, u.account_number, u.profile, u.subscription_due, u.contact, u.email, u.price
       FROM payment_links pl JOIN pppoe_users u ON u.id = pl.pppoe_user_id WHERE pl.token = ?`
    )
    .get(token) as any;
  if (!link) return null;
  const company = db
    .prepare(
      `SELECT name, logo, address, phone, email, payment_qr, gcash_qr, maya_qr, gcash_number, maya_number, payment_instructions
       FROM company WHERE id = 1`
    )
    .get() as any;
  const expired = link.status === 'pending' && link.expires_at && Date.parse(link.expires_at) < Date.now();
  if (expired && link.status === 'pending') {
    db.prepare("UPDATE payment_links SET status = 'expired' WHERE id = ?").run(link.id);
    link.status = 'expired';
  }
  return {
    token: link.token,
    status: link.status,
    amount: link.amount,
    months: link.months,
    expiresAt: link.expires_at,
    paidAt: link.paid_at,
    externalRef: link.external_ref,
    payChannel: link.pay_channel || null,
    merchantId: link.merchant_id != null ? Number(link.merchant_id) : null,
    submittedAt: link.submitted_at || null,
    customer: link.customer_name || link.username,
    account: link.account_number,
    username: link.username,
    plan: link.profile,
    due: link.subscription_due,
    merchants: listPaymentMerchants({ activeOnly: true }).map((m) => ({
      id: m.id,
      name: m.name,
      photo: m.photo,
      address: m.address,
      notes: m.notes,
    })),
    company: {
      name: company?.name || 'ISP Billing',
      logo: company?.logo || null,
      address: company?.address || null,
      phone: company?.phone || null,
      email: company?.email || null,
      paymentQr: company?.payment_qr || null,
      gcashQr: company?.gcash_qr || company?.payment_qr || null,
      mayaQr: company?.maya_qr || company?.payment_qr || null,
      gcashNumber: company?.gcash_number || null,
      mayaNumber: company?.maya_number || null,
      paymentInstructions: company?.payment_instructions || null,
    },
  };
}

/** Subscriber submits GCash/Maya/Cash proof — awaits admin review (does not restore yet). */
export function submitPaymentProof(
  token: string,
  opts: {
    channel: string;
    reference: string;
    proofImage?: string | null;
    merchantId?: number | null;
  }
) {
  const link = db.prepare('SELECT * FROM payment_links WHERE token = ?').get(token) as any;
  if (!link) throw new Error('Payment link not found');
  if (link.status === 'paid') throw new Error('This link is already paid');
  if (link.status === 'expired') throw new Error('Payment link expired');
  if (
    link.status !== 'submitted' &&
    link.status !== 'rejected' &&
    link.expires_at &&
    Date.parse(link.expires_at) < Date.now()
  ) {
    throw new Error('Payment link expired');
  }

  const channel = String(opts.channel || '').toLowerCase().trim();
  if (channel !== 'gcash' && channel !== 'maya' && channel !== 'cash') {
    throw new Error('Select GCash, Maya, or Cash as the payment channel');
  }
  // Honor admin toggles for manual GCash / Maya / Cash on the public pay page.
  try {
    const flags = db
      .prepare('SELECT pay_manual_gcash, pay_manual_maya, pay_manual_cash FROM app_settings WHERE id = 1')
      .get() as { pay_manual_gcash?: number; pay_manual_maya?: number; pay_manual_cash?: number } | undefined;
    if (flags) {
      if (channel === 'gcash' && flags.pay_manual_gcash != null && Number(flags.pay_manual_gcash) !== 1) {
        throw new Error('Manual GCash proof is disabled. Pay online with PayMongo or choose Cash.');
      }
      if (channel === 'maya' && flags.pay_manual_maya != null && Number(flags.pay_manual_maya) !== 1) {
        throw new Error('Manual Maya proof is disabled. Pay online with PayMongo or choose Cash.');
      }
      if (channel === 'cash' && flags.pay_manual_cash != null && Number(flags.pay_manual_cash) !== 1) {
        throw new Error('Cash payment is disabled on this portal.');
      }
    }
  } catch (e: any) {
    if (String(e?.message || '').includes('disabled')) throw e;
    /* columns may not exist yet on very old DBs */
  }

  let merchantId: number | null = null;
  let merchantName: string | null = null;
  if (channel === 'cash') {
    const mid = Number(opts.merchantId);
    if (!mid || !Number.isFinite(mid)) throw new Error('Select the merchant where you paid cash');
    const merchant = getPaymentMerchant(mid);
    if (!merchant || !merchant.active) throw new Error('Selected merchant is not available');
    merchantId = merchant.id;
    merchantName = merchant.name;
  }

  let reference = String(opts.reference || '').trim();
  if (channel === 'cash') {
    if (!reference || reference.length < 2) {
      reference = `Cash @ ${merchantName}`;
    }
  } else if (!reference || reference.length < 4) {
    throw new Error('Enter the transaction / reference number from your receipt');
  }

  let proofPath: string | null = link.proof_image || null;
  const raw = opts.proofImage;
  if (raw && typeof raw === 'string' && raw.startsWith('data:image/')) {
    const m = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!m) throw new Error('Invalid screenshot format');
    const mime = m[1].toLowerCase();
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 6 * 1024 * 1024) throw new Error('Screenshot must be 6MB or smaller');
    const dir = path.resolve(process.cwd(), 'data', 'pay-proofs');
    fs.mkdirSync(dir, { recursive: true });
    const file = `${String(token).slice(0, 24)}-${Date.now()}.${ext}`;
    const full = path.join(dir, file);
    fs.writeFileSync(full, buf);
    proofPath = `pay-proofs/${file}`;
  }

  db.prepare(
    `UPDATE payment_links SET
       status = 'submitted',
       pay_channel = ?,
       external_ref = ?,
       proof_image = ?,
       merchant_id = ?,
       submitted_at = datetime('now')
     WHERE id = ?`
  ).run(channel, reference, proofPath, merchantId, link.id);

  // Subscriber payment proof — notify staff regardless of who created the link.
  try {
    const who = subscriberLabel(link.pppoe_user_id);
    const amt = Number(link.amount) || 0;
    const channelLabel =
      channel === 'cash' ? `CASH${merchantName ? ` @ ${merchantName}` : ''}` : channel.toUpperCase();
    notifyStaff({
      type: 'payment_submitted',
      title: 'Payment received',
      body: `${who} submitted ${channelLabel} proof for ₱${amt.toLocaleString('en-PH', { maximumFractionDigits: 2 })} (ref ${reference})`,
      entityType: 'payment_link',
      entityId: Number(link.id),
      pppoeUserId: Number(link.pppoe_user_id) || null,
      status: 'submitted',
      payload: {
        channel,
        reference,
        amount: amt,
        merchantId,
        merchantName,
        createdBy: link.created_by || 'admin',
      },
    });
  } catch {
    /* ignore */
  }

  return {
    ok: true,
    status: 'submitted',
    channel,
    reference,
    merchantId,
    merchantName,
    message: 'Payment proof submitted. Your ISP will review and restore your service shortly.',
  };
}

export async function markPaymentLinkPaid(token: string, externalRef?: string) {
  const link = db.prepare('SELECT * FROM payment_links WHERE token = ?').get(token) as any;
  if (!link) throw new Error('Payment link not found');
  if (link.status === 'paid') {
    return { ok: true, alreadyPaid: true, link };
  }
  // Allow approving submitted/rejected proofs even if the original link expiry passed
  if (link.status !== 'submitted' && link.status !== 'rejected') {
    if (link.status === 'expired' || (link.expires_at && Date.parse(link.expires_at) < Date.now())) {
      throw new Error('Payment link expired');
    }
  }
  const result = await recordPppoePayment(link.pppoe_user_id, {
    months: link.months || 1,
    source: 'pay-link',
    external_ref: externalRef || link.external_ref || undefined,
  });
  db.prepare(
    `UPDATE payment_links SET status = 'paid', paid_at = datetime('now'),
       external_ref = COALESCE(?, external_ref),
       reviewed_at = datetime('now')
     WHERE id = ?`
  ).run(externalRef || null, link.id);
  try {
    const amt = Number(link.amount) || Number((result as any)?.amount) || 0;
    pushPortalActivity({
      pppoeUserId: Number(link.pppoe_user_id),
      type: 'payment',
      title: 'Payment approved',
      body: `₱${amt.toLocaleString('en-PH', { maximumFractionDigits: 2 })} was posted to your account.`,
      entityType: 'payment_link',
      entityId: Number(link.id),
      payload: { transactionId: (result as any)?.transactionId || (result as any)?.id || null },
    });
  } catch {
    /* ignore */
  }
  return { ok: true, alreadyPaid: false, payment: result, link };
}

export function rejectPaymentProof(id: number, note?: string) {
  const link = db.prepare('SELECT * FROM payment_links WHERE id = ?').get(id) as any;
  if (!link) throw new Error('Payment link not found');
  if (link.status === 'paid') throw new Error('Already paid');
  db.prepare(
    `UPDATE payment_links SET status = 'rejected', reviewed_at = datetime('now'), review_note = ? WHERE id = ?`
  ).run(note || null, id);
  try {
    pushPortalActivity({
      pppoeUserId: Number(link.pppoe_user_id),
      type: 'payment',
      title: 'Payment rejected',
      body: note || 'Your payment proof was not accepted. Please resubmit with a clearer receipt.',
      entityType: 'payment_link',
      entityId: Number(link.id),
    });
  } catch {
    /* ignore */
  }
  return { ok: true, status: 'rejected' };
}

export function listPaymentLinks(limit = 100, opts?: { status?: string; excludeStatus?: string }) {
  const resolved = resolvePublicBaseUrl();
  const where: string[] = [];
  const params: any[] = [];
  if (opts?.status) {
    where.push('pl.status = ?');
    params.push(opts.status);
  }
  if (opts?.excludeStatus) {
    where.push('pl.status != ?');
    params.push(opts.excludeStatus);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // For approval (submitted) always first, then pending, rejected, expired, paid; newest id within each.
  const rows = db
    .prepare(
      `SELECT pl.id, pl.token, pl.amount, pl.months, pl.status, pl.expires_at AS expiresAt, pl.paid_at AS paidAt,
              pl.created_at AS createdAt, pl.external_ref AS externalRef,
              pl.pay_channel AS payChannel, pl.proof_image AS proofImage, pl.submitted_at AS submittedAt,
              pl.reviewed_at AS reviewedAt, pl.review_note AS reviewNote,
              pl.merchant_id AS merchantId,
              COALESCE(NULLIF(pl.created_by, ''), 'admin') AS createdBy,
              pl.cashier_user_id AS cashierUserId,
              pl.cashier_username AS cashierUsername,
              u.username, u.customer_name AS customer, u.account_number AS account,
              m.name AS merchantName
       FROM payment_links pl
       JOIN pppoe_users u ON u.id = pl.pppoe_user_id
       LEFT JOIN payment_merchants m ON m.id = pl.merchant_id
       ${whereSql}
       ORDER BY
         CASE pl.status
           WHEN 'submitted' THEN 0
           WHEN 'pending' THEN 1
           WHEN 'rejected' THEN 2
           WHEN 'expired' THEN 3
           WHEN 'paid' THEN 4
           ELSE 5
         END,
         COALESCE(pl.paid_at, pl.submitted_at, pl.created_at) DESC,
         pl.id DESC
       LIMIT ?`
    )
    .all(...params, limit) as any[];
  return rows.map((r) => {
    const path = `/pay/${r.token}`;
    return {
      ...r,
      path,
      url: resolved.baseUrl ? `${resolved.baseUrl}${path}` : path,
      baseUrl: resolved.baseUrl || null,
      proofUrl: r.proofImage ? `/api/payment-links/${r.id}/proof` : null,
    };
  });
}

/** Ensure a fresh pending pay link exists for reminder messages or portal self-serve. */
export function ensureFreshPayLink(
  userId: number,
  baseUrl?: string,
  opts?: { createdBy?: 'admin' | 'portal' | 'system'; months?: number; amount?: number | null }
) {
  const existing = db
    .prepare(
      `SELECT * FROM payment_links WHERE pppoe_user_id = ? AND status = 'pending' AND datetime(expires_at) > datetime('now')
       ORDER BY id DESC LIMIT 1`
    )
    .get(userId) as any;
  if (existing) {
    const path = `/pay/${existing.token}`;
    const resolved = resolvePublicBaseUrl(baseUrl);
    return {
      token: existing.token,
      path,
      url: resolved.baseUrl ? `${resolved.baseUrl}${path}` : path,
      baseUrl: resolved.baseUrl || null,
      source: resolved.source,
      warning: resolved.warning || null,
      amount: existing.amount,
      months: existing.months,
      createdBy: existing.created_by || 'admin',
    };
  }
  return createPaymentLink({
    pppoeUserId: userId,
    months: opts?.months ?? 1,
    amount: opts?.amount,
    baseUrl,
    ttlHours: 15 * 24,
    createdBy: opts?.createdBy ?? 'admin',
  });
}

/** Create or refresh a pay link for resend (always 15-day validity). */
export function resendPaymentLink(opts: {
  pppoeUserId: number;
  months?: number;
  baseUrl?: string;
}) {
  return createPaymentLink({
    pppoeUserId: opts.pppoeUserId,
    months: opts.months ?? 1,
    baseUrl: opts.baseUrl,
    ttlHours: 15 * 24,
  });
}

/** Calendar days until subscription_due (negative = already expired). */
export function daysUntilSubscriptionDue(due: string | null | undefined): number | null {
  if (!due) return null;
  const day = String(due).slice(0, 10);
  const dueMs = Date.parse(`${day}T00:00:00`);
  if (!Number.isFinite(dueMs)) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((dueMs - today.getTime()) / 86_400_000);
}

/**
 * Pay-link resend is only for accounts expired or due within `withinDays` (default 10).
 * Overdue / non-payment / expired statuses qualify even if due date is missing.
 * Plain "disabled" alone does not qualify unless the due date is within the window (or past).
 */
export function isPayLinkResendEligible(
  user: { subscription_due?: string | null; status?: string | null },
  withinDays = 10
): boolean {
  const d = daysUntilSubscriptionDue(user.subscription_due);
  if (d != null && d <= withinDays) return true;
  const st = String(user.status || '')
    .toLowerCase()
    .trim();
  return ['non-payment', 'expired', 'overdue'].includes(st);
}

/** Subscribers eligible for bulk pay-link resend (expired or ≤ withinDays). */
export function listPayLinkResendCandidates(withinDays = 10) {
  const rows = db
    .prepare(
      `SELECT id, username, customer_name AS customer, email, contact, service, status,
              subscription_due AS subscriptionDue, account_number AS account
       FROM pppoe_users
       ORDER BY subscription_due ASC, customer_name ASC`
    )
    .all() as any[];
  return rows
    .filter((u) => isPayLinkResendEligible({ subscription_due: u.subscriptionDue, status: u.status }, withinDays))
    .map((u) => {
      const days = daysUntilSubscriptionDue(u.subscriptionDue);
      return {
        ...u,
        daysUntilDue: days,
        expired:
          days != null
            ? days < 0
            : ['non-payment', 'expired', 'overdue'].includes(String(u.status || '').toLowerCase()),
      };
    });
}

/**
 * Cashier portal: collect payment for a subscriber, store proof, activate/extend
 * the account immediately, and attribute the payment to the cashier user.
 */
export async function cashierCollectPayment(opts: {
  pppoeUserId: number;
  months?: number;
  amount?: number | null;
  /** How the subscriber paid the cashier: cash or online */
  collectionType?: 'cash' | 'online';
  channel?: string;
  reference?: string;
  proofImage?: string | null;
  merchantId?: number | null;
  cashier: { id: number; username: string };
}) {
  const collectionType = String(opts.collectionType || opts.channel || '').toLowerCase() === 'online'
    ? 'online'
    : String(opts.collectionType || '').toLowerCase() === 'cash'
      ? 'cash'
      : String(opts.channel || '').toLowerCase() === 'cash'
        ? 'cash'
        : 'online';

  let channel = String(opts.channel || '').toLowerCase().trim();
  if (collectionType === 'cash') {
    channel = channel === 'gcash' || channel === 'maya' ? channel : 'cash';
  } else {
    if (channel !== 'gcash' && channel !== 'maya') {
      // Online collection — require an e-wallet channel if not set
      channel = channel === 'cash' ? 'gcash' : (channel || 'gcash');
    }
    if (channel !== 'gcash' && channel !== 'maya' && channel !== 'cash') {
      throw new Error('Select GCash or Maya for online collection');
    }
  }

  let merchantId: number | null = null;
  let merchantName: string | null = null;
  if (channel === 'cash') {
    const mid = Number(opts.merchantId);
    if (mid && Number.isFinite(mid)) {
      const merchant = getPaymentMerchant(mid);
      if (!merchant || !merchant.active) throw new Error('Selected merchant is not available');
      merchantId = merchant.id;
      merchantName = merchant.name;
    }
  }

  let reference = String(opts.reference || '').trim();
  if (channel === 'cash') {
    if (!reference || reference.length < 2) {
      reference = merchantName
        ? `Cash @ ${merchantName} (cashier ${opts.cashier.username})`
        : `Cash (cashier ${opts.cashier.username})`;
    }
  } else if (!reference || reference.length < 4) {
    throw new Error('Enter the transaction / reference number from the receipt');
  }

  const link = createPaymentLink({
    pppoeUserId: opts.pppoeUserId,
    months: opts.months,
    amount: opts.amount,
    createdBy: 'cashier',
    cashierUserId: opts.cashier.id,
    cashierUsername: opts.cashier.username,
  });

  let proofPath: string | null = null;
  const raw = opts.proofImage;
  if (raw && typeof raw === 'string' && raw.startsWith('data:image/')) {
    const m = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!m) throw new Error('Invalid screenshot format');
    const mime = m[1].toLowerCase();
    const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 6 * 1024 * 1024) throw new Error('Screenshot must be 6MB or smaller');
    const dir = path.resolve(process.cwd(), 'data', 'pay-proofs');
    fs.mkdirSync(dir, { recursive: true });
    const file = `cashier-${String(link.token).slice(0, 20)}-${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(dir, file), buf);
    proofPath = `pay-proofs/${file}`;
  } else if (collectionType === 'online') {
    throw new Error('Upload a payment proof screenshot for online collections');
  }

  db.prepare(
    `UPDATE payment_links SET
       pay_channel = ?,
       external_ref = ?,
       proof_image = ?,
       merchant_id = ?,
       submitted_at = datetime('now'),
       cashier_user_id = ?,
       cashier_username = ?
     WHERE id = ?`
  ).run(channel, reference, proofPath, merchantId, opts.cashier.id, opts.cashier.username, link.id);

  const payment = await recordPppoePayment(opts.pppoeUserId, {
    months: link.months || 1,
    source: `cashier:${opts.cashier.username}`,
    external_ref: reference,
    cashierUserId: opts.cashier.id,
    cashierUsername: opts.cashier.username,
  });

  db.prepare(
    `UPDATE payment_links SET status = 'paid', paid_at = datetime('now'),
       reviewed_at = datetime('now'),
       cashier_user_id = ?, cashier_username = ?
     WHERE id = ?`
  ).run(opts.cashier.id, opts.cashier.username, link.id);

  try {
    const amt = Number(link.amount) || Number((payment as any)?.amount) || 0;
    pushPortalActivity({
      pppoeUserId: Number(opts.pppoeUserId),
      type: 'payment',
      title: 'Payment posted by merchant',
      body: `₱${amt.toLocaleString('en-PH', { maximumFractionDigits: 2 })} was posted by merchant ${opts.cashier.username}.`,
      entityType: 'payment_link',
      entityId: Number(link.id),
      payload: {
        transactionId: (payment as any)?.transactionId || (payment as any)?.id || null,
        cashier: opts.cashier.username,
      },
    });
  } catch {
    /* ignore */
  }

  const subscriber = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(opts.pppoeUserId) as any;
  const txId = Number((payment as any)?.transactionId || (payment as any)?.id) || null;
  // Cash only — online collections settle to the ISP and skip the remittance queue.
  const collectibleId =
    collectionType === 'cash'
      ? createCashierCollectible({
          cashierUserId: opts.cashier.id,
          cashierUsername: opts.cashier.username,
          paymentLinkId: link.id,
          transactionId: txId,
          pppoeUserId: opts.pppoeUserId,
          amount: Number(link.amount) || Number((payment as any)?.amount) || 0,
          months: link.months || 1,
          collectionType: 'cash',
          payChannel: channel,
          externalRef: reference,
          subscriberUsername: subscriber?.username || null,
          customerName: subscriber?.customer_name || null,
          accountNumber: subscriber?.account_number || null,
        })
      : null;

  // Subscriber SMS confirmation (same template as PayMongo / admin payments).
  try {
    const contact = String(subscriber?.contact || (payment as any)?.user?.contact || '').trim();
    const total = Number(link.amount) || Number((payment as any)?.total ?? (payment as any)?.amount) || 0;
    const smsUser = (payment as any)?.user || subscriber;
    if (smsUser && contact) {
      const { sendPaymentConfirmationSms } = await import('./notify.js');
      sendPaymentConfirmationSms({ ...smsUser, contact }, total).catch(() => undefined);
    }
  } catch {
    /* never block collect on SMS failure */
  }

  return {
    ok: true,
    linkId: link.id,
    token: link.token,
    amount: link.amount,
    months: link.months,
    channel,
    collectionType,
    reference,
    merchantName,
    cashier: opts.cashier.username,
    collectibleId,
    payment,
  };
}

/**
 * Merchant portal: start a PayMongo hosted checkout unique to the selected subscriber.
 * Activation + SMS happen on the PayMongo webhook. No remittance queue (funds settle online).
 */
export async function cashierStartPaymongoCheckout(opts: {
  pppoeUserId: number;
  months?: number;
  amount?: number | null;
  cashier: { id: number; username: string };
  successUrl: string;
  cancelUrl: string;
}) {
  const { getPublicPayOptions, createPaymongoCheckout } = await import('./paymongo.js');
  const optsPub = getPublicPayOptions();
  if (!optsPub.paymongo) throw new Error('PayMongo is not enabled on this panel');

  const link = createPaymentLink({
    pppoeUserId: opts.pppoeUserId,
    months: opts.months,
    amount: opts.amount,
    createdBy: 'cashier',
    cashierUserId: opts.cashier.id,
    cashierUsername: opts.cashier.username,
  });

  db.prepare(
    `UPDATE payment_links SET
       pay_channel = 'paymongo',
       cashier_user_id = ?,
       cashier_username = ?
     WHERE id = ?`
  ).run(opts.cashier.id, opts.cashier.username, link.id);

  const checkout = await createPaymongoCheckout({
    token: link.token,
    successUrl: opts.successUrl,
    cancelUrl: opts.cancelUrl,
  });

  return {
    ok: true,
    linkId: link.id,
    token: link.token,
    amount: link.amount,
    months: link.months,
    checkoutUrl: checkout.checkoutUrl,
    checkoutId: checkout.checkoutId,
    cashier: opts.cashier.username,
  };
}

function findCashierPaymentTransaction(link: any): { id: number; receipt: any } | null {
  const cashierId = link.cashier_user_id != null ? Number(link.cashier_user_id) : null;
  const userId = Number(link.pppoe_user_id);
  const linkMonths = Math.max(1, Math.floor(Number(link.months) || 1));
  const linkAmount = Number(link.amount) || 0;
  const paidAt = Date.parse(String(link.paid_at || link.created_at || '')) || 0;

  const rows = db
    .prepare(
      `SELECT id, receipt_json, amount, created_at FROM transactions
       WHERE pppoe_user_id = ? AND type = 'payment'
         AND (? IS NULL OR cashier_user_id = ?)
       ORDER BY id DESC LIMIT 25`
    )
    .all(userId, cashierId, cashierId) as any[];

  for (const row of rows) {
    let receipt: any = null;
    try {
      receipt = row.receipt_json ? JSON.parse(String(row.receipt_json)) : null;
    } catch {
      receipt = null;
    }
    if (receipt?.reassignedToUserId) continue; // superseded by a later reassignment
    const months = Math.max(1, Math.floor(Number(receipt?.months) || 1));
    if (months !== linkMonths) continue;
    if (linkAmount > 0 && Math.abs((Number(row.amount) || 0) - linkAmount) > 0.05) continue;
    if (paidAt) {
      const txAt = Date.parse(String(row.created_at || '')) || 0;
      // Reassigned payments create a fresh tx — allow a wider window from original paid_at
      if (txAt && paidAt && txAt < paidAt - 60_000) continue;
    }
    return { id: Number(row.id), receipt: receipt || getTransactionReceipt(Number(row.id)) };
  }

  const collectible = db
    .prepare(
      `SELECT transaction_id AS transactionId FROM cashier_collectibles
       WHERE payment_link_id = ? AND transaction_id IS NOT NULL
       ORDER BY id DESC LIMIT 1`
    )
    .get(Number(link.id)) as { transactionId?: number } | undefined;
  if (collectible?.transactionId) {
    const receipt = getTransactionReceipt(Number(collectible.transactionId));
    if (receipt && !(receipt as any).reassignedToUserId) {
      return { id: Number(collectible.transactionId), receipt };
    }
  }
  return null;
}

/**
 * Merchant: move a processed payment from one subscriber to another.
 * Old subscriber due date is reversed; new subscriber gets the extension.
 */
export async function reassignCashierPayment(opts: {
  paymentLinkId: number;
  newPppoeUserId: number;
  cashier: { id: number; username: string };
}) {
  const link = db.prepare('SELECT * FROM payment_links WHERE id = ?').get(opts.paymentLinkId) as any;
  if (!link) throw new Error('Payment not found');
  if (Number(link.cashier_user_id) !== Number(opts.cashier.id)) {
    throw new Error('You can only reassign payments you processed');
  }
  if (String(link.status) !== 'paid') throw new Error('Only processed payments can be reassigned');

  const oldUserId = Number(link.pppoe_user_id);
  const newUserId = Number(opts.newPppoeUserId);
  if (!newUserId || !Number.isFinite(newUserId)) throw new Error('Select the new subscriber');
  if (oldUserId === newUserId) throw new Error('Select a different subscriber');

  const oldUser = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(oldUserId) as any;
  if (!oldUser) throw new Error('Original subscriber not found');
  const newUser = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(newUserId) as any;
  if (!newUser) throw new Error('New subscriber not found');

  const found = findCashierPaymentTransaction(link);
  const receipt = found?.receipt || {};

  const months = Math.max(1, Math.floor(Number(receipt.months) || Number(link.months) || 1));
  const previousDue = receipt.previousDue ? String(receipt.previousDue).slice(0, 10) : null;
  const expectedNewDue = receipt.newDue ? String(receipt.newDue).slice(0, 10) : null;
  const currentDue = String(oldUser.subscription_due || '').slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  let restoredDue: string;
  if (previousDue && expectedNewDue && currentDue === expectedNewDue) {
    restoredDue = previousDue;
  } else if (previousDue && expectedNewDue && currentDue > expectedNewDue) {
    // Later payments stacked on top — peel off this payment's months.
    restoredDue = addMonthsPreserveDay(currentDue, -months);
  } else if (previousDue && currentDue && currentDue === previousDue) {
    throw new Error('Original subscriber due date already looks reversed — contact admin');
  } else if (currentDue) {
    restoredDue = addMonthsPreserveDay(currentDue, -months);
  } else if (previousDue) {
    restoredDue = previousDue;
  } else {
    throw new Error('Could not determine the original due date to reverse');
  }

  db.prepare(`UPDATE pppoe_users SET subscription_due = ? WHERE id = ?`).run(restoredDue, oldUserId);
  const oldUpdated = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(oldUserId) as any;

  const reverseReceipt = {
    type: 'payment_reassign_out',
    months,
    previousDue: currentDue,
    newDue: restoredDue,
    fromPaymentLinkId: Number(link.id),
    fromTransactionId: found?.id || null,
    reassignedToUserId: newUserId,
    reassignedToUsername: newUser.username,
    cashier: opts.cashier.username,
    at: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO transactions
       (pppoe_user_id, customer_name, amount, type, created_at, receipt_json, cashier_user_id, cashier_username)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    oldUserId,
    oldUser.customer_name || oldUser.username,
    0,
    'payment_reassign_out',
    new Date().toISOString(),
    JSON.stringify(reverseReceipt),
    opts.cashier.id,
    opts.cashier.username
  );

  if (found?.id) {
    try {
      const patched = {
        ...(typeof receipt === 'object' && receipt ? receipt : {}),
        reassignedToUserId: newUserId,
        reassignedToUsername: newUser.username,
        reassignedAt: new Date().toISOString(),
        reassignedBy: opts.cashier.username,
      };
      db.prepare('UPDATE transactions SET receipt_json = ? WHERE id = ?').run(
        JSON.stringify(patched),
        found.id
      );
    } catch {
      /* ignore */
    }
  }

  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
    'info',
    'billing',
    `Merchant ${opts.cashier.username} reassigned payment link #${link.id}: ${oldUser.username} due ${currentDue} → ${restoredDue}; applying +${months}mo to ${newUser.username}`
  );

  // Refresh router schedule for the old subscriber (may now be overdue).
  scheduleRouterExpiry(oldUpdated, oldUpdated.expiration_profile).catch(() => undefined);
  if (restoredDue < today) {
    syncUserToRouter(oldUpdated, 'expire').catch(() => undefined);
  } else {
    // Keep comment/due in sync on the router secret.
    syncUserToRouter(oldUpdated, 'restore').catch(() => undefined);
  }

  const payment = await recordPppoePayment(newUserId, {
    months,
    source: `cashier-reassign:${opts.cashier.username}:link:${link.id}`,
    external_ref: link.external_ref || undefined,
    cashierUserId: opts.cashier.id,
    cashierUsername: opts.cashier.username,
  });

  db.prepare('UPDATE payment_links SET pppoe_user_id = ? WHERE id = ?').run(newUserId, link.id);
  try {
    db.prepare(
      `UPDATE cashier_collectibles SET
         pppoe_user_id = ?,
         subscriber_username = ?,
         customer_name = ?,
         account_number = ?,
         transaction_id = COALESCE(?, transaction_id)
       WHERE payment_link_id = ?`
    ).run(
      newUserId,
      newUser.username || null,
      newUser.customer_name || null,
      newUser.account_number || null,
      Number((payment as any)?.transactionId) || null,
      link.id
    );
  } catch {
    /* ignore if no collectible */
  }

  // SMS confirmation for the new subscriber (same as a fresh payment).
  try {
    const contact = String((payment as any)?.user?.contact || newUser.contact || '').trim();
    const total = Number(link.amount) || Number((payment as any)?.total ?? (payment as any)?.amount) || 0;
    const smsUser = (payment as any)?.user || newUser;
    if (smsUser && contact) {
      const { sendPaymentConfirmationSms } = await import('./notify.js');
      sendPaymentConfirmationSms({ ...smsUser, contact }, total).catch(() => undefined);
    }
  } catch {
    /* never block on SMS */
  }

  return {
    ok: true,
    paymentLinkId: link.id,
    months,
    amount: Number(link.amount) || Number((payment as any)?.amount) || 0,
    from: {
      userId: oldUserId,
      username: oldUser.username,
      previousDue: currentDue,
      subscriptionDue: restoredDue,
    },
    to: {
      userId: newUserId,
      username: newUser.username,
      previousDue: (payment as any)?.previousDue,
      subscriptionDue: (payment as any)?.subscriptionDue,
    },
    payment,
  };
}


/**
 * Merchant: cancel a processed cash payment — reverse due date, drop remittance
 * queue item (if still open), and SMS the subscriber.
 */
export async function cancelCashierCashPayment(opts: {
  paymentLinkId: number;
  cashier: { id: number; username: string };
  reason?: string | null;
}) {
  const link = db.prepare('SELECT * FROM payment_links WHERE id = ?').get(opts.paymentLinkId) as any;
  if (!link) throw new Error('Payment not found');
  if (Number(link.cashier_user_id) !== Number(opts.cashier.id)) {
    throw new Error('You can only cancel payments you processed');
  }
  if (String(link.status) !== 'paid') throw new Error('Only processed payments can be cancelled');

  const channel = String(link.pay_channel || '').toLowerCase();
  if (channel !== 'cash') {
    throw new Error('Only cash payments can be cancelled from the merchant portal');
  }

  const userId = Number(link.pppoe_user_id);
  const user = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(userId) as any;
  if (!user) throw new Error('Subscriber not found');

  const collectible = db
    .prepare('SELECT * FROM cashier_collectibles WHERE payment_link_id = ? ORDER BY id DESC LIMIT 1')
    .get(link.id) as any;
  if (collectible) {
    const st = String(collectible.status || '').toLowerCase();
    if (st === 'collected') {
      throw new Error('This cash payment was already remitted and accepted — contact admin');
    }
    if (st === 'submitted') {
      throw new Error(
        'This cash payment is in a pending remittance — ask admin to reject the deposit first'
      );
    }
  }

  const found = findCashierPaymentTransaction(link);
  const receipt = found?.receipt || {};
  if (receipt?.cancelledAt) {
    throw new Error('This payment was already cancelled');
  }

  const months = Math.max(1, Math.floor(Number(receipt.months) || Number(link.months) || 1));
  const previousDue = receipt.previousDue ? String(receipt.previousDue).slice(0, 10) : null;
  const expectedNewDue = receipt.newDue ? String(receipt.newDue).slice(0, 10) : null;
  const currentDue = String(user.subscription_due || '').slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const amount = Number(link.amount) || Number(receipt.total) || 0;

  let restoredDue: string;
  if (previousDue && expectedNewDue && currentDue === expectedNewDue) {
    restoredDue = previousDue;
  } else if (previousDue && expectedNewDue && currentDue > expectedNewDue) {
    restoredDue = addMonthsPreserveDay(currentDue, -months);
  } else if (previousDue && currentDue && currentDue === previousDue) {
    throw new Error('Subscriber due date already looks reversed — contact admin');
  } else if (currentDue) {
    restoredDue = addMonthsPreserveDay(currentDue, -months);
  } else if (previousDue) {
    restoredDue = previousDue;
  } else {
    throw new Error('Could not determine the original due date to reverse');
  }

  const reason = opts.reason ? String(opts.reason).trim().slice(0, 240) : null;

  db.prepare(`UPDATE pppoe_users SET subscription_due = ? WHERE id = ?`).run(restoredDue, userId);
  const updated = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(userId) as any;

  const cancelReceipt = {
    type: 'payment_cancelled',
    months,
    previousDue: currentDue,
    newDue: restoredDue,
    amount,
    fromPaymentLinkId: Number(link.id),
    fromTransactionId: found?.id || null,
    cashier: opts.cashier.username,
    reason,
    at: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO transactions
       (pppoe_user_id, customer_name, amount, type, created_at, receipt_json, cashier_user_id, cashier_username)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    userId,
    user.customer_name || user.username,
    0,
    'payment_cancelled',
    new Date().toISOString(),
    JSON.stringify(cancelReceipt),
    opts.cashier.id,
    opts.cashier.username
  );

  if (found?.id) {
    try {
      const patched = {
        ...(typeof receipt === 'object' && receipt ? receipt : {}),
        cancelledAt: new Date().toISOString(),
        cancelledBy: opts.cashier.username,
        cancelledDueRestored: restoredDue,
        cancelReason: reason,
      };
      db.prepare('UPDATE transactions SET receipt_json = ? WHERE id = ?').run(
        JSON.stringify(patched),
        found.id
      );
    } catch {
      /* ignore */
    }
  }

  db.prepare(
    `UPDATE payment_links SET
       status = 'cancelled',
       reviewed_at = datetime('now'),
       review_note = ?
     WHERE id = ?`
  ).run(reason || `Cancelled by merchant ${opts.cashier.username}`, link.id);

  if (collectible?.id && String(collectible.status).toLowerCase() === 'open') {
    db.prepare(
      `UPDATE cashier_collectibles SET status = 'rejected', collected_at = datetime('now')
       WHERE id = ? AND status = 'open'`
    ).run(collectible.id);
  }

  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
    'info',
    'billing',
    `Merchant ${opts.cashier.username} cancelled cash payment link #${link.id} for ${user.username}: due ${currentDue} → ${restoredDue}${reason ? ` (${reason})` : ''}`
  );

  scheduleRouterExpiry(updated, updated.expiration_profile).catch(() => undefined);
  if (restoredDue < today) {
    syncUserToRouter(updated, 'expire').catch(() => undefined);
  } else {
    syncUserToRouter(updated, 'restore').catch(() => undefined);
  }

  let sms: { sent: boolean; detail: string } = { sent: false, detail: 'skipped' };
  try {
    const contact = String(updated.contact || user.contact || '').trim();
    if (contact) {
      const { sendPaymentCancelledSms } = await import('./notify.js');
      sms = await sendPaymentCancelledSms({ ...updated, contact }, amount);
    } else {
      sms = { sent: false, detail: 'no phone number on file' };
    }
  } catch (e: any) {
    sms = { sent: false, detail: e?.message || 'SMS failed' };
  }

  return {
    ok: true,
    paymentLinkId: link.id,
    months,
    amount,
    username: user.username,
    previousDue: currentDue,
    subscriptionDue: restoredDue,
    sms,
  };
}
