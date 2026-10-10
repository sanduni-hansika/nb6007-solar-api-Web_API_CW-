'use strict';
const express = require('express');
const { query } = require('../db');
const config = require('../config');
const { ApiError, ah, allow } = require('../utils/errors');
const { requireScope } = require('../middleware/auth');
const { validateBody, qSort, qInt, qTime, badParam } = require('../utils/validate');
const { sendJson, sendCreated, absUrl } = require('../utils/http');
const { runPaged } = require('../utils/paged');
const { parseId } = require('../utils/params');
const S = require('../utils/serialize');
const scope = require('../utils/scope');
const { loadInstallation, loadScoped } = require('./installations');

const r = express.Router();
const readReadings = requireScope('readings:read');
const SORTS = { timestamp: 'r.measured_at', power_kw: 'r.power_kw', energy_kwh: 'r.energy_kwh' };

/** Shared by /readings (cross-installation) and /installations/:id/readings. */
async function listReadings(req, res, { installationId, withHierarchyFilters }) {
  const params = [];
  const where = [scope.districtPredicate(req.auth, params)]; // jurisdiction filter is ALWAYS applied
  if (installationId) where.push(`r.installation_id = ${scope.push(params, installationId)}`);
  if (withHierarchyFilters) {
    const f = { installation_id: qInt(req, 'installation_id'), substation_id: qInt(req, 'substation_id'), district_id: qInt(req, 'district_id'), province_id: qInt(req, 'province_id') };
    if (f.installation_id) where.push(`r.installation_id = ${scope.push(params, f.installation_id)}`);
    if (f.substation_id) where.push(`s.id = ${scope.push(params, f.substation_id)}`);
    if (f.district_id) where.push(`d.id = ${scope.push(params, f.district_id)}`);
    if (f.province_id) where.push(`d.province_id = ${scope.push(params, f.province_id)}`);
  }
  const from = qTime(req, 'from');
  const to = qTime(req, 'to');
  if (from && to && from > to) throw badParam('from', "must not be later than 'to'");
  if (from) where.push(`r.measured_at >= ${scope.push(params, from)}`);
  if (to) where.push(`r.measured_at <= ${scope.push(params, to)}`);
  const sort = qSort(req, SORTS, '-timestamp');
  await runPaged(req, res, {
    select: `SELECT ${S.SQL.readingCols}`, from: S.SQL.readingFrom, where, params,
    order: `${sort.column} ${sort.dir}, r.id ${sort.dir}`, mapper: S.reading,
    lastModified: (rows) => rows.reduce((m, x) => (x.received_at > m ? x.received_at : m), rows[0] ? rows[0].received_at : undefined),
  });
}

// analytical surface: all readings visible to the caller, filterable by jurisdiction + time window
r.route('/readings')
  .get(readReadings, ah((req, res) => listReadings(req, res, { withHierarchyFilters: true })))
  .all(allow('GET'));

// scoped sub-collection: history of ONE installation (+ device ingestion)
const INGEST_RULES = {
  timestamp: { type: 'datetime' },
  power_kw: { type: 'number', required: true, min: 0, max: 5000 },
  energy_kwh: { type: 'number', required: true, min: 0, max: 1e9 },
  voltage_v: { type: 'number', required: true, min: 0, max: 1000 },
  temperature_c: { type: 'number', nullable: true, min: -40, max: 150 },
};
const same = (a, b) => Math.abs(a - b) < 1e-6;

r.route('/installations/:id/readings')
  .get(readReadings, ah(async (req, res) => {
    const inst = await loadScoped(req, parseId(req.params.id));
    await listReadings(req, res, { installationId: inst.id });
  }))
  .post(requireScope('readings:write'), ah(async (req, res) => {
    const id = parseId(req.params.id);
    // WRITE-PATH AUTHORISATION: a device may write ONLY for the installation it authenticated as.
    if (req.auth.type !== 'device' || req.auth.installation_id !== id) {
      throw new ApiError(403, 'DEVICE_INSTALLATION_MISMATCH', 'A metering device may only push readings for the installation it authenticated as.');
    }
    const inst = await loadInstallation(id);
    if (inst.status === 'decommissioned') throw new ApiError(403, 'INSTALLATION_DECOMMISSIONED', 'This installation is decommissioned and cannot accept readings.');
    const b = validateBody(req.body, INGEST_RULES);
    const ts = b.timestamp || new Date();
    const now = Date.now();
    const errors = [];
    if (ts.getTime() > now + 5 * 60000) errors.push({ field: 'timestamp', issue: 'must not be more than 5 minutes in the future' });
    if (ts.getTime() < now - config.retentionDays * 86400000) errors.push({ field: 'timestamp', issue: `must not be older than ${config.retentionDays} days` });
    if (b.power_kw > inst.installed_capacity_kw * 2) errors.push({ field: 'power_kw', issue: `implausible: exceeds twice the installed capacity (${inst.installed_capacity_kw} kW)` });
    const last = (await query('SELECT measured_at, energy_kwh FROM generation_readings WHERE installation_id=$1 ORDER BY measured_at DESC LIMIT 1', [id])).rows[0];
    if (last && ts > last.measured_at && b.energy_kwh < last.energy_kwh) {
      errors.push({ field: 'energy_kwh', issue: `cumulative energy cannot decrease (previous value ${last.energy_kwh} kWh)` });
    }
    if (errors.length) throw new ApiError(400, 'VALIDATION_FAILED', 'The reading failed validation.', errors);

    const ins = await query(
      `INSERT INTO generation_readings (installation_id, measured_at, power_kw, energy_kwh, voltage_v, temperature_c)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (installation_id, measured_at) DO NOTHING RETURNING id`,
      [id, ts, b.power_kw, b.energy_kwh, b.voltage_v, b.temperature_c ?? null]);
    if (ins.rowCount === 1) {
      const row = (await query(`SELECT ${S.SQL.readingCols} FROM generation_readings r WHERE r.id = $1`, [ins.rows[0].id])).rows[0];
      return sendCreated(req, res, S.reading(row), `/api/v1/installations/${id}/readings/${row.id}`);
    }
    // Duplicate timestamp: a RETRY of the same reading is idempotent (200 + same resource); a different value is a conflict (409).
    const ex = (await query(`SELECT ${S.SQL.readingCols} FROM generation_readings r WHERE r.installation_id=$1 AND r.measured_at=$2`, [id, ts])).rows[0];
    const loc = `/api/v1/installations/${id}/readings/${ex.id}`;
    if (same(ex.power_kw, b.power_kw) && same(ex.energy_kwh, b.energy_kwh) && same(ex.voltage_v, b.voltage_v)) {
      res.set('Content-Location', absUrl(req, loc));
      return sendJson(req, res, S.reading(ex), { status: 200 });
    }
    throw new ApiError(409, 'READING_ALREADY_EXISTS', 'A different reading already exists for this installation and timestamp (readings are append-only).',
      [{ existing_reading: absUrl(req, loc) }], { Location: absUrl(req, loc) });
  }))
  .all(allow('GET', 'POST'));

r.route('/installations/:id/readings/:readingId')
  .get(readReadings, ah(async (req, res) => {
    const inst = await loadScoped(req, parseId(req.params.id));
    const rid = parseId(req.params.readingId, 'readingId');
    const row = (await query(`SELECT ${S.SQL.readingCols} FROM generation_readings r WHERE r.id=$1 AND r.installation_id=$2`, [rid, inst.id])).rows[0];
    if (!row) throw new ApiError(404, 'READING_NOT_FOUND', `Reading ${rid} does not exist for installation ${inst.id}.`);
    sendJson(req, res, S.reading(row), { lastModified: row.received_at });
  }))
  // Readings are append-only: no PUT/PATCH. Admin-only DELETE exists purely to retract erroneous data.
  .delete(requireScope('readings:delete'), ah(async (req, res) => {
    const inst = await loadInstallation(parseId(req.params.id));
    const rid = parseId(req.params.readingId, 'readingId');
    const del = await query('DELETE FROM generation_readings WHERE id=$1 AND installation_id=$2', [rid, inst.id]);
    if (!del.rowCount) throw new ApiError(404, 'READING_NOT_FOUND', `Reading ${rid} does not exist for installation ${inst.id}.`);
    res.status(204).end();
  }))
  .all(allow('GET', 'DELETE'));

module.exports = r;
