import 'dotenv/config';
import { buildServer } from './api/server.js';
import { startSchedules } from './backfill/schedule.js';
import { config } from './config.js';
import { closePool } from './db/pool.js';

const app = await buildServer();

// Opt-in so that running several API instances does not mean several copies of
// the same refresh hitting Rijkswaterstaat. Enable it on exactly one.
const stopSchedules = config.enableSchedules
  ? startSchedules({ log: (msg) => app.log.info(msg) })
  : () => {};

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    stopSchedules();
    await app.close();
    await closePool();
    process.exit(0);
  });
}
