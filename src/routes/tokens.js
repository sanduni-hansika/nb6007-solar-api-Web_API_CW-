'use strict';
// POST /api/v1/tokens  - issues a JWT bearer token.
//   users   : { "email", "password" }               -> scopes derived from role, jurisdiction re-read from DB on every request
//   devices : { "meter_id", "device_secret" }       -> a device authenticates AS ITS INSTALLATION, scope readings:write only
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { query } = require('../db');
const { ApiError, ah, allow, bad } = require('../utils/errors');
const { validateBody } = require('../utils/validate');
const { ROLE_SCOPES, DEVICE_SCOPES } = require('../utils/scope');
const { sha256, safeEqualHex } = require('../utils/security');

const r = express.Router();
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);
const ZERO_HASH = '0'.repeat(64);

// Brute-force protection: only FAILED attempts count (10 per 15 minutes per IP).
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (req, res, next) => next(new ApiError(429, 'TOO_MANY_FAILED_LOGINS', 'Too many failed authentication attempts. Try again later.')),
});

const invalid = () => new ApiError(401, 'INVALID_CREDENTIALS', 'The supplied credentials are not valid.', [], { 'WWW-Authenticate': 'Bearer realm="slsea-solar-api", error="invalid_request"' });

function respond(res, token, ttl, scope, subject) {
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  res.status(200).json({ access_token: token, token_type: 'Bearer', expires_in: ttl, scope, subject });
}

r.route('/')
  .post(limiter, ah(async (req, res) => {
    const body = req.body;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('INVALID_BODY', 'The request body must be a JSON object.');
    const isDevice = 'meter_id' in body || 'device_secret' in body;

    if (!isDevice) {
      const b = validateBody(body, { email: { type: 'email', required: true }, password: { type: 'string', required: true, minLength: 1, maxLength: 200 } });
      const u = (await query('SELECT id, email, password_hash, role, active FROM users WHERE email = $1', [b.email])).rows[0];
      const ok = await bcrypt.compare(b.password, u ? u.password_hash : DUMMY_HASH); // always hash-compare (timing)
      if (!u || !ok || !u.active) throw invalid();
      const scopes = ROLE_SCOPES[u.role].join(' ');
      const ttl = config.jwt.userTtlSeconds;
      const token = jwt.sign({ token_use: 'user', role: u.role, scope: scopes }, config.jwt.secret,
        { algorithm: 'HS256', subject: `user:${u.id}`, issuer: config.jwt.issuer, audience: config.jwt.audience, expiresIn: ttl });
      return respond(res, token, ttl, scopes, { type: 'user', id: u.id, role: u.role });
    }

    const b = validateBody(body, { meter_id: { type: 'string', required: true, minLength: 1, maxLength: 40 }, device_secret: { type: 'string', required: true, minLength: 1, maxLength: 200 } });
    const inst = (await query('SELECT id, meter_id, status, device_secret_hash FROM solar_installations WHERE meter_id = $1', [b.meter_id])).rows[0];
    const ok = safeEqualHex(sha256(b.device_secret), inst ? inst.device_secret_hash : ZERO_HASH);
    if (!inst || !ok) throw invalid();
    if (inst.status === 'decommissioned') throw new ApiError(403, 'INSTALLATION_DECOMMISSIONED', 'This installation is decommissioned.');
    const scopes = DEVICE_SCOPES.join(' ');
    const ttl = config.jwt.deviceTtlSeconds;
    const token = jwt.sign({ token_use: 'device', installation_id: inst.id, meter_id: inst.meter_id, scope: scopes }, config.jwt.secret,
      { algorithm: 'HS256', subject: `device:${inst.id}`, issuer: config.jwt.issuer, audience: config.jwt.audience, expiresIn: ttl });
    return respond(res, token, ttl, scopes, { type: 'device', installation_id: inst.id, meter_id: inst.meter_id });
  }))
  .all(allow('POST'));

module.exports = r;
