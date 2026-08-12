/**
 * RouterOS `rate-limit` strings, rendered for humans.
 *
 * A PPP profile's rate-limit is not a single speed — it is a whole burst spec:
 *
 *   rx-rate/tx-rate  burst-rate  burst-threshold  burst-time  priority  limit-at
 *   10M/10M          30M/30M     11250K/11250K    32/32       8         1875K/1875K
 *
 * Dumping that at a subscriber is unreadable, and worse, the eye lands on the
 * first pair and reads it as "the plan speed" — which is the sustained rate, not
 * the burst the plan is usually sold on. Parse it and label both.
 *
 * Direction follows the convention already used for queue rates elsewhere in
 * this codebase (see fetchPppActiveTraffic): in `a/b`, `a` is upload and `b` is
 * download.
 */

export type ParsedRateLimit = {
  uploadBps: number;
  downloadBps: number;
  burstUploadBps: number;
  burstDownloadBps: number;
};

/** "30M" -> 30000000. RouterOS rates are decimal, not binary. */
function parseRosRate(raw: string): number {
  const m = String(raw || '')
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*([kKmMgG]?)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const mult = { k: 1e3, m: 1e6, g: 1e9 }[m[2].toLowerCase() as 'k' | 'm' | 'g'] ?? 1;
  return Math.round(n * mult);
}

function parsePair(field?: string): { up: number; down: number } {
  if (!field) return { up: 0, down: 0 };
  const [a, b] = field.split('/');
  const up = parseRosRate(a);
  // A bare "10M" means the same limit both ways.
  const down = b == null ? up : parseRosRate(b);
  return { up, down };
}

export function parseRateLimit(raw?: string | null): ParsedRateLimit | null {
  const text = String(raw || '').trim();
  if (!text) return null;
  const fields = text.split(/\s+/);
  const base = parsePair(fields[0]);
  if (!base.up && !base.down) return null;
  const burst = parsePair(fields[1]);
  return {
    uploadBps: base.up,
    downloadBps: base.down,
    burstUploadBps: burst.up,
    burstDownloadBps: burst.down,
  };
}

/** 30000000 -> "30 Mbps"; keeps one decimal only when it carries information. */
export function formatBps(bps: number): string {
  const b = Number(bps) || 0;
  if (b <= 0) return '—';
  if (b >= 1e9) {
    const g = b / 1e9;
    return `${g % 1 === 0 ? g : g.toFixed(1)} Gbps`;
  }
  if (b >= 1e6) {
    const m = b / 1e6;
    return `${m % 1 === 0 ? m : m.toFixed(1)} Mbps`;
  }
  return `${Math.round(b / 1e3)} kbps`;
}

/**
 * Short one-line summary for a plan card.
 *
 * Symmetric plans collapse to a single figure rather than repeating it —
 * "30 Mbps" reads better than "30 Mbps down / 30 Mbps up" when both are equal.
 * Returns the raw string unchanged if it does not parse, so an unusual profile
 * still shows something rather than nothing.
 */
export function formatRateLimit(raw?: string | null): string {
  const p = parseRateLimit(raw);
  if (!p) return String(raw || '').trim();
  const symmetric = p.uploadBps === p.downloadBps;
  const main = symmetric
    ? formatBps(p.downloadBps)
    : `${formatBps(p.downloadBps)} down · ${formatBps(p.uploadBps)} up`;
  const burst = Math.max(p.burstDownloadBps, p.burstUploadBps);
  // Only worth mentioning when the burst actually exceeds the sustained rate.
  if (burst > Math.max(p.downloadBps, p.uploadBps)) {
    return `${main} · bursts to ${formatBps(burst)}`;
  }
  return main;
}
