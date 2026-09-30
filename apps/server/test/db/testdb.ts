import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

// A real PostgreSQL 18 per test file (ADR-0015): a fresh database with the
// production roles (deploy/postgres/roles.sql) and the real migrations, applied
// by a real rws_migrator login. DATABASE_URL names a superuser of a throw-away
// cluster (the SessionStart hook's, CI's service container or a local one).

const ROOT = new URL('../../../../', import.meta.url);
export const MIGRATIONS_DIR = fileURLToPath(new URL('db/migrations/', ROOT));
const ROLES_SQL = readFileSync(new URL('deploy/postgres/roles.sql', ROOT), 'utf8');

export const LOGIN_ROLES = ['rws_migrator', 'rws_load', 'rws_publish', 'rws_api', 'rws_owner_api'] as const;
export type LoginRole = (typeof LOGIN_ROLES)[number];

/** Throw-away passwords of the test cluster: the roles have no usable password anywhere else. */
export const testPassword = (role: string) => `it-${role}`;

function adminUrl(): URL {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is not set: test:integration needs a real PostgreSQL 18');
  return new URL(raw);
}

export type TestDb = {
  name: string;
  /** A superuser session on the test database (seeding and catalogue queries). */
  admin: pg.Client;
  /** A real login as `role` (scram-sha-256), so the role's own settings apply. */
  connectAs: (role: LoginRole) => Promise<pg.Client>;
  /** `DATABASE_URL` for `role`, for code that opens its own pool. */
  urlFor: (role: LoginRole) => string;
  drop: () => Promise<void>;
};

/** The `-- migrate:up` part of every migration, in order. */
export function upMigrations(dir = MIGRATIONS_DIR): { file: string; sql: string }[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((file) => {
      const text = readFileSync(`${dir}/${file}`, 'utf8');
      const up = text.indexOf('-- migrate:up');
      const down = text.indexOf('-- migrate:down');
      if (up < 0 || down < up) throw new Error(`${file}: no migrate:up / migrate:down markers`);
      return { file, sql: text.slice(up, down) };
    });
}

export async function createTestDb(opts: { migrate?: boolean } = {}): Promise<TestDb> {
  const base = adminUrl();
  const name = `rws_it_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
  const connect = async (database: string, user?: string, password?: string) => {
    const client = new pg.Client({
      host: base.hostname,
      port: Number(base.port || 5432),
      database,
      user: user ?? decodeURIComponent(base.username),
      password: password ?? (base.password === '' ? undefined : decodeURIComponent(base.password)),
    });
    await client.connect();
    return client;
  };

  const root = await connect(base.pathname.slice(1));
  await root.query(`CREATE DATABASE ${name}`);
  await root.end();

  const admin = await connect(name);
  const clients: pg.Client[] = [admin];
  await admin.query(ROLES_SQL);
  // roles.sql makes UTC the database default for new sessions; this one predates it.
  await admin.query("SET TIME ZONE 'UTC'");
  for (const role of LOGIN_ROLES) await admin.query(`ALTER ROLE ${role} PASSWORD '${testPassword(role)}'`);

  const connectAs = async (role: LoginRole) => {
    const client = await connect(name, role, testPassword(role));
    clients.push(client);
    return client;
  };
  const urlFor = (role: LoginRole) =>
    `postgres://${role}:${testPassword(role)}@${base.hostname}:${base.port || 5432}/${name}?sslmode=disable`;

  if (opts.migrate !== false) {
    // As production does: rws_migrator logs in and acts as rws_owner.
    const migrator = await connectAs('rws_migrator');
    for (const { sql } of upMigrations()) await migrator.query(sql);
    await migrator.end();
  }

  return {
    name,
    admin,
    connectAs,
    urlFor,
    async drop() {
      await Promise.allSettled(clients.map((c) => c.end()));
      const again = await connect(base.pathname.slice(1));
      await again.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await again.end();
    },
  };
}

/** The SQLSTATE of a failing statement, or 'ok'. */
export async function sqlState(client: pg.Client, text: string, values: unknown[] = []): Promise<string> {
  try {
    await client.query(text, values);
    return 'ok';
  } catch (err) {
    return String((err as { code?: unknown }).code ?? 'unknown');
  }
}
