'use strict';
const crypto = require('crypto');
const config = require('../config');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
/** Constant-time comparison of two hex digests. */
function safeEqualHex(a, b) {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}
// Deterministic demo device secret for SEEDED meters: HMAC(server key, meter_id).
const deviceSecretFor = (meterId) => crypto.createHmac('sha256', config.deviceSecretKey).update(meterId).digest('hex').slice(0, 32);
// Random secret for NEW installations (returned once, only the hash is stored).
const newDeviceSecret = () => crypto.randomBytes(24).toString('base64url');

module.exports = { sha256, safeEqualHex, deviceSecretFor, newDeviceSecret };
