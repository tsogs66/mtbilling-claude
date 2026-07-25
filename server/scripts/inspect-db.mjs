#!/usr/bin/env node
// Inspect any SQLite database: list tables, columns, row counts and a sample row.
//
//   node server/scripts/inspect-db.mjs /path/to/backup.db
//
// Use this first when importing a backup from another system so we can see how
// its schema maps onto MT-Billing.

import Database from 'better-sqlite3';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node server/scripts/inspect-db.mjs <path-to-source.db>');
  process.exit(1);
}

let db;
try {
  db = new Database(file, { readonly: true, fileMustExist: true });
} catch (e) {
  console.error(`Could not open "${file}": ${e.message}`);
  process.exit(1);
}

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all();

console.log(`\nDatabase: ${file}`);
console.log(`Tables: ${tables.length}\n`);

for (const { name } of tables) {
  const cols = db.prepare(`PRAGMA table_info("${name}")`).all().map((c) => `${c.name}:${c.type || '?'}`);
  let count = 0;
  try {
    count = db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get().c;
  } catch {
    /* ignore */
  }
  console.log(`── ${name}  (${count} rows)`);
  console.log(`   columns: ${cols.join(', ')}`);
  try {
    const sample = db.prepare(`SELECT * FROM "${name}" LIMIT 1`).get();
    if (sample) console.log(`   sample : ${JSON.stringify(sample)}`);
  } catch {
    /* ignore */
  }
  console.log('');
}

db.close();
