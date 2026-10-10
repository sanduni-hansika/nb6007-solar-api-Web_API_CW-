'use strict';
// Foreign-key-consistent seed: 9 provinces, 25 districts, 50 substations, 250 installations, ~168,000 readings
// (7 days x 96 readings/day per installation), plus demo users.
const bcrypt = require('bcryptjs');
const { query, tx } = require('./db');
const config = require('./config');
const { sha256, deviceSecretFor } = require('./utils/security');
const { unit } = require('./sim/generator');
const { catchUp } = require('./sim/simulator');

const GEO = [
  ['WP', 'Western', [['COL', 'Colombo', 6.9271, 79.8612], ['GAM', 'Gampaha', 7.0873, 79.9925], ['KAL', 'Kalutara', 6.5854, 79.9607]]],
  ['CP', 'Central', [['KAN', 'Kandy', 7.2906, 80.6337], ['MTL', 'Matale', 7.4675, 80.6234], ['NEL', 'Nuwara Eliya', 6.9497, 80.7891]]],
  ['SP', 'Southern', [['GAL', 'Galle', 6.0535, 80.221], ['MTR', 'Matara', 5.9549, 80.555], ['HAM', 'Hambantota', 6.1241, 81.1185]]],
  ['NP', 'Northern', [['JAF', 'Jaffna', 9.6615, 80.0255], ['KIL', 'Kilinochchi', 9.3803, 80.377], ['MAN', 'Mannar', 8.981, 79.9044], ['VAV', 'Vavuniya', 8.7514, 80.4971], ['MUL', 'Mullaitivu', 9.2671, 80.8142]]],
  ['EP', 'Eastern', [['BAT', 'Batticaloa', 7.731, 81.6747], ['AMP', 'Ampara', 7.2912, 81.6724], ['TRI', 'Trincomalee', 8.5874, 81.2152]]],
  ['NW', 'North Western', [['KUR', 'Kurunegala', 7.4863, 80.3647], ['PUT', 'Puttalam', 8.0408, 79.8394]]],
  ['NC', 'North Central', [['ANU', 'Anuradhapura', 8.3114, 80.4037], ['POL', 'Polonnaruwa', 7.9403, 81.0188]]],
  ['UV', 'Uva', [['BAD', 'Badulla', 6.9934, 81.055], ['MON', 'Monaragala', 6.8728, 81.3507]]],
  ['SG', 'Sabaragamuwa', [['RAT', 'Ratnapura', 6.7056, 80.3847], ['KEG', 'Kegalle', 7.2513, 80.3464]]],
];
const CAPACITIES = [3, 3.5, 4, 5, 5, 6, 8, 10, 12, 15, 25];
const slug = (s) => s.toLowerCase().replace(/\s+/g, '-');
const pad = (n, w) => String(n).padStart(w, '0');

async function isEmpty() {
  const { rows } = await query('SELECT (SELECT count(*) FROM provinces)::int AS n');
  return rows[0].n === 0;
}

async function seed({ force = false } = {}) {
  if (force) {
    await query('TRUNCATE generation_readings, solar_installations, grid_substations, users, districts, provinces RESTART IDENTITY CASCADE');
  } else if (!(await isEmpty())) {
    return false;
  }
  console.log('[seed] seeding hierarchy, installations and users ...');
  const demo = [];
  await tx(async (c) => {
    const passwordHash = await bcrypt.hash(config.seedPassword, 10);
    await c.query(`INSERT INTO users (email, password_hash, full_name, role) VALUES
      ('admin@slsea.example', $1, 'SLSEA System Administrator', 'admin'),
      ('national@slsea.example', $1, 'SLSEA National Analyst', 'national')`, [passwordHash]);
    let meterNo = 0;
    for (const [pcode, pname, districts] of GEO) {
      const p = (await c.query('INSERT INTO provinces (code, name) VALUES ($1,$2) RETURNING id', [pcode, pname])).rows[0];
      await c.query(`INSERT INTO users (email, password_hash, full_name, role, province_id) VALUES ($1,$2,$3,'provincial',$4)`,
        [`provincial.${slug(pname)}@slsea.example`, passwordHash, `${pname} Province Analyst`, p.id]);
      for (const [dcode, dname, lat, lon] of districts) {
        const d = (await c.query('INSERT INTO districts (province_id, code, name) VALUES ($1,$2,$3) RETURNING id', [p.id, dcode, dname])).rows[0];
        await c.query(`INSERT INTO users (email, password_hash, full_name, role, district_id) VALUES ($1,$2,$3,'district',$4)`,
          [`district.${slug(dname)}@slsea.example`, passwordHash, `${dname} District Operator`, d.id]);
        for (let sIdx = 1; sIdx <= 2; sIdx++) {
          const s = (await c.query(
            'INSERT INTO grid_substations (district_id, code, name, voltage_level_kv, capacity_mva) VALUES ($1,$2,$3,$4,$5) RETURNING id',
            [d.id, `GSS-${dcode}-${pad(sIdx, 2)}`, `${dname} Grid Substation ${sIdx === 1 ? 'A' : 'B'}`, 33, sIdx === 1 ? 31.5 : 63])).rows[0];
          for (let k = 1; k <= 5; k++) {
            meterNo += 1;
            const meterId = `SLSEA-MTR-${pad(meterNo, 4)}`;
            const cap = CAPACITIES[Math.floor(unit('cap', meterNo) * CAPACITIES.length)];
            const lat2 = (lat + (unit('lat', meterNo) - 0.5) * 0.12).toFixed(6);
            const lon2 = (lon + (unit('lon', meterNo) - 0.5) * 0.12).toFixed(6);
            const year = 2021 + Math.floor(unit('yr', meterNo) * 5);
            const month = 1 + Math.floor(unit('mo', meterNo) * 12);
            await c.query(
              `INSERT INTO solar_installations (substation_id, meter_id, site_name, installed_capacity_kw, latitude, longitude, status, commissioned_on, device_secret_hash)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [s.id, meterId, `Rooftop Solar Site ${pad(meterNo, 4)} - ${dname}`, cap, lat2, lon2,
                'active', `${year}-${pad(month, 2)}-15`, sha256(deviceSecretFor(meterId))]);
            if (meterNo <= 3) demo.push({ meter_id: meterId, device_secret: deviceSecretFor(meterId) });
          }
        }
      }
    }
  });
  console.log('[seed] generating 7 days of readings ...');
  const n = await catchUp();
  // a few sites go into maintenance AFTER their history exists: they keep history but stop reporting (stale demo)
  await query("UPDATE solar_installations SET status = 'maintenance' WHERE meter_id IN ('SLSEA-MTR-0053','SLSEA-MTR-0106','SLSEA-MTR-0159','SLSEA-MTR-0212')");
  console.log(`[seed] done: ${n} readings.`);
  console.log('[seed] demo users (password = SEED_PASSWORD): admin@slsea.example, national@slsea.example, provincial.western@slsea.example, district.colombo@slsea.example, ...');
  console.log('[seed] demo devices:', JSON.stringify(demo));
  return true;
}

module.exports = { seed };
