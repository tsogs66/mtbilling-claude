import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const dataDir = path.join(__dirname, '..', 'data');
export const backupsDir = path.join(dataDir, 'backups');
export const dbPath = path.join(dataDir, 'mt-billing.db');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

// If a restore was requested, apply the pending database file before opening
// the connection (safe: the live DB is never overwritten while it is open).
const pendingPath = `${dbPath}.pending`;
if (fs.existsSync(pendingPath)) {
  try {
    if (fs.existsSync(dbPath)) fs.renameSync(dbPath, path.join(backupsDir, `prerestore-${Date.now()}.db`));
    for (const ext of ['-wal', '-shm']) {
      const p = `${dbPath}${ext}`;
      if (fs.existsSync(p)) fs.rmSync(p);
    }
    fs.renameSync(pendingPath, dbPath);
  } catch {
    /* ignore and boot with existing db */
  }
}

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS routers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      host TEXT,
      port INTEGER DEFAULT 8728,
      ssh_port INTEGER DEFAULT 22,
      api_user TEXT,
      api_pass TEXT,
      board TEXT,
      type TEXT DEFAULT 'pppoe',
      status TEXT DEFAULT 'online'
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      rate_limit TEXT,
      price REAL DEFAULT 0,
      type TEXT DEFAULT 'pppoe',
      ppp_profile TEXT
    );

    CREATE TABLE IF NOT EXISTS pppoe_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      customer_name TEXT,
      account_number TEXT,
      profile TEXT,
      status TEXT DEFAULT 'Active',
      subscription_due TEXT,
      price REAL DEFAULT 0,
      router_id INTEGER,
      address TEXT,
      lat REAL,
      lng REAL,
      nap_id INTEGER,
      service TEXT DEFAULT 'pppoe',
      online INTEGER DEFAULT 1,
      password TEXT,
      expiration_profile TEXT DEFAULT 'default',
      contact TEXT,
      email TEXT,
      plc_port TEXT
    );

    CREATE TABLE IF NOT EXISTS naps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT DEFAULT 'nap',
      lat REAL,
      lng REAL,
      ports INTEGER DEFAULT 8,
      parent_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pppoe_user_id INTEGER,
      customer_name TEXT,
      amount REAL NOT NULL,
      type TEXT DEFAULT 'payment',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      receipt_json TEXT
    );

    CREATE TABLE IF NOT EXISTS queues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      avg_rate REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT,
      sku TEXT,
      quantity INTEGER DEFAULT 0,
      unit_price REAL DEFAULT 0,
      status TEXT DEFAULT 'In Stock'
    );

    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT DEFAULT 'info',
      source TEXT,
      message TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS company (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT,
      address TEXT,
      phone TEXT,
      email TEXT,
      currency TEXT DEFAULT 'PHP'
    );

    CREATE TABLE IF NOT EXISTS notify_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      reminder_enabled INTEGER DEFAULT 1,
      days_before INTEGER DEFAULT 3,
      email_enabled INTEGER DEFAULT 1,
      sms_enabled INTEGER DEFAULT 1,
      autodisable_enabled INTEGER DEFAULT 1,
      autodisable_hours INTEGER DEFAULT 24,
      email_from TEXT DEFAULT 'billing@pa-north.net',
      sms_sender TEXT DEFAULT 'PA-NORTH'
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      recipient TEXT,
      client_id INTEGER,
      customer_name TEXT,
      subject TEXT,
      message TEXT,
      type TEXT DEFAULT 'manual',
      status TEXT DEFAULT 'sent',
      detail TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      theme TEXT DEFAULT 'system',
      language TEXT DEFAULT 'en',
      currency TEXT DEFAULT 'PHP',
      ngrok_enabled INTEGER DEFAULT 0,
      ngrok_authtoken TEXT,
      ngrok_region TEXT DEFAULT 'ap',
      ngrok_port INTEGER DEFAULT 5173,
      ngrok_status TEXT DEFAULT 'stopped',
      ngrok_url TEXT,
      ai_provider TEXT DEFAULT 'anthropic',
      ai_api_key TEXT,
      ai_model TEXT DEFAULT 'claude-sonnet-4-20250514',
      ai_enabled INTEGER DEFAULT 0,
      cursor_api_key TEXT,
      cursor_model TEXT DEFAULT 'composer-2',
      cursor_repo_url TEXT,
      tz TEXT DEFAULT 'Asia/Manila',
      ntp_server TEXT DEFAULT 'time.cloudflare.com',
      public_base_url TEXT,
      cf_tunnel_token TEXT,
      cf_tunnel_hostname TEXT,
      cf_tunnel_port INTEGER DEFAULT 80,
      cf_tunnel_status TEXT DEFAULT 'stopped',
      cf_tunnel_url TEXT,
      cf_tunnel_enabled INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ai_scripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT,
      model TEXT,
      prompt TEXT,
      script TEXT,
      router_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS ipoe_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      download_mbps REAL DEFAULT 0,
      upload_mbps REAL DEFAULT 0,
      max_limit TEXT DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS ipoe_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      price REAL DEFAULT 0,
      cycle TEXT DEFAULT 'Monthly',
      profile_name TEXT,
      download_mbps REAL DEFAULT 0,
      upload_mbps REAL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ipoe_lease_meta (
      mac TEXT PRIMARY KEY,
      name TEXT,
      plan_name TEXT,
      due_at TEXT,
      payment_status TEXT DEFAULT 'Active',
      comment TEXT
    );
  `);
}

function count(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

function columnExists(table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === col);
}

/** Idempotent migrations for databases created before a column existed. */
export function migrate() {
  if (!columnExists('pppoe_users', 'online')) {
    db.exec('ALTER TABLE pppoe_users ADD COLUMN online INTEGER DEFAULT 1');
    setOnlineStates();
  }
  const addCols: [string, string][] = [
    ['password', 'TEXT'],
    ['expiration_profile', "TEXT DEFAULT 'default'"],
    ['contact', 'TEXT'],
    ['email', 'TEXT'],
    ['plc_port', 'TEXT'],
    ['nonpayment_since', 'TEXT'],
    ['reminder_sent', 'TEXT'],
  ];
  for (const [col, type] of addCols) {
    if (!columnExists('pppoe_users', col)) {
      db.exec(`ALTER TABLE pppoe_users ADD COLUMN ${col} ${type}`);
    }
  }
  if (!columnExists('profiles', 'ppp_profile')) {
    db.exec('ALTER TABLE profiles ADD COLUMN ppp_profile TEXT');
  }

  ensureBillingPlans();
  ensureIpoeBillingDefaults();
  ensureNotifySettings();

  // Gateway configuration columns (added over time).
  const notifyCols: [string, string][] = [
    ['smtp_host', 'TEXT'],
    ['smtp_port', 'INTEGER DEFAULT 587'],
    ['smtp_secure', 'INTEGER DEFAULT 0'],
    ['smtp_user', 'TEXT'],
    ['smtp_pass', 'TEXT'],
    ['smtp_from', 'TEXT'],
    ['sms_api_url', "TEXT DEFAULT 'https://smtpapi.vocotext.com/isms_send_all_id.php'"],
    ['sms_api_user', 'TEXT'],
    ['sms_api_pass', 'TEXT'],
    ['sms_type', 'INTEGER DEFAULT 1'],
    ['sms_provider', "TEXT DEFAULT 'isms'"],
  ];
  for (const [col, type] of notifyCols) {
    if (!columnExists('notify_settings', col)) db.exec(`ALTER TABLE notify_settings ADD COLUMN ${col} ${type}`);
  }
  if (!columnExists('company', 'logo')) db.exec('ALTER TABLE company ADD COLUMN logo TEXT');
  const companyPayCols: [string, string][] = [
    ['payment_qr', 'TEXT'],
    ['gcash_qr', 'TEXT'],
    ['maya_qr', 'TEXT'],
    ['gcash_number', 'TEXT'],
    ['maya_number', 'TEXT'],
    ['payment_instructions', 'TEXT'],
  ];
  for (const [col, type] of companyPayCols) {
    if (!columnExists('company', col)) db.exec(`ALTER TABLE company ADD COLUMN ${col} ${type}`);
  }

  if (count('app_settings') === 0) {
    db.prepare('INSERT INTO app_settings (id) VALUES (1)').run();
  }

  const appCols: [string, string][] = [
    ['cursor_api_key', 'TEXT'],
    ['cursor_model', "TEXT DEFAULT 'composer-2'"],
    ['cursor_repo_url', 'TEXT'],
    ['public_base_url', 'TEXT'],
    ['cf_tunnel_token', 'TEXT'],
    ['cf_tunnel_hostname', 'TEXT'],
    ['cf_tunnel_port', 'INTEGER DEFAULT 80'],
    ['cf_tunnel_status', "TEXT DEFAULT 'stopped'"],
    ['cf_tunnel_url', 'TEXT'],
    ['cf_tunnel_enabled', 'INTEGER DEFAULT 0'],
    // Default map picker / topology center (Batangas area)
    ['map_default_lat', 'REAL DEFAULT 13.918665341879885'],
    ['map_default_lng', 'REAL DEFAULT 120.93887161534413'],
  ];
  for (const [col, type] of appCols) {
    if (!columnExists('app_settings', col)) db.exec(`ALTER TABLE app_settings ADD COLUMN ${col} ${type}`);
  }
  // Ensure existing installs that already had nulls get the new default center once.
  db.prepare(
    `UPDATE app_settings SET
       map_default_lat = COALESCE(map_default_lat, 13.918665341879885),
       map_default_lng = COALESCE(map_default_lng, 120.93887161534413)
     WHERE id = 1`
  ).run();
  if (!columnExists('routers', 'ssh_port')) {
    db.exec('ALTER TABLE routers ADD COLUMN ssh_port INTEGER DEFAULT 22');
  }
  const routerMapCols: [string, string][] = [
    ['lat', 'REAL'],
    ['lng', 'REAL'],
    ['address', 'TEXT'],
  ];
  for (const [col, type] of routerMapCols) {
    if (!columnExists('routers', col)) db.exec(`ALTER TABLE routers ADD COLUMN ${col} ${type}`);
  }
  const napMapCols: [string, string][] = [
    ['code', 'TEXT'],
    ['status', "TEXT DEFAULT 'active'"],
    ['address', 'TEXT'],
    ['splitter_ratio', 'TEXT'],
    ['pon_port', 'INTEGER'],
    ['host', 'TEXT'],
    ['snmp_port', 'INTEGER DEFAULT 161'],
    ['snmp_community', "TEXT DEFAULT 'public'"],
    ['vendor', 'TEXT'],
    ['model', 'TEXT'],
    ['sys_name', 'TEXT'],
    ['firmware', 'TEXT'],
    ['last_probe_at', 'TEXT'],
    ['probe_error', 'TEXT'],
  ];
  for (const [col, type] of napMapCols) {
    if (!columnExists('naps', col)) db.exec(`ALTER TABLE naps ADD COLUMN ${col} ${type}`);
  }

  db.prepare("UPDATE naps SET name = 'OLT Main Server' WHERE kind = 'olt' AND name = 'OLT-1'").run();

  // One-time: remove demo/sample operational data; keep stock & inventory (+ users/settings).
  purgeSampleOperationalDataOnce();
  ensureBillingPlans();
  ensureIpoeBillingDefaults();
  ensureFiberInventory();

  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pppoe_user_id INTEGER NOT NULL,
      token TEXT UNIQUE NOT NULL,
      amount REAL,
      months INTEGER DEFAULT 1,
      status TEXT DEFAULT 'pending',
      expires_at TEXT,
      paid_at TEXT,
      external_ref TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS fair_use_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER DEFAULT 1,
      cap_percent INTEGER DEFAULT 95,
      sustain_minutes INTEGER DEFAULT 10,
      notify_email INTEGER DEFAULT 1,
      notify_sms INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS usage_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pppoe_user_id INTEGER,
      router_id INTEGER,
      alert_type TEXT,
      threshold_bps INTEGER,
      observed_bps INTEGER,
      profile TEXT,
      acknowledged INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS usage_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_type TEXT,
      subject_key TEXT,
      router_id INTEGER,
      rx_bytes INTEGER DEFAULT 0,
      tx_bytes INTEGER DEFAULT 0,
      rx_bps INTEGER DEFAULT 0,
      tx_bps INTEGER DEFAULT 0,
      sampled_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS usage_daily (
      subject_type TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      day TEXT NOT NULL,
      rx_bytes INTEGER DEFAULT 0,
      tx_bytes INTEGER DEFAULT 0,
      peak_rx_bps INTEGER DEFAULT 0,
      peak_tx_bps INTEGER DEFAULT 0,
      PRIMARY KEY (subject_type, subject_key, day)
    );
    CREATE TABLE IF NOT EXISTS usage_services (
      day TEXT NOT NULL,
      service_id TEXT NOT NULL,
      service_name TEXT,
      category TEXT,
      hits INTEGER DEFAULT 0,
      router_id INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, service_id, router_id)
    );
  `);
  if (!(db.prepare('SELECT 1 FROM fair_use_settings WHERE id = 1').get())) {
    db.prepare('INSERT INTO fair_use_settings (id) VALUES (1)').run();
  }

  const payLinkCols: [string, string][] = [
    ['pay_channel', 'TEXT'],
    ['proof_image', 'TEXT'],
    ['submitted_at', 'TEXT'],
    ['reviewed_at', 'TEXT'],
    ['review_note', 'TEXT'],
  ];
  for (const [col, type] of payLinkCols) {
    if (!columnExists('payment_links', col)) db.exec(`ALTER TABLE payment_links ADD COLUMN ${col} ${type}`);
  }

  if (!columnExists('transactions', 'receipt_json')) {
    db.exec('ALTER TABLE transactions ADD COLUMN receipt_json TEXT');
  }
}

/** Wipe seeded demo rows (routers, clients, sales, map, logs, etc.) once per database. Inventory is preserved. */
function purgeSampleOperationalDataOnce() {
  if (!columnExists('app_settings', 'sample_purged_v2')) {
    db.exec('ALTER TABLE app_settings ADD COLUMN sample_purged_v2 INTEGER DEFAULT 0');
  }
  if (count('app_settings') === 0) {
    db.prepare('INSERT INTO app_settings (id) VALUES (1)').run();
  }
  const row = db.prepare('SELECT sample_purged_v2 FROM app_settings WHERE id = 1').get() as
    | { sample_purged_v2: number }
    | undefined;
  if (row?.sample_purged_v2) return;

  const tx = db.transaction(() => {
    db.exec(`
      DELETE FROM pppoe_users;
      DELETE FROM naps;
      DELETE FROM transactions;
      DELETE FROM queues;
      DELETE FROM logs;
      DELETE FROM routers;
      DELETE FROM profiles;
      DELETE FROM ipoe_profiles;
      DELETE FROM ipoe_plans;
      DELETE FROM ipoe_lease_meta;
      DELETE FROM ai_scripts;
    `);
    try {
      db.exec('DELETE FROM wan_routes');
    } catch {
      /* table may not exist yet */
    }
    try {
      db.exec('DELETE FROM firewall_rules');
    } catch {
      /* optional */
    }
    try {
      db.prepare(
        `UPDATE notify_settings SET email_from = 'billing@localhost', sms_sender = 'ISP' WHERE id = 1`
      ).run();
    } catch {
      /* optional */
    }
    db.prepare('UPDATE app_settings SET sample_purged_v2 = 1 WHERE id = 1').run();
  });
  tx();
}

/** Catalog of basic fiber ISP equipment & peripherals (upsert by SKU). */
function ensureFiberInventory() {
  const items: [string, string, string, number, number, string][] = [
    ['Huawei ONT HG8145V5', 'ONU/ONT', 'ONT-HG8145', 42, 850, 'In Stock'],
    ['FiberHome AN5506-04-FG ONT', 'ONU/ONT', 'ONT-FH5506', 30, 780, 'In Stock'],
    ['ZTE F660 V8 ONT', 'ONU/ONT', 'ONT-ZTEF660', 25, 720, 'In Stock'],
    ['GPON OLT 4-PON', 'OLT', 'OLT-4PON', 2, 28000, 'Low Stock'],
    ['GPON OLT 8-PON', 'OLT', 'OLT-8PON', 1, 45000, 'Low Stock'],
    ['Fiber Drop Cable 1F Figure-8 (300m)', 'Cable', 'FDC-1F-300', 15, 2100, 'In Stock'],
    ['Aerial Fiber Cable 12F (1km)', 'Cable', 'AFC-12F-1K', 8, 8500, 'In Stock'],
    ['Aerial Fiber Cable 24F (1km)', 'Cable', 'AFC-24F-1K', 5, 12000, 'In Stock'],
    ['ADSS Fiber Cable 48F (1km)', 'Cable', 'ADSS-48F-1K', 2, 18500, 'Low Stock'],
    ['Indoor Duplex Fiber Patch Cord SC/APC 3m', 'Cable', 'PC-SCAPC-3M', 100, 45, 'In Stock'],
    ['Indoor Duplex Fiber Patch Cord SC/UPC 3m', 'Cable', 'PC-SCUPC-3M', 80, 40, 'In Stock'],
    ['Cat6 UTP Cable Box 305m', 'Cable', 'CAT6-305', 12, 3200, 'In Stock'],
    ['SC/APC Fast Connector', 'Connector', 'SCAPC-FC', 320, 25, 'In Stock'],
    ['SC/UPC Fast Connector', 'Connector', 'SCUPC-FC', 200, 22, 'In Stock'],
    ['LC/UPC Fast Connector', 'Connector', 'LCUPC-FC', 150, 28, 'In Stock'],
    ['SC/APC Adapter (simplex)', 'Connector', 'SCAPC-ADP', 250, 12, 'In Stock'],
    ['RJ45 Cat6 Connector (100pcs)', 'Connector', 'RJ45-CAT6-100', 20, 180, 'In Stock'],
    ['NAP Box 1x8 PLC Splitter', 'Splitter', 'NAP-8-PLC', 6, 1200, 'Low Stock'],
    ['NAP Box 16-port', 'Splitter', 'NAP-16', 4, 1600, 'Low Stock'],
    ['PLC Splitter 1x4 Bare', 'Splitter', 'PLC-1X4', 40, 180, 'In Stock'],
    ['PLC Splitter 1x8 Bare', 'Splitter', 'PLC-1X8', 35, 220, 'In Stock'],
    ['PLC Splitter 1x16 Bare', 'Splitter', 'PLC-1X16', 20, 350, 'In Stock'],
    ['PLC Splitter 1x32 Bare', 'Splitter', 'PLC-1X32', 10, 550, 'In Stock'],
    ['Dome Fiber Closure 48F', 'Enclosure', 'CLS-DOME-48', 8, 1400, 'In Stock'],
    ['Inline Fiber Closure 24F', 'Enclosure', 'CLS-INLINE-24', 10, 900, 'In Stock'],
    ['Outdoor Enclosure IP65', 'Enclosure', 'ENC-IP65', 6, 2100, 'In Stock'],
    ['ODF / Fiber Patch Panel 24-port', 'Enclosure', 'ODF-24', 4, 2800, 'In Stock'],
    ['MikroTik hAP ax3', 'Router', 'MT-HAPAX3', 3, 4500, 'Low Stock'],
    ['MikroTik hEX S (RB760iGS)', 'Router', 'MT-HEX-S', 5, 3200, 'In Stock'],
    ['MikroTik CCR2004', 'Router', 'MT-CCR2004', 1, 28000, 'Low Stock'],
    ['MikroTik CRS328-24P-4S+', 'Switch', 'MT-CRS328', 2, 18500, 'Low Stock'],
    ['Managed Switch 24-Port Gigabit', 'Switch', 'SW-24G', 3, 6500, 'In Stock'],
    ['SFP Module 1.25G 1310nm 20km', 'Transceiver', 'SFP-1G-1310', 40, 450, 'In Stock'],
    ['SFP Module 1.25G 1550nm 40km', 'Transceiver', 'SFP-1G-1550', 25, 650, 'In Stock'],
    ['SFP+ Module 10G LR', 'Transceiver', 'SFP10G-LR', 10, 1800, 'In Stock'],
    ['Media Converter RJ45–Fiber SC', 'Transceiver', 'MC-RJ45-SC', 15, 900, 'In Stock'],
    ['PoE Injector 24V/48V', 'Power', 'POE-INJ', 20, 350, 'In Stock'],
    ['UPS 650VA', 'Power', 'UPS-650', 4, 2800, 'In Stock'],
    ['UPS 1500VA', 'Power', 'UPS-1500', 2, 6500, 'Low Stock'],
    ['Battery 12V 100Ah', 'Power', 'BAT-12V-100', 6, 8500, 'In Stock'],
    ['Pole Bracket Clamp', 'Accessory', 'PBC-01', 0, 45, 'Out of Stock'],
    ['Wall Mount ONU Bracket', 'Accessory', 'ONU-BRKT', 50, 35, 'In Stock'],
    ['Steel Messenger Wire 1.5mm (1km)', 'Accessory', 'MSG-1.5-1K', 5, 2200, 'In Stock'],
    ['Dead-end Clamp', 'Accessory', 'CLMP-DEAD', 80, 25, 'In Stock'],
    ['Suspension Clamp', 'Accessory', 'CLMP-SUSP', 80, 22, 'In Stock'],
    ['Grounding Kit', 'Accessory', 'GND-KIT', 15, 180, 'In Stock'],
    ['Cable Ties (100pcs)', 'Accessory', 'TIE-100', 40, 50, 'In Stock'],
    ['Electrical Tape (roll)', 'Accessory', 'TAPE-ELEC', 60, 25, 'In Stock'],
    ['Heat Shrink Tubing Kit', 'Accessory', 'HST-KIT', 25, 120, 'In Stock'],
    ['Fusion Splice Sleeve (50pcs)', 'Tools', 'SPLICE-SLV-50', 30, 90, 'In Stock'],
    ['Fiber Cleaver', 'Tools', 'TOOL-CLEAVER', 3, 3500, 'Low Stock'],
    ['Fusion Splicer', 'Tools', 'TOOL-SPLICER', 1, 65000, 'Low Stock'],
    ['Optical Power Meter', 'Tools', 'TOOL-OPM', 4, 2800, 'In Stock'],
    ['Visual Fault Locator (VFL)', 'Tools', 'TOOL-VFL', 6, 650, 'In Stock'],
    ['OTDR Handheld', 'Tools', 'TOOL-OTDR', 1, 42000, 'Low Stock'],
    ['Fiber Stripper', 'Tools', 'TOOL-STRIP', 8, 280, 'In Stock'],
    ['RJ45 Crimp Tool', 'Tools', 'TOOL-CRIMP', 5, 450, 'In Stock'],
    ['Label Printer (handheld)', 'Peripherals', 'PER-LABEL', 2, 4500, 'Low Stock'],
    ['USB Serial Console Cable', 'Peripherals', 'PER-USB-CONS', 10, 350, 'In Stock'],
    ['Outdoor Wi-Fi CPE 5GHz', 'Peripherals', 'PER-CPE5', 8, 2200, 'In Stock'],
  ];
  const has = db.prepare('SELECT 1 FROM inventory WHERE sku = ?');
  const ins = db.prepare(
    'INSERT INTO inventory (name, category, sku, quantity, unit_price, status) VALUES (?, ?, ?, ?, ?, ?)'
  );
  for (const it of items) {
    if (!has.get(it[2])) ins.run(...it);
  }
}

/** Single-row notification settings, created with sensible defaults. */
function ensureNotifySettings() {
  if (count('notify_settings') === 0) {
    db.prepare(
      `INSERT INTO notify_settings
        (id, reminder_enabled, days_before, email_enabled, sms_enabled, autodisable_enabled, autodisable_hours, email_from, sms_sender)
       VALUES (1, 1, 3, 1, 1, 1, 24, 'billing@localhost', 'ISP')`
    ).run();
  }
}

/**
 * Panel billing plans only (type=plan). They reference an existing MikroTik
 * /ppp/profile via ppp_profile — they are never pushed to the router.
 */
function ensureBillingPlans() {
  const plans: [string, string, number][] = [
    ['UNLI500', '30M/30M', 500],
    ['UNLI700', '50M/50M', 700],
    ['UNLI1000', '100M/100M', 1000],
  ];
  const has = db.prepare('SELECT 1 FROM profiles WHERE name = ?');
  const ins = db.prepare(
    'INSERT INTO profiles (name, rate_limit, price, type, ppp_profile) VALUES (?, ?, ?, ?, ?)'
  );
  for (const [name, rate, price] of plans) {
    if (!has.get(name)) ins.run(name, rate, price, 'plan', null);
  }
  // Legacy rows that were stored as type=pppoe but are billing plans.
  db.prepare(
    `UPDATE profiles SET type = 'plan'
     WHERE name IN ('UNLI500', 'UNLI700', 'UNLI1000')
       AND coalesce(type, 'pppoe') != 'plan'`
  ).run();
  db.prepare(
    `UPDATE profiles SET type = 'plan'
     WHERE coalesce(type, 'pppoe') = 'pppoe'
       AND ppp_profile IS NOT NULL
       AND trim(ppp_profile) != ''`
  ).run();
}

/** Predefined IPoE speed profiles + billing plans (editable in the IPoE UI). */
function ensureIpoeBillingDefaults() {
  const profiles: [string, number, number][] = [
    ['IPOE-30', 30, 30],
    ['IPOE-50', 50, 50],
    ['IPOE-100', 100, 100],
  ];
  const hasProfile = db.prepare('SELECT 1 FROM ipoe_profiles WHERE name = ?');
  const insProfile = db.prepare(
    'INSERT INTO ipoe_profiles (name, download_mbps, upload_mbps, max_limit) VALUES (?, ?, ?, ?)'
  );
  for (const [name, down, up] of profiles) {
    if (!hasProfile.get(name)) insProfile.run(name, down, up, `${down}M/${up}M`);
  }

  const plans: [string, number, string, string][] = [
    ['UNLI500', 500, 'Monthly', 'IPOE-30'],
    ['UNLI700', 700, 'Monthly', 'IPOE-50'],
    ['UNLI1000', 1000, 'Monthly', 'IPOE-100'],
  ];
  const hasPlan = db.prepare('SELECT 1 FROM ipoe_plans WHERE name = ?');
  const insPlan = db.prepare(
    `INSERT INTO ipoe_plans (name, price, cycle, profile_name, download_mbps, upload_mbps)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const getProfile = db.prepare('SELECT download_mbps, upload_mbps FROM ipoe_profiles WHERE name = ?');
  for (const [name, price, cycle, profile] of plans) {
    if (hasPlan.get(name)) continue;
    const pr = getProfile.get(profile) as { download_mbps: number; upload_mbps: number } | undefined;
    insPlan.run(name, price, cycle, profile, pr?.download_mbps ?? 0, pr?.upload_mbps ?? 0);
  }
}

/** Derive a realistic ONU online/offline state from subscriber status. */
function setOnlineStates() {
  db.exec("UPDATE pppoe_users SET online = 0 WHERE status != 'Active'");
  db.exec("UPDATE pppoe_users SET online = CASE WHEN (id % 7 = 0) THEN 0 ELSE 1 END WHERE status = 'Active'");
}

/** Seed essentials only — no demo routers/clients/sales/map. Inventory is filled via ensureFiberInventory(). */
export function seed() {
  if (count('users') === 0) {
    const user = process.env.ADMIN_USER || 'admin';
    const pass = process.env.ADMIN_PASS || 'admin123';
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(
      user,
      bcrypt.hashSync(pass, 10),
      'Administrator'
    );
  } else {
    db.prepare("UPDATE users SET role = 'Administrator' WHERE role IN ('superadmin', 'admin')").run();
  }

  if (count('company') === 0) {
    db.prepare('INSERT INTO company (id, name, address, phone, email, currency) VALUES (1, ?, ?, ?, ?, ?)').run(
      'ISP Business',
      '',
      '',
      '',
      'PHP'
    );
  }

  ensureBillingPlans();
  ensureIpoeBillingDefaults();
  ensureFiberInventory();
}
