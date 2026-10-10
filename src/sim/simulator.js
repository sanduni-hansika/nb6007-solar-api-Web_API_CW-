'use strict';
// "Live data": every 15-minute slot each ACTIVE installation reports one reading, exactly like a real smart meter.
// catchUp() also back-fills any gap (e.g. free hosting that sleeps), so last-known-reading is always current.
const { query } = require('../db');
const config = require('../config');
const { SLOT_MS, floorSlot, baseEnergy, generateSlots } = require('./generator');

const HISTORY_DAYS = 7;
const CHUNK = 20000;
let running = false;
let lastSlotDone = 0;

async function insertRows(rows) {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    await query(
      `INSERT INTO generation_readings (installation_id, measured_at, power_kw, energy_kwh, voltage_v, temperature_c)
       SELECT * FROM unnest($1::int[], $2::timestamptz[], $3::numeric[], $4::numeric[], $5::numeric[], $6::numeric[])
       ON CONFLICT (installation_id, measured_at) DO NOTHING`,
      [part.map((r) => r.id), part.map((r) => r.measured_at), part.map((r) => r.power_kw), part.map((r) => r.energy_kwh), part.map((r) => r.voltage_v), part.map((r) => r.temperature_c)]);
  }
}

/** Fill every active installation up to the current 15-minute slot. Returns number of rows generated. */
async function catchUp() {
  const nowSlot = floorSlot(Date.now());
  const windowStart = nowSlot - (HISTORY_DAYS * 24 * 60 / config.slotMinutes - 1) * SLOT_MS;
  const { rows: insts } = await query(
    `SELECT i.id, i.installed_capacity_kw AS capacity, i.commissioned_on, s.district_id, l.measured_at AS last_at, l.energy_kwh AS last_energy
       FROM solar_installations i
       JOIN grid_substations s ON s.id = i.substation_id
       LEFT JOIN LATERAL (SELECT measured_at, energy_kwh FROM generation_readings r WHERE r.installation_id = i.id ORDER BY measured_at DESC LIMIT 1) l ON TRUE
      WHERE i.status = 'active'`);
  const out = [];
  for (const inst of insts) {
    let start = inst.last_at ? floorSlot(new Date(inst.last_at).getTime()) + SLOT_MS : windowStart;
    if (start < windowStart) start = windowStart;
    if (start > nowSlot) continue;
    const startEnergy = inst.last_energy != null && inst.last_at ? inst.last_energy : baseEnergy(inst, windowStart);
    for (const r of generateSlots(inst, start, nowSlot, startEnergy)) out.push({ id: inst.id, ...r });
  }
  if (out.length) await insertRows(out);
  lastSlotDone = nowSlot;
  return out.length;
}

async function purgeOld() {
  const { rowCount } = await query(`DELETE FROM generation_readings WHERE measured_at < now() - ($1 || ' days')::interval`, [String(config.retentionDays)]);
  return rowCount;
}

async function tick() {
  if (running || floorSlot(Date.now()) <= lastSlotDone) return;
  running = true;
  try {
    const n = await catchUp();
    if (n) console.log(`[simulator] generated ${n} new reading(s)`);
  } catch (e) {
    console.error('[simulator] failed:', e.message);
  } finally {
    running = false;
  }
}

function startSimulator() {
  tick();
  setInterval(tick, 30 * 1000).unref();
  purgeOld().then((n) => n && console.log(`[retention] removed ${n} old readings`)).catch(() => {});
  setInterval(() => purgeOld().catch(() => {}), 6 * 3600 * 1000).unref();
}

module.exports = { catchUp, startSimulator, purgeOld };
