import {
  type CompiledQuery,
  type DatabaseConnection,
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import type { DB } from '../../src/db/generated.ts';

/**
 * A Kysely without a database: every statement is answered by `answer` (rows,
 * a rejection, or a promise that waits). Transactions are no-ops.
 */
export function fakeDb(answer: (query: CompiledQuery) => Promise<{ rows: unknown[] }>): Kysely<DB> {
  const connection = { executeQuery: answer } as unknown as DatabaseConnection;
  const driver = Object.assign(new DummyDriver(), { acquireConnection: async () => connection });
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}
