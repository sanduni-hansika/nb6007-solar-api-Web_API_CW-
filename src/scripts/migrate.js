'use strict';
const { migrate } = require('../schema');
const { pool } = require('../db');
migrate().then(() => console.log('Schema is up to date.')).catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => pool.end());
