/**
 * Appliance / low-resource profile for flash images (RPi, thin PC).
 * Detects constrained hosts and exposes longer scheduler intervals + lower
 * concurrency so background MikroTik/NOC work does not starve the panel API
 * (Cloudflare hostname timeouts after a few minutes).
 */
import os from 'os';

export type ApplianceProfile = {
  /** True when this host should run in low-resource mode */
  appliance: boolean;
  reason: string;
  totalMemMb: number;
  freeMemMb: number;
  cpus: number;
  arch: string;
  /** Background job intervals (ms) */
  intervals: {
    statusHub: number;
    outage: number;
    uptime: number;
    noc: number;
    usage: number;
    routerSync: number;
    notify: number;
  };
  /** Parallel HTTP/router feed checks in Status Hub */
  statusHubConcurrency: number;
  /** Wall-clock cap for one NOC probe pass */
  nocPassDeadlineMs: number;
  /** Suggested Node --max-old-space-size (MB) for install scripts */
  nodeHeapMb: number;
};

function envFlag(name: string): boolean | null {
  const v = String(process.env[name] || '').trim().toLowerCase();
  if (!v) return null;
  if (['1', 'true', 'yes', 'on', 'appliance'].includes(v)) return true;
  if (['0', 'false', 'no', 'off', 'full'].includes(v)) return false;
  return null;
}

function detectAppliance(): { appliance: boolean; reason: string } {
  const forced = envFlag('MT_BILLING_APPLIANCE');
  if (forced === true) return { appliance: true, reason: 'MT_BILLING_APPLIANCE=1' };
  if (forced === false) return { appliance: false, reason: 'MT_BILLING_APPLIANCE=0' };

  const totalMb = Math.round(os.totalmem() / (1024 * 1024));
  const cpus = os.cpus()?.length || 1;
  const arch = os.arch();

  // Typical RPi / thin PC flash images
  if (totalMb > 0 && totalMb <= 3072) {
    return { appliance: true, reason: `total RAM ${totalMb}MB ≤ 3GB` };
  }
  if (cpus <= 2 && totalMb > 0 && totalMb <= 4096) {
    return { appliance: true, reason: `${cpus} CPU(s) and ${totalMb}MB RAM` };
  }
  if (/^arm|^aarch64$/i.test(arch) && totalMb > 0 && totalMb <= 4096) {
    return { appliance: true, reason: `ARM (${arch}) with ${totalMb}MB RAM` };
  }
  return { appliance: false, reason: 'desktop/server resources' };
}

let cached: ApplianceProfile | null = null;

export function getApplianceProfile(): ApplianceProfile {
  if (cached) return cached;
  const totalMemMb = Math.round(os.totalmem() / (1024 * 1024));
  const freeMemMb = Math.round(os.freemem() / (1024 * 1024));
  const cpus = os.cpus()?.length || 1;
  const arch = os.arch();
  const { appliance, reason } = detectAppliance();

  const nodeHeapMb = totalMemMb <= 1024 ? 256 : totalMemMb <= 2048 ? 384 : totalMemMb <= 3072 ? 512 : 768;

  cached = {
    appliance,
    reason,
    totalMemMb,
    freeMemMb,
    cpus,
    arch,
    intervals: appliance
      ? {
          // Stretch background work so Cloudflare / panel API stay responsive
          statusHub: 10 * 60_000,
          outage: 5 * 60_000,
          uptime: 3 * 60_000,
          noc: 10 * 60_000,
          usage: 5 * 60_000, // was 60s — main MikroTik load on RPi
          routerSync: 5 * 60_000,
          notify: 10 * 60_000,
        }
      : {
          statusHub: 5 * 60_000,
          outage: 3 * 60_000,
          uptime: 90_000,
          noc: 5 * 60_000,
          usage: 60_000,
          routerSync: 3 * 60_000,
          notify: 5 * 60_000,
        },
    statusHubConcurrency: appliance ? 2 : 8,
    nocPassDeadlineMs: appliance ? 60_000 : 90_000,
    nodeHeapMb,
  };
  return cached;
}

export function logApplianceProfile() {
  const p = getApplianceProfile();
  console.log(
    `[appliance] mode=${p.appliance ? 'low-resource' : 'full'} (${p.reason}); ` +
      `mem=${p.totalMemMb}MB free≈${p.freeMemMb}MB cpus=${p.cpus} arch=${p.arch}; ` +
      `usageEvery=${Math.round(p.intervals.usage / 1000)}s nocEvery=${Math.round(p.intervals.noc / 1000)}s ` +
      `statusConcurrency=${p.statusHubConcurrency}`
  );
}
