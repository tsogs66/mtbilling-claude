/**
 * Subscriber-portal password helpers.
 *
 * Default login is account number + the phone/contact on file. Subscribers
 * type that number in many shapes (09…, +63…, spaces, dashes). Matching must
 * accept those variants, and first-login "set a new password" must allow
 * keeping the phone number as the chosen password.
 */
import bcrypt from 'bcryptjs';

export function defaultPortalPasswordFromContact(contact: string | null | undefined): string {
  return String(contact || '').trim();
}

export function validateChosenPortalPassword(password: string): string | null {
  const pw = String(password || '');
  if (pw.length < 6) return 'Password must be at least 6 characters';
  if (pw.length > 64) return 'Password must be at most 64 characters';
  if (/\s/.test(pw)) return 'Password cannot contain spaces';
  return null;
}

function digitsOnly(value: string): string {
  return String(value || '').replace(/[^0-9]/g, '');
}

/** Normalize a PH mobile to 63XXXXXXXXXX when the input looks like one. */
export function normalizePhMobile(value: string): string {
  const digits = digitsOnly(value);
  if (digits.startsWith('63') && digits.length >= 12) return digits;
  if (digits.startsWith('0') && digits.length >= 11) return `63${digits.slice(1)}`;
  if (digits.startsWith('9') && digits.length === 10) return `63${digits}`;
  return digits;
}

export function looksLikePhonePassword(value: string): boolean {
  const d = digitsOnly(value);
  if (d.length < 10 || d.length > 13) return false;
  if (d.startsWith('63') && d.length >= 12) return d[2] === '9';
  if (d.startsWith('0') && d.length === 11) return d[1] === '9';
  if (d.startsWith('9') && d.length === 10) return true;
  return false;
}

/** Distinct strings a subscriber might type (or we might have hashed) for a phone. */
export function portalPasswordCandidates(plain: string): string[] {
  const raw = String(plain || '').trim();
  const out: string[] = [];
  const add = (v: string) => {
    if (v && !out.includes(v)) out.push(v);
  };
  add(raw);
  const digits = digitsOnly(raw);
  add(digits);

  let national = '';
  if (digits.startsWith('63') && digits.length >= 12) national = digits.slice(2);
  else if (digits.startsWith('0') && digits.length >= 11) national = digits.slice(1);
  else if (digits.startsWith('9') && digits.length === 10) national = digits;

  if (national.length >= 10) {
    add(`0${national}`);
    add(national);
    add(`63${national}`);
    add(`+63${national}`);
  }
  return out;
}

export function phonesEquivalent(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizePhMobile(String(a || ''));
  const nb = normalizePhMobile(String(b || ''));
  return !!na && !!nb && na === nb;
}

/** True when the typed password is the account's default (phone) password. */
export function isDefaultPortalPassword(
  password: string,
  contact: string | null | undefined
): boolean {
  const def = defaultPortalPasswordFromContact(contact);
  const typed = String(password || '').trim();
  if (!def || !typed) return false;
  if (typed === def) return true;
  return phonesEquivalent(typed, def);
}

function bcryptCompare(plain: string, hash: string): boolean {
  try {
    return bcrypt.compareSync(plain, hash);
  } catch {
    return false;
  }
}

/**
 * Compare a typed portal password to the stored hash.
 * Tries the exact string first, then a small set of PH mobile variants so
 * "0917…", "+63 917…" and the stored contact all log in against each other.
 */
export function portalPasswordMatches(
  plain: string,
  hash: string | null | undefined,
  contact?: string | null
): boolean {
  if (!hash) return false;
  const raw = String(plain || '').trim();
  if (!raw) return false;
  if (bcryptCompare(raw, String(hash))) return true;

  const candidates: string[] = [];
  const add = (v: string) => {
    if (v && v !== raw && !candidates.includes(v)) candidates.push(v);
  };

  if (contact && isDefaultPortalPassword(raw, contact)) {
    add(String(contact).trim());
    for (const v of portalPasswordCandidates(String(contact))) add(v);
  }
  if (looksLikePhonePassword(raw)) {
    for (const v of portalPasswordCandidates(raw)) add(v);
  }

  let tried = 0;
  for (const c of candidates) {
    if (tried >= 6) break;
    tried += 1;
    if (bcryptCompare(c, String(hash))) return true;
  }
  return false;
}
