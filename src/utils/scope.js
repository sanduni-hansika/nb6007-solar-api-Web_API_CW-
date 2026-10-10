'use strict';
// Jurisdiction-scoped authorisation (attribute-based) on top of JWT scopes.
const config = require('../config');
const { ApiError } = require('./errors');

const READ = ['hierarchy:read', 'readings:read'];
const ROLE_SCOPES = {
  admin: [...READ, 'assets:write', 'readings:delete', 'users:manage'],
  national: READ,
  provincial: READ,
  district: READ,
};
const DEVICE_SCOPES = ['readings:write'];

const isNational = (a) => a.role === 'admin' || a.role === 'national';

/** Can this user see a resource located at (province_id, district_id)?  Strictly within their sub-tree. */
function inScope(auth, loc) {
  if (isNational(auth)) return true;
  if (auth.role === 'provincial') return loc.province_id === auth.province_id;
  if (auth.role === 'district') return loc.district_id === auth.district_id;
  return false;
}
/** A province record is visible to its own province users and (as an ancestor) to its districts' users. */
function provinceVisible(auth, provinceId) {
  if (isNational(auth)) return true;
  return auth.province_id === provinceId; // provincial: own; district: their parent province
}

function deny() {
  if (config.hideOutOfScope) return new ApiError(404, 'NOT_FOUND', 'The requested resource was not found.');
  return new ApiError(403, 'OUT_OF_JURISDICTION', 'Your account is not authorised to access data outside your jurisdiction.');
}
function assertInScope(auth, loc) { if (!inScope(auth, loc)) throw deny(); }
function assertProvinceVisible(auth, id) { if (!provinceVisible(auth, id)) throw deny(); }

// ---- SQL predicates (collections are filtered in the database, so out-of-scope rows are never even read) ----
function push(params, v) { params.push(v); return '$' + params.length; }
/** `d` = alias of the districts table in the query. */
function districtPredicate(auth, params, d = 'd') {
  if (isNational(auth)) return 'TRUE';
  if (auth.role === 'provincial') return `${d}.province_id = ${push(params, auth.province_id)}`;
  return `${d}.id = ${push(params, auth.district_id)}`;
}
function provincePredicate(auth, params, p = 'p') {
  if (isNational(auth)) return 'TRUE';
  return `${p}.id = ${push(params, auth.province_id)}`;
}

module.exports = { deny, ROLE_SCOPES, DEVICE_SCOPES, inScope, provinceVisible, assertInScope, assertProvinceVisible, districtPredicate, provincePredicate, push, isNational };
