// Regenerates the OpenAPI snapshots (P9b): packages/contracts/openapi.json (the public API) and
// packages/contracts/openapi-owner.json (the owner API, `api-owner`). Both are functions of the Zod contracts and the
// path table of packages/contracts/src/openapi.ts, so a changed contract is an edit there and a run of this script.
//
//   node scripts/gen-openapi.ts            # rewrite both files
//   node scripts/gen-openapi.ts --check    # exit 1 if a committed file differs
//
// The files are JSON with the keys sorted at every depth, 2-space indent and a final newline. They hold schemas only:
// no data, no canary (the owner document has the owner source-id pattern, not a value).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ownerOpenApiDocument } from '../packages/contracts/src/api-owner.ts';
import { openApiDocument } from '../packages/contracts/src/openapi.ts';

const DIR = join(import.meta.dirname, '..', 'packages/contracts');
export const FILES = [
  { path: join(DIR, 'openapi.json'), build: openApiDocument },
  { path: join(DIR, 'openapi-owner.json'), build: ownerOpenApiDocument },
] as const;

/** `value` as the committed text: keys sorted recursively (arrays keep their order), 2 spaces, a final newline. */
export function canonical(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, x]) => [k, sort(x)]),
          )
        : v;
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    console.error('usage: node scripts/gen-openapi.ts [--check]');
    process.exit(64);
  }
  for (const f of FILES) {
    const text = canonical(f.build());
    if (args.length === 0) writeFileSync(f.path, text);
    else if (readFileSync(f.path, 'utf8') !== text) {
      console.error(`gen-openapi: ${f.path} is stale; run node scripts/gen-openapi.ts`);
      process.exitCode = 1;
    }
  }
}
