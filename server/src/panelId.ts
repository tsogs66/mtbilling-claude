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

/**
 * License keys and password-reset codes are Ed25519 signatures, not shared-secret
 * HMACs. Only the PUBLIC key lives here (safe to publish — every self-hosted
 * customer has this file on their own server). The matching PRIVATE key is held
 * only by the vendor's offline `activator/` tool and is never committed to this
 * repo — that asymmetry is what makes codes unforgeable even though the panel's
 * own verification source is public.
 *
 * Regenerate both halves with `node activator/generate-keys.cjs` and paste the
 * printed public-key value below. Keep the private key file it writes out of git.
 */
const LICENSE_PUBLIC_KEY_X = 'mSAK26oPFmnMU8EE0hkMkCDSXjNx2gz5p7CHJJyvZzM';

let cachedPublicKey: crypto.KeyObject | null = null;
function licensePublicKey(): crypto.KeyObject {
  if (!cachedPublicKey) {
    cachedPublicKey = crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: LICENSE_PUBLIC_KEY_X },
      format: 'jwk',
    });
  }
  return cachedPublicKey;
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(str: string): Buffer {
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Ed25519-verify a base32-encoded 64-byte signature over `message`. */
function verifySignature(message: string, signatureB32: string): boolean {
  const sig = base32Decode(signatureB32);
  if (sig.length !== 64) return false;
  try {
    return crypto.verify(null, Buffer.from(message, 'utf8'), licensePublicKey(), sig);
  } catch {
    return false;
  }
}

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

export function durationDays(durationId: string): number | null {
  const d = LICENSE_DURATIONS.find((x) => x.id === String(durationId).toLowerCase());
  return d ? d.days : null;
}

/** Split a pasted license key into its base32 signature body and duration suffix. */
export function parseLicenseKey(key: string): { body: string; duration: LicenseDurationId | null } {
  const raw = String(key || '').toUpperCase().trim();
  const parts = raw.split('-').filter(Boolean);
  if (parts.length >= 2) {
    const durPart = parts[parts.length - 1].toLowerCase();
    const known = LICENSE_DURATIONS.find((d) => d.id === durPart);
    if (known) {
      return { body: normalizeCode(parts.slice(0, -1).join('')), duration: known.id };
    }
  }
  return { body: normalizeCode(parts.join('')), duration: null };
}

/**
 * Validate a license key against this hardware ID. Keys are Ed25519 signatures
 * over `LIC|<normalized hwid>|<duration>`, generated only by the vendor's
 * offline activator (which holds the private key).
 */
export function validateLicenseKey(
  hwid: string,
  key: string
): { ok: true; duration: LicenseDurationId; licenseKey: string } | { ok: false } {
  const parsed = parseLicenseKey(key);
  if (!parsed.duration || !parsed.body) return { ok: false };

  const norm = normalizeCode(hwid);
  const message = `LIC|${norm}|${parsed.duration}`;
  if (!verifySignature(message, parsed.body)) return { ok: false };

  const canonical = `${parsed.body.match(/.{1,5}/g)?.join('-') || parsed.body}-${parsed.duration.toUpperCase()}`;
  return { ok: true, duration: parsed.duration, licenseKey: canonical };
}

export function expiresAtFromDuration(duration: LicenseDurationId, from = new Date()): string | null {
  const days = durationDays(duration);
  if (days == null) return null;
  const d = new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

/**
 * Validate a password-reset code (`RST-...`) against this hardware ID. The code
 * is an Ed25519 signature over `RST|<normalized hwid>`, generated only by the
 * vendor's offline activator.
 */
export function verifyPasswordResetCode(hwid: string, code: string): boolean {
  const norm = normalizeCode(hwid);
  const body = normalizeCode(code).replace(/^RST/, '');
  return verifySignature(`RST|${norm}`, body);
}
