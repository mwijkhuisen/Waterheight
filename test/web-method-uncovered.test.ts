import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { generateUncovered, METHOD_FILE, UNCOVERED_FILE, uncoveredBoards } from '../scripts/gen-web-method.ts';

// P19b (D32): the Method page's table of off water boards follows the registry, not code. uncoveredBoards is pure, so a
// temp root (no Biome) exercises it; the real registry checks the committed set and the committed file.
const root = join(import.meta.dirname, '..');
const sources = (parse(readFileSync(join(root, 'registry/sources.yaml'), 'utf8')) as { sources: S[] }).sources;
interface S {
  id: string;
  audience: string;
}

const row = (id: string, o: Record<string, unknown> = {}) => ({
  id,
  name: `Name ${id}`,
  source: 'NL-1',
  role: 'primary',
  audience: 'public',
  licence_gate: 'open',
  ...o,
});

function mk(over: { entries?: unknown[]; sources?: unknown[]; rows?: unknown[]; cell?: string } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'uncov-'));
  for (const p of ['docs/sources', 'registry/stations']) mkdirSync(join(d, p), { recursive: true });
  writeFileSync(
    join(d, 'docs/sources/SOURCE-CATALOGUE.md'),
    [
      '## 2. Other',
      '### 2.8 Dutch water boards',
      '| ID | Board | Website | Contact | Rivers | Terms |',
      '|---|---|---|---|---|---|',
      `| NL-7 (C16) | Limburg | w | c | ${over.cell ?? 'Roer, Geul (UNVERIFIED, R17)'} | contact@example.org |`,
      '| NL-99 (C99) | Test | w | c | Beek | n |',
      '### 2.9 Next',
      '| NL-55 (C55) | Never read | w | c | Beek | n |',
    ].join('\n'),
  );
  writeFileSync(
    join(d, 'registry/sources.yaml'),
    stringify({
      sources: over.sources ?? [
        { id: 'NL-1', provider: 'rws', audience: 'public' },
        { id: 'BE-3', provider: 'be', audience: 'owner' },
        { id: 'NL-7', provider: 'ws7', audience: 'off' },
        { id: 'NL-99', provider: 'ws99', audience: 'off' },
      ],
    }),
  );
  writeFileSync(
    join(d, 'registry/providers.yaml'),
    stringify({
      providers: [
        { id: 'ws7', name: 'Waterschap Zeven' },
        { id: 'ws99', name: 'Waterschap Negenennegentig' },
      ],
    }),
  );
  const e7 = { source: 'NL-7', rivers: { nl: ['Roer', 'Geul'], en: ['Roer', 'Geul'] }, gauges: ['g.ok'] };
  writeFileSync(join(d, 'registry/uncovered.yaml'), stringify({ boards: over.entries ?? [e7] }));
  writeFileSync(
    join(d, 'registry/stations/nl-1.yaml'),
    stringify({
      stations: over.rows ?? [
        row('g.ok'),
        row('g.ok', { quantity: 'Q' }),
        row('g.second'),
        row('g.off', { audience: 'off' }),
        row('g.withheld', { audience: 'off', licence_gate: 'withheld' }),
        row('g.twin', { role: 'twin' }),
        row('g.owner', { source: 'BE-3', audience: 'owner' }),
      ],
    }),
  );
  return d;
}

const e7 = (o: Record<string, unknown> = {}) => ({
  source: 'NL-7',
  rivers: { nl: ['Roer'], en: ['Roer'] },
  gauges: ['g.ok'],
  ...o,
});
const e99 = { source: 'NL-99', rivers: { nl: ['Beek'], en: ['Beek'] }, gauges: ['g.second'] };

describe('uncoveredBoards', () => {
  it('reads the board name, curated rivers and a deduped public gauge, and no source id', () => {
    const out = uncoveredBoards(mk({ entries: [e7(), e99] })).slice(0, 1);
    expect(out).toEqual([
      {
        board: 'Waterschap Zeven',
        rivers: { nl: ['Roer'], en: ['Roer'] },
        gauges: [{ id: 'g.ok', name: 'Name g.ok' }],
      },
    ]);
    expect(JSON.stringify(out)).not.toMatch(/NL-\d/);
  });

  it('follows the registry: a board that goes public drops, a new off board is added, with no code edit', () => {
    const flipped = [
      { id: 'NL-1', provider: 'rws', audience: 'public' },
      { id: 'NL-7', provider: 'ws7', audience: 'public' },
      { id: 'NL-99', provider: 'ws99', audience: 'off' },
    ];
    expect(uncoveredBoards(mk({ sources: flipped, entries: [e99] })).map((b) => b.board)).toEqual([
      'Waterschap Negenennegentig',
    ]);
    expect(uncoveredBoards(mk({ entries: [e7(), e99] })).map((b) => b.board)).toEqual([
      'Waterschap Zeven',
      'Waterschap Negenennegentig',
    ]);
  });

  it('refuses a gauge that is an owner source, off, withheld, not primary or unknown', () => {
    for (const g of ['g.owner', 'g.off', 'g.withheld', 'g.twin', 'g.nowhere'])
      expect(() => uncoveredBoards(mk({ entries: [e7({ gauges: [g] })] })), g).toThrow(/gauge/);
  });

  it('refuses a river missing from the cell, a marker or bracket, and unequal lists', () => {
    expect(() => uncoveredBoards(mk({ entries: [e7({ rivers: { nl: ['X'], en: ['Maas'] } })] }))).toThrow(
      /Rivers cell/,
    );
    for (const bad of ['UNVERIFIED', 'R17', 'Roer (x)'])
      expect(() =>
        uncoveredBoards(mk({ entries: [e7({ rivers: { nl: ['Roer'], en: [bad] } })], cell: `Roer, ${bad}` })),
      ).toThrow(/marker/);
    expect(() => uncoveredBoards(mk({ entries: [e7({ rivers: { nl: ['Roer', 'Geul'], en: ['Roer'] } })] }))).toThrow(
      /length/,
    );
  });

  it('refuses a missing entry, a stale entry and a row with no registry source', () => {
    expect(() => uncoveredBoards(mk({ entries: [e99] }))).toThrow(/NL-7 has no entry/);
    expect(() => uncoveredBoards(mk({ entries: [e7(), e99, { ...e99, source: 'NL-1' }] }))).toThrow(/not an off board/);
    expect(() => uncoveredBoards(mk({ sources: [{ id: 'NL-1', provider: 'rws', audience: 'public' }] }))).toThrow(
      /not in registry/,
    );
  });
});

describe('the real registry', () => {
  const real = uncoveredBoards(root);
  const catalogue = readFileSync(join(root, 'docs/sources/SOURCE-CATALOGUE.md'), 'utf8');

  it('lists exactly the off section 2.8 boards', () => {
    const table = catalogue.slice(catalogue.indexOf('\n### 2.8 '), catalogue.indexOf('\n**Platforms seen.**'));
    const ids = [...table.matchAll(/^\| (NL-\d+)/gm)].map((x) => x[1] as string);
    const off = ids.filter((id) => sources.find((s) => s.id === id)?.audience === 'off');
    expect(real).toHaveLength(off.length);
    expect(off.length).toBeGreaterThanOrEqual(20);
  });

  it('the committed uncovered.gen.ts is the generator output', () => {
    expect(readFileSync(join(root, UNCOVERED_FILE), 'utf8')).toBe(generateUncovered(root));
  });

  it('the committed method.gen.ts and uncovered.gen.ts hold no station id or name of an owner source', () => {
    const file = [METHOD_FILE, UNCOVERED_FILE].map((f) => readFileSync(join(root, f), 'utf8')).join('\n');
    const owner = new Set(sources.filter((s) => s.audience === 'owner').map((s) => s.id));
    expect(owner.size).toBeGreaterThan(0);
    for (const f of readdirSync(join(root, 'registry/stations'))) {
      const rows = (
        parse(readFileSync(join(root, 'registry/stations', f), 'utf8')) as {
          stations: { id: string; name: string; source: string }[];
        }
      ).stations;
      for (const r of rows.filter((x) => owner.has(x.source))) {
        expect(file, r.id).not.toContain(r.id);
        expect(file, r.name).not.toContain(`'${r.name}'`);
        expect(file, r.name).not.toContain(`"${r.name}"`);
      }
    }
  });
});
