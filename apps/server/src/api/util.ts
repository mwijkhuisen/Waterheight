import type { Kysely } from 'kysely';
import type { z } from 'zod';
import type { DB } from '../db/generated.ts';

// Helpers shared by the routes of the api role.

/** One read-only repeatable-read snapshot of the views, so the pieces of an answer belong together. */
export const snapshot = <T>(db: Kysely<DB>, read: (tx: Kysely<DB>) => Promise<T>): Promise<T> =>
  db.transaction().setAccessMode('read only').setIsolationLevel('repeatable read').execute(read);

/** An error that carries only a fixed code, which is all the log ever sees. */
export const coded = (code: string) => Object.assign(new Error(code), { code });

/** What is about to be sent must match the contract: a shape bug is a 503 here, never a silent leak. */
export function validated<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw coded('contract');
  return r.data;
}

/** An instant in UTC ISO 8601; null stays null. */
export function iso(d: Date): string;
export function iso(d: Date | null): string | null;
export function iso(d: Date | null): string | null {
  return d?.toISOString() ?? null;
}
