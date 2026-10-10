'use strict';
// Processing-style derived resources: aggregate generation across ALL installations of a district / province.
const express = require('express');
const { query } = require('../db');
const config = require('../config');
const { ApiError, ah, allow } = require('../utils/errors');
const { requireScope } = require('../middleware/auth');
const { sendJson } = require('../utils/http');
const { parseId } = require('../utils/params');
const scope = require('../utils/scope');
const { TZ_MS } = require('../sim/generator');

const r = express.Router();
const need = [requireScope('hierarchy:read'), requireScope('readings:read')];
const r3 = (v) => Math.round(v * 1000) / 1000;

async function summarise(level, id, name, provinceId) {
  const col = level === 'district' ? 'd.id' : 'd.province_id';
  const startOfToday = new Date(Math.floor((Date.now() + TZ_MS) / 86400000) * 86400000 - TZ_MS);
  const base = `SELECT i.id, i.substation_id, i.installed_capacity_kw FROM solar_installations i
                JOIN grid_substations s ON s.id = i.substation_id JOIN districts d ON d.id = s.district_id
                WHERE ${col} = $1 AND i.status <> 'decommissioned'`;
  const rows = (await query(
    `WITH inst AS (${base}),
     latest AS (SELECT DISTINCT ON (r.installation_id) r.installation_id, r.measured_at, r.power_kw, r.energy_kwh
                  FROM generation_readings r JOIN inst ON inst.id = r.installation_id ORDER BY r.installation_id, r.measured_at DESC),
     before_today AS (SELECT DISTINCT ON (r.installation_id) r.installation_id, r.energy_kwh
                  FROM generation_readings r JOIN inst ON inst.id = r.installation_id WHERE r.measured_at < $2
                  ORDER BY r.installation_id, r.measured_at DESC),
     first_today AS (SELECT r.installation_id, min(r.energy_kwh) AS energy_kwh
                  FROM generation_readings r JOIN inst ON inst.id = r.installation_id WHERE r.measured_at >= $2 GROUP BY r.installation_id)
     SELECT inst.id, inst.substation_id, inst.installed_capacity_kw, l.measured_at, l.power_kw,
            GREATEST(l.energy_kwh - COALESCE(b.energy_kwh, f.energy_kwh, l.energy_kwh), 0) AS today_energy_kwh
       FROM inst LEFT JOIN latest l ON l.installation_id = inst.id
                 LEFT JOIN before_today b ON b.installation_id = inst.id
                 LEFT JOIN first_today f ON f.installation_id = inst.id`, [id, startOfToday])).rows;
  const subs = (await query(
    `SELECT s.id, s.code, s.name FROM grid_substations s JOIN districts d ON d.id = s.district_id WHERE ${col} = $1 ORDER BY s.id`, [id])).rows;
  const peak = (await query(
    `SELECT r.measured_at, sum(r.power_kw) AS total FROM generation_readings r
       JOIN solar_installations i ON i.id = r.installation_id JOIN grid_substations s ON s.id = i.substation_id JOIN districts d ON d.id = s.district_id
      WHERE ${col} = $1 AND i.status <> 'decommissioned' AND r.measured_at >= $2
      GROUP BY r.measured_at ORDER BY total DESC, r.measured_at DESC LIMIT 1`, [id, startOfToday])).rows[0];

  const liveCut = Date.now() - config.staleAfterMinutes * 60000;
  const isLive = (x) => x.measured_at && new Date(x.measured_at).getTime() >= liveCut;
  const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);
  const live = rows.filter(isLive);
  const capacity = sum(rows, (x) => x.installed_capacity_kw);
  const currentPower = sum(live, (x) => x.power_kw);
  const lastAt = rows.reduce((m, x) => (x.measured_at && (!m || x.measured_at > m) ? x.measured_at : m), null);
  return {
    scope: { level, id, name, ...(level === 'district' ? { province_id: provinceId } : {}) },
    timezone: 'Asia/Colombo',
    as_of: lastAt ? new Date(lastAt).toISOString() : null,
    installations: { total: rows.length, reporting_live: live.length, not_reporting: rows.length - live.length },
    current: {
      total_power_kw: r3(currentPower),
      installed_capacity_kw: r3(capacity),
      capacity_utilisation_percent: capacity ? Math.round((currentPower / capacity) * 1000) / 10 : 0,
    },
    today: {
      since: startOfToday.toISOString(),
      total_energy_kwh: r3(sum(rows, (x) => x.today_energy_kwh)),
      peak_total_power_kw: peak ? r3(peak.total) : 0,
      peak_at: peak ? new Date(peak.measured_at).toISOString() : null,
    },
    by_grid_substation: subs.map((s) => {
      const mine = rows.filter((x) => x.substation_id === s.id);
      return {
        id: s.id, code: s.code, name: s.name, installations: mine.length,
        current_power_kw: r3(sum(mine.filter(isLive), (x) => x.power_kw)),
        today_energy_kwh: r3(sum(mine, (x) => x.today_energy_kwh)),
      };
    }),
  };
}

r.route('/districts/:id/generation-summary')
  .get(...need, ah(async (req, res) => {
    const id = parseId(req.params.id);
    const d = (await query('SELECT id, name, province_id FROM districts WHERE id = $1', [id])).rows[0];
    if (!d) throw new ApiError(404, 'DISTRICT_NOT_FOUND', `District ${id} does not exist.`);
    scope.assertInScope(req.auth, { province_id: d.province_id, district_id: d.id });
    const body = await summarise('district', d.id, d.name, d.province_id);
    sendJson(req, res, body, { lastModified: body.as_of || undefined });
  }))
  .all(allow('GET'));

r.route('/provinces/:id/generation-summary')
  .get(...need, ah(async (req, res) => {
    const id = parseId(req.params.id);
    const p = (await query('SELECT id, name FROM provinces WHERE id = $1', [id])).rows[0];
    if (!p) throw new ApiError(404, 'PROVINCE_NOT_FOUND', `Province ${id} does not exist.`);
    // A province summary aggregates the WHOLE province, so district users (who only see their district) are refused.
    if (!(scope.isNational(req.auth) || (req.auth.role === 'provincial' && req.auth.province_id === p.id))) throw scope.deny ? scope.deny() : new ApiError(403, 'OUT_OF_JURISDICTION', 'Not authorised.');
    const body = await summarise('province', p.id, p.name);
    sendJson(req, res, body, { lastModified: body.as_of || undefined });
  }))
  .all(allow('GET'));

module.exports = r;
