'use strict';
const { Pool, types } = require('pg');
const config = require('./config');

// pg returns NUMERIC/BIGINT as strings by default. Convert so JSON contains real numbers.
types.setTypeParser(1700, (v) => parseFloat(v)); // NUMERIC
types.setTypeParser(20, (v) => parseInt(v, 10)); // BIGINT
types.setTypeParser(1082, (v) => v); // DATE stays 'YYYY-MM-DD'

function buildPoolConfig() {
  const url = new URL(config.databaseUrl);
  const sslmode = url.searchParams.get('sslmode');
  url.searchParams.delete('sslmode');
  url.searchParams.delete('channel_binding');
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  let useSsl;
  if (config.databaseSsl !== undefined && config.databaseSsl !== '') useSsl = config.databaseSsl === 'true';
  else useSsl = (sslmode && sslmode !== 'disable') || (!local && config.isProd);
  return {
    connectionString: url.toString(),
    ssl: useSsl ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
  };
}

const pool = new Pool(buildPoolConfig());
pool.on('error', (err) => console.error('[db] idle client error:', err.message));

const query = (text, params) => pool.query(text, params);

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, tx };
