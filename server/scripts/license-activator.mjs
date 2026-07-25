#!/usr/bin/env node
// MT-Billing License Activator (CLI) — must match server/src/panelId.ts
//
//   node server/scripts/license-activator.mjs <HARDWARE-ID> [30d|90d|180d|1y|2y|life]
//
// Prefer the unified vendor tool: activator/activator.cjs (license + password reset).

import crypto from 'crypto';

const LICENSE_SECRET = 'MT-BILLING-LICENSE-2026';
const DURATIONS = ['30d', '90d', '180d', '1y', '2y', 'life'];

function normalizeCode(k) {
  return String(k || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function formatBody(hex) {
  return `${hex.slice(0, 5)}-${hex.slice(5, 10)}-${hex.slice(10, 15)}-${hex.slice(15, 20)}`;
}

function expectedKeyFor(hwid, duration = 'life') {
  const dur = DURATIONS.includes(String(duration).toLowerCase()) ? String(duration).toLowerCase() : 'life';
  const payload = `${normalizeCode(hwid)}|${dur}`;
  const h = crypto.createHmac('sha256', LICENSE_SECRET).update(payload).digest('hex').toUpperCase();
  return `${formatBody(h)}-${dur.toUpperCase()}`;
}

const hwid = process.argv[2];
const duration = process.argv[3] || 'life';
if (!hwid) {
  console.error('Usage: node server/scripts/license-activator.mjs <HARDWARE-ID> [30d|90d|180d|1y|2y|life]');
  process.exit(1);
}

console.log('');
console.log('  Hardware ID : ' + hwid.toUpperCase());
console.log('  Expiration  : ' + duration);
console.log('  License Key : ' + expectedKeyFor(hwid, duration));
console.log('');
