import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { db } from './db.js';
import { ALL_PERMISSIONS, getLicenseStatus } from './extra.js';

const SECRET = process.env.JWT_SECRET || 'change-me-in-production';

export interface AuthedRequest extends Request {
  user?: { id: number; username: string; role: string };
}

export function signToken(payload: { id: number; username: string; role: string }) {
  return jwt.sign(payload, SECRET, { expiresIn: '12h' });
}

export function verifyToken(token: string): AuthedRequest['user'] {
  return jwt.verify(token, SECRET) as AuthedRequest['user'];
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
