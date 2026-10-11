import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { GATED } from '../packages/contracts/src/registry.ts';
import { generate, METHOD_FILE } from '../scripts/gen-web-method.ts';

// P10b plan C7: the Method page's crosswalk file holds public, ungated rows only. An owner source, a permission
// source or their agencies in it would put them in the public bundle.
const root = join(import.meta.dirname, '..');
/** The gated sources (catalogue §0.2) that are not public in the registry, and their agencies (P12b, A20: derived). */
const sources = (
  parse(readFileSync(join(root, 'registry/sources.yaml'), 'utf8')) as { sources: { id: string; audience: string }[] }
).sources;
const BANNED = [
  ...[...GATED].filter((id) => sources.find((s) => s.id === id)?.audience !== 'public'),
  'SPW',
  'HIC',
  'NLWKN',
];

describe('gen-web-method', () => {
  it('the committed file is the generated one', () => {
    expect(readFileSync(join(root, METHOD_FILE), 'utf8')).toBe(generate(root));
  }, 30_000);

  it('names no owner or permission source and none of their agencies', () => {
    expect(BANNED).toEqual(expect.arrayContaining(['BE-1', 'BE-3', 'DE-3', 'DE-9', 'DE-12', 'LU-4']));
    const file = readFileSync(join(root, METHOD_FILE), 'utf8');
    for (const word of BANNED) expect(file, word).not.toMatch(new RegExp(`(?<![\\w-])${word}(?![\\w-])`));
    // and never the free text of a row (flag, convention)
    expect(file).not.toMatch(/\bflag\b|\bconvention\b/);
  });
});
