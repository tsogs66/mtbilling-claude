import assert from 'node:assert/strict';
import { flattenAcsParameters, pickFirstParam } from './genieacs.js';

const sample = {
  _id: 'TEST-DEVICE',
  InternetGatewayDevice: {
    DeviceInfo: {
      SerialNumber: { _value: 'SN123', _type: 'xsd:string', _timestamp: 1 },
    },
    LANDevice: {
      '1': {
        WLANConfiguration: {
          '1': {
            SSID: { _value: 'MyWifi', _type: 'xsd:string' },
          },
        },
      },
    },
  },
};

const flat = flattenAcsParameters(sample);
assert(flat.some((p) => p.path.endsWith('SerialNumber') && p.value === 'SN123'), 'serial flattened');
assert(flat.some((p) => p.path.includes('SSID') && p.value === 'MyWifi'), 'ssid flattened');

const picked = pickFirstParam(flat, [
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
  'missing.path',
]);
assert(picked?.value === 'MyWifi', 'pickFirstParam');

console.log('genieacs.test.ts: ok');
