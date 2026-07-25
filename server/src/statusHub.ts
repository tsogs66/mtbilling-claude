/**
 * Status Hub — internet status feeds only (no local network reachability probes).
 * Sources: isitdownstatus.com crowdsourced/official indicators + Atlassian Statuspage JSON.
 * Heartbeats stored in SQLite; optional Prometheus text export.
 */
import { db } from './db.js';
import type { RouterConn } from './mikrotik.js';
import { probeHttpUrlsFromRouter } from './mikrotik.js';

const HEARTBEAT_KEEP = 120;
const DEFAULT_INTERVAL_SEC = 90;
const FEED_TIMEOUT_MS = 10_000;
const CONCURRENCY = 8;
const UA = 'MT-Billing-StatusHub/2.0';

export type MonitorType = 'feed' | 'statuspage';
export type HeartbeatStatus = 'up' | 'down' | 'degraded' | 'pending';

type GroupSeed = { slug: string; name: string; sort: number; icon: string };
type MonitorSeed = {
  group: string;
  name: string;
  url: string;
  feedSlug: string;
  statusPage?: string;
};

const GROUP_SEEDS: GroupSeed[] = [
  { slug: 'web', name: 'Web & Search', sort: 10, icon: 'globe' },
  { slug: 'social', name: 'Social', sort: 20, icon: 'users' },
  { slug: 'streaming', name: 'Streaming & Media', sort: 30, icon: 'play' },
  { slug: 'games', name: 'Games & Platforms', sort: 40, icon: 'gamepad' },
  { slug: 'comms', name: 'Communication', sort: 50, icon: 'message' },
  { slug: 'cloud', name: 'Cloud & Infrastructure', sort: 60, icon: 'cloud' },
  { slug: 'dns', name: 'DNS & Connectivity', sort: 70, icon: 'network' },
  { slug: 'finance', name: 'Finance & Commerce', sort: 80, icon: 'wallet' },
  { slug: 'custom', name: 'Custom Monitors', sort: 90, icon: 'plus' },
];

const MONITOR_SEEDS: MonitorSeed[] = [
  { group: 'web', name: 'Google', url: 'https://www.google.com', feedSlug: 'google' },
  { group: 'web', name: 'Bing', url: 'https://www.bing.com', feedSlug: 'bing' },
  { group: 'web', name: 'Wikipedia', url: 'https://www.wikipedia.org', feedSlug: 'wikipedia' },
  { group: 'web', name: 'DuckDuckGo', url: 'https://duckduckgo.com', feedSlug: 'duckduckgo' },
  { group: 'social', name: 'Facebook', url: 'https://www.facebook.com', feedSlug: 'facebook' },
  { group: 'social', name: 'Instagram', url: 'https://www.instagram.com', feedSlug: 'instagram' },
  { group: 'social', name: 'X (Twitter)', url: 'https://x.com', feedSlug: 'twitter' },
  { group: 'social', name: 'TikTok', url: 'https://www.tiktok.com', feedSlug: 'tiktok' },
  { group: 'social', name: 'Reddit', url: 'https://www.reddit.com', feedSlug: 'reddit' },
  { group: 'social', name: 'LinkedIn', url: 'https://www.linkedin.com', feedSlug: 'linkedin' },
  { group: 'streaming', name: 'YouTube', url: 'https://www.youtube.com', feedSlug: 'youtube' },
  { group: 'streaming', name: 'Netflix', url: 'https://www.netflix.com', feedSlug: 'netflix' },
  { group: 'streaming', name: 'Twitch', url: 'https://www.twitch.tv', feedSlug: 'twitch' },
  { group: 'streaming', name: 'Spotify', url: 'https://www.spotify.com', feedSlug: 'spotify' },
  { group: 'streaming', name: 'Disney+', url: 'https://www.disneyplus.com', feedSlug: 'disney-plus' },
  { group: 'streaming', name: 'Apple Music', url: 'https://music.apple.com', feedSlug: 'apple' },
  { group: 'games', name: 'Steam', url: 'https://store.steampowered.com', feedSlug: 'steam' },
  { group: 'games', name: 'Epic Games', url: 'https://store.epicgames.com', feedSlug: 'epic-games' },
  { group: 'games', name: 'Xbox / Microsoft', url: 'https://www.xbox.com', feedSlug: 'xbox-live' },
  { group: 'games', name: 'PlayStation Network', url: 'https://www.playstation.com', feedSlug: 'playstation-network' },
  { group: 'games', name: 'Nintendo', url: 'https://www.nintendo.com', feedSlug: 'nintendo' },
  { group: 'games', name: 'Roblox', url: 'https://www.roblox.com', feedSlug: 'roblox' },
  { group: 'games', name: 'Minecraft', url: 'https://www.minecraft.net', feedSlug: 'minecraft' },
  { group: 'games', name: 'Riot Games', url: 'https://www.riotgames.com', feedSlug: 'riot-games' },
  { group: 'games', name: 'Valorant', url: 'https://playvalorant.com', feedSlug: 'valorant' },
  { group: 'games', name: 'League of Legends', url: 'https://www.leagueoflegends.com', feedSlug: 'league-of-legends' },
  { group: 'games', name: 'Fortnite', url: 'https://www.fortnite.com', feedSlug: 'fortnite' },
  { group: 'games', name: 'Mobile Legends', url: 'https://www.mobilelegends.com', feedSlug: 'mobile-legends' },
  { group: 'games', name: 'Genshin Impact', url: 'https://genshin.hoyoverse.com', feedSlug: 'genshin-impact' },
  { group: 'games', name: 'EA / Origin', url: 'https://www.ea.com', feedSlug: 'ea' },
  { group: 'games', name: 'Battle.net', url: 'https://battle.net', feedSlug: 'battle-net' },
  {
    group: 'comms',
    name: 'Discord',
    url: 'https://discord.com',
    feedSlug: 'discord',
    statusPage: 'https://discordstatus.com/api/v2/summary.json',
  },
  { group: 'comms', name: 'WhatsApp', url: 'https://www.whatsapp.com', feedSlug: 'whatsapp' },
  { group: 'comms', name: 'Telegram', url: 'https://telegram.org', feedSlug: 'telegram' },
  { group: 'comms', name: 'Zoom', url: 'https://zoom.us', feedSlug: 'zoom' },
  {
    group: 'comms',
    name: 'Slack',
    url: 'https://slack.com',
    feedSlug: 'slack',
    statusPage: 'https://status.slack.com/api/v2.0.0/current',
  },
  { group: 'comms', name: 'Gmail', url: 'https://mail.google.com', feedSlug: 'gmail' },
  { group: 'comms', name: 'Microsoft Teams', url: 'https://teams.microsoft.com', feedSlug: 'microsoft-teams' },
  {
    group: 'cloud',
    name: 'Cloudflare',
    url: 'https://www.cloudflare.com',
    feedSlug: 'cloudflare',
    statusPage: 'https://www.cloudflarestatus.com/api/v2/summary.json',
  },
  { group: 'cloud', name: 'Amazon AWS', url: 'https://aws.amazon.com', feedSlug: 'aws' },
  { group: 'cloud', name: 'Google Cloud', url: 'https://cloud.google.com', feedSlug: 'google-cloud' },
  { group: 'cloud', name: 'Azure', url: 'https://azure.microsoft.com', feedSlug: 'azure' },
  {
    group: 'cloud',
    name: 'GitHub',
    url: 'https://github.com',
    feedSlug: 'github',
    statusPage: 'https://www.githubstatus.com/api/v2/summary.json',
  },
  {
    group: 'cloud',
    name: 'GitLab',
    url: 'https://gitlab.com',
    feedSlug: 'gitlab',
    statusPage: 'https://status.gitlab.com/api/v2/summary.json',
  },
  {
    group: 'cloud',
    name: 'DigitalOcean',
    url: 'https://www.digitalocean.com',
    feedSlug: 'digitalocean',
    statusPage: 'https://status.digitalocean.com/api/v2/summary.json',
  },
  {
    group: 'cloud',
    name: 'Vercel',
    url: 'https://vercel.com',
    feedSlug: 'vercel',
    statusPage: 'https://www.vercel-status.com/api/v2/summary.json',
  },
  { group: 'dns', name: 'Cloudflare DNS', url: 'https://1.1.1.1', feedSlug: 'cloudflare' },
  { group: 'dns', name: 'Google DNS', url: 'https://dns.google', feedSlug: 'google' },
  { group: 'dns', name: 'OpenDNS', url: 'https://www.opendns.com', feedSlug: 'opendns' },
  { group: 'finance', name: 'PayPal', url: 'https://www.paypal.com', feedSlug: 'paypal' },
  { group: 'finance', name: 'Stripe', url: 'https://stripe.com', feedSlug: 'stripe', statusPage: 'https://status.stripe.com/current/index.json' },
  { group: 'finance', name: 'Amazon', url: 'https://www.amazon.com', feedSlug: 'amazon' },
  { group: 'finance', name: 'eBay', url: 'https://www.ebay.com', feedSlug: 'ebay' },
];

/** Uplink / backbone view — also feed-based (no panel-origin RTT probes). */
const UPLINK_SEEDS: { slug: string; name: string; region: string; feedSlug: string; statusPage?: string; url: string }[] = [
  {
    slug: 'cloudflare-net',
    name: 'Cloudflare Network',
    region: 'Global CDN / DNS',
    feedSlug: 'cloudflare',
    statusPage: 'https://www.cloudflarestatus.com/api/v2/summary.json',
    url: 'https://www.cloudflarestatus.com',
  },
  {
    slug: 'aws',
    name: 'Amazon AWS',
    region: 'Cloud backbone',
    feedSlug: 'aws',
    url: 'https://health.aws.amazon.com/health/status',
  },
  {
    slug: 'google-cloud',
    name: 'Google Cloud',
    region: 'Cloud backbone',
    feedSlug: 'google-cloud',
    url: 'https://status.cloud.google.com',
  },
  {
    slug: 'azure',
    name: 'Microsoft Azure',
    region: 'Cloud backbone',
    feedSlug: 'azure',
    url: 'https://status.azure.com',
  },
  {
    slug: 'fastly',
    name: 'Fastly',
    region: 'CDN',
    feedSlug: 'fastly',
    statusPage: 'https://www.fastlystatus.com/api/v2/summary.json',
    url: 'https://www.fastlystatus.com',
  },
  {
    slug: 'akamai',
    name: 'Akamai',
    region: 'CDN',
    feedSlug: 'akamai',
    url: 'https://www.akamai.com',
  },
  {
    slug: 'github',
    name: 'GitHub',
    region: 'Developer platform',
    feedSlug: 'github',
    statusPage: 'https://www.githubstatus.com/api/v2/summary.json',
    url: 'https://www.githubstatus.com',
  },
  {
    slug: 'discord',
    name: 'Discord',
    region: 'Realtime / voice',
    feedSlug: 'discord',
    statusPage: 'https://discordstatus.com/api/v2/summary.json',
    url: 'https://discordstatus.com',
  },
];

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let uplinkRunning = false;
let lastRunAt: number | null = null;
let lastUplinkRunAt: number | null = null;
let activeRouterId: number | null = null;
let lastProbeMode: 'internet-feeds' | 'router-probe' = 'internet-feeds';
let lastRouterProbeUnavailable = false;
/** Default background interval between full sweeps (router probes are slow). */
const BG_INTERVAL_MS = 5 * 60_000;

function columnExists(table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === col);
}

export function initStatusHub() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS status_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      icon TEXT DEFAULT 'globe'
    );
    CREATE TABLE IF NOT EXISTS status_monitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      type TEXT DEFAULT 'feed',
      interval_sec INTEGER DEFAULT 90,
      enabled INTEGER DEFAULT 1,
      builtin INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(group_id) REFERENCES status_groups(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS status_heartbeats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      monitor_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      latency_ms REAL,
      code INTEGER,
      error TEXT,
      checked_at INTEGER NOT NULL,
      FOREIGN KEY(monitor_id) REFERENCES status_monitors(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_status_hb_monitor ON status_heartbeats(monitor_id, checked_at DESC);
    CREATE TABLE IF NOT EXISTS status_uplink_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      region TEXT,
      url TEXT NOT NULL,
      kind TEXT DEFAULT 'feed',
      enabled INTEGER DEFAULT 1,
      builtin INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS status_uplink_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      latency_ms REAL,
      code INTEGER,
      body_snip TEXT,
      error TEXT,
      checked_at INTEGER NOT NULL,
      FOREIGN KEY(target_id) REFERENCES status_uplink_targets(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_status_uplink_res ON status_uplink_results(target_id, checked_at DESC);
    CREATE TABLE IF NOT EXISTS status_uplink_hosts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER DEFAULT 443,
      type TEXT DEFAULT 'tcp',
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS status_uplink_host_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      latency_ms REAL,
      error TEXT,
      checked_at INTEGER NOT NULL,
      FOREIGN KEY(host_id) REFERENCES status_uplink_hosts(id) ON DELETE CASCADE
    );
  `);

  if (!columnExists('status_monitors', 'feed_slug')) {
    db.exec(`ALTER TABLE status_monitors ADD COLUMN feed_slug TEXT`);
  }
  if (!columnExists('status_monitors', 'status_page')) {
    db.exec(`ALTER TABLE status_monitors ADD COLUMN status_page TEXT`);
  }
  if (!columnExists('status_uplink_targets', 'feed_slug')) {
    db.exec(`ALTER TABLE status_uplink_targets ADD COLUMN feed_slug TEXT`);
  }
  if (!columnExists('status_uplink_targets', 'status_page')) {
    db.exec(`ALTER TABLE status_uplink_targets ADD COLUMN status_page TEXT`);
  }
  if (!columnExists('status_heartbeats', 'router_id')) {
    db.exec(`ALTER TABLE status_heartbeats ADD COLUMN router_id INTEGER NOT NULL DEFAULT 0`);
  }
  if (!columnExists('status_uplink_results', 'router_id')) {
    db.exec(`ALTER TABLE status_uplink_results ADD COLUMN router_id INTEGER NOT NULL DEFAULT 0`);
  }

  seedGroupsAndMonitors();
  seedUplinkTargets();
  migrateBuiltinsToFeeds();
}

function seedGroupsAndMonitors() {
  const insGroup = db.prepare(
    'INSERT OR IGNORE INTO status_groups (slug, name, sort_order, icon) VALUES (?, ?, ?, ?)'
  );
  for (const g of GROUP_SEEDS) {
    insGroup.run(g.slug, g.name, g.sort, g.icon);
  }

  const groupId = (slug: string) =>
    (db.prepare('SELECT id FROM status_groups WHERE slug = ?').get(slug) as { id: number } | undefined)?.id;

  const countBuiltin = (db.prepare('SELECT COUNT(*) AS c FROM status_monitors WHERE builtin = 1').get() as { c: number }).c;
  if (countBuiltin > 0) return;

  const ins = db.prepare(`
    INSERT INTO status_monitors (group_id, name, url, type, interval_sec, enabled, builtin, feed_slug, status_page)
    VALUES (?, ?, ?, 'feed', ?, 1, 1, ?, ?)
  `);
  for (const m of MONITOR_SEEDS) {
    const gid = groupId(m.group);
    if (!gid) continue;
    ins.run(gid, m.name, m.url, DEFAULT_INTERVAL_SEC, m.feedSlug, m.statusPage || null);
  }
}

/** Existing installs: attach feed slugs / status pages; stop treating type as http/tcp. */
function migrateBuiltinsToFeeds() {
  const byName = new Map(MONITOR_SEEDS.map((m) => [m.name, m]));
  const rows = db.prepare('SELECT id, name, feed_slug AS feedSlug FROM status_monitors WHERE builtin = 1').all() as any[];
  const upd = db.prepare(`
    UPDATE status_monitors
    SET type = 'feed', feed_slug = ?, status_page = ?, url = COALESCE(?, url)
    WHERE id = ?
  `);
  for (const row of rows) {
    const seed = byName.get(row.name);
    if (!seed) {
      if (!row.feedSlug) {
        db.prepare(`UPDATE status_monitors SET type = 'feed' WHERE id = ?`).run(row.id);
      }
      continue;
    }
    upd.run(seed.feedSlug, seed.statusPage || null, seed.url, row.id);
  }

  // Drop legacy local-probe uplink targets once; reseed feed-based backbone list
  const legacy = db
    .prepare(
      `SELECT id FROM status_uplink_targets WHERE slug IN ('ifconfig-me','icanhazip','ipify','google-204','msft-ncsi','apple-captive','cf-trace-global') LIMIT 1`
    )
    .get();
  const missingFeed = db
    .prepare(`SELECT COUNT(*) AS c FROM status_uplink_targets WHERE feed_slug IS NULL OR feed_slug = ''`)
    .get() as { c: number };
  if (legacy || (missingFeed.c > 0 && (db.prepare('SELECT COUNT(*) AS c FROM status_uplink_targets').get() as { c: number }).c > 0)) {
    db.prepare('DELETE FROM status_uplink_results').run();
    db.prepare('DELETE FROM status_uplink_targets').run();
    seedUplinkTargets(true);
  }
}

function seedUplinkTargets(force = false) {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM status_uplink_targets').get() as { c: number }).c;
  if (count > 0 && !force) return;
  const ins = db.prepare(`
    INSERT OR IGNORE INTO status_uplink_targets (slug, name, region, url, kind, enabled, builtin, feed_slug, status_page)
    VALUES (?, ?, ?, ?, 'feed', 1, 1, ?, ?)
  `);
  for (const t of UPLINK_SEEDS) {
    ins.run(t.slug, t.name, t.region, t.url, t.feedSlug, t.statusPage || null);
  }
}

function worse(a: HeartbeatStatus, b: HeartbeatStatus): HeartbeatStatus {
  const rank = { pending: -1, up: 0, degraded: 1, down: 2 };
  return rank[b] > rank[a] ? b : a;
}

function mapDownStatus(s: string | undefined): HeartbeatStatus {
  const v = (s || '').toLowerCase();
  if (v === 'down' || v === 'major_outage' || v === 'critical') return 'down';
  if (v === 'degraded' || v === 'partial_outage' || v === 'minor' || v === 'major') return 'degraded';
  return 'up';
}

function mapOfficialIndicator(ind: string | null | undefined): HeartbeatStatus | null {
  if (ind == null || ind === '' || ind === 'none') return null;
  const v = ind.toLowerCase();
  if (v === 'critical' || v === 'major') return 'down';
  if (v === 'minor' || v === 'maintenance') return 'degraded';
  return null;
}

function mapStatuspageIndicator(ind: string | undefined): HeartbeatStatus {
  const v = (ind || '').toLowerCase();
  if (v === 'major' || v === 'critical') return 'down';
  if (v === 'minor' || v === 'maintenance') return 'degraded';
  return 'up';
}

async function fetchJson(url: string): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': UA },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCrowdsourcedStatus(feedSlug: string): Promise<{
  status: HeartbeatStatus;
  detail: string;
  ok: boolean;
  reports1h: number;
  reports24h: number;
}> {
  if (!feedSlug) {
    return { status: 'pending', detail: 'No feed slug', ok: false, reports1h: 0, reports24h: 0 };
  }
  const data = await fetchJson(`https://isitdownstatus.com/api/v1/status/${encodeURIComponent(feedSlug)}`);
  if (!data?.ok || !data?.data) {
    return { status: 'up', detail: 'Crowdsourced feed unavailable', ok: false, reports1h: 0, reports24h: 0 };
  }
  const d = data.data;
  const fromReports = mapDownStatus(d.status);
  const fromOfficial = mapOfficialIndicator(d.official_indicator);
  const status = fromOfficial ? worse(fromReports, fromOfficial) : fromReports;
  const parts: string[] = ['Internet status'];
  if (d.official_indicator && d.official_indicator !== 'none') parts.push(`official: ${d.official_indicator}`);
  if (Number(d.report_count_1h) > 0) parts.push(`${d.report_count_1h} reports/1h`);
  if (Number(d.report_count_24h) > 0) parts.push(`${d.report_count_24h} reports/24h`);
  return {
    status,
    detail: parts.join(' · '),
    ok: true,
    reports1h: Number(d.report_count_1h) || 0,
    reports24h: Number(d.report_count_24h) || 0,
  };
}

async function fetchStatuspage(url: string): Promise<{ status: HeartbeatStatus; detail: string; ok: boolean }> {
  if (!url) return { status: 'up', detail: '', ok: false };
  const data = await fetchJson(url);
  // Atlassian Statuspage summary
  if (data?.status?.indicator) {
    const status = mapStatuspageIndicator(data.status.indicator);
    return {
      status,
      detail: data.status.description || `Statuspage: ${data.status.indicator}`,
      ok: true,
    };
  }
  // Slack-style
  if (data?.status && typeof data.status === 'string') {
    const status = mapDownStatus(data.status);
    return { status, detail: `Official: ${data.status}`, ok: true };
  }
  // Stripe-like
  if (data?.largeststatus || data?.message) {
    return { status: 'up', detail: String(data.message || 'OK'), ok: true };
  }
  return { status: 'up', detail: '', ok: false };
}

async function resolveFeedStatus(feedSlug: string | null, statusPage: string | null) {
  const crowd = feedSlug
    ? await fetchCrowdsourcedStatus(feedSlug)
    : { status: 'pending' as HeartbeatStatus, detail: '', ok: false, reports1h: 0, reports24h: 0 };
  const official = statusPage ? await fetchStatuspage(statusPage) : { status: 'up' as HeartbeatStatus, detail: '', ok: false };

  let status: HeartbeatStatus = 'pending';
  const details: string[] = [];

  if (crowd.ok) {
    status = crowd.status;
    details.push(crowd.detail);
  }
  if (official.ok) {
    status = crowd.ok ? worse(status, official.status) : official.status;
    if (official.detail) details.push(official.detail);
  }

  if (!crowd.ok && !official.ok) {
    return {
      status: 'degraded' as HeartbeatStatus,
      detail: 'Status feeds unreachable (not a local outage check)',
      error: 'feed unavailable',
    };
  }

  return {
    status: status === 'pending' ? ('up' as HeartbeatStatus) : status,
    detail: details.filter(Boolean).join(' · ') || 'Operational',
    error: status === 'up' ? null : details.join(' · '),
  };
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

function pruneHeartbeats(monitorId: number) {
  const rows = db
    .prepare(
      'SELECT checked_at AS checkedAt FROM status_heartbeats WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT ?'
    )
    .all(monitorId, HEARTBEAT_KEEP) as { checkedAt: number }[];
  if (rows.length < HEARTBEAT_KEEP) return;
  const cutoff = rows[rows.length - 1].checkedAt;
  db.prepare('DELETE FROM status_heartbeats WHERE monitor_id = ? AND checked_at < ?').run(monitorId, cutoff);
}

function recordHeartbeat(
  monitorId: number,
  status: HeartbeatStatus,
  detail?: string | null,
  routerId = 0,
  latencyMs?: number | null
) {
  db.prepare(`
    INSERT INTO status_heartbeats (monitor_id, status, latency_ms, code, error, checked_at, router_id)
    VALUES (?, ?, ?, NULL, ?, ?, ?)
  `).run(monitorId, status, latencyMs ?? null, detail || null, Date.now(), routerId || 0);
  pruneHeartbeats(monitorId);
}

function ensureStatusHubRouterSetting() {
  if (!columnExists('app_settings', 'status_hub_router_id')) {
    db.exec('ALTER TABLE app_settings ADD COLUMN status_hub_router_id INTEGER');
  }
}

function persistStatusHubRouterId(id: number | null) {
  try {
    ensureStatusHubRouterSetting();
    db.prepare('UPDATE app_settings SET status_hub_router_id = ? WHERE id = 1').run(id);
  } catch {
    /* ignore */
  }
}

function loadPersistedStatusHubRouterId(): number | null {
  try {
    ensureStatusHubRouterSetting();
    const row = db.prepare('SELECT status_hub_router_id AS id FROM app_settings WHERE id = 1').get() as
      | { id?: number | null }
      | undefined;
    const n = Number(row?.id);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function setStatusHubRouterId(routerId: number | null | undefined) {
  const id = routerId != null && Number(routerId) > 0 ? Number(routerId) : null;
  activeRouterId = id;
  if (id) persistStatusHubRouterId(id);
  return activeRouterId;
}

export function getStatusHubRouterId() {
  return activeRouterId;
}

function resolveBackgroundRouter(): { id: number; conn: RouterConn } | null {
  const preferred = activeRouterId || loadPersistedStatusHubRouterId();
  const pick = (id: number) => {
    const r = db.prepare('SELECT id, host, port, api_user, api_pass FROM routers WHERE id = ?').get(id) as
      | { id: number; host?: string; port?: number; api_user?: string; api_pass?: string }
      | undefined;
    if (!r?.host || !r?.api_user) return null;
    return {
      id: r.id,
      conn: {
        host: r.host,
        port: Number(r.port) || 8728,
        api_user: r.api_user,
        api_pass: r.api_pass,
      },
    };
  };
  if (preferred) {
    const hit = pick(preferred);
    if (hit) {
      activeRouterId = hit.id;
      return hit;
    }
  }
  const row = db
    .prepare(
      `SELECT id FROM routers
       WHERE host IS NOT NULL AND TRIM(host) != '' AND api_user IS NOT NULL AND TRIM(api_user) != ''
       ORDER BY id LIMIT 1`
    )
    .get() as { id: number } | undefined;
  return row ? pick(row.id) : null;
}

export async function runStatusChecks(
  monitorIds?: number[],
  routerConn?: RouterConn | null,
  routerId?: number | null
) {
  if (running) return { skipped: true, running: true };
  running = true;
  const rid = routerId ?? activeRouterId ?? 0;
  try {
    let rows: any[];
    if (monitorIds?.length) {
      const placeholders = monitorIds.map(() => '?').join(',');
      rows = db
        .prepare(
          `SELECT id, name, url, feed_slug AS feedSlug, status_page AS statusPage FROM status_monitors WHERE enabled = 1 AND id IN (${placeholders})`
        )
        .all(...monitorIds);
    } else {
      rows = db
        .prepare(
          `SELECT id, name, url, feed_slug AS feedSlug, status_page AS statusPage FROM status_monitors WHERE enabled = 1`
        )
        .all();
    }

    const viaRouter = !!(routerConn?.host && routerConn?.api_user);
    lastRouterProbeUnavailable = rid > 0 && !viaRouter;
    lastProbeMode = viaRouter ? 'router-probe' : 'internet-feeds';

    if (viaRouter) {
      // Drop stale router heartbeats so UI cannot show hours-old "output option" errors mid-scan.
      if (rid > 0) {
        db.prepare('DELETE FROM status_heartbeats WHERE router_id = ?').run(rid);
        for (const m of rows) recordHeartbeat(m.id, 'pending', 'Scanning…', rid, null);
      }
      const urls = rows.map((m) => String(m.url || ''));
      const results = await probeHttpUrlsFromRouter(routerConn!, urls);
      for (let i = 0; i < rows.length; i++) {
        const m = rows[i];
        const r = results[i];
        recordHeartbeat(
          m.id,
          r.status,
          r.error || (r.ms != null ? `Router probe · ${r.ms} ms` : 'Router probe'),
          rid,
          r.ms
        );
      }
    } else {
      await mapPool(rows, CONCURRENCY, async (m) => {
        const r = await resolveFeedStatus(m.feedSlug || null, m.statusPage || null);
        recordHeartbeat(m.id, r.status, r.error || r.detail, 0);
      });
    }
    lastRunAt = Date.now();
    return {
      ok: true,
      checked: rows.length,
      at: lastRunAt,
      mode: lastProbeMode,
      routerId: viaRouter ? rid : null,
      routerProbeUnavailable: lastRouterProbeUnavailable,
    };
  } finally {
    running = false;
  }
}

function pruneUplinkResults(targetId: number) {
  const rows = db
    .prepare(
      'SELECT checked_at AS checkedAt FROM status_uplink_results WHERE target_id = ? ORDER BY checked_at DESC LIMIT 60'
    )
    .all(targetId) as { checkedAt: number }[];
  if (rows.length < 60) return;
  const cutoff = rows[rows.length - 1].checkedAt;
  db.prepare('DELETE FROM status_uplink_results WHERE target_id = ? AND checked_at < ?').run(targetId, cutoff);
}

export async function runUplinkChecks(routerConn?: RouterConn | null, routerId?: number | null) {
  if (uplinkRunning) return { skipped: true, running: true };
  uplinkRunning = true;
  const rid = routerId ?? activeRouterId ?? 0;
  try {
    const targets = db
      .prepare(
        `SELECT id, name, url, feed_slug AS feedSlug, status_page AS statusPage FROM status_uplink_targets WHERE enabled = 1`
      )
      .all() as any[];

    const viaRouter = !!(routerConn?.host && routerConn?.api_user);

    if (viaRouter) {
      const urls = targets.map((t) => String(t.url || ''));
      const results = await probeHttpUrlsFromRouter(routerConn!, urls);
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const r = results[i];
        db.prepare(`
          INSERT INTO status_uplink_results (target_id, status, latency_ms, code, body_snip, error, checked_at, router_id)
          VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
        `).run(
          t.id,
          r.status,
          r.ms,
          r.ms != null ? `Router probe · ${r.ms} ms` : null,
          r.error || null,
          Date.now(),
          rid
        );
        pruneUplinkResults(t.id);
      }
    } else {
      await mapPool(targets, CONCURRENCY, async (t) => {
        const r = await resolveFeedStatus(t.feedSlug || null, t.statusPage || null);
        db.prepare(`
          INSERT INTO status_uplink_results (target_id, status, latency_ms, code, body_snip, error, checked_at, router_id)
          VALUES (?, ?, NULL, NULL, ?, ?, ?, 0)
        `).run(t.id, r.status, r.detail || null, r.error || null, Date.now());
        pruneUplinkResults(t.id);
      });
    }

    lastUplinkRunAt = Date.now();
    return {
      ok: true,
      targets: targets.length,
      hosts: 0,
      at: lastUplinkRunAt,
      mode: viaRouter ? 'router-probe' : 'internet-feeds',
      routerId: viaRouter ? rid : null,
    };
  } finally {
    uplinkRunning = false;
  }
}

function latestHeartbeat(monitorId: number, routerId = 0) {
  return db
    .prepare(
      `
    SELECT status, latency_ms AS latencyMs, code, error, checked_at AS checkedAt
    FROM status_heartbeats WHERE monitor_id = ? AND router_id = ? ORDER BY checked_at DESC LIMIT 1
  `
    )
    .get(monitorId, routerId || 0) as any;
}

function isRouterApiConfigured(routerId: number) {
  if (routerId <= 0) return false;
  const r = db.prepare('SELECT host, api_user FROM routers WHERE id = ?').get(routerId) as
    | { host?: string | null; api_user?: string | null }
    | undefined;
  return !!(String(r?.host || '').trim() && String(r?.api_user || '').trim());
}

function heartbeatView(monitorId: number, requestedRouterId = 0, routerApiConfigured = true) {
  if (requestedRouterId > 0) {
    if (routerApiConfigured) {
      const fromRouter = latestHeartbeat(monitorId, requestedRouterId);
      if (fromRouter) return { hb: fromRouter, source: 'router' as const, readRouterId: requestedRouterId };
    }
    const fromFeed = latestHeartbeat(monitorId, 0);
    if (fromFeed) {
      return {
        hb: fromFeed,
        source: routerApiConfigured ? ('internet-fallback' as const) : ('internet' as const),
        readRouterId: 0,
      };
    }
    return { hb: null as any, source: 'pending' as const, readRouterId: requestedRouterId };
  }
  const fromFeed = latestHeartbeat(monitorId, 0);
  return { hb: fromFeed, source: 'internet' as const, readRouterId: 0 };
}

function heartbeatHistory(monitorId: number, routerId = 0, limit = 48) {
  return db
    .prepare(
      `
    SELECT status, latency_ms AS latencyMs, code, checked_at AS t
    FROM status_heartbeats WHERE monitor_id = ? AND router_id = ?
    ORDER BY checked_at DESC LIMIT ?
  `
    )
    .all(monitorId, routerId || 0, limit)
    .reverse() as any[];
}

function uptimePct(monitorId: number, routerId = 0): number {
  const rows = db
    .prepare(
      `SELECT status FROM status_heartbeats WHERE monitor_id = ? AND router_id = ? ORDER BY checked_at DESC LIMIT 100`
    )
    .all(monitorId, routerId || 0) as { status: string }[];
  if (!rows.length) return 100;
  const up = rows.filter((r) => r.status === 'up' || r.status === 'degraded').length;
  return Math.round((up / rows.length) * 1000) / 10;
}

function latestUplinkResult(targetId: number, routerId = 0) {
  return db
    .prepare(
      `
      SELECT status, latency_ms AS latencyMs, code, body_snip AS bodySnip, error, checked_at AS checkedAt
      FROM status_uplink_results WHERE target_id = ? AND router_id = ? ORDER BY checked_at DESC LIMIT 1
    `
    )
    .get(targetId, routerId || 0) as any;
}

function uplinkView(targetId: number, requestedRouterId = 0) {
  if (requestedRouterId > 0) {
    const fromRouter = latestUplinkResult(targetId, requestedRouterId);
    if (fromRouter) return { row: fromRouter, readRouterId: requestedRouterId };
    const fromFeed = latestUplinkResult(targetId, 0);
    if (fromFeed) return { row: fromFeed, readRouterId: 0 };
    return { row: null as any, readRouterId: requestedRouterId };
  }
  return { row: latestUplinkResult(targetId, 0), readRouterId: 0 };
}

function uplinkHistory(targetId: number, routerId = 0, limit = 30) {
  return db
    .prepare(
      `
      SELECT status, latency_ms AS latencyMs, checked_at AS t
      FROM status_uplink_results WHERE target_id = ? AND router_id = ? ORDER BY checked_at DESC LIMIT ?
    `
    )
    .all(targetId, routerId || 0, limit)
    .reverse() as any[];
}

export function listStatusOverview(routerId?: number | null) {
  const rid = routerId ?? activeRouterId ?? 0;
  const routerApiConfigured = isRouterApiConfigured(rid);
  const routerProbeUnavailable = rid > 0 && !routerApiConfigured;
  const groups = db
    .prepare('SELECT id, slug, name, sort_order AS sortOrder, icon FROM status_groups ORDER BY sort_order, name')
    .all() as any[];
  const monitors = db
    .prepare(
      `
    SELECT m.id, m.group_id AS groupId, m.name, m.url, m.type, m.interval_sec AS intervalSec,
           m.enabled, m.builtin, m.feed_slug AS feedSlug, m.status_page AS statusPage,
           g.slug AS groupSlug, g.name AS groupName
    FROM status_monitors m
    JOIN status_groups g ON g.id = m.group_id
    ORDER BY g.sort_order, m.name
  `
    )
    .all() as any[];

  const enriched = monitors.map((m) => {
    const view = heartbeatView(m.id, rid, routerApiConfigured);
    const last = view.hb;
    const history = heartbeatHistory(m.id, view.readRouterId, 40);
    return {
      ...m,
      enabled: !!m.enabled,
      builtin: !!m.builtin,
      status: (last?.status as HeartbeatStatus) || 'pending',
      latencyMs: last?.latencyMs ?? null,
      code: last?.code ?? null,
      lastError: last?.error ?? null,
      detail: last?.error ?? null,
      lastChecked: last?.checkedAt ?? null,
      uptimePct: uptimePct(m.id, view.readRouterId),
      source: view.source,
      history: history.map((h) => ({
        t: h.t,
        up: h.status === 'up' || h.status === 'degraded',
        status: h.status,
        ms: h.latencyMs ?? null,
      })),
    };
  });

  const routerProbeActive = enriched.some((m) => m.source === 'router');
  const feedFallback = rid > 0 && enriched.some((m) => m.source === 'internet-fallback');
  const summary = {
    total: enriched.length,
    up: enriched.filter((m) => m.status === 'up').length,
    degraded: enriched.filter((m) => m.status === 'degraded').length,
    down: enriched.filter((m) => m.status === 'down').length,
    pending: enriched.filter((m) => m.status === 'pending').length,
    avgMs: (() => {
      const lat = enriched.map((m) => m.latencyMs).filter((n): n is number => n != null);
      return lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null;
    })(),
    lastRunAt,
    scanning: running,
    mode: routerProbeActive ? ('router-probe' as const) : ('internet-feeds' as const),
    routerId: routerProbeActive ? rid : null,
    routerProbeUnavailable,
    feedFallback,
    egressOk: true as boolean | null,
  };

  return { groups, monitors: enriched, summary };
}

export function listUplinkOverview(routerId?: number | null) {
  const rid = routerId ?? activeRouterId ?? 0;
  const targets = db
    .prepare(
      `
    SELECT id, slug, name, region, url, kind, enabled, builtin,
           feed_slug AS feedSlug, status_page AS statusPage
    FROM status_uplink_targets ORDER BY name
  `
    )
    .all() as any[];

  const enrichedTargets = targets.map((t) => {
    const view = uplinkView(t.id, rid);
    const last = view.row;
    const history = uplinkHistory(t.id, view.readRouterId, 30);
    return {
      ...t,
      enabled: !!t.enabled,
      builtin: !!t.builtin,
      status: last?.status || 'pending',
      latencyMs: null,
      code: last?.code ?? null,
      bodySnip: last?.bodySnip ?? null,
      lastError: last?.error ?? null,
      lastChecked: last?.checkedAt ?? null,
      history: history.map((h) => ({
        t: h.t,
        up: h.status === 'up' || h.status === 'degraded',
        ms: h.latencyMs ?? null,
        status: h.status,
      })),
    };
  });

  const routerProbeActive = enrichedTargets.some((t) => rid > 0 && latestUplinkResult(t.id, rid));
  const summary = {
    publicIp: null as string | null,
    total: enrichedTargets.length,
    up: enrichedTargets.filter((t) => t.status === 'up').length,
    degraded: enrichedTargets.filter((t) => t.status === 'degraded').length,
    down: enrichedTargets.filter((t) => t.status === 'down').length,
    avgMs: (() => {
      const lat = enrichedTargets.map((t) => t.latencyMs).filter((n): n is number => n != null);
      return lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null;
    })(),
    lastRunAt: lastUplinkRunAt,
    mode: routerProbeActive ? ('router-probe' as const) : ('internet-feeds' as const),
    routerId: routerProbeActive ? rid : null,
    feedFallback: rid > 0 && !routerProbeActive && enrichedTargets.some((t) => t.status !== 'pending'),
  };

  return { targets: enrichedTargets, hosts: [], summary };
}

export function createMonitor(input: {
  name: string;
  url?: string;
  feedSlug?: string;
  statusPage?: string;
  groupSlug?: string;
  type?: MonitorType;
  intervalSec?: number;
}) {
  const name = String(input.name || '').trim();
  const feedSlug = String(input.feedSlug || '').trim().toLowerCase().replace(/\s+/g, '-');
  const statusPage = String(input.statusPage || '').trim() || null;
  const url = String(input.url || '').trim() || (feedSlug ? `https://isitdownstatus.com/${feedSlug}` : '');
  if (!name) throw new Error('Name is required');
  if (!feedSlug && !statusPage) {
    throw new Error('Provide an internet feed slug (isitdownstatus) and/or official status page JSON URL — local probing is disabled');
  }
  const slug = input.groupSlug || 'custom';
  let group = db.prepare('SELECT id FROM status_groups WHERE slug = ?').get(slug) as { id: number } | undefined;
  if (!group) {
    db.prepare('INSERT INTO status_groups (slug, name, sort_order, icon) VALUES (?, ?, ?, ?)').run(
      'custom',
      'Custom Monitors',
      90,
      'plus'
    );
    group = db.prepare('SELECT id FROM status_groups WHERE slug = ?').get('custom') as { id: number };
  }
  const interval = Math.max(60, Number(input.intervalSec) || DEFAULT_INTERVAL_SEC);
  const info = db
    .prepare(
      `
    INSERT INTO status_monitors (group_id, name, url, type, interval_sec, enabled, builtin, feed_slug, status_page)
    VALUES (?, ?, ?, 'feed', ?, 1, 0, ?, ?)
  `
    )
    .run(group.id, name, url || 'https://isitdownstatus.com', interval, feedSlug || null, statusPage);
  return db.prepare('SELECT * FROM status_monitors WHERE id = ?').get(info.lastInsertRowid);
}

export function deleteMonitor(id: number) {
  const row = db.prepare('SELECT id, builtin FROM status_monitors WHERE id = ?').get(id) as any;
  if (!row) throw new Error('Monitor not found');
  if (row.builtin) throw new Error('Built-in monitors cannot be deleted (disable instead)');
  db.prepare('DELETE FROM status_heartbeats WHERE monitor_id = ?').run(id);
  db.prepare('DELETE FROM status_monitors WHERE id = ?').run(id);
}

export function setMonitorEnabled(id: number, enabled: boolean) {
  const info = db.prepare('UPDATE status_monitors SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  if (!info.changes) throw new Error('Monitor not found');
}

/** @deprecated Local IP probes disabled — kept for API compatibility. */
export function createUplinkHost(_input: { label: string; host: string; port?: number; type?: string }) {
  throw new Error('Local IP/host probing is disabled. Status Hub uses internet status feeds only.');
}

/** @deprecated */
export function deleteUplinkHost(id: number) {
  db.prepare('DELETE FROM status_uplink_host_results WHERE host_id = ?').run(id);
  const info = db.prepare('DELETE FROM status_uplink_hosts WHERE id = ?').run(id);
  if (!info.changes) throw new Error('Host not found');
}

export function prometheusMetrics(): string {
  const overview = listStatusOverview();
  const uplink = listUplinkOverview();
  const lines: string[] = [
    '# HELP status_hub_monitor_up 1 if internet status feed reports up',
    '# TYPE status_hub_monitor_up gauge',
  ];
  for (const m of overview.monitors) {
    const labels = `id="${m.id}",name="${escapeLabel(m.name)}",group="${escapeLabel(m.groupSlug)}"`;
    lines.push(`status_hub_monitor_up{${labels}} ${m.status === 'up' || m.status === 'degraded' ? 1 : 0}`);
    lines.push(`status_hub_monitor_uptime_pct{${labels}} ${m.uptimePct}`);
  }
  lines.push('# HELP status_hub_backbone_up Internet backbone / CDN feed status');
  lines.push('# TYPE status_hub_backbone_up gauge');
  for (const t of uplink.targets) {
    lines.push(
      `status_hub_backbone_up{slug="${escapeLabel(t.slug)}",name="${escapeLabel(t.name)}"} ${
        t.status === 'up' || t.status === 'degraded' ? 1 : 0
      }`
    );
  }
  lines.push(`status_hub_last_run_timestamp ${lastRunAt ? Math.floor(lastRunAt / 1000) : 0}`);
  lines.push(`status_hub_uplink_last_run_timestamp ${lastUplinkRunAt ? Math.floor(lastUplinkRunAt / 1000) : 0}`);
  return lines.join('\n') + '\n';
}

function escapeLabel(s: string) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

async function runBackgroundStatusSweep() {
  const bg = resolveBackgroundRouter();
  if (bg) {
    activeRouterId = bg.id;
    await runStatusChecks(undefined, bg.conn, bg.id);
    await runUplinkChecks(bg.conn, bg.id);
  } else {
    await runStatusChecks(undefined, null, null);
    await runUplinkChecks(null, null);
  }
}

/**
 * Continuously refresh Status Hub in the background so the UI does not require
 * manual "Scan now". Uses the last selected / first API-configured router when available.
 * Chains runs (wait until finished + interval) because router sweeps can take minutes.
 */
export function startStatusHub(intervalMs = BG_INTERVAL_MS) {
  initStatusHub();
  const persisted = loadPersistedStatusHubRouterId();
  if (persisted) activeRouterId = persisted;

  const scheduleNext = (delay: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void (async () => {
        try {
          await runBackgroundStatusSweep();
        } catch {
          /* ignore */
        }
        scheduleNext(intervalMs);
      })();
    }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
  };

  // First sweep shortly after boot, then every intervalMs after each finish.
  scheduleNext(8_000);
}
