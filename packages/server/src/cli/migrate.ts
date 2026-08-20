#!/usr/bin/env node
import '../env.js';
import { closePool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { syncSources } from '../db/sources.js';

try {
  const result = await migrate();

  // The registry in src/sources/registry.ts is the source of truth for which
  // sources exist; this projects it into the table the foreign keys point at,
  // so adding a source is a code change rather than a code change plus a
  // migration.
  const sources = await syncSources();
  console.log(`Synced ${sources} source(s) from the registry.`);

  if (result.applied.length === 0) {
    console.log(`Nothing to apply; ${result.skipped.length} migration(s) already applied.`);
  } else {
    console.log(`Applied ${result.applied.length} migration(s): ${result.applied.join(', ')}`);
  }
} catch (err) {
  console.error(`Migration failed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
