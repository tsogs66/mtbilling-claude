/**
 * Live interface traffic source for the dashboard graphs.
 *
 * Produces smooth, realistic upload/download rates (bits per second) per
 * interface using a mean-reverting random walk with occasional spikes. When a
 * real RouterOS device is configured this is where `/interface/monitor-traffic`
 * would feed in; without hardware the simulated feed keeps the dashboard live.
 */

interface IfaceProfile {
  name: string;
  baseUp: number;
  baseDown: number;
  amp: number;
}

// Interfaces mirror a typical ISP edge (names match the reference dashboard).
const PROFILES: IfaceProfile[] = [
  { name: 'ISP-PFSENSE-MAIN-ETH0', baseUp: 4_000_000, baseDown: 30_000_000, amp: 22_000_000 },
  { name: 'ISP-PFSENSE-MAIN-ETH1', baseUp: 2_500_000, baseDown: 37_000_000, amp: 20_000_000 },
  { name: 'LAN-ACCESS', baseUp: 1_500_000, baseDown: 45_000_000, amp: 18_000_000 },
  { name: 'OLT-PPPoE1', baseUp: 5_000_000, baseDown: 12_000_000, amp: 40_000_000 },
  { name: 'OLT-PPPoE2', baseUp: 300_000, baseDown: 1_300_000, amp: 6_000_000 },
  { name: 'WAN_BACKUP_SERVER', baseUp: 600, baseDown: 480, amp: 40_000 },
  { name: 'bridge-LAN/HS/PPPOE', baseUp: 4_200_000, baseDown: 2_200_000, amp: 30_000_000 },
];

interface Live {
  upload: number;
  download: number;
}

const state = new Map<string, Live>();
for (const p of PROFILES) state.set(p.name, { upload: p.baseUp, download: p.baseDown });

function step(current: number, base: number, amp: number): number {
  // Mean-reversion toward base + gaussian-ish noise + rare spike.
  let next = current + (base - current) * 0.15 + (Math.random() - 0.5) * amp * 0.35;
  if (Math.random() < 0.06) next += amp * (0.6 + Math.random());
  return Math.max(0, Math.round(next));
}

function advance() {
  for (const p of PROFILES) {
    const s = state.get(p.name)!;
    s.upload = step(s.upload, p.baseUp, p.amp * 0.35);
    s.download = step(s.download, p.baseDown, p.amp);
  }
}

export function getInterfaceNames(): string[] {
  return PROFILES.map((p) => p.name);
}

export function getTrafficSnapshot(): { t: number; interfaces: { name: string; upload: number; download: number }[] } {
  advance();
  return {
    t: Date.now(),
    interfaces: PROFILES.map((p) => {
      const s = state.get(p.name)!;
      return { name: p.name, upload: s.upload, download: s.download };
    }),
  };
}
