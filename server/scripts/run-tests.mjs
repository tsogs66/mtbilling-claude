#!/usr/bin/env node
/**
 * Test runner for the server package.
 *
 * Importing most modules pulls in db.ts, which creates/opens the SQLite file at
 * MT_DATA_DIR on import — so without this the suite would touch (and create)
 * the developer's real server/data/mt-billing.db just by running. Point every
 * test at one throwaway directory and remove it afterwards.
 *
 * Usage: node scripts/run-tests.mjs [unit|smoke|all]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');

const SUITES = {
  unit: [
    'src/portalPassword.test.ts',
    'src/merchantPayMonths.test.ts',
    'src/genieacs.test.ts',
    'src/ispDesk.test.ts',
    'src/apiPermissions.test.ts',
    'src/dbSync.test.ts',
  ],
  smoke: ['src/dbSyncTriggers.test.ts', 'src/ispDesk.smoke.ts'],
};

const which = process.argv[2] || 'all';
const files = which === 'all' ? [...SUITES.unit, ...SUITES.smoke] : SUITES[which];
if (!files) {
  console.error(`Unknown suite "${which}". Use: unit | smoke | all`);
  process.exit(2);
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-tests-'));
const env = {
  ...process.env,
  MT_DATA_DIR: dataDir,
  JWT_SECRET: process.env.JWT_SECRET || 'test-secret',
  NODE_ENV: 'test',
};

let failed = 0;
for (const file of files) {
  // Each test gets its own sub-directory so one cannot see another's rows.
  const caseDir = path.join(dataDir, path.basename(file).replace(/\W+/g, '_'));
  fs.mkdirSync(caseDir, { recursive: true });
  const r = spawnSync('npx', ['tsx', file], {
    cwd: serverRoot,
    stdio: 'inherit',
    env: { ...env, MT_DATA_DIR: caseDir },
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    failed += 1;
    console.error(`\n✗ ${file} exited with ${r.status ?? r.signal}`);
  }
}

fs.rmSync(dataDir, { recursive: true, force: true });

if (failed) {
  console.error(`\n${failed} test file(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${files.length} test file(s) passed.`);
