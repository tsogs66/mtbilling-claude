/**
 * Simple in-memory login rate limiter (per IP + username).
 */
type Bucket = { fails: number; firstAt: number; blockedUntil: number };

const buckets = new Map<string, Bucket>();

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 8;
const BLOCK_MS = 15 * 60 * 1000;

function key(ip: string, username: string) {
  return `${ip || '?'}|${String(username || '').trim().toLowerCase()}`;
}

export function loginRateLimitCheck(ip: string, username: string): { ok: true } | { ok: false; retryAfterSec: number } {
  const k = key(ip, username);
  const b = buckets.get(k);
  if (!b) return { ok: true };
  const now = Date.now();
  if (b.blockedUntil > now) {
    return { ok: false, retryAfterSec: Math.ceil((b.blockedUntil - now) / 1000) };
  }
  if (now - b.firstAt > WINDOW_MS) {
    buckets.delete(k);
    return { ok: true };
  }
  return { ok: true };
}

export function loginRateLimitFail(ip: string, username: string) {
  const k = key(ip, username);
  const now = Date.now();
  let b = buckets.get(k);
  if (!b || now - b.firstAt > WINDOW_MS) {
    b = { fails: 1, firstAt: now, blockedUntil: 0 };
  } else {
    b.fails += 1;
  }
  if (b.fails >= MAX_FAILS) {
    b.blockedUntil = now + BLOCK_MS;
  }
  buckets.set(k, b);
}

export function loginRateLimitSuccess(ip: string, username: string) {
  buckets.delete(key(ip, username));
}
