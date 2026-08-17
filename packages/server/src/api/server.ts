import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { registerRoutes } from './routes.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    // Behind a proxy in most deployments; trust its forwarding headers so
    // rate limiting keys on the real client rather than the proxy.
    trustProxy: true,
  });

  /**
   * Inbound rate limit. This is about protecting our own database and our
   * upstream budget: an uncapped /observations endpoint can trigger live
   * fetches to Rijkswaterstaat, so an abusive client would spend someone
   * else's quota. Health checks are exempt so a monitor never trips it.
   */
  await app.register(rateLimit, {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.windowMs,
    allowList: (request) => request.url.startsWith('/api/health'),
    // statusCode is required here: without it Fastify cannot tell what status
    // the thrown response carries and falls back to 500, which would tell a
    // throttled client to retry immediately instead of backing off. The
    // top-level message is what the shared error handler wraps into the
    // standard { error: { code, message } } envelope.
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      message: `Too many requests. Try again in ${Math.ceil(context.ttl / 1000)}s.`,
    }),
  });

  /**
   * CORS for third-party API consumers. The bundled client is served from this
   * same origin and does not need it; RWS itself sends no CORS headers, which
   * is a large part of why this API exists.
   */
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Access-Control-Allow-Origin', config.corsOrigin);
    reply.header('Vary', 'Origin');
  });

  await registerRoutes(app);

  // Serve the built client at the root when it is present, so a deployment is
  // one container and one origin. Registered after the API routes so /api
  // always wins.
  const webRoot = config.webRoot ? resolve(config.webRoot) : '';
  const serveClient = Boolean(webRoot) && existsSync(join(webRoot, 'index.html'));

  if (serveClient) {
    await app.register(fastifyStatic, { root: webRoot, index: ['index.html'] });
    app.log.info(`serving client from ${webRoot}`);
  }

  // One handler for both cases: unknown /api paths always keep the JSON error
  // envelope, while unknown non-API paths fall back to the client shell so
  // browser routing and deep links work.
  app.setNotFoundHandler((request, reply) => {
    if (serveClient && !request.url.startsWith('/api')) {
      return reply.sendFile('index.html');
    }
    return reply.status(404).send({
      error: { code: 'not_found', message: 'No such endpoint' },
    });
  });

  return app;
}
