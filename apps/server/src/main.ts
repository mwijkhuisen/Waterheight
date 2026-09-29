import { serve } from '@hono/node-server';
import { createApp } from './app.ts';

/** Roles of the single server image (A§4); the command picks one. */
export const ROLES = ['capture', 'load', 'publish', 'api', 'replay', 'watchdog'] as const;
export type Role = (typeof ROLES)[number];

export const EXIT_NOT_IMPLEMENTED = 2;
export const EXIT_USAGE = 64;

const USAGE = `usage: main.js <${ROLES.join('|')}>`;

export type Listen = { hostname: string; port: number };

/** HOST and PORT come from the environment; anything malformed is a usage error. */
export function parseListen(env: Readonly<Record<string, string | undefined>>): Listen | string {
  const hostname = env.HOST ?? '127.0.0.1';
  const rawPort = env.PORT ?? '8080';
  if (hostname === '') return 'HOST must not be empty';
  const port = /^[0-9]{1,5}$/.test(rawPort) ? Number(rawPort) : Number.NaN;
  if (!(port >= 1 && port <= 65535)) return `PORT must be an integer from 1 to 65535, got ${JSON.stringify(rawPort)}`;
  return { hostname, port };
}

/**
 * Resolves with an exit code, except for `api`, which keeps serving until
 * SIGINT or SIGTERM. Every role but `api` is a stub until its phase (P1+).
 */
export function run(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void = (line) => console.error(line),
): Promise<number> {
  const [role, ...rest] = argv;
  if (role === undefined || rest.length > 0 || !(ROLES as readonly string[]).includes(role)) {
    log(USAGE);
    return Promise.resolve(EXIT_USAGE);
  }
  if (role !== 'api') {
    log(`role ${role} is not implemented yet`);
    return Promise.resolve(EXIT_NOT_IMPLEMENTED);
  }
  const listen = parseListen(env);
  if (typeof listen === 'string') {
    log(listen);
    return Promise.resolve(EXIT_USAGE);
  }
  return new Promise((resolve) => {
    const server = serve({ fetch: createApp().fetch, ...listen }, (info) => {
      log(`api listening on ${info.address}:${info.port}`);
    });
    const stop = () => server.close(() => resolve(0));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

if (import.meta.main) {
  process.exitCode = await run(process.argv.slice(2), process.env);
}
