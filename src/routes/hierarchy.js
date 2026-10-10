'use strict';
// Province -> District -> Grid Substation (reference/asset hierarchy).
// Provinces and districts are static administrative geography => read-only. Substations are writable by admins.
const express = require('express');
const { query } = require('../db');
const { ApiError, ah, allow } = require('../utils/errors');
const { requireScope } = require('../middleware/auth');
const { validateBody, qSort, qEnum, qStr } = require('../utils/validate');
const { sendJson, sendCreated, checkIfMatch } = require('../utils/http');
const { runPaged } = require('../utils/paged');
const S = require('../utils/serialize');
const scope = require('../utils/scope');
const { parseId } = require('../utils/params');

const r = express.Router();
const read = requireScope('hierarchy:read');
const write = requireScope('assets:write');

// ---------- loaders ----------
async function loadProvince(id) {
  const row = (await query(`${S.SQL.province} WHERE p.id = $1`, [id])).rows[0];
  if (!row) throw new ApiError(404, 'PROVINCE_NOT_FOUND', `Province ${id} does not exist.`);
  return row;
}
async function loadDistrict(id) {
  const row = (await query(`${S.SQL.district} WHERE d.id = $1`, [id])).rows[0];
  if (!row) throw new ApiError(404, 'DISTRICT_NOT_FOUND', `District ${id} does not exist.`);
  return row;
}
async function loadSubstation(id) {
  const row = (await query(`${S.SQL.substation} WHERE s.id = $1`, [id])).rows[0];
  if (!row) throw new ApiError(404, 'SUBSTATION_NOT_FOUND', `Grid substation ${id} does not exist.`);
  return row;
}

// ---------- provinces ----------
r.route('/provinces')
  .get(read, ah(async (req, res) => {
    const params = [];
    const where = [scope.provincePredicate(req.auth, params)];
    const sort = qSort(req, { id: 'p.id', name: 'p.name', code: 'p.code' }, 'id');
    await runPaged(req, res, {
      select: 'SELECT p.id, p.code, p.name', from: 'FROM provinces p', where, params,
      order: `${sort.column} ${sort.dir}, p.id`, mapper: S.province,
    });
  }))
  .all(allow('GET'));

r.route('/provinces/:id')
  .get(read, ah(async (req, res) => {
    const row = await loadProvince(parseId(req.params.id));
    scope.assertProvinceVisible(req.auth, row.id);
    sendJson(req, res, S.province(row), { lastModified: row.updated_at });
  }))
  .all(allow('GET'));

r.route('/provinces/:id/districts')
  .get(read, ah(async (req, res) => {
    const prov = await loadProvince(parseId(req.params.id));
    scope.assertProvinceVisible(req.auth, prov.id);
    const params = [prov.id];
    const where = ['d.province_id = $1', scope.districtPredicate(req.auth, params)];
    const sort = qSort(req, { id: 'd.id', name: 'd.name', code: 'd.code' }, 'id');
    await runPaged(req, res, {
      select: 'SELECT d.id, d.code, d.name, d.province_id', from: 'FROM districts d', where, params,
      order: `${sort.column} ${sort.dir}, d.id`, mapper: S.district,
    });
  }))
  .all(allow('GET'));

// ---------- districts ----------
r.route('/districts/:id')
  .get(read, ah(async (req, res) => {
    const row = await loadDistrict(parseId(req.params.id));
    scope.assertInScope(req.auth, { province_id: row.province_id, district_id: row.id });
    sendJson(req, res, S.district(row), { lastModified: row.updated_at });
  }))
  .all(allow('GET'));

r.route('/districts/:id/grid-substations')
  .get(read, ah(async (req, res) => {
    const d = await loadDistrict(parseId(req.params.id));
    scope.assertInScope(req.auth, { province_id: d.province_id, district_id: d.id });
    const params = [d.id];
    const sort = qSort(req, { id: 's.id', code: 's.code', name: 's.name', capacity_mva: 's.capacity_mva' }, 'id');
    await runPaged(req, res, {
      select: 'SELECT s.id, s.code, s.name, s.district_id, d.province_id, s.voltage_level_kv, s.capacity_mva, s.created_at, s.updated_at',
      from: 'FROM grid_substations s JOIN districts d ON d.id = s.district_id', where: ['s.district_id = $1'], params,
      order: `${sort.column} ${sort.dir}, s.id`, mapper: S.substation,
    });
  }))
  .post(write, ah(async (req, res) => {
    const d = await loadDistrict(parseId(req.params.id));
    const b = validateBody(req.body, SUBSTATION_RULES(true));
    const row = (await query(
      `INSERT INTO grid_substations (district_id, code, name, voltage_level_kv, capacity_mva) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [d.id, b.code, b.name, b.voltage_level_kv, b.capacity_mva])).rows[0];
    const created = await loadSubstation(row.id);
    sendCreated(req, res, S.substation(created), `/api/v1/grid-substations/${row.id}`);
  }))
  .all(allow('GET', 'POST'));

// ---------- grid substations ----------
const SUBSTATION_RULES = (all) => ({
  code: { type: 'string', required: all, pattern: /^[A-Z0-9-]{3,30}$/, patternMsg: 'must be 3-30 characters: A-Z, 0-9 or hyphen' },
  name: { type: 'string', required: all, minLength: 1, maxLength: 150 },
  voltage_level_kv: { type: 'number', required: all, exclusiveMin: 0, max: 765 },
  capacity_mva: { type: 'number', required: all, exclusiveMin: 0, max: 5000 },
});

r.route('/grid-substations/:id')
  .get(read, ah(async (req, res) => {
    const row = await loadSubstation(parseId(req.params.id));
    scope.assertInScope(req.auth, row);
    sendJson(req, res, S.substation(row), { lastModified: row.updated_at });
  }))
  .put(write, ah(async (req, res) => { // full replacement (idempotent)
    const cur = await loadSubstation(parseId(req.params.id));
    checkIfMatch(req, S.substation(cur));
    const b = validateBody(req.body, SUBSTATION_RULES(true));
    await query('UPDATE grid_substations SET code=$1, name=$2, voltage_level_kv=$3, capacity_mva=$4, updated_at=now() WHERE id=$5',
      [b.code, b.name, b.voltage_level_kv, b.capacity_mva, cur.id]);
    const row = await loadSubstation(cur.id);
    sendJson(req, res, S.substation(row), { lastModified: row.updated_at });
  }))
  .patch(write, ah(async (req, res) => { // partial update
    const cur = await loadSubstation(parseId(req.params.id));
    checkIfMatch(req, S.substation(cur));
    const b = validateBody(req.body, SUBSTATION_RULES(false), { partial: true });
    const merged = { ...cur, ...b };
    await query('UPDATE grid_substations SET code=$1, name=$2, voltage_level_kv=$3, capacity_mva=$4, updated_at=now() WHERE id=$5',
      [merged.code, merged.name, merged.voltage_level_kv, merged.capacity_mva, cur.id]);
    const row = await loadSubstation(cur.id);
    sendJson(req, res, S.substation(row), { lastModified: row.updated_at });
  }))
  .delete(write, ah(async (req, res) => {
    const cur = await loadSubstation(parseId(req.params.id));
    checkIfMatch(req, S.substation(cur));
    await query('DELETE FROM grid_substations WHERE id = $1', [cur.id]); // 409 via FK if it still has installations
    res.status(204).end();
  }))
  .all(allow('GET', 'PUT', 'PATCH', 'DELETE'));

module.exports = r;
