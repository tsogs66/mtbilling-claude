#!/usr/bin/env node
/*
 * MT-Billing Activator (vendor tool) — License + Password Reset
 *
 * Generates codes that match a customer's Hardware ID / Panel ID (same value):
 *   - License key  → paste on System → License (duration-bound)
 *   - Reset code   → paste on login → Forgot password (account recovery)
 *
 * Codes are Ed25519 signatures. This tool needs the private key created by
 * `node generate-keys.cjs` (keys/vendor-private-key.pem, gitignored). Keep
 * that file private — this script itself embeds no secret and is safe to share.
 */
'use strict';

const readline = require('readline');
const {
  DURATIONS,
  loadPrivateKey,
  signLicenseKey,
  signResetCode,
} = require('./sign.cjs');

function printResult(hwid, duration, privateKey) {
  const id = String(hwid || '').toUpperCase().trim();
  const dur = String(duration || 'life').toLowerCase();
  const durLabel = (DURATIONS.find((d) => d.id === dur) || DURATIONS[DURATIONS.length - 1]).label;
  const license = signLicenseKey(privateKey, id, dur);
  const reset = signResetCode(privateKey, id);
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
  console.log('  mt-billing-activator.exe <HARDWARE-OR-PANEL-ID> [--days 30d|90d|180d|1y|2y|life] [--key <path>]');
  console.log('  mt-billing-activator.exe                  (interactive)');
  console.log('  mt-billing-activator.exe --license <ID> [--days 1y] [--key <path>]');
  console.log('  mt-billing-activator.exe --reset <ID> [--key <path>]');
  console.log('');
  console.log('Durations: ' + DURATIONS.map((d) => d.id).join(', '));
  console.log('');
  console.log('Private key resolution order: --key <path>, MT_BILLING_VENDOR_KEY env var,');
  console.log('then ./keys/vendor-private-key.pem next to this tool.');
}

function parseDays(args) {
  const i = args.indexOf('--days');
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const j = args.indexOf('--duration');
  if (j >= 0 && args[j + 1]) return args[j + 1];
  return 'life';
}

function parseKeyPath(args) {
  const i = args.indexOf('--key');
  if (i >= 0 && args[i + 1]) return args[i + 1];
  return undefined;
}

const args = process.argv.slice(2);
if (args[0] === '-h' || args[0] === '--help') {
  usage();
  process.exit(0);
}

let privateKey;
try {
  privateKey = loadPrivateKey(parseKeyPath(args));
} catch (e) {
  console.error('');
  console.error('  ' + e.message);
  console.error('');
  process.exit(1);
}

if (args[0] === '--license' && args[1]) {
  const id = args[1];
  const days = parseDays(args);
  console.log('');
  console.log('  Hardware ID  : ' + String(id).toUpperCase().trim());
  console.log('  Expiration   : ' + days);
  console.log('  License Key  : ' + signLicenseKey(privateKey, id, days));
  console.log('');
} else if ((args[0] === '--reset' || args[0] === '--password-reset') && args[1]) {
  const id = args[1];
  console.log('');
  console.log('  Panel ID     : ' + String(id).toUpperCase().trim());
  console.log('  Reset Code   : ' + signResetCode(privateKey, id));
  console.log('');
} else if (args[0] && !args[0].startsWith('-')) {
  printResult(args[0], parseDays(args), privateKey);
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Enter the customer Hardware ID / Panel ID: ', (ans) => {
    console.log('');
    console.log('Select license expiration:');
    DURATIONS.forEach((d, i) => console.log('  ' + (i + 1) + ') ' + d.label + ' (' + d.id + ')'));
    rl.question('Choice [6 = lifetime]: ', (choice) => {
      const n = parseInt(choice, 10);
      const dur = DURATIONS[n - 1]?.id || 'life';
      printResult(ans.trim(), dur, privateKey);
      rl.question('Press Enter to exit...', () => rl.close());
    });
  });
}
