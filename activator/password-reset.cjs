#!/usr/bin/env node
/*
 * MT-Billing Password Reset Activator (vendor tool).
 * Prefer the unified activator/activator.cjs which also generates license keys.
 *
 * Algorithm must match server/src/panelId.ts (expectedPasswordResetCode).
 */
'use strict';

const crypto = require('crypto');
const readline = require('readline');

const PASSWORD_RESET_SECRET = 'MT-BILLING-PASSWORD-RESET-2026';

function normalizeCode(k) {
  return String(k || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function resetCodeFor(hwid) {
  const norm = normalizeCode(hwid);
  const h = crypto.createHmac('sha256', PASSWORD_RESET_SECRET).update(norm).digest('hex').toUpperCase();
  return 'RST-' + h.slice(0, 4) + '-' + h.slice(4, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16);
}

function printResult(panelId) {
  const code = resetCodeFor(panelId);
  console.log('');
  console.log('  ========================================');
  console.log('   MT-Billing Password Reset Activator');
  console.log('  ========================================');
  console.log('   Panel ID   : ' + String(panelId).toUpperCase().trim());
  console.log('   Reset Code : ' + code);
  console.log('  ========================================');
  console.log('');
  console.log('  Tip: use activator/activator.cjs for license + recovery together.');
  console.log('');
}

const arg = process.argv[2];
if (arg) {
  printResult(arg);
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Enter the customer Panel ID: ', (ans) => {
    printResult(ans.trim());
    rl.question('Press Enter to exit...', () => rl.close());
  });
}
