#!/usr/bin/env node
// Convert a database backup from another system into an MT-Billing .db.
//
//   node server/scripts/import-db.mjs <source.sqlite> [referenceMtDb] [outDb]
//
// Defaults:
//   referenceMtDb = server/data/mt-billing.db   (used only to copy the schema)
//   outDb         = server/data/imported.db
//
// After it runs, load the output via System Settings -> Database Management ->
// Restore (or copy it to server/data/mt-billing.db) and restart the server.
//
// It auto-detects the source's subscriber / plan / router / payment tables and
// maps common column names. Review the summary it prints; if a field is missed,
// run inspect-db.mjs and tell me the columns so I can tailor the mapping.

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..');

const sourceFile = process.argv[2];
const referenceFile = process.argv[3] || path.join(serverDir, 'data', 'mt-billing.db');
const outFile = process.argv[4] || path.join(serverDir, 'data', 'imported.db');

if (!sourceFile) {
  console.error('Usage: node server/scripts/import-db.mjs <source.sqlite> [referenceMtDb] [outDb]');
  process.exit(1);
}
if (!fs.existsSync(sourceFile)) {
  console.error(`Source not found: ${sourceFile}`);
  process.exit(1);
}
if (!fs.existsSync(referenceFile)) {
  console.error(`Reference MT-Billing DB not found: ${referenceFile}\nStart the panel once so it creates server/data/mt-billing.db, or pass the path as the 2nd argument.`);
  process.exit(1);
}

const src = new Database(sourceFile, { readonly: true, fileMustExist: true });
const ref = new Database(referenceFile, { readonly: true, fileMustExist: true });

// Fresh output DB with MT-Billing's schema (copied from the reference DB).
if (fs.existsSync(outFile)) fs.rmSync(outFile);
const out = new Database(outFile);
const schema = ref.prepare("SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all();
out.exec('PRAGMA foreign_keys=OFF;');
for (const s of schema) {
  try {
    out.exec(s.sql + ';');
  } catch (e) {
    /* ignore already-exists */
  }
}
ref.close();

// ---- helpers ----
const srcTables = src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((t) => t.name);
function findTable(candidates) {
  for (const c of candidates) {
    const hit = srcTables.find((t) => t.toLowerCase() === c || t.toLowerCase().includes(c));
    if (hit) return hit;
  }
  return null;
}
function rowsOf(table) {
  try {
    return src.prepare(`SELECT * FROM "${table}"`).all();
  } catch {
    return [];
  }
}
const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
function pick(row, candidates, fallback = null) {
  const keys = Object.keys(row);
  for (const cand of candidates) {
    const n = norm(cand);
    const k = keys.find((x) => norm(x) === n);
    if (k != null && row[k] != null && row[k] !== '') return row[k];
  }
  return fallback;
}
function toDate(v) {
  if (!v) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
function account12() {
  return String(Math.floor(100000000000 + Math.random() * 900000000000));
}

// MikroTik ppp-secret comments store billing data as JSON, e.g.
// {"plan":"UNLI500","dueDate":"2026-08-07","expireProfile":"non-payments",
//  "customer":{"fullName":"...","address":"...","contactNumber":"...","email":"...",
//   "napId":"nap_...","status":"active","plcPort":"8","latitude":13.9,"longitude":120.9},
//  "accountNumber":992215186158}
function parseMeta(row) {
  if (!row) return null;
  for (const k of Object.keys(row)) {
    const v = row[k];
    if (typeof v === 'string' && v.trim().startsWith('{')) {
      try {
        const o = JSON.parse(v);
        if (o && typeof o === 'object' && (o.plan || o.customer || o.accountNumber || o.dueDate)) return o;
      } catch {
        /* not JSON */
      }
    }
  }
  return null;
}
function mapStatus(s) {
  const v = String(s || '').toLowerCase();
  if (/^(active|enabled|online|1|true)$/.test(v)) return 'Active';
  if (/non.?pay/.test(v)) return 'non-payment';
  if (/expire/.test(v)) return 'expired';
  if (/disable/.test(v)) return 'disabled';
  if (/inactive/.test(v)) return 'inactive';
  return s ? String(s) : 'Active';
}

const summary = {};

// ---- Plans / profiles ----
const planTable = findTable(['profiles', 'plans', 'packages', 'billing_plans', 'billingplan', 'plan']);
if (planTable) {
  const ins = out.prepare('INSERT OR IGNORE INTO profiles (name, rate_limit, price, type) VALUES (?, ?, ?, ?)');
  let n = 0;
  for (const r of rowsOf(planTable)) {
    const name = pick(r, ['name', 'plan', 'profile', 'package', 'title']);
    if (!name) continue;
    ins.run(String(name), String(pick(r, ['rate_limit', 'rate', 'speed', 'bandwidth', 'ratelimit'], '') || ''), Number(pick(r, ['price', 'amount', 'fee', 'cost'], 0)) || 0, 'pppoe');
    n++;
  }
  summary.profiles = `${n} from "${planTable}"`;
}

// ---- Routers / NAS ----
const routerTable = findTable(['routers', 'router', 'nas', 'devices', 'mikrotik']);
if (routerTable) {
  const ins = out.prepare('INSERT INTO routers (name, host, port, api_user, api_pass, board, type, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  let n = 0;
  for (const r of rowsOf(routerTable)) {
    const name = pick(r, ['name', 'router', 'nasname', 'identity', 'hostname']);
    if (!name) continue;
    ins.run(
      String(name),
      pick(r, ['host', 'ip', 'address', 'ipaddress', 'nasip']),
      Number(pick(r, ['port', 'apiport'], 8728)) || 8728,
      pick(r, ['api_user', 'user', 'username', 'apiuser']),
      pick(r, ['api_pass', 'pass', 'password', 'apipassword']),
      pick(r, ['board', 'model']),
      String(pick(r, ['type', 'service'], 'pppoe') || 'pppoe').toLowerCase().includes('ipoe') ? 'ipoe' : 'pppoe',
      'online'
    );
    n++;
  }
  summary.routers = `${n} from "${routerTable}"`;
}

// ---- Subscribers ----
function detectSecretTable() {
  for (const t of srcTables) {
    let row = null;
    try {
      row = src.prepare(`SELECT * FROM "${t}" LIMIT 1`).get();
    } catch {
      row = null;
    }
    if (parseMeta(row)) return t;
  }
  return null;
}
const userTable =
  findTable(['pppoe_users', 'subscribers', 'customers', 'clients', 'secrets', 'ppp_secret', 'pppsecret', 'users', 'accounts', 'members']) ||
  detectSecretTable();

if (userTable) {
  // Build a plan -> price lookup from the copied profiles, and add any plan
  // names that appear on subscribers but aren't defined yet.
  const planPrice = {};
  for (const p of out.prepare('SELECT name, price FROM profiles').all()) planPrice[p.name] = p.price;
  const ensurePlan = out.prepare("INSERT OR IGNORE INTO profiles (name, rate_limit, price, type) VALUES (?, '', 0, 'pppoe')");

  const ins = out.prepare(
    `INSERT INTO pppoe_users
      (username, password, customer_name, account_number, profile, status, subscription_due, price,
       router_id, service, expiration_profile, contact, email, address, plc_port, lat, lng, online)
     VALUES (@username, @password, @customer_name, @account_number, @profile, @status, @subscription_due, @price,
       1, 'pppoe', @expiration_profile, @contact, @email, @address, @plc_port, @lat, @lng, @online)`
  );

  let n = 0;
  const tx = out.transaction(() => {
    for (const r of rowsOf(userTable)) {
      const meta = parseMeta(r) || {};
      const cust = meta.customer || {};
      const username = pick(r, ['username', 'user', 'login', 'name']);
      if (!username) continue;

      const plan = String(meta.plan || pick(r, ['profile', 'plan', 'package', 'billing_plan']) || '15mbps');
      if (!(plan in planPrice)) {
        ensurePlan.run(plan);
        planPrice[plan] = 0;
      }
      const status = mapStatus(cust.status != null ? cust.status : pick(r, ['status', 'state'], 'Active'));

      ins.run({
        username: String(username),
        password: pick(r, ['password', 'pass', 'secret']) || '',
        customer_name: cust.fullName || pick(r, ['customer_name', 'fullname', 'full_name', 'customer', 'name']) || String(username),
        account_number: String(meta.accountNumber || pick(r, ['account_number', 'account', 'accountno', 'accountnumber']) || account12()),
        profile: plan,
        status,
        subscription_due:
          toDate(meta.dueDate || pick(r, ['subscription_due', 'expiry', 'expiration', 'expire_date', 'due', 'duedate', 'valid_until'])) ||
          new Date().toISOString().slice(0, 10),
        price: Number(planPrice[plan]) || 0,
        expiration_profile: String(meta.expireProfile || 'default'),
        contact: cust.contactNumber || pick(r, ['contact', 'phone', 'mobile', 'contact_number']),
        email: cust.email || pick(r, ['email', 'mail', 'email_address']),
        address: cust.address || pick(r, ['address', 'full_address', 'location']),
        plc_port: cust.plcPort != null && cust.plcPort !== '' ? String(cust.plcPort) : null,
        lat: cust.latitude != null ? Number(cust.latitude) : null,
        lng: cust.longitude != null ? Number(cust.longitude) : null,
        online: /active/i.test(status) ? 1 : 0,
      });
      n++;
    }
  });
  tx();
  summary.pppoe_users = `${n} from "${userTable}"`;
}

// ---- Payments / transactions ----
const payTable = findTable(['transactions', 'payments', 'invoices', 'billing', 'ledger', 'collections']);
if (payTable) {
  const ins = out.prepare('INSERT INTO transactions (customer_name, amount, type, created_at) VALUES (?, ?, ?, ?)');
  let n = 0;
  for (const r of rowsOf(payTable)) {
    const amount = Number(pick(r, ['amount', 'price', 'total', 'paid', 'value'], 0)) || 0;
    if (!amount) continue;
    const dt = pick(r, ['created_at', 'date', 'paid_at', 'timestamp', 'datetime', 'payment_date']);
    ins.run(
      pick(r, ['customer_name', 'customer', 'name', 'username', 'account']) || 'Imported',
      amount,
      'payment',
      dt ? new Date(String(dt)).toISOString() : new Date().toISOString()
    );
    n++;
  }
  summary.transactions = `${n} from "${payTable}"`;
}

src.close();
out.close();

console.log('\nImport complete →', outFile);
console.log('Detected source tables:', srcTables.join(', ') || '(none)');
console.log('Mapped:');
for (const k of Object.keys(summary)) console.log(`  ${k}: ${summary[k]}`);
if (Object.keys(summary).length === 0) {
  console.log('  (nothing matched — run inspect-db.mjs and share the table/column names)');
}
console.log('\nNext: Database Management -> Restore -> choose', path.basename(outFile), '(then restart), or copy it to server/data/mt-billing.db');
