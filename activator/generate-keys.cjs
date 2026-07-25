#!/usr/bin/env node
/*
 * One-time setup: generates the vendor's Ed25519 keypair.
 *
 *   node generate-keys.cjs
 *
 * Writes the PRIVATE key to keys/vendor-private-key.pem (gitignored — back it
 * up somewhere safe and never share it) and prints the PUBLIC key value to
 * paste into server/src/panelId.ts (LICENSE_PUBLIC_KEY_X). That file is safe
 * to commit: it lets the panel verify codes but not create new ones.
 *
 * Re-running this after keys already exist would invalidate every code you've
 * ever issued, so it refuses to overwrite an existing key.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const keyPath = path.join(__dirname, 'keys', 'vendor-private-key.pem');

if (fs.existsSync(keyPath)) {
  console.error(`A vendor key already exists at ${keyPath}`);
  console.error('Refusing to overwrite it — that would invalidate every license/reset code');
  console.error('you have already issued to customers. Delete it manually first if you are');
  console.error('sure you want to rotate keys (existing customer codes will stop validating).');
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const jwk = publicKey.export({ format: 'jwk' });

fs.mkdirSync(path.dirname(keyPath), { recursive: true });
fs.writeFileSync(keyPath, pem, { mode: 0o600 });

console.log('');
console.log('  ==================================================');
console.log('   MT-Billing vendor keypair generated');
console.log('  ==================================================');
console.log('');
console.log('  Private key written to: ' + keyPath);
console.log('  -> Keep this file OFFLINE. Back it up (password manager / offline drive).');
console.log('  -> It is already gitignored — do not force-add it, do not paste it anywhere.');
console.log('  -> Anyone who obtains it can generate valid license/reset codes for any panel.');
console.log('');
console.log('  Paste this into server/src/panelId.ts as LICENSE_PUBLIC_KEY_X:');
console.log('');
console.log('    ' + jwk.x);
console.log('');
console.log('  This public value is safe to commit — it can verify codes but not create them.');
console.log('');
