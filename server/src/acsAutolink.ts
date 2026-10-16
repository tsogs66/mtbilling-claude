import { db } from './db.js';
import { fetchPppActive } from './mikrotik.js';
import {
  flattenAcsParameters,
  listAcsDevices,
  addAcsDeviceTags,
  publicAcsConfig,
} from './genieacs.js';

export type AutolinkResult = {
  linked: number;
  tagsSynced: number;
  skipped: number;
  errors: string[];
  matches: { deviceId: string; subscriberId: number; reason: string }[];
};

export type SubscriberLinkRow = {
  id: number;
  username: string;
  customer_name?: string | null;
  account_number?: string | null;
  acs_device_id?: string | null;
  cpe_mac?: string | null;
  profile?: string | null;
  status?: string | null;
};

const PPP_USERNAME_PATHS = [
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANPPPConnection.1.Username',
  'Device.PPP.Interface.1.Username',
  'Device.PPP.Interface.2.Username',
];

const MAC_PATHS = [
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.MACAddress',
  'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.BSSID',
  'Device.Ethernet.Interface.1.MACAddress',
  'Device.WiFi.Radio.1.BSSID',
];

export function normalizeMac(mac: string | null | undefined): string {
  return String(mac || '')
    .toLowerCase()
    .replace(/[^a-f0-9]/g, '');
}

export function normalizeUsername(u: string | null | undefined): string {
  return String(u || '')
    .trim()
    .toLowerCase();
}

export function buildProvisionTags(sub: SubscriberLinkRow): string[] {
  const tags = new Set<string>();
  const add = (t: string) => {
    const s = String(t || '').trim();
    if (s.length >= 2 && s.length <= 120) tags.add(s);
  };
  add(`mtbilling:sub:${sub.id}`);
  const un = normalizeUsername(sub.username);
  if (un) add(`mtbilling:username:${un}`);
  const acct = String(sub.account_number || '').trim();
  if (acct) add(`mtbilling:account:${acct}`);
  const prof = String(sub.profile || '').trim();
  if (prof) add(`mtbilling:profile:${prof.replace(/\s+/g, '_')}`);
  const st = String(sub.status || 'Active').trim().toLowerCase().replace(/\s+/g, '-');
  add(`mtbilling:status:${st}`);
  return [...tags];
}

/** Parse GenieACS device tags / cached params into lookup keys. */
export function extractDeviceMatchKeys(device: Record<string, unknown>): {
  subscriberIds: number[];
  usernames: string[];
  accounts: string[];
  macs: string[];
  pppUsernames: string[];
} {
  const subscriberIds: number[] = [];
  const usernames: string[] = [];
  const accounts: string[] = [];
  const macs: string[] = [];
  const pppUsernames: string[] = [];

  const rawTags = device._tags;
  const tagList: string[] = Array.isArray(rawTags)
    ? rawTags.map(String)
    : typeof rawTags === 'string'
      ? rawTags.split(',').map((t) => t.trim())
      : [];

  for (const tag of tagList) {
    if (tag.startsWith('mtbilling:sub:')) {
      const id = Number(tag.slice('mtbilling:sub:'.length));
      if (id > 0) subscriberIds.push(id);
    } else if (tag.startsWith('mtbilling:username:')) {
      usernames.push(normalizeUsername(tag.slice('mtbilling:username:'.length)));
    } else if (tag.startsWith('mtbilling:account:')) {
      accounts.push(String(tag.slice('mtbilling:account:'.length)).trim());
    } else if (tag.startsWith('username:')) {
      usernames.push(normalizeUsername(tag.slice('username:'.length)));
    }
  }

  const params = flattenAcsParameters(device);
  for (const path of PPP_USERNAME_PATHS) {
    const hit = params.find((p) => p.path === path);
    if (hit?.value) pppUsernames.push(normalizeUsername(hit.value));
  }
  for (const path of MAC_PATHS) {
    const hit = params.find((p) => p.path === path);
    const m = normalizeMac(hit?.value);
    if (m.length >= 6) macs.push(m);
  }

  return { subscriberIds, usernames, accounts, macs, pppUsernames };
}

function loadSubscribers(onlyId?: number): SubscriberLinkRow[] {
  if (onlyId) {
    const row = db.prepare('SELECT * FROM pppoe_users WHERE id = ?').get(onlyId) as SubscriberLinkRow | undefined;
    return row ? [row] : [];
  }
  return db
    .prepare(
      `SELECT id, username, customer_name, account_number, acs_device_id, cpe_mac, profile, status
       FROM pppoe_users ORDER BY id`
    )
    .all() as SubscriberLinkRow[];
}

function deviceAlreadyLinkedToOther(deviceId: string, subscriberId: number): boolean {
  const row = db
    .prepare(
      `SELECT id FROM pppoe_users
       WHERE acs_device_id = ? COLLATE NOCASE AND id != ? LIMIT 1`
    )
    .get(deviceId, subscriberId) as { id: number } | undefined;
  return !!row;
}

function pickSubscriberForDevice(
  keys: ReturnType<typeof extractDeviceMatchKeys>,
  subs: SubscriberLinkRow[],
  macToUsername: Map<string, string>
): { sub: SubscriberLinkRow; reason: string } | null {
  const byId = new Map(subs.map((s) => [s.id, s]));
  const byUsername = new Map(subs.map((s) => [normalizeUsername(s.username), s]));
  const byAccount = new Map(
    subs.filter((s) => s.account_number).map((s) => [String(s.account_number).trim(), s])
  );
  const byMac = new Map(
    subs.filter((s) => s.cpe_mac).map((s) => [normalizeMac(s.cpe_mac), s])
  );

  for (const id of keys.subscriberIds) {
    const sub = byId.get(id);
    if (sub && !sub.acs_device_id) return { sub, reason: 'tag:mtbilling:sub' };
  }

  for (const acct of keys.accounts) {
    const sub = byAccount.get(acct);
    if (sub && !sub.acs_device_id) return { sub, reason: 'tag:mtbilling:account' };
  }

  for (const un of [...keys.usernames, ...keys.pppUsernames]) {
    const sub = byUsername.get(un);
    if (sub && !sub.acs_device_id) return { sub, reason: keys.pppUsernames.includes(un) ? 'ppp-username' : 'tag:username' };
  }

  for (const mac of keys.macs) {
    const sub = byMac.get(mac);
    if (sub && !sub.acs_device_id) return { sub, reason: 'cpe_mac' };
    const un = macToUsername.get(mac);
    if (un) {
      const sub2 = byUsername.get(normalizeUsername(un));
      if (sub2 && !sub2.acs_device_id) return { sub: sub2, reason: 'mikrotik-caller-id' };
    }
  }

  return null;
}

export async function runAcsAutolink(opts?: {
  subscriberId?: number;
  dryRun?: boolean;
  syncTagsOnly?: boolean;
}): Promise<AutolinkResult> {
  const cfg = publicAcsConfig();
  if (!cfg.enabled) throw new Error('acs-disabled');
  if (!cfg.autolinkEnabled && !opts?.syncTagsOnly) throw new Error('acs-autolink-disabled');

  const result: AutolinkResult = { linked: 0, tagsSynced: 0, skipped: 0, errors: [], matches: [] };
  const subs = loadSubscribers(opts?.subscriberId);
  if (!subs.length) return result;

  let devices: Record<string, unknown>[] = [];
  try {
    devices = (await listAcsDevices({ limit: 2000 })) as Record<string, unknown>[];
  } catch (e: unknown) {
    throw new Error(e instanceof Error ? e.message : 'list devices failed');
  }

  const macToUsername = await buildCallerIdMapFromMikrotik();

  const linkedSubs = subs.filter((s) => s.acs_device_id);
  if (cfg.provisionTags) {
    for (const sub of linkedSubs) {
      if (!sub.acs_device_id || opts?.dryRun) continue;
      try {
        await addAcsDeviceTags(sub.acs_device_id, buildProvisionTags(sub));
        result.tagsSynced++;
      } catch (e: unknown) {
        result.errors.push(`tags ${sub.username}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  if (opts?.syncTagsOnly) return result;

  for (const device of devices) {
    const deviceId = String(device._id || '');
    if (!deviceId) continue;
    const keys = extractDeviceMatchKeys(device);
    const hit = pickSubscriberForDevice(keys, subs, macToUsername);
    if (!hit) {
      result.skipped++;
      continue;
    }
    if (deviceAlreadyLinkedToOther(deviceId, hit.sub.id)) {
      result.skipped++;
      continue;
    }
    result.matches.push({ deviceId, subscriberId: hit.sub.id, reason: hit.reason });
    if (opts?.dryRun) continue;

    try {
      db.prepare('UPDATE pppoe_users SET acs_device_id = ? WHERE id = ?').run(deviceId, hit.sub.id);
      hit.sub.acs_device_id = deviceId;
      result.linked++;
      if (cfg.provisionTags) {
        await addAcsDeviceTags(deviceId, buildProvisionTags(hit.sub));
        result.tagsSynced++;
      }
    } catch (e: unknown) {
      result.errors.push(`link ${deviceId}: ${e instanceof Error ? e.message : e}`);
    }
  }

  if (result.linked > 0) {
    db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
      'info',
      'acs',
      `Autolink: ${result.linked} CPE(s) linked, ${result.tagsSynced} tag sync(s)`
    );
  }
  return result;
}

/** PPPoE caller-id MAC → username from live MikroTik active sessions. */
async function buildCallerIdMapFromMikrotik(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const routers = db
    .prepare('SELECT * FROM routers WHERE host IS NOT NULL AND api_user IS NOT NULL')
    .all() as Record<string, unknown>[];
  for (const r of routers) {
    try {
      const sessions = await fetchPppActive({
        host: String(r.host || ''),
        port: Number(r.port) || 8728,
        api_user: String(r.api_user || ''),
        api_pass: String(r.api_pass || ''),
      });
      for (const s of sessions) {
        const mac = normalizeMac(s.caller);
        if (mac && s.name) map.set(mac, s.name);
      }
    } catch {
      /* ignore unreachable router */
    }
  }
  return map;
}
