import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { H_DESCRIPTION } from '../apps/server/src/adapters/nl-4/normalise.ts';
import { readThresholds } from '../apps/server/src/load/thresholds.ts';
import { StationsFile } from '../packages/contracts/src/index.ts';
import { classify, crosswalkRow, nl4Stem, type RefIn } from '../packages/core/src/index.ts';

// P18b criterion 2 (issue #66, D30): every NL-4 label stem that a tidal or lake NL-1 level series uses is in the class
// crosswalk as a provider class (never an area class, so never a warning), classifies with the basis `provider_class`,
// and is listed in the catalogue's addendum (§4.9, between the D30-addendum markers).
//
// The rule for "a tidal or lake series": a public primary NL-1 H series on NAP whose registry flags say `tidal: true`
// (the coast, the Wadden Sea, the Scheldt estuaries and the tidal delta rivers) or `lake: true` (the water type lake:
// IJsselmeer, Markermeer, Veerse Meer, Grevelingen, the border lakes). The seasonal stems (Haringvliet, IJsselmeer,
// Veerse Meer, Grevelingen) sit on both kinds, so both are covered.

const root = new URL('..', import.meta.url);
const thresholds = readThresholds(readFileSync(new URL('registry/thresholds/nl-4.csv', root), 'utf8')).rows;
type Row = (typeof thresholds)[number];

const series = StationsFile.parse(
  parse(readFileSync(new URL('registry/stations/nl-1.yaml', root), 'utf8')),
).stations.filter(
  (s) =>
    s.role === 'primary' &&
    s.audience === 'public' &&
    s.quantity === 'H' &&
    'datum' in s &&
    s.datum === 'NAP' &&
    (s.flags.tidal === true || s.flags.lake === true),
);
const codes = new Set(series.map((s) => s.provider_code));
const rows: Row[] = thresholds.filter((r) => r.description === H_DESCRIPTION && codes.has(r.code));
const byStem = new Map<string, Row[]>();
for (const r of rows) byStem.set(nl4Stem(r.label), [...(byStem.get(nl4Stem(r.label)) ?? []), r]);
const stems = [...byStem.keys()].sort();

/** The addendum block of catalogue §4.9: its table rows by stem. */
const catalogue = readFileSync(new URL('docs/sources/SOURCE-CATALOGUE.md', root), 'utf8');
const block = /<!-- D30-addendum:begin -->([\s\S]*?)<!-- D30-addendum:end -->/.exec(catalogue)?.[1] ?? '';
const table = block
  .split('\n')
  .filter((l) => l.startsWith('|') && !l.startsWith('| NL-4 label stem') && !l.startsWith('|---'))
  .map(
    (l) =>
      l
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim()) as [string, string, string, string],
  );

/** The RefIn rows of one class row, as the registry sync stores them. */
const refsOfRow = (r: Row): RefIn[] => {
  const base = {
    source: 'NL-4',
    unit: 'cm',
    convention: null,
    period: null,
    seasonFrom: r.from_md as number,
    seasonTo: r.to_md as number,
    priority: r.priority,
    label: r.label,
  };
  return [
    ...(r.from === null ? [] : [{ ...base, kind: 'NL4_FROM', value: r.from }]),
    ...(r.to === null ? [] : [{ ...base, kind: 'NL4_TO', value: r.to }]),
  ];
};

/** A value inside the band of a row, or null when the band is empty or has no bound. */
const inside = (r: Row): number | null => {
  if (r.from !== null && r.to !== null) return r.from < r.to ? (r.from + r.to) / 2 : null;
  if (r.from !== null) return r.from + 1;
  if (r.to !== null) return r.to - 1;
  return null;
};

const classOf = (refs: RefIn[], value: number, md: number) =>
  classify(
    {
      quantity: 'H',
      valueKind: 'level',
      value,
      qc: 0,
      ageMs: 0,
      stalenessMs: 3_600_000,
      // noon local on the first day of the row's own season
      t: Temporal.PlainDateTime.from({
        year: 2026,
        month: Math.floor(md / 100),
        day: md % 100,
        hour: 12,
      }).toZonedDateTime('Europe/Amsterdam').epochMilliseconds,
      refs,
      classes: [],
      areas: [],
      tidal: false,
      impounded: false,
    },
    'public',
  );

describe('the NL-4 stems of the tidal and lake NL-1 level series (D30)', () => {
  it('finds both kinds of series and the stems the catalogue lists', () => {
    expect(series.filter((s) => s.flags.tidal === true).length).toBeGreaterThan(50);
    expect(series.filter((s) => s.flags.lake === true).length).toBeGreaterThan(20);
    // the coast classes and the seasonal lake classes are all there
    for (const stem of [
      'Stormvloed',
      'Hoogwater / Stormvloed',
      'Laagwater',
      'Normaal',
      'Normale waterstand',
      'Verlaagd',
    ])
      expect(stems, stem).toContain(stem);
    expect(stems.length).toBeGreaterThanOrEqual(15);
  });

  it.each(stems)('%s: a provider class in the crosswalk, never an area class', (stem) => {
    const row = crosswalkRow('NL-4', 'stem', stem);
    expect(row, stem).toBeDefined();
    expect(row?.group).toBe('provider_class');
    expect(row?.basis).not.toBe('area');
  });

  it.each(stems)('%s: classifies with the basis provider_class (or no_ref and no basis)', (stem) => {
    const row = crosswalkRow('NL-4', 'stem', stem);
    // every row of this stem with a non-empty band, in its own season, alone
    const playable = (byStem.get(stem) ?? []).filter((r) => inside(r) !== null);
    expect(playable.length, `${stem} has a non-empty band`).toBeGreaterThan(0);
    for (const r of playable) {
      const got = classOf(refsOfRow(r), inside(r) as number, r.from_md as number);
      if (row?.level === 'no_ref') {
        expect([got.state, got.basis], `${stem} ${r.code}`).toEqual(['no_ref', null]);
      } else {
        expect(got.state, `${stem} ${r.code}`).toBe(row?.level);
        expect(got.basis, `${stem} ${r.code}`).toMatchObject({
          source: 'NL-4',
          kind: 'provider_class',
          ref: stem,
          label: r.label,
        });
      }
    }
  });

  it('is listed, one row per stem and in order, in the catalogue addendum (§4.9)', () => {
    expect(table.map((c) => c[0])).toEqual(stems);
    for (const [stem, target, basis, note] of table) {
      expect(target, stem).toBe(crosswalkRow('NL-4', 'stem', stem as string)?.level);
      expect(basis, stem).toBe('provider_class');
      expect(note, stem).toContain('Waterinfo display class, never a warning');
    }
  });

  it('never calls a display class a warning in the addendum', () => {
    for (const row of table) if (/warning/i.test(row.join(' '))) expect(row.join(' '), row[0]).toMatch(/never/i);
    // the prose: every sentence that names a warning also says what it is not, or that it is a link
    expect(block).toMatch(/never warnings/);
    expect(block).toMatch(/link to the national service/);
    expect(block).toMatch(/D12 amended/);
    expect(block).toMatch(/signed off by the owner on 2026-10-22, as proposed/);
  });
});
