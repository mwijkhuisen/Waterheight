import { SchemaDrift } from '@rws/core';

// A leaf module (P14b review C3): the provider files import it, and provider.ts imports them, so it cannot live there.

/** A SchemaDrift's code as the run prints it: a fixed code, or `other` should one ever carry anything else. */
export const driftCode = (err: unknown): string =>
  err instanceof SchemaDrift && /^[a-z0-9_]{1,40}$/.test(err.code) ? err.code : 'other';
