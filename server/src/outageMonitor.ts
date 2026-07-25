/**
 * Outage Monitor — Downdetector-style public-internet status directory.
 * Crowdsourced feeds (isitdownstatus.com) + official status pages.
 * Separate from Status Hub (router WAN probes).
 */
export type OutageLevel = 'no_problems' | 'possible_problems' | 'problems' | 'unknown';

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
  reports1h: number;
  reports24h: number;
  checkedAt: number;
  history: { t: number; level: OutageLevel; reports1h: number }[];
};

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
  const services = SERVICE_SEEDS.map((s) => {
    const c = cache.get(s.slug);
    return (
      c || {
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
        checkedAt: 0,
        history: [],
      }
    );
  });

  const mostReported = [...services]
    .filter((s) => s.reports1h > 0 || s.level !== 'no_problems')
    .sort((a, b) => b.reports1h - a.reports1h || b.reports24h - a.reports24h)
    .slice(0, 8);

  const summary = {
    total: services.length,
    noProblems: services.filter((s) => s.level === 'no_problems').length,
    possibleProblems: services.filter((s) => s.level === 'possible_problems').length,
    problems: services.filter((s) => s.level === 'problems').length,
    unknown: services.filter((s) => s.level === 'unknown').length,
    lastSweepAt,
    sweeping,
  };

  return { services, mostReported, summary, categories: [...new Set(SERVICE_SEEDS.map((s) => s.category))] };
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
