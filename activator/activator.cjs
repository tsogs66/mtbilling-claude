#!/usr/bin/env node
/*
 * MT-Billing Activator (vendor tool) — License + Password Reset
 *
 * Generates codes that match a customer's Hardware ID / Panel ID (same value):
 *   - License key  → paste on System → License (duration-bound)
 *   - Reset code   → paste on login → Forgot password (account recovery)
 *
 * Algorithms MUST match server/src/panelId.ts
 */
'use strict';

const crypto = require('crypto');
const readline = require('readline');

const LICENSE_SECRET = 'MT-BILLING-LICENSE-2026';
const PASSWORD_RESET_SECRET = 'MT-BILLING-PASSWORD-RESET-2026';

const DURATIONS = [
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: '180d', label: '6 months' },
  { id: '1y', label: '1 year' },
  { id: '2y', label: '2 years' },
  { id: 'life', label: 'Lifetime' },
];

function normalizeCode(k) {
  return String(k || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function formatBody(hex) {
  return hex.slice(0, 5) + '-' + hex.slice(5, 10) + '-' + hex.slice(10, 15) + '-' + hex.slice(15, 20);
}

/** Legacy perpetual key (no duration) — still accepted by the panel as lifetime. */
function licenseKeyLegacy(hwid) {
  const h = crypto.createHmac('sha256', LICENSE_SECRET).update(normalizeCode(hwid)).digest('hex').toUpperCase();
  return formatBody(h);
}

function licenseKeyFor(hwid, duration) {
  const id = String(duration || 'life').toLowerCase();
  const known = DURATIONS.find((d) => d.id === id);
  const dur = known ? known.id : 'life';
  const payload = normalizeCode(hwid) + '|' + dur;
  const h = crypto.createHmac('sha256', LICENSE_SECRET).update(payload).digest('hex').toUpperCase();
  return formatBody(h) + '-' + dur.toUpperCase();
}

function resetCodeFor(hwid) {
  const h = crypto.createHmac('sha256', PASSWORD_RESET_SECRET).update(normalizeCode(hwid)).digest('hex').toUpperCase();
  return 'RST-' + h.slice(0, 4) + '-' + h.slice(4, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16);
}

function printResult(hwid, duration) {
  const id = String(hwid || '').toUpperCase().trim();
  const dur = String(duration || 'life').toLowerCase();
  const durLabel = (DURATIONS.find((d) => d.id === dur) || DURATIONS[DURATIONS.length - 1]).label;
  const license = licenseKeyFor(id, dur);
  const reset = resetCodeFor(id);
  console.log('');
  console.log('  ============================================');
  console.log('   MT-Billing Activator (License + Recovery)');
  console.log('  ============================================');
  console.log('   Hardware / Panel ID : ' + id);
  console.log('   Expiration          : ' + durLabel + ' (' + dur + ')');
  console.log('   License Key         : ' + license);
  console.log('   Password Reset Code : ' + reset);
  console.log('  ============================================');
  console.log('');
  console.log('  License  → customer pastes on System → License');
  console.log('  Recovery → customer pastes on login → Forgot password');
  console.log('');
}

function usage() {
  console.log('Usage:');
  console.log('  mt-billing-activator.exe <HARDWARE-OR-PANEL-ID> [--days 30d|90d|180d|1y|2y|life]');
  console.log('  mt-billing-activator.exe                  (interactive)');
  console.log('  mt-billing-activator.exe --license <ID> [--days 1y]');
  console.log('  mt-billing-activator.exe --reset <ID>');
  console.log('');
  console.log('Durations: ' + DURATIONS.map((d) => d.id).join(', '));
}

function parseDays(args) {
  const i = args.indexOf('--days');
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const j = args.indexOf('--duration');
  if (j >= 0 && args[j + 1]) return args[j + 1];
  return 'life';
}

const args = process.argv.slice(2);
if (args[0] === '-h' || args[0] === '--help') {
  usage();
  process.exit(0);
}

if (args[0] === '--license' && args[1]) {
  const id = args[1];
  const days = parseDays(args);
  console.log('');
  console.log('  Hardware ID  : ' + String(id).toUpperCase().trim());
  console.log('  Expiration   : ' + days);
  console.log('  License Key  : ' + licenseKeyFor(id, days));
  console.log('');
} else if ((args[0] === '--reset' || args[0] === '--password-reset') && args[1]) {
  const id = args[1];
  console.log('');
  console.log('  Panel ID     : ' + String(id).toUpperCase().trim());
  console.log('  Reset Code   : ' + resetCodeFor(id));
  console.log('');
} else if (args[0] && !args[0].startsWith('-')) {
  printResult(args[0], parseDays(args));
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Enter the customer Hardware ID / Panel ID: ', (ans) => {
    console.log('');
    console.log('Select license expiration:');
    DURATIONS.forEach((d, i) => console.log('  ' + (i + 1) + ') ' + d.label + ' (' + d.id + ')'));
    rl.question('Choice [6 = lifetime]: ', (choice) => {
      const n = parseInt(choice, 10);
      const dur = DURATIONS[n - 1]?.id || 'life';
      printResult(ans.trim(), dur);
      rl.question('Press Enter to exit...', () => rl.close());
    });
  });
}

// Export for tests / HTML parity note
module.exports = { licenseKeyFor, licenseKeyLegacy, resetCodeFor, DURATIONS };
