#!/usr/bin/env node
import 'dotenv/config';
import { closePool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';

try {
  const result = await migrate();
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
