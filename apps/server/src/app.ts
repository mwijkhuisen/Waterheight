import { Hono } from 'hono';

/**
 * The HTTP app of the `api` role. `/healthz` is a liveness probe only: it
 * reports no version, host or build data (A§12.2).
 */
export function createApp(): Hono {
  const app = new Hono();
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  return app;
}
