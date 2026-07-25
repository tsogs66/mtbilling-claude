import express from 'express';
import bcrypt from 'bcryptjs';
import { db } from './db.js';
import {
  panelHardwareId,
  expectedLicenseKey,
  validateLicenseKey,
  expiresAtFromDuration,
  LICENSE_DURATIONS,
} from './panelId.js';
import {
  fetchWanRoutes,
  setRouteEnabled,
  fetchFirewallRules,
  fetchIpRoutes,
  fetchVlans,
  fetchMultiWanLinks,
  fetchNetworkInterfaces,
  fetchVlanParentInterfaces,
  isPppoeInterface,
  setFirewallRuleEnabled,
  removeFirewallRule,
  addFirewallRule,
  addIpRoute,
  removeIpRoute,
  addVlan,
  removeVlan,
} from './mikrotik.js';
import { getUpdaterStatus, applyUpdate, UPDATE_REPO, readUpdateJob } from './updater.js';

export const extraRouter = express.Router();

/** All panel menu permission keys (must match client Sidebar). */
export const ALL_PERMISSIONS = [
  'dashboard', 'terminal', 'ai', 'routers', 'network', 'pppoe', 'ipoe', 'map',
  'zerotier', 'super-router', 'files', 'sales', 'inventory', 'hotspot',
  'notifications', 'uptime', 'logs', 'company', 'settings', 'roles', 'updater', 'license',
] as const;

// Shared license / password-reset signing secrets live in panelId.ts.
// Vendor tools: activator/activator.cjs (unified) and server/scripts/*-activator.mjs
// must use the same normalizeCode + HMAC algorithms.

function columnExists(table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === col);
}

export function initExtra() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vouchers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      plan TEXT,
      price REAL DEFAULT 0,
      speed TEXT,
      validity TEXT,
      status TEXT DEFAULT 'unused',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      used_at TEXT
    );
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      permissions TEXT DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS wan_routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      router_id INTEGER,
      router_name TEXT,
      gateway TEXT NOT NULL,
      check_method TEXT DEFAULT 'ping',
      distance INTEGER DEFAULT 1,
      status TEXT DEFAULT 'Active',
      enabled INTEGER DEFAULT 1,
      interface_name TEXT,
      dst_address TEXT DEFAULT '0.0.0.0/0',
      route_id TEXT
    );
    CREATE TABLE IF NOT EXISTS map_connectors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      from_id INTEGER NOT NULL,
      to_id INTEGER NOT NULL,
      points TEXT NOT NULL,
      UNIQUE(kind, from_id, to_id)
    );
  `);

  for (const [col, type] of [
    ['router_id', 'INTEGER'],
    ['router_name', 'TEXT'],
    ['interface_name', 'TEXT'],
    ['dst_address', "TEXT DEFAULT '0.0.0.0/0'"],
    ['route_id', 'TEXT'],
  ] as [string, string][]) {
    if (!columnExists('wan_routes', col)) db.exec(`ALTER TABLE wan_routes ADD COLUMN ${col} ${type}`);
  }

  // Drop stale sample WAN routes that were never synced from a live router.
  db.prepare("DELETE FROM wan_routes WHERE route_id IS NULL OR route_id = ''").run();

  for (const [col, type] of [
    ['license_key', 'TEXT'],
    ['license_activated', 'INTEGER DEFAULT 0'],
    ['license_expires_at', 'TEXT'],
    ['license_duration', 'TEXT'],
    ['zerotier_api_token', 'TEXT'],
    ['zerotier_network_id', 'TEXT'],
    ['zerotier_node_name', 'TEXT'],
  ] as [string, string][]) {
    if (!columnExists('app_settings', col)) db.exec(`ALTER TABLE app_settings ADD COLUMN ${col} ${type}`);
  }

  if ((db.prepare('SELECT COUNT(*) AS c FROM roles').get() as any).c === 0) {
    const ins = db.prepare('INSERT INTO roles (name, description, permissions) VALUES (?, ?, ?)');
    ins.run('Administrator', 'Full access to all panel features', JSON.stringify(['*']));
    ins.run(
      'Technician',
      'Manage clients, routers and network',
      JSON.stringify(['dashboard', 'terminal', 'pppoe', 'ipoe', 'routers', 'network', 'map', 'files', 'logs', 'license'])
    );
    ins.run(
      'Cashier',
      'Billing and payments only',
      JSON.stringify(['dashboard', 'pppoe', 'sales', 'notifications', 'hotspot', 'license'])
    );
    ins.run(
      'Read-only',
      'View the entire system without making changes',
      JSON.stringify([...ALL_PERMISSIONS, 'readonly'])
    );
  }

  ensureReadOnlyRoleViewsAll();
  seedDefaultPanelUsers();
}

/** Keep the built-in Read-only role able to open every menu (writes blocked separately). */
function ensureReadOnlyRoleViewsAll() {
  const row = db.prepare("SELECT id, permissions FROM roles WHERE name = 'Read-only'").get() as
    | { id: number; permissions: string }
    | undefined;
  const desired = JSON.stringify([...ALL_PERMISSIONS, 'readonly']);
  if (!row) {
    db.prepare('INSERT INTO roles (name, description, permissions) VALUES (?, ?, ?)').run(
      'Read-only',
      'View the entire system without making changes',
      desired
    );
    return;
  }
  db.prepare('UPDATE roles SET description = ?, permissions = ? WHERE id = ?').run(
    'View the entire system without making changes',
    desired,
    row.id
  );
}

/** Default logins for each role (documented in Panel Roles). */
export function seedDefaultPanelUsers() {
  // Normalize legacy role names first
  db.prepare("UPDATE users SET role = 'Administrator' WHERE role IN ('superadmin', 'admin')").run();

  const defaults: { username: string; password: string; role: string }[] = [
    { username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASS || 'admin123', role: 'Administrator' },
    { username: 'technician', password: 'tech123', role: 'Technician' },
    { username: 'cashier', password: 'cash123', role: 'Cashier' },
    { username: 'viewer', password: 'view123', role: 'Read-only' },
  ];
  const has = db.prepare('SELECT id FROM users WHERE username = ?');
  const ins = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)');
  for (const u of defaults) {
    if (has.get(u.username)) continue;
    ins.run(u.username, bcrypt.hashSync(u.password, 10), u.role);
  }
}

// ---------------- Network (live MikroTik only — no mock/sample fallbacks) ----------------
function resolveNetworkRouter(req: express.Request): { router: any; error?: string; status?: number } {
  const routerId = Number(req.query.routerId || req.body?.routerId || 0);
  if (!routerId) {
    return { router: null, error: 'Select a router in the top bar.', status: 400 };
  }
  const router = db.prepare('SELECT * FROM routers WHERE id = ?').get(routerId) as any;
  if (!router) return { router: null, error: 'Router not found', status: 404 };
  if (!router.host || !router.api_user) {
    return { router: null, error: 'Router API credentials not configured.', status: 400 };
  }
  return { router };
}

async function syncWanRoutesFromRouters(routerId?: number | null) {
  const routers = (
    routerId
      ? db.prepare('SELECT * FROM routers WHERE id = ?').all(routerId)
      : db.prepare('SELECT * FROM routers').all()
  ) as any[];
  const collected: {
    router_id: number;
    router_name: string;
    route_id: string;
    gateway: string;
    check_method: string;
    distance: number;
    status: string;
    enabled: number;
    interface_name: string | null;
    dst_address: string;
  }[] = [];

  for (const r of routers) {
    if (!r.host || !r.api_user) continue;
    try {
      const routes = await fetchWanRoutes(r);
      for (const route of routes) {
        collected.push({
          router_id: r.id,
          router_name: r.name,
          route_id: route.routeId,
          gateway: route.gateway,
          check_method: route.checkMethod,
          distance: route.distance,
          status: route.status,
          enabled: route.enabled ? 1 : 0,
          interface_name: route.interfaceName,
          dst_address: route.dstAddress,
        });
      }
    } catch {
      /* router unreachable */
    }
  }

  if (routerId) {
    db.prepare('DELETE FROM wan_routes WHERE router_id = ?').run(routerId);
  } else {
    db.prepare('DELETE FROM wan_routes').run();
  }

  if (collected.length === 0) return false;

  const ins = db.prepare(
    `INSERT INTO wan_routes (router_id, router_name, route_id, gateway, check_method, distance, status, enabled, interface_name, dst_address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of collected) {
    ins.run(
      row.router_id,
      row.router_name,
      row.route_id,
      row.gateway,
      row.check_method,
      row.distance,
      row.status,
      row.enabled,
      row.interface_name,
      row.dst_address
    );
  }
  return true;
}

function getRouterConn(routerId: number) {
  return db.prepare('SELECT * FROM routers WHERE id = ?').get(routerId) as any;
}

extraRouter.get('/network/wan', async (req, res) => {
  const routerId = req.query.routerId ? Number(req.query.routerId) : null;
  if (!routerId) return res.status(400).json({ error: 'Select a router in the top bar.', routes: [], live: false });
  const router = getRouterConn(routerId);
  if (!router) return res.status(404).json({ error: 'Router not found', routes: [], live: false });
  if (!router.host || !router.api_user) {
    return res.status(400).json({ error: 'Router API credentials not configured.', routes: [], live: false });
  }

  let live = false;
  let fetchError = '';
  try {
    live = await syncWanRoutesFromRouters(routerId);
  } catch (e: any) {
    fetchError = e?.message || 'Could not reach MikroTik';
  }

  const routes = live
    ? (db
        .prepare(
          `SELECT id, router_id AS routerId, router_name AS routerName, gateway,
                  check_method AS checkMethod, distance, status, enabled,
                  interface_name AS interfaceName, dst_address AS dstAddress
           FROM wan_routes WHERE router_id = ? AND route_id IS NOT NULL ORDER BY distance, id`
        )
        .all(routerId) as any[])
    : [];

  if (!live && !fetchError) {
    try {
      await fetchWanRoutes(router);
    } catch (e: any) {
      fetchError = e?.message || 'Could not reach MikroTik';
    }
  }

  res.json({
    routes,
    live,
    routerId,
    routerName: router.name,
    error: fetchError || undefined,
  });
});

extraRouter.post('/network/wan/:id/toggle', async (req, res) => {
  const id = Number(req.params.id);
  const row = db
    .prepare('SELECT id, router_id, route_id, gateway, enabled FROM wan_routes WHERE id = ?')
    .get(id) as any;
  if (!row) return res.status(404).json({ error: 'not found' });
  if (!row.route_id) return res.status(400).json({ error: 'Route is not linked to a live MikroTik route. Refresh the WAN list.' });

  const router = getRouterConn(row.router_id);
  if (!router?.host || !router?.api_user) {
    return res.status(400).json({ error: 'Router API credentials not configured.' });
  }

  const enable = !row.enabled;
  try {
    await setRouteEnabled(router, row.route_id, enable);
    db.prepare('UPDATE wan_routes SET enabled = ?, status = ? WHERE id = ?').run(
      enable ? 1 : 0,
      enable ? 'Active' : 'Disabled',
      id
    );
    db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
      'info',
      'network',
      `${enable ? 'Enabled' : 'Disabled'} WAN route ${row.gateway} on ${router.name}`
    );
    res.json({ ok: true, enabled: enable });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || 'Could not update route on MikroTik router' });
  }
});

extraRouter.post('/network/wan/toggle-all', async (req, res) => {
  const enable = !!req.body?.enabled;
  const routerId = req.body?.routerId ? Number(req.body.routerId) : req.query.routerId ? Number(req.query.routerId) : null;
  const rows = (
    routerId
      ? db
          .prepare('SELECT id, router_id, route_id, gateway FROM wan_routes WHERE route_id IS NOT NULL AND router_id = ?')
          .all(routerId)
      : db.prepare('SELECT id, router_id, route_id, gateway FROM wan_routes WHERE route_id IS NOT NULL').all()
  ) as { id: number; router_id: number; route_id: string; gateway: string }[];

  if (rows.length === 0) {
    return res.status(400).json({ error: 'No live WAN routes to update. Select a reachable router and refresh.' });
  }

  const errors: string[] = [];
  for (const row of rows) {
    const router = getRouterConn(row.router_id);
    if (!router?.host || !router?.api_user) continue;
    try {
      await setRouteEnabled(router, row.route_id, enable);
      db.prepare('UPDATE wan_routes SET enabled = ?, status = ? WHERE id = ?').run(
        enable ? 1 : 0,
        enable ? 'Active' : 'Disabled',
        row.id
      );
    } catch (e: any) {
      errors.push(`${router.name} ${row.gateway}: ${e?.message || 'failed'}`);
    }
  }

  if (errors.length === rows.length) {
    return res.status(502).json({ error: errors[0] || 'Could not update routes on MikroTik' });
  }

  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
    'info',
    'network',
    `${enable ? 'Enabled' : 'Disabled'} all WAN routes (${rows.length - errors.length}/${rows.length})`
  );
  res.json({ ok: true, enabled: enable, errors: errors.length ? errors : undefined });
});

extraRouter.get('/network/firewall', async (req, res) => {
  const { router, error, status } = resolveNetworkRouter(req);
  if (!router) return res.status(status || 400).json({ error, rules: [], live: false });
  try {
    const rules = await fetchFirewallRules(router);
    res.json({ rules, live: true, routerId: router.id, routerName: router.name });
  } catch (e: any) {
    res.status(502).json({
      error: e?.message || 'Could not fetch firewall rules from MikroTik',
      rules: [],
      live: false,
      routerId: router.id,
      routerName: router.name,
    });
  }
});

extraRouter.post('/network/firewall/toggle', async (req, res) => {
  const { router, error, status } = resolveNetworkRouter(req);
  if (!router) return res.status(status || 400).json({ error });
  const table = String(req.body?.table || '');
  const id = String(req.body?.id || '');
  const enabled = !!req.body?.enabled;
  if (!['filter', 'nat', 'mangle'].includes(table) || !id) {
    return res.status(400).json({ error: 'table and id are required' });
  }
  try {
    await setFirewallRuleEnabled(router, table as 'filter' | 'nat' | 'mangle', id, enabled);
    res.json({ ok: true, enabled });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || 'Could not update firewall rule on MikroTik' });
  }
});

extraRouter.delete('/network/firewall', async (req, res) => {
  const { router, error, status } = resolveNetworkRouter(req);
  if (!router) return res.status(status || 400).json({ error });
  const table = String(req.query.table || req.body?.table || '');
  const id = String(req.query.id || req.body?.id || '');
  if (!['filter', 'nat', 'mangle'].includes(table) || !id) {
    return res.status(400).json({ error: 'table and id are required' });
  }
  try {
    await removeFirewallRule(router, table as 'filter' | 'nat' | 'mangle', id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || 'Could not remove firewall rule on MikroTik' });
  }
});

extraRouter.post('/network/firewall', async (req, res) => {
  const { router, error, status } = resolveNetworkRouter(req);
  if (!router) return res.status(status || 400).json({ error });
  const table = String(req.body?.table || 'filter');
  if (!['filter', 'nat', 'mangle'].includes(table)) {
    return res.status(400).json({ error: 'Invalid firewall table' });
  }
  const fields: Record<string, string> = {};
  if (req.body?.chain) fields.chain = String(req.body.chain);
  if (req.body?.action) fields.action = String(req.body.action);
  if (req.body?.protocol) fields.protocol = String(req.body.protocol);
  if (req.body?.dstPort) fields['dst-port'] = String(req.body.dstPort);
  if (req.body?.srcAddress) fields['src-address'] = String(req.body.srcAddress);
  if (req.body?.dstAddress) fields['dst-address'] = String(req.body.dstAddress);
  if (req.body?.comment) fields.comment = String(req.body.comment);
  if (!fields.chain || !fields.action) {
    return res.status(400).json({ error: 'chain and action are required' });
  }
  try {
    await addFirewallRule(router, table as 'filter' | 'nat' | 'mangle', fields);
    res.status(201).json({ ok: true });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || 'Could not add firewall rule on MikroTik' });
  }
});

extraRouter.get('/network/routes', async (req, res) => {
  const { router, error, status } = resolveNetworkRouter(req);
  if (!router) return res.status(status || 400).json({ error, routes: [], vlans: [], live: false });
  try {
    const [allRoutes, allVlans, parentIfaces] = await Promise.all([
      fetchIpRoutes(router),
      fetchVlans(router),
      fetchVlanParentInterfaces(router).catch(() => [] as { name: string; type: string; running: boolean }[]),
    ]);
    // Hide PPPoE-related dynamic routes and VLAN parents from this management view.
    const routes = allRoutes.filter((r) => {
      if (isPppoeInterface(r.gateway || '') || isPppoeInterface(r.interfaceName || '')) return false;
      const gw = String(r.gateway || '');
      if (gw.startsWith('<') && /pppoe/i.test(gw)) return false;
      return true;
    });
    const vlans = allVlans.filter((v) => !isPppoeInterface(v.iface || ''));
    res.json({
      routes,
      vlans,
      parentInterfaces: parentIfaces,
      live: true,
      routerId: router.id,
      routerName: router.name,
    });
  } catch (e: any) {
    res.status(502).json({
      error: e?.message || 'Could not fetch routes/VLANs from MikroTik',
      routes: [],
      vlans: [],
      parentInterfaces: [],
      live: false,
      routerId: router.id,
      routerName: router.name,
    });
  }
});

extraRouter.get('/network/vlan-parents', async (req, res) => {
  const { router, error, status } = resolveNetworkRouter(req);
  if (!router) return res.status(status || 400).json({ error, interfaces: [], live: false });
  try {
    const interfaces = await fetchVlanParentInterfaces(router);
    res.json({ interfaces, live: true, routerId: router.id, routerName: router.name });
  } catch (e: any) {
    res.status(502).json({
      error: e?.message || 'Could not fetch interfaces from MikroTik',
      interfaces: [],
      live: false,
    });
  }
});

extraRouter.post('/network/routes', async (req, res) => {
  const { router, error, status } = resolveNetworkRouter(req);
  if (!router) return res.status(status || 400).json({ error });
  const dst = String(req.body?.dst || '').trim();
  const gateway = String(req.body?.gateway || '').trim();
  if (!dst || !gateway) return res.status(400).json({ error: 'dst and gateway are required' });
  try {
    await addIpRoute(router, {
      dst,
      gateway,
      distance: req.body?.distance != null ? Number(req.body.distance) : undefined,
      comment: req.body?.comment ? String(req.body.comment) : undefined,
      checkGateway: req.body?.checkGateway ? String(req.body.checkGateway) : undefined,
    });
    res.status(201).json({ ok: true });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || 'Could not add route on MikroTik' });
  }
});

extraRouter.post('/network/routes/toggle', async (req, res) => {
  const { router, error, status } = resolveNetworkRouter(req);
  if (!router) return res.status(status || 400).json({ error });
  const id = String(req.body?.id || '');
  if (!id) return res.status(400).json({ error: 'id is required' });
  try {
    await setRouteEnabled(router, id, !!req.body?.enabled);
    res.json({ ok: true, enabled: !!req.body?.enabled });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || 'Could not toggle route on MikroTik' });
  }
});

extraRouter.delete('/network/routes', async (req, res) => {
  const { router, error, status } = resolveNetworkRouter(req);
  if (!router) return res.status(status || 400).json({ error });
  const id = String(req.query.id || req.body?.id || '');
  if (!id) return res.status(400).json({ error: 'id is required' });
  try {
    await removeIpRoute(router, id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || 'Could not remove route on MikroTik' });
  }
});

extraRouter.post('/network/vlans', async (req, res) => {
  const { router, error, status } = resolveNetworkRouter(req);
  if (!router) return res.status(status || 400).json({ error });
  const name = String(req.body?.name || '').trim();
  const vlanId = Number(req.body?.vlanId);
  const iface = String(req.body?.iface || '').trim();
  if (!name || !vlanId || !iface) return res.status(400).json({ error: 'name, vlanId and iface are required' });
  if (isPppoeInterface(iface)) {
    return res.status(400).json({ error: 'PPPoE interfaces cannot be used as VLAN parents. Choose ether/bridge/bond/wlan.' });
  }
  try {
    await addVlan(router, {
      name,
      vlanId,
      iface,
      comment: req.body?.comment ? String(req.body.comment) : undefined,
    });
    res.status(201).json({ ok: true });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || 'Could not add VLAN on MikroTik' });
  }
});

extraRouter.delete('/network/vlans', async (req, res) => {
  const { router, error, status } = resolveNetworkRouter(req);
  if (!router) return res.status(status || 400).json({ error });
  const id = String(req.query.id || req.body?.id || '');
  if (!id) return res.status(400).json({ error: 'id is required' });
  try {
    await removeVlan(router, id);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || 'Could not remove VLAN on MikroTik' });
  }
});

extraRouter.get('/network/multiwan', async (req, res) => {
  const { router, error, status } = resolveNetworkRouter(req);
  if (!router) {
    return res.status(status || 400).json({
      error,
      enabled: false,
      strategy: '',
      links: [],
      interfaces: [],
      addresses: [],
      live: false,
    });
  }
  try {
    const [data, net] = await Promise.all([fetchMultiWanLinks(router), fetchNetworkInterfaces(router)]);
    res.json({
      ...data,
      interfaces: net.interfaces,
      addresses: net.addresses,
      live: true,
      routerId: router.id,
      routerName: router.name,
    });
  } catch (e: any) {
    res.status(502).json({
      error: e?.message || 'Could not fetch multi-WAN data from MikroTik',
      enabled: false,
      strategy: '',
      links: [],
      interfaces: [],
      addresses: [],
      live: false,
      routerId: router.id,
      routerName: router.name,
    });
  }
});

// ---------------- Inventory CRUD ----------------
extraRouter.post('/inventory', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name is required' });
  const info = db
    .prepare('INSERT INTO inventory (name, category, sku, quantity, unit_price, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(b.name, b.category || null, b.sku || null, Number(b.quantity) || 0, Number(b.unit_price) || 0, b.status || 'In Stock');
  res.status(201).json(db.prepare('SELECT * FROM inventory WHERE id = ?').get(info.lastInsertRowid));
});
extraRouter.put('/inventory/:id', (req, res) => {
  const id = Number(req.params.id);
  const ex = db.prepare('SELECT * FROM inventory WHERE id = ?').get(id) as any;
  if (!ex) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const quantity = b.quantity != null ? Number(b.quantity) : ex.quantity;
  const autoStatus = quantity <= 0 ? 'Out of Stock' : quantity <= 5 ? 'Low Stock' : 'In Stock';
  db.prepare('UPDATE inventory SET name=?, category=?, sku=?, quantity=?, unit_price=?, status=? WHERE id=?').run(
    b.name ?? ex.name,
    b.category ?? ex.category,
    b.sku ?? ex.sku,
    quantity,
    b.unit_price != null ? Number(b.unit_price) : ex.unit_price,
    b.status || autoStatus,
    id
  );
  res.json(db.prepare('SELECT * FROM inventory WHERE id = ?').get(id));
});
extraRouter.delete('/inventory/:id', (req, res) => {
  db.prepare('DELETE FROM inventory WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------------- Hotspot vouchers ----------------
const VOUCHER_PLANS: Record<string, { price: number; speed: string; validity: string }> = {
  '1 Hour': { price: 5, speed: '5M/5M', validity: '1h' },
  '1 Day': { price: 20, speed: '10M/10M', validity: '1d' },
  '1 Week': { price: 100, speed: '10M/10M', validity: '7d' },
  '30 Days': { price: 350, speed: '15M/15M', validity: '30d' },
};
extraRouter.get('/hotspot/vouchers', (_req, res) => {
  res.json(db.prepare('SELECT id, code, plan, price, speed, validity, status, created_at AS createdAt, used_at AS usedAt FROM vouchers ORDER BY id DESC LIMIT 500').all());
});
extraRouter.post('/hotspot/vouchers/generate', (req, res) => {
  const plan = String(req.body?.plan || '1 Day');
  const count = Math.min(200, Math.max(1, Math.floor(Number(req.body?.count) || 1)));
  const p = VOUCHER_PLANS[plan] || VOUCHER_PLANS['1 Day'];
  const ins = db.prepare('INSERT INTO vouchers (code, plan, price, speed, validity, status) VALUES (?, ?, ?, ?, ?, ?)');
  const created: string[] = [];
  const tx = db.transaction(() => {
    for (let i = 0; i < count; i++) {
      let code = '';
      for (let a = 0; a < 3; a++) {
        code = Array.from({ length: 3 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('') +
          '-' + Math.floor(1000 + Math.random() * 9000);
        try {
          ins.run(code, plan, p.price, p.speed, p.validity, 'unused');
          created.push(code);
          break;
        } catch {
          /* code collision, retry */
        }
      }
    }
  });
  tx();
  res.json({ ok: true, count: created.length, plan });
});
extraRouter.delete('/hotspot/vouchers/:id', (req, res) => {
  db.prepare('DELETE FROM vouchers WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------------- ZeroTier ----------------
function getZtSettings() {
  return db.prepare('SELECT zerotier_api_token, zerotier_network_id, zerotier_node_name FROM app_settings WHERE id = 1').get() as any;
}

extraRouter.get('/zerotier/settings', (_req, res) => {
  const s = getZtSettings() || {};
  res.json({
    apiTokenSet: !!s.zerotier_api_token,
    networkId: s.zerotier_network_id || '',
    nodeName: s.zerotier_node_name || '',
  });
});

extraRouter.put('/zerotier/settings', (req, res) => {
  const b = req.body || {};
  const cur = getZtSettings() || {};
  const token = b.apiToken != null && b.apiToken !== '' ? String(b.apiToken) : cur.zerotier_api_token;
  const networkId = b.networkId != null ? String(b.networkId) : cur.zerotier_network_id;
  const nodeName = b.nodeName != null ? String(b.nodeName) : cur.zerotier_node_name;
  db.prepare('UPDATE app_settings SET zerotier_api_token=?, zerotier_network_id=?, zerotier_node_name=? WHERE id=1').run(
    token || null,
    networkId || null,
    nodeName || null
  );
  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run('info', 'zerotier', 'ZeroTier settings updated');
  res.json({ ok: true, apiTokenSet: !!token, networkId: networkId || '', nodeName: nodeName || '' });
});

extraRouter.get('/zerotier', (_req, res) => {
  const s = getZtSettings() || {};
  const configured = !!(s.zerotier_api_token && s.zerotier_network_id);
  if (!configured) {
    return res.json({
      configured: false,
      online: false,
      address: s.zerotier_node_name || 'not-configured',
      networks: [],
      message: 'Configure ZeroTier API token and Network ID in Setup below.',
    });
  }
  res.json({
    configured: true,
    online: true,
    address: s.zerotier_node_name || 'local-node',
    networks: [
      {
        id: s.zerotier_network_id,
        name: s.zerotier_network_id,
        status: 'OK',
        assignedIp: '—',
        members: [
          { name: s.zerotier_node_name || 'panel-host', ip: '—', authorized: true, online: true },
        ],
      },
    ],
  });
});

// ---------------- Updater (GitHub: tsogs66/MT-Billing) ----------------
extraRouter.get('/updater', async (_req, res) => {
  try {
    const status = await getUpdaterStatus();
    res.json(status);
  } catch (e: any) {
    res.status(500).json({
      current: 'unknown',
      latest: 'unknown',
      updateAvailable: false,
      changelog: [],
      lastChecked: new Date().toISOString(),
      repo: UPDATE_REPO.url,
      branch: UPDATE_REPO.branch,
      error: e?.message || 'Updater failed',
      job: null,
    });
  }
});

extraRouter.get('/updater/job', (_req, res) => {
  res.json({ job: readUpdateJob() });
});

extraRouter.post('/updater/check', async (_req, res) => {
  try {
    const status = await getUpdaterStatus();
    res.json({
      updateAvailable: status.updateAvailable,
      latest: status.latest,
      lastChecked: status.lastChecked,
      repo: status.repo,
      branch: status.branch,
      currentSha: status.currentSha,
      latestSha: status.latestSha,
      changelog: status.changelog,
      error: status.error,
      job: status.job,
    });
  } catch (e: any) {
    res.status(502).json({ error: e?.message || 'Could not check GitHub for updates', repo: UPDATE_REPO.url });
  }
});

extraRouter.post('/updater/apply', async (_req, res) => {
  try {
    const result = await applyUpdate();
    if (!result.ok) return res.status(409).json(result);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ ok: false, message: e?.message || 'Update failed', repo: UPDATE_REPO.url });
  }
});

// ---------------- Panel Roles ----------------
extraRouter.get('/roles', (_req, res) => {
  const rows = db.prepare('SELECT id, name, description, permissions FROM roles ORDER BY id').all() as any[];
  rows.forEach((r) => {
    try {
      r.permissions = JSON.parse(r.permissions || '[]');
    } catch {
      r.permissions = [];
    }
  });
  res.json(rows);
});
extraRouter.post('/roles', (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name is required' });
  const info = db
    .prepare('INSERT INTO roles (name, description, permissions) VALUES (?, ?, ?)')
    .run(b.name, b.description || null, JSON.stringify(b.permissions || []));
  res.status(201).json({ id: info.lastInsertRowid });
});
extraRouter.put('/roles/:id', (req, res) => {
  const id = Number(req.params.id);
  const ex = db.prepare('SELECT * FROM roles WHERE id = ?').get(id) as any;
  if (!ex) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  db.prepare('UPDATE roles SET name=?, description=?, permissions=? WHERE id=?').run(
    b.name ?? ex.name,
    b.description ?? ex.description,
    JSON.stringify(b.permissions != null ? b.permissions : JSON.parse(ex.permissions || '[]')),
    id
  );
  res.json({ ok: true });
});
extraRouter.delete('/roles/:id', (req, res) => {
  db.prepare('DELETE FROM roles WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------------- Panel users (login accounts bound to roles) ----------------
extraRouter.get('/panel-users', (_req, res) => {
  const rows = db
    .prepare('SELECT id, username, role, created_at AS createdAt FROM users ORDER BY id')
    .all();
  res.json(rows);
});

extraRouter.post('/panel-users', (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim();
  const password = String(b.password || '');
  const role = String(b.role || '').trim();
  if (!username || password.length < 6) {
    return res.status(400).json({ error: 'Username and password (min 6 chars) are required.' });
  }
  const roleRow = db.prepare('SELECT name FROM roles WHERE name = ?').get(role) as { name: string } | undefined;
  if (!roleRow) return res.status(400).json({ error: 'Select a valid role.' });
  try {
    const info = db
      .prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username, bcrypt.hashSync(password, 10), roleRow.name);
    res.status(201).json({
      id: info.lastInsertRowid,
      username,
      role: roleRow.name,
    });
  } catch {
    res.status(409).json({ error: 'Username already exists.' });
  }
});

extraRouter.put('/panel-users/:id', (req, res) => {
  const id = Number(req.params.id);
  const ex = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as any;
  if (!ex) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  const username = b.username != null ? String(b.username).trim() : ex.username;
  const role = b.role != null ? String(b.role).trim() : ex.role;
  if (b.role) {
    const roleRow = db.prepare('SELECT name FROM roles WHERE name = ?').get(role);
    if (!roleRow) return res.status(400).json({ error: 'Select a valid role.' });
  }
  try {
    if (b.password && String(b.password).length >= 6) {
      db.prepare('UPDATE users SET username=?, role=?, password_hash=? WHERE id=?').run(
        username,
        role,
        bcrypt.hashSync(String(b.password), 10),
        id
      );
    } else {
      db.prepare('UPDATE users SET username=?, role=? WHERE id=?').run(username, role, id);
    }
    res.json({ id, username, role });
  } catch {
    res.status(409).json({ error: 'Username already exists.' });
  }
});

extraRouter.delete('/panel-users/:id', (req: any, res) => {
  const id = Number(req.params.id);
  if (req.user?.id === id) return res.status(400).json({ error: 'Cannot delete your own account.' });
  const count = (db.prepare('SELECT COUNT(*) AS c FROM users').get() as any).c;
  if (count <= 1) return res.status(400).json({ error: 'Cannot delete the last panel user.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---------------- Log Viewer ----------------
extraRouter.get('/logs/router', (req, res) => {
  const r = db.prepare('SELECT id, name FROM routers WHERE id = ?').get(Number(req.query.routerId)) as any;
  const name = r?.name || 'Router';
  const cycle = [
    { topic: 'sstp,ppp,info', message: 'RemoteInboxVPN%v: disconnected' },
    { topic: 'sstp,ppp,info', message: 'RemoteInboxVPN%v: terminating... - failed to authenticate ourselves to peer' },
    { topic: 'sstp,ppp,info', message: 'RemoteInboxVPN%v: connecting...' },
    { topic: 'sstp,ppp,info', message: 'RemoteInboxVPN%v: initializing...' },
    { topic: 'pppoe,info', message: 'pppoe-in: authenticated' },
    { topic: 'system,info,account', message: 'user admin logged in via api' },
    { topic: 'dhcp,info', message: 'dhcp-lan assigned 10.20.0.14 to A4:2B:11:22:33:44' },
  ];
  const now = Date.now();
  const entries = Array.from({ length: 60 }, (_, i) => {
    const c = cycle[i % cycle.length];
    return { time: new Date(now - i * 10000).toISOString(), topic: c.topic, message: c.message };
  });
  res.json({ router: name, entries });
});

extraRouter.get('/logs/panel', (req, res) => {
  const proc = String(req.query.process) === 'api' ? 'mikrotik-api-backend' : 'mikrotik-manager';
  const dbName = proc.includes('api') ? 'superadmin database' : 'panel database';
  const lines = [`[TAILING] Tailing last 150 lines for [${proc}] process (change the value with --lines option)`, `[LOG] /root/.pm2/logs/${proc}-out.log last 150 lines:`];
  for (let i = 0; i < 150; i++) lines.push(`[mikrotik] | Connected to the ${dbName}.`);
  res.json({ process: proc, text: lines.join('\n') });
});

extraRouter.get('/logs/nginx', (_req, res) => {
  const paths = ['/', '/api/dashboard/host', '/api/pppoe/users?service=pppoe', '/api/map', '/api/sales?group=month', '/api/uptime'];
  const now = Date.now();
  const lines = Array.from({ length: 80 }, (_, i) => {
    const t = new Date(now - i * 3000).toUTCString();
    const p = paths[i % paths.length];
    return `172.30.0.1 - - [${t}] "GET ${p} HTTP/1.1" 200 ${180 + ((i * 37) % 900)} "-" "Mozilla/5.0"`;
  });
  res.json({ text: lines.join('\n') });
});

extraRouter.get('/logs/email', (req, res) => {
  const cat = String(req.query.category || 'payment');
  let where = "channel = 'email'";
  if (cat === 'payment') where += " AND (subject LIKE '%Payment%' OR subject LIKE '%Receipt%')";
  else if (cat === 'reminder') where += " AND (type = 'expiry_reminder' OR subject LIKE '%Reminder%' OR subject LIKE '%expire%')";
  else where += " AND type = 'manual' AND subject NOT LIKE '%Payment%' AND subject NOT LIKE '%Receipt%' AND subject NOT LIKE '%Reminder%'";
  const rows = db
    .prepare(`SELECT id, recipient, customer_name AS customer, subject, message, status, detail, created_at AS date FROM notifications WHERE ${where} ORDER BY id DESC LIMIT 200`)
    .all();
  res.json(rows);
});

// ---------------- License ----------------
function hardwareId(): string {
  return panelHardwareId();
}
export function expectedKeyFor(hwid: string): string {
  return expectedLicenseKey(hwid);
}

export function getLicenseStatus(): {
  activated: boolean;
  expired: boolean;
  expiresAt: string | null;
  duration: string | null;
  licenseKey: string | null;
} {
  const s = db
    .prepare('SELECT license_activated, license_key, license_expires_at, license_duration FROM app_settings WHERE id = 1')
    .get() as any;
  if (!s?.license_activated) {
    return { activated: false, expired: false, expiresAt: null, duration: null, licenseKey: null };
  }
  const expiresAt = s.license_expires_at || null;
  const expired = !!(expiresAt && new Date(expiresAt).getTime() < Date.now());
  if (expired && s.license_activated) {
    db.prepare('UPDATE app_settings SET license_activated = 0 WHERE id = 1').run();
    return { activated: false, expired: true, expiresAt, duration: s.license_duration || null, licenseKey: null };
  }
  return {
    activated: true,
    expired: false,
    expiresAt,
    duration: s.license_duration || null,
    licenseKey: s.license_key || null,
  };
}

extraRouter.get('/license', (_req, res) => {
  const status = getLicenseStatus();
  const hwid = hardwareId();
  res.json({
    hardwareId: hwid,
    activated: status.activated,
    expired: status.expired,
    expiresAt: status.expiresAt,
    duration: status.duration,
    licenseKey: status.activated ? status.licenseKey : null,
    durations: LICENSE_DURATIONS,
    product: 'MT-Billing',
    edition: status.activated
      ? status.duration === 'life' || !status.expiresAt
        ? 'Licensed (Lifetime)'
        : `Licensed until ${new Date(status.expiresAt!).toLocaleDateString()}`
      : status.expired
        ? 'Expired'
        : 'Unlicensed (trial)',
  });
});

extraRouter.post('/license/activate', (req, res) => {
  const hwid = hardwareId();
  const provided = String(req.body?.key || '');
  if (!provided.trim()) return res.status(400).json({ error: 'license key is required' });
  const result = validateLicenseKey(hwid, provided);
  if (!result.ok) {
    db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
      'warning',
      'license',
      'Invalid license activation attempt'
    );
    return res.status(400).json({ error: 'Invalid license key for this hardware ID.' });
  }
  const expiresAt = expiresAtFromDuration(result.duration);
  db.prepare(
    'UPDATE app_settings SET license_activated = 1, license_key = ?, license_duration = ?, license_expires_at = ? WHERE id = 1'
  ).run(result.licenseKey, result.duration, expiresAt);
  db.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
    'info',
    'license',
    `License activated (${result.duration}${expiresAt ? `, expires ${expiresAt}` : ', lifetime'})`
  );
  res.json({
    ok: true,
    activated: true,
    licenseKey: result.licenseKey,
    duration: result.duration,
    expiresAt,
  });
});

extraRouter.post('/license/deactivate', (_req, res) => {
  db.prepare(
    'UPDATE app_settings SET license_activated = 0, license_key = NULL, license_duration = NULL, license_expires_at = NULL WHERE id = 1'
  ).run();
  res.json({ ok: true, activated: false });
});
