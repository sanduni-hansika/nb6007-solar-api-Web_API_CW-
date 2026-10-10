'use strict';
const config = require('./config');
const { migrate } = require('./schema');
const { seed } = require('./seed');
const { startSimulator } = require('./sim/simulator');
const { pool } = require('./db');
const { createApp } = require('./app');

async function main() {
  await migrate();
  console.log('[boot] schema ready');
  const app = createApp();
  const server = app.listen(config.port, () => console.log(`[boot] listening on port ${config.port} (${config.isProd ? 'production' : 'development'})`));
  // Seed + live simulator run AFTER the port is open, so the host sees a healthy service quickly.
  (async () => {
    try {
      if (config.autoSeed) await seed();
      if (config.simulator) startSimulator();
    } catch (e) {
      console.error('[boot] seed/simulator failed:', e);
    }
  })();
  const shutdown = () => { server.close(() => pool.end().finally(() => process.exit(0))); setTimeout(() => process.exit(1), 10000).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
main().catch((e) => { console.error('[boot] fatal:', e); process.exit(1); });
