'use strict';
const { bad } = require('./errors');
/** Path ids must be positive integers => otherwise 400 (not a confusing 404/500). */
function parseId(v, name = 'id') {
  if (!/^\d{1,9}$/.test(v) || parseInt(v, 10) < 1) throw bad('INVALID_PATH_PARAMETER', `The path parameter '${name}' must be a positive integer.`, [{ parameter: name, value: String(v).slice(0, 30) }]);
  return parseInt(v, 10);
}
module.exports = { parseId };
