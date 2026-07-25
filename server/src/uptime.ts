import dns from 'dns';
import { performance } from 'perf_hooks';
import type { RouterConn } from './mikrotik.js';
import { probeHttpUrlFromRouter } from './mikrotik.js';

/**
 * Uptime monitor with three scopes:
 *  - global: DownStatus crowdsourced / official world status
 *  - regional: Asia / SEA PoPs from official Statuspage summaries (+ global feed)
 *  - local: HTTPS reachability probes from this panel host (Philippines-focused)
 */

try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  /* Node < 17 */
}

export type UptimeScope = 'global' | 'regional' | 'local';

export interface MonitorSample {
  t: number;
  up: boolean;
  ms: number | null;
}

export interface MonitorState {
  id: string;
  name: string;
  category: string;
  url: string;
  status: 'up' | 'down' | 'degraded' | 'pending';
  latencyMs: number | null;
  code: number;
  lastChecked: number | null;
  uptimePct: number;
  avgMs: number | null;
  history: MonitorSample[];
  lastError?: string | null;
  detail?: string;
  source?: 'global' | 'regional' | 'local' | 'unknown';
  reportCount1h?: number;
  reportCount24h?: number;
  officialIndicator?: string | null;
  regionStatus?: 'up' | 'down' | 'degraded' | 'unknown';
  regionDetail?: string;
  scope: UptimeScope;
}

type StatusLevel = 'up' | 'down' | 'degraded';

interface FeedTarget {
  id: string;
  name: string;
  category: string;
  slug: string;
  url: string;
  statusPage?: string;
}

interface LocalTarget {
  id: string;
  name: string;
  category: string;
  url: string;
}

const FEED_TARGETS: FeedTarget[] = [
  { id: 'google', name: 'Google', category: 'Web & Search', slug: 'google', url: 'https://www.google.com' },
  { id: 'bing', name: 'Bing', category: 'Web & Search', slug: 'bing', url: 'https://www.bing.com' },
  { id: 'wikipedia', name: 'Wikipedia', category: 'Web & Search', slug: 'wikipedia', url: 'https://www.wikipedia.org' },
  { id: 'facebook', name: 'Facebook', category: 'Social', slug: 'facebook', url: 'https://www.facebook.com' },
  { id: 'instagram', name: 'Instagram', category: 'Social', slug: 'instagram', url: 'https://www.instagram.com' },
  { id: 'tiktok', name: 'TikTok', category: 'Social', slug: 'tiktok', url: 'https://www.tiktok.com' },
  { id: 'x', name: 'X (Twitter)', category: 'Social', slug: 'twitter', url: 'https://x.com' },
  { id: 'reddit', name: 'Reddit', category: 'Social', slug: 'reddit', url: 'https://www.reddit.com' },
  { id: 'youtube', name: 'YouTube', category: 'Video & Streaming', slug: 'youtube', url: 'https://www.youtube.com' },
  { id: 'netflix', name: 'Netflix', category: 'Video & Streaming', slug: 'netflix', url: 'https://www.netflix.com' },
  { id: 'twitch', name: 'Twitch', category: 'Video & Streaming', slug: 'twitch', url: 'https://www.twitch.tv' },
  { id: 'spotify', name: 'Spotify', category: 'Video & Streaming', slug: 'spotify', url: 'https://www.spotify.com' },
  { id: 'steam', name: 'Steam', category: 'Games', slug: 'steam', url: 'https://store.steampowered.com' },
  { id: 'roblox', name: 'Roblox', category: 'Games', slug: 'roblox', url: 'https://www.roblox.com' },
  { id: 'riot', name: 'League of Legends', category: 'Games', slug: 'league-of-legends', url: 'https://www.leagueoflegends.com' },
  { id: 'valorant', name: 'Valorant', category: 'Games', slug: 'valorant', url: 'https://playvalorant.com' },
  { id: 'epic', name: 'Fortnite (Epic)', category: 'Games', slug: 'fortnite', url: 'https://www.epicgames.com' },
  { id: 'mlbb', name: 'Mobile Legends', category: 'Games', slug: 'mobile-legends', url: 'https://www.mobilelegends.com' },
  { id: 'minecraft', name: 'Minecraft', category: 'Games', slug: 'minecraft', url: 'https://www.minecraft.net' },
  {
    id: 'discord',
    name: 'Discord',
    category: 'Communication',
    slug: 'discord',
    url: 'https://discord.com',
    statusPage: 'https://discordstatus.com/api/v2/summary.json',
  },
  { id: 'whatsapp', name: 'WhatsApp', category: 'Communication', slug: 'whatsapp', url: 'https://www.whatsapp.com' },
  { id: 'zoom', name: 'Zoom', category: 'Communication', slug: 'zoom', url: 'https://zoom.us' },
  { id: 'gmail', name: 'Gmail', category: 'Communication', slug: 'gmail', url: 'https://mail.google.com' },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    category: 'Infrastructure & DNS',
    slug: 'cloudflare',
    url: 'https://www.cloudflare.com',
    statusPage: 'https://www.cloudflarestatus.com/api/v2/summary.json',
  },
  {
    id: 'aws',
    name: 'Amazon AWS',
    category: 'Infrastructure & DNS',
    slug: 'aws',
    url: 'https://health.aws.amazon.com/health/status',
  },
  {
    id: 'github',
    name: 'GitHub',
    category: 'Developer & Shopping',
    slug: 'github',
    url: 'https://github.com',
    statusPage: 'https://www.githubstatus.com/api/v2/summary.json',
  },
  { id: 'amazon', name: 'Amazon', category: 'Developer & Shopping', slug: 'amazon', url: 'https://www.amazon.com' },
];

/** Local (Philippines) reachability probes from the panel host. */
const LOCAL_TARGETS: LocalTarget[] = [
  { id: 'ph-google', name: 'Google', category: 'Web & Search', url: 'https://www.google.com/generate_204' },
  { id: 'ph-facebook', name: 'Facebook', category: 'Social', url: 'https://www.facebook.com' },
  { id: 'ph-youtube', name: 'YouTube', category: 'Video & Streaming', url: 'https://www.youtube.com' },
  { id: 'ph-tiktok', name: 'TikTok', category: 'Social', url: 'https://www.tiktok.com' },
  { id: 'ph-netflix', name: 'Netflix', category: 'Video & Streaming', url: 'https://www.netflix.com' },
  { id: 'ph-discord', name: 'Discord', category: 'Communication', url: 'https://discord.com' },
  { id: 'ph-steam', name: 'Steam', category: 'Games', url: 'https://store.steampowered.com' },
  { id: 'ph-mlbb', name: 'Mobile Legends', category: 'Games', url: 'https://www.mobilelegends.com' },
  { id: 'ph-cloudflare-dns', name: 'Cloudflare DNS (1.1.1.1)', category: 'Infrastructure & DNS', url: 'https://1.1.1.1' },
  { id: 'ph-google-dns', name: 'Google DNS', category: 'Infrastructure & DNS', url: 'https://dns.google/resolve?name=google.com&type=A' },
  { id: 'ph-gov', name: 'GOV.PH', category: 'Philippines', url: 'https://www.gov.ph' },
  { id: 'ph-dict', name: 'DICT', category: 'Philippines', url: 'https://dict.gov.ph' },
  { id: 'ph-globe', name: 'Globe', category: 'Philippines', url: 'https://www.globe.com.ph' },
  { id: 'ph-smart', name: 'Smart', category: 'Philippines', url: 'https://smart.com.ph' },
  { id: 'ph-pldt', name: 'PLDT', category: 'Philippines', url: 'https://pldt.com' },
  { id: 'ph-gcash', name: 'GCash', category: 'Philippines', url: 'https://www.gcash.com' },
  { id: 'ph-maya', name: 'Maya', category: 'Philippines', url: 'https://www.maya.ph' },
  { id: 'ph-shopee', name: 'Shopee PH', category: 'Philippines', url: 'https://shopee.ph' },
  { id: 'ph-lazada', name: 'Lazada PH', category: 'Philippines', url: 'https://www.lazada.com.ph' },
  { id: 'ph-abs', name: 'ABS-CBN', category: 'Philippines', url: 'https://www.abs-cbn.com' },
  { id: 'ph-gma', name: 'GMA Network', category: 'Philippines', url: 'https://www.gmanetwork.com' },
];

const ASIA_HINTS = [
  'southeast asia',
  'south-east asia',
  'southeast-asia',
  'asia',
  'asia pacific',
  'asia-pacific',
  'apac',
  'ap-southeast',
  'ap-east',
  'ap-northeast',
  'ap-south',
  'singapore',
  'manila',
  'cebu',
  'philippines',
  'jakarta',
  'indonesia',
  'bangkok',
  'thailand',
  'kuala lumpur',
  'malaysia',
  'ho chi minh',
  'hanoi',
  'vietnam',
  'tokyo',
  'osaka',
  'japan',
  'seoul',
  'korea',
  'hong kong',
  'taipei',
  'taiwan',
  'mumbai',
  'india',
  'sydney',
  'australia',
  'asia pacific (singapore)',
  'asia pacific (jakarta)',
  'asia pacific (tokyo)',
  'asia pacific (seoul)',
  'asia pacific (hong kong)',
  'asia pacific (mumbai)',
  'asia pacific (osaka)',
  'asia pacific (sydney)',
];

const HISTORY_CAP = 60;
const CONCURRENCY = 6;
const TIMEOUT_MS = 10000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const SCOPES: UptimeScope[] = ['global', 'regional', 'local'];
const stateByKey = new Map<string, Map<string, MonitorState>>();
let activeScope: UptimeScope = 'global';
let activeRouterId: number | null = null;

function stateKey(scope: UptimeScope, routerId?: number | null): string {
  if (scope !== 'local') return scope;
  return routerId && routerId > 0 ? `local:r${routerId}` : 'local:panel';
}

function getScopeMap(scope: UptimeScope, routerId?: number | null): Map<string, MonitorState> {
  const key = stateKey(scope, routerId);
  let map = stateByKey.get(key);
  if (!map) {
    map = new Map<string, MonitorState>();
    if (scope === 'local') {
      for (const t of LOCAL_TARGETS) map.set(t.id, emptyMonitor(t.id, t.name, t.category, t.url, scope));
    } else {
      for (const t of FEED_TARGETS) map.set(t.id, emptyMonitor(t.id, t.name, t.category, t.url, scope));
    }
    stateByKey.set(key, map);
  }
  return map;
}

function emptyMonitor(
  id: string,
  name: string,
  category: string,
  url: string,
  scope: UptimeScope
): MonitorState {
  return {
    id,
    name,
    category,
    url,
    scope,
    status: 'pending',
    latencyMs: null,
    code: 0,
    lastChecked: null,
    uptimePct: 0,
    avgMs: null,
    history: [],
    lastError: null,
    detail: scope === 'local' ? 'Waiting for local probe…' : 'Waiting for status feed…',
    source: 'unknown',
    reportCount1h: 0,
    reportCount24h: 0,
    officialIndicator: null,
    regionStatus: 'unknown',
    regionDetail: '',
  };
}

function initScope(scope: UptimeScope) {
  getScopeMap(scope, null);
  getScopeMap(scope, activeRouterId);
}

for (const s of SCOPES) initScope(s);

export function getUptimeScopes() {
  return [
    {
      id: 'global' as const,
      label: 'Global',
      description: 'Worldwide outage feeds (DownStatus / official indicators)',
    },
    {
      id: 'regional' as const,
      label: 'Regional (Asia)',
      description: 'Asia / SEA PoPs from official status pages, plus global feed',
    },
    {
      id: 'local' as const,
      label: 'Local (Philippines)',
      description: 'HTTPS reachability from the active MikroTik router (or panel host if none selected)',
    },
  ];
}

export function getActiveScope(): UptimeScope {
  return activeScope;
}

export function setActiveScope(scope: string): UptimeScope {
  const next = (SCOPES.includes(scope as UptimeScope) ? scope : 'global') as UptimeScope;
  activeScope = next;
  return activeScope;
}

export function setActiveRouterId(routerId: number | null | undefined) {
  const id = routerId != null && Number(routerId) > 0 ? Number(routerId) : null;
  if (id !== activeRouterId) {
    activeRouterId = id;
    if (activeScope === 'local') getScopeMap('local', id);
  }
  return activeRouterId;
}

export function getActiveRouterId() {
  return activeRouterId;
}

function worse(a: StatusLevel, b: StatusLevel): StatusLevel {
  const rank = { up: 0, degraded: 1, down: 2 };
  return rank[b] > rank[a] ? b : a;
}

function mapDownStatus(s: string | undefined): StatusLevel {
  const v = (s || '').toLowerCase();
  if (v === 'down' || v === 'major_outage' || v === 'critical') return 'down';
  if (v === 'degraded' || v === 'partial_outage' || v === 'minor' || v === 'major') return 'degraded';
  return 'up';
}

function mapOfficialIndicator(ind: string | null | undefined): StatusLevel | null {
  if (ind == null || ind === '' || ind === 'none') return null;
  const v = ind.toLowerCase();
  if (v === 'critical' || v === 'major') return 'down';
  if (v === 'minor' || v === 'maintenance') return 'degraded';
  return null;
}

function mapComponentStatus(s: string | undefined): StatusLevel {
  const v = (s || '').toLowerCase();
  if (v === 'major_outage') return 'down';
  if (v === 'partial_outage' || v === 'degraded_performance' || v === 'under_maintenance') return 'degraded';
  return 'up';
}

function isAsiaName(name: string): boolean {
  const n = name.toLowerCase();
  return ASIA_HINTS.some((h) => n.includes(h));
}

async function fetchJson(url: string, timeoutMs = TIMEOUT_MS): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'MT-Billing-UptimeMonitor/3.0',
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchGlobalStatus(slug: string) {
  const data = await fetchJson(`https://isitdownstatus.com/api/v1/status/${encodeURIComponent(slug)}`);
  if (!data?.ok || !data?.data) {
    return {
      status: 'up' as StatusLevel,
      officialIndicator: null as string | null,
      reportCount1h: 0,
      reportCount24h: 0,
      detail: 'Global status unavailable',
      ok: false,
    };
  }
  const d = data.data;
  const fromReports = mapDownStatus(d.status);
  const fromOfficial = mapOfficialIndicator(d.official_indicator);
  const status = fromOfficial ? worse(fromReports, fromOfficial) : fromReports;
  const parts: string[] = ['Global'];
  if (d.official_indicator && d.official_indicator !== 'none') parts.push(`official: ${d.official_indicator}`);
  if (Number(d.report_count_1h) > 0) parts.push(`${d.report_count_1h} reports/1h`);
  if (Number(d.report_count_24h) > 0) parts.push(`${d.report_count_24h} reports/24h`);
  return {
    status,
    officialIndicator: (d.official_indicator ?? null) as string | null,
    reportCount1h: Number(d.report_count_1h) || 0,
    reportCount24h: Number(d.report_count_24h) || 0,
    detail: parts.join(' · '),
    ok: true,
  };
}

async function fetchAsiaRegionalStatus(statusPageUrl: string) {
  if (!statusPageUrl.includes('/api/v2/summary.json')) {
    return { status: 'up' as StatusLevel, detail: '', ok: false };
  }
  const data = await fetchJson(statusPageUrl);
  if (!data?.components) return { status: 'up' as StatusLevel, detail: '', ok: false };

  const asia = (data.components as any[]).filter(
    (c) => c && !c.group && typeof c.name === 'string' && isAsiaName(c.name)
  );
  if (!asia.length) {
    return { status: 'up' as StatusLevel, detail: 'No Asia components listed', ok: true };
  }

  let worst: StatusLevel = 'up';
  const issues: string[] = [];
  for (const c of asia) {
    const st = mapComponentStatus(c.status);
    worst = worse(worst, st);
    if (st !== 'up') issues.push(`${c.name}: ${c.status}`);
  }
  return {
    status: worst,
    detail:
      worst === 'up'
        ? `Asia operational (${asia.length} checked)`
        : `Asia: ${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}`,
    ok: true,
  };
}

async function checkFeedTarget(target: FeedTarget, scope: 'global' | 'regional') {
  const global = await fetchGlobalStatus(target.slug);
  let regionStatus: MonitorState['regionStatus'] = 'unknown';
  let regionDetail = '';
  let combined: StatusLevel = global.ok ? global.status : 'up';
  let source: MonitorState['source'] = global.ok ? 'global' : 'unknown';
  const details: string[] = [];

  if (global.ok) details.push(global.detail);
  else details.push('Global feed unreachable');

  if (scope === 'regional' && target.statusPage) {
    const regional = await fetchAsiaRegionalStatus(target.statusPage);
    if (regional.ok) {
      regionStatus = regional.status;
      regionDetail = regional.detail;
      if (regional.detail) details.push(regional.detail);
      combined = worse(combined, regional.status);
      if (regional.status !== 'up') source = 'regional';
    }
  }

  if (!global.ok && regionStatus === 'unknown') {
    return {
      status: 'degraded' as StatusLevel,
      source: 'unknown' as const,
      detail: 'Could not reach status feeds',
      reportCount1h: 0,
      reportCount24h: 0,
      officialIndicator: null as string | null,
      regionStatus,
      regionDetail,
      up: true,
      latencyMs: null as number | null,
      code: 0,
      lastError: 'status feed unreachable',
    };
  }

  return {
    status: combined,
    source,
    detail: details.filter(Boolean).join(' · '),
    reportCount1h: global.reportCount1h,
    reportCount24h: global.reportCount24h,
    officialIndicator: global.officialIndicator,
    regionStatus,
    regionDetail,
    up: combined !== 'down',
    latencyMs: null as number | null,
    code: 0,
    lastError: combined === 'up' ? null : details.join(' · '),
  };
}

async function probeLocal(url: string): Promise<{
  up: boolean;
  status: StatusLevel;
  ms: number | null;
  code: number;
  error: string | null;
}> {
  // Local = path reachability from this host. Any HTTP response means the route works
  // (WAFs often return 403/405 from VPS IPs while the service is fine for subscribers).
  const tryOnce = async (method: 'HEAD' | 'GET') => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const start = performance.now();
    try {
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        signal: controller.signal,
        headers: { 'User-Agent': UA, Accept: '*/*', 'Cache-Control': 'no-cache' },
      });
      const ms = Math.round(performance.now() - start);
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      return { ok: true as const, ms, code: res.status };
    } catch (e: any) {
      const msg = e?.name === 'AbortError' ? 'timeout' : String(e?.message || e || 'network error');
      return { ok: false as const, error: msg };
    } finally {
      clearTimeout(timer);
    }
  };

  let result = await tryOnce('HEAD');
  if (!result.ok) result = await tryOnce('GET');
  else if (result.code >= 500) {
    const get = await tryOnce('GET');
    if (get.ok) result = get;
  }

  if (!result.ok) {
    return { up: false, status: 'down', ms: null, code: 0, error: result.error };
  }
  if (result.code >= 500) {
    return { up: false, status: 'degraded', ms: result.ms, code: result.code, error: `HTTP ${result.code}` };
  }
  return { up: true, status: 'up', ms: result.ms, code: result.code, error: null };
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

function applyResult(
  s: MonitorState,
  r: {
    status: StatusLevel;
    up: boolean;
    latencyMs: number | null;
    code: number;
    lastError: string | null;
    detail?: string;
    source?: MonitorState['source'];
    reportCount1h?: number;
    reportCount24h?: number;
    officialIndicator?: string | null;
    regionStatus?: MonitorState['regionStatus'];
    regionDetail?: string;
  }
) {
  s.status = r.status;
  s.latencyMs = r.latencyMs;
  s.code = r.code;
  s.lastChecked = Date.now();
  s.lastError = r.lastError;
  if (r.detail != null) s.detail = r.detail;
  if (r.source != null) s.source = r.source;
  if (r.reportCount1h != null) s.reportCount1h = r.reportCount1h;
  if (r.reportCount24h != null) s.reportCount24h = r.reportCount24h;
  if (r.officialIndicator !== undefined) s.officialIndicator = r.officialIndicator;
  if (r.regionStatus != null) s.regionStatus = r.regionStatus;
  if (r.regionDetail != null) s.regionDetail = r.regionDetail;
  s.history.push({ t: s.lastChecked, up: r.up, ms: r.latencyMs });
  if (s.history.length > HISTORY_CAP) s.history.shift();
  const ups = s.history.filter((h) => h.up).length;
  s.uptimePct = s.history.length ? Number(((ups / s.history.length) * 100).toFixed(1)) : 0;
  const lat = s.history.filter((h) => h.ms != null).map((h) => h.ms as number);
  s.avgMs = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null;
}

const runningByKey = new Map<string, Promise<void>>();

export async function runUptimeChecks(scope?: UptimeScope, routerConn?: RouterConn | null, routerId?: number | null) {
  const sc = scope || activeScope;
  const rid = sc === 'local' ? (routerId ?? activeRouterId) : null;
  const key = stateKey(sc, rid);
  if (runningByKey.has(key)) return runningByKey.get(key)!;

  const job = (async () => {
    const map = getScopeMap(sc, rid);
    if (sc === 'local') {
      const viaRouter = !!(routerConn?.host && routerConn?.api_user);
      await mapPool(LOCAL_TARGETS, CONCURRENCY, async (t) => {
        const r = viaRouter
          ? await probeHttpUrlFromRouter(routerConn!, t.url)
          : await probeLocal(t.url);
        applyResult(map.get(t.id)!, {
          status: r.status,
          up: r.up,
          latencyMs: r.ms,
          code: r.code,
          lastError: r.error,
          detail: r.error || (r.code ? `Reachable via ${viaRouter ? 'router' : 'panel'} · HTTP ${r.code}` : `Reachable via ${viaRouter ? 'router' : 'panel'}`),
          source: 'local',
        });
      });
      return;
    }

    await mapPool(FEED_TARGETS, CONCURRENCY, async (t) => {
      const r = await checkFeedTarget(t, sc);
      applyResult(map.get(t.id)!, {
        status: r.status,
        up: r.up,
        latencyMs: r.latencyMs,
        code: r.code,
        lastError: r.lastError,
        detail: r.detail,
        source: r.source,
        reportCount1h: r.reportCount1h,
        reportCount24h: r.reportCount24h,
        officialIndicator: r.officialIndicator,
        regionStatus: r.regionStatus,
        regionDetail: r.regionDetail,
      });
    });
  })().finally(() => {
    runningByKey.delete(key);
  });

  runningByKey.set(key, job);
  return job;
}

export function getUptime(scope?: UptimeScope, routerId?: number | null): MonitorState[] {
  const sc = scope || activeScope;
  const rid = sc === 'local' ? (routerId ?? activeRouterId) : null;
  return Array.from(getScopeMap(sc, rid).values());
}

export function getUptimeSummary(scope?: UptimeScope, routerId?: number | null) {
  const sc = scope || activeScope;
  const rid = sc === 'local' ? (routerId ?? activeRouterId) : null;
  const all = getUptime(sc, rid);
  const checked = all.filter((m) => m.status !== 'pending');
  const up = checked.filter((m) => m.status === 'up').length;
  const degraded = checked.filter((m) => m.status === 'degraded').length;
  const down = checked.filter((m) => m.status === 'down').length;
  const lat = checked.filter((m) => m.latencyMs != null).map((m) => m.latencyMs as number);
  const avgMs = lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null;
  const reports1h = checked.reduce((s, m) => s + (m.reportCount1h || 0), 0);
  return {
    total: all.length,
    up,
    degraded,
    down,
    avgMs,
    reports1h,
    scope: sc,
    mode: sc,
    routerId: rid,
    probeSource: sc === 'local' ? (rid ? 'router' : 'panel') : sc,
    lastRun: Math.max(0, ...all.map((m) => m.lastChecked || 0)) || null,
  };
}

let started = false;
export function startUptime(intervalMs = 90000) {
  if (started) return;
  started = true;
  // Warm global feed on boot; other scopes run on first view / Check now.
  runUptimeChecks('global').catch((err) => console.error('[uptime] initial run failed', err));
  setInterval(() => {
    runUptimeChecks(activeScope).catch((err) => console.error('[uptime] scheduled run failed', err));
  }, intervalMs);
}
