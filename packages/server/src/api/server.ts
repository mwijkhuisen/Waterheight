import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { registerRoutes } from './routes.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    // Behind a proxy in most deployments; trust its forwarding headers.
    trustProxy: true,
  });

  // The browser calls this API directly from the map, which is the whole
  // reason it exists -- RWS itself sends no CORS headers.
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
  });

  await registerRoutes(app);
  return app;
}
