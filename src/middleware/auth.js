'use strict';
const jwt = require('jsonwebtoken');
const config = require('../config');
const { query } = require('../db');
const { ApiError, ah } = require('../utils/errors');
const { ROLE_SCOPES, DEVICE_SCOPES } = require('../utils/scope');

const challenge = (extra = '') => ({ 'WWW-Authenticate': `Bearer realm="slsea-solar-api"${extra}` });
const unauthorized = (msg, code = 'UNAUTHENTICATED', err = '') =>
  new ApiError(401, code, msg, [], challenge(err ? `, error="${err}"` : ''));

/**
 * Verifies the JWT bearer token and builds req.auth.
 *  - user tokens: role + jurisdiction are re-read from the DB on every request (so a disabled user or a changed
 *    jurisdiction takes effect immediately) and scopes = token scopes INTERSECT role scopes.
 *  - device tokens: bound to ONE installation, scope readings:write only.
 */
const authenticate = ah(async (req, res, next) => {
  const header = req.get('authorization');
  if (!header) throw unauthorized('Authentication required. Send "Authorization: Bearer <token>" (obtain one via POST /api/v1/tokens).');
  const m = /^Bearer\s+([\w-]+\.[\w-]+\.[\w-]+)$/.exec(header);
  if (!m) throw unauthorized('Malformed Authorization header. Expected "Bearer <JWT>".', 'INVALID_TOKEN', 'invalid_request');

  let payload;
  try {
    payload = jwt.verify(m[1], config.jwt.secret, { algorithms: ['HS256'], issuer: config.jwt.issuer, audience: config.jwt.audience });
  } catch (e) {
    const expired = e.name === 'TokenExpiredError';
    throw unauthorized(expired ? 'The access token has expired. Request a new one.' : 'The access token is invalid.', expired ? 'TOKEN_EXPIRED' : 'INVALID_TOKEN', 'invalid_token');
  }
  const tokenScopes = String(payload.scope || '').split(' ').filter(Boolean);

  if (payload.token_use === 'user') {
    const id = parseInt(String(payload.sub).split(':')[1], 10);
    const { rows } = await query(
      `SELECT u.id, u.email, u.full_name, u.role, u.active, u.district_id,
              COALESCE(u.province_id, d.province_id) AS province_id
         FROM users u LEFT JOIN districts d ON d.id = u.district_id WHERE u.id = $1`, [id]);
    const u = rows[0];
    if (!u || !u.active) throw unauthorized('The account for this token is unknown or disabled.', 'INVALID_TOKEN', 'invalid_token');
    const roleScopes = ROLE_SCOPES[u.role];
    req.auth = {
      type: 'user', id: u.id, email: u.email, role: u.role,
      province_id: u.province_id, district_id: u.district_id,
      scopes: new Set(tokenScopes.filter((s) => roleScopes.includes(s))),
    };
  } else if (payload.token_use === 'device') {
    req.auth = {
      type: 'device', installation_id: payload.installation_id, meter_id: payload.meter_id,
      scopes: new Set(tokenScopes.filter((s) => DEVICE_SCOPES.includes(s))),
    };
  } else {
    throw unauthorized('The access token is invalid.', 'INVALID_TOKEN', 'invalid_token');
  }
  next();
});

/** Require ALL listed scopes. */
const requireScope = (...needed) => (req, res, next) => {
  const missing = needed.filter((s) => !req.auth.scopes.has(s));
  if (missing.length) {
    return next(new ApiError(403, 'INSUFFICIENT_SCOPE', 'Your token does not grant the scope required for this operation.',
      [{ required: needed, missing }], challenge(', error="insufficient_scope"')));
  }
  next();
};
const requireUser = (req, res, next) =>
  req.auth.type === 'user' ? next() : next(new ApiError(403, 'USER_TOKEN_REQUIRED', 'This resource is only available to SLSEA user accounts, not to metering devices.'));

module.exports = { authenticate, requireScope, requireUser };
