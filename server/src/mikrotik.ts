import { RouterOSAPI } from 'node-routeros';

export interface RouterConn {
  host?: string;
  port?: number;
  api_user?: string;
  api_pass?: string;
}

/**
 * Thin wrapper around the RouterOS API. If a real router is reachable and
 * credentials are provided, live data is returned. Otherwise callers should
 * fall back to the local database (seeded/sample data) so the panel remains
 * fully usable during development without hardware.
 */
export async function withRouter<T>(
  conn: RouterConn,
  fn: (api: RouterOSAPI) => Promise<T>,
  opts?: { timeoutSec?: number }
): Promise<T> {
  if (!conn.host || !conn.api_user) {
    throw new Error('router-not-configured');
  }
  const timeoutSec = opts?.timeoutSec ?? 15;
  const api = new RouterOSAPI({
    host: conn.host,
    port: conn.port || 8728,
    user: conn.api_user,
    password: conn.api_pass || '',
    // 4s was too aggressive for WAN/API-over-VPN boards and multi-step writes.
    timeout: timeoutSec,
  });
  // node-routeros re-emits late/stray socket errors as 'error' on this instance
  // after its connect-phase listeners already fired once and were removed (e.g.
  // an OS-level socket error arriving after the app-level connect timeout already
  // rejected). Node's EventEmitter throws — crashing the whole process, not just
  // this request — on an 'error' event with no listener. An unreachable router is
  // an entirely normal condition (WAN down, reboot, wrong IP), so this must never
  // be allowed to take the panel down; connect()/fn() rejecting is how callers
  // actually observe the failure.
  api.on('error', () => {});
  await api.connect();
  try {
    // Hard budget for the whole callback — node-routeros per-command timeout does
    // not reliably abort stuck /system or /tool/fetch writes.
    const budgetMs = Math.max(3_000, timeoutSec * 1000);
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          api.close();
        } catch {
          /* ignore */
        }
        reject(new Error(`router-call-timeout after ${timeoutSec}s`));
      }, budgetMs);
      fn(api).then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        }
      );
    });
  } finally {
    try {
      api.close();
    } catch {
      /* ignore */
    }
  }
}

function rosTrapMessage(e: unknown): string {
  const any = e as any;
  const msg =
    any?.message ||
    any?.errno ||
    any?.errors?.[0]?.message ||
    (typeof any === 'string' ? any : '') ||
    'MikroTik API error';
  return String(msg);
}

export async function tryLiveResource<T>(
  conn: RouterConn,
  path: string,
  fallback: T
): Promise<{ live: boolean; data: T }> {
  try {
    const data = (await withRouter(conn, (api) => api.write(path))) as unknown as T;
    return { live: true, data };
  } catch {
    return { live: false, data: fallback };
  }
}

export interface RouterProbeResult {
  online: boolean;
  board: string | null;
  identity: string | null;
  version: string | null;
  error?: string;
}

/** Probe a MikroTik router for reachability and hardware identity. */
export async function probeRouter(conn: RouterConn): Promise<RouterProbeResult> {
  if (!conn.host || !conn.api_user) {
    return { online: false, board: null, identity: null, version: null, error: 'Host and API user are required.' };
  }
  try {
    const info = await withRouter(conn, async (api) => {
      const [resource, identity] = await Promise.all([
        api.write('/system/resource/print') as Promise<Record<string, string>[]>,
        api.write('/system/identity/print') as Promise<Record<string, string>[]>,
      ]);
      const r = resource?.[0] || {};
      const id = identity?.[0]?.name || null;
      const board = r['board-name'] || r.board || null;
      const version = r.version || null;
      return { board, identity: id, version };
    });
    return { online: true, board: info.board, identity: info.identity, version: info.version };
  } catch (e: any) {
    return {
      online: false,
      board: null,
      identity: null,
      version: null,
      error: e?.message || 'Connection failed',
    };
  }
}

export interface WanRouteRow {
  routeId: string;
  gateway: string;
  checkMethod: string;
  distance: number;
  status: string;
  interfaceName: string | null;
  dstAddress: string;
  enabled: boolean;
}

/** Enable or disable a route on the router by its .id. */
export async function setRouteEnabled(conn: RouterConn, routeId: string, enabled: boolean): Promise<void> {
  await withRouter(conn, (api) => api.write(enabled ? '/ip/route/enable' : '/ip/route/disable', [`=numbers=${routeId}`]));
}

/** Fetch monitored WAN routes (check-gateway or default routes) from a router. */
export async function fetchWanRoutes(conn: RouterConn): Promise<WanRouteRow[]> {
  return withRouter(conn, async (api) => {
    const routes = (await api.write('/ip/route/print')) as Record<string, string>[];
    const out: WanRouteRow[] = [];
    for (const r of routes || []) {
      const routeId = r['.id'] || '';
      const check = r['check-gateway'] || '';
      const gateway = r.gateway || '';
      const dst = r['dst-address'] || '0.0.0.0/0';
      if (!gateway || !routeId) continue;
      const iface = r.interface || r['interface'] || null;
      const isDefault = dst === '0.0.0.0/0';
      if (!check && !isDefault) continue;
      const disabled = r.disabled === 'true' || r.disabled === 'yes';
      const active = r.active === 'true' || r.active === 'yes';
      out.push({
        routeId,
        gateway,
        checkMethod: check || (isDefault ? 'route' : 'ping'),
        distance: Number(r.distance) || 1,
        status: disabled ? 'Disabled' : active ? 'Active' : 'Inactive',
        interfaceName: iface,
        dstAddress: dst,
        enabled: !disabled,
      });
    }
    return out;
  });
}

export interface RouterFileRow {
  name: string;
  size: number;
  type: string;
  creationTime: string | null;
}

/** List files stored on the router. */
export async function listRouterFiles(conn: RouterConn): Promise<RouterFileRow[]> {
  return withRouter(conn, async (api) => {
    const rows = (await api.write('/file/print')) as Record<string, string>[];
    return (rows || []).map((f) => ({
      name: f.name || '',
      size: Number(f.size) || 0,
      type: f.type || 'file',
      creationTime: f['creation-time'] || null,
    }));
  });
}

function parseRouterMemMb(raw: string | undefined): number {
  if (!raw) return 0;
  const m = raw.match(/^([\d.]+)\s*(\w+)?/i);
  if (!m) return 0;
  const n = Number(m[1]);
  const unit = (m[2] || 'B').toLowerCase();
  if (unit.startsWith('g')) return n * 1024;
  if (unit.startsWith('m')) return n;
  if (unit.startsWith('k')) return n / 1024;
  return n / (1024 * 1024);
}

export interface RouterDashboardStats {
  live: boolean;
  board: string | null;
  uptime: string | null;
  cpuLoad: number;
  memPct: number;
  memTotalMb: number;
}

/** Live CPU, memory, uptime and board from a MikroTik router. */
export async function fetchRouterDashboardStats(conn: RouterConn): Promise<RouterDashboardStats> {
  try {
    return await withRouter(conn, async (api) => {
      const rows = (await api.write('/system/resource/print')) as Record<string, string>[];
      const r = rows[0] || {};
      const totalMb = parseRouterMemMb(r['total-memory']);
      const freeMb = parseRouterMemMb(r['free-memory']);
      const usedMb = Math.max(0, totalMb - freeMb);
      return {
        live: true,
        board: r['board-name'] || null,
        uptime: r.uptime || null,
        cpuLoad: Number(r['cpu-load']) || 0,
        memPct: totalMb > 0 ? Number(((usedMb / totalMb) * 100).toFixed(1)) : 0,
        memTotalMb: Number(totalMb.toFixed(1)),
      };
    });
  } catch {
    return { live: false, board: null, uptime: null, cpuLoad: 0, memPct: 0, memTotalMb: 0 };
  }
}

/** Parse RouterOS rate strings ("15.2Mbps", "800k", "1234567") to bits/sec. */
export function parseRosRate(raw: string | number | undefined | null): number {
  if (raw == null || raw === '') return 0;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const s = String(raw).trim().toLowerCase().replace(/,/g, '');
  const m = s.match(/^([\d.]+)\s*([a-z%/]*)$/);
  if (!m) {
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = m[2].replace(/\/s(ec)?$/, '').replace(/ps$/, '');
  if (unit === 'g' || unit === 'gb' || unit === 'gbps') return n * 1_000_000_000;
  if (unit === 'm' || unit === 'mb' || unit === 'mbps') return n * 1_000_000;
  if (unit === 'k' || unit === 'kb' || unit === 'kbps') return n * 1_000;
  // bare number from RouterOS queue stats is already bits/sec
  return n;
}

/** Queue tree entries from the router (name + current rate in Mbps). */
export async function fetchRouterQueues(conn: RouterConn): Promise<{ name: string; avgRate: number }[]> {
  return withRouter(conn, async (api) => {
    let rows = (await api.write('/queue/tree/print')) as Record<string, string>[];
    // Some RouterOS builds need an explicit stats pass for live rate.
    if (!(rows || []).some((q) => q.rate != null && String(q.rate) !== '' && String(q.rate) !== '0')) {
      try {
        const withStats = (await api.write('/queue/tree/print', ['=stats='])) as Record<string, string>[];
        if (withStats?.length) rows = withStats;
      } catch {
        /* keep first print */
      }
    }
    const mapped = (rows || [])
      .filter((q) => q.name)
      .map((q) => {
        const bps = parseRosRate(q.rate);
        const mbps = bps / 1_000_000;
        return { name: q.name, avgRate: Number(mbps.toFixed(3)) || 0 };
      })
      .sort((a, b) => b.avgRate - a.avgRate);
    // Fall back to simple queues when the tree is empty (common on small CPE boards).
    if (!mapped.length) {
      const simple = (await api.write('/queue/simple/print')) as Record<string, string>[];
      return (simple || [])
        .filter((q) => q.name)
        .map((q) => {
          // simple queues expose rate as "rx/tx" — use the larger leg
          const raw = String(q.rate || '');
          const parts = raw.split('/');
          const bps = Math.max(parseRosRate(parts[0]), parseRosRate(parts[1] || parts[0]));
          return { name: q.name, avgRate: Number((bps / 1_000_000).toFixed(3)) || 0 };
        })
        .sort((a, b) => b.avgRate - a.avgRate);
    }
    return mapped;
  });
}

const VLAN_PARENT_TYPES = new Set([
  'ether',
  'bridge',
  'bond',
  'bonding',
  'vlan',
  'sfp',
  'sfp-plus',
  'qsfpplus',
  'wlan',
  'cap',
  'ovs-bridge',
]);

/** True when an interface name/type is PPPoE or otherwise unsuitable as a VLAN parent. */
export function isPppoeInterface(name: string, type?: string): boolean {
  const n = (name || '').toLowerCase();
  const t = (type || '').toLowerCase();
  if (t.startsWith('pppoe') || t === 'pptp-in' || t === 'pptp-out' || t === 'l2tp-in' || t === 'l2tp-out') return true;
  if (n.startsWith('pppoe-') || n.startsWith('<pppoe-') || n.includes('pppoe')) return true;
  return false;
}

/** Interfaces suitable as VLAN parents (excludes PPPoE / tunnels / disabled). */
export async function fetchVlanParentInterfaces(
  conn: RouterConn
): Promise<{ name: string; type: string; running: boolean }[]> {
  return withRouter(conn, async (api) => {
    const rows = (await api.write('/interface/print')) as Record<string, string>[];
    return (rows || [])
      .filter((i) => {
        if (!i.name || rosBool(i.disabled)) return false;
        if (isPppoeInterface(i.name, i.type)) return false;
        const type = (i.type || '').toLowerCase();
        if (VLAN_PARENT_TYPES.has(type)) return true;
        // Allow common ethernet-like names when type is blank on older ROS
        if (!type && /^(ether|sfp|bridge|bond|wlan)/i.test(i.name)) return true;
        return false;
      })
      .map((i) => ({
        name: i.name,
        type: i.type || '',
        running: rosBool(i.running),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

/** Interface names from the router. */
export async function fetchRouterInterfaceNames(conn: RouterConn): Promise<string[]> {
  return withRouter(conn, async (api) => {
    const rows = (await api.write('/interface/print')) as Record<string, string>[];
    return (rows || [])
      .filter((i) => i.name && i.disabled !== 'true')
      .map((i) => i.name);
  });
}

/** One-shot traffic sample for a set of interfaces on the router. */
export async function fetchRouterInterfaceTraffic(
  conn: RouterConn,
  names: string[]
): Promise<{ name: string; upload: number; download: number }[]> {
  if (!names.length) return [];
  return withRouter(conn, async (api) => {
    const out: { name: string; upload: number; download: number }[] = [];
    for (const name of names) {
      try {
        const rows = (await api.write('/interface/monitor-traffic', [`=interface=${name}`, '=once='])) as Record<string, string>[];
        const r = rows[0] || {};
        out.push({
          name,
          upload: Number(r['tx-bits-per-second']) || 0,
          download: Number(r['rx-bits-per-second']) || 0,
        });
      } catch {
        out.push({ name, upload: 0, download: 0 });
      }
    }
    return out;
  });
}

function rosBool(v: string | boolean | number | undefined | null): boolean {
  if (v === true || v === 1) return true;
  if (v === false || v === 0 || v == null) return false;
  const s = String(v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === '1';
}

export interface FirewallRuleRow {
  id: string;
  table: 'filter' | 'nat' | 'mangle';
  chain: string;
  action: string;
  proto: string;
  dstPort: string;
  srcAddress: string;
  dstAddress: string;
  inInterface: string;
  outInterface: string;
  comment: string;
  enabled: boolean;
  bytes: number;
  packets: number;
}

function mapFirewallRow(r: Record<string, string>, table: FirewallRuleRow['table']): FirewallRuleRow {
  return {
    id: r['.id'] || '',
    table,
    chain: r.chain || '-',
    action: r.action || '-',
    proto: r.protocol || r.proto || 'all',
    dstPort: r['dst-port'] || '-',
    srcAddress: r['src-address'] || '-',
    dstAddress: r['dst-address'] || '-',
    inInterface: r['in-interface'] || '-',
    outInterface: r['out-interface'] || '-',
    comment: r.comment || '',
    enabled: !rosBool(r.disabled),
    bytes: Number(r.bytes) || 0,
    packets: Number(r.packets) || 0,
  };
}

/** Live firewall filter + NAT + mangle rules from the router. */
export async function fetchFirewallRules(conn: RouterConn): Promise<FirewallRuleRow[]> {
  return withRouter(conn, async (api) => {
    const [filter, nat, mangle] = await Promise.all([
      api.write('/ip/firewall/filter/print') as Promise<Record<string, string>[]>,
      api.write('/ip/firewall/nat/print') as Promise<Record<string, string>[]>,
      api.write('/ip/firewall/mangle/print') as Promise<Record<string, string>[]>,
    ]);
    return [
      ...(filter || []).map((r) => mapFirewallRow(r, 'filter')),
      ...(nat || []).map((r) => mapFirewallRow(r, 'nat')),
      ...(mangle || []).map((r) => mapFirewallRow(r, 'mangle')),
    ];
  });
}

export async function setFirewallRuleEnabled(
  conn: RouterConn,
  table: 'filter' | 'nat' | 'mangle',
  id: string,
  enabled: boolean
): Promise<void> {
  const path = `/ip/firewall/${table}/${enabled ? 'enable' : 'disable'}`;
  await withRouter(conn, (api) => api.write(path, [`=numbers=${id}`]));
}

export async function removeFirewallRule(
  conn: RouterConn,
  table: 'filter' | 'nat' | 'mangle',
  id: string
): Promise<void> {
  await withRouter(conn, (api) => api.write(`/ip/firewall/${table}/remove`, [`=numbers=${id}`]));
}

export async function addFirewallRule(
  conn: RouterConn,
  table: 'filter' | 'nat' | 'mangle',
  fields: Record<string, string>
): Promise<void> {
  const args = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `=${k}=${v}`);
  await withRouter(conn, (api) => api.write(`/ip/firewall/${table}/add`, args));
}

export interface IpRouteRow {
  id: string;
  dst: string;
  gateway: string;
  distance: number;
  active: boolean;
  enabled: boolean;
  interfaceName: string;
  checkGateway: string;
  routingMark: string;
  comment: string;
}

/** Full IP routing table from the router. */
export async function fetchIpRoutes(conn: RouterConn): Promise<IpRouteRow[]> {
  return withRouter(conn, async (api) => {
    const routes = (await api.write('/ip/route/print')) as Record<string, string>[];
    return (routes || []).map((r) => ({
      id: r['.id'] || '',
      dst: r['dst-address'] || '0.0.0.0/0',
      gateway: r.gateway || r['immediate-gw'] || '-',
      distance: Number(r.distance) || 0,
      active: rosBool(r.active),
      enabled: !rosBool(r.disabled),
      interfaceName: r.interface || '-',
      checkGateway: r['check-gateway'] || '',
      routingMark: r['routing-mark'] || '',
      comment: r.comment || '',
    }));
  });
}

export async function addIpRoute(
  conn: RouterConn,
  fields: { dst: string; gateway: string; distance?: number; comment?: string; checkGateway?: string }
): Promise<void> {
  const args = [`=dst-address=${fields.dst}`, `=gateway=${fields.gateway}`];
  if (fields.distance != null) args.push(`=distance=${fields.distance}`);
  if (fields.comment) args.push(`=comment=${fields.comment}`);
  if (fields.checkGateway) args.push(`=check-gateway=${fields.checkGateway}`);
  await withRouter(conn, (api) => api.write('/ip/route/add', args));
}

export async function removeIpRoute(conn: RouterConn, id: string): Promise<void> {
  await withRouter(conn, (api) => api.write('/ip/route/remove', [`=numbers=${id}`]));
}

export interface VlanRow {
  id: string;
  name: string;
  vlanId: number;
  iface: string;
  comment: string;
  enabled: boolean;
}

/** VLAN interfaces from the router. */
export async function fetchVlans(conn: RouterConn): Promise<VlanRow[]> {
  return withRouter(conn, async (api) => {
    const rows = (await api.write('/interface/vlan/print')) as Record<string, string>[];
    return (rows || []).map((v) => ({
      id: v['.id'] || '',
      name: v.name || '',
      vlanId: Number(v['vlan-id']) || 0,
      iface: v.interface || '-',
      comment: v.comment || '',
      enabled: !rosBool(v.disabled),
    }));
  });
}

export async function addVlan(
  conn: RouterConn,
  fields: { name: string; vlanId: number; iface: string; comment?: string }
): Promise<void> {
  const args = [`=name=${fields.name}`, `=vlan-id=${fields.vlanId}`, `=interface=${fields.iface}`];
  if (fields.comment) args.push(`=comment=${fields.comment}`);
  await withRouter(conn, (api) => api.write('/interface/vlan/add', args));
}

export async function removeVlan(conn: RouterConn, id: string): Promise<void> {
  await withRouter(conn, (api) => api.write('/interface/vlan/remove', [`=numbers=${id}`]));
}

export interface MultiWanLinkRow {
  name: string;
  role: 'primary' | 'backup' | 'failover';
  weight: number;
  gateway: string;
  interfaceName: string;
  distance: number;
  checkMethod: string;
  status: 'up' | 'standby' | 'down';
}

/** Multi-WAN view derived from default / check-gateway routes on the router. */
export async function fetchMultiWanLinks(conn: RouterConn): Promise<{
  enabled: boolean;
  strategy: string;
  links: MultiWanLinkRow[];
}> {
  const wan = await fetchWanRoutes(conn);
  const sorted = [...wan].sort((a, b) => a.distance - b.distance || a.gateway.localeCompare(b.gateway));
  const links: MultiWanLinkRow[] = sorted.map((r, i) => {
    let role: MultiWanLinkRow['role'] = 'failover';
    if (i === 0) role = 'primary';
    else if (i === 1) role = 'backup';
    const weight = Math.max(
      1,
      Math.round((1 / Math.max(1, r.distance) / sorted.reduce((s, x) => s + 1 / Math.max(1, x.distance), 0)) * 100)
    );
    let status: MultiWanLinkRow['status'] = 'down';
    if (!r.enabled) status = 'down';
    else if (r.status === 'Active') status = 'up';
    else status = 'standby';
    return {
      name: r.interfaceName || r.gateway,
      role,
      weight: sorted.length === 1 ? 100 : weight,
      gateway: r.gateway,
      interfaceName: r.interfaceName || '-',
      distance: r.distance,
      checkMethod: r.checkMethod,
      status,
    };
  });
  const sum = links.reduce((s, l) => s + l.weight, 0) || 1;
  if (links.length > 1 && sum !== 100) {
    let acc = 0;
    links.forEach((l, i) => {
      if (i === links.length - 1) l.weight = Math.max(1, 100 - acc);
      else {
        l.weight = Math.max(1, Math.round((l.weight / sum) * 100));
        acc += l.weight;
      }
    });
  }
  return {
    enabled: links.some((l) => l.status === 'up' || l.status === 'standby'),
    strategy: links.length
      ? `Distance-based failover (${links.filter((l) => l.checkMethod && l.checkMethod !== 'route').length ? 'check-gateway' : 'default routes'})`
      : 'No WAN routes',
    links,
  };
}

/** Interface list + LAN IP hints for multi-WAN script assistant. */
export async function fetchNetworkInterfaces(conn: RouterConn): Promise<{
  interfaces: { name: string; type: string; running: boolean; disabled: boolean }[];
  addresses: { address: string; interface: string; network: string }[];
}> {
  return withRouter(conn, async (api) => {
    const [ifaces, addrs] = await Promise.all([
      api.write('/interface/print') as Promise<Record<string, string>[]>,
      api.write('/ip/address/print') as Promise<Record<string, string>[]>,
    ]);
    return {
      interfaces: (ifaces || []).map((i) => ({
        name: i.name || '',
        type: i.type || '',
        running: rosBool(i.running),
        disabled: rosBool(i.disabled),
      })),
      addresses: (addrs || []).map((a) => ({
        address: a.address || '',
        interface: a.interface || '',
        network: a.network || '',
      })),
    };
  });
}

// ---------------- PPP / PPPoE ----------------

export interface PppSecretRow {
  id: string;
  name: string;
  password: string;
  profile: string;
  service: string;
  comment: string;
  disabled: boolean;
  callerId: string;
}

export interface PppActiveRow {
  id: string;
  name: string;
  address: string;
  uptime: string;
  caller: string;
  service: string;
  profile: string;
}

export interface PppProfileRow {
  id: string;
  name: string;
  rateLimit: string;
  localAddress: string;
  remoteAddress: string;
  onlyOne: string;
  comment: string;
}

export interface PppoeServerRow {
  id: string;
  name: string;
  interface: string;
  maxSessions: number;
  service: string;
  authentication: string;
  status: string;
  disabled: boolean;
  oneSessionPerHost: boolean;
}

export async function fetchPppSecrets(conn: RouterConn): Promise<PppSecretRow[]> {
  return withRouter(conn, async (api) => {
    const rows = (await api.write('/ppp/secret/print')) as Record<string, string>[];
    return (rows || []).map((s) => ({
      id: s['.id'] || '',
      name: s.name || '',
      password: s.password || '',
      profile: s.profile || '',
      service: s.service || 'pppoe',
      comment: s.comment || '',
      disabled: rosBool(s.disabled),
      callerId: s['caller-id'] || '',
    }));
  });
}

export async function fetchPppActive(conn: RouterConn): Promise<PppActiveRow[]> {
  return withRouter(conn, async (api) => {
    const rows = (await api.write('/ppp/active/print')) as Record<string, string>[];
    return (rows || []).map((a) => ({
      id: a['.id'] || '',
      name: a.name || '',
      address: a.address || '-',
      uptime: a.uptime || '-',
      caller: a['caller-id'] || a.caller || '-',
      service: a.service || 'pppoe',
      profile: a.profile || '-',
    }));
  });
}

/** Secrets + active in one TCP session (avoids double connect on busy list polls). */
export async function fetchPppSecretsAndActive(conn: RouterConn): Promise<{
  secrets: PppSecretRow[];
  sessions: PppActiveRow[];
}> {
  return withRouter(conn, async (api) => {
    const [secretRows, activeRows] = await Promise.all([
      api.write('/ppp/secret/print') as Promise<Record<string, string>[]>,
      api.write('/ppp/active/print') as Promise<Record<string, string>[]>,
    ]);
    const secrets: PppSecretRow[] = (secretRows || []).map((s) => ({
      id: s['.id'] || '',
      name: s.name || '',
      password: s.password || '',
      profile: s.profile || '',
      service: s.service || 'pppoe',
      comment: s.comment || '',
      disabled: rosBool(s.disabled),
      callerId: s['caller-id'] || '',
    }));
    const sessions: PppActiveRow[] = (activeRows || []).map((a) => ({
      id: a['.id'] || '',
      name: a.name || '',
      address: a.address || '-',
      uptime: a.uptime || '-',
      caller: a['caller-id'] || a.caller || '-',
      service: a.service || 'pppoe',
      profile: a.profile || '-',
    }));
    return { secrets, sessions };
  }, { timeoutSec: 20 });
}

/** Case-insensitive lookup for PPP secret / active session names. */
export function pppNameKey(name: string | null | undefined): string {
  return String(name || '').trim().toLowerCase();
}

/** MikroTik system profiles — not shown as customer profiles or billing plans. */
export function isSystemPppProfileName(name: string | null | undefined): boolean {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  return n.includes('default') || /non[-_\s]?pay/.test(n);
}

export interface PppEnrichInput {
  username: string;
  status?: string;
  profile?: string;
  online?: number | boolean;
  nonpaymentSince?: string | null;
  expirationProfile?: string | null;
}

/**
 * Merge MikroTik PPP secret + active-session state onto panel user rows.
 * - Username match is case-insensitive (Winbox vs DB casing often differs).
 * - Billing plan (`profile`) stays the panel/DB value (from secret comment).
 *   Live RouterOS profile is only exposed as `mikrotikProfile` (often the
 *   non-payment profile during grace) so payment restore keeps the original plan.
 * - Secret disabled on MikroTik wins — keep status disabled even if a session
 *   has not dropped yet (disable + remove-active is async on the router).
 * - Only clear a DB "disabled" flag when the secret is explicitly enabled.
 * - `panelStatus` keeps the DB billing status so the UI can show non-payment
 *   alongside disabled when the secret was auto-disabled for expiry.
 */
export function enrichPppUsersFromLive<T extends PppEnrichInput>(
  users: T[],
  secrets: PppSecretRow[],
  sessions: PppActiveRow[]
): (T & {
  status: string;
  panelStatus: string;
  online: number;
  sessionOnline: boolean;
  mikrotikProfile: string | null;
})[] {
  const byName = new Map(secrets.map((s) => [pppNameKey(s.name), s]));
  const onlineSet = new Set(sessions.map((s) => pppNameKey(s.name)).filter(Boolean));

  return users.map((u) => {
    const key = pppNameKey(u.username);
    const sec = byName.get(key);
    const sessionOnline = onlineSet.has(key);
    const panelStatus = String(u.status || 'Active');
    let status = panelStatus;

    if (sec) {
      if (sec.disabled) {
        status = 'disabled';
      } else if (status.toLowerCase() === 'disabled') {
        // Secret is enabled on MikroTik — clear stale billing/DB disabled flag.
        status = 'Active';
      }
    }

    return {
      ...u,
      profile: u.profile,
      status,
      panelStatus,
      online: sessionOnline ? 1 : 0,
      sessionOnline,
      mikrotikProfile: sec?.profile || null,
    };
  });
}

export async function fetchPppProfiles(conn: RouterConn): Promise<PppProfileRow[]> {
  return withRouter(conn, async (api) => {
    const rows = (await api.write('/ppp/profile/print')) as Record<string, string>[];
    return (rows || []).map((p) => ({
      id: p['.id'] || '',
      name: p.name || '',
      rateLimit: p['rate-limit'] || '',
      localAddress: p['local-address'] || '',
      remoteAddress: p['remote-address'] || '',
      onlyOne: p['only-one'] || '',
      comment: p.comment || '',
    }));
  });
}

export async function addPppProfile(
  conn: RouterConn,
  fields: { name: string; rateLimit?: string; localAddress?: string; remoteAddress?: string; comment?: string }
): Promise<void> {
  const args = [`=name=${fields.name}`];
  if (fields.rateLimit) args.push(`=rate-limit=${fields.rateLimit}`);
  if (fields.localAddress) args.push(`=local-address=${fields.localAddress}`);
  if (fields.remoteAddress) args.push(`=remote-address=${fields.remoteAddress}`);
  if (fields.comment) args.push(`=comment=${fields.comment}`);
  await withRouter(conn, (api) => api.write('/ppp/profile/add', args));
}

export async function updatePppProfile(
  conn: RouterConn,
  id: string,
  fields: { name?: string; rateLimit?: string; localAddress?: string; remoteAddress?: string; comment?: string }
): Promise<void> {
  const args = [`=.id=${id}`];
  if (fields.name) args.push(`=name=${fields.name}`);
  if (fields.rateLimit != null) args.push(`=rate-limit=${fields.rateLimit}`);
  if (fields.localAddress != null) args.push(`=local-address=${fields.localAddress}`);
  if (fields.remoteAddress != null) args.push(`=remote-address=${fields.remoteAddress}`);
  if (fields.comment != null) args.push(`=comment=${fields.comment}`);
  await withRouter(conn, (api) => api.write('/ppp/profile/set', args));
}

export async function removePppProfile(conn: RouterConn, id: string): Promise<void> {
  await withRouter(conn, (api) => api.write('/ppp/profile/remove', [`=numbers=${id}`]));
}

export async function setPppSecretEnabled(conn: RouterConn, nameOrId: string, enabled: boolean): Promise<void> {
  await withRouter(conn, (api) =>
    api.write(enabled ? '/ppp/secret/enable' : '/ppp/secret/disable', [`=numbers=${nameOrId}`])
  );
}

/** Remove active PPP session(s) for a username (case-insensitive). */
export async function removePppActiveByName(conn: RouterConn, username: string): Promise<number> {
  const key = pppNameKey(username);
  if (!key) return 0;
  return withRouter(conn, async (api) => {
    const rows = (await api.write('/ppp/active/print')) as Record<string, string>[];
    const ids = (rows || [])
      .filter((r) => pppNameKey(r.name) === key && r['.id'])
      .map((r) => r['.id']);
    for (const id of ids) {
      try {
        await api.write('/ppp/active/remove', [`=.id=${id}`]);
      } catch {
        try {
          await api.write('/ppp/active/remove', [`=numbers=${id}`]);
        } catch {
          /* session may already be gone */
        }
      }
    }
    return ids.length;
  });
}

/** Ensure a PPP profile exists on the router (create empty one if missing). */
export async function ensurePppProfile(
  conn: RouterConn,
  name: string,
  rateLimit?: string
): Promise<void> {
  if (!name) return;
  await withRouter(conn, async (api) => {
    const rows = (await api.write('/ppp/profile/print')) as Record<string, string>[];
    if ((rows || []).some((p) => String(p.name || '') === name)) return;
    const args = [`=name=${name}`];
    if (rateLimit) args.push(`=rate-limit=${rateLimit}`);
    await api.write('/ppp/profile/add', args);
  }, { timeoutSec: 15 });
}

function secretWriteArgs(fields: {
  name?: string;
  password?: string;
  profile?: string;
  service?: string;
  comment?: string;
  disabled?: boolean;
}): string[] {
  const args: string[] = [];
  if (fields.name != null) args.push(`=name=${fields.name}`);
  if (fields.password != null) args.push(`=password=${fields.password}`);
  if (fields.service != null) args.push(`=service=${fields.service}`);
  if (fields.profile) args.push(`=profile=${fields.profile}`);
  if (fields.comment != null) args.push(`=comment=${fields.comment}`);
  if (fields.disabled != null) args.push(`=disabled=${fields.disabled ? 'yes' : 'no'}`);
  return args;
}

export async function addPppSecret(
  conn: RouterConn,
  fields: {
    name: string;
    password: string;
    profile?: string;
    service?: string;
    comment?: string;
    disabled?: boolean;
    rateLimit?: string;
  }
): Promise<void> {
  // Do not auto-create PPP profiles — billing plans must reference an existing MikroTik profile.
  const tryAdd = async (profile?: string) => {
    const args = secretWriteArgs({
      name: fields.name,
      password: fields.password || '',
      service: fields.service || 'pppoe',
      profile,
      comment: fields.comment,
      disabled: fields.disabled,
    });
    await withRouter(conn, (api) => api.write('/ppp/secret/add', args), { timeoutSec: 20 });
  };

  try {
    await tryAdd(fields.profile);
  } catch (e) {
    const msg = rosTrapMessage(e);
    // Missing/invalid profile → retry with RouterOS "default"
    if (fields.profile && /profile|no such|invalid/i.test(msg)) {
      try {
        await tryAdd('default');
        return;
      } catch (e2) {
        throw new Error(rosTrapMessage(e2) || msg);
      }
    }
    // Already exists → treat as update
    if (/already|exist|unique/i.test(msg)) {
      await updatePppSecret(conn, fields.name, {
        password: fields.password,
        profile: fields.profile,
        service: fields.service || 'pppoe',
        comment: fields.comment,
        disabled: fields.disabled,
      });
      return;
    }
    throw new Error(msg);
  }
}

export async function updatePppSecret(
  conn: RouterConn,
  nameOrId: string,
  fields: {
    password?: string;
    profile?: string;
    service?: string;
    comment?: string;
    disabled?: boolean;
    rateLimit?: string;
  }
): Promise<void> {
  // Do not auto-create PPP profiles — use an existing MikroTik profile from the billing plan.
  const args = [`=numbers=${nameOrId}`, ...secretWriteArgs(fields)];
  try {
    await withRouter(conn, (api) => api.write('/ppp/secret/set', args), { timeoutSec: 20 });
  } catch (e) {
    const msg = rosTrapMessage(e);
    // Secret missing on router → create it when we have a password
    if (/no such|not found|invalid value for argument numbers/i.test(msg)) {
      if (fields.password == null) {
        throw new Error(
          `PPP secret "${nameOrId}" not found on MikroTik. Edit the user (set password) or re-create to push the secret.`
        );
      }
      await addPppSecret(conn, {
        name: nameOrId,
        password: fields.password || '',
        profile: fields.profile,
        service: fields.service || 'pppoe',
        comment: fields.comment,
        disabled: fields.disabled,
        rateLimit: fields.rateLimit,
      });
      return;
    }
    throw new Error(msg);
  }
}

export async function removePppSecret(conn: RouterConn, nameOrId: string): Promise<void> {
  await withRouter(conn, (api) => api.write('/ppp/secret/remove', [`=numbers=${nameOrId}`]), {
    timeoutSec: 15,
  });
}

/**
 * Billing metadata stored in /ppp/secret comment (JSON).
 * Matches the format used by fetch-from-MikroTik import.
 */
export function buildPppSecretComment(input: {
  plan?: string | null;
  dueDate?: string | null;
  expireProfile?: string | null;
  accountNumber?: string | number | null;
  customer?: {
    fullName?: string | null;
    address?: string | null;
    contactNumber?: string | null;
    email?: string | null;
    napId?: string | number | null;
    status?: string | null;
    plcPort?: string | number | null;
    latitude?: number | null;
    longitude?: number | null;
  };
}): string {
  const cust = input.customer || {};
  const statusRaw = String(cust.status || 'active').toLowerCase();
  const status =
    statusRaw === 'active' || statusRaw === 'enabled' || statusRaw === 'online'
      ? 'active'
      : statusRaw === 'non-payment' || statusRaw === 'nonpayment'
        ? 'non-payment'
        : statusRaw === 'expired'
          ? 'expired'
          : statusRaw === 'disabled'
            ? 'disabled'
            : statusRaw || 'active';

  const acct = input.accountNumber;
  let accountNumber: string | number | null = acct == null || acct === '' ? null : acct;
  if (typeof accountNumber === 'string' && /^\d+$/.test(accountNumber) && accountNumber.length <= 15) {
    accountNumber = Number(accountNumber);
  }

  const napId =
    cust.napId == null || cust.napId === ''
      ? null
      : typeof cust.napId === 'number'
        ? `nap_${cust.napId}`
        : String(cust.napId).startsWith('nap_')
          ? String(cust.napId)
          : /^\d+$/.test(String(cust.napId))
            ? `nap_${cust.napId}`
            : String(cust.napId);

  const payload: Record<string, unknown> = {
    plan: input.plan || null,
    dueDate: input.dueDate ? String(input.dueDate).slice(0, 10) : null,
    expireProfile: input.expireProfile || 'non-payments',
    customer: {
      fullName: cust.fullName || null,
      address: cust.address || null,
      contactNumber: cust.contactNumber || null,
      email: cust.email || null,
      napId,
      status,
      plcPort: cust.plcPort != null && cust.plcPort !== '' ? String(cust.plcPort) : null,
      latitude: cust.latitude != null && Number.isFinite(Number(cust.latitude)) ? Number(cust.latitude) : null,
      longitude: cust.longitude != null && Number.isFinite(Number(cust.longitude)) ? Number(cust.longitude) : null,
    },
    accountNumber,
  };
  return JSON.stringify(payload);
}

export async function fetchPppoeServers(conn: RouterConn): Promise<PppoeServerRow[]> {
  return withRouter(conn, async (api) => {
    const rows = (await api.write('/interface/pppoe-server/server/print')) as Record<string, string>[];
    return (rows || []).map((s) => {
      const disabled = rosBool(s.disabled);
      return {
        id: s['.id'] || '',
        name: s['service-name'] || s.name || '',
        interface: s.interface || '-',
        maxSessions: Number(s['max-sessions'] || s['max-session'] || 0) || 0,
        service: 'pppoe',
        authentication: s.authentication || s.auth || '-',
        status: disabled ? 'disabled' : 'running',
        disabled,
        oneSessionPerHost: rosBool(s['one-session-per-host']),
      };
    });
  });
}

// ---------------- DHCP / IPoE ----------------

export interface DhcpLeaseRow {
  id: string;
  address: string;
  macAddress: string;
  hostName: string;
  server: string;
  status: string;
  expiresAfter: string;
  lastSeen: string;
  comment: string;
  dynamic: boolean;
  blocked: boolean;
  activeAddress: string;
  activeMac: string;
  activeServer: string;
}

export interface DhcpServerRow {
  id: string;
  name: string;
  interface: string;
  addressPool: string;
  leaseTime: string;
  disabled: boolean;
  authoritative: string;
}

export async function fetchDhcpLeases(conn: RouterConn): Promise<DhcpLeaseRow[]> {
  return withRouter(conn, async (api) => {
    const rows = (await api.write('/ip/dhcp-server/lease/print')) as Record<string, string>[];
    return (rows || []).map((l) => ({
      id: l['.id'] || '',
      address: l.address || l['active-address'] || '',
      macAddress: (l['mac-address'] || l['active-mac-address'] || '').toUpperCase(),
      hostName: l['host-name'] || '',
      server: l.server || l['active-server'] || '',
      status: l.status || (rosBool(l.blocked) ? 'blocked' : 'unknown'),
      expiresAfter: l['expires-after'] || '',
      lastSeen: l['last-seen'] || '',
      comment: l.comment || '',
      dynamic: rosBool(l.dynamic),
      blocked: rosBool(l.blocked),
      activeAddress: l['active-address'] || '',
      activeMac: (l['active-mac-address'] || '').toUpperCase(),
      activeServer: l['active-server'] || '',
    }));
  });
}

export async function setDhcpLeaseBlocked(conn: RouterConn, id: string, blocked: boolean): Promise<void> {
  await withRouter(conn, (api) =>
    api.write('/ip/dhcp-server/lease/set', [`=.id=${id}`, `=blocked=${blocked ? 'yes' : 'no'}`])
  );
}

export async function fetchDhcpServers(conn: RouterConn): Promise<DhcpServerRow[]> {
  return withRouter(conn, async (api) => {
    const rows = (await api.write('/ip/dhcp-server/print')) as Record<string, string>[];
    return (rows || []).map((s) => ({
      id: s['.id'] || '',
      name: s.name || '',
      interface: s.interface || '',
      addressPool: s['address-pool'] || '',
      leaseTime: s['lease-time'] || '',
      disabled: rosBool(s.disabled),
      authoritative: s.authoritative || '',
    }));
  });
}

export async function addDhcpServer(
  conn: RouterConn,
  fields: { name: string; interface: string; addressPool: string; leaseTime?: string }
): Promise<void> {
  const args = [
    `=name=${fields.name}`,
    `=interface=${fields.interface}`,
    `=address-pool=${fields.addressPool}`,
  ];
  if (fields.leaseTime) args.push(`=lease-time=${fields.leaseTime}`);
  await withRouter(conn, (api) => api.write('/ip/dhcp-server/add', args));
}

export async function updateDhcpServer(
  conn: RouterConn,
  id: string,
  fields: { name?: string; interface?: string; addressPool?: string; leaseTime?: string; disabled?: boolean }
): Promise<void> {
  const args = [`=.id=${id}`];
  if (fields.name) args.push(`=name=${fields.name}`);
  if (fields.interface) args.push(`=interface=${fields.interface}`);
  if (fields.addressPool) args.push(`=address-pool=${fields.addressPool}`);
  if (fields.leaseTime) args.push(`=lease-time=${fields.leaseTime}`);
  if (fields.disabled != null) args.push(`=disabled=${fields.disabled ? 'yes' : 'no'}`);
  await withRouter(conn, (api) => api.write('/ip/dhcp-server/set', args));
}

export async function removeDhcpServer(conn: RouterConn, id: string): Promise<void> {
  await withRouter(conn, (api) => api.write('/ip/dhcp-server/remove', [`=numbers=${id}`]));
}

/** Map dynamic PPPoE interface / queue names → lowercase username key. */
function pppIfaceUserKey(name: string): string | null {
  const n = String(name || '').trim();
  if (!n) return null;
  // <pppoe-user>, <pppoe-user@realm>, pppoe-user, <l2tp-user>, etc.
  const m =
    n.match(/^<(?:pppoe|pptp|l2tp|ovpn|sstp)-(.+)>$/i) ||
    n.match(/^(?:pppoe|pptp|l2tp|ovpn|sstp)-(.+)$/i);
  if (m) return pppNameKey(m[1]);
  return null;
}

async function readPppIfaceByteCounters(
  api: RouterOSAPI
): Promise<Map<string, { down: number; up: number; iface: string }>> {
  const map = new Map<string, { down: number; up: number; iface: string }>();
  const attempts: string[][] = [
    ['=.proplist=name,rx-byte,tx-byte,rx-bytes,tx-bytes'],
    ['=stats='],
    [],
  ];
  let rows: Record<string, string>[] = [];
  for (const args of attempts) {
    try {
      rows = (await api.write('/interface/print', args)) as Record<string, string>[];
      if ((rows || []).some((r) => r['rx-byte'] != null || r['rx-bytes'] != null || r['tx-byte'] != null)) {
        break;
      }
    } catch {
      /* try next shape */
    }
  }
  for (const iface of rows || []) {
    const name = iface.name || '';
    const key = pppIfaceUserKey(name);
    if (!key) continue;
    const ifaceRx = Number(iface['rx-byte'] || iface['rx-bytes'] || 0) || 0;
    const ifaceTx = Number(iface['tx-byte'] || iface['tx-bytes'] || 0) || 0;
    map.set(key, {
      down: ifaceTx, // to subscriber = download
      up: ifaceRx, // from subscriber = upload
      iface: name,
    });
  }
  return map;
}

/** Last interface byte snapshot per router — used to derive live bps between UI polls
 * without sleeping 1s inside each request (so Active Connections can refresh every 2s). */
const lastPppIfaceSnap = new Map<
  string,
  { t: number; byKey: Map<string, { down: number; up: number; iface: string }> }
>();

function routerSnapKey(conn: RouterConn): string {
  return `${conn.host || ''}:${conn.port || 8728}:${conn.api_user || ''}`;
}

/** Live bits/s for PPP active sessions via their dynamic <pppoe-user> interfaces.
 *
 * Those interfaces face the subscriber (LAN side of the PPP session), not the WAN:
 *   - TX (to client)  = subscriber download
 *   - RX (from client) = subscriber upload
 *
 * Fast path (opts.fast): one counter print + delta vs previous poll, then queues /
 * monitor-traffic fill-ins — no 1s sleep, so the Active tab can poll every 2s.
 */
export async function fetchPppActiveTraffic(
  conn: RouterConn,
  usernames: string[],
  opts?: { addresses?: Record<string, string>; fast?: boolean }
): Promise<Record<string, { download: number; upload: number }>> {
  if (!usernames.length) return {};
  const fast = opts?.fast !== false; // default fast for live UI; pass fast:false for one-shot accuracy
  return withRouter(conn, async (api) => {
    const out: Record<string, { download: number; upload: number }> = {};
    const nameByKey = new Map<string, string>();
    for (const u of usernames) nameByKey.set(pppNameKey(u), u);
    const wantKeys = new Set(nameByKey.keys());
    const addrToUser = new Map<string, string>();
    for (const [user, addr] of Object.entries(opts?.addresses || {})) {
      const ip = String(addr || '')
        .trim()
        .split('/')[0]
        .split(':')[0];
      if (ip && wantKeys.has(pppNameKey(user))) addrToUser.set(ip, pppNameKey(user));
    }

    const setRate = (key: string, download: number, upload: number) => {
      const user = nameByKey.get(key);
      if (!user) return;
      const prev = out[user];
      out[user] = {
        download: Math.max(prev?.download || 0, download),
        upload: Math.max(prev?.upload || 0, upload),
      };
    };

    // ---- 1) Interface byte counters → bps via previous poll snapshot (no sleep) ----
    let ifaceMap = new Map<string, { down: number; up: number; iface: string }>();
    let hadPriorSnap = false;
    try {
      ifaceMap = await readPppIfaceByteCounters(api);
      const snapKey = routerSnapKey(conn);
      const now = Date.now();
      const prev = lastPppIfaceSnap.get(snapKey);
      hadPriorSnap = !!(prev && prev.byKey.size);
      lastPppIfaceSnap.set(snapKey, { t: now, byKey: ifaceMap });

      if (prev && prev.byKey.size) {
        const dt = Math.max(0.4, (now - prev.t) / 1000);
        // Only trust deltas from recent polls (0.4s–12s) — covers 2s UI refresh.
        if (dt >= 0.4 && dt <= 12) {
          for (const key of wantKeys) {
            const s0 = prev.byKey.get(key);
            const s1 = ifaceMap.get(key);
            if (!s0 || !s1) continue;
            const downBytes = Math.max(0, s1.down - s0.down);
            const upBytes = Math.max(0, s1.up - s0.up);
            setRate(key, Math.round((downBytes * 8) / dt), Math.round((upBytes * 8) / dt));
          }
        }
      }

      // Slow/one-shot path: if no usable prior sample, dual-sample once (accurate but ~1s).
      if (!fast && ![...wantKeys].some((k) => {
        const u = nameByKey.get(k)!;
        const t = out[u];
        return t && (t.download > 0 || t.upload > 0);
      })) {
        await new Promise((r) => setTimeout(r, 900));
        const b = await readPppIfaceByteCounters(api);
        const dt = 0.9;
        lastPppIfaceSnap.set(snapKey, { t: Date.now(), byKey: b });
        for (const key of wantKeys) {
          const s0 = ifaceMap.get(key);
          const s1 = b.get(key);
          if (!s0 || !s1) continue;
          setRate(
            key,
            Math.round((Math.max(0, s1.down - s0.down) * 8) / dt),
            Math.round((Math.max(0, s1.up - s0.up) * 8) / dt)
          );
        }
        ifaceMap = b;
      }
    } catch {
      /* optional */
    }

    // ---- 2) Overlay simple-queue live rates when present ----
    // Fast polls with a prior counter snapshot already have usable rates; skip the
    // extra queue print so 2s Active refreshes stay cheap.
    if (!fast || !hadPriorSnap) {
      try {
        let simple = (await api.write('/queue/simple/print')) as Record<string, string>[];
        if (!(simple || []).some((q) => q.rate != null && String(q.rate) !== '' && String(q.rate) !== '0/0')) {
          try {
            const withStats = (await api.write('/queue/simple/print', ['=stats='])) as Record<string, string>[];
            if (withStats?.length) simple = withStats;
          } catch {
            /* keep first */
          }
        }
        for (const q of simple || []) {
          const qName = String(q.name || '');
          let key = pppIfaceUserKey(qName) || '';
          if (!key && wantKeys.has(pppNameKey(qName))) key = pppNameKey(qName);
          if (!key) {
            const target = String(q.target || q['dst-address'] || '');
            const ipMatch = target.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
            if (ipMatch?.[1] && addrToUser.has(ipMatch[1])) key = addrToUser.get(ipMatch[1])!;
          }
          if (!key || !wantKeys.has(key)) continue;
          const raw = String(q.rate || '');
          if (!raw || raw === '0' || raw === '0/0') continue;
          const parts = raw.split('/');
          const upload = parseRosRate(parts[0]);
          const download = parseRosRate(parts[1] || parts[0]);
          if (download > 0 || upload > 0) setRate(key, download, upload);
        }
      } catch {
        /* optional */
      }
    }

    // ---- 3) monitor-traffic for users still at 0 (batched). Cap work on fast polls. ----
    // With a prior snap, 0 from counter deltas means idle — don't probe every 2s.
    const needProbe = hadPriorSnap && fast
      ? []
      : [...wantKeys].filter((k) => {
          const u = nameByKey.get(k)!;
          const t = out[u];
          return !t || (t.download === 0 && t.upload === 0);
        });
    if (needProbe.length) {
      try {
        const ifaceByKey = new Map<string, string>();
        const needSet = new Set(needProbe);
        for (const [key, v] of ifaceMap) {
          if (needSet.has(key)) ifaceByKey.set(key, v.iface);
        }
        // If iface map was empty, refresh names for monitor.
        if (!ifaceByKey.size) {
          const fresh = await readPppIfaceByteCounters(api);
          for (const [key, v] of fresh) {
            if (needSet.has(key)) ifaceByKey.set(key, v.iface);
          }
        }

        const keys = [...ifaceByKey.keys()].slice(0, fast ? 40 : 200);
        const CHUNK = fast ? 16 : 12;
        for (let i = 0; i < keys.length; i += CHUNK) {
          const chunk = keys.slice(i, i + CHUNK);
          const ifaceList = chunk.map((k) => ifaceByKey.get(k)!).join(',');
          try {
            const rows = (await api.write('/interface/monitor-traffic', [
              `=interface=${ifaceList}`,
              '=once=',
              '=.proplist=name,rx-bits-per-second,tx-bits-per-second',
            ])) as Record<string, string>[];
            for (const r of rows || []) {
              const key = pppIfaceUserKey(String(r.name || ''));
              if (!key || !wantKeys.has(key)) continue;
              const rx = Number(r['rx-bits-per-second']) || 0;
              const tx = Number(r['tx-bits-per-second']) || 0;
              setRate(key, tx, rx);
            }
          } catch {
            if (fast) continue; // don't fall into slow sequential path during 2s polls
            for (const key of chunk) {
              const iface = ifaceByKey.get(key);
              if (!iface) continue;
              try {
                const rows = (await api.write('/interface/monitor-traffic', [
                  `=interface=${iface}`,
                  '=once=',
                ])) as Record<string, string>[];
                const r = rows?.[0] || {};
                const rx = Number(r['rx-bits-per-second']) || 0;
                const tx = Number(r['tx-bits-per-second']) || 0;
                setRate(key, tx, rx);
              } catch {
                /* skip */
              }
            }
          }
        }
      } catch {
        /* optional */
      }
    }

    for (const u of usernames) {
      if (out[u] == null) out[u] = { download: 0, upload: 0 };
    }
    return out;
  }, { timeoutSec: fast ? 20 : 45 });
}

/**
 * Live rx/tx for IPoE/DHCP leases by matching simple-queue targets to lease IPs.
 * MikroTik simple-queue `rate` is upload/download (from the target/client perspective).
 */
export async function fetchLeaseTrafficByIp(
  conn: RouterConn,
  ips: string[]
): Promise<Record<string, { download: number; upload: number }>> {
  if (!ips.length) return {};
  const want = new Set(ips.map((ip) => String(ip || '').trim()).filter(Boolean));
  return withRouter(conn, async (api) => {
    const out: Record<string, { download: number; upload: number }> = {};
    const simple = (await api.write('/queue/simple/print')) as Record<string, string>[];
    for (const q of simple || []) {
      // target can be "1.2.3.4/32", "1.2.3.4", or "1.2.3.4/32,ether1"
      const target = String(q.target || q['dst-address'] || '');
      const ipMatch = target.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
      const ip = ipMatch?.[1];
      if (!ip || !want.has(ip)) continue;
      const raw = String(q.rate || '');
      const parts = raw.split('/');
      // rate = upload/download for a client-targeted queue
      const upload = parseRosRate(parts[0]);
      const download = parseRosRate(parts[1] || parts[0]);
      const prev = out[ip];
      out[ip] = {
        download: Math.max(prev?.download || 0, download),
        upload: Math.max(prev?.upload || 0, upload),
      };
    }
    return out;
  }, { timeoutSec: 20 });
}

/** Cumulative byte counters on dynamic PPPoE interfaces (subscriber perspective).
 * Interface is LAN-facing: iface TX → download, iface RX → upload.
 * Returned as rxBytes=download, txBytes=upload to match usage UI labels.
 */
export async function fetchPppInterfaceBytes(
  conn: RouterConn,
  usernames: string[]
): Promise<Record<string, { rxBytes: number; txBytes: number }>> {
  if (!usernames.length) return {};
  return withRouter(conn, async (api) => {
    const want = new Set(usernames.map((u) => pppNameKey(u)));
    const counters = await readPppIfaceByteCounters(api);
    const out: Record<string, { rxBytes: number; txBytes: number }> = {};
    for (const u of usernames) {
      const t = counters.get(pppNameKey(u));
      if (t && want.has(pppNameKey(u))) {
        out[u] = {
          rxBytes: t.down, // download to subscriber
          txBytes: t.up, // upload from subscriber
        };
      }
    }
    return out;
  }, { timeoutSec: 20 });
}

/** DNS cache names — used to estimate popular platforms/services. */
export async function fetchDnsCacheNames(conn: RouterConn): Promise<string[]> {
  const entries = await fetchDnsCacheEntries(conn);
  return [...new Set(entries.map((e) => e.name).filter(Boolean))];
}

/** DNS cache name ↔ address pairs (for per-user service labeling). */
export async function fetchDnsCacheEntries(
  conn: RouterConn
): Promise<{ name: string; address: string }[]> {
  return withRouter(conn, async (api) => {
    const out: { name: string; address: string }[] = [];
    const paths = ['/ip/dns/cache/print', '/ip/dns/cache/all/print'];
    for (const path of paths) {
      try {
        const rows = (await api.write(path)) as Record<string, string>[];
        for (const r of rows || []) {
          const name = String(r.name || '').trim();
          const address = String(r.data || r.address || '').trim();
          if (name) out.push({ name, address });
        }
        if (out.length) break;
      } catch {
        /* try next path (ROS version differences) */
      }
    }
    return out;
  }, { timeoutSec: 20 });
}

/** Sample active connections' destination addresses (capped). */
export async function fetchConnectionDestinations(
  conn: RouterConn,
  limit = 400
): Promise<{ dst: string; protocol: string }[]> {
  return withRouter(conn, async (api) => {
    try {
      const rows = (await api.write('/ip/firewall/connection/print', [
        '=.proplist=dst-address,protocol',
      ])) as Record<string, string>[];
      return (rows || []).slice(0, limit).map((r) => ({
        dst: String(r['dst-address'] || '').split(':')[0],
        protocol: String(r.protocol || ''),
      }));
    } catch {
      return [];
    }
  }, { timeoutSec: 20 });
}

/**
 * Active firewall connections whose source matches a subscriber PPP address.
 * Used for "services currently accessed" on the Usage per-user panel.
 */
export async function fetchConnectionsForSrcAddress(
  conn: RouterConn,
  srcAddress: string,
  limit = 300
): Promise<{ dst: string; dstPort: string; protocol: string; replySrc: string }[]> {
  const src = String(srcAddress || '').trim();
  if (!src || src === '-') return [];
  return withRouter(conn, async (api) => {
    try {
      // Prefer server-side filter when RouterOS supports it; fall back to full print.
      let rows: Record<string, string>[] = [];
      try {
        rows = (await api.write('/ip/firewall/connection/print', [
          `?src-address=${src}`,
          '=.proplist=src-address,dst-address,protocol,reply-src-address',
        ])) as Record<string, string>[];
      } catch {
        rows = (await api.write('/ip/firewall/connection/print', [
          '=.proplist=src-address,dst-address,protocol,reply-src-address',
        ])) as Record<string, string>[];
      }
      const out: { dst: string; dstPort: string; protocol: string; replySrc: string }[] = [];
      for (const r of rows || []) {
        const rowSrc = String(r['src-address'] || '').split('/')[0].split(':')[0];
        if (rowSrc !== src) continue;
        const dstRaw = String(r['dst-address'] || '');
        const [dstHost, dstPort = ''] = dstRaw.split(':');
        out.push({
          dst: dstHost || dstRaw,
          dstPort,
          protocol: String(r.protocol || ''),
          replySrc: String(r['reply-src-address'] || '').split(':')[0],
        });
        if (out.length >= limit) break;
      }
      return out;
    } catch {
      return [];
    }
  }, { timeoutSec: 25 });
}

function parseProbeUrl(url: string): { host: string; fetchUrl: string } {
  try {
    const u = new URL(url);
    return { host: u.hostname, fetchUrl: u.href };
  } catch {
    const host = String(url || '')
      .replace(/^https?:\/\//i, '')
      .split('/')[0]
      .split('?')[0];
    return { host, fetchUrl: url.startsWith('http') ? url : `https://${host}` };
  }
}

/**
 * RouterOS reports ping/duration fields as compound strings with sub-ms
 * precision — "3ms800us", "800us", "1s200ms" — not a plain number. A naive
 * `.replace(/ms$/i, '')` only strips an exact trailing "ms" and leaves
 * anything with a "us" (or multi-unit) remainder as NaN, which silently
 * drops every real reading and forces callers to fall back to a much
 * coarser wall-clock measurement instead of the router's own reported RTT.
 */
function parseRouterOsDurationMs(raw: string | undefined | null): number | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const UNIT_MS: Record<string, number> = { d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1, us: 0.001, ns: 0.000001 };
  const re = /(\d+(?:\.\d+)?)(ms|us|ns|d|h|m|s)/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    matched = true;
    total += Number(m[1]) * UNIT_MS[m[2]];
  }
  return matched ? total : null;
}

function parsePingAvgMs(rows: Record<string, string>[]): number | null {
  const times: number[] = [];
  for (const row of rows || []) {
    const n = parseRouterOsDurationMs(row.time || row['avg-rtt']);
    if (n != null && n > 0) times.push(n);
  }
  if (!times.length) return null;
  return Math.round(times.reduce((a, b) => a + b, 0) / times.length);
}

export type RouterHttpProbeResult = {
  up: boolean;
  status: 'up' | 'down' | 'degraded';
  ms: number | null;
  code: number;
  error: string | null;
};

/** RouterOS /tool fetch streams !re until /cancel — must not overlap concurrent jobs. */
async function cancelFetchTool(api: RouterOSAPI) {
  try {
    await api.write('/cancel');
  } catch {
    /* ignore */
  }
}

async function removeStaleFetches(api: RouterOSAPI) {
  try {
    await api.write('/tool/fetch/remove', ['=numbers=0']);
  } catch {
    try {
      await api.write('/tool/fetch/remove', ['=.id=*']);
    } catch {
      /* ignore */
    }
  }
}

function terminalFetchStatus(rows: Record<string, string>[] | undefined) {
  const list = rows || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const st = String(list[i].status || '').toLowerCase();
    if (st === 'finished' || st === 'ok' || st === 'failed') {
      return { st, message: list[i].message || null };
    }
  }
  const last = list[list.length - 1] || {};
  return { st: String(last.status || '').toLowerCase(), message: last.message || null };
}

function rosErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  const any = e as { message?: string; errno?: string };
  return String(any?.message || any?.errno || e || 'router error');
}

async function waitForRouterFetch(
  api: RouterOSAPI,
  rows: Record<string, string>[]
): Promise<{ ok: boolean; message: string | null }> {
  let { st, message } = terminalFetchStatus(rows);
  const deadline = Date.now() + 12_000;

  while (!['finished', 'ok', 'failed'].includes(st) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const pending = (await api.write('/tool/fetch/print', ['=.proplist=status,message'])) as Record<string, string>[];
    const next = terminalFetchStatus(pending);
    st = next.st;
    if (next.message) message = next.message;
  }

  if (st === 'finished' || st === 'ok') return { ok: true, message: null };
  return { ok: false, message: message || (st === 'failed' ? 'fetch failed' : 'fetch timeout') };
}

function extractImmediateFetchResult(rows: Record<string, string>[] | undefined) {
  for (const row of rows || []) {
    const st = String(row.status || '').toLowerCase();
    if (st === 'finished' || st === 'ok') return { ok: true as const, message: null };
    if (st === 'failed') return { ok: false as const, message: row.message || row.ret || 'fetch failed' };
  }
  return null;
}

async function removeProbeFile(api: RouterOSAPI, name: string) {
  try {
    await api.write('/file/remove', [`=.id=${name}`]);
  } catch {
    try {
      await api.write('/file/remove', [`=numbers=${name}`]);
    } catch {
      /* ignore */
    }
  }
}

/**
 * RouterOS 7.20 API rejects many output=/keep-result= combinations with
 * "please use 'output' option". Writing to a temp file (default output=file)
 * is the reliable API path; CLI as-value/output=none still works in Winbox.
 */
async function attemptRouterFetch(api: RouterOSAPI, fetchUrl: string): Promise<{ ok: boolean; message: string | null }> {
  const dst = `mtb-probe-${Date.now() % 1_000_000}.tmp`;
  await removeStaleFetches(api);
  await cancelFetchTool(api);
  await removeProbeFile(api, dst);

  let lastError: string | null = null;
  try {
    const rows = (await api.write('/tool/fetch', [
      `=url=${fetchUrl}`,
      `=dst-path=${dst}`,
      '=check-certificate=no',
      '=http-method=get',
    ])) as Record<string, string>[];
    const immediate = extractImmediateFetchResult(rows);
    const result = immediate ?? (await waitForRouterFetch(api, rows));
    if (result.ok) {
      await removeProbeFile(api, dst);
      return result;
    }
    lastError = result.message;
    if (lastError?.toLowerCase().includes('output')) {
      const rows2 = (await api.write('/tool/fetch', [
        `=url=${fetchUrl}`,
        '=as-value=',
        '=output=none',
        '=check-certificate=no',
      ])) as Record<string, string>[];
      const immediate2 = extractImmediateFetchResult(rows2);
      const result2 = immediate2 ?? (await waitForRouterFetch(api, rows2));
      if (result2.ok) return result2;
      lastError = result2.message || lastError;
    }
  } catch (e: unknown) {
    lastError = rosErrorMessage(e);
  } finally {
    await cancelFetchTool(api);
    await removeProbeFile(api, dst);
    await removeStaleFetches(api);
  }
  return { ok: false, message: lastError };
}

async function resolveHostViaRouter(api: RouterOSAPI, host: string): Promise<string | null> {
  try {
    const rows = (await api.write('/resolve', [`=domain-name=${host}`])) as Record<string, string>[];
    const ip = rows?.[0]?.['ret'] || rows?.[0]?.address || rows?.[0]?.['ip'];
    return ip ? String(ip) : null;
  } catch {
    try {
      const rows = (await api.write('/resolve', [`=address=${host}`])) as Record<string, string>[];
      const ip = rows?.[0]?.['ret'] || rows?.[0]?.address;
      return ip ? String(ip) : null;
    } catch {
      return null;
    }
  }
}

async function probePingHost(
  api: RouterOSAPI,
  host: string,
  start: number
): Promise<RouterHttpProbeResult | null> {
  const address = (await resolveHostViaRouter(api, host)) || host;
  // RouterOS defaults to a 1s gap between packets when =interval isn't set,
  // which for count=2 pads every single latency reading by a full second —
  // set it explicitly everywhere so a probe reflects real network RTT.
  const attempts: string[][] = [
    [`=address=${address}`, '=count=2', '=interval=100ms'],
    [`=address=${address}`, '=count=2', '=interval=500ms'],
    [`=address=${host}`, '=count=2', '=interval=100ms'],
  ];

  for (const args of attempts) {
    try {
      const pingRows = (await api.write('/ping', args)) as Record<string, string>[];
      const ms = parsePingAvgMs(pingRows);
      const received =
        pingRows?.filter((p) => {
          if (p.time || p['avg-rtt']) return true;
          if (Number(p.received) > 0) return true;
          const st = String(p.status || '').toLowerCase();
          return st === '' || st === 'echo reply';
        }).length ?? 0;
      if (received > 0) {
        const latency = ms ?? Math.round(performance.now() - start);
        const status = latency > 2500 ? 'degraded' : 'up';
        return { up: true, status, ms: latency, code: 0, error: null };
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

async function probeHttpUrlWithApi(
  api: RouterOSAPI,
  url: string,
  start = performance.now()
): Promise<RouterHttpProbeResult> {
  const { host, fetchUrl } = parseProbeUrl(url);

  // Prefer ICMP: avoids RouterOS 7 API /tool fetch "output" traps when WAN works.
  const pinged = await probePingHost(api, host, start);
  if (pinged) return pinged;

  const fetched = await attemptRouterFetch(api, fetchUrl);
  if (fetched.ok) {
    const ms = Math.round(performance.now() - start);
    const degraded = ms > 2500;
    return { up: true, status: degraded ? 'degraded' : 'up', ms, code: 200, error: null };
  }

  const msg = fetched.message || 'unreachable from router';
  // Never surface the ROS7 API syntax trap as a service outage reason.
  const clean =
    msg.toLowerCase().includes('output') || msg.toLowerCase().includes('keep-result')
      ? 'host unreachable (ping/fetch failed from router)'
      : msg;

  return {
    up: false,
    status: 'down',
    ms: null,
    code: 0,
    error: clean,
  };
}

/**
 * HTTP/HTTPS reachability probe executed on a MikroTik router (subscriber WAN perspective).
 * Uses /tool fetch when available, with ICMP ping fallback on the URL host.
 */
export async function probeHttpUrlFromRouter(
  conn: RouterConn,
  url: string,
  opts?: { timeoutSec?: number }
): Promise<RouterHttpProbeResult> {
  const start = performance.now();
  try {
    return await withRouter(conn, (api) => probeHttpUrlWithApi(api, url, start), { timeoutSec: opts?.timeoutSec ?? 15 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { up: false, status: 'down', ms: null, code: 0, error: msg || 'router error' };
  }
}

/**
 * Probe many URLs over one RouterOS API session.
 * MikroTik allows only one active /tool fetch per API channel — probes run sequentially.
 */
export async function probeHttpUrlsFromRouter(
  conn: RouterConn,
  urls: string[],
  opts?: { timeoutSec?: number; concurrency?: number }
): Promise<RouterHttpProbeResult[]> {
  void opts?.concurrency;
  return withRouter(
    conn,
    async (api) => {
      const out: RouterHttpProbeResult[] = [];
      for (const url of urls) {
        const start = performance.now();
        try {
          out.push(await probeHttpUrlWithApi(api, url, start));
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          out.push({ up: false, status: 'down', ms: null, code: 0, error: msg || 'router error' });
        }
      }
      return out;
    },
    { timeoutSec: opts?.timeoutSec ?? Math.min(600, 30 + urls.length * 8) }
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Router-side grace/expiry enforcement (RouterOS /system scheduler).
 *
 * Billing enforcement normally runs from this panel's own 5-minute poller
 * (see notify.ts executeBillingEnforcement), which requires the panel to be
 * up and able to reach the router at the right moment. To guarantee grace
 * and expiration still take effect even if the panel is offline or cut off
 * from the router/cloud, we additionally provision two one-shot RouterOS
 * scheduler entries per subscriber — the router fires these itself:
 *   - "grace"   at the moment the account becomes overdue: switch the PPP
 *               secret to the non-payment profile.
 *   - "disable" at the moment the grace period ends: disable the secret
 *               and drop any active session.
 * Both are named deterministically so a later payment can find and remove
 * them (re-provisioning fresh ones for the new due date), which is how
 * "pay before it fires" cancellation works — no server-side timer to leak.
 * ──────────────────────────────────────────────────────────────────────── */

const SCHED_PREFIX = 'mtb-';
const ROS_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function schedName(kind: 'grace' | 'disable', username: string): string {
  return `${SCHED_PREFIX}${kind}-${username}`;
}

/** Escape a value for safe interpolation inside a RouterOS script string literal. */
function rosScriptEscape(s: string): string {
  return String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Parse RouterOS's own reported clock (either "mon/dd/yyyy" or "yyyy-mm-dd") as if it were UTC. */
function parseRosClockAsUtc(dateStr?: string, timeStr?: string): number | null {
  if (!dateStr || !timeStr) return null;
  let y: number, mo: number, da: number;
  const mon = /^([a-z]{3})\/(\d{2})\/(\d{4})$/i.exec(dateStr.trim());
  if (mon) {
    mo = ROS_MONTHS.indexOf(mon[1].toLowerCase());
    da = Number(mon[2]);
    y = Number(mon[3]);
  } else {
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
    if (!iso) return null;
    y = Number(iso[1]);
    mo = Number(iso[2]) - 1;
    da = Number(iso[3]);
  }
  if (mo < 0 || !y || !da) return null;
  const [hh, mm, ss] = timeStr.trim().split(':').map(Number);
  return Date.UTC(y, mo, da, hh || 0, mm || 0, ss || 0);
}

/** Router's wall-clock offset from this server's clock (handles routers set to a local timezone, not UTC). */
async function getRouterClockOffsetMs(api: RouterOSAPI): Promise<number> {
  try {
    const rows = (await api.write('/system/clock/print')) as Record<string, string>[];
    const routerAsUtc = parseRosClockAsUtc(rows?.[0]?.date, rows?.[0]?.time);
    return routerAsUtc == null ? 0 : routerAsUtc - Date.now();
  } catch {
    return 0;
  }
}

/** Render an absolute instant as RouterOS scheduler start-date/start-time, adjusted for the router's own clock. */
function rosScheduleFields(at: Date, offsetMs: number): { date: string; time: string } {
  const wall = new Date(at.getTime() + offsetMs);
  const date = `${ROS_MONTHS[wall.getUTCMonth()]}/${String(wall.getUTCDate()).padStart(2, '0')}/${wall.getUTCFullYear()}`;
  const time = `${String(wall.getUTCHours()).padStart(2, '0')}:${String(wall.getUTCMinutes()).padStart(2, '0')}:${String(wall.getUTCSeconds()).padStart(2, '0')}`;
  return { date, time };
}

async function removeSchedulerByName(api: RouterOSAPI, name: string): Promise<void> {
  // Prefer direct remove by name — `/system/scheduler/print` hangs on some boards.
  try {
    await raceApi(
      api.write('/system/scheduler/remove', [`=numbers=${name}`]),
      5_000,
      'sched-remove'
    );
  } catch {
    /* missing entry or transient — do not fall back to print (can hang) */
  }
}

async function removeSystemScriptByName(api: RouterOSAPI, name: string): Promise<void> {
  try {
    await raceApi(
      api.write('/system/script/remove', [`=numbers=${name}`]),
      5_000,
      'script-remove'
    );
  } catch {
    /* missing entry or transient — do not fall back to print (can hang) */
  }
}

function raceApi<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/**
 * Remove any pending grace/disable scheduler entries for a username. Call
 * this whenever an account is no longer heading toward disconnection on its
 * own (payment processed, manually re-enabled, or deleted) so a stale
 * schedule can't act on it later.
 */
export async function cancelExpiryScheduleOnRouter(conn: RouterConn, username: string): Promise<void> {
  if (!username) return;
  // Short timeout — this rides along with an already-latency-sensitive request
  // (payment, manual toggle, delete) and is best-effort, not the primary action.
  await withRouter(
    conn,
    async (api) => {
      await removeSchedulerByName(api, schedName('grace', username));
      await removeSchedulerByName(api, schedName('disable', username));
      await removeSystemScriptByName(api, schedName('grace', username));
      await removeSystemScriptByName(api, schedName('disable', username));
    },
    { timeoutSec: 8 }
  );
}

/**
 * Provision one-shot RouterOS scheduler entries so grace-switch and full
 * disable happen on the router itself at the right time, independent of
 * this panel's uptime. Always removes any existing entries for the
 * username first, so re-running this (e.g. after a new payment) replaces
 * the old schedule with one for the new due date.
 *
 * Scripts live under /system/script (Winbox → System → Scripts) and are
 * invoked by matching /system/scheduler one-shots — same pattern as classic
 * MikroTik non-payment / expire automation.
 */
export async function scheduleExpiryOnRouter(
  conn: RouterConn,
  opts: { username: string; graceAt: Date; disableAt: Date; nonPaymentProfile: string }
): Promise<void> {
  const { username, graceAt, disableAt, nonPaymentProfile } = opts;
  if (!username) return;
  await withRouter(conn, async (api) => {
    const graceName = schedName('grace', username);
    const disableName = schedName('disable', username);
    await removeSchedulerByName(api, graceName);
    await removeSchedulerByName(api, disableName);
    await removeSystemScriptByName(api, graceName);
    await removeSystemScriptByName(api, disableName);

    const offsetMs = await getRouterClockOffsetMs(api);
    const u = rosScriptEscape(username);
    const expireProf = rosScriptEscape(nonPaymentProfile);
    // Skip past start times — RouterOS one-shots with a past clock often never
    // fire. The panel applies overdue actions immediately; only future events
    // belong on the router so grace/disable still work while the server is offline.
    const skewMs = 15_000;
    const nowWall = Date.now() + offsetMs;
    const scheduleGrace = graceAt.getTime() + offsetMs > nowWall + skewMs;
    const scheduleDisable = disableAt.getTime() + offsetMs > nowWall + skewMs;

    if (scheduleGrace) {
      const grace = rosScheduleFields(graceAt, offsetMs);
      // Switch to non-payments AND drop active so the CPE redials into the
      // non-payment IP pool (web-proxy captive / error.html).
      const graceSource =
        `:do {/ppp secret set [find name="${u}"] profile="${expireProf}" disabled=no;/ppp active remove [find name="${u}"]} on-error={}`;
      try {
        await raceApi(
          api.write('/system/script/add', [
            `=name=${graceName}`,
            `=source=${graceSource}`,
            '=dont-require-permissions=yes',
            '=comment=MT-Billing auto grace-switch (non-payment profile + kick)',
          ]),
          8_000,
          'script-add-grace'
        );
        await raceApi(
          api.write('/system/scheduler/add', [
            `=name=${graceName}`,
            `=start-date=${grace.date}`,
            `=start-time=${grace.time}`,
            '=interval=0',
            `=on-event=${graceName}`,
            '=comment=MT-Billing auto grace-switch',
          ]),
          8_000,
          'sched-add-grace'
        );
      } catch {
        // Fallback: classic inline on-event (no /system/script entry).
        await api.write('/system/scheduler/add', [
          `=name=${graceName}`,
          `=start-date=${grace.date}`,
          `=start-time=${grace.time}`,
          '=interval=0',
          `=on-event=${graceSource}`,
          '=comment=MT-Billing auto grace-switch',
        ]);
      }
    }

    if (scheduleDisable) {
      const disable = rosScheduleFields(disableAt, offsetMs);
      const disableSource =
        `:do {/ppp secret disable [find name="${u}"];/ppp active remove [find name="${u}"]} on-error={}`;
      try {
        await raceApi(
          api.write('/system/script/add', [
            `=name=${disableName}`,
            `=source=${disableSource}`,
            '=dont-require-permissions=yes',
            '=comment=MT-Billing auto disable past grace',
          ]),
          8_000,
          'script-add-disable'
        );
        await raceApi(
          api.write('/system/scheduler/add', [
            `=name=${disableName}`,
            `=start-date=${disable.date}`,
            `=start-time=${disable.time}`,
            '=interval=0',
            `=on-event=${disableName}`,
            '=comment=MT-Billing auto disable',
          ]),
          8_000,
          'sched-add-disable'
        );
      } catch {
        await api.write('/system/scheduler/add', [
          `=name=${disableName}`,
          `=start-date=${disable.date}`,
          `=start-time=${disable.time}`,
          '=interval=0',
          `=on-event=${disableSource}`,
          '=comment=MT-Billing auto disable',
        ]);
      }
    }
  }, { timeoutSec: 8 });
}

const BILLING_EXPIRE_SCRIPT = 'mtb-billing-expire';
const BILLING_EXPIRE_SCHEDULER = 'mtb-billing-expire';

/**
 * Global RouterOS expire scanner (System → Scripts).
 * Compact single-line body (API-safe). Reads dueDate / expireProfile from PPP
 * secret comment JSON via find/pick and switches overdue secrets to the
 * non-payment profile so they redial into the captive pool → error.html.
 */
export function buildBillingExpireScriptSource(nonPaymentProfile = 'non-payments'): string {
  const prof = rosScriptEscape(nonPaymentProfile || 'non-payments');
  // Semicolon-separated one-liner — avoids multiline API word issues.
  return (
    `:local expireProfile "${prof}";` +
    `:local today [/system clock get date];` +
    `:local mon [:pick $today 0 3];` +
    `:local dd [:pick $today 4 6];` +
    `:local yyyy [:pick $today 7 11];` +
    `:local months {"jan"="01";"feb"="02";"mar"="03";"apr"="04";"may"="05";"jun"="06";"jul"="07";"aug"="08";"sep"="09";"oct"="10";"nov"="11";"dec"="12"};` +
    `:local mm ($months->$mon);` +
    `:if ([:len $mm] = 0) do={ :return };` +
    `:local todayIso ($yyyy . "-" . $mm . "-" . $dd);` +
    `:local dueMarker "\\"dueDate\\":\\"";` +
    `:local expMarker "\\"expireProfile\\":\\"";` +
    `:foreach i in=[/ppp secret find where disabled=no] do={` +
    `:local name [/ppp secret get $i name];` +
    `:local profile [/ppp secret get $i profile];` +
    `:local comment [/ppp secret get $i comment];` +
    `:if ([:len $comment] > 12) do={` +
    `:do {` +
    `:local p [:find $comment $dueMarker];` +
    `:if ($p != nil) do={` +
    `:local dueStart ($p + [:len $dueMarker]);` +
    `:local due [:pick $comment $dueStart ($dueStart + 10)];` +
    `:local expProf $expireProfile;` +
    `:local ep [:find $comment $expMarker];` +
    `:if ($ep != nil) do={` +
    `:local epStart ($ep + [:len $expMarker]);` +
    `:local epRaw [:pick $comment $epStart ($epStart + 32)];` +
    `:local epEnd [:find $epRaw "\\""];` +
    `:if ($epEnd != nil && $epEnd > 0) do={ :set expProf [:pick $epRaw 0 $epEnd] }` +
    `};` +
    `:if ([:len $due] = 10 && $due < $todayIso && $profile != $expProf) do={` +
    `/ppp secret set $i profile=$expProf disabled=no;` +
    `:do { /ppp active remove [find name=$name] } on-error={};` +
    `:log info ("MT-Billing expire: " . $name . " due " . $due . " -> " . $expProf)` +
    `}` +
    `}` +
    `} on-error={}` +
    `}` +
    `}`
  );
}

/** Install/replace the global billing-expire system script + 5-minute scheduler. */
export async function ensureBillingExpireSystemScript(
  conn: RouterConn,
  opts?: { nonPaymentProfile?: string; interval?: string }
): Promise<{ script: string; scheduler: string; interval: string }> {
  const nonPaymentProfile = opts?.nonPaymentProfile || 'non-payments';
  const interval = opts?.interval || '00:05:00';
  const source = buildBillingExpireScriptSource(nonPaymentProfile);
  await withRouter(
    conn,
    async (api) => {
      await removeSchedulerByName(api, BILLING_EXPIRE_SCHEDULER);
      await removeSystemScriptByName(api, BILLING_EXPIRE_SCRIPT);
      try {
        await raceApi(
          api.write('/system/script/add', [
            `=name=${BILLING_EXPIRE_SCRIPT}`,
            `=source=${source}`,
            '=dont-require-permissions=yes',
            '=comment=MT-Billing: overdue PPP secrets → non-payment profile (captive error.html)',
          ]),
          12_000,
          'add-expire-script'
        );
      } catch {
        // Already present (remove may have been a no-op) — overwrite source.
        await raceApi(
          api.write('/system/script/set', [
            `=numbers=${BILLING_EXPIRE_SCRIPT}`,
            `=source=${source}`,
            '=dont-require-permissions=yes',
            '=comment=MT-Billing: overdue PPP secrets → non-payment profile (captive error.html)',
          ]),
          12_000,
          'set-expire-script'
        );
      }
      try {
        await raceApi(
          api.write('/system/scheduler/add', [
            `=name=${BILLING_EXPIRE_SCHEDULER}`,
            '=start-time=startup',
            `=interval=${interval}`,
            `=on-event=${BILLING_EXPIRE_SCRIPT}`,
            '=comment=MT-Billing periodic expire scan',
          ]),
          8_000,
          'add-expire-sched'
        );
      } catch {
        await raceApi(
          api.write('/system/scheduler/set', [
            `=numbers=${BILLING_EXPIRE_SCHEDULER}`,
            '=start-time=startup',
            `=interval=${interval}`,
            `=on-event=${BILLING_EXPIRE_SCRIPT}`,
            '=comment=MT-Billing periodic expire scan',
            '=disabled=no',
          ]),
          8_000,
          'set-expire-sched'
        );
      }
    },
    { timeoutSec: 25 }
  );
  return { script: BILLING_EXPIRE_SCRIPT, scheduler: BILLING_EXPIRE_SCHEDULER, interval };
}

export async function fetchSystemScripts(
  conn: RouterConn,
  opts?: { includeSource?: boolean }
): Promise<{ id: string; name: string; owner: string; policy: string; comment: string; source: string }[]> {
  const includeSource = !!opts?.includeSource;
  return withRouter(
    conn,
    async (api) => {
      const props = includeSource
        ? '=.proplist=.id,name,owner,policy,comment,source'
        : '=.proplist=.id,name,owner,policy,comment';
      const rows = (await raceApi(
        api.write('/system/script/print', [props]),
        15_000,
        'script-print'
      )) as Record<string, string>[];
      return (rows || []).map((s) => ({
        id: s['.id'] || '',
        name: s.name || '',
        owner: s.owner || '',
        policy: s.policy || '',
        comment: s.comment || '',
        source: includeSource ? s.source || '' : '',
      }));
    },
    { timeoutSec: 20 }
  );
}

export async function fetchSystemSchedulers(conn: RouterConn): Promise<
  {
    id: string;
    name: string;
    startDate: string;
    startTime: string;
    interval: string;
    onEvent: string;
    comment: string;
    disabled: boolean;
  }[]
> {
  return withRouter(
    conn,
    async (api) => {
      try {
        const rows = (await raceApi(
          api.write('/system/scheduler/print', [
            '=.proplist=.id,name,start-date,start-time,interval,on-event,comment,disabled',
          ]),
          8_000,
          'sched-print'
        )) as Record<string, string>[];
        return (rows || []).map((s) => ({
          id: s['.id'] || '',
          name: s.name || '',
          startDate: s['start-date'] || '',
          startTime: s['start-time'] || '',
          interval: s.interval || '',
          onEvent: s['on-event'] || '',
          comment: s.comment || '',
          disabled: rosBool(s.disabled),
        }));
      } catch {
        // Some RouterOS builds hang on full scheduler print via API.
        return [];
      }
    },
    { timeoutSec: 12 }
  );
}

const WEBPROXY_RULE_COMMENT = 'MT-Billing nonpay captive';
const NONPAY_HTTPS_LIST = 'nonpay-https-allow';
const NONPAY_POOL_NAME = 'non-payment';
const NONPAY_NAT = {
  httpRedirect: 'MT-Billing nonpay HTTP redirect',
  httpRedirectCidr: 'MT-Billing nonpay HTTP redirect CIDR',
  httpsAllow: 'MT-Billing nonpay HTTPS allow',
  httpsRedirect: 'MT-Billing nonpay HTTPS redirect',
  dnsBypassUdp: 'MT-Billing nonpay DNS bypass AdGuard',
  dnsBypassTcp: 'MT-Billing nonpay DNS bypass AdGuard TCP',
} as const;
const NONPAY_FW = {
  https: 'MT-Billing nonpay allow HTTPS billing',
  dnsUdp: 'MT-Billing nonpay allow DNS',
  dnsTcp: 'MT-Billing nonpay allow DNS TCP',
  http: 'MT-Billing nonpay allow HTTP captive',
  proxyInput: 'MT-Billing nonpay allow proxy input',
  rejectTcp: 'MT-Billing nonpay reject TCP fast',
  rejectQuic: 'MT-Billing nonpay reject QUIC fast',
  drop: 'MT-Billing nonpay drop other',
} as const;
const NONPAY_PROXY = {
  allowLanding: 'MT-Billing nonpay allow landing',
  denyCaptive: 'MT-Billing nonpay captive deny',
  redirectPortal: 'MT-Billing nonpay redirect portal',
} as const;

/** Management networks allowed to open WebFig / Winbox / SSH. */
const ROUTER_MGMT_LIST = 'mt-billing-mgmt';
const ROUTER_UI_BLOCK = 'MT-Billing block subscriber router UI';
const DEFAULT_ROUTER_MGMT_CIDRS = ['192.168.0.0/24', '20.0.0.0/24', '10.10.0.0/16'];

/**
 * Block PPPoE/IPoE subscribers from the MikroTik login UI (WebFig www/www-ssl,
 * Winbox, FTP, Telnet). Management stays on LAN/VPN CIDRs only.
 *
 * Captive non-pay traffic uses webproxy :8080 (not www :80), so this does not
 * break error.html → /portal.
 */
export async function restrictSubscriberRouterLogin(
  conn: RouterConn,
  opts: {
    mgmtCidrs?: string[];
    /** Also restrict SSH to mgmt CIDRs (default true). */
    lockSsh?: boolean;
  } = {}
): Promise<{
  ok: true;
  mgmtCidrs: string[];
  servicesRestricted: string[];
  filterAdded: boolean;
  mgmtListEnsured: string[];
}> {
  const mgmtCidrs = [
    ...new Set(
      (opts.mgmtCidrs?.length ? opts.mgmtCidrs : DEFAULT_ROUTER_MGMT_CIDRS)
        .map((c) => String(c || '').trim())
        .filter(Boolean)
    ),
  ];
  const lockSsh = opts.lockSsh !== false;
  const addressCsv = mgmtCidrs.join(',');

  return withRouter(
    conn,
    async (api) => {
      const addrList = (await api.write('/ip/firewall/address-list/print')) as Record<string, string>[];
      const mgmtListEnsured: string[] = [];
      for (const cidr of mgmtCidrs) {
        const exists = (addrList || []).some(
          (r) => String(r.list || '') === ROUTER_MGMT_LIST && String(r.address || '') === cidr
        );
        if (exists) continue;
        try {
          await api.write('/ip/firewall/address-list/add', [
            `=list=${ROUTER_MGMT_LIST}`,
            `=address=${cidr}`,
            `=comment=${ROUTER_UI_BLOCK}`,
          ]);
          mgmtListEnsured.push(cidr);
          addrList.push({ list: ROUTER_MGMT_LIST, address: cidr });
        } catch {
          /* duplicate */
        }
      }

      const services = (await api.write('/ip/service/print')) as Record<string, string>[];
      const servicesRestricted: string[] = [];
      const lockNames = new Set(['www', 'www-ssl', 'winbox', 'ftp', 'telnet', ...(lockSsh ? ['ssh'] : [])]);
      for (const svc of services || []) {
        const name = String(svc.name || '');
        if (!lockNames.has(name)) continue;
        // Skip dynamic connection rows (RouterOS lists live sessions under /ip/service).
        const dyn = String(svc.dynamic || '').toLowerCase();
        if (dyn === 'true' || dyn === 'yes') continue;
        const id = svc['.id'];
        if (!id) continue;
        const current = String(svc.address || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .sort()
          .join(',');
        const want = [...mgmtCidrs].sort().join(',');
        if (current === want) continue;
        try {
          await api.write('/ip/service/set', [`=.id=${id}`, `=address=${addressCsv}`]);
          servicesRestricted.push(name);
        } catch {
          /* ignore single-service failure */
        }
      }

      const filters = (await api.write('/ip/firewall/filter/print')) as Record<string, string>[];
      let filterAdded = false;
      const hasBlock = (filters || []).some((r) => String(r.comment || '') === ROUTER_UI_BLOCK);
      if (!hasBlock) {
        // Drop WebFig/Winbox/FTP/Telnet from anyone outside management.
        // Proxy captive (:8080) is unaffected. Place near top of input chain.
        const proxyAllowId =
          (filters || []).find((r) => String(r.comment || '') === NONPAY_FW.proxyInput)?.['.id'] || '';
        try {
          await api.write('/ip/firewall/filter/add', [
            '=chain=input',
            '=action=drop',
            '=protocol=tcp',
            `=src-address-list=!${ROUTER_MGMT_LIST}`,
            '=dst-port=80,443,8291,21,23',
            `=comment=${ROUTER_UI_BLOCK}`,
            ...(proxyAllowId ? [`=place-before=${proxyAllowId}`] : ['=place-before=0']),
          ]);
          filterAdded = true;
        } catch {
          filterAdded = false;
        }
      }

      return {
        ok: true as const,
        mgmtCidrs,
        servicesRestricted,
        filterAdded,
        mgmtListEnsured,
      };
    },
    { timeoutSec: 30 }
  );
}

/**
 * Expand a /24 (or similar) CIDR into an IP pool range usable by RouterOS.
 * Example: 172.15.10.0/24 → 172.15.10.2-172.15.10.254
 */
export function cidrToPoolRanges(cidr: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(cidr || '').trim());
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  const prefix = Number(m[5]);
  if (parts.some((n) => n > 255) || prefix < 8 || prefix > 30) return null;
  if (prefix === 24) {
    const base = `${parts[0]}.${parts[1]}.${parts[2]}`;
    return `${base}.2-${base}.254`;
  }
  // Conservative fallback for other prefixes: keep host+1 .. last usable as dotted range via /24 style when possible
  const hostBits = 32 - prefix;
  const size = 2 ** hostBits;
  if (size < 4 || size > 65536) return null;
  const ipNum = ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
  const network = ipNum >>> hostBits << hostBits;
  const first = network + 2;
  const last = network + size - 2;
  const toIp = (n: number) =>
    [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
  return `${toIp(first)}-${toIp(last)}`;
}

function natRuleDisabled(n: Record<string, string>): boolean {
  return rosBool(n.disabled);
}

/** True when a dstnat rule actually redirects non-pay HTTP to the webproxy port. */
function isWorkingNonPayHttpRedirect(
  n: Record<string, string>,
  opts: { nonPayCidr: string; nonPayAddressList: string; proxyPort: number }
): boolean {
  if (String(n.chain || '') !== 'dstnat') return false;
  if (String(n.action || '').toLowerCase() !== 'redirect') return false;
  if (natRuleDisabled(n)) return false;
  const proto = String(n.protocol || '').toLowerCase();
  if (proto && proto !== 'tcp') return false;
  if (String(n['dst-port'] || '') !== '80') return false;
  if (String(n['to-ports'] || '') !== String(opts.proxyPort)) return false;
  const srcList = String(n['src-address-list'] || '');
  const srcAddr = String(n['src-address'] || '');
  return srcList === opts.nonPayAddressList || srcAddr === opts.nonPayCidr;
}

/**
 * Ensure the captive non-payment IP pool + PPP profile so overdue secrets
 * redial into 172.15.10.0/24 (webproxy NAT match). Without this, Admin can be
 * on profile "non-payments" but still get a normal pool → no redirect.
 */
export async function ensureNonPaymentCaptiveProfile(
  api: RouterOSAPI,
  opts: {
    profileName?: string;
    poolName?: string;
    nonPayCidr?: string;
    landingAddress?: string;
    rateLimit?: string;
  } = {}
): Promise<{
  profileName: string;
  poolName: string;
  nonPayCidr: string;
  poolRanges: string;
  remoteAddress: string;
  localAddress: string;
  createdPool: boolean;
  createdProfile: boolean;
  updatedProfile: boolean;
}> {
  const profileName = String(opts.profileName || 'non-payments').trim() || 'non-payments';
  const nonPayCidr = String(opts.nonPayCidr || '172.15.10.0/24').trim();
  const landingAddress = String(opts.landingAddress || '1.1.10.1').trim();
  const rateLimit = String(opts.rateLimit || '2M/2M').trim();
  const poolRanges = cidrToPoolRanges(nonPayCidr) || '172.15.10.2-172.15.10.254';
  const cidrPrefix = nonPayCidr.split('/')[0].split('.').slice(0, 3).join('.');

  let createdPool = false;
  const pools = (await api.write('/ip/pool/print')) as Record<string, string>[];
  // Prefer an existing pool already covering the captive CIDR (often named "non-payments").
  const preferredNames = [
    String(opts.poolName || '').trim(),
    profileName,
    NONPAY_POOL_NAME,
    'non-payments',
    'non-payment',
  ].filter(Boolean);
  let poolRow =
    (pools || []).find((p) => preferredNames.includes(String(p.name || ''))) ||
    (pools || []).find((p) => String(p.ranges || '').includes(cidrPrefix)) ||
    null;
  let poolName = poolRow ? String(poolRow.name || '') : String(opts.poolName || NONPAY_POOL_NAME).trim() || NONPAY_POOL_NAME;

  if (!poolRow) {
    await api.write('/ip/pool/add', [
      `=name=${poolName}`,
      `=ranges=${poolRanges}`,
      `=comment=${WEBPROXY_RULE_COMMENT}`,
    ]);
    createdPool = true;
  } else {
    const ranges = String(poolRow.ranges || '');
    if (!ranges.includes(cidrPrefix)) {
      try {
        await raceApi(
          api.write('/ip/pool/set', [`=.id=${poolRow['.id']}`, `=ranges=${poolRanges}`]),
          5_000,
          'pool-set'
        );
      } catch {
        /* keep existing ranges if in use by active PPP */
      }
    }
  }

  let createdProfile = false;
  let updatedProfile = false;
  const profiles = (await api.write('/ppp/profile/print')) as Record<string, string>[];
  const prof = (profiles || []).find((p) => String(p.name || '') === profileName);
  if (!prof) {
    await api.write('/ppp/profile/add', [
      `=name=${profileName}`,
      `=local-address=${landingAddress}`,
      `=remote-address=${poolName}`,
      `=rate-limit=${rateLimit}`,
      `=comment=${WEBPROXY_RULE_COMMENT}`,
    ]);
    createdProfile = true;
  } else {
    const remote = String(prof['remote-address'] || '');
    const local = String(prof['local-address'] || '');
    const args = [`=.id=${prof['.id']}`];
    // Only rewrite remote-address when it does not already point at the captive pool/CIDR.
    const remoteOk =
      remote === poolName ||
      remote === nonPayCidr ||
      preferredNames.includes(remote) ||
      (pools || []).some(
        (p) => String(p.name || '') === remote && String(p.ranges || '').includes(cidrPrefix)
      );
    if (!remoteOk) args.push(`=remote-address=${poolName}`);
    if (!local) args.push(`=local-address=${landingAddress}`);
    if (!String(prof['rate-limit'] || '') && rateLimit) args.push(`=rate-limit=${rateLimit}`);
    if (args.length > 1) {
      await raceApi(api.write('/ppp/profile/set', args), 8_000, 'profile-set');
      updatedProfile = true;
    }
  }

  const refreshed = (await api.write('/ppp/profile/print', [`?name=${profileName}`])) as Record<
    string,
    string
  >[];
  const live = refreshed?.[0] || {};
  return {
    profileName,
    poolName,
    nonPayCidr,
    poolRanges,
    remoteAddress: live['remote-address'] || poolName,
    localAddress: live['local-address'] || landingAddress,
    createdPool,
    createdProfile,
    updatedProfile,
  };
}

/**
 * Snapshot of captive ingredients on the router (for debugging "no redirect").
 */
export async function inspectNonPaymentCaptive(
  conn: RouterConn,
  opts: {
    nonPayCidr?: string;
    landingAddress?: string;
    proxyPort?: number;
    nonPayAddressList?: string;
    profileName?: string;
    username?: string;
  } = {}
): Promise<Record<string, unknown>> {
  const nonPayCidr = String(opts.nonPayCidr || '172.15.10.0/24').trim();
  const landingAddress = String(opts.landingAddress || '1.1.10.1').trim();
  const proxyPort = Math.max(1, Math.floor(Number(opts.proxyPort) || 8080));
  const nonPayAddressList = String(opts.nonPayAddressList || 'non-payment').trim() || 'non-payment';
  const profileName = String(opts.profileName || 'non-payments').trim() || 'non-payments';
  const username = String(opts.username || '').trim();

  return withRouter(
    conn,
    async (api) => {
      const proxy = ((await api.write('/ip/proxy/print')) as Record<string, string>[])?.[0] || {};
      const access = (await api.write('/ip/proxy/access/print')) as Record<string, string>[];
      const nats = (await api.write('/ip/firewall/nat/print')) as Record<string, string>[];
      const addrList = (await api.write('/ip/firewall/address-list/print')) as Record<string, string>[];
      const pools = (await api.write('/ip/pool/print')) as Record<string, string>[];
      const profiles = (await api.write('/ppp/profile/print')) as Record<string, string>[];
      const secrets = username
        ? ((await api.write('/ppp/secret/print', [`?name=${username}`])) as Record<string, string>[])
        : [];
      const active = username
        ? ((await api.write('/ppp/active/print', [`?name=${username}`])) as Record<string, string>[])
        : [];

      const httpRedirects = (nats || []).filter((n) =>
        isWorkingNonPayHttpRedirect(n, { nonPayCidr, nonPayAddressList, proxyPort })
      );
      const taggedRedirects = (nats || []).filter((n) => {
        const c = String(n.comment || '');
        return (
          c === NONPAY_NAT.httpRedirect ||
          c === NONPAY_NAT.httpRedirectCidr ||
          c === 'non-payment'
        );
      });
      const profile = (profiles || []).find((p) => String(p.name || '') === profileName) || null;
      const pool =
        (pools || []).find((p) => String(p.name || '') === NONPAY_POOL_NAME) ||
        (pools || []).find((p) => String(p.name || '') === String(profile?.['remote-address'] || '')) ||
        null;

      const secret = secrets?.[0] || null;
      const session = active?.[0] || null;
      const sessionIp = String(session?.address || '');
      const inNonPayCidr =
        !!sessionIp &&
        sessionIp !== '-' &&
        (() => {
          try {
            const [net, bits] = nonPayCidr.split('/');
            const prefix = Number(bits || 24);
            const ipParts = sessionIp.split('.').map(Number);
            const netParts = net.split('.').map(Number);
            if (ipParts.length !== 4 || netParts.length !== 4) return false;
            const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
            const ipN =
              ((ipParts[0] << 24) >>> 0) + (ipParts[1] << 16) + (ipParts[2] << 8) + ipParts[3];
            const netN =
              ((netParts[0] << 24) >>> 0) + (netParts[1] << 16) + (netParts[2] << 8) + netParts[3];
            return (ipN & mask) === (netN & mask);
          } catch {
            return false;
          }
        })();

      const files = (await api.write('/file/print', ['=.proplist=name,size'])) as Record<
        string,
        string
      >[];
      const errorHtml = (files || []).find((f) => {
        const n = String(f.name || '');
        return n === 'webproxy/error.html' || n.endsWith('/error.html') || n === 'error.html';
      });

      return {
        proxy: {
          enabled: proxy.enabled,
          port: proxy.port,
          anonymous: proxy.anonymous,
        },
        proxyAccess: (access || [])
          .filter((r) => String(r['src-address'] || '') === nonPayCidr || /nonpay|non-pay/i.test(String(r.comment || '')))
          .map((r) => ({
            id: r['.id'],
            action: r.action,
            src: r['src-address'],
            dstHost: r['dst-host'],
            dstAddress: r['dst-address'],
            redirectTo: r['redirect-to'] || '',
            comment: r.comment,
            disabled: rosBool(r.disabled),
          })),
        addressList: (addrList || [])
          .filter((r) => String(r.list || '') === nonPayAddressList)
          .map((r) => ({
            list: r.list,
            address: r.address,
            comment: r.comment,
            disabled: rosBool(r.disabled),
          })),
        httpRedirectWorking: httpRedirects.length > 0,
        httpRedirects: httpRedirects.map((n) => ({
          id: n['.id'],
          comment: n.comment,
          srcAddress: n['src-address'],
          srcAddressList: n['src-address-list'],
          toPorts: n['to-ports'],
          disabled: rosBool(n.disabled),
        })),
        taggedHttpRedirects: taggedRedirects.map((n) => ({
          id: n['.id'],
          comment: n.comment,
          action: n.action,
          srcAddress: n['src-address'],
          srcAddressList: n['src-address-list'],
          toPorts: n['to-ports'],
          disabled: rosBool(n.disabled),
        })),
        profile: profile
          ? {
              name: profile.name,
              localAddress: profile['local-address'],
              remoteAddress: profile['remote-address'],
              rateLimit: profile['rate-limit'],
            }
          : null,
        pool: pool
          ? { name: pool.name, ranges: pool.ranges, comment: pool.comment }
          : null,
        errorHtml: errorHtml
          ? { name: errorHtml.name, size: Number(errorHtml.size || 0) }
          : null,
        secret: secret
          ? {
              name: secret.name,
              profile: secret.profile,
              disabled: rosBool(secret.disabled),
            }
          : null,
        session: session
          ? {
              name: session.name,
              address: session.address,
              profile: session.profile,
              uptime: session.uptime,
              inNonPayCidr,
            }
          : null,
        diagnosis: !secret
          ? username
            ? 'PPP secret not found on router'
            : 'No username requested'
          : rosBool(secret.disabled)
            ? 'Secret is disabled — cannot browse or hit captive'
            : String(secret.profile || '') !== profileName
              ? `Secret profile is "${secret.profile}" (want "${profileName}") — not in captive pool`
              : session && !inNonPayCidr
                ? `Online at ${sessionIp} outside ${nonPayCidr} — pool/profile mismatch; kick session after repair`
                : !session
                  ? 'Secret looks ready but offline — connect CPE then browse http://example.com'
                  : httpRedirects.length === 0
                    ? 'No working HTTP→webproxy NAT redirect'
                    : 'Looks configured — try plain HTTP (not HTTPS) or wait for HTTPS fail-fast'
            ,
      };
    },
    { timeoutSec: 25 }
  );
}

/**
 * Apply captive redirect via /system/script/run — avoids hung /ip/proxy API
 * print/set sessions observed on the live board.
 */
export async function repairNonPaymentHttpRedirectViaScript(
  conn: RouterConn,
  opts: {
    nonPayCidr?: string;
    proxyPort?: number;
    portalRedirectUrl?: string;
    username?: string;
  } = {}
): Promise<{ ok: true; ran: string; kicked?: string | null }> {
  const nonPayCidr = String(opts.nonPayCidr || '172.15.10.0/24').trim();
  const proxyPort = Math.max(1, Math.floor(Number(opts.proxyPort) || 8080));
  const portal = String(opts.portalRedirectUrl || 'https://panorth.tsogs.cloud/portal')
    .trim()
    .replace(/\/$/, '');
  const httpPortal = portal.replace(/^https:\/\//i, 'http://');
  const username = String(opts.username || '').trim();
  const scriptName = 'mtb-fix-captive';
  const u = rosScriptEscape(username);

  const source =
    `:do {/ip proxy set enabled=yes port=${proxyPort} anonymous=no} on-error={};` +
    `:do {/ip firewall address-list add list=non-payment address=${nonPayCidr} comment=mtb-nonpay} on-error={};` +
    `:do {/ip firewall nat remove [find comment=mtb-cidr-redir]} on-error={};` +
    `:do {/ip firewall nat add chain=dstnat action=redirect protocol=tcp src-address=${nonPayCidr} dst-port=80 to-ports=${proxyPort} comment=mtb-cidr-redir} on-error={};` +
    `:do {/ip proxy access remove [find comment=mtb-portal-redir]} on-error={};` +
    `:do {/ip proxy access add src-address=${nonPayCidr} action=deny redirect-to=${httpPortal} comment=mtb-portal-redir} on-error={};` +
    (username
      ? `:do {/ppp secret set [find name="${u}"] profile=non-payments disabled=no} on-error={};` +
        `:do {/ppp active remove [find name="${u}"]} on-error={};`
      : '');

  return withRouter(
    conn,
    async (api) => {
      await removeSystemScriptByName(api, scriptName);
      await api.write('/system/script/add', [
        `=name=${scriptName}`,
        `=source=${source}`,
        '=dont-require-permissions=yes',
        '=comment=MT-Billing one-shot captive redirect repair',
      ]);
      await api.write('/system/script/run', [`=number=${scriptName}`]);
      return { ok: true as const, ran: scriptName, kicked: username || null };
    },
    { timeoutSec: 20 }
  );
}

/**
 * Fast path: enable webproxy, ensure HTTP→8080 NAT, and set catch-all
 * proxy access redirect to the subscriber portal. Avoids full firewall
 * rebuild so it can run while the board is busy / recovering.
 */
export async function repairNonPaymentHttpRedirect(
  conn: RouterConn,
  opts: {
    nonPayCidr?: string;
    proxyPort?: number;
    nonPayAddressList?: string;
    portalRedirectUrl?: string;
    username?: string;
  } = {}
): Promise<{
  ok: true;
  proxyEnabled: boolean;
  natHttpRedirect: boolean;
  proxyRedirect: boolean;
  portalRedirectTo: string;
  kicked?: string | null;
}> {
  const nonPayCidr = String(opts.nonPayCidr || '172.15.10.0/24').trim();
  const proxyPort = Math.max(1, Math.floor(Number(opts.proxyPort) || 8080));
  const nonPayAddressList = String(opts.nonPayAddressList || 'non-payment').trim() || 'non-payment';
  const portalRedirectTo = String(opts.portalRedirectUrl || 'https://panorth.tsogs.cloud/portal')
    .trim()
    .replace(/\/$/, '');
  const username = String(opts.username || '').trim();

  return withRouter(
    conn,
    async (api) => {
      let proxyEnabled = false;
      try {
        await api.write('/ip/proxy/set', ['=enabled=yes', `=port=${proxyPort}`, '=anonymous=no']);
        proxyEnabled = true;
      } catch {
        try {
          await api.write('/ip/proxy/set', ['=enabled=yes']);
          proxyEnabled = true;
        } catch {
          proxyEnabled = false;
        }
      }

      const addrList = (await api.write('/ip/firewall/address-list/print')) as Record<string, string>[];
      const hasCidr = (addrList || []).some(
        (r) =>
          String(r.list || '') === nonPayAddressList &&
          String(r.address || '') === nonPayCidr &&
          !rosBool(r.disabled)
      );
      if (!hasCidr) {
        await api.write('/ip/firewall/address-list/add', [
          `=list=${nonPayAddressList}`,
          `=address=${nonPayCidr}`,
          `=comment=${WEBPROXY_RULE_COMMENT}`,
        ]);
      }

      const nats = (await api.write('/ip/firewall/nat/print')) as Record<string, string>[];
      const redirectOpts = { nonPayCidr, nonPayAddressList, proxyPort };
      const hasList = (nats || []).some(
        (n) =>
          isWorkingNonPayHttpRedirect(n, redirectOpts) &&
          String(n['src-address-list'] || '') === nonPayAddressList
      );
      const hasCidrNat = (nats || []).some(
        (n) =>
          isWorkingNonPayHttpRedirect(n, redirectOpts) &&
          String(n['src-address'] || '') === nonPayCidr
      );
      if (!hasList) {
        await api.write('/ip/firewall/nat/add', [
          '=chain=dstnat',
          '=action=redirect',
          `=to-ports=${proxyPort}`,
          '=protocol=tcp',
          `=src-address-list=${nonPayAddressList}`,
          '=dst-port=80',
          `=comment=${NONPAY_NAT.httpRedirect}`,
          '=place-before=0',
        ]);
      }
      if (!hasCidrNat) {
        await api.write('/ip/firewall/nat/add', [
          '=chain=dstnat',
          '=action=redirect',
          `=to-ports=${proxyPort}`,
          '=protocol=tcp',
          `=src-address=${nonPayCidr}`,
          '=dst-port=80',
          `=comment=${NONPAY_NAT.httpRedirectCidr}`,
          '=place-before=0',
        ]);
      }

      const access = (await api.write('/ip/proxy/access/print')) as Record<string, string>[];
      for (const row of access || []) {
        if (String(row['src-address'] || '') !== nonPayCidr) continue;
        const action = String(row.action || '').toLowerCase();
        const catchAll =
          !String(row['dst-host'] || '') &&
          !String(row['dst-address'] || '') &&
          (action === 'deny' || action === 'redirect');
        if (!catchAll) continue;
        try {
          await api.write('/ip/proxy/access/remove', [`=.id=${row['.id']}`]);
        } catch {
          /* ignore */
        }
      }

      let proxyRedirect = false;
      // RouterOS: redirect-to is set on a deny rule (HTTP 302 to portal).
      try {
        await api.write('/ip/proxy/access/add', [
          `=src-address=${nonPayCidr}`,
          '=action=deny',
          `=comment=${NONPAY_PROXY.redirectPortal}`,
        ]);
        const rows = (await api.write('/ip/proxy/access/print', [
          `?comment=${NONPAY_PROXY.redirectPortal}`,
          '=.proplist=.id,comment,action',
        ])) as Record<string, string>[];
        const id = rows?.[0]?.['.id'];
        if (id) {
          const targets = [
            portalRedirectTo,
            portalRedirectTo.replace(/^https:\/\//i, 'http://'),
            'https://panorth.tsogs.cloud/portal',
            'http://panorth.tsogs.cloud/portal',
          ];
          for (const to of [...new Set(targets)]) {
            try {
              await api.write('/ip/proxy/access/set', [`=.id=${id}`, `=redirect-to=${to}`]);
              proxyRedirect = true;
              break;
            } catch {
              /* try next URL form */
            }
          }
        }
      } catch {
        try {
          await api.write('/ip/proxy/access/add', [
            `=src-address=${nonPayCidr}`,
            '=action=deny',
            `=comment=${NONPAY_PROXY.denyCaptive}`,
          ]);
        } catch {
          /* ignore */
        }
        proxyRedirect = false;
      }

      let kicked: string | null = null;
      if (username) {
        try {
          const secrets = (await api.write('/ppp/secret/print', [
            `?name=${username}`,
            '=.proplist=.id,name,profile',
          ])) as Record<string, string>[];
          const sec = secrets?.[0];
          if (sec?.['.id']) {
            await api.write('/ppp/secret/set', [
              `=.id=${sec['.id']}`,
              '=profile=non-payments',
              '=disabled=no',
            ]);
          }
          const actives = (await api.write('/ppp/active/print', [
            `?name=${username}`,
            '=.proplist=.id,name',
          ])) as Record<string, string>[];
          for (const a of actives || []) {
            if (!a['.id']) continue;
            try {
              await api.write('/ppp/active/remove', [`=.id=${a['.id']}`]);
            } catch {
              /* ignore */
            }
          }
          kicked = username;
        } catch {
          kicked = null;
        }
      }

      return {
        ok: true as const,
        proxyEnabled,
        natHttpRedirect: true,
        proxyRedirect,
        portalRedirectTo,
        kicked,
      };
    },
    { timeoutSec: 25 }
  );
}

export type NonPaymentWebProxyOpts = {
  /** Non-payment PPP pool CIDR (default matches common Pa-North setup). */
  nonPayCidr?: string;
  /** Host clients may reach for the landing / webproxy page. */
  landingAddress?: string;
  /** Public billing hostname (subscriber portal + branding). */
  billingHost?: string;
  /** Extra hostnames allowed over HTTPS (PayMongo checkout, etc.). */
  allowHosts?: string[];
  /** Absolute URL of error.html — fetched onto the router as error.html when set. */
  errorPageUrl?: string;
  /**
   * Absolute portal URL used for webproxy action=redirect (HTTP captive).
   * Prefer this over deny→error.html when browsers ignore the interstitial file.
   */
  portalRedirectUrl?: string;
  proxyPort?: number;
  /**
   * When true (default), ensure forward firewall lockdown so non-pay clients
   * cannot browse past the captive interstitial except DNS + HTTP captive ports
   * + HTTPS to billing/PayMongo (subscriber portal payment path).
   */
  lockdownFirewall?: boolean;
  /** Firewall address-list name used for non-pay clients (NAT/filter). */
  nonPayAddressList?: string;
  /**
   * Optional billing LAN IPv4(s) allowed through webproxy (legacy / diagnostics).
   * Portal payment uses public HTTPS to billingHost, not these.
   */
  billingLanIps?: string[];
  /** Local port on landingAddress that dstnats to billing LAN HTTP (default 9080). */
  captiveApiPort?: number;
  /**
   * When true (default), restrict WebFig/Winbox so PPPoE subscribers cannot
   * open the MikroTik login page (mgmt LAN/VPN only).
   */
  lockRouterUi?: boolean;
  /** CIDRs allowed to open router admin UI (defaults: LAN + VPN). */
  routerMgmtCidrs?: string[];
};

/**
 * Non-payment captive setup for portal-pay flow:
 *  - HTTP :80 → NAT redirect to webproxy
 *  - Proxy access: allow portal/PayMongo/landing, then DENY (serves error.html)
 *  - HTTPS to portal/PayMongo allowed; other HTTPS dropped (no TLS→HTTP proxy
 *    redirect — that breaks PC browsers / never shows error.html)
 *
 * Never touches:
 *  - /ip address, pools, PPP profile local/remote addressing
 *  - existing untagged /ip proxy access rules (your redirect stays)
 *
 * Only:
 *  - adds missing dst-host allow rules (billing + PayMongo) tagged for idempotent refresh
 *  - optionally fetches error.html into webproxy/error.html
 *  - optionally ensures tagged forward filter lockdown (HTTPS bypass fix)
 *  - ensures dstnat landing:9080 → billing LAN:80 (preserves PPPoE source IP for captive API)
 *  - installs mtb-billing-expire System script + scheduler
 */
export async function configureNonPaymentWebProxy(
  conn: RouterConn,
  opts: NonPaymentWebProxyOpts = {}
): Promise<{
  ok: true;
  nonPayCidr: string;
  landingAddress: string;
  proxyPort: number;
  addedHosts: string[];
  skippedHosts: string[];
  fetchedErrorHtml: boolean;
  errorHtmlSource?: string | null;
  errorHtmlBytes?: number;
  billingExpireScript?: { script: string; scheduler: string; interval: string } | null;
  firewallLockdown: boolean;
  firewallAdded: string[];
  firewallSkipped: string[];
  firewallDisabledBypass: number;
  addedLanIps: string[];
  skippedLanIps: string[];
  proxyAnonymousOff: boolean;
  captiveApiDstnat: boolean;
  natHttpRedirect: boolean;
  natHttpsAllow: boolean;
  natHttpsRedirect: boolean;
  proxyDeny: boolean;
  captiveProfile?: Awaited<ReturnType<typeof ensureNonPaymentCaptiveProfile>>;
  routerUiLock?: Awaited<ReturnType<typeof restrictSubscriberRouterLogin>>;
}> {
  const nonPayCidr = String(opts.nonPayCidr || '172.15.10.0/24').trim();
  const landingAddress = String(opts.landingAddress || '1.1.10.1').trim();
  const proxyPort = Math.max(1, Math.floor(Number(opts.proxyPort) || 8080));
  const captiveApiPort = Math.max(1, Math.floor(Number(opts.captiveApiPort) || 9080));
  const nonPayAddressList = String(opts.nonPayAddressList || 'non-payment').trim() || 'non-payment';
  const lockdownFirewall = opts.lockdownFirewall !== false;
  const lockRouterUi = opts.lockRouterUi !== false;
  const billingLanIps = [...new Set(
    (opts.billingLanIps || [])
      .map((ip) => String(ip || '').trim())
      .filter((ip) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip))
  )];
  const billingHost = String(opts.billingHost || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .toLowerCase();
  const allowHosts = [
    billingHost,
    ...(opts.allowHosts || []),
    'checkout.paymongo.com',
    'api.paymongo.com',
  ]
    .map((h) => String(h || '').trim().toLowerCase())
    .filter(Boolean);
  const uniqueHosts = [...new Set(allowHosts)];

  return withRouter(
    conn,
    async (api) => {
      // 0) Pool + PPP profile must put non-pay secrets into nonPayCidr or NAT never hits.
      const captiveProfile = await ensureNonPaymentCaptiveProfile(api, {
        profileName: 'non-payments',
        poolName: NONPAY_POOL_NAME,
        nonPayCidr,
        landingAddress,
        rateLimit: '2M/2M',
      });

      // Enable proxy + anonymous=no (XFF when anything still hits LAN HTTP).
      let proxyAnonymousOff = false;
      try {
        await api.write('/ip/proxy/set', [
          '=enabled=yes',
          `=port=${proxyPort}`,
          '=anonymous=no',
        ]);
        proxyAnonymousOff = true;
      } catch {
        try {
          await api.write('/ip/proxy/set', ['=anonymous=no']);
          proxyAnonymousOff = true;
        } catch {
          proxyAnonymousOff = false;
        }
      }

      const existing = (await api.write('/ip/proxy/access/print')) as Record<string, string>[];

      // IMPORTANT: never allow dst-port=<proxyPort> for the non-pay CIDR.
      // Transparent NAT makes every HTTP request look like :8080, so that
      // allow bypasses captive and the browser never sees error.html.
      for (const row of [...(existing || [])]) {
        const action = String(row.action || '').toLowerCase();
        const src = String(row['src-address'] || '');
        const dport = String(row['dst-port'] || '');
        const isBadAllow =
          action === 'allow' &&
          src === nonPayCidr &&
          dport === String(proxyPort) &&
          !String(row['dst-host'] || '') &&
          !String(row['dst-address'] || '');
        const isLegacyRedirect = action === 'redirect' && src === nonPayCidr;
        if (!isBadAllow && !isLegacyRedirect) continue;
        const id = row['.id'];
        if (!id) continue;
        try {
          await api.write('/ip/proxy/access/remove', [`=.id=${id}`]);
          const idx = existing.indexOf(row);
          if (idx >= 0) existing.splice(idx, 1);
        } catch {
          /* ignore */
        }
      }

      // Place new allows before any deny rule.
      const denyId =
        (existing || []).find(
          (r) =>
            String(r.action || '').toLowerCase() === 'deny' &&
            String(r['src-address'] || '') === nonPayCidr
        )?.['.id'] || '';
      const placeBeforeDeny = denyId ? [`=place-before=${denyId}`] : [];

      const alreadyAllowsHost = (host: string) =>
        (existing || []).some(
          (r) =>
            String(r.action || '').toLowerCase() === 'allow' &&
            String(r['src-address'] || '') === nonPayCidr &&
            String(r['dst-host'] || '').toLowerCase() === host
        );

      const alreadyAllowsLanIp = (ip: string) =>
        (existing || []).some(
          (r) =>
            String(r.action || '').toLowerCase() === 'allow' &&
            String(r['src-address'] || '') === nonPayCidr &&
            (String(r['dst-address'] || '') === ip || String(r['dst-address'] || '') === `${ip}/32`)
        );

      const alreadyAllowsLanding = (existing || []).some(
        (r) =>
          String(r.action || '').toLowerCase() === 'allow' &&
          String(r['src-address'] || '') === nonPayCidr &&
          (String(r['dst-address'] || '') === landingAddress ||
            String(r['dst-address'] || '') === `${landingAddress}/32` ||
            String(r.comment || '') === NONPAY_PROXY.allowLanding)
      );
      if (!alreadyAllowsLanding) {
        await api.write('/ip/proxy/access/add', [
          `=src-address=${nonPayCidr}`,
          `=dst-address=${landingAddress}`,
          '=action=allow',
          `=comment=${NONPAY_PROXY.allowLanding}`,
          ...placeBeforeDeny,
        ]);
        existing.push({
          action: 'allow',
          'src-address': nonPayCidr,
          'dst-address': landingAddress,
          comment: NONPAY_PROXY.allowLanding,
        });
      }

      const addedHosts: string[] = [];
      const skippedHosts: string[] = [];
      for (const host of uniqueHosts) {
        if (alreadyAllowsHost(host)) {
          skippedHosts.push(host);
          continue;
        }
        await api.write('/ip/proxy/access/add', [
          `=src-address=${nonPayCidr}`,
          `=dst-host=${host}`,
          '=action=allow',
          `=comment=${WEBPROXY_RULE_COMMENT}`,
          ...placeBeforeDeny,
        ]);
        addedHosts.push(host);
        existing.push({ action: 'allow', 'src-address': nonPayCidr, 'dst-host': host });
      }

      const addedLanIps: string[] = [];
      const skippedLanIps: string[] = [];
      for (const ip of billingLanIps) {
        if (alreadyAllowsLanIp(ip)) {
          skippedLanIps.push(ip);
          continue;
        }
        await api.write('/ip/proxy/access/add', [
          `=src-address=${nonPayCidr}`,
          `=dst-address=${ip}`,
          '=action=allow',
          `=comment=${WEBPROXY_RULE_COMMENT} lan-api`,
          ...placeBeforeDeny,
        ]);
        addedLanIps.push(ip);
        existing.push({ action: 'allow', 'src-address': nonPayCidr, 'dst-address': ip });
      }

      // Final catch-all: REDIRECT browser to subscriber portal (clear "redirection"
      // behavior). Keep deny as fallback if redirect-to is unsupported on older ROS.
      const portalRedirectUrl = String(
        opts.portalRedirectUrl ||
          (opts.billingHost ? `https://${opts.billingHost}/portal` : '') ||
          'https://panorth.tsogs.cloud/portal'
      )
        .trim()
        .replace(/\/$/, '');
      const portalRedirectTarget = portalRedirectUrl.endsWith('/portal')
        ? portalRedirectUrl
        : `${portalRedirectUrl}/portal`;

      // Remove stale deny-only catch-all so redirect can take effect (idempotent).
      for (const row of [...(existing || [])]) {
        const action = String(row.action || '').toLowerCase();
        const src = String(row['src-address'] || '');
        const cmt = String(row.comment || '');
        if (src !== nonPayCidr) continue;
        if (action !== 'deny' && action !== 'redirect') continue;
        if (
          cmt !== NONPAY_PROXY.denyCaptive &&
          cmt !== NONPAY_PROXY.redirectPortal &&
          action !== 'deny'
        ) {
          continue;
        }
        // Replace untagged/deny catch-alls and our own redirect/deny markers.
        if (
          cmt === NONPAY_PROXY.denyCaptive ||
          cmt === NONPAY_PROXY.redirectPortal ||
          (action === 'deny' && !String(row['dst-host'] || '') && !String(row['dst-address'] || ''))
        ) {
          const id = row['.id'];
          if (!id) continue;
          try {
            await api.write('/ip/proxy/access/remove', [`=.id=${id}`]);
            const idx = existing.indexOf(row);
            if (idx >= 0) existing.splice(idx, 1);
          } catch {
            /* ignore */
          }
        }
      }

      let proxyDeny = false;
      const hasPortalRedirect = (existing || []).some((r) => {
        const action = String(r.action || '').toLowerCase();
        const src = String(r['src-address'] || '');
        const to = String(r['redirect-to'] || '');
        return (
          src === nonPayCidr &&
          action === 'deny' &&
          !!to &&
          !rosBool(r.disabled) &&
          !String(r['dst-host'] || '') &&
          !String(r['dst-address'] || '')
        );
      });
      if (!hasPortalRedirect) {
        try {
          await api.write('/ip/proxy/access/add', [
            `=src-address=${nonPayCidr}`,
            '=action=deny',
            `=comment=${NONPAY_PROXY.redirectPortal}`,
          ]);
          const rows = (await api.write('/ip/proxy/access/print', [
            `?comment=${NONPAY_PROXY.redirectPortal}`,
            '=.proplist=.id',
          ])) as Record<string, string>[];
          const id = rows?.[0]?.['.id'];
          if (id) {
            for (const to of [
              portalRedirectTarget,
              portalRedirectTarget.replace(/^https:\/\//i, 'http://'),
            ]) {
              try {
                await api.write('/ip/proxy/access/set', [`=.id=${id}`, `=redirect-to=${to}`]);
                break;
              } catch {
                /* next */
              }
            }
          }
          proxyDeny = true;
          existing.push({
            action: 'deny',
            'src-address': nonPayCidr,
            comment: NONPAY_PROXY.redirectPortal,
          });
        } catch {
          await api.write('/ip/proxy/access/add', [
            `=src-address=${nonPayCidr}`,
            '=action=deny',
            `=comment=${NONPAY_PROXY.denyCaptive}`,
          ]);
          proxyDeny = true;
        }
      } else {
        proxyDeny = true;
      }

      // Prefer LAN HTTP for error.html — public HTTPS often lands Cloudflare
      // challenge HTML on the router, which breaks the captive redirect page.
      let fetchedErrorHtml = false;
      let errorHtmlSource: string | null = null;
      let errorHtmlBytes = 0;
      try {
        const existingFiles = (await raceApi(
          api.write('/file/print', ['=.proplist=name,size']),
          6_000,
          'file-print-pre'
        )) as Record<string, string>[];
        const existingHtml = (existingFiles || []).find((f) => {
          const n = String(f.name || '');
          return n === 'webproxy/error.html' || n.endsWith('/error.html') || n === 'error.html';
        });
        const existingSize = Number(existingHtml?.size || 0);
        if (existingSize >= 1500) {
          fetchedErrorHtml = true;
          errorHtmlSource = 'already-on-router';
          errorHtmlBytes = existingSize;
        }
      } catch {
        /* fetch below */
      }
      const errorPageUrl = String(opts.errorPageUrl || '').trim();
      const fetchCandidates: string[] = [];
      if (!fetchedErrorHtml) {
        for (const ip of billingLanIps.slice(0, 2)) {
          fetchCandidates.push(`http://${ip}/error.html`);
        }
        if (errorPageUrl && /^https?:\/\//i.test(errorPageUrl)) {
          fetchCandidates.push(errorPageUrl);
        }
      }
      for (const url of [...new Set(fetchCandidates)]) {
        try {
          await raceApi(
            (async () => {
              try {
                await removeProbeFile(api, 'webproxy/error.html');
              } catch {
                /* ok */
              }
              await removeStaleFetches(api);
              await cancelFetchTool(api);
              const rows = (await api.write('/tool/fetch', [
                `=url=${url}`,
                '=dst-path=webproxy/error.html',
                '=check-certificate=no',
                '=http-method=get',
              ])) as Record<string, string>[];
              const immediate = extractImmediateFetchResult(rows);
              if (immediate?.ok) return true;
              if (immediate && !immediate.ok) return false;
              const result = await waitForRouterFetch(api, rows);
              return result.ok;
            })(),
            8_000,
            'fetch-error-html'
          );
        } catch {
          continue;
        }
        try {
          const files = (await raceApi(
            api.write('/file/print', ['=.proplist=name,size']),
            6_000,
            'file-print'
          )) as Record<string, string>[];
          const hit = (files || []).find((f) => {
            const n = String(f.name || '');
            return n === 'webproxy/error.html' || n.endsWith('/error.html') || n === 'error.html';
          });
          const size = Number(hit?.size || 0);
          if (!Number.isFinite(size) || size < 1500) continue;
          fetchedErrorHtml = true;
          errorHtmlSource = url;
          errorHtmlBytes = size;
          break;
        } catch {
          /* try next */
        }
      }

      // --- Address-list MUST exist before NAT (NAT matches this list / CIDR) ---
      {
        const addrListEarly = (await api.write('/ip/firewall/address-list/print')) as Record<
          string,
          string
        >[];
        const hasCidr = (addrListEarly || []).some(
          (r) =>
            String(r.list || '') === nonPayAddressList &&
            String(r.address || '') === nonPayCidr &&
            !rosBool(r.disabled)
        );
        if (!hasCidr) {
          // Drop disabled duplicates then add.
          for (const r of addrListEarly || []) {
            if (String(r.list || '') !== nonPayAddressList) continue;
            if (String(r.address || '') !== nonPayCidr) continue;
            if (!r['.id']) continue;
            try {
              await api.write('/ip/firewall/address-list/remove', [`=.id=${r['.id']}`]);
            } catch {
              /* ignore */
            }
          }
          await api.write('/ip/firewall/address-list/add', [
            `=list=${nonPayAddressList}`,
            `=address=${nonPayCidr}`,
            `=comment=${WEBPROXY_RULE_COMMENT}`,
          ]);
        }
      }

      // --- NAT: HTTP redirect only (HTTPS redirect to proxy breaks PC browsers) ---
      const nats = (await api.write('/ip/firewall/nat/print')) as Record<string, string>[];
      const hasNatComment = (comment: string) =>
        (nats || []).some((n) => String(n.comment || '') === comment && !natRuleDisabled(n));

      const redirectOpts = { nonPayCidr, nonPayAddressList, proxyPort };
      // Remove tagged-but-broken redirects so we can recreate working ones.
      for (const n of nats || []) {
        const cmt = String(n.comment || '');
        const tagged =
          cmt === NONPAY_NAT.httpRedirect ||
          cmt === NONPAY_NAT.httpRedirectCidr ||
          cmt === 'non-payment';
        if (!tagged) continue;
        if (isWorkingNonPayHttpRedirect(n, redirectOpts)) continue;
        const id = n['.id'];
        if (!id) continue;
        try {
          await api.write('/ip/firewall/nat/remove', [`=.id=${id}`]);
          const idx = nats.indexOf(n);
          if (idx >= 0) nats.splice(idx, 1);
        } catch {
          /* ignore */
        }
      }

      const hasListRedirect = (nats || []).some(
        (n) =>
          isWorkingNonPayHttpRedirect(n, redirectOpts) &&
          String(n['src-address-list'] || '') === nonPayAddressList
      );
      const hasCidrRedirect = (nats || []).some(
        (n) =>
          isWorkingNonPayHttpRedirect(n, redirectOpts) &&
          String(n['src-address'] || '') === nonPayCidr
      );

      let natHttpRedirect = hasListRedirect || hasCidrRedirect;
      if (!hasListRedirect) {
        await api.write('/ip/firewall/nat/add', [
          '=chain=dstnat',
          '=action=redirect',
          `=to-ports=${proxyPort}`,
          '=protocol=tcp',
          `=src-address-list=${nonPayAddressList}`,
          '=dst-port=80',
          `=comment=${NONPAY_NAT.httpRedirect}`,
          '=place-before=0',
        ]);
        natHttpRedirect = true;
      }
      // Direct CIDR match — works even if address-list entry was deleted.
      if (!hasCidrRedirect) {
        await api.write('/ip/firewall/nat/add', [
          '=chain=dstnat',
          '=action=redirect',
          `=to-ports=${proxyPort}`,
          '=protocol=tcp',
          `=src-address=${nonPayCidr}`,
          '=dst-port=80',
          `=comment=${NONPAY_NAT.httpRedirectCidr}`,
          '=place-before=0',
        ]);
        natHttpRedirect = true;
      }

      // Keep HTTPS allow (portal/PayMongo) if present; remove TLS→8080 redirect
      // which shows SSL errors instead of error.html on PC browsers.
      let natHttpsRedirect = false;
      for (const n of nats || []) {
        if (String(n.comment || '') !== NONPAY_NAT.httpsRedirect) continue;
        const id = n['.id'];
        if (!id) continue;
        try {
          await api.write('/ip/firewall/nat/remove', [`=.id=${id}`]);
        } catch {
          natHttpsRedirect = true;
        }
      }

      let natHttpsAllow = hasNatComment(NONPAY_NAT.httpsAllow);
      if (!natHttpsAllow) {
        await api.write('/ip/firewall/nat/add', [
          '=chain=dstnat',
          '=action=accept',
          '=protocol=tcp',
          `=src-address-list=${nonPayAddressList}`,
          `=dst-address-list=${NONPAY_HTTPS_LIST}`,
          '=dst-port=443',
          `=comment=${NONPAY_NAT.httpsAllow}`,
          '=place-before=0',
        ]);
        natHttpsAllow = true;
      }

      // Bypass global DNS hijack (e.g. AdGuard) for non-pay — use profile DNS fast.
      const ensureDnsBypass = async (comment: string, proto: 'udp' | 'tcp') => {
        if (hasNatComment(comment)) return;
        const adguardId =
          (nats || []).find((n) => /adguard/i.test(String(n.comment || '')))?.['.id'] || '';
        await api.write('/ip/firewall/nat/add', [
          '=chain=dstnat',
          '=action=accept',
          `=protocol=${proto}`,
          `=src-address-list=${nonPayAddressList}`,
          '=dst-port=53',
          `=comment=${comment}`,
          ...(adguardId ? [`=place-before=${adguardId}`] : ['=place-before=0']),
        ]);
      };
      await ensureDnsBypass(NONPAY_NAT.dnsBypassUdp, 'udp');
      await ensureDnsBypass(NONPAY_NAT.dnsBypassTcp, 'tcp');

      const firewallAdded: string[] = [];
      const firewallSkipped: string[] = [];
      let firewallDisabledBypass = 0;

      if (lockdownFirewall) {
        const addrList = (await api.write('/ip/firewall/address-list/print')) as Record<string, string>[];
        const hasCidr = (addrList || []).some(
          (r) =>
            String(r.list || '') === nonPayAddressList &&
            String(r.address || '') === nonPayCidr
        );
        if (!hasCidr) {
          await api.write('/ip/firewall/address-list/add', [
            `=list=${nonPayAddressList}`,
            `=address=${nonPayCidr}`,
            `=comment=${WEBPROXY_RULE_COMMENT}`,
          ]);
        }

        // FQDN entries resolve dynamically on RouterOS 7 — portal + PayMongo HTTPS.
        for (const host of uniqueHosts) {
          const hasHost = (addrList || []).some(
            (r) =>
              String(r.list || '') === NONPAY_HTTPS_LIST &&
              String(r.address || '').toLowerCase() === host
          );
          if (hasHost) continue;
          try {
            await api.write('/ip/firewall/address-list/add', [
              `=list=${NONPAY_HTTPS_LIST}`,
              `=address=${host}`,
              `=comment=${WEBPROXY_RULE_COMMENT}`,
            ]);
            addrList.push({ list: NONPAY_HTTPS_LIST, address: host });
          } catch {
            /* duplicate */
          }
        }

        const filters = (await api.write('/ip/firewall/filter/print')) as Record<string, string>[];
        const hasComment = (comment: string) =>
          (filters || []).some((r) => String(r.comment || '') === comment);

        const anchorId =
          (filters || []).find((r) => String(r.comment || '') === NONPAY_FW.drop)?.['.id'] ||
          (filters || []).find(
            (r) =>
              String(r.chain || '') === 'forward' &&
              String(r['src-address-list'] || '') === nonPayAddressList &&
              String(r.action || '') === 'accept' &&
              !String(r.comment || '').startsWith('MT-Billing nonpay')
          )?.['.id'] ||
          '';
        const placeArgs = anchorId ? [`=place-before=${anchorId}`] : [];

        const ensureAllow = async (comment: string, args: string[]) => {
          if (hasComment(comment)) {
            firewallSkipped.push(comment);
            return;
          }
          await api.write('/ip/firewall/filter/add', [...args, `=comment=${comment}`, ...placeArgs]);
          firewallAdded.push(comment);
          filters.push({ comment });
        };

        await ensureAllow(NONPAY_FW.https, [
          '=chain=forward',
          '=action=accept',
          '=protocol=tcp',
          `=src-address-list=${nonPayAddressList}`,
          `=dst-address-list=${NONPAY_HTTPS_LIST}`,
          '=dst-port=443',
        ]);
        await ensureAllow(NONPAY_FW.dnsUdp, [
          '=chain=forward',
          '=action=accept',
          '=protocol=udp',
          `=src-address-list=${nonPayAddressList}`,
          '=dst-port=53',
        ]);
        await ensureAllow(NONPAY_FW.dnsTcp, [
          '=chain=forward',
          '=action=accept',
          '=protocol=tcp',
          `=src-address-list=${nonPayAddressList}`,
          '=dst-port=53',
        ]);
        await ensureAllow(NONPAY_FW.http, [
          '=chain=forward',
          '=action=accept',
          '=protocol=tcp',
          `=src-address-list=${nonPayAddressList}`,
          `=dst-port=80,${proxyPort},${captiveApiPort}`,
        ]);

        // Redirected HTTP lands on the router's proxy — allow input.
        if (!hasComment(NONPAY_FW.proxyInput)) {
          await api.write('/ip/firewall/filter/add', [
            '=chain=input',
            '=action=accept',
            '=protocol=tcp',
            `=src-address-list=${nonPayAddressList}`,
            `=dst-port=${proxyPort}`,
            `=comment=${NONPAY_FW.proxyInput}`,
            '=place-before=0',
          ]);
          firewallAdded.push(NONPAY_FW.proxyInput);
        } else {
          firewallSkipped.push(NONPAY_FW.proxyInput);
        }

        if (hasComment(NONPAY_FW.drop)) {
          firewallSkipped.push(NONPAY_FW.drop);
        } else {
          const bypassId =
            (filters || []).find(
              (r) =>
                String(r.chain || '') === 'forward' &&
                String(r['src-address-list'] || '') === nonPayAddressList &&
                String(r.action || '') === 'accept' &&
                !String(r.comment || '').startsWith('MT-Billing nonpay')
            )?.['.id'] || '';
          const dropPlace = bypassId ? [`=place-before=${bypassId}`] : [];
          await api.write('/ip/firewall/filter/add', [
            '=chain=forward',
            '=action=drop',
            `=src-address-list=${nonPayAddressList}`,
            `=comment=${NONPAY_FW.drop}`,
            ...dropPlace,
          ]);
          firewallAdded.push(NONPAY_FW.drop);
          filters.push({ comment: NONPAY_FW.drop });
        }

        // Chrome/Android: silent DROP makes HTTPS/DoH hang for tens of seconds.
        // Reject with RST/ICMP so the tablet fails fast and captive HTTP wins.
        const dropId =
          (filters || []).find((r) => String(r.comment || '') === NONPAY_FW.drop)?.['.id'] ||
          (
            (await api.write('/ip/firewall/filter/print')) as Record<string, string>[]
          ).find((r) => String(r.comment || '') === NONPAY_FW.drop)?.['.id'] ||
          '';
        const beforeDrop = dropId ? [`=place-before=${dropId}`] : [];
        if (!hasComment(NONPAY_FW.rejectTcp)) {
          await api.write('/ip/firewall/filter/add', [
            '=chain=forward',
            '=action=reject',
            '=reject-with=tcp-reset',
            '=protocol=tcp',
            `=src-address-list=${nonPayAddressList}`,
            `=comment=${NONPAY_FW.rejectTcp}`,
            ...beforeDrop,
          ]);
          firewallAdded.push(NONPAY_FW.rejectTcp);
        } else {
          firewallSkipped.push(NONPAY_FW.rejectTcp);
        }
        if (!hasComment(NONPAY_FW.rejectQuic)) {
          await api.write('/ip/firewall/filter/add', [
            '=chain=forward',
            '=action=reject',
            '=reject-with=icmp-port-unreachable',
            '=protocol=udp',
            `=src-address-list=${nonPayAddressList}`,
            '=dst-port=443',
            `=comment=${NONPAY_FW.rejectQuic}`,
            ...beforeDrop,
          ]);
          firewallAdded.push(NONPAY_FW.rejectQuic);
        } else {
          firewallSkipped.push(NONPAY_FW.rejectQuic);
        }

        // Legacy inverted bypass: accept tcp !80,8080 (lets HTTPS through) and udp/443 (QUIC).
        const fresh = (await api.write('/ip/firewall/filter/print')) as Record<string, string>[];
        for (const r of fresh || []) {
          if (String(r.chain || '') !== 'forward') continue;
          if (String(r['src-address-list'] || '') !== nonPayAddressList) continue;
          if (String(r.action || '') !== 'accept') continue;
          const cmt = String(r.comment || '');
          if (cmt.startsWith('MT-Billing nonpay')) continue;
          const dport = String(r['dst-port'] || '');
          const proto = String(r.protocol || '').toLowerCase();
          const isHttpsBypass =
            (proto === 'tcp' && (dport.includes('!80') || dport === '!80,8080')) ||
            (proto === 'udp' && dport === '443');
          if (!isHttpsBypass) continue;
          if (String(r.disabled || '').toLowerCase() === 'true' || r.disabled === 'yes') continue;
          const id = r['.id'];
          if (!id) continue;
          try {
            await api.write('/ip/firewall/filter/disable', [`=.id=${id}`]);
            firewallDisabledBypass += 1;
          } catch {
            /* ignore */
          }
        }
      }

      // dstnat landing:9080 → billing LAN:80 so captive clients can reach LAN API
      // while the TCP source remains the PPPoE address (unlike webproxy XFF).
      let captiveApiDstnat = false;
      const billingLanTarget = billingLanIps[0] || '';
      if (billingLanTarget) {
        const natsApi = (await api.write('/ip/firewall/nat/print')) as Record<string, string>[];
        const natComment = `${WEBPROXY_RULE_COMMENT} captive-api`;
        const hasNat = (natsApi || []).some(
          (n) =>
            String(n.comment || '') === natComment ||
            String(n.comment || '') === 'MT-Billing captive API'
        );
        if (!hasNat) {
          try {
            await api.write('/ip/firewall/nat/add', [
              '=chain=dstnat',
              '=action=dst-nat',
              `=to-addresses=${billingLanTarget}`,
              '=to-ports=80',
              '=protocol=tcp',
              `=src-address-list=${nonPayAddressList}`,
              `=dst-address=${landingAddress}`,
              `=dst-port=${captiveApiPort}`,
              `=comment=${natComment}`,
            ]);
            captiveApiDstnat = true;
          } catch {
            captiveApiDstnat = false;
          }
        } else {
          captiveApiDstnat = true;
        }
      }

      let routerUiLock: Awaited<ReturnType<typeof restrictSubscriberRouterLogin>> | undefined;
      if (lockRouterUi) {
        try {
          routerUiLock = await restrictSubscriberRouterLogin(conn, {
            mgmtCidrs: opts.routerMgmtCidrs,
          });
        } catch {
          routerUiLock = undefined;
        }
      }

      // Install classic System → Scripts expire scanner (best-effort, bounded).
      let billingExpireScript: { script: string; scheduler: string; interval: string } | null =
        null;
      try {
        const source = buildBillingExpireScriptSource('non-payments');
        await removeSchedulerByName(api, BILLING_EXPIRE_SCHEDULER);
        await removeSystemScriptByName(api, BILLING_EXPIRE_SCRIPT);
        try {
          await raceApi(
            api.write('/system/script/add', [
              `=name=${BILLING_EXPIRE_SCRIPT}`,
              `=source=${source}`,
              '=dont-require-permissions=yes',
              '=comment=MT-Billing: overdue PPP secrets → non-payment profile (captive error.html)',
            ]),
            10_000,
            'add-exp-script'
          );
        } catch {
          await raceApi(
            api.write('/system/script/set', [
              `=numbers=${BILLING_EXPIRE_SCRIPT}`,
              `=source=${source}`,
              '=dont-require-permissions=yes',
            ]),
            10_000,
            'set-exp-script'
          );
        }
        try {
          await raceApi(
            api.write('/system/scheduler/add', [
              `=name=${BILLING_EXPIRE_SCHEDULER}`,
              '=start-time=startup',
              '=interval=00:05:00',
              `=on-event=${BILLING_EXPIRE_SCRIPT}`,
              '=comment=MT-Billing periodic expire scan',
            ]),
            6_000,
            'add-exp-sched'
          );
        } catch {
          await raceApi(
            api.write('/system/scheduler/set', [
              `=numbers=${BILLING_EXPIRE_SCHEDULER}`,
              '=start-time=startup',
              '=interval=00:05:00',
              `=on-event=${BILLING_EXPIRE_SCRIPT}`,
              '=disabled=no',
            ]),
            6_000,
            'set-exp-sched'
          );
        }
        billingExpireScript = {
          script: BILLING_EXPIRE_SCRIPT,
          scheduler: BILLING_EXPIRE_SCHEDULER,
          interval: '00:05:00',
        };
      } catch {
        billingExpireScript = null;
      }

      return {
        ok: true as const,
        nonPayCidr,
        landingAddress,
        proxyPort,
        addedHosts,
        skippedHosts,
        fetchedErrorHtml,
        errorHtmlSource,
        errorHtmlBytes,
        billingExpireScript,
        firewallLockdown: lockdownFirewall,
        firewallAdded,
        firewallSkipped,
        firewallDisabledBypass,
        addedLanIps,
        skippedLanIps,
        proxyAnonymousOff,
        captiveApiDstnat,
        captiveProfile,
        natHttpRedirect,
        natHttpsAllow,
        natHttpsRedirect,
        proxyDeny,
        routerUiLock,
      };
    },
    { timeoutSec: 55 }
  );
}

/** Live Hotspot active sessions from RouterOS. */
export interface HotspotActiveRow {
  id: string;
  user: string;
  address: string;
  macAddress: string;
  uptime: string;
  bytesIn: number;
  bytesOut: number;
  loginBy: string;
  server: string;
}

export interface HotspotUserRow {
  id: string;
  name: string;
  password: string;
  profile: string;
  limitUptime: string;
  disabled: boolean;
  comment: string;
}

function parseRosBytes(raw: string | undefined): number {
  if (!raw) return 0;
  const n = Number(String(raw).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export async function fetchHotspotActive(conn: RouterConn): Promise<HotspotActiveRow[]> {
  return withRouter(conn, async (api) => {
    const rows = (await api.write('/ip/hotspot/active/print')) as Record<string, string>[];
    return (rows || []).map((r) => ({
      id: r['.id'] || '',
      user: r.user || r.name || '',
      address: r.address || '',
      macAddress: (r['mac-address'] || '').toUpperCase(),
      uptime: r.uptime || '',
      bytesIn: parseRosBytes(r['bytes-in']),
      bytesOut: parseRosBytes(r['bytes-out']),
      loginBy: r['login-by'] || '',
      server: r.server || '',
    }));
  });
}

export async function fetchHotspotUsers(conn: RouterConn): Promise<HotspotUserRow[]> {
  return withRouter(conn, async (api) => {
    const rows = (await api.write('/ip/hotspot/user/print')) as Record<string, string>[];
    return (rows || []).map((r) => ({
      id: r['.id'] || '',
      name: r.name || '',
      password: r.password || '',
      profile: r.profile || '',
      limitUptime: r['limit-uptime'] || '',
      disabled: rosBool(r.disabled),
      comment: r.comment || '',
    }));
  });
}

/** Remove a Hotspot active session (kick). */
export async function removeHotspotActive(conn: RouterConn, id: string): Promise<void> {
  await withRouter(conn, (api) => api.write('/ip/hotspot/active/remove', [`=.id=${id}`]));
}
