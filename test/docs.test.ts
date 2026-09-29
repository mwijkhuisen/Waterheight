import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './catalogue.ts';

const read = (path: string) => readFileSync(`${repoRoot}${path}`, 'utf8');

function between(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  const j = text.indexOf(end, i + start.length);
  if (i < 0 || j < 0) throw new Error(`markers not found: ${start} … ${end}`);
  return text.slice(i + start.length, j).trim();
}

/** A§12.1 as ARCHITECTURE.md writes it: the numbered list under the heading. */
const architectureInvariants = (architecture: string) =>
  between(architecture, '### 12.1 Invariants (verbatim in `CLAUDE.md`, quoted in every prompt)\n', '\n### 12.2');
const claudeInvariants = (claude: string) => between(claude, '<!-- invariants:start -->', '<!-- invariants:end -->');
/** The check itself: CLAUDE.md quotes A§12.1 byte for byte. */
const quotesInvariants = (claude: string, architecture: string) =>
  Buffer.from(claudeInvariants(claude)).equals(Buffer.from(architectureInvariants(architecture)));

describe('CLAUDE.md', () => {
  const architecture = read('docs/plan/ARCHITECTURE.md');
  const claude = read('CLAUDE.md');
  const expected = architectureInvariants(architecture);
  const actual = claudeInvariants(claude);

  it('quotes invariants 1–11 of ARCHITECTURE §12.1 byte for byte', () => {
    expect(expected.split('\n').map((l) => l.split('.')[0])).toEqual(
      Array.from({ length: 11 }, (_, i) => String(i + 1)),
    );
    expect(quotesInvariants(claude, architecture)).toBe(true);
    expect(actual).toBe(expected);
  });

  it('includes invariant 11 with the owner canary', () => {
    expect(actual).toMatch(/^11\. \*\*Owner-audience data never reaches a public output\.\*\*/m);
    expect(actual).toContain('`777777.777`');
  });

  it.each([
    ['one changed character', (s: string) => s.replace('never shared', 'Never shared')],
    ['one dropped character', (s: string) => s.replace('`777777.777`', '`77777.777`')],
    ['a trailing space', (s: string) => s.replace('never shared.', 'never shared. ')],
  ])('fails on a CLAUDE.md with %s in the invariants', (_, mutate) => {
    const inside = claude.indexOf('<!-- invariants:start -->');
    const mutated = claude.slice(0, inside) + mutate(claude.slice(inside));
    expect(mutated).not.toBe(claude);
    expect(quotesInvariants(mutated, architecture)).toBe(false);
  });

  it.each([
    ['fresh-start rule', /Never open, read, copy or restore the content of a legacy file/],
    ['audience rules', /## Audience rules/],
    ['owner view never shared', /used by the owner alone and is never shared/],
    ['synthetic owner fixtures', /Fixtures of owner-audience sources are synthetic/],
    ['adapter contract', /## Adapter contract/],
    ['criterion tags', /\*\*\[CI\]\*\*.*\*\*\[agent-prod\]\*\*.*\*\*\[owner\]\*\*/],
    ['ADR-lite rule', /ADR-lite rule/],
    ['release-age override', /Release-age override for an urgent security fix/],
    ['TS 7 forbidden', /TypeScript 7 is forbidden/],
    ['MapLibre 6', /MapLibre GL JS 6\*\* is ESM-only and WebGL2-only, and `map\.transform` is removed/],
    ['PG18 image layout', /\/var\/lib\/postgresql\/18\/docker/],
    ['Vitest 5 defaults', /`clearMocks` defaults to true, and an unawaited async assertion fails/],
    ['Node 26 rules', /native `Temporal`.*type stripping/],
    ['corepack', /corepack is not bundled/],
    ['Protomaps', /Protomaps\*\* builds are kept for one week/],
    ['Hub’Eau v1', /Hub'Eau v1\*\* answers 403/],
    ['RWS CTD', /moves to the CTD on 2026-11-05/],
  ])('covers the %s', (_, pattern) => {
    expect(read('CLAUDE.md')).toMatch(pattern);
  });
});
