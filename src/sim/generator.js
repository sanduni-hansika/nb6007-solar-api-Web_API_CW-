'use strict';
// Deterministic, realistic solar generation model (diurnal bell curve, regional weather, noise).
// Used by BOTH the seeder (history) and the live simulator (new readings every 15 minutes).
const config = require('../config');

const SLOT_MS = config.slotMinutes * 60 * 1000;
const TZ_MS = config.tzOffsetMinutes * 60 * 1000;
const floorSlot = (ms) => Math.floor(ms / SLOT_MS) * SLOT_MS;

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/** Deterministic pseudo-random number in [0,1) from any list of parts (mulberry32 on a hash). */
function unit(...parts) {
  let a = (hash32(parts.join('|')) + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/** One sample (power, voltage, temperature) for an installation at an instant. */
function sample(inst, tsMs) {
  const local = tsMs + TZ_MS;
  const day = Math.floor(local / 86400000);
  const hour = ((local % 86400000) + 86400000) % 86400000 / 3600000; // local hour 0..24
  let clear = 0;
  if (hour > 6.0 && hour < 18.2) clear = Math.pow(Math.sin((Math.PI * (hour - 6.0)) / 12.2), 1.4);
  const weatherDay = 0.5 + 0.5 * unit('wd', inst.district_id, day);
  const cloud = 0.78 + 0.22 * unit('cl', inst.district_id, day, Math.floor(hour * 2));
  const noise = 0.95 + 0.1 * unit('n', inst.id, tsMs);
  const eff = 0.78 + 0.1 * unit('eff', inst.id);
  const power = clear === 0 ? 0 : inst.capacity * clear * weatherDay * cloud * noise * eff;
  const util = inst.capacity ? power / inst.capacity : 0;
  const voltage = 228 + 4 * unit('v', inst.id) + 4 * util + (unit('vn', inst.id, tsMs) - 0.5) * 3;
  const temp = 26 + 6 * clear + 18 * util + (unit('t', inst.id, tsMs) - 0.5) * 2;
  return { power_kw: round(power, 3), voltage_v: round(voltage, 2), temperature_c: round(temp, 1) };
}

/** Starting meter register for a brand-new installation (kWh produced since commissioning). */
function baseEnergy(inst, windowStartMs) {
  const days = Math.max(0, (windowStartMs - new Date(inst.commissioned_on).getTime()) / 86400000);
  return round(inst.capacity * 4.2 * 0.8 * days * (0.9 + 0.2 * unit('e0', inst.id)), 3);
}

/** Generate readings for slots startMs..endMs (inclusive, both slot-aligned) with a running cumulative register. */
function* generateSlots(inst, startMs, endMs, startEnergy) {
  let energy = startEnergy;
  for (let t = startMs; t <= endMs; t += SLOT_MS) {
    const s = sample(inst, t);
    energy = round(energy + s.power_kw * (config.slotMinutes / 60), 3);
    yield { measured_at: new Date(t).toISOString(), ...s, energy_kwh: energy };
  }
}

module.exports = { SLOT_MS, TZ_MS, floorSlot, sample, baseEnergy, generateSlots, unit, round };
