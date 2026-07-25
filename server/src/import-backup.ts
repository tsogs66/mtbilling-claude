/**
 * One-time importer: reads the production panel SQLite backup (old schema)
 * and populates server/data/mt-billing.db (current MT-Billing schema).
 *
 * Usage: npx tsx server/src/import-backup.ts [path-to-backup.sqlite]
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backupPath = process.argv[2] || path.join(__dirname, '..', '..', 'panel-db-backup-2026-07-10T10-36-00.938Z.sqlite');
const dataDir = path.join(__dirname, '..', 'data');
const dbPath = path.join(dataDir, 'mt-billing.db');

function mapStatus(s: string): string {
  const v = (s || '').toLowerCase();
  if (v === 'active') return 'Active';
  if (v === 'expired') return 'expired';
  if (v === 'inactive' || v === 'suspended') return 'inactive';
  return 'Active';
}

function initSchema(fresh: Database.Database) {
  fresh.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE routers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      host TEXT, port INTEGER DEFAULT 8728,
      api_user TEXT, api_pass TEXT,
      board TEXT, type TEXT DEFAULT 'pppoe', status TEXT DEFAULT 'online'
    );
    CREATE TABLE profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, rate_limit TEXT, price REAL DEFAULT 0, type TEXT DEFAULT 'pppoe'
    );
    CREATE TABLE pppoe_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL, customer_name TEXT, account_number TEXT,
      profile TEXT, status TEXT DEFAULT 'Active', subscription_due TEXT,
      price REAL DEFAULT 0, router_id INTEGER, address TEXT,
      lat REAL, lng REAL, nap_id INTEGER, service TEXT DEFAULT 'pppoe', online INTEGER DEFAULT 1
    );
    CREATE TABLE naps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, kind TEXT DEFAULT 'nap',
      lat REAL, lng REAL, ports INTEGER DEFAULT 8, parent_id INTEGER
    );
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pppoe_user_id INTEGER, customer_name TEXT,
      amount REAL NOT NULL, type TEXT DEFAULT 'payment',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE queues (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, avg_rate REAL DEFAULT 0
    );
    CREATE TABLE inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, category TEXT,
      sku TEXT, quantity INTEGER DEFAULT 0, unit_price REAL DEFAULT 0, status TEXT DEFAULT 'In Stock'
    );
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT DEFAULT 'info',
      source TEXT, message TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE company (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT, address TEXT, phone TEXT, email TEXT, currency TEXT DEFAULT 'PHP'
    );
  `);
}

function main() {
  if (!fs.existsSync(backupPath)) {
    console.error(`Backup not found: ${backupPath}`);
    process.exit(1);
  }

  const src = new Database(backupPath, { readonly: true });
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  for (const f of fs.readdirSync(dataDir)) {
    if (f.startsWith('mt-billing.db')) fs.unlinkSync(path.join(dataDir, f));
  }

  const fresh = new Database(dbPath);
  fresh.pragma('journal_mode = WAL');
  initSchema(fresh);

  const routerMap = new Map<string, number>();
  const napMap = new Map<string, number>();
  const oltMap = new Map<string, number>();

  const tx = fresh.transaction(() => {
    const routers = src.prepare('SELECT id, name, host, user, password, port FROM routers').all() as any[];
    const insRouter = fresh.prepare(
      'INSERT INTO routers (name, host, port, api_user, api_pass, board, type, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const r of routers) {
      const info = insRouter.run(
        r.name,
        r.host,
        r.port === 80 ? 8728 : r.port,
        r.user || '',
        r.password || '',
        'MikroTik RouterBoard',
        'pppoe',
        'online'
      );
      routerMap.set(r.id, Number(info.lastInsertRowid));
    }
    if (routerMap.size === 0) {
      const info = insRouter.run('PPPoE MT Router', '192.168.88.1', 8728, '', '', 'MikroTik RouterBoard', 'pppoe', 'online');
      routerMap.set('default', Number(info.lastInsertRowid));
    }

    const plans = src.prepare('SELECT name, price, pppoeProfile FROM billing_plans').all() as any[];
    const insProfile = fresh.prepare('INSERT INTO profiles (name, rate_limit, price, type) VALUES (?, ?, ?, ?)');
    const profileNames = new Set<string>();
    for (const p of plans) {
      const prof = p.pppoeProfile || p.name;
      if (!profileNames.has(prof)) {
        const rate = prof.includes('mbps') ? prof.replace('mbps', 'M') + '/' + prof.replace('mbps', 'M') : prof;
        insProfile.run(prof, rate, p.price || 0, 'pppoe');
        profileNames.add(prof);
      }
    }
    if (profileNames.size === 0) insProfile.run('15mbps', '15M/15M', 500, 'pppoe');

    const planProfile = new Map<string, string>();
    for (const p of plans) planProfile.set(p.name, p.pppoeProfile || '15mbps');

    const insNap = fresh.prepare('INSERT INTO naps (name, kind, lat, lng, ports, parent_id) VALUES (?, ?, ?, ?, ?, ?)');
    for (const o of src.prepare('SELECT id, name, latitude, longitude FROM olts').all() as any[]) {
      const info = insNap.run(o.name, 'olt', o.latitude, o.longitude, 128, null);
      oltMap.set(o.id, Number(info.lastInsertRowid));
      napMap.set(o.id, Number(info.lastInsertRowid));
    }
    for (const n of src.prepare('SELECT id, name, napCode, latitude, longitude, oltId FROM naps').all() as any[]) {
      const parent = n.oltId ? oltMap.get(n.oltId) ?? null : null;
      const info = insNap.run(n.name || n.napCode, 'nap', n.latitude, n.longitude, 8, parent);
      napMap.set(n.id, Number(info.lastInsertRowid));
    }

    const sales = src.prepare('SELECT clientName, planName, date FROM sales_records ORDER BY date').all() as {
      clientName: string;
      planName: string;
      date: string;
    }[];
    const latestPlan = new Map<string, string>();
    for (const s of sales) latestPlan.set(s.clientName.toLowerCase(), s.planName);

    const accounts = new Map<string, string>();
    for (const a of src.prepare('SELECT username, accountNumber FROM pppoe_account_numbers').all() as any[]) {
      accounts.set(a.username, String(a.accountNumber));
    }

    const customers = src.prepare('SELECT * FROM customers').all() as any[];
    const insUser = fresh.prepare(
      `INSERT INTO pppoe_users (username, customer_name, account_number, profile, status, subscription_due, price, router_id, address, lat, lng, nap_id, service, online)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const defaultRouter = [...routerMap.values()][0];
    for (const c of customers) {
      const planName = latestPlan.get((c.fullName || '').toLowerCase());
      const profile = planName ? (planProfile.get(planName) || '15mbps') : '15mbps';
      const plan = plans.find((p: any) => p.name === planName);
      const due = new Date();
      due.setMonth(due.getMonth() + 1);
      const status = mapStatus(c.status);
      insUser.run(
        c.username,
        c.fullName || c.username,
        accounts.get(c.username) || String(Math.floor(Math.random() * 1e12)),
        profile,
        status,
        due.toISOString().slice(0, 10),
        plan?.price ?? 0,
        routerMap.get(c.routerId) || defaultRouter,
        c.address || '',
        c.latitude,
        c.longitude,
        c.napId ? napMap.get(c.napId) ?? null : null,
        'pppoe',
        status === 'Active' ? 1 : 0
      );
    }

    const insTx = fresh.prepare('INSERT INTO transactions (customer_name, amount, type, created_at) VALUES (?, ?, ?, ?)');
    for (const s of src.prepare('SELECT clientName, finalAmount, date FROM sales_records').all() as any[]) {
      insTx.run(s.clientName, s.finalAmount || 0, 'payment', s.date);
    }

    for (const u of src.prepare('SELECT username, password, role_id FROM users').all() as any[]) {
      const role = u.role_id === 'role_admin' ? 'superadmin' : 'admin';
      fresh.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(u.username, u.password, role);
    }

    const settings = Object.fromEntries(
      (src.prepare('SELECT key, value FROM company_settings').all() as { key: string; value: string }[]).map((r) => [
        r.key,
        r.value.replace(/^"|"$/g, ''),
      ])
    );
    fresh.prepare('INSERT INTO company (id, name, address, phone, email, currency) VALUES (1, ?, ?, ?, ?, ?)').run(
      settings.companyName || 'Pa-North Fiber Internet',
      settings.address || '',
      settings.contactNumber || '',
      settings.email || '',
      'PHP'
    );

    const insQ = fresh.prepare('INSERT INTO queues (name, avg_rate) VALUES (?, ?)');
    insQ.run('Downstream Total', 25.5);
    insQ.run('PPPoE Subscribers', customers.filter((c: any) => (c.status || '').toLowerCase() === 'active').length);

    fresh.prepare('INSERT INTO logs (level, source, message) VALUES (?, ?, ?)').run(
      'info',
      'import',
      `Imported production backup (${customers.length} customers, ${sales.length} sales)`
    );
  });

  tx();

  const counts = {
    routers: (fresh.prepare('SELECT COUNT(*) AS c FROM routers').get() as any).c,
    subscribers: (fresh.prepare('SELECT COUNT(*) AS c FROM pppoe_users').get() as any).c,
    transactions: (fresh.prepare('SELECT COUNT(*) AS c FROM transactions').get() as any).c,
    naps: (fresh.prepare('SELECT COUNT(*) AS c FROM naps').get() as any).c,
    users: (fresh.prepare('SELECT COUNT(*) AS c FROM users').get() as any).c,
  };

  console.log('Import complete:', counts);
  src.close();
  fresh.close();
}

main();
