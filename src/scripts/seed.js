'use strict';
const { migrate } = require('../schema');
const { seed } = require('../seed');
const { pool } = require('../db');
const force = process.argv.includes('--force');
migrate().then(() => seed({ force })).then((did) => console.log(did ? 'Seeded.' : 'Database already has data (use "npm run reseed" to wipe and re-seed).'))
  .catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
