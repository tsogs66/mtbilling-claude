/**
 * Subscriber self-service Wi-Fi: input rules, the current SSID read from the
 * ACS device document, and a per-subscriber change limit. The push itself goes
 * through setAcsWifiCredentials (genieacs.ts), the same TR-069 path the
 * Operations Desk uses.
 */
import { db } from './db.js';
import { ACS_PARAMETER_PRESETS, readAcsParam } from './genieacs.js';

export const WIFI_MAX_CHANGES_PER_HOUR = 5;

export type WifiInput =
  | { ok: true; ssid?: string; password?: string }
  | { ok: false; error: string };

/** SSID: 1-32 bytes. Password: WPA2 passphrase, 8-63 printable ASCII characters. */
export function validateWifiInput(body: any): WifiInput {
  const rawSsid = body?.ssid == null ? '' : String(body.ssid);
  const rawPassword = body?.password == null ? '' : String(body.password);
  const ssid = rawSsid.trim();
  if (!ssid && !rawPassword) return { ok: false, error: 'Enter a new Wi-Fi name, a new password, or both.' };

  if (ssid) {
    if (/[\x00-\x1f\x7f]/.test(ssid)) return { ok: false, error: 'The Wi-Fi name contains characters that are not allowed.' };
    if (Buffer.byteLength(ssid, 'utf8') > 32) return { ok: false, error: 'The Wi-Fi name can be at most 32 characters.' };
  }
  if (rawPassword) {
    if (!/^[\x20-\x7e]+$/.test(rawPassword)) {
      return { ok: false, error: 'The password may only use letters, numbers, spaces and common symbols.' };
    }
    if (rawPassword.length < 8 || rawPassword.length > 63) {
      return { ok: false, error: 'The Wi-Fi password must be 8 to 63 characters.' };
    }
    if (rawPassword !== rawPassword.trim()) {
      return { ok: false, error: 'The Wi-Fi password cannot start or end with a space.' };
    }
  }
  return { ok: true, ssid: ssid || undefined, password: rawPassword || undefined };
}

/** The SSID the device last reported, from whichever data model it speaks. */
export function currentSsid(doc: unknown): string | null {
  if (!doc) return null;
  for (const id of ['wifi-ssid-igd', 'wifi-ssid-tr181']) {
    const preset = ACS_PARAMETER_PRESETS.find((p) => p.id === id);
    for (const path of preset?.paths || []) {
      const hit = readAcsParam(doc, path);
      if (hit && hit.value !== '') return hit.value;
    }
  }
  return null;
}

export function ensureWifiTable(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS portal_wifi_changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pppoe_user_id INTEGER NOT NULL,
      ssid_changed INTEGER NOT NULL DEFAULT 0,
      password_changed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/** Deliberately stores no credentials: only that, and when, a change was made. */
export function recordWifiChange(pppoeUserId: number, ssidChanged: boolean, passwordChanged: boolean): void {
  db.prepare(
    'INSERT INTO portal_wifi_changes (pppoe_user_id, ssid_changed, password_changed) VALUES (?, ?, ?)'
  ).run(pppoeUserId, ssidChanged ? 1 : 0, passwordChanged ? 1 : 0);
}

export function recentWifiChanges(pppoeUserId: number): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM portal_wifi_changes
       WHERE pppoe_user_id = ? AND julianday(created_at) > julianday('now', '-1 hour')`
    )
    .get(pppoeUserId) as { n: number };
  return Number(row?.n) || 0;
}

export function lastWifiChangeAt(pppoeUserId: number): string | null {
  const row = db
    .prepare('SELECT created_at FROM portal_wifi_changes WHERE pppoe_user_id = ? ORDER BY id DESC LIMIT 1')
    .get(pppoeUserId) as { created_at: string } | undefined;
  return row?.created_at || null;
}
