#!/usr/bin/env node
// MT-Billing Password Reset Activator (CLI) — must match server/src/panelId.ts
//
//   node server/scripts/password-reset-activator.mjs <PANEL-ID> [--key <path-to-private-key.pem>]
//
// Needs the vendor's Ed25519 private key (from `node activator/generate-keys.cjs`).
// Prefer the unified vendor tool: activator/activator.cjs (license + password reset).

import crypto from 'crypto';
import fs from 'fs';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function normalizeCode(k) {
  return String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function base32Encode(buf) {
  let bits = 0, value = 0, output = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function chunk(s, size = 5) {
  const parts = [];
  for (let i = 0; i < s.length; i += size) parts.push(s.slice(i, i + size));
  return parts.join('-');
}

function loadPrivateKey(keyPath) {
  const source = keyPath || process.env.MT_BILLING_VENDOR_KEY;
  if (!source) {
    console.error('Provide the vendor private key: --key <path-to-vendor-private-key.pem>');
    console.error('(or set MT_BILLING_VENDOR_KEY). Generate one with activator/generate-keys.cjs.');
    process.exit(1);
  }
  const pem = source.includes('BEGIN PRIVATE KEY') ? source : fs.readFileSync(source, 'utf8');
  return crypto.createPrivateKey(pem);
}

function resetCodeFor(privateKey, hwid) {
  const message = `RST|${normalizeCode(hwid)}`;
  const sig = crypto.sign(null, Buffer.from(message, 'utf8'), privateKey);
  return `RST-${chunk(base32Encode(sig))}`;
}

const args = process.argv.slice(2);
const keyIdx = args.indexOf('--key');
const keyPath = keyIdx >= 0 ? args[keyIdx + 1] : undefined;
const positional = args.filter((a, i) => a !== '--key' && i !== keyIdx + 1);

const panelId = positional[0];
if (!panelId) {
  console.error('Usage: node server/scripts/password-reset-activator.mjs <PANEL-ID> [--key <path>]');
  process.exit(1);
}

const privateKey = loadPrivateKey(keyPath);

console.log('');
console.log('  Panel ID    : ' + panelId.toUpperCase());
console.log('  Reset Code  : ' + resetCodeFor(privateKey, panelId));
console.log('');
console.log('  Give this code to the customer. They enter it on the login page');
console.log('  to restore the default admin username and password.');
console.log('');
