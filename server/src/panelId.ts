import os from 'os';
import crypto from 'crypto';

/** Stable panel hardware ID (shown on License and Forgot Password screens). */
export function panelHardwareId(): string {
  const nets = os.networkInterfaces();
  let mac = '';
  for (const key of Object.keys(nets)) {
    for (const ni of nets[key] || []) {
      if (!ni.internal && ni.mac && ni.mac !== '00:00:00:00:00:00') {
        mac = ni.mac;
        break;
      }
    }
    if (mac) break;
  }
  const cpu = os.cpus()[0]?.model || 'cpu';
  const raw = [os.hostname(), mac, os.arch(), os.platform(), cpu].join('|');
  const h = crypto.createHash('sha256').update(raw).digest('hex').toUpperCase();
  return `${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}`;
}

export const LICENSE_SECRET = 'MT-BILLING-LICENSE-2026';
export const PASSWORD_RESET_SECRET = 'MT-BILLING-PASSWORD-RESET-2026';

/** Supported license durations (activator + panel). */
export const LICENSE_DURATIONS = [
  { id: '30d', label: '30 days', days: 30 },
  { id: '90d', label: '90 days', days: 90 },
  { id: '180d', label: '6 months', days: 180 },
  { id: '1y', label: '1 year', days: 365 },
  { id: '2y', label: '2 years', days: 730 },
  { id: 'life', label: 'Lifetime', days: null as number | null },
] as const;

export type LicenseDurationId = (typeof LICENSE_DURATIONS)[number]['id'];

export function normalizeCode(k: string): string {
  return String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function formatKeyBody(hex: string): string {
  return `${hex.slice(0, 5)}-${hex.slice(5, 10)}-${hex.slice(10, 15)}-${hex.slice(15, 20)}`;
}

/** Legacy perpetual key (no duration segment) — treated as lifetime. */
export function expectedLicenseKey(hwid: string): string {
  const norm = normalizeCode(hwid);
  const h = crypto.createHmac('sha256', LICENSE_SECRET).update(norm).digest('hex').toUpperCase();
  return formatKeyBody(h);
}

/** Duration-bound license key: BODY-DURATION (e.g. …-1Y or …-LIFE). */
export function expectedLicenseKeyForDuration(hwid: string, duration: string): string {
  const dur = String(duration || 'life').toLowerCase() as LicenseDurationId;
  const known = LICENSE_DURATIONS.find((d) => d.id === dur);
  const id = known?.id || 'life';
  const norm = normalizeCode(hwid);
  const payload = `${norm}|${id}`;
  const h = crypto.createHmac('sha256', LICENSE_SECRET).update(payload).digest('hex').toUpperCase();
  return `${formatKeyBody(h)}-${id.toUpperCase()}`;
}

export function durationDays(durationId: string): number | null {
  const d = LICENSE_DURATIONS.find((x) => x.id === String(durationId).toLowerCase());
  return d ? d.days : null;
}

export function parseLicenseKey(key: string): { body: string; duration: LicenseDurationId | null } {
  const raw = String(key || '').toUpperCase().trim();
  const parts = raw.split('-').filter(Boolean);
  if (parts.length >= 5) {
    const durPart = parts[parts.length - 1].toLowerCase();
    const known = LICENSE_DURATIONS.find((d) => d.id === durPart);
    if (known) {
      return { body: parts.slice(0, -1).join('-'), duration: known.id };
    }
  }
  return { body: parts.join('-'), duration: null };
}

/**
 * Validate a license key against this hardware ID.
 * Accepts legacy perpetual keys and new duration-suffixed keys.
 */
export function validateLicenseKey(
  hwid: string,
  key: string
): { ok: true; duration: LicenseDurationId; licenseKey: string } | { ok: false } {
  const provided = normalizeCode(key);
  if (!provided) return { ok: false };

  const parsed = parseLicenseKey(key);

  // New format with duration suffix
  if (parsed.duration) {
    const expected = expectedLicenseKeyForDuration(hwid, parsed.duration);
    if (normalizeCode(expected) === provided) {
      return { ok: true, duration: parsed.duration, licenseKey: expected };
    }
    return { ok: false };
  }

  // Legacy perpetual (lifetime)
  const legacy = expectedLicenseKey(hwid);
  if (normalizeCode(legacy) === provided) {
    return { ok: true, duration: 'life', licenseKey: legacy };
  }

  // Also accept duration keys pasted without noticing — try all durations
  for (const d of LICENSE_DURATIONS) {
    const expected = expectedLicenseKeyForDuration(hwid, d.id);
    if (normalizeCode(expected) === provided) {
      return { ok: true, duration: d.id, licenseKey: expected };
    }
  }

  return { ok: false };
}

export function expiresAtFromDuration(duration: LicenseDurationId, from = new Date()): string | null {
  const days = durationDays(duration);
  if (days == null) return null;
  const d = new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

/** Vendor-generated code from panel hardware ID (prefix RST- for identification). */
export function expectedPasswordResetCode(hwid: string): string {
  const norm = normalizeCode(hwid);
  const h = crypto.createHmac('sha256', PASSWORD_RESET_SECRET).update(norm).digest('hex').toUpperCase();
  return `RST-${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}`;
}
