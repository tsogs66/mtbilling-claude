import assert from 'node:assert/strict';
import {
  flattenAcsParameters,
  pickFirstParam,
  readAcsParam,
  normalizeAcsDeviceId,
  huaweiEncodedAcsDeviceId,
  acsDeviceIdLookupVariants,
  acsDeviceIdsEquivalent,
} from './genieacs.js';
import {
  buildProvisionTags,
  extractDeviceMatchKeys,
  normalizeMac,
  normalizeUsername,
} from './acsAutolink.js';

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
assert(
  readAcsParam(sample, 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID')?.value === 'MyWifi',
  'readAcsParam nested path'
);

assert(normalizeUsername('  Juan.Doe  ') === 'juan.doe', 'username norm');
assert(normalizeMac('AA:BB:CC:11:22:33') === 'aabbcc112233', 'mac norm');

const tags = buildProvisionTags({
  id: 42,
  username: 'juan',
  account_number: '123456789012',
  profile: 'UNLI500',
  status: 'Active',
});
assert(tags.some((t) => t === 'mtbilling:sub:42'), 'sub tag');
assert(tags.some((t) => t === 'mtbilling:username:juan'), 'user tag');

const keys = extractDeviceMatchKeys({
  _tags: ['mtbilling:username:juan', 'mtbilling:account:123456789012'],
  InternetGatewayDevice: {
    WANDevice: {
      '1': {
        WANConnectionDevice: {
          '1': {
            WANPPPConnection: {
              '1': { Username: { _value: 'otheruser', _type: 'xsd:string' } },
            },
          },
        },
      },
    },
  },
});
assert(keys.usernames.includes('juan'), 'tag username parsed');
assert(keys.pppUsernames.includes('otheruser'), 'ppp username parsed');

assert(
  normalizeAcsDeviceId('00259E-HG8145X6%2D10-48575443075EF0B2') === '00259E-HG8145X6-10-48575443075EF0B2',
  'decode %2D in device id'
);
const variants = acsDeviceIdLookupVariants('00259E-HG8145X6%2D10-48575443075EF0B2');
assert(variants.includes('00259E-HG8145X6-10-48575443075EF0B2'), 'variant decoded');
assert(
  acsDeviceIdsEquivalent('00259E-HG8145X6%2D10-48575443075EF0B2', '00259E-HG8145X6-10-48575443075EF0B2'),
  'ids equivalent'
);
assert(
  huaweiEncodedAcsDeviceId('00259E-HG8145X6-10-48575443075EF0B2') === '00259E-HG8145X6%2D10-48575443075EF0B2',
  'huawei encode model revision dash'
);
const decodedVariants = acsDeviceIdLookupVariants('00259E-HG8145X6-10-48575443075EF0B2');
assert(
  decodedVariants.includes('00259E-HG8145X6%2D10-48575443075EF0B2'),
  'lookup variants include GenieACS-encoded Huawei id'
);
assert(
  !decodedVariants.includes('00259E-HG8145X6%2D10%2D48575443075EF0B2'),
  'lookup variants do not encode every hyphen'
);

console.log('genieacs.test.ts: ok');
