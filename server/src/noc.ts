import express from 'express';
import net from 'net';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { db } from './db.js';
import { probeOlt } from './olt.js';
import { probeRouter } from './mikrotik.js';

export const nocRouter = express.Router();
const execFileAsync = promisify(execFile);

export type NocKind = 'olt' | 'router' | 'switch' | 'ap' | 'radio' | 'other';

function columnExists(table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === col);
}

export function initNoc() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS noc_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'other',
      host TEXT NOT NULL,
      ports TEXT DEFAULT '',
      snmp_port INTEGER DEFAULT 161,
      snmp_community TEXT DEFAULT 'public',
      notes TEXT,
      enabled INTEGER DEFAULT 1,
      status TEXT DEFAULT 'unknown',
      last_latency_ms INTEGER,
      last_probe_at TEXT,
      probe_error TEXT,
      sys_name TEXT,
      vendor TEXT,
      model TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS noc_probe_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_key TEXT NOT NULL,
      online INTEGER NOT NULL,
      latency_ms INTEGER,
      probed_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_noc_probe_history_key ON noc_probe_history(device_key, probed_at);
  `);
  for (const [col, type] of [
    ['ports', "TEXT DEFAULT ''"],
    ['snmp_port', 'INTEGER DEFAULT 161'],
    ['snmp_community', "TEXT DEFAULT 'public'"],
    ['notes', 'TEXT'],
    ['enabled', 'INTEGER DEFAULT 1'],
    ['status', "TEXT DEFAULT 'unknown'"],
    ['last_latency_ms', 'INTEGER'],
    ['last_probe_at', 'TEXT'],
    ['probe_error', 'TEXT'],
    ['sys_name', 'TEXT'],
    ['vendor', 'TEXT'],
    ['model', 'TEXT'],
    ['ssh_port', 'INTEGER DEFAULT 22'],
    ['ssh_user', 'TEXT'],
    ['ssh_pass', 'TEXT'],
  ] as [string, string][]) {
    if (!columnExists('noc_devices', col)) db.exec(`ALTER TABLE noc_devices ADD COLUMN ${col} ${type}`);
  }
}

function parsePorts(raw: unknown): number[] | undefined {
  if (raw == null || raw === '') return undefined;
  if (Array.isArray(raw)) {
    const nums = raw.map(Number).filter((n) => Number.isFinite(n) && n > 0 && n < 65536);
    return nums.length ? nums : undefined;
  }
  const nums = String(raw)
    .split(/[,\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 65536);
  return nums.length ? nums : undefined;
}

function portsToStore(raw: unknown): string {
  const p = parsePorts(raw);
  return p ? p.join(',') : '';
}

export async function probeNocDevice(row: {
  host: string;
  ports?: string | null;
  snmp_port?: number | null;
  snmp_community?: string | null;
}): Promise<{
  online: boolean;
  latencyMs: number | null;
  sysName: string | null;
  vendor: string | null;
  model: string | null;
  error?: string;
}> {
  const host = String(row.host || '').trim();
  if (!host) {
    return { online: false, latencyMs: null, sysName: null, vendor: null, model: null, error: 'Host required' };
  }
  const started = Date.now();
  const result = await probeOlt({
    host,
    snmpPort: row.snmp_port || 161,
    snmpCommunity: row.snmp_community || 'public',
    ports: parsePorts(row.ports),
  });
  const latencyMs = result.online ? Date.now() - started : null;
  return {
    online: result.online,
    latencyMs,
    sysName: result.sysName,
    vendor: result.vendor,
    model: result.model,
    error: result.error,
  };
}

function persistProbe(
  id: number,
  probe: Awaited<ReturnType<typeof probeNocDevice>>
) {
  db.prepare(
    `UPDATE noc_devices SET
       status = ?, last_latency_ms = ?, last_probe_at = CURRENT_TIMESTAMP,
       probe_error = ?, sys_name = COALESCE(?, sys_name),
       vendor = COALESCE(?, vendor), model = COALESCE(?, model)
     WHERE id = ?`
  ).run(
    probe.online ? 'online' : 'offline',
    probe.latencyMs,
    probe.error || null,
    probe.sysName,
    probe.vendor,
    probe.model,
    id
  );
  recordHistory(`custom:${id}`, probe.online, probe.latencyMs);
}

function recordHistory(deviceKey: string, online: boolean, latencyMs: number | null) {
  try {
    db.prepare(
      `INSERT INTO noc_probe_history (device_key, online, latency_ms) VALUES (?, ?, ?)`
    ).run(deviceKey, online ? 1 : 0, latencyMs);
    db.prepare(`DELETE FROM noc_probe_history WHERE probed_at < datetime('now', '-2 day')`).run();
  } catch {
    /* table may be mid-migrate */
  }
}

async function probeLinkedRouters(): Promise<
  {
    source: 'router';
    id: number;
    name: string;
    kind: 'router';
    host: string;
    status: string;
    online: boolean;
    latencyMs: number | null;
    board?: string;
    error?: string;
  }[]
> {
  const routers = db
    .prepare(`SELECT id, name, host, port, api_user, api_pass, board, type, status FROM routers ORDER BY name`)
    .all() as any[];
  const out: any[] = [];
  for (const r of routers) {
    if (!r.host || !r.api_user) {
      out.push({
        source: 'router',
        id: r.id,
        name: r.name,
        kind: 'router',
        host: r.host || '',
        status: 'unknown',
        online: false,
        latencyMs: null,
        board: r.board || null,
        error: 'Missing host or API credentials',
      });
      continue;
    }
    const t0 = Date.now();
    try {
      const p = await probeRouter({
        host: r.host,
        api_user: r.api_user,
        api_pass: r.api_pass || '',
        port: r.port || 8728,
      });
      out.push({
        source: 'router',
        id: r.id,
        name: r.name,
        kind: 'router',
        host: r.host,
        status: p.online ? 'online' : 'offline',
        online: !!p.online,
        latencyMs: p.online ? Date.now() - t0 : null,
        board: p.board || p.identity || r.board || null,
        error: p.error,
        sshCapable: true,
        routerId: r.id,
      });
      recordHistory(`router:${r.id}`, !!p.online, p.online ? Date.now() - t0 : null);
    } catch (e: any) {
      out.push({
        source: 'router',
        id: r.id,
        name: r.name,
        kind: 'router',
        host: r.host,
        status: 'offline',
        online: false,
        latencyMs: null,
        board: r.board || null,
        error: e?.message || 'Probe failed',
      });
      recordHistory(`router:${r.id}`, false, null);
    }
  }
  return out;
}

async function probeLinkedOlts(): Promise<
  {
    source: 'olt';
    id: number;
    name: string;
    kind: 'olt';
    host: string;
    status: string;
    online: boolean;
    latencyMs: number | null;
    vendor?: string | null;
    model?: string | null;
    error?: string;
  }[]
> {
  const olts = db
    .prepare(
      `SELECT id, name, host, snmp_port, snmp_community, vendor, model, status
       FROM naps WHERE kind = 'olt' ORDER BY name`
    )
    .all() as any[];
  const out: any[] = [];
  for (const o of olts) {
    if (!o.host) {
      out.push({
        source: 'olt',
        id: o.id,
        name: o.name,
        kind: 'olt',
        host: '',
        status: 'unknown',
        online: false,
        latencyMs: null,
        vendor: o.vendor,
        model: o.model,
        error: 'No host configured',
      });
      continue;
    }
    const t0 = Date.now();
    const p = await probeOlt({
      host: o.host,
      snmpPort: o.snmp_port || 161,
      snmpCommunity: o.snmp_community || 'public',
    });
    out.push({
      source: 'olt',
      id: o.id,
      name: o.name,
      kind: 'olt',
      host: o.host,
      status: p.online ? 'online' : 'offline',
      online: p.online,
      latencyMs: p.online ? Date.now() - t0 : null,
      vendor: p.vendor || o.vendor,
      model: p.model || o.model,
      error: p.error,
    });
    recordHistory(`olt:${o.id}`, p.online, p.online ? Date.now() - t0 : null);
    try {
      db.prepare(
        `UPDATE naps SET status = ?, last_probe_at = CURRENT_TIMESTAMP, probe_error = ?,
           vendor = COALESCE(?, vendor), model = COALESCE(?, model), sys_name = COALESCE(?, sys_name)
         WHERE id = ?`
      ).run(
        p.online ? 'online' : 'offline',
        p.error || null,
        p.vendor,
        p.model,
        p.sysName,
        o.id
      );
    } catch {
      /* older schema may lack some cols */
    }
  }
  return out;
}

export async function runNocProbePass(): Promise<{
  custom: number;
  linked: number;
  online: number;
  offline: number;
}> {
  const devices = db.prepare('SELECT * FROM noc_devices WHERE enabled = 1').all() as any[];
  let online = 0;
  let offline = 0;
  for (const d of devices) {
    // eslint-disable-next-line no-await-in-loop
    const probe = await probeNocDevice(d);
    persistProbe(d.id, probe);
    if (probe.online) online += 1;
    else offline += 1;
  }
  const linkedRouters = await probeLinkedRouters();
  const linkedOlts = await probeLinkedOlts();
  for (const x of [...linkedRouters, ...linkedOlts]) {
    if (x.online) online += 1;
    else offline += 1;
  }
  return {
    custom: devices.length,
    linked: linkedRouters.length + linkedOlts.length,
    online,
    offline,
  };
}

nocRouter.get('/noc/summary', async (_req, res) => {
  const custom = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'online' THEN 1 ELSE 0 END) AS online,
         SUM(CASE WHEN status = 'offline' THEN 1 ELSE 0 END) AS offline
       FROM noc_devices WHERE enabled = 1`
    )
    .get() as { total: number; online: number; offline: number };
  const routers = (db.prepare('SELECT COUNT(*) AS c FROM routers').get() as any).c as number;
  const olts = (db.prepare("SELECT COUNT(*) AS c FROM naps WHERE kind = 'olt'").get() as any).c as number;
  res.json({
    customTotal: custom.total || 0,
    customOnline: custom.online || 0,
    customOffline: custom.offline || 0,
    linkedRouters: routers,
    linkedOlts: olts,
  });
});

nocRouter.get('/noc', async (req, res) => {
  const live = String(req.query.live || '') === '1' || String(req.query.live || '') === 'true';
  if (live) {
    await runNocProbePass();
  }
  const devices = db
    .prepare('SELECT * FROM noc_devices ORDER BY kind, name')
    .all()
    .map((d: any) => {
      const { ssh_pass, ...rest } = d;
      return {
        ...rest,
        source: 'custom' as const,
        online: d.status === 'online',
        ssh_pass_set: !!ssh_pass,
        sshCapable: !!(d.ssh_user && d.host),
      };
    });

  let linked: any[] = [];
  if (live) {
    linked = [...(await probeLinkedRouters()), ...(await probeLinkedOlts())];
  } else {
    // Cheap snapshot without re-probing routers/OLTs (use last known)
    const routers = db
      .prepare('SELECT id, name, host, board, status FROM routers ORDER BY name')
      .all() as any[];
    linked.push(
      ...routers.map((r) => ({
        source: 'router',
        id: r.id,
        name: r.name,
        kind: 'router',
        host: r.host || '',
        status: r.status === 'online' ? 'online' : r.status === 'offline' ? 'offline' : 'unknown',
        online: r.status === 'online',
        latencyMs: null,
        board: r.board || null,
        sshCapable: true,
        routerId: r.id,
        note: 'Refresh with live probe for status',
      }))
    );
    const olts = db
      .prepare(
        `SELECT id, name, host, vendor, model, status, last_probe_at, probe_error
         FROM naps WHERE kind = 'olt' ORDER BY name`
      )
      .all() as any[];
    linked.push(
      ...olts.map((o) => ({
        source: 'olt',
        id: o.id,
        name: o.name,
        kind: 'olt',
        host: o.host || '',
        status: o.status || 'unknown',
        online: o.status === 'online',
        latencyMs: null,
        vendor: o.vendor,
        model: o.model,
        error: o.probe_error,
        lastProbeAt: o.last_probe_at,
      }))
    );
  }

  const all = [...devices, ...linked];
  const online = all.filter((x) => x.online || x.status === 'online').length;
  const offline = all.filter((x) => x.status === 'offline' || (!x.online && x.status !== 'unknown')).length;

  res.json({
    devices: all,
    counts: {
      total: all.length,
      online,
      offline,
      unknown: all.length - online - offline,
      custom: devices.length,
      linked: linked.length,
    },
    probedAt: new Date().toISOString(),
    live,
  });
});

nocRouter.post('/noc/probe', async (_req, res) => {
  const result = await runNocProbePass();
  res.json({ ok: true, ...result, probedAt: new Date().toISOString() });
});

nocRouter.post('/noc/test', async (req, res) => {
  const b = req.body || {};
  const probe = await probeNocDevice({
    host: b.host,
    ports: portsToStore(b.ports),
    snmp_port: b.snmpPort ?? b.snmp_port ?? 161,
    snmp_community: b.snmpCommunity ?? b.snmp_community ?? 'public',
  });
  res.json(probe);
});

function tcpProbe(host: string, port: number, timeoutMs = 350): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok: boolean) => {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

async function readIpJson(args: string[]): Promise<any[]> {
  try {
    const { stdout } = await execFileAsync('ip', ['-j', ...args], { timeout: 5000 });
    return JSON.parse(stdout || '[]');
  } catch {
    return [];
  }
}

function cidrHosts(cidr: string, maxHosts = 254): string[] {
  const m = cidr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
  if (!m) return [];
  const ip =
    ((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>> 0;
  const prefix = Number(m[5]);
  if (prefix < 24 || prefix > 30) return [];
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const network = (ip & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  const out: string[] = [];
  for (let h = network + 1; h < broadcast && out.length < maxHosts; h++) {
    out.push([(h >>> 24) & 255, (h >>> 16) & 255, (h >>> 8) & 255, h & 255].join('.'));
  }
  return out;
}

async function mapPoolScan<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, () => worker()));
  return results;
}

const SCAN_PORTS = [22, 80, 443, 8728, 8291, 161, 23, 8080];

/**
 * Discover devices on the connected LAN (hop 1) and neighbors learned via the
 * gateway / ARP/NDP (hop ≤ 2). Returns candidates the operator can add to NOC.
 */
nocRouter.post('/noc/scan', async (req, res) => {
  try {
    const hops = Math.min(2, Math.max(1, Number(req.body?.hops) || 2));
    const addrs = await readIpJson(['-4', 'addr', 'show']);
    const routes = await readIpJson(['route', 'show', 'default']);
    const neigh = await readIpJson(['neigh', 'show']);
    const gateways = new Set<string>();
    for (const r of routes) {
      if (r.gateway) gateways.add(String(r.gateway));
    }

    const localCidrs: string[] = [];
    const selfIps = new Set<string>();
    for (const iface of addrs) {
      if (iface.operstate === 'DOWN') continue;
      for (const a of iface.addr_info || []) {
        if (a.family !== 'inet' || !a.local) continue;
        if (String(a.local).startsWith('127.')) continue;
        selfIps.add(String(a.local));
        const prefix = Number(a.prefixlen) || 24;
        if (prefix >= 24 && prefix <= 30) localCidrs.push(`${a.local}/${prefix}`);
      }
    }

    const hop1Hosts = new Set<string>();
    for (const cidr of localCidrs) {
      for (const h of cidrHosts(cidr, 254)) hop1Hosts.add(h);
    }
    // Always include gateways
    for (const g of gateways) hop1Hosts.add(g);

    const hop2Hosts = new Set<string>();
    if (hops >= 2) {
      for (const n of neigh) {
        const dst = String(n.dst || '');
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(dst)) continue;
        if (selfIps.has(dst) || hop1Hosts.has(dst)) continue;
        // Neighbors outside local CIDR = typically beyond gateway (2nd hop)
        hop2Hosts.add(dst);
      }
    }

    const known = new Set(
      (db.prepare('SELECT host FROM noc_devices').all() as { host: string }[])
        .map((r) => String(r.host || '').trim())
        .filter(Boolean)
    );
    for (const r of db.prepare('SELECT host FROM routers').all() as { host: string }[]) {
      if (r.host) known.add(String(r.host).trim());
    }

    const probeHost = async (host: string, hop: number) => {
      if (selfIps.has(host)) return null;
      const openPorts: number[] = [];
      for (const p of SCAN_PORTS) {
        // eslint-disable-next-line no-await-in-loop
        if (await tcpProbe(host, p)) openPorts.push(p);
      }
      if (!openPorts.length) return null;
      let kind = 'other';
      if (openPorts.includes(8728) || openPorts.includes(8291)) kind = 'router';
      else if (openPorts.includes(161)) kind = 'switch';
      else if (openPorts.includes(22) && openPorts.includes(80)) kind = 'other';
      else if (openPorts.includes(22)) kind = 'other';
      return {
        host,
        hop,
        kind,
        openPorts,
        sshCapable: openPorts.includes(22),
        alreadyMonitored: known.has(host),
        isGateway: gateways.has(host),
      };
    };

    const hop1List = [...hop1Hosts];
    const hop1Found = (
      await mapPoolScan(hop1List, 40, (h) => probeHost(h, 1))
    ).filter(Boolean) as any[];

    const hop2List = [...hop2Hosts].slice(0, 64);
    const hop2Found =
      hops >= 2
        ? ((await mapPoolScan(hop2List, 20, (h) => probeHost(h, 2))).filter(Boolean) as any[])
        : [];

    const devices = [...hop1Found, ...hop2Found].sort((a, b) =>
      a.hop !== b.hop ? a.hop - b.hop : a.host.localeCompare(b.host)
    );

    res.json({
      ok: true,
      hops,
      localCidrs,
      gateways: [...gateways],
      scanned: hop1List.length + hop2List.length,
      devices,
      probedAt: new Date().toISOString(),
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'Network scan failed' });
  }
});

/** Add multiple discovered hosts as NOC custom devices. */
nocRouter.post('/noc/scan/import', async (req, res) => {
  const items = Array.isArray(req.body?.devices) ? req.body.devices : [];
  if (!items.length) return res.status(400).json({ error: 'No devices selected.' });
  let added = 0;
  for (const d of items) {
    const host = String(d.host || '').trim();
    if (!host) continue;
    const exists = db.prepare('SELECT id FROM noc_devices WHERE host = ?').get(host);
    if (exists) continue;
    const kind = String(d.kind || 'other').toLowerCase() || 'other';
    const name = String(d.name || host).trim();
    const ports = Array.isArray(d.openPorts) ? d.openPorts.join(',') : '22,80,443';
    const info = db
      .prepare(
        `INSERT INTO noc_devices (name, kind, host, ports, snmp_port, snmp_community, notes, enabled, ssh_port, ssh_user)
         VALUES (?, ?, ?, ?, 161, 'public', ?, 1, 22, ?)`
      )
      .run(name, kind, host, ports, d.isGateway ? 'Discovered gateway' : 'Discovered via network scan', d.sshCapable ? 'admin' : null);
    const id = Number(info.lastInsertRowid);
    try {
      // eslint-disable-next-line no-await-in-loop
      const probe = await probeNocDevice({ host, ports, snmp_port: 161, snmp_community: 'public' });
      persistProbe(id, probe);
    } catch {
      /* ignore */
    }
    added += 1;
  }
  res.json({ ok: true, added });
});

/** Health series for graphic display (uptime-style). Defaults to last 24h. */
nocRouter.get('/noc/health', (req, res) => {
  const hours = Math.min(72, Math.max(1, Number(req.query.hours) || 24));
  const rows = db
    .prepare(
      `SELECT device_key, online, latency_ms, probed_at
       FROM noc_probe_history
       WHERE probed_at >= datetime('now', ?)
       ORDER BY probed_at ASC`
    )
    .all(`-${hours} hours`) as any[];
  const byKey: Record<string, { t: string; online: number; latency: number | null }[]> = {};
  for (const r of rows) {
    const k = r.device_key;
    if (!byKey[k]) byKey[k] = [];
    byKey[k].push({
      t: r.probed_at,
      online: r.online ? 1 : 0,
      latency: r.latency_ms,
    });
  }
  const summary = Object.entries(byKey).map(([key, series]) => {
    const up = series.filter((s) => s.online).length;
    return {
      key,
      samples: series.length,
      uptimePct: series.length ? Math.round((up / series.length) * 1000) / 10 : null,
      series,
    };
  });
  res.json({ hours, devices: summary, probedAt: new Date().toISOString() });
});

nocRouter.get('/noc/devices/:id/info', async (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM noc_devices WHERE id = ?').get(id) as any;
  if (!row) return res.status(404).json({ error: 'Device not found' });
  const probe = await probeNocDevice(row);
  persistProbe(id, probe);
  const fresh = db.prepare('SELECT * FROM noc_devices WHERE id = ?').get(id) as any;
  const { ssh_pass: _p, ...pub } = fresh;
  res.json({
    device: { ...pub, ssh_pass_set: !!fresh.ssh_pass },
    probe,
    sshCapable: !!(fresh.ssh_user && fresh.host),
  });
});

nocRouter.get('/noc/devices/:id/history', (req, res) => {
  const id = Number(req.params.id);
  const source = String(req.query.source || 'custom').toLowerCase();
  const key =
    source === 'router' ? `router:${id}` : source === 'olt' ? `olt:${id}` : `custom:${id}`;
  const rows = db
    .prepare(
      `SELECT online, latency_ms AS latencyMs, probed_at AS probedAt
       FROM noc_probe_history WHERE device_key = ? ORDER BY id DESC LIMIT 120`
    )
    .all(key)
    .reverse();
  res.json({ deviceKey: key, history: rows });
});

nocRouter.post('/noc/devices', async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const host = String(b.host || '').trim();
  const kind = String(b.kind || 'other').trim().toLowerCase() || 'other';
  if (!name || !host) return res.status(400).json({ error: 'Name and host are required.' });
  const info = db
    .prepare(
      `INSERT INTO noc_devices (name, kind, host, ports, snmp_port, snmp_community, notes, enabled, ssh_port, ssh_user, ssh_pass)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
    )
    .run(
      name,
      kind,
      host,
      portsToStore(b.ports),
      Number(b.snmpPort ?? b.snmp_port ?? 161) || 161,
      String(b.snmpCommunity ?? b.snmp_community ?? 'public'),
      b.notes != null ? String(b.notes) : null,
      Number(b.sshPort ?? b.ssh_port ?? 22) || 22,
      b.sshUser ?? b.ssh_user ?? null,
      b.sshPass ?? b.ssh_pass ?? null
    );
  const id = Number(info.lastInsertRowid);
  const probe = await probeNocDevice({
    host,
    ports: portsToStore(b.ports),
    snmp_port: Number(b.snmpPort ?? b.snmp_port ?? 161) || 161,
    snmp_community: String(b.snmpCommunity ?? b.snmp_community ?? 'public'),
  });
  persistProbe(id, probe);
  const row = db.prepare('SELECT * FROM noc_devices WHERE id = ?').get(id);
  res.status(201).json(row);
});

nocRouter.put('/noc/devices/:id', async (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM noc_devices WHERE id = ?').get(id) as any;
  if (!existing) return res.status(404).json({ error: 'Device not found' });
  const b = req.body || {};
  const name = b.name != null ? String(b.name).trim() : existing.name;
  const host = b.host != null ? String(b.host).trim() : existing.host;
  const kind = b.kind != null ? String(b.kind).trim().toLowerCase() : existing.kind;
  if (!name || !host) return res.status(400).json({ error: 'Name and host are required.' });
  db.prepare(
    `UPDATE noc_devices SET name=?, kind=?, host=?, ports=?, snmp_port=?, snmp_community=?, notes=?,
       enabled=?, ssh_port=?, ssh_user=?, ssh_pass=COALESCE(?, ssh_pass) WHERE id=?`
  ).run(
    name,
    kind,
    host,
    b.ports != null ? portsToStore(b.ports) : existing.ports,
    b.snmpPort != null || b.snmp_port != null
      ? Number(b.snmpPort ?? b.snmp_port) || 161
      : existing.snmp_port,
    b.snmpCommunity != null || b.snmp_community != null
      ? String(b.snmpCommunity ?? b.snmp_community)
      : existing.snmp_community,
    b.notes != null ? String(b.notes) : existing.notes,
    b.enabled != null ? (b.enabled ? 1 : 0) : existing.enabled,
    b.sshPort != null || b.ssh_port != null ? Number(b.sshPort ?? b.ssh_port) || 22 : existing.ssh_port || 22,
    b.sshUser != null || b.ssh_user != null ? String(b.sshUser ?? b.ssh_user) : existing.ssh_user,
    b.sshPass != null || b.ssh_pass != null ? String(b.sshPass ?? b.ssh_pass) : null,
    id
  );
  if (b.probe !== false) {
    const row = db.prepare('SELECT * FROM noc_devices WHERE id = ?').get(id) as any;
    const probe = await probeNocDevice(row);
    persistProbe(id, probe);
  }
  res.json(db.prepare('SELECT * FROM noc_devices WHERE id = ?').get(id));
});

nocRouter.delete('/noc/devices/:id', (req, res) => {
  const id = Number(req.params.id);
  const info = db.prepare('DELETE FROM noc_devices WHERE id = ?').run(id);
  if (!info.changes) return res.status(404).json({ error: 'Device not found' });
  res.json({ ok: true });
});

let nocTimer: ReturnType<typeof setInterval> | null = null;

export function startNocMonitor(intervalMs = 60_000) {
  if (nocTimer) clearInterval(nocTimer);
  // Defer first pass so boot isn't slammed alongside other schedulers
  setTimeout(() => {
    runNocProbePass().catch((e) => console.error('[noc] probe pass failed:', e));
  }, 20_000);
  nocTimer = setInterval(() => {
    runNocProbePass().catch((e) => console.error('[noc] probe pass failed:', e));
  }, intervalMs);
}
