'use strict';
const express = require('express');
const { query } = require('../db');
const config = require('../config');
const { ApiError, ah, allow } = require('../utils/errors');
const { requireScope } = require('../middleware/auth');
const { validateBody, qSort, qEnum, qStr, qInt } = require('../utils/validate');
const { sendJson, sendCreated, checkIfMatch } = require('../utils/http');
const { runPaged } = require('../utils/paged');
const { sha256, newDeviceSecret } = require('../utils/security');
const { parseId } = require('../utils/params');
const S = require('../utils/serialize');
const scope = require('../utils/scope');
const { TZ_MS } = require('../sim/generator');

const r = express.Router();
const read = requireScope('hierarchy:read');
const readReadings = requireScope('readings:read');
const write = requireScope('assets:write');
const STATUSES = ['active', 'maintenance', 'decommissioned'];

async function loadInstallation(id) {
  const row = (await query(`${S.SQL.installation} WHERE i.id = $1`, [id])).rows[0];
  if (!row) throw new ApiError(404, 'INSTALLATION_NOT_FOUND', `Solar installation ${id} does not exist.`);
  return row;
}
/** Load + enforce jurisdiction. Used by every installation-scoped route. */
async function loadScoped(req, id) {
  const row = await loadInstallation(id);
  scope.assertInScope(req.auth, row);
  return row;
}

const RULES = (all) => ({
  substation_id: { type: 'integer', required: all, min: 1 },
  meter_id: { type: 'string', required: all, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{3,38}$/, patternMsg: 'must be 4-39 characters: letters, digits, dot, underscore or hyphen' },
  site_name: { type: 'string', required: all, minLength: 1, maxLength: 150 },
  installed_capacity_kw: { type: 'number', required: all, exclusiveMin: 0, max: 1000 },
  latitude: { type: 'number', required: all, nullable: true, min: -90, max: 90 },
  longitude: { type: 'number', required: all, nullable: true, min: -180, max: 180 },
  status: { type: 'enum', values: STATUSES, required: all },
  commissioned_on: { type: 'date', required: all, notFuture: true },
});

async function assertSubstationExists(id) {
  const ok = (await query('SELECT 1 FROM grid_substations WHERE id = $1', [id])).rowCount;
  if (!ok) throw new ApiError(400, 'VALIDATION_FAILED', 'The request body failed validation.', [{ field: 'substation_id', issue: `grid substation ${id} does not exist` }]);
}

// ---------- collection (global, jurisdiction-filtered) ----------
r.route('/installations')
  .get(read, ah(async (req, res) => {
    const params = [];
    const where = [scope.districtPredicate(req.auth, params)];
    const f = { province_id: qInt(req, 'province_id'), district_id: qInt(req, 'district_id'), substation_id: qInt(req, 'substation_id') };
    if (f.province_id) where.push(`d.province_id = ${scope.push(params, f.province_id)}`);
    if (f.district_id) where.push(`d.id = ${scope.push(params, f.district_id)}`);
    if (f.substation_id) where.push(`s.id = ${scope.push(params, f.substation_id)}`);
    const status = qEnum(req, 'status', STATUSES);
    if (status) where.push(`i.status = ${scope.push(params, status)}`);
    const q = qStr(req, 'q', { max: 60 });
    if (q) where.push(`(i.site_name ILIKE ${scope.push(params, '%' + q.replace(/[%_\\]/g, '\\$&') + '%')} OR i.meter_id ILIKE $${params.length})`);
    const sort = qSort(req, { id: 'i.id', meter_id: 'i.meter_id', site_name: 'i.site_name', installed_capacity_kw: 'i.installed_capacity_kw', commissioned_on: 'i.commissioned_on' }, 'id');
    await runPaged(req, res, {
      select: `SELECT ${S.SQL.installationCols}`, from: S.SQL.installationFrom, where, params,
      order: `${sort.column} ${sort.dir}, i.id`, mapper: S.installation,
    });
  }))
  .all(allow('GET'));

// scoped collection under a substation (+ create)
r.route('/grid-substations/:id/installations')
  .get(read, ah(async (req, res) => {
    const sid = parseId(req.params.id);
    const sub = (await query(`${S.SQL.substation} WHERE s.id = $1`, [sid])).rows[0];
    if (!sub) throw new ApiError(404, 'SUBSTATION_NOT_FOUND', `Grid substation ${sid} does not exist.`);
    scope.assertInScope(req.auth, sub);
    const params = [sid];
    const where = ['i.substation_id = $1'];
    const status = qEnum(req, 'status', STATUSES);
    if (status) where.push(`i.status = ${scope.push(params, status)}`);
    const sort = qSort(req, { id: 'i.id', meter_id: 'i.meter_id', site_name: 'i.site_name', installed_capacity_kw: 'i.installed_capacity_kw' }, 'id');
    await runPaged(req, res, {
      select: `SELECT ${S.SQL.installationCols}`, from: S.SQL.installationFrom, where, params,
      order: `${sort.column} ${sort.dir}, i.id`, mapper: S.installation,
    });
  }))
  .post(write, ah(async (req, res) => {
    const sid = parseId(req.params.id);
    const sub = (await query('SELECT id FROM grid_substations WHERE id = $1', [sid])).rows[0];
    if (!sub) throw new ApiError(404, 'SUBSTATION_NOT_FOUND', `Grid substation ${sid} does not exist.`);
    const rules = RULES(true);
    delete rules.substation_id;
    rules.status.required = false; rules.status.default = 'active';
    rules.latitude.required = false; rules.longitude.required = false;
    const b = validateBody(req.body, rules);
    const secret = newDeviceSecret();
    const ins = (await query(
      `INSERT INTO solar_installations (substation_id, meter_id, site_name, installed_capacity_kw, latitude, longitude, status, commissioned_on, device_secret_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [sid, b.meter_id, b.site_name, b.installed_capacity_kw, b.latitude ?? null, b.longitude ?? null, b.status, b.commissioned_on, sha256(secret)])).rows[0];
    const row = await loadInstallation(ins.id);
    // The device secret is shown ONCE (only its SHA-256 is stored).
    sendCreated(req, res, S.installation(row), `/api/v1/installations/${row.id}`, {
      device_credentials: { meter_id: row.meter_id, device_secret: secret, note: 'Store this secret now - it cannot be retrieved again.' },
    });
  }))
  .all(allow('GET', 'POST'));

// ---------- atomic resource ----------
r.route('/installations/:id')
  .get(read, ah(async (req, res) => {
    const row = await loadScoped(req, parseId(req.params.id));
    sendJson(req, res, S.installation(row), { lastModified: row.updated_at });
  }))
  .put(write, ah(async (req, res) => { // FULL replacement, idempotent
    const cur = await loadInstallation(parseId(req.params.id));
    checkIfMatch(req, S.installation(cur));
    const b = validateBody(req.body, RULES(true));
    await assertSubstationExists(b.substation_id);
    await update(cur.id, b);
    const row = await loadInstallation(cur.id);
    sendJson(req, res, S.installation(row), { lastModified: row.updated_at });
  }))
  .patch(write, ah(async (req, res) => { // PARTIAL update (never PUT for partial)
    const cur = await loadInstallation(parseId(req.params.id));
    checkIfMatch(req, S.installation(cur));
    const b = validateBody(req.body, RULES(false), { partial: true });
    if (b.substation_id !== undefined) await assertSubstationExists(b.substation_id);
    await update(cur.id, { ...cur, ...b });
    const row = await loadInstallation(cur.id);
    sendJson(req, res, S.installation(row), { lastModified: row.updated_at });
  }))
  .delete(write, ah(async (req, res) => {
    const cur = await loadInstallation(parseId(req.params.id));
    checkIfMatch(req, S.installation(cur));
    await query('DELETE FROM solar_installations WHERE id = $1', [cur.id]); // readings cascade
    res.status(204).end();
  }))
  .all(allow('GET', 'PUT', 'PATCH', 'DELETE'));

async function update(id, b) {
  await query(
    `UPDATE solar_installations SET substation_id=$1, meter_id=$2, site_name=$3, installed_capacity_kw=$4, latitude=$5, longitude=$6,
            status=$7, commissioned_on=$8, updated_at=now() WHERE id=$9`,
    [b.substation_id, b.meter_id, b.site_name, b.installed_capacity_kw, b.latitude, b.longitude, b.status, b.commissioned_on, id]);
}

// ---------- derived: last-known reading (operational view) ----------
async function latestReading(installationId) {
  return (await query(`SELECT ${S.SQL.readingCols} FROM generation_readings r WHERE r.installation_id = $1 ORDER BY r.measured_at DESC LIMIT 1`, [installationId])).rows[0];
}
const freshness = (row) => (Date.now() - new Date(row.measured_at).getTime() <= config.staleAfterMinutes * 60000 ? 'live' : 'stale');

r.route('/installations/:id/latest-reading')
  .get(readReadings, ah(async (req, res) => {
    const inst = await loadScoped(req, parseId(req.params.id));
    const last = await latestReading(inst.id);
    if (!last) throw new ApiError(404, 'NO_READINGS_YET', `Installation ${inst.id} has not reported any readings yet.`);
    const body = {
      installation_id: inst.id, meter_id: inst.meter_id, installation_status: inst.status,
      freshness: freshness(last), // derived: 'live' (< 30 min old) or 'stale'
      capacity_utilisation_percent: Math.round((last.power_kw / inst.installed_capacity_kw) * 1000) / 10, // derived
      reading: S.reading(last),
    };
    sendJson(req, res, body, { lastModified: last.measured_at });
  }))
  .all(allow('GET'));

// ---------- composite resource: installation + its most relevant related data ----------
function startOfTodayColombo() {
  return new Date(Math.floor((Date.now() + TZ_MS) / 86400000) * 86400000 - TZ_MS);
}
r.route('/installations/:id/overview')
  .get(read, readReadings, ah(async (req, res) => {
    const inst = await loadScoped(req, parseId(req.params.id));
    const [hier, last, today] = await Promise.all([
      query(`SELECT s.id AS sid, s.code AS scode, s.name AS sname, d.id AS did, d.name AS dname, p.id AS pid, p.name AS pname
               FROM grid_substations s JOIN districts d ON d.id = s.district_id JOIN provinces p ON p.id = d.province_id WHERE s.id = $1`, [inst.substation_id]),
      latestReading(inst.id),
      query(`SELECT count(*)::int AS readings, COALESCE(max(power_kw),0) AS peak_kw,
                    COALESCE(max(energy_kwh) - min(energy_kwh), 0) AS energy_span
               FROM generation_readings WHERE installation_id = $1 AND measured_at >= $2`, [inst.id, startOfTodayColombo()]),
    ]);
    const h = hier.rows[0];
    const baseline = (await query('SELECT energy_kwh FROM generation_readings WHERE installation_id=$1 AND measured_at < $2 ORDER BY measured_at DESC LIMIT 1', [inst.id, startOfTodayColombo()])).rows[0];
    const t = today.rows[0];
    const todayEnergy = last ? (baseline ? last.energy_kwh - baseline.energy_kwh : t.energy_span) : 0;
    const body = {
      installation: S.installation(inst),
      hierarchy: {
        grid_substation: { id: h.sid, code: h.scode, name: h.sname },
        district: { id: h.did, name: h.dname },
        province: { id: h.pid, name: h.pname },
      },
      latest_reading: last ? { ...S.reading(last), freshness: freshness(last) } : null,
      today: {
        timezone: 'Asia/Colombo', since: startOfTodayColombo().toISOString(), readings: t.readings,
        energy_kwh: Math.round(Math.max(todayEnergy, 0) * 1000) / 1000, peak_power_kw: t.peak_kw,
      },
    };
    sendJson(req, res, body, { lastModified: last ? last.measured_at : inst.updated_at });
  }))
  .all(allow('GET'));

module.exports = r;
module.exports.loadInstallation = loadInstallation;
module.exports.loadScoped = loadScoped;
