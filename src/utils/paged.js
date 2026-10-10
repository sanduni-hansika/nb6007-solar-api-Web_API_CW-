'use strict';

const { query } = require('../db');
const { parsePaging, sendPaged } = require('./http');

/**
 * Execute a paginated collection query.
 */
async function runPaged(req, res, {
  select,
  from,
  where = [],
  params = [],
  order,
  mapper,
  lastModified
}) {
  const { page, pageSize, offset } = parsePaging(req);

  const whereSql = where.length
    ? `WHERE ${where.join(' AND ')}`
    : '';

  const totalResult = await query(
    `SELECT count(*)::int AS n ${from} ${whereSql}`,
    params
  );
  const total = totalResult.rows[0].n;

  const rowsResult = await query(
    `${select} ${from} ${whereSql} ORDER BY ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset]
  );

  const rows = rowsResult.rows.map(mapper);

  return sendPaged(
    req,
    res,
    rows,
    { page, pageSize, total },
    lastModified ? lastModified(rowsResult.rows) : undefined
  );
}

module.exports = { runPaged };
