import { db } from './db.js';
import {
  fetchPppActive,
  fetchPppActiveTraffic,
  fetchPppInterfaceBytes,
  fetchDnsCacheNames,
  fetchDnsCacheEntries,
  fetchConnectionDestinations,
  fetchConnectionsForSrcAddress,
  parseRosRate,
  pppNameKey,
} from './mikrotik.js';
import { notifyClientChannels } from './notify.js';
import { getBillingPlan } from './billing.js';

/** Map hostnames / domains to platform / service categories (DNS popularity only). */
const SERVICE_RULES: { id: string; name: string; category: string; match: RegExp }[] = [
  { id: 'youtube', name: 'YouTube', category: 'Video & Streaming', match: /youtube|youtu\.be|googlevideo|ytimg/i },
  { id: 'netflix', name: 'Netflix', category: 'Video & Streaming', match: /netflix|nflx/i },
  { id: 'facebook', name: 'Facebook', category: 'Social', match: /facebook|fbcdn|fb\.com/i },
  { id: 'instagram', name: 'Instagram', category: 'Social', match: /instagram|cdninstagram/i },
  { id: 'tiktok', name: 'TikTok', category: 'Social', match: /tiktok|musical\.ly|byteoversea|ibytedance/i },
  { id: 'x', name: 'X (Twitter)', category: 'Social', match: /twitter|twimg|t\.co|x\.com/i },
  { id: 'discord', name: 'Discord', category: 'Communication', match: /discord/i },
  { id: 'whatsapp', name: 'WhatsApp', category: 'Communication', match: /whatsapp|wa\.me/i },
  { id: 'zoom', name: 'Zoom', category: 'Communication', match: /zoom\.(us|com)/i },
  { id: 'google', name: 'Google', category: 'Web & Search', match: /google|gstatic|googleapis|gmail/i },
  { id: 'cloudflare', name: 'Cloudflare', category: 'Infrastructure', match: /cloudflare|1\.1\.1\.1/i },
  { id: 'steam', name: 'Steam', category: 'Games', match: /steampowered|steamcommunity|steamstatic/i },
  { id: 'roblox', name: 'Roblox', category: 'Games', match: /roblox/i },
  { id: 'riot', name: 'Riot Games', category: 'Games', match: /riotgames|leagueoflegends|valorant/i },
  { id: 'mlbb', name: 'Mobile Legends', category: 'Games', match: /mobilelegends|moonton/i },
  { id: 'shopee', name: 'Shopee', category: 'Shopping', match: /shopee/i },
  { id: 'lazada', name: 'Lazada', category: 'Shopping', match: /lazada/i },
  { id: 'gcash', name: 'GCash', category: 'Finance', match: /gcash|globe\.com\.ph/i },
  { id: 'maya', name: 'Maya', category: 'Finance', match: /maya\.ph|paymaya/i },
  { id: 'spotify', name: 'Spotify', category: 'Video & Streaming', match: /spotify/i },
  { id: 'amazon', name: 'Amazon', category: 'Shopping', match: /amazon|aws\./i },
  { id: 'microsoft', name: 'Microsoft', category: 'Web & Search', match: /microsoft|office\.com|live\.com|xbox/i },
  { id: 'apple', name: 'Apple', category: 'Web & Search', match: /apple\.com|icloud|mzstatic/i },
];

function classifyHost(name: string): { id: string; name: string; category: string } {
  for (const r of SERVICE_RULES) {
    if (r.match.test(name)) return { id: r.id, name: r.name, category: r.category };
  }
  return { id: 'other', name: 'Other services', category: 'Other' };
}

export function getFairUseSettings() {
  ensureFairUseRow();
  return db.prepare('SELECT * FROM fair_use_settings WHERE id = 1').get() as any;
}

export function updateFairUseSettings(patch: Record<string, any>) {
  ensureFairUseRow();
  const cur = getFairUseSettings() as Record<string, any>;
  const fields = ['enabled', 'cap_percent', 'sustain_minutes', 'notify_email', 'notify_sms'];
  for (const f of fields) {
    if (f in patch) cur[f] = patch[f];
  }
  db.prepare(
    `UPDATE fair_use_settings SET enabled=?, cap_percent=?, sustain_minutes=?, notify_email=?, notify_sms=? WHERE id=1`
  ).run(
    cur.enabled ? 1 : 0,
    Math.max(50, Math.min(100, Number(cur.cap_percent) || 95)),
    Math.max(1, Number(cur.sustain_minutes) || 10),
    cur.notify_email ? 1 : 0,
    cur.notify_sms ? 1 : 0
  );
  return getFairUseSettings();
}

function ensureFairUseRow() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fair_use_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER DEFAULT 1,
      cap_percent INTEGER DEFAULT 95,
      sustain_minutes INTEGER DEFAULT 10,
      notify_email INTEGER DEFAULT 1,
      notify_sms INTEGER DEFAULT 0
    );
  `);
  if (!(db.prepare('SELECT 1 FROM fair_use_settings WHERE id = 1').get())) {
    db.prepare('INSERT INTO fair_use_settings (id) VALUES (1)').run();
  }
}

function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** In-memory sustained-overage tracker: username → first breach timestamp */
const overCapSince = new Map<string, number>();

/**
 * Poll live MikroTik counters and accumulate real per-user byte deltas.
 * Absolute interface counters are snapshotted; only the increase since the last
 * sample is added to today's usage (handles router reboot / counter reset).
 */
export async function pollUsageAndFairUse(opts?: { routerId?: number | null }) {
  ensureUsageTables();
  const settings = getFairUseSettings();
  const onlyId = opts?.routerId != null && Number(opts.routerId) > 0 ? Number(opts.routerId) : null;
  const routers = (
    onlyId
      ? db
          .prepare('SELECT * FROM routers WHERE id = ? AND host IS NOT NULL AND api_user IS NOT NULL')
          .all(onlyId)
      : db.prepare('SELECT * FROM routers WHERE host IS NOT NULL AND api_user IS NOT NULL').all()
  ) as any[];
  let samples = 0;
  let alerts = 0;
  let services = 0;
  let bytesDelta = 0;

  const day = todayLocal();
  const nowIso = new Date().toISOString();

  for (const router of routers) {
    // Platforms tab: always sample DNS / connections even when nobody is online.
    try {
      services += await samplePlatformUsage(router, day);
    } catch (e) {
      console.error('[usage] platforms', router.id, e);
    }

    try {
      const sessions = await fetchPppActive(router);
      const names = sessions.map((s) => s.name).filter(Boolean);
      if (!names.length) continue;

      const [traffic, bytes] = await Promise.all([
        fetchPppActiveTraffic(router, names),
        fetchPppInterfaceBytes(router, names),
      ]);

      for (const name of names) {
        const t = traffic[name] || { download: 0, upload: 0 };
        const b = bytes[name] || { rxBytes: 0, txBytes: 0 };
        const absDown = Math.max(0, Number(b.rxBytes) || 0); // subscriber download (iface TX)
        const absUp = Math.max(0, Number(b.txBytes) || 0); // subscriber upload (iface RX)
        const user = db.prepare('SELECT * FROM pppoe_users WHERE username = ? COLLATE NOCASE').get(name) as any;

        const prev = db
          .prepare(
            `SELECT rx_bytes AS rx, tx_bytes AS tx FROM usage_last_counters
             WHERE subject_type = 'pppoe' AND subject_key = ? COLLATE NOCASE AND router_id = ?`
          )
          .get(name, router.id) as { rx: number; tx: number } | undefined;

        let deltaDown = 0;
        let deltaUp = 0;
        if (prev) {
          // Counter increased → real usage since last poll. Dropped → reboot/reset.
          deltaDown = absDown >= prev.rx ? absDown - prev.rx : 0;
          deltaUp = absUp >= prev.tx ? absUp - prev.tx : 0;
        }
        // First sample only establishes baseline (delta 0) so we don't credit lifetime totals.

        db.prepare(
          `INSERT INTO usage_last_counters (subject_type, subject_key, router_id, rx_bytes, tx_bytes, updated_at)
           VALUES ('pppoe', ?, ?, ?, ?, ?)
           ON CONFLICT(subject_type, subject_key, router_id) DO UPDATE SET
             rx_bytes = excluded.rx_bytes,
             tx_bytes = excluded.tx_bytes,
             updated_at = excluded.updated_at`
        ).run(name, router.id, absDown, absUp, nowIso);

        db.prepare(
          `INSERT INTO usage_samples (subject_type, subject_key, router_id, rx_bytes, tx_bytes, rx_bps, tx_bps, delta_rx, delta_tx, sampled_at)
           VALUES ('pppoe', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(name, router.id, absDown, absUp, t.download, t.upload, deltaDown, deltaUp, nowIso);

        db.prepare(
          `INSERT INTO usage_daily (subject_type, subject_key, day, rx_bytes, tx_bytes, peak_rx_bps, peak_tx_bps)
           VALUES ('pppoe', ?, ?, ?, ?, ?, ?)
           ON CONFLICT(subject_type, subject_key, day) DO UPDATE SET
             rx_bytes = rx_bytes + excluded.rx_bytes,
             tx_bytes = tx_bytes + excluded.tx_bytes,
             peak_rx_bps = MAX(peak_rx_bps, excluded.peak_rx_bps),
             peak_tx_bps = MAX(peak_tx_bps, excluded.peak_tx_bps)`
        ).run(name, day, deltaDown, deltaUp, Math.round(t.download), Math.round(t.upload));

        samples++;
        bytesDelta += deltaDown + deltaUp;

        if (!settings.enabled || !user) continue;
        const prof = getBillingPlan(user.profile);
        const limitRaw = String(prof?.rateLimit || '');
        const downLimit = parseRosRate(limitRaw.split('/')[0] || limitRaw);
        if (downLimit <= 0) continue;
        const cap = (downLimit * (Number(settings.cap_percent) || 95)) / 100;
        const key = `${router.id}:${name.toLowerCase()}`;
        if (t.download >= cap) {
          if (!overCapSince.has(key)) overCapSince.set(key, Date.now());
          const mins = (Date.now() - (overCapSince.get(key) || Date.now())) / 60000;
          if (mins >= (Number(settings.sustain_minutes) || 10)) {
            const recent = db
              .prepare(
                `SELECT id FROM usage_alerts WHERE pppoe_user_id = ? AND alert_type = 'sustained_over_cap'
                 AND datetime(created_at) > datetime('now', '-2 hours') LIMIT 1`
              )
              .get(user.id);
            if (!recent) {
              db.prepare(
                `INSERT INTO usage_alerts (pppoe_user_id, router_id, alert_type, threshold_bps, observed_bps, profile)
                 VALUES (?, ?, 'sustained_over_cap', ?, ?, ?)`
              ).run(user.id, router.id, Math.round(cap), Math.round(t.download), user.profile);
              alerts++;
              const channels: ('email' | 'sms')[] = [];
              if (settings.notify_email) channels.push('email');
              if (settings.notify_sms) channels.push('sms');
              if (channels.length) {
                await notifyClientChannels(
                  user,
                  channels,
                  'Fair-use notice — high bandwidth',
                  `Hi ${user.customer_name || user.username}, your connection has been using high bandwidth (≥${settings.cap_percent}% of your ${user.profile} plan) for ${settings.sustain_minutes}+ minutes. Please reduce heavy downloads/streams during peak hours.`,
                  'fair_use_alert'
                );
              }
            }
            overCapSince.delete(key);
          }
        } else {
          overCapSince.delete(key);
        }
      }
    } catch (e) {
      console.error('[usage] router', router.id, e);
    }
  }

  return { samples, alerts, services, bytesDelta, routers: routers.length, accounting: 'delta' };
}

/** Classify DNS / connection names into platform buckets for the Websites tab. */
async function samplePlatformUsage(router: any, day: string): Promise<number> {
  let hosts: string[] = [];
  try {
    hosts = await fetchDnsCacheNames(router);
  } catch {
    hosts = [];
  }

  // Fallback when DNS cache is empty (clients using public DNS): sample connection destinations.
  if (!hosts.length) {
    try {
      const dests = await fetchConnectionDestinations(router, 1000);
      hosts = dests.map((d) => d.dst).filter(Boolean);
    } catch {
      /* optional */
    }
  }

  if (!hosts.length) return 0;

  const counts = new Map<string, { name: string; category: string; hits: number }>();
  for (const host of hosts) {
    const c = classifyHost(host);
    // Skip raw IPs in the "Other" bucket — they add noise without platform signal
    if (c.id === 'other' && /^\d{1,3}(\.\d{1,3}){3}$/.test(String(host).split(':')[0])) continue;
    const prev = counts.get(c.id) || { name: c.name, category: c.category, hits: 0 };
    prev.hits++;
    counts.set(c.id, prev);
  }

  if (!counts.size) return 0;

  db.prepare('DELETE FROM usage_services WHERE day = ? AND router_id = ?').run(day, router.id);
  let n = 0;
  for (const [sid, v] of counts) {
    db.prepare(
      `INSERT INTO usage_services (day, service_id, service_name, category, hits, router_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(day, sid, v.name, v.category, v.hits, router.id);
    n++;
  }
  return n;
}

export function ensureUsageTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pppoe_user_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      amount REAL,
      months INTEGER DEFAULT 1,
      status TEXT DEFAULT 'pending',
      expires_at TEXT,
      paid_at TEXT,
      external_ref TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS fair_use_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER DEFAULT 1,
      cap_percent INTEGER DEFAULT 95,
      sustain_minutes INTEGER DEFAULT 10,
      notify_email INTEGER DEFAULT 1,
      notify_sms INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS usage_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pppoe_user_id INTEGER,
      router_id INTEGER,
      alert_type TEXT,
      threshold_bps INTEGER,
      observed_bps INTEGER,
      profile TEXT,
      acknowledged INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS usage_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_type TEXT,
      subject_key TEXT,
      router_id INTEGER,
      rx_bytes INTEGER DEFAULT 0,
      tx_bytes INTEGER DEFAULT 0,
      rx_bps INTEGER DEFAULT 0,
      tx_bps INTEGER DEFAULT 0,
      delta_rx INTEGER DEFAULT 0,
      delta_tx INTEGER DEFAULT 0,
      sampled_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS usage_daily (
      subject_type TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      day TEXT NOT NULL,
      rx_bytes INTEGER DEFAULT 0,
      tx_bytes INTEGER DEFAULT 0,
      peak_rx_bps INTEGER DEFAULT 0,
      peak_tx_bps INTEGER DEFAULT 0,
      PRIMARY KEY (subject_type, subject_key, day)
    );
    CREATE TABLE IF NOT EXISTS usage_services (
      day TEXT NOT NULL,
      service_id TEXT NOT NULL,
      service_name TEXT,
      category TEXT,
      hits INTEGER DEFAULT 0,
      router_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, service_id, router_id)
    );
    CREATE TABLE IF NOT EXISTS usage_last_counters (
      subject_type TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      router_id INTEGER NOT NULL,
      rx_bytes INTEGER DEFAULT 0,
      tx_bytes INTEGER DEFAULT 0,
      updated_at TEXT,
      PRIMARY KEY (subject_type, subject_key, router_id)
    );
    CREATE TABLE IF NOT EXISTS usage_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Add delta columns on older DBs
  try {
    const cols = db.prepare('PRAGMA table_info(usage_samples)').all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('delta_rx')) db.exec('ALTER TABLE usage_samples ADD COLUMN delta_rx INTEGER DEFAULT 0');
    if (!names.has('delta_tx')) db.exec('ALTER TABLE usage_samples ADD COLUMN delta_tx INTEGER DEFAULT 0');
  } catch {
    /* ignore */
  }

  // One-time wipe of absolute-counter "usage" that looked predefined / wrong
  const migrated = db.prepare("SELECT value FROM usage_meta WHERE key = 'accounting_v2'").get() as
    | { value: string }
    | undefined;
  if (!migrated) {
    db.exec(`
      DELETE FROM usage_daily;
      DELETE FROM usage_samples;
      DELETE FROM usage_services;
      DELETE FROM usage_last_counters;
    `);
    db.prepare("INSERT OR REPLACE INTO usage_meta (key, value) VALUES ('accounting_v2', ?)").run(
      new Date().toISOString()
    );
  }

  ensureFairUseRow();
}

export function listUsageAlerts(limit = 100) {
  return db
    .prepare(
      `SELECT a.*, u.username, u.customer_name AS customer
       FROM usage_alerts a
       LEFT JOIN pppoe_users u ON u.id = a.pppoe_user_id
       ORDER BY a.id DESC LIMIT ?`
    )
    .all(limit);
}

export function ackUsageAlert(id: number) {
  db.prepare('UPDATE usage_alerts SET acknowledged = 1 WHERE id = ?').run(id);
  return db.prepare('SELECT * FROM usage_alerts WHERE id = ?').get(id);
}

export function getUserUsageHistory(username: string, days = 30) {
  return db
    .prepare(
      `SELECT day, rx_bytes AS rxBytes, tx_bytes AS txBytes, peak_rx_bps AS peakRxBps, peak_tx_bps AS peakTxBps
       FROM usage_daily WHERE subject_type = 'pppoe' AND subject_key = ? COLLATE NOCASE
       AND day >= date('now', ?) ORDER BY day`
    )
    .all(username, `-${Math.max(1, days)} days`);
}

/** Rolling last-24h byte usage (download/upload) keyed by lowercase username. */
export function getUsageLast24hByUser(opts?: {
  routerId?: number | null;
  usernames?: string[];
}): Map<string, { rxBytes: number; txBytes: number }> {
  ensureUsageTables();
  const rid = opts?.routerId != null && Number(opts.routerId) > 0 ? Number(opts.routerId) : null;
  const want =
    opts?.usernames && opts.usernames.length
      ? new Set(opts.usernames.map((u) => String(u || '').trim().toLowerCase()).filter(Boolean))
      : null;

  const rows = (
    rid
      ? db
          .prepare(
            `SELECT subject_key AS username,
                    COALESCE(SUM(delta_rx), 0) AS rxBytes,
                    COALESCE(SUM(delta_tx), 0) AS txBytes
             FROM usage_samples
             WHERE subject_type = 'pppoe'
               AND router_id = ?
               AND datetime(sampled_at) >= datetime('now', '-1 day')
             GROUP BY subject_key`
          )
          .all(rid)
      : db
          .prepare(
            `SELECT subject_key AS username,
                    COALESCE(SUM(delta_rx), 0) AS rxBytes,
                    COALESCE(SUM(delta_tx), 0) AS txBytes
             FROM usage_samples
             WHERE subject_type = 'pppoe'
               AND datetime(sampled_at) >= datetime('now', '-1 day')
             GROUP BY subject_key`
          )
          .all()
  ) as { username: string; rxBytes: number; txBytes: number }[];

  const map = new Map<string, { rxBytes: number; txBytes: number }>();
  for (const r of rows) {
    const key = String(r.username || '').trim().toLowerCase();
    if (!key) continue;
    if (want && !want.has(key)) continue;
    map.set(key, { rxBytes: Number(r.rxBytes) || 0, txBytes: Number(r.txBytes) || 0 });
  }

  // Fallback to today's usage_daily for anyone with no sample deltas yet
  const dayRows = (
    rid
      ? db
          .prepare(
            `SELECT d.subject_key AS username, d.rx_bytes AS rxBytes, d.tx_bytes AS txBytes
             FROM usage_daily d
             INNER JOIN pppoe_users u ON u.username = d.subject_key COLLATE NOCASE AND u.router_id = ?
             WHERE d.subject_type = 'pppoe' AND d.day = date('now', 'localtime')`
          )
          .all(rid)
      : db
          .prepare(
            `SELECT subject_key AS username, rx_bytes AS rxBytes, tx_bytes AS txBytes
             FROM usage_daily
             WHERE subject_type = 'pppoe' AND day = date('now', 'localtime')`
          )
          .all()
  ) as { username: string; rxBytes: number; txBytes: number }[];

  for (const r of dayRows) {
    const key = String(r.username || '').trim().toLowerCase();
    if (!key) continue;
    if (want && !want.has(key)) continue;
    if (map.has(key)) continue;
    map.set(key, { rxBytes: Number(r.rxBytes) || 0, txBytes: Number(r.txBytes) || 0 });
  }

  return map;
}

/** Recent live traffic samples (bps) for the download/upload graph. */
export function getUserTrafficSamples(username: string, hours = 6) {
  const h = Math.max(1, Math.min(48, Number(hours) || 6));
  return db
    .prepare(
      `SELECT sampled_at AS t, rx_bps AS downloadBps, tx_bps AS uploadBps,
              delta_rx AS deltaRx, delta_tx AS deltaTx
       FROM usage_samples
       WHERE subject_type = 'pppoe' AND subject_key = ? COLLATE NOCASE
         AND datetime(sampled_at) >= datetime('now', ?)
       ORDER BY id ASC`
    )
    .all(username, `-${h} hours`) as {
    t: string;
    downloadBps: number;
    uploadBps: number;
    deltaRx: number;
    deltaTx: number;
  }[];
}

/**
 * Live traffic + classified internet services for one PPPoE subscriber
 * (connection tracking filtered by their PPP address).
 */
export async function getSubscriberUsageDetail(
  username: string,
  opts?: { days?: number; hours?: number }
) {
  const user = String(username || '').trim();
  if (!user) throw new Error('username required');

  const days = Math.max(1, Math.min(90, Number(opts?.days) || 30));
  const hours = Math.max(1, Math.min(48, Number(opts?.hours) || 6));

  const client = db
    .prepare(
      `SELECT id, username, customer_name AS customer, profile, account_number AS account,
              router_id AS routerId, status
       FROM pppoe_users WHERE username = ? COLLATE NOCASE`
    )
    .get(user) as any;

  const history = getUserUsageHistory(user, days);
  const samples = getUserTrafficSamples(user, hours);

  let live = {
    downloadBps: 0,
    uploadBps: 0,
    online: false,
    address: null as string | null,
    uptime: null as string | null,
  };
  let services: {
    id: string;
    name: string;
    category: string;
    hits: number;
    destinations: string[];
  }[] = [];
  let servicesNote = '';
  let liveOk = false;

  const routerId = client?.routerId;
  const router = routerId
    ? (db.prepare('SELECT * FROM routers WHERE id = ?').get(routerId) as any)
    : (db
        .prepare('SELECT * FROM routers WHERE host IS NOT NULL AND api_user IS NOT NULL ORDER BY id LIMIT 1')
        .get() as any);

  if (router?.host && router?.api_user) {
    try {
      const sessions = await fetchPppActive(router);
      const session = sessions.find((s) => pppNameKey(s.name) === pppNameKey(user));
      if (session) {
        live.online = true;
        live.address = session.address && session.address !== '-' ? session.address : null;
        live.uptime = session.uptime || null;
        try {
          const traffic = await fetchPppActiveTraffic(router, [session.name]);
          const t = traffic[session.name] || traffic[Object.keys(traffic)[0]];
          if (t) {
            live.downloadBps = t.download || 0;
            live.uploadBps = t.upload || 0;
          }
        } catch {
          /* optional */
        }

        if (live.address) {
          const conns = await fetchConnectionsForSrcAddress(router, live.address, 400);
          // Reverse map IP → hostname from DNS cache when available
          const ipToHost = new Map<string, string>();
          try {
            const entries = await fetchDnsCacheEntries(router);
            for (const e of entries) {
              const ip = String(e.address || '').trim();
              if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && e.name) {
                if (!ipToHost.has(ip)) ipToHost.set(ip, e.name);
              }
            }
          } catch {
            /* optional */
          }

          const counts = new Map<
            string,
            { name: string; category: string; hits: number; destinations: Set<string> }
          >();
          for (const c of conns) {
            if (!c.dst || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|127\.|0\.|255\.)/.test(c.dst)) {
              continue;
            }
            const hostHint =
              ipToHost.get(c.dst) ||
              (c.replySrc && !/^\d{1,3}(\.\d{1,3}){3}$/.test(c.replySrc) ? c.replySrc : '') ||
              c.dst;
            const classified = classifyHost(hostHint);
            const prev =
              counts.get(classified.id) || {
                name: classified.name,
                category: classified.category,
                hits: 0,
                destinations: new Set<string>(),
              };
            prev.hits++;
            prev.destinations.add(hostHint);
            counts.set(classified.id, prev);
          }
          services = [...counts.entries()]
            .map(([id, v]) => ({
              id,
              name: v.name,
              category: v.category,
              hits: v.hits,
              destinations: [...v.destinations].slice(0, 8),
            }))
            .sort((a, b) => b.hits - a.hits)
            .slice(0, 30);
          servicesNote = services.length
            ? `Active connections from ${live.address} (MikroTik connection tracking).`
            : `No tracked connections for ${live.address} right now.`;
        } else {
          servicesNote = 'Session is online but has no PPP address yet.';
        }
      } else {
        servicesNote = 'Subscriber is not online on the router — no live services.';
        // Fall back to last sampled bps from DB
        const last = samples.length ? samples[samples.length - 1] : null;
        if (last) {
          live.downloadBps = Number(last.downloadBps) || 0;
          live.uploadBps = Number(last.uploadBps) || 0;
        }
      }
      liveOk = true;
    } catch (e: any) {
      servicesNote = e?.message || 'Could not reach MikroTik for live services.';
      const last = samples.length ? samples[samples.length - 1] : null;
      if (last) {
        live.downloadBps = Number(last.downloadBps) || 0;
        live.uploadBps = Number(last.uploadBps) || 0;
      }
    }
  } else {
    servicesNote = 'Router API is not configured — showing stored samples only.';
    const last = samples.length ? samples[samples.length - 1] : null;
    if (last) {
      live.downloadBps = Number(last.downloadBps) || 0;
      live.uploadBps = Number(last.uploadBps) || 0;
    }
  }

  return {
    username: client?.username || user,
    customer: client?.customer || user,
    profile: client?.profile || null,
    account: client?.account || null,
    userId: client?.id || null,
    history,
    samples: samples.map((s) => ({
      t: s.t,
      downloadBps: Number(s.downloadBps) || 0,
      uploadBps: Number(s.uploadBps) || 0,
      label: String(s.t || '').slice(11, 16) || s.t,
    })),
    live,
    services,
    servicesNote,
    liveOk,
    hours,
    days,
  };
}

export function getUsageSummary(days = 7, routerId?: number | null) {
  const dayArg = `-${Math.max(1, days)} days`;
  const rid = routerId != null && Number(routerId) > 0 ? Number(routerId) : null;

  const users = (
    rid
      ? db.prepare(
          `SELECT d.subject_key AS username,
                  SUM(d.rx_bytes) AS rxBytes, SUM(d.tx_bytes) AS txBytes,
                  MAX(d.peak_rx_bps) AS peakRxBps, MAX(d.peak_tx_bps) AS peakTxBps
           FROM usage_daily d
           INNER JOIN pppoe_users u ON u.username = d.subject_key COLLATE NOCASE AND u.router_id = ?
           WHERE d.subject_type = 'pppoe' AND d.day >= date('now', ?)
           GROUP BY d.subject_key
           ORDER BY (SUM(d.rx_bytes)+SUM(d.tx_bytes)) DESC
           LIMIT 100`
        ).all(rid, dayArg)
      : db.prepare(
          `SELECT subject_key AS username,
                  SUM(rx_bytes) AS rxBytes, SUM(tx_bytes) AS txBytes,
                  MAX(peak_rx_bps) AS peakRxBps, MAX(peak_tx_bps) AS peakTxBps
           FROM usage_daily
           WHERE subject_type = 'pppoe' AND day >= date('now', ?)
           GROUP BY subject_key
           ORDER BY (SUM(rx_bytes)+SUM(tx_bytes)) DESC
           LIMIT 100`
        ).all(dayArg)
  ) as any[];

  const enriched = users.map((u) => {
    const client = (
      rid
        ? db
            .prepare(
              'SELECT id, customer_name, profile, account_number, router_id FROM pppoe_users WHERE username = ? COLLATE NOCASE AND router_id = ?'
            )
            .get(u.username, rid)
        : db
            .prepare(
              'SELECT id, customer_name, profile, account_number, router_id FROM pppoe_users WHERE username = ? COLLATE NOCASE'
            )
            .get(u.username)
    ) as any;
    const live = (
      rid
        ? db
            .prepare(
              `SELECT rx_bps AS downloadBps, tx_bps AS uploadBps, sampled_at AS sampledAt
               FROM usage_samples
               WHERE subject_type = 'pppoe' AND subject_key = ? COLLATE NOCASE AND router_id = ?
               ORDER BY id DESC LIMIT 1`
            )
            .get(u.username, rid)
        : db
            .prepare(
              `SELECT rx_bps AS downloadBps, tx_bps AS uploadBps, sampled_at AS sampledAt
               FROM usage_samples
               WHERE subject_type = 'pppoe' AND subject_key = ? COLLATE NOCASE
               ORDER BY id DESC LIMIT 1`
            )
            .get(u.username)
    ) as any;
    return {
      ...u,
      customer: client?.customer_name || u.username,
      profile: client?.profile || null,
      account: client?.account_number || null,
      userId: client?.id || null,
      routerId: client?.router_id ?? rid ?? null,
      downloadBps: live?.downloadBps ?? 0,
      uploadBps: live?.uploadBps ?? 0,
      sampledAt: live?.sampledAt || null,
    };
  });

  // Also include currently-online users with 0 accumulated bytes so the list isn't empty
  const online = (
    rid
      ? db
          .prepare(
            `SELECT username, customer_name AS customer, profile, account_number AS account, id AS userId, router_id AS routerId
             FROM pppoe_users WHERE online = 1 AND router_id = ?`
          )
          .all(rid)
      : db
          .prepare(
            `SELECT username, customer_name AS customer, profile, account_number AS account, id AS userId, router_id AS routerId
             FROM pppoe_users WHERE online = 1`
          )
          .all()
  ) as any[];
  const seen = new Set(enriched.map((u) => String(u.username).toLowerCase()));
  for (const o of online) {
    if (seen.has(String(o.username).toLowerCase())) continue;
    const live = (
      rid
        ? db
            .prepare(
              `SELECT rx_bps AS downloadBps, tx_bps AS uploadBps, sampled_at AS sampledAt
               FROM usage_samples WHERE subject_type = 'pppoe' AND subject_key = ? COLLATE NOCASE AND router_id = ?
               ORDER BY id DESC LIMIT 1`
            )
            .get(o.username, rid)
        : db
            .prepare(
              `SELECT rx_bps AS downloadBps, tx_bps AS uploadBps, sampled_at AS sampledAt
               FROM usage_samples WHERE subject_type = 'pppoe' AND subject_key = ? COLLATE NOCASE
               ORDER BY id DESC LIMIT 1`
            )
            .get(o.username)
    ) as any;
    enriched.push({
      username: o.username,
      customer: o.customer || o.username,
      profile: o.profile,
      account: o.account,
      userId: o.userId,
      routerId: o.routerId ?? rid ?? null,
      rxBytes: 0,
      txBytes: 0,
      peakRxBps: live?.downloadBps || 0,
      peakTxBps: live?.uploadBps || 0,
      downloadBps: live?.downloadBps ?? 0,
      uploadBps: live?.uploadBps ?? 0,
      sampledAt: live?.sampledAt || null,
    });
  }

  const services = (
    rid
      ? db
          .prepare(
            `SELECT service_id AS id, service_name AS name, category,
                    SUM(hits) AS hits
             FROM usage_services
             WHERE day >= date('now', ?) AND router_id = ?
             GROUP BY service_id
             ORDER BY SUM(hits) DESC
             LIMIT 40`
          )
          .all(dayArg, rid)
      : db
          .prepare(
            `SELECT service_id AS id, service_name AS name, category,
                    SUM(hits) AS hits
             FROM usage_services
             WHERE day >= date('now', ?)
             GROUP BY service_id
             ORDER BY SUM(hits) DESC
             LIMIT 40`
          )
          .all(dayArg)
  );

  const sampleCount = (
    rid
      ? (db
          .prepare(
            `SELECT COUNT(*) AS c FROM usage_samples
             WHERE datetime(sampled_at) >= datetime('now', '-1 day') AND router_id = ?`
          )
          .get(rid) as { c: number }).c
      : (db
          .prepare(`SELECT COUNT(*) AS c FROM usage_samples WHERE datetime(sampled_at) >= datetime('now', '-1 day')`).get() as {
          c: number;
        }).c
  );

  return {
    users: enriched,
    services,
    days,
    routerId: rid,
    accounting: 'delta',
    sampleCount,
    note: 'Per-user download/upload are real byte deltas from MikroTik <pppoe-*> interfaces. Platforms tab uses DNS-cache popularity (falls back to connection destinations when the cache is empty).',
  };
}

let usageStarted = false;
export function startUsageScheduler(intervalMs = 60_000) {
  if (usageStarted) return;
  usageStarted = true;
  ensureUsageTables();
  pollUsageAndFairUse().catch((e) => console.error('[usage] initial', e));
  setInterval(() => {
    pollUsageAndFairUse().catch((e) => console.error('[usage]', e));
  }, intervalMs);
}
