import 'dotenv/config';
import { buildServer } from './api/server.js';
import { config } from './config.js';
import { closePool } from './db/pool.js';

const app = await buildServer();

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    app.log.info(`${signal} received, shutting down`);
    await app.close();
    await closePool();
    process.exit(0);
  });
}
