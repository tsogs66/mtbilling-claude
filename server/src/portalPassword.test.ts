/**
 * Run with: npx tsx src/portalPassword.test.ts
 */
import bcrypt from 'bcryptjs';
import {
  defaultPortalPasswordFromContact,
  isDefaultPortalPassword,
  looksLikePhonePassword,
  phonesEquivalent,
  portalPasswordCandidates,
  portalPasswordMatches,
  validateChosenPortalPassword,
} from './portalPassword.js';

let failed = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) {
    failed += 1;
    console.error(`FAIL: ${msg}`);
  } else {
    console.log(`ok  : ${msg}`);
  }
}

const contactDashed = '0917-123-4567';
const hashDashed = bcrypt.hashSync(contactDashed, 4);
const hashLocal = bcrypt.hashSync('09171234567', 4);
const hashCustom = bcrypt.hashSync('secret42', 4);

assert(defaultPortalPasswordFromContact('  0917 123 4567  ') === '0917 123 4567', 'trim contact');
assert(phonesEquivalent('09171234567', '+63 917 123 4567'), '09 vs +63');
assert(phonesEquivalent('9171234567', '0917-123-4567'), '10-digit vs dashed 09');
assert(!phonesEquivalent('09171234567', '09181234567'), 'different numbers');
assert(looksLikePhonePassword('0917 123 4567'), 'looks like phone with spaces');
assert(looksLikePhonePassword('+639171234567'), 'looks like +63 phone');
assert(!looksLikePhonePassword('secret42'), 'custom password is not a phone');

const cands = portalPasswordCandidates('+63 917-123-4567');
assert(cands.includes('09171234567'), 'candidates include 09 local');
assert(cands.includes('639171234567'), 'candidates include 63');
assert(cands.includes('9171234567'), 'candidates include 10-digit');

assert(isDefaultPortalPassword('09171234567', contactDashed), 'typed 09 is default');
assert(isDefaultPortalPassword('+63 917 123 4567', contactDashed), 'typed +63 is default');
assert(isDefaultPortalPassword(contactDashed, contactDashed), 'exact default');
assert(!isDefaultPortalPassword('secret42', contactDashed), 'custom is not default');

assert(portalPasswordMatches(contactDashed, hashDashed, contactDashed), 'exact stored contact');
assert(portalPasswordMatches('09171234567', hashDashed, contactDashed), '09 digits vs dashed hash');
assert(portalPasswordMatches('+639171234567', hashDashed, contactDashed), '+63 vs dashed hash');
assert(portalPasswordMatches('0917 123 4567', hashDashed, contactDashed), 'spaced 09 vs dashed hash');
assert(portalPasswordMatches('0917-123-4567', hashLocal, '09171234567'), 'dashed vs local hash');
assert(portalPasswordMatches('secret42', hashCustom, contactDashed), 'custom password still matches');
assert(!portalPasswordMatches('wrongpass', hashCustom, contactDashed), 'wrong custom rejected');
assert(!portalPasswordMatches('09181234567', hashDashed, contactDashed), 'other phone rejected');

assert(validateChosenPortalPassword('abcdef') === null, 'valid new password');
assert(validateChosenPortalPassword('abc') !== null, 'too short');
assert(validateChosenPortalPassword('abc def') !== null, 'spaces rejected for new passwords');

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nAll portal password assertions passed');
