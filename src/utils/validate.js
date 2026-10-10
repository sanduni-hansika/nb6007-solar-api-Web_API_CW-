'use strict';
const { ApiError, bad } = require('./errors');

const ISO_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseDateTime(s) {
  if (typeof s !== 'string') return null;
  const fixed = s.replace(/ (\d{2}:\d{2})$/, '+$1'); // '+' in a query string arrives as ' '
  if (!ISO_DT.test(fixed)) return null;
  const d = new Date(fixed);
  return Number.isNaN(d.getTime()) ? null : d;
}
function isDateOnly(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function check(v, r) {
  switch (r.type) {
    case 'string':
      if (typeof v !== 'string') return ['must be a string'];
      if (r.minLength && v.trim().length < r.minLength) return [`must be at least ${r.minLength} characters`];
      if (r.maxLength && v.length > r.maxLength) return [`must be at most ${r.maxLength} characters`];
      if (r.pattern && !r.pattern.test(v)) return [r.patternMsg || 'has an invalid format'];
      return [null, v.trim()];
    case 'email':
      if (typeof v !== 'string' || v.length > 255 || !EMAIL.test(v)) return ['must be a valid e-mail address'];
      return [null, v.trim().toLowerCase()];
    case 'number':
    case 'integer':
      if (typeof v !== 'number' || !Number.isFinite(v)) return ['must be a number'];
      if (r.type === 'integer' && !Number.isInteger(v)) return ['must be an integer'];
      if (r.exclusiveMin !== undefined && v <= r.exclusiveMin) return [`must be greater than ${r.exclusiveMin}`];
      if (r.min !== undefined && v < r.min) return [`must be >= ${r.min}`];
      if (r.max !== undefined && v > r.max) return [`must be <= ${r.max}`];
      return [null, v];
    case 'enum':
      if (!r.values.includes(v)) return [`must be one of: ${r.values.join(', ')}`];
      return [null, v];
    case 'boolean':
      if (typeof v !== 'boolean') return ['must be true or false'];
      return [null, v];
    case 'datetime': {
      const d = parseDateTime(v);
      if (!d) return ['must be an ISO-8601 date-time with a time zone, e.g. 2026-10-09T10:15:00Z'];
      return [null, d];
    }
    case 'date':
      if (!isDateOnly(v)) return ['must be a calendar date formatted YYYY-MM-DD'];
      if (r.notFuture && v > new Date().toISOString().slice(0, 10)) return ['must not be in the future'];
      return [null, v];
    default:
      return ['unsupported rule'];
  }
}

/**
 * Validate a JSON body against a rule set. Unknown fields are rejected (strict).
 * partial=true => PATCH semantics (only supplied fields are checked, none required).
 */
function validateBody(body, spec, { partial = false } = {}) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw bad('INVALID_BODY', 'The request body must be a JSON object.');
  }
  const errors = [];
  for (const key of Object.keys(body)) if (!Object.prototype.hasOwnProperty.call(spec, key)) errors.push({ field: key, issue: 'unknown field' });
  const out = {};
  for (const [name, rule] of Object.entries(spec)) {
    const present = Object.prototype.hasOwnProperty.call(body, name) && body[name] !== undefined;
    if (!present) {
      if (!partial && rule.required) errors.push({ field: name, issue: 'is required' });
      else if (!partial && 'default' in rule) out[name] = rule.default;
      continue;
    }
    const v = body[name];
    if (v === null) {
      if (rule.nullable) out[name] = null;
      else errors.push({ field: name, issue: 'must not be null' });
      continue;
    }
    const [err, norm] = check(v, rule);
    if (err) errors.push({ field: name, issue: err });
    else out[name] = norm;
  }
  if (partial && errors.length === 0 && Object.keys(out).length === 0) {
    errors.push({ field: '(body)', issue: 'must contain at least one field to change' });
  }
  if (errors.length) throw new ApiError(400, 'VALIDATION_FAILED', 'The request body failed validation.', errors);
  return out;
}

// ---------- query-string helpers ----------
const badParam = (name, issue) => new ApiError(400, 'INVALID_QUERY_PARAMETER', `Invalid query parameter '${name}'.`, [{ parameter: name, issue }]);
function one(req, name) {
  const v = req.query[name];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw badParam(name, 'must be supplied only once');
  return v;
}
function qInt(req, name, { min = 1, max = Number.MAX_SAFE_INTEGER, def } = {}) {
  const v = one(req, name);
  if (v === undefined || v === '') return def;
  if (!/^-?\d+$/.test(v)) throw badParam(name, 'must be an integer');
  const n = parseInt(v, 10);
  if (n < min || n > max) throw badParam(name, `must be between ${min} and ${max}`);
  return n;
}
function qEnum(req, name, values) {
  const v = one(req, name);
  if (v === undefined || v === '') return undefined;
  if (!values.includes(v)) throw badParam(name, `must be one of: ${values.join(', ')}`);
  return v;
}
function qStr(req, name, { max = 100 } = {}) {
  const v = one(req, name);
  if (v === undefined || v === '') return undefined;
  if (v.length > max) throw badParam(name, `must be at most ${max} characters`);
  return v;
}
function qTime(req, name) {
  const v = one(req, name);
  if (v === undefined || v === '') return undefined;
  const d = parseDateTime(v);
  if (!d) throw badParam(name, 'must be an ISO-8601 date-time with a time zone, e.g. 2026-10-09T00:00:00Z');
  return d;
}
/** sort=field | sort=-field (and optional order=asc|desc). `map` whitelists field -> SQL column. */
function qSort(req, map, def) {
  let s = one(req, 'sort') || def;
  let dir = 'ASC';
  if (s.startsWith('-')) { dir = 'DESC'; s = s.slice(1); }
  if (!Object.prototype.hasOwnProperty.call(map, s)) throw badParam('sort', `must be one of: ${Object.keys(map).join(', ')} (prefix with '-' for descending)`);
  const order = one(req, 'order');
  if (order !== undefined) {
    if (!['asc', 'desc'].includes(order.toLowerCase())) throw badParam('order', 'must be asc or desc');
    dir = order.toUpperCase();
  }
  return { column: map[s], dir, field: s };
}

module.exports = { validateBody, parseDateTime, qInt, qEnum, qStr, qTime, qSort, badParam };
