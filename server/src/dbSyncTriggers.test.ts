/**
 * Regression: every table in SYNC_CATEGORIES must get sync_outbox triggers on a
 * FRESH database. ensureSyncTriggers() skips tables that do not exist yet, so
 * initDbSync() has to run after every module that CREATEs a synced table —
 * it used to run before initIspOps/initIspDesk/initNoc/initOutageReportTables,
 * leaving job_orders, the NOC inventory, the outage reports and the whole
 * operations desk without an outbox on a first boot.
 *
 * Imports are dynamic on purpose: `import` is hoisted, so a static import of
 * db.js would open the developer's real database before MT_DATA_DIR is set.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-sync-triggers-'));
process.env.JWT_SECRET = 'sync-trigger-test';

const { db, initSchema, migrate, seed } = await import('./db.js');
const { initExtra } = await import('./extra.js');
const { initIspOps } = await import('./ispOps.js');
const { initIspDesk } = await import('./ispDesk.js');
const { initTwingate } = await import('./twingate.js');
const { initGenieacs } = await import('./genieacs.js');
const { initNoc } = await import('./noc.js');
const { initOutageReportTables } = await import('./outageMonitor.js');
const { initDbSync, SYNC_CATEGORIES } = await import('./dbSync.js');

// Same order as index.ts.
initSchema();
migrate();
seed();
initExtra();
initIspOps();
initIspDesk();
initTwingate();
initGenieacs();
initNoc();
initOutageReportTables();
initDbSync();

const triggers = new Set(
  (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`).all() as { name: string }[]).map(
    (r) => r.name
  )
);

const wanted = [...new Set(Object.values(SYNC_CATEGORIES).flat())];
const missing: string[] = [];
for (const table of wanted) {
  const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table);
  if (!exists) {
    missing.push(`${table} (table absent on a fresh DB)`);
    continue;
  }
  const base = `sync_outbox_${table}`.replace(/[^a-zA-Z0-9_]/g, '_');
  for (const suffix of ['ai', 'au', 'ad']) {
    if (!triggers.has(`${base}_${suffix}`)) missing.push(`${base}_${suffix}`);
  }
}
assert.deepEqual(missing, [], 'every synced table needs outbox triggers on a fresh DB');

// Operations-desk tables specifically — these were missing from SYNC_CATEGORIES.
for (const t of ['isp_payments', 'cashier_closes', 'area_outages', 'session_history', 'job_orders']) {
  assert.ok(wanted.includes(t), `${t} is in a sync category`);
  assert.ok(triggers.has(`sync_outbox_${t}_ai`), `${t} has an insert outbox trigger`);
}

// Per-site tables stay OUT: a shared BIR receipt series would collide between branches.
for (const t of ['isp_settings', 'cgnat_logs']) {
  assert.ok(!wanted.includes(t), `${t} is deliberately not synced`);
}

fs.rmSync(process.env.MT_DATA_DIR!, { recursive: true, force: true });
console.log('dbSyncTriggers.test.ts: ok');

export {};
