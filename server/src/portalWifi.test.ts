/**
 * Subscriber Wi-Fi change: input rules, SSID read-back, change limit, and a
 * guard that staff can still read the saved Wi-Fi password from the device
 * record. Run via scripts/run-tests.mjs.
 */
import assert from 'node:assert/strict';
import { db, initSchema, migrate, seed } from './db.js';
import {
  currentSsid,
  ensureWifiTable,
  recentWifiChanges,
  recordWifiChange,
  validateWifiInput,
  WIFI_MAX_CHANGES_PER_HOUR,
} from './portalWifi.js';
import { ACS_PARAMETER_PRESETS, flattenAcsParameters, pickFirstParam, readAcsParam } from './genieacs.js';

initSchema();
migrate();
seed();
ensureWifiTable();

assert.deepEqual(validateWifiInput({}), { ok: false, error: 'Enter a new Wi-Fi name, a new password, or both.' });
const both = validateWifiInput({ ssid: '  Home Net ', password: 'correct horse' });
assert.ok(both.ok && both.ssid === 'Home Net' && both.password === 'correct horse', 'ssid trimmed, password kept as typed');
assert.ok(validateWifiInput({ ssid: 'OnlyName' }).ok, 'name alone is fine');
assert.ok(validateWifiInput({ password: 'longenough1' }).ok, 'password alone is fine');
assert.ok(!validateWifiInput({ ssid: 'x'.repeat(33) }).ok, 'ssid over 32 bytes');
assert.ok(validateWifiInput({ ssid: 'x'.repeat(32) }).ok, 'ssid of 32 bytes');
assert.ok(!validateWifiInput({ ssid: '\u00e9'.repeat(17) }).ok, 'ssid is measured in bytes, not characters');
assert.ok(!validateWifiInput({ ssid: 'bad\u0000name' }).ok, 'control characters rejected');
assert.ok(!validateWifiInput({ password: 'short' }).ok, 'password under 8');
assert.ok(!validateWifiInput({ password: 'x'.repeat(64) }).ok, 'password over 63');
assert.ok(validateWifiInput({ password: 'x'.repeat(63) }).ok, 'password of 63');
assert.ok(!validateWifiInput({ password: 'caf\u00e9-password' }).ok, 'non-ASCII password rejected');
assert.ok(!validateWifiInput({ password: ' leading space1' }).ok, 'edge whitespace rejected');

const tr098 = {
  InternetGatewayDevice: {
    LANDevice: {
      '1': {
        WLANConfiguration: {
          '1': {
            SSID: { _value: 'Casa 5G' },
            PreSharedKey: { '1': { KeyPassphrase: { _value: 'saved-secret-1' } } },
          },
        },
      },
    },
  },
};
const tr181 = { Device: { WiFi: { SSID: { '1': { SSID: { _value: 'Casa181' } } } } } };
assert.equal(currentSsid(tr098), 'Casa 5G');
assert.equal(currentSsid(tr181), 'Casa181');
assert.equal(currentSsid({}), null);
assert.equal(currentSsid(null), null);

// Staff must keep seeing the saved Wi-Fi password in the device detail.
const passPreset = ACS_PARAMETER_PRESETS.find((p) => p.id === 'wifi-pass-igd')!;
const flat = flattenAcsParameters(tr098);
assert.equal(pickFirstParam(flat, passPreset.paths)?.value, 'saved-secret-1', 'password present in flattened parameters');
assert.equal(readAcsParam(tr098, passPreset.paths[0])?.value, 'saved-secret-1', 'password present via preset path');

db.exec('DELETE FROM portal_wifi_changes');
for (let i = 0; i < WIFI_MAX_CHANGES_PER_HOUR; i++) recordWifiChange(77, true, true);
assert.equal(recentWifiChanges(77), WIFI_MAX_CHANGES_PER_HOUR);
assert.equal(recentWifiChanges(78), 0, 'limit is per subscriber');
db.prepare(`UPDATE portal_wifi_changes SET created_at = datetime('now', '-2 hours')`).run();
assert.equal(recentWifiChanges(77), 0, 'older changes fall out of the window');
const cols = (db.prepare('PRAGMA table_info(portal_wifi_changes)').all() as { name: string }[]).map((c) => c.name);
assert.ok(!cols.some((c) => /pass|ssid$/.test(c) && c !== 'password_changed' && c !== 'ssid_changed'), 'no credential columns');

console.log('portalWifi.test.ts: ok');
