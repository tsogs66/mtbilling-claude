import assert from 'node:assert/strict';
import {
  flattenAcsParameters,
  pickFirstParam,
  readAcsParam,
  normalizeAcsDeviceId,
  huaweiEncodedAcsDeviceId,
  acsDeviceIdLookupVariants,
  acsDeviceIdsEquivalent,
  canonicalAcsDeviceId,
  acsDataModel,
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

// Manual linking and autolink must store the SAME form, or the duplicate-link
// guard compares a decoded id against GenieACS's encoded one and never matches.
assert.equal(
  canonicalAcsDeviceId('00259E-HG8145X6%2D10-48575443075EF0B2'),
  canonicalAcsDeviceId('00259E-HG8145X6-10-48575443075EF0B2'),
  'canonical id is stable across encodings'
);
assert.equal(canonicalAcsDeviceId('  TEST-DEVICE  '), 'TEST-DEVICE', 'canonical id trims');
assert.equal(canonicalAcsDeviceId(''), '', 'canonical id of blank');

// Wi-Fi pushes pick paths per data model instead of assuming TR-098.
assert.equal(acsDataModel(sample), 'tr098', 'IGD document is TR-098');
assert.equal(acsDataModel({ Device: { WiFi: {} } }), 'tr181', 'Device document is TR-181');
assert.equal(acsDataModel(null), null, 'no document, no model');
assert.equal(acsDataModel({ _id: 'x' }), null, 'bare document has no model');

console.log('genieacs.test.ts: ok');
