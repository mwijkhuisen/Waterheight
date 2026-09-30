import { readFileSync } from 'node:fs';
import pg from 'pg';

// Prepares a throw-away database the way production does, for the dbmate round
// trip and the drift checks (scripts/db-check.sh): the roles of
// deploy/postgres/roles.sql, a database owned by rws_owner, and a throw-away
// password for rws_migrator. Prints the migrator's DATABASE_URL.
//
//   DATABASE_URL=<superuser of a local PostgreSQL 18> node apps/server/test/db/prepare.ts <database>

const admin = new URL(process.env.DATABASE_URL ?? '');
const name = process.argv[2] ?? '';
if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(admin.hostname) || !/^rws_[a-z0-9_]{1,40}$/.test(name)) {
  console.error('db-prepare: needs a local DATABASE_URL and a database name like rws_check');
  process.exit(2);
}
const PASSWORD = 'db-check-only';
const connect = async (database: string) => {
  const client = new pg.Client({
    host: admin.hostname,
    port: Number(admin.port || 5432),
    database,
    user: decodeURIComponent(admin.username),
    ...(admin.password === '' ? {} : { password: decodeURIComponent(admin.password) }),
  });
  await client.connect();
  return client;
};

const root = await connect(admin.pathname.slice(1));
await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
await root.query(`CREATE DATABASE ${name}`);
await root.end();
const db = await connect(name);
await db.query(readFileSync(new URL('../../../../deploy/postgres/roles.sql', import.meta.url), 'utf8'));
await db.query(`ALTER ROLE rws_migrator PASSWORD '${PASSWORD}'`);
await db.end();
console.log(`postgres://rws_migrator:${PASSWORD}@${admin.hostname}:${admin.port || 5432}/${name}?sslmode=disable`);
