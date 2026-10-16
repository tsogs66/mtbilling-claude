/**
 * Regression: sync_outbox triggers must not use json_object() with >63 pairs (breaks sqlite3 CLI).
 */
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-dbsync-'));
const dbPath = path.join(tmp, 'test.db');

const db = new Database(dbPath);
const colDefs = ['id INTEGER PRIMARY KEY', ...Array.from({ length: 90 }, (_, i) => `c${i} TEXT`)];
db.exec(`CREATE TABLE app_settings (${colDefs.join(', ')});`);
db.exec(`CREATE TABLE sync_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op TEXT NOT NULL DEFAULT 'upsert',
  payload TEXT,
  updated_at TEXT,
  next_attempt_at TEXT,
  UNIQUE (entity_type, entity_id)
);`);
db.exec(`INSERT INTO app_settings (id) VALUES (1);`);
db.exec(`ALTER TABLE app_settings ADD COLUMN sync_enabled INTEGER DEFAULT 0`);
db.exec(`ALTER TABLE app_settings ADD COLUMN sync_role TEXT DEFAULT 'standalone'`);

const cols = (db.prepare('PRAGMA table_info(app_settings)').all() as { name: string }[]).map((c) => c.name);
const chunkSize = 30;
const parts: string[] = [];
for (let i = 0; i < cols.length; i += chunkSize) {
  const slice = cols.slice(i, i + chunkSize);
  const inner = slice.map((c) => `'${c}', NEW.${c}`).join(', ');
  parts.push(`json_object(${inner})`);
}
const jsonPayload = parts.slice(1).reduce((acc, part) => `json_patch(${acc}, ${part})`, parts[0]);

db.exec(`
  CREATE TRIGGER sync_outbox_app_settings_au AFTER UPDATE ON app_settings
  WHEN (SELECT sync_enabled FROM app_settings WHERE id = 1) = 1
   AND (SELECT sync_role FROM app_settings WHERE id = 1) = 'edge'
  BEGIN
    INSERT INTO sync_outbox (entity_type, entity_id, op, payload, updated_at, next_attempt_at)
    VALUES ('app_settings', CAST(NEW.id AS TEXT), 'upsert', ${jsonPayload}, datetime('now'), datetime('now'));
  END;
`);
db.close();

execSync(`sqlite3 "${dbPath}" "UPDATE app_settings SET c0 = 'wired' WHERE id = 1"`, { stdio: 'pipe' });
const row = execSync(`sqlite3 "${dbPath}" "SELECT c0 FROM app_settings WHERE id = 1"`, { encoding: 'utf8' }).trim();
assert.equal(row, 'wired');
console.log('dbSync.test.ts: ok');
