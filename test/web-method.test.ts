import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generate, METHOD_FILE } from '../scripts/gen-web-method.ts';

// P10b plan C7: the Method page's crosswalk file holds public, ungated rows only. An owner source, a permission
// source or their agencies in it would put them in the public bundle.
const root = join(import.meta.dirname, '..');
const BANNED = [
  'BE-3',
  'LU-2',
  'LU-3',
  'LU-4',
  'DE-2',
  'DE-3',
  'DE-9',
  'DE-10',
  'DE-12',
  'DE-13',
  'BE-1',
  'BE-2',
  'SPW',
  'HIC',
  'NLWKN',
];

describe('gen-web-method', () => {
  it('the committed file is the generated one', () => {
    expect(readFileSync(join(root, METHOD_FILE), 'utf8')).toBe(generate(root));
  }, 30_000);

  it('names no owner or permission source and none of their agencies', () => {
    const file = readFileSync(join(root, METHOD_FILE), 'utf8');
    for (const word of BANNED) expect(file, word).not.toMatch(new RegExp(`(?<![\\w-])${word}(?![\\w-])`));
    // and never the free text of a row (flag, convention)
    expect(file).not.toMatch(/\bflag\b|\bconvention\b/);
  });
});
