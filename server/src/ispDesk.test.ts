import assert from 'node:assert/strict';
import { parseCgnatLine } from './ispDesk.js';

const line = parseCgnatLine('2026-10-23T01:00:00Z 10.0.0.5:1234 203.0.113.8:54321 tcp juan');
assert(line?.srcIp === '10.0.0.5', 'src ip');
assert(line?.srcPort === 1234, 'src port');
assert(line?.publicIp === '203.0.113.8', 'public ip');
assert(line?.publicPort === 54321, 'public port');
assert(line?.protocol === 'tcp', 'proto');
assert(line?.username === 'juan', 'user');

const json = parseCgnatLine('{"public_ip":"198.51.100.9","src_ip":"10.1.1.8","seen_at":"2026-10-23T02:00:00Z"}');
assert(json?.publicIp === '198.51.100.9', 'json public');
assert(json?.srcIp === '10.1.1.8', 'json src');
assert(parseCgnatLine('') === null, 'blank');

console.log('ispDesk.test.ts: ok');
