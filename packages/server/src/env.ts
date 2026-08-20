/**
 * Loads the `.env` file for every entry point, from the repository root
 * rather than from the current working directory.
 *
 * `dotenv/config` resolves `.env` against `process.cwd()`. Under Docker that
 * never mattered -- compose injects real environment variables and no `.env`
 * is present in the image. Outside Docker it does: `npm run migrate` and
 * friends run their script with the cwd set to `packages/server`, so the
 * `.env` at the repository root was silently ignored and the configuration
 * fell back to its defaults. A wrong database URL that fails to connect is
 * merely confusing; one that connects to the wrong database is worse.
 *
 * So the file is located relative to this module instead: walk up from wherever
 * it was loaded from (`src/` under tsx, `dist/` once built) until a `.env`
 * turns up. `ENV_FILE` overrides the search outright, which is what the systemd
 * unit uses.
 *
 * Real environment variables always win -- dotenv does not overwrite them --
 * so `Environment=` in a unit file, a `docker compose` environment block and an
 * exported shell variable all still take precedence over the file.
 */

import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

/** Walks up from `start` looking for a `.env`, returning the first hit. */
function findEnvFile(start: string): string | undefined {
  const { root } = parse(start);
  let dir = start;

  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    if (dir === root) return undefined;
    dir = dirname(dir);
  }
}

const explicit = process.env['ENV_FILE'];
const envFile = explicit ?? findEnvFile(dirname(fileURLToPath(import.meta.url)));

if (explicit !== undefined && !existsSync(explicit)) {
  // An explicit path that is not there is a deployment mistake, not a default.
  throw new Error(`ENV_FILE points at ${explicit}, which does not exist`);
}

if (envFile !== undefined) loadDotenv({ path: envFile });

/** The `.env` actually loaded, if any. Reported by the CLIs so it is visible. */
export const loadedEnvFile = envFile;
