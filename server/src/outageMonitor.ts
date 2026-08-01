/**
 * Outage Monitor — Downdetector-style public-internet status directory.
 * Crowdsourced feeds (isitdownstatus.com) + official status pages.
 * Also stores ISP-local subscriber reports from the client portal.
 * Separate from Status Hub (router WAN probes).
 */
import { db } from './db.js';

export type OutageLevel = 'no_problems' | 'possible_problems' | 'problems' | 'unknown';

let tablesReady = false;

export function initOutageReportTables() {
  if (tablesReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS outage_subscriber_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pppoe_user_id INTEGER,
      customer_name TEXT,
      contact TEXT,
      account_number TEXT,
      description TEXT,
      job_order_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS outage_subscriber_report_services (
      report_id INTEGER NOT NULL,
      service_slug TEXT NOT NULL,
      PRIMARY KEY (report_id, service_slug)
    );
    CREATE INDEX IF NOT EXISTS idx_outage_report_services_slug
      ON outage_subscriber_report_services(service_slug);
    CREATE INDEX IF NOT EXISTS idx_outage_reports_created
      ON outage_subscriber_reports(created_at);
  `);
  tablesReady = true;
}

type ServiceSeed = {
  slug: string;
  name: string;
  category: string;
  url: string;
  feedSlug: string;
  statusPage?: string;
  region?: 'ph' | 'global';
};

const SERVICE_SEEDS: ServiceSeed[] = [
  // Philippines
  { slug: 'pldt', name: 'PLDT', category: 'ISP & Telco', url: 'https://www.pldt.com', feedSlug: 'pldt', region: 'ph' },
  { slug: 'globe', name: 'Globe', category: 'ISP & Telco', url: 'https://www.globe.com.ph', feedSlug: 'globe', region: 'ph' },
  { slug: 'smart', name: 'Smart', category: 'ISP & Telco', url: 'https://smart.com.ph', feedSlug: 'smart', region: 'ph' },
  { slug: 'converge', name: 'Converge ICT', category: 'ISP & Telco', url: 'https://www.convergeict.com', feedSlug: 'converge', region: 'ph' },
  { slug: 'dito', name: 'DITO Telecommunity', category: 'ISP & Telco', url: 'https://dito.ph', feedSlug: 'dito', region: 'ph' },
  { slug: 'sky-cable', name: 'Sky Cable', category: 'ISP & Telco', url: 'https://www.sky.com.ph', feedSlug: 'sky-cable', region: 'ph' },
  { slug: 'gcash', name: 'GCash', category: 'Finance', url: 'https://www.gcash.com', feedSlug: 'gcash', region: 'ph' },
  { slug: 'maya', name: 'Maya', category: 'Finance', url: 'https://www.maya.ph', feedSlug: 'paymaya', region: 'ph' },
  { slug: 'bpi', name: 'BPI', category: 'Finance', url: 'https://www.bpi.com.ph', feedSlug: 'bpi', region: 'ph' },
  { slug: 'bdo', name: 'BDO Unibank', category: 'Finance', url: 'https://www.bdo.com.ph', feedSlug: 'bdo', region: 'ph' },
  { slug: 'landbank', name: 'Landbank', category: 'Finance', url: 'https://www.landbank.com', feedSlug: 'landbank', region: 'ph' },
  { slug: 'metrobank', name: 'Metrobank', category: 'Finance', url: 'https://www.metrobank.com.ph', feedSlug: 'metrobank', region: 'ph' },
  { slug: 'mobile-legends', name: 'Mobile Legends', category: 'Games', url: 'https://www.mobilelegends.com', feedSlug: 'mobile-legends', region: 'ph' },
  // Global
  { slug: 'facebook', name: 'Facebook', category: 'Social', url: 'https://www.facebook.com', feedSlug: 'facebook', region: 'global' },
  { slug: 'messenger', name: 'Facebook Messenger', category: 'Social', url: 'https://www.messenger.com', feedSlug: 'facebook-messenger', region: 'global' },
  { slug: 'instagram', name: 'Instagram', category: 'Social', url: 'https://www.instagram.com', feedSlug: 'instagram', region: 'global' },
  { slug: 'tiktok', name: 'TikTok', category: 'Social', url: 'https://www.tiktok.com', feedSlug: 'tiktok', region: 'global' },
  { slug: 'x-twitter', name: 'X (Twitter)', category: 'Social', url: 'https://x.com', feedSlug: 'twitter', region: 'global' },
  { slug: 'youtube', name: 'YouTube', category: 'Streaming', url: 'https://www.youtube.com', feedSlug: 'youtube', region: 'global' },
  { slug: 'netflix', name: 'Netflix', category: 'Streaming', url: 'https://www.netflix.com', feedSlug: 'netflix', region: 'global' },
  { slug: 'spotify', name: 'Spotify', category: 'Streaming', url: 'https://www.spotify.com', feedSlug: 'spotify', region: 'global' },
  { slug: 'google', name: 'Google', category: 'Web', url: 'https://www.google.com', feedSlug: 'google', region: 'global' },
  { slug: 'gmail', name: 'Gmail', category: 'Communication', url: 'https://mail.google.com', feedSlug: 'gmail', region: 'global' },
  { slug: 'discord', name: 'Discord', category: 'Communication', url: 'https://discord.com', feedSlug: 'discord', statusPage: 'https://discordstatus.com/api/v2/summary.json', region: 'global' },
  { slug: 'telegram', name: 'Telegram', category: 'Communication', url: 'https://telegram.org', feedSlug: 'telegram', region: 'global' },
  { slug: 'whatsapp', name: 'WhatsApp', category: 'Communication', url: 'https://www.whatsapp.com', feedSlug: 'whatsapp', region: 'global' },
  { slug: 'steam', name: 'Steam', category: 'Games', url: 'https://store.steampowered.com', feedSlug: 'steam', region: 'global' },
  { slug: 'roblox', name: 'Roblox', category: 'Games', url: 'https://www.roblox.com', feedSlug: 'roblox', region: 'global' },
  { slug: 'valorant', name: 'Valorant', category: 'Games', url: 'https://playvalorant.com', feedSlug: 'valorant', region: 'global' },
  { slug: 'dota-2', name: 'Dota 2', category: 'Games', url: 'https://www.dota2.com', feedSlug: 'dota-2', region: 'global' },
  { slug: 'fortnite', name: 'Fortnite', category: 'Games', url: 'https://www.fortnite.com', feedSlug: 'fortnite', region: 'global' },
  { slug: 'minecraft', name: 'Minecraft', category: 'Games', url: 'https://www.minecraft.net', feedSlug: 'minecraft', region: 'global' },
  { slug: 'cloudflare', name: 'Cloudflare', category: 'Cloud', url: 'https://www.cloudflare.com', feedSlug: 'cloudflare', statusPage: 'https://www.cloudflarestatus.com/api/v2/summary.json', region: 'global' },
  { slug: 'aws', name: 'Amazon AWS', category: 'Cloud', url: 'https://aws.amazon.com', feedSlug: 'aws', region: 'global' },
  { slug: 'github', name: 'GitHub', category: 'Cloud', url: 'https://github.com', feedSlug: 'github', statusPage: 'https://www.githubstatus.com/api/v2/summary.json', region: 'global' },
];

type CacheRow = {
  slug: string;
  name: string;
  category: string;
  url: string;
  region: string;
  level: OutageLevel;
  status: string;
  detail: string;
  /** Crowdsourced feed counts */
  reports1h: number;
  reports24h: number;
  /** ISP subscriber reports from /portal */
  localReports1h: number;
  localReports24h: number;
  checkedAt: number;
  history: { t: number; level: OutageLevel; reports1h: number }[];
};

export function listOutageServiceCatalog() {
  return SERVICE_SEEDS.map((s) => ({
    slug: s.slug,
    name: s.name,
    category: s.category,
    region: s.region || 'global',
  }));
}

export function resolveOutageServiceSlugs(slugs: unknown): string[] {
  if (!Array.isArray(slugs)) return [];
  const valid = new Set(SERVICE_SEEDS.map((s) => s.slug));
  const out: string[] = [];
  for (const raw of slugs) {
    const slug = String(raw || '').trim().toLowerCase();
    if (slug && valid.has(slug) && !out.includes(slug)) out.push(slug);
  }
  return out;
}

function localReportCounts(): Map<string, { h1: number; h24: number }> {
  initOutageReportTables();
  const map = new Map<string, { h1: number; h24: number }>();
  const rows = db
    .prepare(
      `SELECT s.service_slug AS slug,
              SUM(CASE WHEN r.created_at >= datetime('now', '-1 hour') THEN 1 ELSE 0 END) AS h1,
              SUM(CASE WHEN r.created_at >= datetime('now', '-24 hour') THEN 1 ELSE 0 END) AS h24
       FROM outage_subscriber_report_services s
       JOIN outage_subscriber_reports r ON r.id = s.report_id
       WHERE r.created_at >= datetime('now', '-24 hour')
       GROUP BY s.service_slug`
    )
    .all() as { slug: string; h1: number; h24: number }[];
  for (const row of rows) {
    map.set(row.slug, { h1: Number(row.h1) || 0, h24: Number(row.h24) || 0 });
  }
  return map;
}

function levelWithLocal(feedLevel: OutageLevel, local1h: number): OutageLevel {
  // Subscriber reports are high-signal for a small ISP — elevate sooner than public feed thresholds.
  if (local1h >= 3) return 'problems';
  if (local1h >= 1) {
    if (feedLevel === 'problems') return 'problems';
    return 'possible_problems';
  }
  return feedLevel;
}

export type RecordSubscriberOutageInput = {
  pppoeUserId: number;
  customerName?: string | null;
  contact?: string | null;
  accountNumber?: string | null;
  description?: string | null;
  jobOrderId?: number | null;
  serviceSlugs: string[];
};

export function recordSubscriberOutageReport(input: RecordSubscriberOutageInput) {
  initOutageReportTables();
  const slugs = resolveOutageServiceSlugs(input.serviceSlugs);
  if (!slugs.length) return null;
  const info = db
    .prepare(
      `INSERT INTO outage_subscriber_reports
       (pppoe_user_id, customer_name, contact, account_number, description, job_order_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.pppoeUserId,
      input.customerName || null,
      input.contact || null,
      input.accountNumber || null,
      input.description || null,
      input.jobOrderId ?? null
    );
  const reportId = Number(info.lastInsertRowid);
  const ins = db.prepare(
    `INSERT INTO outage_subscriber_report_services (report_id, service_slug) VALUES (?, ?)`
  );
  for (const slug of slugs) ins.run(reportId, slug);
  return {
    id: reportId,
    serviceSlugs: slugs,
    serviceNames: slugs.map((slug) => SERVICE_SEEDS.find((s) => s.slug === slug)?.name || slug),
  };
}

export function listRecentSubscriberOutageReports(limit = 50) {
  initOutageReportTables();
  const reports = db
    .prepare(
      `SELECT id, pppoe_user_id, customer_name, contact, account_number, description, job_order_id, created_at
       FROM outage_subscriber_reports
       ORDER BY id DESC LIMIT ?`
    )
    .all(Math.min(200, Math.max(1, limit))) as any[];
  const svcStmt = db.prepare(
    `SELECT service_slug FROM outage_subscriber_report_services WHERE report_id = ? ORDER BY service_slug`
  );
  return reports.map((r) => {
    const slugs = (svcStmt.all(r.id) as { service_slug: string }[]).map((x) => x.service_slug);
    return {
      id: r.id,
      pppoeUserId: r.pppoe_user_id,
      customerName: r.customer_name,
      contact: r.contact,
      accountNumber: r.account_number,
      description: r.description,
      jobOrderId: r.job_order_id,
      createdAt: r.created_at,
      services: slugs.map((slug) => ({
        slug,
        name: SERVICE_SEEDS.find((s) => s.slug === slug)?.name || slug,
        category: SERVICE_SEEDS.find((s) => s.slug === slug)?.category || '',
      })),
    };
  });
}

const cache = new Map<string, CacheRow>();
let lastSweepAt: number | null = null;
let sweeping = false;
let timer: ReturnType<typeof setTimeout> | null = null;

const UA = 'MT-Billing-OutageMonitor/1.0';
const FEED_TIMEOUT_MS = 10_000;

function mapDownStatus(raw: string | undefined): 'up' | 'degraded' | 'down' {
  const s = String(raw || '').toLowerCase();
  if (!s || s === 'up' || s === 'ok' || s === 'operational' || s === 'none') return 'up';
  if (s.includes('major') || s.includes('outage') || s === 'down' || s === 'critical') return 'down';
  if (s.includes('partial') || s.includes('minor') || s.includes('degraded') || s.includes('slow')) return 'degraded';
  return 'up';
}

function toLevel(status: 'up' | 'degraded' | 'down', reports1h: number): OutageLevel {
  if (status === 'down' || reports1h >= 80) return 'problems';
  if (status === 'degraded' || reports1h >= 15) return 'possible_problems';
  if (status === 'up') return 'no_problems';
  return 'unknown';
}

async function fetchJson(url: string): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': UA },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function probeService(seed: ServiceSeed): Promise<Omit<CacheRow, 'history'>> {
  let status: 'up' | 'degraded' | 'down' = 'up';
  let detail = 'Operational';
  let reports1h = 0;
  let reports24h = 0;

  const crowd = await fetchJson(`https://isitdownstatus.com/api/v1/status/${encodeURIComponent(seed.feedSlug)}`);
  if (crowd?.ok && crowd?.data) {
    const d = crowd.data;
    const fromReports = mapDownStatus(d.status);
    const official = String(d.official_indicator || 'none').toLowerCase();
    const fromOfficial =
      official === 'none' || !official
        ? null
        : official.includes('major') || official === 'critical'
          ? ('down' as const)
          : official.includes('minor') || official.includes('partial')
            ? ('degraded' as const)
            : ('up' as const);
    status = fromOfficial ? (fromOfficial === 'down' || fromReports === 'down' ? 'down' : fromOfficial === 'degraded' || fromReports === 'degraded' ? 'degraded' : 'up') : fromReports;
    reports1h = Number(d.report_count_1h) || 0;
    reports24h = Number(d.report_count_24h) || 0;
    const parts = ['Crowdsourced'];
    if (official && official !== 'none') parts.push(`official: ${official}`);
    if (reports1h > 0) parts.push(`${reports1h} reports/1h`);
    if (reports24h > 0) parts.push(`${reports24h} reports/24h`);
    detail = parts.join(' · ');
  } else if (seed.statusPage) {
    const page = await fetchJson(seed.statusPage);
    if (page?.status?.indicator) {
      const ind = String(page.status.indicator).toLowerCase();
      status = ind.includes('major') || ind === 'critical' ? 'down' : ind.includes('minor') || ind.includes('partial') ? 'degraded' : 'up';
      detail = page.status.description || `Statuspage: ${page.status.indicator}`;
    } else {
      status = 'up';
      detail = 'Feed unavailable — assuming operational';
    }
  } else {
    detail = 'Feed unavailable — assuming operational';
  }

  const level = toLevel(status, reports1h);
  return {
    slug: seed.slug,
    name: seed.name,
    category: seed.category,
    url: seed.url,
    region: seed.region || 'global',
    level,
    status,
    detail,
    reports1h,
    reports24h,
    localReports1h: 0,
    localReports24h: 0,
    checkedAt: Date.now(),
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

export async function runOutageSweep() {
  if (sweeping) return { skipped: true };
  sweeping = true;
  try {
    const rows = await mapPool(SERVICE_SEEDS, 6, async (seed) => {
      const next = await probeService(seed);
      const prev = cache.get(seed.slug);
      const history = [...(prev?.history || []), { t: next.checkedAt, level: next.level, reports1h: next.reports1h }].slice(-48);
      const row: CacheRow = { ...next, history };
      cache.set(seed.slug, row);
      return row;
    });
    lastSweepAt = Date.now();
    return { ok: true, checked: rows.length, at: lastSweepAt };
  } finally {
    sweeping = false;
  }
}

export function listOutageOverview() {
  initOutageReportTables();
  const local = localReportCounts();
  const services = SERVICE_SEEDS.map((s) => {
    const c = cache.get(s.slug);
    const base =
      c ||
      ({
        slug: s.slug,
        name: s.name,
        category: s.category,
        url: s.url,
        region: s.region || 'global',
        level: 'unknown' as OutageLevel,
        status: 'pending',
        detail: 'Waiting for first sweep…',
        reports1h: 0,
        reports24h: 0,
        localReports1h: 0,
        localReports24h: 0,
        checkedAt: 0,
        history: [],
      } satisfies CacheRow);
    const loc = local.get(s.slug) || { h1: 0, h24: 0 };
    const localReports1h = loc.h1;
    const localReports24h = loc.h24;
    const level =
      base.level === 'unknown' && !localReports1h
        ? base.level
        : levelWithLocal(base.level === 'unknown' ? 'no_problems' : base.level, localReports1h);
    let detail = base.detail;
    if (localReports1h > 0) {
      detail = `${detail} · ${localReports1h} subscriber report${localReports1h === 1 ? '' : 's'}/1h`;
    }
    return {
      ...base,
      localReports1h,
      localReports24h,
      level,
      detail,
    };
  });

  const mostReported = [...services]
    .filter((s) => s.reports1h > 0 || s.localReports1h > 0 || (s.level !== 'no_problems' && s.level !== 'unknown'))
    .sort(
      (a, b) =>
        b.localReports1h - a.localReports1h ||
        b.reports1h - a.reports1h ||
        b.localReports24h - a.localReports24h ||
        b.reports24h - a.reports24h
    )
    .slice(0, 8);

  const localReportTotal24h = [...local.values()].reduce((n, v) => n + v.h24, 0);

  const summary = {
    total: services.length,
    noProblems: services.filter((s) => s.level === 'no_problems').length,
    possibleProblems: services.filter((s) => s.level === 'possible_problems').length,
    problems: services.filter((s) => s.level === 'problems').length,
    unknown: services.filter((s) => s.level === 'unknown').length,
    localReports24h: localReportTotal24h,
    lastSweepAt,
    sweeping,
  };

  return {
    services,
    mostReported,
    summary,
    categories: [...new Set(SERVICE_SEEDS.map((s) => s.category))],
    subscriberReports: listRecentSubscriberOutageReports(40),
  };
}

export function getOutageService(slug: string) {
  const seed = SERVICE_SEEDS.find((s) => s.slug === slug);
  if (!seed) return null;
  const overview = listOutageOverview();
  return overview.services.find((s) => s.slug === slug) || null;
}

export function startOutageMonitor(intervalMs = 3 * 60_000) {
  const loop = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void runOutageSweep()
        .catch(() => undefined)
        .finally(() => loop());
    }, intervalMs);
    if (timer && typeof (timer as any).unref === 'function') (timer as any).unref();
  };
  setTimeout(() => {
    void runOutageSweep()
      .catch(() => undefined)
      .finally(() => loop());
  }, 6_000);
}
