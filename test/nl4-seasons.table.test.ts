import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { H_DESCRIPTION } from '../apps/server/src/adapters/nl-4/normalise.ts';
import { readThresholds } from '../apps/server/src/load/thresholds.ts';
import { StationsFile } from '../packages/contracts/src/index.ts';
import { classify, crosswalkRow, type RefIn, type SeriesIn } from '../packages/core/src/index.ts';

// P18b criterion 1 (issue #66): the NL-4 seasonal windows on both sides of every boundary, wrap-around included, on
// every NAP level series that has a seasonal class: the tidal ones (D12 amended: NL-4 decides on tidal series), the
// lakes (IJsselmeer, Veerse Meer, Grevelingen, Haringvliet) and the river Winterstand/Zomerstand ones.
//
// The expectation is an oracle written here, independent of nl4Candidate: the rows active on the local date
// (inclusive, wrapping when from > to), the bands holding the value (from <= v < to, an open side is open, a band
// with neither bound never), the lowest priority wins. Each date is tested at local noon and at 00:30 Europe/Amsterdam
// (1 April 00:30 local is 31 March 22:30Z, so the LOCAL date decides the season, never the UTC one).

const root = new URL('..', import.meta.url);
const thresholds = readThresholds(readFileSync(new URL('registry/thresholds/nl-4.csv', root), 'utf8')).rows;
type Row = (typeof thresholds)[number];

const stations = StationsFile.parse(
  parse(readFileSync(new URL('registry/stations/nl-1.yaml', root), 'utf8')),
).stations.filter(
  (s) => s.role === 'primary' && s.audience === 'public' && s.quantity === 'H' && 'datum' in s && s.datum === 'NAP',
);

/** The H class rows of a station code. */
const rowsOf = (code: string): Row[] => thresholds.filter((r) => r.code === code && r.description === H_DESCRIPTION);

/** The RefIn rows the registry sync stores for them (NL4_FROM and NL4_TO, each where the band has the bound). */
function refsOf(rows: readonly Row[]): RefIn[] {
  const out: RefIn[] = [];
  for (const r of rows) {
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
    if (r.from !== null) out.push({ ...base, kind: 'NL4_FROM', value: r.from });
    if (r.to !== null) out.push({ ...base, kind: 'NL4_TO', value: r.to });
  }
  return out;
}

// --- the calendar ----------------------------------------------------------------------------------------------------

const YEAR = 2026;
/** The instant of an MMDD at hour:minute Europe/Amsterdam. */
const instant = (md: number, hour: number, minute: number) =>
  Temporal.PlainDateTime.from({ year: YEAR, month: Math.floor(md / 100), day: md % 100, hour, minute }).toZonedDateTime(
    'Europe/Amsterdam',
  ).epochMilliseconds;
/** The MMDD one day away (a non-leap year, the year wraps). */
const shift = (md: number, days: number) => {
  const d = new Date(Date.UTC(YEAR, Math.floor(md / 100) - 1, (md % 100) + days));
  return (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
};

// --- the oracle -------------------------------------------------------------------------------------------------------

const activeOn = (md: number, from: number, to: number) =>
  from <= to ? md >= from && md <= to : md >= from || md <= to;
const stemOf = (label: string) => label.split('(')[0]?.trim() ?? label;

type Want = { state: string; label: string | null };
/**
 * The bands of the lowest priority that hold the value, the winner first: more than one only where two windows
 * overlap on a boundary day, and then the higher From wins, then the label (KG-443: never the row order). `ties`
 * counts those cases.
 */
function oracle(rows: readonly Row[], md: number, v: number): Want[] {
  const holds = rows.filter(
    (r) =>
      activeOn(md, r.from_md as number, r.to_md as number) &&
      (r.from !== null || r.to !== null) &&
      (r.from === null || v >= r.from) &&
      (r.to === null || v < r.to),
  );
  if (holds.length === 0) return [{ state: 'no_ref', label: null }];
  const lowest = Math.min(...holds.map((r) => r.priority));
  const wins = holds
    .filter((r) => r.priority === lowest)
    .sort(
      (a, b) => (b.from ?? -Infinity) - (a.from ?? -Infinity) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
    );
  return wins.map((r) => {
    const level = crosswalkRow('NL-4', 'stem', stemOf(r.label))?.level ?? 'no_ref';
    return level === 'no_ref' ? { state: 'no_ref', label: null } : { state: level, label: r.label };
  });
}

// --- the cases ---------------------------------------------------------------------------------------------------------

/** A value inside each non-empty band: the midpoint, from + 1 or to - 1 beside an open side; plus both bounds. */
function valuesOf(rows: readonly Row[]): number[] {
  const out = new Set<number>();
  for (const r of rows) {
    if (r.from !== null && r.to !== null) {
      if (r.from >= r.to) continue;
      out
        .add((r.from + r.to) / 2)
        .add(r.from)
        .add(r.to);
    } else if (r.from !== null) out.add(r.from + 1).add(r.from);
    else if (r.to !== null) out.add(r.to - 1).add(r.to);
  }
  return [...out].sort((a, b) => a - b);
}

const ALL_YEAR = (r: Row) => r.from_md === 101 && r.to_md === 1231;

function classOf(refs: readonly RefIn[], value: number, t: number, tidal: boolean) {
  const series: SeriesIn = {
    quantity: 'H',
    valueKind: 'level',
    value,
    qc: 0,
    ageMs: 0,
    stalenessMs: 3_600_000,
    t,
    refs,
    classes: [],
    areas: [],
    tidal,
    impounded: false,
  };
  return classify(series, 'public');
}

const seasonal = stations
  .map((s) => ({ s, rows: rowsOf(s.provider_code) }))
  .filter(({ rows }) => rows.some((r) => !ALL_YEAR(r)));
let generated = 0;
let ties = 0;
const disagreeing: unknown[] = [];

describe('NL-4 seasonal windows on NAP level series (D12 amended, P18b)', () => {
  it('covers the coast, the lakes and the river winter and summer levels', () => {
    const codes = new Set(seasonal.map(({ s }) => s.provider_code));
    expect(codes.size).toBeGreaterThanOrEqual(10);
    for (const code of [
      'hellevoetsluis',
      'edam',
      'markermeer.midden',
      'bommenede',
      'kamperland.schotsman',
      'eefde.sluis.beneden',
      'lobith.bovenrijn.tolkamer',
    ])
      expect(codes.has(code), code).toBe(true);
    // at least one tidal series with a seasonal window: the case T1 opens
    expect(seasonal.some(({ s }) => s.flags.tidal === true)).toBe(true);
  });

  it('has no two bands of a station that share the classifier key (from_md, to_md, priority)', () => {
    for (const { s, rows } of seasonal) {
      const keys = rows.map((r) => `${r.from_md}/${r.to_md}/${r.priority}`);
      expect(keys.length - new Set(keys).size, s.provider_code).toBe(0);
    }
  });

  it.each(seasonal.map(({ s, rows }) => [s.provider_code, s.flags.tidal === true, rows] as const))(
    '%s (tidal %s): each boundary day, both sides, local noon and 00:30',
    (_code, tidal, rows) => {
      const refs = refsOf(rows);
      const windows = new Set(rows.filter((r) => !ALL_YEAR(r)).map((r) => `${r.from_md}/${r.to_md}`));
      const dates = new Set<number>();
      for (const w of windows) {
        const [from, to] = w.split('/').map(Number) as [number, number];
        for (const md of [shift(from, -1), from, to, shift(to, 1)]) dates.add(md);
      }
      const values = valuesOf(rows);
      const bad: unknown[] = [];
      for (const md of [...dates].sort((a, b) => a - b)) {
        for (const [hour, minute] of [
          [12, 0],
          [0, 30],
        ] as const) {
          const t = instant(md, hour, minute);
          // 00:30 local is the evening before in UTC: the date the classifier must NOT use
          if (hour === 0) expect(new Date(t).getUTCDate()).not.toBe(md % 100);
          for (const v of values) {
            const want = oracle(rows, md, v);
            if (want.length > 1) {
              ties++;
              if (new Set(want.map((w) => w.state)).size > 1) disagreeing.push({ md, v, want });
            }
            const got = classOf(refs, v, t, tidal);
            generated++;
            const gotWant: Want = { state: got.state, label: got.basis?.label ?? null };
            const ok =
              want[0]?.state === gotWant.state &&
              want[0]?.label === gotWant.label &&
              got.flags.tidal === tidal &&
              (got.state === 'no_ref' ? got.basis === null : got.basis?.kind === 'provider_class');
            if (!ok) bad.push({ md, hour, minute, v, want, got: gotWant });
          }
        }
      }
      expect(bad).toEqual([]);
    },
    60_000,
  );

  // Two windows overlap on a boundary day (Haringvliet on 0315 and 0715) and can hold a value in two bands of equal
  // priority; then the tied bands must at least agree on the state (they do: same stem or same class).
  it('generated a table of cases, and its ties agree on the state', () => {
    expect(generated).toBeGreaterThan(1000);
    expect(ties).toBeGreaterThan(0);
    expect(disagreeing).toEqual([]);
  });
});

describe('pinned seasonal days', () => {
  const pinned = (code: string, tidal: boolean) => {
    const refs = refsOf(rowsOf(code));
    return (md: number, v: number, hour = 12, minute = 0) => {
      const r = classOf(refs, v, instant(md, hour, minute), tidal);
      return [r.state, r.basis?.label ?? null, r.basis?.kind ?? null, r.flags.tidal];
    };
  };

  it('hellevoetsluis (tidal, Haringvliet windows 315-715 and 715-315 overlap on 0315 and 0715)', () => {
    const at = pinned('hellevoetsluis', true);
    const broed = 'Licht verhoogd (>80cm)';
    const buiten = 'Normaal (> 0cm)';
    // 100 cm is Normaal outside the breeding season and "Licht verhoogd" inside it
    expect(at(314, 100)).toEqual(['normal', buiten, 'provider_class', true]);
    expect(at(315, 100)).toEqual(['elevated', broed, 'provider_class', true]); // both windows; priority 3 beats 5
    expect(at(316, 100)).toEqual(['elevated', broed, 'provider_class', true]);
    expect(at(714, 100)).toEqual(['elevated', broed, 'provider_class', true]);
    expect(at(715, 100)).toEqual(['elevated', broed, 'provider_class', true]); // both windows again
    expect(at(716, 100)).toEqual(['normal', buiten, 'provider_class', true]);
    // 00:30 local on 15 March is 14 March 23:30Z, 16 July 00:30 local is 15 July 22:30Z: still the local date
    expect(at(315, 100, 0, 30)).toEqual(['elevated', broed, 'provider_class', true]);
    expect(at(716, 100, 0, 30)).toEqual(['normal', buiten, 'provider_class', true]);
    expect(at(715, 100, 0, 30)).toEqual(['elevated', broed, 'provider_class', true]);
    // 140 cm holds both priority-3 bands on the overlap days: the higher From wins there, never the row order (KG-443)
    const buiten130 = 'Licht verhoogd (>130cm)';
    expect(at(314, 140)).toEqual(['elevated', buiten130, 'provider_class', true]);
    expect(at(315, 140)).toEqual(['elevated', buiten130, 'provider_class', true]);
    expect(at(316, 140)).toEqual(['elevated', broed, 'provider_class', true]);
    expect(at(714, 140)).toEqual(['elevated', broed, 'provider_class', true]);
    expect(at(715, 140)).toEqual(['elevated', buiten130, 'provider_class', true]);
    expect(at(716, 140)).toEqual(['elevated', buiten130, 'provider_class', true]);
    // the Gehele-jaar rows hold on every one of these days
    for (const md of [314, 315, 316, 714, 715, 716]) {
      expect(at(md, 200), String(md)).toEqual(['high', 'Hoogwater / Stormvloed (> 190cm)', 'provider_class', true]);
      expect(at(md, 230), String(md)).toEqual(['extreme', 'Extreem hoogwater (> 220cm)', 'provider_class', true]);
      expect(at(md, -10), String(md)).toEqual(['low', 'Laagwater (< 0cm)', 'provider_class', true]);
    }
  });

  it.each(['edam', 'markermeer.midden'])('%s: the IJsselmeer winter (1001-331, wraps) and summer (401-930)', (code) => {
    const at = pinned(code, false);
    const [verlaagd, normaal] =
      code === 'edam'
        ? [
            ['Verlaagde waterstand (<-35cm)', 'Verlaagde waterstand (<-55cm)'],
            ['Normale waterstand (-55 tot -10cm)', 'Normale waterstand (-35 tot -10cm)'],
          ]
        : [
            ['Verlaagd (<-30cm)', 'Verlaagd (<-45cm)'],
            ['Normaal (-45 tot -10cm)', 'Normaal (-30 tot -10cm)'],
          ];
    // -40 cm: low in summer (below -35 / -30), normal in winter (above -55 / -45)
    expect(at(331, -40)).toEqual(['normal', normaal[0], 'provider_class', false]);
    expect(at(401, -40)).toEqual(['low', verlaagd[0], 'provider_class', false]);
    expect(at(930, -40)).toEqual(['low', verlaagd[0], 'provider_class', false]);
    expect(at(1001, -40)).toEqual(['normal', normaal[0], 'provider_class', false]);
    // -60 cm: low in winter (below -55 / -45)
    expect(at(331, -60)).toEqual(['low', verlaagd[1], 'provider_class', false]);
    expect(at(1001, -60)).toEqual(['low', verlaagd[1], 'provider_class', false]);
    // 00:30 local on 1 April is 31 March 22:30Z: still summer by the local date
    expect(at(401, -40, 0, 30)).toEqual(['low', verlaagd[0], 'provider_class', false]);
    expect(at(1001, -40, 0, 30)).toEqual(['normal', normaal[0], 'provider_class', false]);
    // the Gehele-jaar rows hold across the seam
    for (const md of [331, 401, 930, 1001])
      expect(at(md, 60), String(md)).toEqual(
        code === 'edam'
          ? ['high', 'Hoogwater (>15cm)', 'provider_class', false]
          : ['extreme', 'Extreem hoog water (>50cm)', 'provider_class', false],
      );
  });
});
