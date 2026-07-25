#!/usr/bin/env node
/*
 * MT-Billing Password Reset Activator (vendor tool).
 * Prefer the unified activator.cjs which also generates license keys.
 *
 * Needs the private key from `node generate-keys.cjs`
 * (keys/vendor-private-key.pem, gitignored — never commit it).
 */
'use strict';

const readline = require('readline');
const { loadPrivateKey, signResetCode } = require('./sign.cjs');

function parseKeyPath(args) {
  const i = args.indexOf('--key');
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
}

function printResult(panelId, privateKey) {
  const code = signResetCode(privateKey, panelId);
  console.log('');
  console.log('  ========================================');
  console.log('   MT-Billing Password Reset Activator');
  console.log('  ========================================');
  console.log('   Panel ID   : ' + String(panelId).toUpperCase().trim());
  console.log('   Reset Code : ' + code);
  console.log('  ========================================');
  console.log('');
  console.log('  Tip: use activator.cjs for license + recovery together.');
  console.log('');
}

const args = process.argv.slice(2);
let privateKey;
try {
  privateKey = loadPrivateKey(parseKeyPath(args));
} catch (e) {
  console.error('');
  console.error('  ' + e.message);
  console.error('');
  process.exit(1);
}

const panelId = args[0] && !args[0].startsWith('-') ? args[0] : undefined;

if (panelId) {
  printResult(panelId, privateKey);
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Enter the customer Panel ID: ', (ans) => {
    printResult(ans.trim(), privateKey);
    rl.question('Press Enter to exit...', () => rl.close());
  });
}
