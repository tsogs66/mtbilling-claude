#!/usr/bin/env node
// MT-Billing License Activator (CLI) — must match server/src/panelId.ts
//
//   node server/scripts/license-activator.mjs <HARDWARE-ID> [30d|90d|180d|1y|2y|life] [--key <path-to-private-key.pem>]
//
// Needs the vendor's Ed25519 private key (from `node activator/generate-keys.cjs`).
// Prefer the unified vendor tool: activator/activator.cjs (license + password reset).

import crypto from 'crypto';
import fs from 'fs';

const DURATIONS = ['30d', '90d', '180d', '1y', '2y', 'life'];
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function normalizeCode(k) {
  return String(k || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
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

function signedKeyFor(privateKey, hwid, duration = 'life') {
  const dur = DURATIONS.includes(String(duration).toLowerCase()) ? String(duration).toLowerCase() : 'life';
  const message = `LIC|${normalizeCode(hwid)}|${dur}`;
  const sig = crypto.sign(null, Buffer.from(message, 'utf8'), privateKey);
  return `${chunk(base32Encode(sig))}-${dur.toUpperCase()}`;
}

const args = process.argv.slice(2);
const keyIdx = args.indexOf('--key');
const keyPath = keyIdx >= 0 ? args[keyIdx + 1] : undefined;
const positional = args.filter((a, i) => a !== '--key' && i !== keyIdx + 1);

const hwid = positional[0];
const duration = positional[1] || 'life';
if (!hwid) {
  console.error('Usage: node server/scripts/license-activator.mjs <HARDWARE-ID> [30d|90d|180d|1y|2y|life] [--key <path>]');
  process.exit(1);
}

const privateKey = loadPrivateKey(keyPath);

console.log('');
console.log('  Hardware ID : ' + hwid.toUpperCase());
console.log('  Expiration  : ' + duration);
console.log('  License Key : ' + signedKeyFor(privateKey, hwid, duration));
console.log('');
