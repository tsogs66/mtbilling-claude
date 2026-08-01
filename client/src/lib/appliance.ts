/**
 * Client-side poll hints from /api/health — slower refreshes on RPi/thin PC
 * so network pages (Topology, PPPoE, Hotspot, NOC) do not stampede the API.
 */
import { publicApi } from '../api';

export type PollHints = {
  map: number;
  hotspot: number;
  pppoeUsers: number;
  pppoeActive: number;
};

const DEFAULT_HINTS: PollHints = {
  map: 15_000,
  hotspot: 15_000,
  pppoeUsers: 12_000,
  pppoeActive: 2_000,
};

const APPLIANCE_HINTS: PollHints = {
  map: 45_000,
  hotspot: 30_000,
  pppoeUsers: 20_000,
  pppoeActive: 4_000,
};

let appliance = false;
let hints: PollHints = { ...DEFAULT_HINTS };
let loaded = false;

export function isApplianceMode() {
  return appliance;
}

export function pollHints() {
  return hints;
}

export async function refreshApplianceHints(): Promise<void> {
  try {
    const r = await publicApi.get('/health', { timeout: 4000 });
    appliance = !!r.data?.appliance;
    const h = r.data?.pollHintMs || {};
    hints = {
      map: Number(h.map) || (appliance ? APPLIANCE_HINTS.map : DEFAULT_HINTS.map),
      hotspot: Number(h.hotspot) || (appliance ? APPLIANCE_HINTS.hotspot : DEFAULT_HINTS.hotspot),
      pppoeUsers:
        Number(h.pppoeUsers) || (appliance ? APPLIANCE_HINTS.pppoeUsers : DEFAULT_HINTS.pppoeUsers),
      pppoeActive:
        Number(h.pppoeActive) || (appliance ? APPLIANCE_HINTS.pppoeActive : DEFAULT_HINTS.pppoeActive),
    };
  } catch {
    // Prefer safer (slower) polls when we cannot ask the API — common mid-tunnel blip
    if (!loaded) {
      appliance = true;
      hints = { ...APPLIANCE_HINTS };
    }
  } finally {
    loaded = true;
  }
}
