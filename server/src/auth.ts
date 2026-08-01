import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { db, dataDir } from './db.js';
import { ALL_PERMISSIONS, getLicenseStatus } from './extra.js';

/** Historical hardcoded default — treated as "unset" so old .env files don't silently stay weak. */
const KNOWN_WEAK_DEFAULTS = new Set(['change-me-in-production', '']);

/**
 * Resolve the JWT signing secret. Prefers `JWT_SECRET` from the environment; if
 * that's unset (or still the old hardcoded default), falls back to a random
 * secret generated on first boot and persisted locally so tokens survive
 * restarts. That file is gitignored and unique per install, so it's never
 * shipped in source the way a hardcoded fallback would be.
 */
function resolveSecret(): string {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && !KNOWN_WEAK_DEFAULTS.has(fromEnv)) return fromEnv;

  const secretPath = path.join(dataDir, '.jwt-secret');
  try {
    const existing = fs.readFileSync(secretPath, 'utf8').trim();
    if (existing) return existing;
  } catch {
    // fall through to generation
  }
  const generated = crypto.randomBytes(48).toString('hex');
  try {
    const tmp = `${secretPath}.tmp`;
    fs.writeFileSync(tmp, generated, { mode: 0o600 });
    fs.renameSync(tmp, secretPath);
  } catch (e) {
    console.warn('[auth] could not persist generated JWT secret, tokens will invalidate on restart:', e);
  }
  console.warn(
    '[auth] JWT_SECRET not set in server/.env — generated and persisted a random secret at ' +
      secretPath +
      '. Set JWT_SECRET explicitly if you run multiple server instances behind a load balancer.'
  );
  return generated;
}

const SECRET = resolveSecret();

export interface AuthedRequest extends Request {
  user?: { id: number; username: string; role: string };
}

/** Session lifetime — long enough for a full ops day without surprise logouts. */
export const SESSION_TTL = '7d';

export function signToken(payload: { id: number; username: string; role: string }) {
  return jwt.sign(payload, SECRET, { expiresIn: SESSION_TTL });
}

/** True when the token expires within `withinMs` (default 24h) — used for sliding refresh. */
export function tokenNeedsRefresh(token: string, withinMs = 24 * 60 * 60 * 1000): boolean {
  try {
    const payload = jwt.decode(token) as { exp?: number } | null;
    if (!payload?.exp) return false;
    return payload.exp * 1000 - Date.now() < withinMs;
  } catch {
    return false;
  }
}

/** Short-lived token issued after password check when 2FA is enabled — proves
 *  "who", not "logged in". Only /api/login/totp accepts it (see
 *  verifyPendingTotpToken); requireAuth explicitly rejects anything carrying a
 *  `purpose` claim so this can never be replayed against the general API even
 *  with reduced permissions. */
export function signPendingTotpToken(userId: number) {
  return jwt.sign({ id: userId, purpose: 'totp-pending' }, SECRET, { expiresIn: '5m' });
}

export function verifyPendingTotpToken(token: string): number | null {
  try {
    const payload = jwt.verify(token, SECRET) as { id?: number; purpose?: string };
    if (payload?.purpose !== 'totp-pending' || !payload.id) return null;
    return Number(payload.id);
  } catch {
    return null;
  }
}

export function verifyToken(token: string): AuthedRequest['user'] {
  const payload = jwt.verify(token, SECRET) as AuthedRequest['user'] & { purpose?: string };
  if (payload?.purpose) throw new Error('Token is not a session token');
  return payload;
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing token' });
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    return res.status(401).json({ error: 'invalid token' });
  }
}

/** Built-in viewer role — browse everything, never mutate. */
export function roleIsReadOnlyByName(roleName: string): boolean {
  return /^read[\s_-]?only$/i.test(String(roleName || '').trim());
}

/** Resolve permission list for a panel role name. */
export function permissionsForRole(roleName: string): string[] {
  if (!roleName) return ['dashboard', 'license'];
  if (roleName === 'superadmin' || roleName === 'admin') return ['*'];
  const row = db.prepare('SELECT permissions FROM roles WHERE name = ?').get(roleName) as
    | { permissions: string }
    | undefined;
  if (!row) {
    // Unknown role string — treat Administrator-like names as full access
    if (/admin/i.test(roleName)) return ['*'];
    if (roleIsReadOnlyByName(roleName)) return [...ALL_PERMISSIONS, 'readonly'];
    return ['dashboard', 'license'];
  }
  let perms: string[] = [];
  try {
    const parsed = JSON.parse(row.permissions || '[]');
    perms = Array.isArray(parsed) ? parsed.map(String) : ['dashboard', 'license'];
  } catch {
    perms = ['dashboard', 'license'];
  }
  // Viewer / Read-only: always grant every menu for browsing (writes blocked separately).
  if (roleIsReadOnlyByName(roleName) || perms.includes('readonly')) {
    return [...new Set([...ALL_PERMISSIONS, 'readonly', ...perms.filter((p) => p !== '*')])];
  }
  return perms;
}

export function roleIsReadOnly(roleName: string): boolean {
  if (roleIsReadOnlyByName(roleName)) return true;
  const perms = permissionsForRole(roleName);
  return perms.includes('readonly');
}

export function userHasPermission(roleName: string, permission: string): boolean {
  const perms = permissionsForRole(roleName);
  if (perms.includes('*')) return true;
  return perms.includes(permission);
}

/** Build the session payload returned by /login and /me. */
export function sessionPayload(user: { id: number; username: string; role: string }) {
  const license = getLicenseStatus();
  const permissions = permissionsForRole(user.role);
  const roleReadOnly = roleIsReadOnly(user.role);
  const canWrite = !!license.activated && !roleReadOnly;
  return {
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      permissions,
      licenseActivated: license.activated,
      readOnly: !canWrite,
      canWrite,
    },
    license: {
      activated: license.activated,
      expired: license.expired,
      expiresAt: license.expiresAt,
      duration: license.duration,
    },
  };
}

/**
 * After auth: if license is inactive, allow viewing (GET) everywhere,
 * but block mutating requests except license activation.
 */
export function requireLicenseOrAllowlist(req: AuthedRequest, res: Response, next: NextFunction) {
  const license = getLicenseStatus();
  if (license.activated) return next();

  const method = (req.method || 'GET').toUpperCase();
  const path = (req.path || '').replace(/^\/api/, '') || req.url.split('?')[0];

  // Read-only browsing is allowed for the full panel
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

  // License activation / deactivation must still work
  if (method === 'POST' && /^\/license\/(activate|deactivate)$/.test(path)) return next();

  return res.status(403).json({
    error: 'License required',
    code: 'LICENSE_READONLY',
    message: 'Panel is read-only until a license is activated. You can view data but cannot make changes.',
  });
}

/**
 * Viewer / Read-only role: allow GET everywhere, block all mutations.
 */
export function requireRoleWritable(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.user || !roleIsReadOnly(req.user.role)) return next();

  const method = (req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

  return res.status(403).json({
    error: 'Read-only account',
    code: 'ROLE_READONLY',
    message: 'Viewer accounts can browse the system but cannot make changes.',
  });
}
