import assert from 'node:assert/strict';
import { requiredPermissionsForApiPath } from './apiPermissions.js';

const need = (p: string, m = 'GET') => requiredPermissionsForApiPath(p, m);

// TR-069 / GenieACS must not be reachable by every authenticated role.
assert.deepEqual(need('/acs/config'), ['network'], 'acs config read');
assert.deepEqual(need('/acs/config', 'PUT'), ['network'], 'acs config write');
assert.deepEqual(need('/acs/devices'), ['network'], 'acs device list');
assert.deepEqual(
  need('/acs/devices/00259E-HG8145X6%2D10-ABC/set-parameter', 'POST'),
  ['network'],
  'acs parameter push'
);
assert.deepEqual(need('/api/acs/devices/x/reboot', 'POST'), ['network'], 'acs reboot via /api prefix');

// Cleartext PPPoE secrets are a settings-level export, not a billing read.
assert.deepEqual(need('/isp/radius-users'), ['settings'], 'radius export');

// Specific operations-desk rules must win over the generic /isp catch-all.
assert.deepEqual(need('/isp/payments', 'POST'), ['sales', 'invoices', 'finance'], 'take payment');
assert.deepEqual(need('/isp/payments/4/reverse', 'POST'), ['sales', 'invoices', 'finance'], 'reverse');
assert.deepEqual(need('/isp/cashier-close', 'POST'), ['sales', 'invoices', 'finance'], 'drawer close');
assert.deepEqual(need('/isp/finance'), ['sales', 'invoices', 'finance'], 'collections');
assert.deepEqual(need('/isp/subscribers/12/cpe', 'POST'), ['network', 'tech-tools'], 'cpe push');
assert.deepEqual(need('/isp/settings', 'PUT'), ['settings'], 'isp policy write');
assert.equal(need('/isp/settings', 'GET'), null, 'isp policy read is writeOnly-gated');

// Everything else on the desk stays on the sidebar permission.
assert.deepEqual(need('/isp/aging'), ['pppoe'], 'aging');
assert.deepEqual(need('/isp/subscribers/12'), ['pppoe'], 'subscriber hub');
assert.deepEqual(need('/isp/outages', 'POST'), ['pppoe'], 'outages');

// The generic /isp rule must no longer grant the desk to seven unrelated roles.
assert.ok(!need('/isp/aging')!.includes('notifications'), 'notifications no longer opens the desk');
assert.ok(!need('/isp/aging')!.includes('noc'), 'noc no longer opens the desk');

// Pre-existing rules still behave.
assert.deepEqual(need('/pppoe/1', 'PUT'), ['pppoe'], 'pppoe');
assert.deepEqual(need('/roles'), ['roles'], 'roles');
assert.equal(need('/settings'), null, 'settings read is writeOnly-gated');
assert.deepEqual(need('/settings', 'POST'), ['settings'], 'settings write');
assert.equal(need('/merchant/foo', 'POST'), null, 'merchant portal bypasses the staff gate');
assert.equal(need('/health'), null, 'unmatched path');

console.log('apiPermissions.test.ts: ok');
