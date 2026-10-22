import { db } from './db.js';

export type AcsSettings = {
  acs_enabled: number;
  acs_nbi_url: string | null;
  acs_ui_url: string | null;
  acs_username: string | null;
  acs_password: string | null;
  acs_autolink_enabled: number | null;
  acs_autolink_interval_min: number | null;
  acs_provision_tags: number | null;
  acs_provision_on_install: number | null;
  acs_cwmp_url: string | null;
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
    ['acs_autolink_enabled', 'INTEGER DEFAULT 1'],
    ['acs_autolink_interval_min', 'INTEGER DEFAULT 15'],
    ['acs_provision_tags', 'INTEGER DEFAULT 1'],
    ['acs_provision_on_install', 'INTEGER DEFAULT 1'],
    ['acs_cwmp_url', 'TEXT'],
  ] as [string, string][]) {
    if (!columnExists('app_settings', col)) db.exec(`ALTER TABLE app_settings ADD COLUMN ${col} ${type}`);
  }
  if (!columnExists('pppoe_users', 'acs_device_id')) {
    db.exec('ALTER TABLE pppoe_users ADD COLUMN acs_device_id TEXT');
  }
  if (!columnExists('pppoe_users', 'cpe_mac')) {
    db.exec('ALTER TABLE pppoe_users ADD COLUMN cpe_mac TEXT');
  }
  if (db.prepare('SELECT id FROM app_settings WHERE id = 1').get() == null) {
    db.prepare('INSERT INTO app_settings (id) VALUES (1)').run();
  }
}

function getSettingsRow(): AcsSettings {
  initGenieacs();
  return db
    .prepare(
      `SELECT acs_enabled, acs_nbi_url, acs_ui_url, acs_username, acs_password,
              acs_autolink_enabled, acs_autolink_interval_min, acs_provision_tags,
              acs_provision_on_install, acs_cwmp_url
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
    autolinkEnabled: s.acs_autolink_enabled == null ? true : !!s.acs_autolink_enabled,
    autolinkIntervalMin: Number(s.acs_autolink_interval_min) || 15,
    provisionTags: s.acs_provision_tags == null ? true : !!s.acs_provision_tags,
    provisionOnInstall: s.acs_provision_on_install == null ? true : !!s.acs_provision_on_install,
    cwmpUrl: s.acs_cwmp_url || '',
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
  const autolinkEnabled =
    body.autolinkEnabled != null ? (body.autolinkEnabled ? 1 : 0) : cur.acs_autolink_enabled ?? 1;
  const autolinkIntervalMin =
    body.autolinkIntervalMin != null
      ? Math.max(5, Math.min(240, Number(body.autolinkIntervalMin) || 15))
      : cur.acs_autolink_interval_min ?? 15;
  const provisionTags =
    body.provisionTags != null ? (body.provisionTags ? 1 : 0) : cur.acs_provision_tags ?? 1;
  const provisionOnInstall =
    body.provisionOnInstall != null
      ? body.provisionOnInstall
        ? 1
        : 0
      : cur.acs_provision_on_install ?? 1;
  const cwmpUrl =
    body.cwmpUrl != null ? String(body.cwmpUrl || '').trim() || null : cur.acs_cwmp_url;

  db.prepare(
    `UPDATE app_settings SET
       acs_enabled = @acs_enabled,
       acs_nbi_url = @acs_nbi_url,
       acs_ui_url = @acs_ui_url,
       acs_username = @acs_username,
       acs_password = @acs_password,
       acs_autolink_enabled = @acs_autolink_enabled,
       acs_autolink_interval_min = @acs_autolink_interval_min,
       acs_provision_tags = @acs_provision_tags,
       acs_provision_on_install = @acs_provision_on_install,
       acs_cwmp_url = @acs_cwmp_url
     WHERE id = 1`
  ).run({
    acs_enabled: enabled,
    acs_nbi_url: nbiUrl,
    acs_ui_url: uiUrl,
    acs_username: username,
    acs_password: password,
    acs_autolink_enabled: autolinkEnabled,
    acs_autolink_interval_min: autolinkIntervalMin,
    acs_provision_tags: provisionTags,
    acs_provision_on_install: provisionOnInstall,
    acs_cwmp_url: cwmpUrl,
  });
  restartAcsScheduler();
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

/** GenieACS NBI device id encoding (path segment). */
export function encodeAcsDeviceId(deviceId: string): string {
  return encodeURIComponent(deviceId);
}

/** Decode percent-sequences in device IDs (e.g. HG8145X6%2D10 → HG8145X6-10). */
export function normalizeAcsDeviceId(deviceId: string): string {
  let s = String(deviceId ?? '').trim();
  if (!s) return s;
  for (let i = 0; i < 4; i++) {
    if (!/%[0-9A-Fa-f]{2}/.test(s)) break;
    try {
      const decoded = decodeURIComponent(s);
      if (decoded === s) break;
      s = decoded;
    } catch {
      break;
    }
  }
  return s;
}

/** Distinct _id strings to try against GenieACS NBI (encoded vs decoded Huawei IDs). */
export function acsDeviceIdLookupVariants(deviceId: string): string[] {
  const raw = String(deviceId ?? '').trim();
  if (!raw) return [];
  const norm = normalizeAcsDeviceId(raw);
  const out = new Set<string>([raw, norm]);
  if (norm.includes('-')) {
    out.add(norm.replace(/-/g, '%2D'));
  }
  return [...out].filter(Boolean);
}

export function acsDeviceIdsEquivalent(a: string, b: string): boolean {
  const va = acsDeviceIdLookupVariants(a);
  const vb = acsDeviceIdLookupVariants(b);
  return va.some((x) => vb.includes(x));
}

const ACS_DETAIL_PROJECTION = [
  '_id',
  '_lastInform',
  '_tags',
  'InternetGatewayDevice.DeviceInfo',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.',
  'Device.DeviceInfo',
  'Device.WiFi.',
  'Device.IP.Interface.1.',
].join(',');

function pickDeviceFromList(data: unknown, variants: string[]): unknown | null {
  if (!Array.isArray(data) || !data.length) return null;
  if (data.length === 1) return data[0];
  for (const v of variants) {
    const hit = data.find(
      (d) => d && typeof d === 'object' && String((d as { _id?: string })._id || '') === v
    );
    if (hit) return hit;
  }
  return data[0];
}

async function fetchAcsDeviceDocument(idVariant: string): Promise<unknown | null> {
  const query = JSON.stringify({ _id: idVariant });
  const byQuery = await acsRequest('GET', '/devices/', undefined, {
    query,
    limit: '1',
    projection: ACS_DETAIL_PROJECTION,
  });
  if (byQuery.ok) {
    const doc = pickDeviceFromList(byQuery.data, [idVariant]);
    if (doc) return doc;
  }

  const enc = encodeAcsDeviceId(idVariant);
  const byPath = await acsRequest('GET', `/devices/${enc}`, undefined, {
    projection: ACS_DETAIL_PROJECTION,
  });
  if (byPath.ok && byPath.data != null && !Array.isArray(byPath.data)) return byPath.data;
  if (byPath.ok && Array.isArray(byPath.data) && byPath.data.length) {
    return pickDeviceFromList(byPath.data, [idVariant]);
  }
  return null;
}

export async function getAcsDevice(deviceId: string) {
  const variants = acsDeviceIdLookupVariants(deviceId);
  if (!variants.length) throw new Error('device-id-required');

  let lastError = 'Device not found in GenieACS';
  for (const variant of variants) {
    try {
      const doc = await fetchAcsDeviceDocument(variant);
      if (doc) return doc;
    } catch (e: unknown) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(lastError);
}

/** Canonical `_id` from GenieACS for tasks/tags (falls back to normalized input). */
export async function resolveAcsDeviceCanonicalId(deviceId: string): Promise<string> {
  try {
    const doc = (await getAcsDevice(deviceId)) as { _id?: string };
    const fromDoc = doc._id != null ? String(doc._id).trim() : '';
    if (fromDoc) return fromDoc;
  } catch {
    /* use normalized input */
  }
  return normalizeAcsDeviceId(deviceId) || String(deviceId).trim();
}

export async function postAcsTask(deviceId: string, task: Record<string, unknown>, connectionRequest = true) {
  const canonical = await resolveAcsDeviceCanonicalId(deviceId);
  const variants = acsDeviceIdLookupVariants(canonical);
  const q = connectionRequest ? { connection_request: 'true' } : undefined;
  let lastError = 'ACS task failed';
  for (const raw of variants) {
    const id = encodeAcsDeviceId(raw);
    const r = await acsRequest('POST', `/devices/${id}/tasks`, task, q);
    if (r.ok) return r.data;
    lastError = r.error;
  }
  throw new Error(lastError);
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

export async function addAcsDeviceTag(deviceId: string, tag: string) {
  const canonical = await resolveAcsDeviceCanonicalId(deviceId);
  const t = encodeURIComponent(tag);
  let lastError = 'ACS tag failed';
  for (const raw of acsDeviceIdLookupVariants(canonical)) {
    const id = encodeAcsDeviceId(raw);
    const r = await acsRequest('POST', `/devices/${id}/tags/${t}`);
    if (r.ok) return r.data;
    lastError = r.error;
  }
  throw new Error(lastError);
}

export async function addAcsDeviceTags(deviceId: string, tags: string[]) {
  for (const tag of tags) {
    try {
      await addAcsDeviceTag(deviceId, tag);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!/exist|duplicate|409/i.test(msg)) throw e;
    }
  }
}

const CWMP_URL_PATHS = [
  'InternetGatewayDevice.ManagementServer.URL',
  'Device.ManagementServer.URL',
];

export async function pushCwmpUrlToDevice(deviceId: string, url: string) {
  if (!url.trim()) return;
  const parameterValues: [string, string, string][] = CWMP_URL_PATHS.map((p) => [p, url.trim(), 'xsd:string']);
  await setAcsParameterValues(deviceId, parameterValues);
}

let acsSchedulerTimer: ReturnType<typeof setInterval> | null = null;

export function restartAcsScheduler() {
  if (acsSchedulerTimer) {
    clearInterval(acsSchedulerTimer);
    acsSchedulerTimer = null;
  }
  startAcsAutolinkScheduler();
}

export function startAcsAutolinkScheduler() {
  const cfg = publicAcsConfig();
  if (!cfg.enabled || !cfg.autolinkEnabled) return;
  const ms = Math.max(5, cfg.autolinkIntervalMin) * 60 * 1000;
  acsSchedulerTimer = setInterval(() => {
    void import('./acsAutolink.js')
      .then((m) => m.runAcsAutolink({ syncTagsOnly: false }))
      .catch((e) => console.error('[acs] autolink scheduler', e));
  }, ms);
  console.info(`[acs] autolink scheduler every ${cfg.autolinkIntervalMin} min`);
}

/** After subscriber create/update or install job — link, tag, optional CWMP push. */
export async function acsAfterSubscriberUpsert(row: Record<string, unknown>, opts?: { install?: boolean }) {
  const cfg = publicAcsConfig();
  if (!cfg.enabled) return;

  const { runAcsAutolink, buildProvisionTags } = await import('./acsAutolink.js');
  const subId = Number(row.id);
  if (!subId) return;

  if (cfg.autolinkEnabled && !row.acs_device_id) {
    try {
      await runAcsAutolink({ subscriberId: subId });
    } catch {
      /* ignore */
    }
  }

  const fresh = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(subId) as Record<string, unknown> | undefined;
  const deviceId = fresh?.acs_device_id ? String(fresh.acs_device_id) : '';
  if (!deviceId) return;

  if (cfg.provisionTags && fresh) {
    try {
      await addAcsDeviceTags(deviceId, buildProvisionTags(fresh as import('./acsAutolink.js').SubscriberLinkRow));
    } catch (e) {
      console.error('[acs] provision tags', e);
    }
  }

  const onInstall = opts?.install && cfg.provisionOnInstall;
  if (onInstall && cfg.cwmpUrl) {
    try {
      await pushCwmpUrlToDevice(deviceId, cfg.cwmpUrl);
    } catch (e) {
      console.error('[acs] CWMP URL push', e);
    }
  }

  if (onInstall) {
    try {
      await refreshAcsDevice(deviceId, 'InternetGatewayDevice.');
      await refreshAcsDevice(deviceId, 'Device.');
    } catch {
      /* ignore */
    }
  }
}

export async function acsOnInstallComplete(pppoeUserId: number) {
  const row = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(pppoeUserId);
  if (!row) return;
  await acsAfterSubscriberUpsert(row as Record<string, unknown>, { install: true });
}

const FLATTEN_MAX_DEPTH = 64;
const FLATTEN_MAX_PARAMS = 12_000;

/** Walk GenieACS device document and collect TR-069 parameter paths. */
export function flattenAcsParameters(
  root: unknown,
  prefix = '',
  depth = 0,
  out: FlatParam[] = []
): FlatParam[] {
  if (depth > FLATTEN_MAX_DEPTH || out.length >= FLATTEN_MAX_PARAMS) return out;
  if (root == null || typeof root !== 'object') return out;
  const obj = root as Record<string, unknown>;
  for (const [key, val] of Object.entries(obj)) {
    if (key.startsWith('_')) continue;
    if (out.length >= FLATTEN_MAX_PARAMS) break;
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
        flattenAcsParameters(val, `${path}.`, depth + 1, out);
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
  let dev = deviceId != null ? String(deviceId).trim() || null : null;
  if (dev) dev = normalizeAcsDeviceId(dev) || dev;
  db.prepare('UPDATE pppoe_users SET acs_device_id = ? WHERE id = ?').run(dev, id);
  const out = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(id) as Record<string, unknown>;
  if (dev) void acsAfterSubscriberUpsert(out).catch(() => undefined);
  return db.prepare('SELECT id, username, customer_name, acs_device_id FROM pppoe_users WHERE id = ?').get(id);
}
