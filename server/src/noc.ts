import express from 'express';
import { db } from './db.js';
import { probeOlt } from './olt.js';
import { probeRouter } from './mikrotik.js';

export const nocRouter = express.Router();

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
      });
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
    .map((d: any) => ({
      ...d,
      source: 'custom' as const,
      online: d.status === 'online',
    }));

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

nocRouter.post('/noc/devices', async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const host = String(b.host || '').trim();
  const kind = String(b.kind || 'other').trim().toLowerCase() || 'other';
  if (!name || !host) return res.status(400).json({ error: 'Name and host are required.' });
  const info = db
    .prepare(
      `INSERT INTO noc_devices (name, kind, host, ports, snmp_port, snmp_community, notes, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    )
    .run(
      name,
      kind,
      host,
      portsToStore(b.ports),
      Number(b.snmpPort ?? b.snmp_port ?? 161) || 161,
      String(b.snmpCommunity ?? b.snmp_community ?? 'public'),
      b.notes != null ? String(b.notes) : null
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
       enabled=? WHERE id=?`
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
