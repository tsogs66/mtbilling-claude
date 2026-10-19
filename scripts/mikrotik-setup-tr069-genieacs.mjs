#!/usr/bin/env node
/**
 * Apply MikroTik NAT + firewall for TR-069 (CWMP) to GenieACS for every /ip pool.
 * Run from a host that can reach RouterOS API (e.g. MT-Billing LXC on 20.0.0.0/24).
 *
 * Example:
 *   node scripts/mikrotik-setup-tr069-genieacs.mjs \
 *     --host 20.0.0.1 --user admin --password 'secret' \
 *     --genieacs 192.168.0.107 --acs-front 1.10.0.1
 *
 * Env: MIKROTIK_HOST, MIKROTIK_USER, MIKROTIK_PASSWORD, GENIEACS_IP, ACS_FRONT_IP, MIKROTIK_PORT
 */
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '../server/package.json'));
const { RouterOSAPI } = require('node-routeros');

const COMMENT = 'MT-Billing TR-069 GenieACS';
const LIST = 'tr069-cpe-pools';
const CWMP_PORT = 7547;

function arg(name, envKey, def = '') {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env[envKey] || def;
}

function usage() {
  console.error(`Usage: node scripts/mikrotik-setup-tr069-genieacs.mjs \\
  --host <router> --user <api-user> --password <api-pass> \\
  --genieacs 192.168.0.107 --acs-front <IP-on-MikroTik-for-ONT-ACS-URL>`);
  process.exit(1);
}

const host = arg('host', 'MIKROTIK_HOST');
const user = arg('user', 'MIKROTIK_USER');
const password = arg('password', 'MIKROTIK_PASSWORD');
const genieacs = arg('genieacs', 'GENIEACS_IP', '192.168.0.107');
const acsFront = arg('acs-front', 'ACS_FRONT_IP');
const port = Number(arg('port', 'MIKROTIK_PORT', '8728')) || 8728;

if (!host || !user || !acsFront) usage();

const api = new RouterOSAPI({ host, port, user, password, timeout: 20 });
api.on('error', () => {});

async function connect() {
  await api.connect();
}

async function printPools() {
  return api.write('/ip/pool/print');
}

async function clearAddressList() {
  const rows = await api.write('/ip/firewall/address-list/print', [`?list=${LIST}`]);
  for (const r of rows || []) {
    if (r['.id']) await api.write('/ip/firewall/address-list/remove', [`=.id=${r['.id']}`]);
  }
}

async function addPoolRangesToList(pools) {
  const added = [];
  for (const p of pools || []) {
    const name = String(p.name || '');
    const ranges = String(p.ranges || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const range of ranges) {
      await api.write('/ip/firewall/address-list/add', [
        `=list=${LIST}`,
        `=address=${range}`,
        `=comment=${COMMENT} pool:${name}`,
      ]);
      added.push({ pool: name, range });
    }
  }
  return added;
}

async function removeRulesByComment(path, chain) {
  const rows = await api.write(`${path}/print`, [`?comment=${COMMENT}`]);
  for (const r of rows || []) {
    if (r['.id']) await api.write(`${path}/remove`, [`=.id=${r['.id']}`]);
  }
  // also remove chain-specific if comment match failed partial
  const all = await api.write(`${path}/print`);
  for (const r of all || []) {
    if (String(r.comment || '').includes('MT-Billing TR-069')) {
      await api.write(`${path}/remove`, [`=.id=${r['.id']}`]);
    }
  }
}

async function ensureRules() {
  await removeRulesByComment('/ip/firewall/nat', 'dstnat');
  await removeRulesByComment('/ip/firewall/nat', 'srcnat');
  await removeRulesByComment('/ip/firewall/filter', 'forward');

  await api.write('/ip/firewall/nat/add', [
    '=chain=dstnat',
    '=protocol=tcp',
    `=dst-address=${acsFront}`,
    `=dst-port=${CWMP_PORT}`,
    '=action=dst-nat',
    `=to-addresses=${genieacs}`,
    `=to-ports=${CWMP_PORT}`,
    `=comment=${COMMENT} dst-nat`,
  ]);

  await api.write('/ip/firewall/filter/add', [
    '=chain=forward',
    '=action=accept',
    '=protocol=tcp',
    `=dst-address=${genieacs}`,
    `=dst-port=${CWMP_PORT}`,
    `=src-address-list=${LIST}`,
    `=comment=${COMMENT} forward`,
  ]);

  await api.write('/ip/firewall/nat/add', [
    '=chain=srcnat',
    '=action=masquerade',
    '=protocol=tcp',
    `=dst-address=${genieacs}`,
    `=dst-port=${CWMP_PORT}`,
    `=src-address-list=${LIST}`,
    `=comment=${COMMENT} srcnat`,
  ]);
}

async function main() {
  console.log(`Connecting to ${host}:${port} as ${user}…`);
  await connect();
  const pools = await printPools();
  console.log(`Found ${(pools || []).length} IP pool(s):`);
  for (const p of pools || []) {
    console.log(`  - ${p.name}: ${p.ranges}`);
  }

  console.log(`Refreshing address-list "${LIST}"…`);
  await clearAddressList();
  const added = await addPoolRangesToList(pools);
  if (!added.length) {
    console.warn('WARNING: No pool ranges found — add /ip pool entries or create filter rules manually.');
  } else {
    for (const a of added) console.log(`  + list ${LIST}: ${a.range} (${a.pool})`);
  }

  console.log('Applying NAT + forward rules…');
  await ensureRules();

  console.log('');
  console.log('=== Done ===');
  console.log(`Huawei ACS URL (all pools): http://${acsFront}:${CWMP_PORT}/`);
  console.log(`MT-Billing CWMP ACS URL:    http://${acsFront}:${CWMP_PORT}/`);
  console.log(`GenieACS backend:           ${genieacs}:${CWMP_PORT}`);
  console.log(`Address-list:               ${LIST} (all /ip pool ranges)`);
  api.close();
}

main().catch((e) => {
  console.error(e.message || e);
  try {
    api.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
