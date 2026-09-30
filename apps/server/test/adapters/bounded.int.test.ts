import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BODIES } from './bounded-child.ts';

// Review S1: no DE-1 payload inside the byte caps can run the loader out of
// memory on its way to a SchemaDrift. Each hostile body is parsed in its own
// process with a 256 MiB heap (the load container has 768 MiB). In the
// integration project, which runs one file at a time: these children are heavy,
// and the unit project has timing tests.

const child = fileURLToPath(new URL('./bounded-child.ts', import.meta.url));
const expected: Record<keyof typeof BODIES, string> = {
  'series-zeros': 'json_too_many_nodes',
  'basin-2m': 'json_too_many_nodes',
  'basin-bytes': 'json_too_many_nodes',
  'series-bytes': 'json_too_many_nodes',
  'meta-bytes': 'json_too_many_nodes',
  'basin-issues': 'invalid_type at 0.timeseries.0.shortname',
  'meta-issues': 'invalid_type at 0.timeseries.0.shortname',
  'series-issues': 'invalid_type at 0.timestamp',
};

describe('bounded parsing: every hostile body ends in a SchemaDrift, not a crash', () => {
  it.each(Object.keys(expected))('%s, under a 256 MiB heap', (name) => {
    const run = spawnSync(process.execPath, ['--max-old-space-size=256', '--no-experimental-webstorage', child, name], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect([name, run.status, run.stdout.trim()]).toEqual([name, 0, expected[name]]);
  });
});
