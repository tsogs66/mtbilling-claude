#!/usr/bin/env node
// MT-Billing Password Reset Activator (CLI) — must match server/src/panelId.ts
//
//   node server/scripts/password-reset-activator.mjs <PANEL-ID>
//
// Prefer the unified vendor tool: activator/activator.cjs (license + password reset).

import crypto from 'crypto';

const PASSWORD_RESET_SECRET = 'MT-BILLING-PASSWORD-RESET-2026';

function normalizeCode(k) {
  return String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function resetCodeFor(hwid) {
  const norm = normalizeCode(hwid);
  const h = crypto.createHmac('sha256', PASSWORD_RESET_SECRET).update(norm).digest('hex').toUpperCase();
  return `RST-${h.slice(0, 4)}-${h.slice(4, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}`;
}

const panelId = process.argv[2];
if (!panelId) {
  console.error('Usage: node server/scripts/password-reset-activator.mjs <PANEL-ID>');
  process.exit(1);
}

console.log('');
console.log('  Panel ID    : ' + panelId.toUpperCase());
console.log('  Reset Code  : ' + resetCodeFor(panelId));
console.log('');
console.log('  Give this code to the customer. They enter it on the login page');
console.log('  to restore the default admin username and password.');
console.log('');
