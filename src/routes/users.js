'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const { query } = require('../db');
const { ApiError, ah, allow } = require('../utils/errors');
const { requireScope, requireUser } = require('../middleware/auth');
const { validateBody, qEnum, qSort } = require('../utils/validate');
const { sendJson, sendCreated } = require('../utils/http');
const { runPaged } = require('../utils/paged');
const { parseId } = require('../utils/params');
const S = require('../utils/serialize');

const r = express.Router();
const manage = requireScope('users:manage');
const COLS = 'u.id, u.email, u.full_name, u.role, u.active, u.created_at, u.province_id, u.district_id';
const ROLES = ['admin', 'national', 'provincial', 'district'];
const PASSWORD = { type: 'string', minLength: 10, maxLength: 72, pattern: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).+$/, patternMsg: 'must contain upper-case, lower-case and a digit' };

async function loadUser(id) {
  const row = (await query(`SELECT ${COLS} FROM users u WHERE u.id = $1`, [id])).rows[0];
  if (!row) throw new ApiError(404, 'USER_NOT_FOUND', `User ${id} does not exist.`);
  return row;
}

r.route('/users/me')
  .get(requireUser, ah(async (req, res) => {
    const row = await loadUser(req.auth.id);
    sendJson(req, res, { ...S.user(row), province_id: req.auth.province_id ?? null, jurisdiction: req.auth.role === 'district' ? 'district' : req.auth.role === 'provincial' ? 'province' : 'national', scopes: [...req.auth.scopes] });
  }))
  .all(allow('GET'));

r.route('/users')
  .get(manage, ah(async (req, res) => {
    const params = [];
    const where = [];
    const role = qEnum(req, 'role', ROLES);
    if (role) { params.push(role); where.push(`u.role = $${params.length}`); }
    const sort = qSort(req, { id: 'u.id', email: 'u.email', role: 'u.role' }, 'id');
    await runPaged(req, res, { select: `SELECT ${COLS}`, from: 'FROM users u', where, params, order: `${sort.column} ${sort.dir}, u.id`, mapper: S.user });
  }))
  .post(manage, ah(async (req, res) => {
    const b = validateBody(req.body, {
      email: { type: 'email', required: true },
      password: { ...PASSWORD, required: true },
      full_name: { type: 'string', required: true, minLength: 1, maxLength: 150 },
      role: { type: 'enum', values: ROLES, required: true },
      province_id: { type: 'integer', min: 1 },
      district_id: { type: 'integer', min: 1 },
    });
    const errs = [];
    if (b.role === 'provincial' && !b.province_id) errs.push({ field: 'province_id', issue: 'is required for role provincial' });
    if (b.role === 'district' && !b.district_id) errs.push({ field: 'district_id', issue: 'is required for role district' });
    if (['admin', 'national'].includes(b.role) && (b.province_id || b.district_id)) errs.push({ field: 'role', issue: 'admin/national users must not have a province_id or district_id' });
    if (b.role === 'provincial' && b.district_id) errs.push({ field: 'district_id', issue: 'must not be set for role provincial' });
    if (b.role === 'district' && b.province_id) errs.push({ field: 'province_id', issue: 'must not be set for role district (derived from the district)' });
    if (b.province_id && !(await query('SELECT 1 FROM provinces WHERE id=$1', [b.province_id])).rowCount) errs.push({ field: 'province_id', issue: 'does not exist' });
    if (b.district_id && !(await query('SELECT 1 FROM districts WHERE id=$1', [b.district_id])).rowCount) errs.push({ field: 'district_id', issue: 'does not exist' });
    if (errs.length) throw new ApiError(400, 'VALIDATION_FAILED', 'The request body failed validation.', errs);
    const hash = await bcrypt.hash(b.password, 10);
    const row = (await query(
      `INSERT INTO users (email, password_hash, full_name, role, province_id, district_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [b.email, hash, b.full_name, b.role, b.province_id ?? null, b.district_id ?? null])).rows[0];
    sendCreated(req, res, S.user(await loadUser(row.id)), `/api/v1/users/${row.id}`);
  }))
  .all(allow('GET', 'POST'));

r.route('/users/:id')
  .get(manage, ah(async (req, res) => sendJson(req, res, S.user(await loadUser(parseId(req.params.id))))))
  .patch(manage, ah(async (req, res) => {
    const cur = await loadUser(parseId(req.params.id));
    const b = validateBody(req.body, {
      full_name: { type: 'string', minLength: 1, maxLength: 150 },
      active: { type: 'boolean' },
      password: PASSWORD,
    }, { partial: true });
    if (b.password) b.password_hash = await bcrypt.hash(b.password, 10);
    await query(
      `UPDATE users SET full_name = COALESCE($1, full_name), active = COALESCE($2, active), password_hash = COALESCE($3, password_hash), updated_at = now() WHERE id = $4`,
      [b.full_name ?? null, b.active ?? null, b.password_hash ?? null, cur.id]);
    sendJson(req, res, S.user(await loadUser(cur.id)));
  }))
  .delete(manage, ah(async (req, res) => {
    const cur = await loadUser(parseId(req.params.id));
    if (cur.id === req.auth.id) throw new ApiError(409, 'CANNOT_DELETE_SELF', 'You cannot delete your own account.');
    await query('DELETE FROM users WHERE id = $1', [cur.id]);
    res.status(204).end();
  }))
  .all(allow('GET', 'PATCH', 'DELETE'));

module.exports = r;
