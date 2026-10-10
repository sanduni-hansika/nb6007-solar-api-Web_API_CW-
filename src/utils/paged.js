'use strict';
const { query } = require('../db');
const { parsePaging, sendPaged } = require('./http');

/**
 * Generic paginated collection query: runs COUNT(*) + the page query with the same WHERE,
 * then answers with data + total count + next/previous links.
 */
async function runPaged(req, res, { select, from, where = [], params = [], order, mapper, lastModified }) {
  const { page, pageSize, offset } = parsePaging(req);
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = (await query(`SELECT count(*)::int AS n ${from} ${whereSql}`, params)).rows[0].n;
  const rows = (await query(
    `${select} ${from} ${whereSql} ORDER BY ${order} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset])).rows;
  return sendPaged(req, res, rows.map(mapper), { page, pageSize, total }, lastModified ? lastModified(rows) : undefined);
}
module.exports = { runPaged };
