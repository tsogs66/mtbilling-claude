import { db } from './db.js';

export type AcsSettings = {
  acs_enabled: number;
  acs_nbi_url: string | null;
  acs_ui_url: string | null;
  acs_username: string | null;
  acs_password: string | null;
};

export type FlatParam = {
  path: string;
  value: string;
  type?: string;
  timestamp?: number;
};

function columnExists(table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === col);
}

export function initGenieacs() {
  for (const [col, type] of [
    ['acs_enabled', 'INTEGER DEFAULT 0'],
    ['acs_nbi_url', "TEXT DEFAULT 'http://127.0.0.1:7557'"],
    ['acs_ui_url', 'TEXT'],
    ['acs_username', 'TEXT'],
    ['acs_password', 'TEXT'],
  ] as [string, string][]) {
    if (!columnExists('app_settings', col)) db.exec(`ALTER TABLE app_settings ADD COLUMN ${col} ${type}`);
  }
  if (!columnExists('pppoe_users', 'acs_device_id')) {
    db.exec('ALTER TABLE pppoe_users ADD COLUMN acs_device_id TEXT');
  }
  if (db.prepare('SELECT id FROM app_settings WHERE id = 1').get() == null) {
    db.prepare('INSERT INTO app_settings (id) VALUES (1)').run();
  }
}

function getSettingsRow(): AcsSettings {
  initGenieacs();
  return db
    .prepare(
      `SELECT acs_enabled, acs_nbi_url, acs_ui_url, acs_username, acs_password
       FROM app_settings WHERE id = 1`
    )
    .get() as AcsSettings;
}

export function publicAcsConfig() {
  const s = getSettingsRow();
  return {
    enabled: !!s.acs_enabled,
    nbiUrl: s.acs_nbi_url || 'http://127.0.0.1:7557',
    uiUrl: s.acs_ui_url || '',
    username: s.acs_username || '',
    passwordSet: !!s.acs_password,
  };
}

export function saveAcsConfig(body: Record<string, unknown>) {
  const cur = getSettingsRow();
  const enabled = body.enabled != null ? (body.enabled ? 1 : 0) : cur.acs_enabled;
  const nbiUrl =
    body.nbiUrl != null ? String(body.nbiUrl || '').trim() || null : cur.acs_nbi_url;
  const uiUrl = body.uiUrl != null ? String(body.uiUrl || '').trim() || null : cur.acs_ui_url;
  const username =
    body.username != null ? String(body.username || '').trim() || null : cur.acs_username;
  let password = cur.acs_password;
  if (body.password != null && String(body.password).trim() !== '') {
    password = String(body.password);
  }
  db.prepare(
    `UPDATE app_settings SET
       acs_enabled = @acs_enabled,
       acs_nbi_url = @acs_nbi_url,
       acs_ui_url = @acs_ui_url,
       acs_username = @acs_username,
       acs_password = @acs_password
     WHERE id = 1`
  ).run({
    acs_enabled: enabled,
    acs_nbi_url: nbiUrl,
    acs_ui_url: uiUrl,
    acs_username: username,
    acs_password: password,
  });
  return publicAcsConfig();
}

function resolveNbiBase(): string {
  const s = getSettingsRow();
  if (!s.acs_enabled) throw new Error('acs-disabled');
  const base = String(s.acs_nbi_url || '').replace(/\/+$/, '');
  if (!base) throw new Error('acs-nbi-url-missing');
  return base;
}

function authHeaders(): Record<string, string> {
  const s = getSettingsRow();
  const h: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'MT-Billing-ACS',
  };
  if (s.acs_username && s.acs_password) {
    const token = Buffer.from(`${s.acs_username}:${s.acs_password}`).toString('base64');
    h.Authorization = `Basic ${token}`;
  }
  return h;
}

export async function acsRequest(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string>
): Promise<{ ok: true; data: unknown; status: number } | { ok: false; status: number; error: string }> {
  const base = resolveNbiBase();
  const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
  const url = `${base}${path.startsWith('/') ? path : `/${path}`}${qs}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...authHeaders(),
        ...(body != null ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const msg =
        typeof data === 'object' && data && 'message' in (data as object)
          ? String((data as { message: string }).message)
          : typeof data === 'string'
            ? data.slice(0, 200)
            : `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: msg };
    }
    return { ok: true, data, status: res.status };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/abort/i.test(msg)) return { ok: false, status: 0, error: 'ACS request timed out' };
    return { ok: false, status: 0, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

export async function testAcsConnection(): Promise<{ ok: boolean; message: string; deviceCount?: number }> {
  const cfg = publicAcsConfig();
  if (!cfg.enabled) return { ok: false, message: 'Enable TR-069 / GenieACS in settings first.' };
  const r = await acsRequest('GET', '/devices/', undefined, { limit: '1' });
  if (!r.ok) {
    return {
      ok: false,
      message: `Cannot reach GenieACS NBI at ${cfg.nbiUrl}: ${r.error}`,
    };
  }
  const list = await acsRequest('GET', '/devices/', undefined, { limit: '500' });
  const count = list.ok && Array.isArray(list.data) ? list.data.length : undefined;
  return {
    ok: true,
    message: `Connected to GenieACS NBI (${cfg.nbiUrl}).`,
    deviceCount: count,
  };
}

export async function listAcsDevices(opts?: { query?: string; limit?: number }) {
  const q: Record<string, string> = { limit: String(opts?.limit ?? 200) };
  if (opts?.query?.trim()) q.query = opts.query.trim();
  const r = await acsRequest('GET', '/devices/', undefined, q);
  if (!r.ok) throw new Error(r.error);
  return Array.isArray(r.data) ? r.data : [];
}

export async function getAcsDevice(deviceId: string) {
  const id = encodeURIComponent(deviceId);
  const r = await acsRequest('GET', `/devices/${id}`);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

export async function postAcsTask(deviceId: string, task: Record<string, unknown>, connectionRequest = true) {
  const id = encodeURIComponent(deviceId);
  const q = connectionRequest ? { connection_request: 'true' } : undefined;
  const r = await acsRequest('POST', `/devices/${id}/tasks`, task, q);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

export async function refreshAcsDevice(deviceId: string, objectName = 'InternetGatewayDevice.') {
  return postAcsTask(deviceId, { name: 'refreshObject', objectName });
}

export async function rebootAcsDevice(deviceId: string) {
  return postAcsTask(deviceId, { name: 'reboot' });
}

export async function getAcsParameterValues(deviceId: string, parameterNames: string[]) {
  return postAcsTask(deviceId, { name: 'getParameterValues', parameterNames });
}

export async function setAcsParameterValues(
  deviceId: string,
  parameterValues: [string, string, string][]
) {
  return postAcsTask(deviceId, { name: 'setParameterValues', parameterValues });
}

/** Walk GenieACS device document and collect TR-069 parameter paths. */
export function flattenAcsParameters(root: unknown, prefix = ''): FlatParam[] {
  const out: FlatParam[] = [];
  if (root == null || typeof root !== 'object') return out;
  const obj = root as Record<string, unknown>;
  for (const [key, val] of Object.entries(obj)) {
    if (key.startsWith('_')) continue;
    const path = prefix ? `${prefix}${key}` : key;
    if (val != null && typeof val === 'object' && !Array.isArray(val)) {
      const rec = val as Record<string, unknown>;
      if ('_value' in rec) {
        out.push({
          path,
          value: rec._value == null ? '' : String(rec._value),
          type: rec._type != null ? String(rec._type) : undefined,
          timestamp: typeof rec._timestamp === 'number' ? rec._timestamp : undefined,
        });
      } else {
        out.push(...flattenAcsParameters(val, `${path}.`));
      }
    }
  }
  return out;
}

export const ACS_PARAMETER_PRESETS: { id: string; label: string; paths: string[]; writable?: boolean }[] = [
  {
    id: 'wifi-ssid-igd',
    label: 'Wi‑Fi SSID (TR-098)',
    paths: ['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID'],
    writable: true,
  },
  {
    id: 'wifi-pass-igd',
    label: 'Wi‑Fi password (TR-098)',
    paths: [
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase',
      'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.PreSharedKey',
    ],
    writable: true,
  },
  {
    id: 'wifi-ssid-tr181',
    label: 'Wi‑Fi SSID (TR-181)',
    paths: ['Device.WiFi.SSID.1.SSID', 'Device.WiFi.SSID.2.SSID'],
    writable: true,
  },
  {
    id: 'wifi-pass-tr181',
    label: 'Wi‑Fi password (TR-181)',
    paths: ['Device.WiFi.AccessPoint.1.Security.KeyPassphrase'],
    writable: true,
  },
  {
    id: 'serial',
    label: 'Serial number',
    paths: [
      'InternetGatewayDevice.DeviceInfo.SerialNumber',
      'Device.DeviceInfo.SerialNumber',
    ],
  },
  {
    id: 'model',
    label: 'Model',
    paths: ['InternetGatewayDevice.DeviceInfo.ModelName', 'Device.DeviceInfo.ModelName'],
  },
  {
    id: 'wan-ip',
    label: 'WAN IP',
    paths: [
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
      'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
      'Device.IP.Interface.1.IPv4Address.1.IPAddress',
    ],
  },
];

export function pickFirstParam(params: FlatParam[], paths: string[]): FlatParam | undefined {
  const map = new Map(params.map((p) => [p.path, p]));
  for (const path of paths) {
    const hit = map.get(path);
    if (hit && hit.value !== '') return hit;
  }
  return undefined;
}

export function listSubscriberAcsLinks() {
  return db
    .prepare(
      `SELECT id, username, customer_name, account_number, acs_device_id, service, status
       FROM pppoe_users
       WHERE acs_device_id IS NOT NULL AND trim(acs_device_id) != ''
       ORDER BY customer_name`
    )
    .all();
}

export function linkSubscriberDevice(pppoeUserId: number, deviceId: string | null) {
  const id = Number(pppoeUserId);
  const row = db.prepare('SELECT id FROM pppoe_users WHERE id = ?').get(id);
  if (!row) throw new Error('subscriber-not-found');
  const dev = deviceId != null ? String(deviceId).trim() || null : null;
  db.prepare('UPDATE pppoe_users SET acs_device_id = ? WHERE id = ?').run(dev, id);
  return db.prepare('SELECT id, username, customer_name, acs_device_id FROM pppoe_users WHERE id = ?').get(id);
}
