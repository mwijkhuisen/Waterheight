import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { type Normalised, SchemaDrift } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type Context,
  normalise,
  normaliseTide,
  normaliseTideType,
  type TideKind,
} from '../../src/adapters/nl-1/normalise.ts';
import {
  ASTRO_CAPS,
  JSON_CAPS,
  parseWaarnemingen,
  TIDE_CAPS,
  type Waarnemingen,
  type WaarnemingenCaps,
} from '../../src/adapters/nl-1/parse.ts';
import { goldenUrl, rawFixture, registryOf } from './registry.ts';

// NL-1 P16b: the astronomical tide and the high and low waters (specs nl-1-astro, nl-1-hwlw, nl-1-hwlw-astro).
// Real goldens: the trimmed Vlissingen NAP astronomical tide and the Goeree lichteiland MSL astronomical extremes.
// The measured extremes are a synthetic case: RWS answered 204 to every measured month we probed (Q2).

const registry = registryOf('NL-1');
const VLISSINGEN = 'vlissingen/WATHTE/NAP/other:F007';
const GOEREE = 'goeree.lichteiland/WATHTE/MSL/other:F007';

const ctx = (name: string): Context => ({
  registry,
  fetchedAt: Date.parse(rawFixture('NL-1', name).meta.recorded_at),
});
const lists = (name: string, caps: WaarnemingenCaps = TIDE_CAPS) =>
  parseWaarnemingen(rawFixture('NL-1', name).body, caps);
const tide = (name: string, kind: TideKind, caps: WaarnemingenCaps = TIDE_CAPS) =>
  normaliseTide(lists(name, caps), ctx(name), kind);

function golden(name: string, actual: Normalised): Normalised {
  const url = goldenUrl('NL-1', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

/** The same lists with other metadata (Code of a coded field, or the ProcesType string), and rows replaced. */
const alter = (
  from: readonly Waarnemingen[],
  aquo: Record<string, string> = {},
  code?: string,
  metingen?: Waarnemingen['metingen'],
): Waarnemingen[] =>
  from.map((l) => ({
    ...l,
    locatie: code === undefined ? l.locatie : { ...l.locatie, Code: code },
    metingen: metingen ?? l.metingen,
    aquo: {
      ...l.aquo,
      ...Object.fromEntries(
        Object.entries(aquo).map(([k, v]) => [k, k === 'ProcesType' ? v : { Code: v, Omschrijving: '' }]),
      ),
    } as Waarnemingen['aquo'],
  }));

describe('golden files (real payloads)', () => {
  it('the astronomical tide of Vlissingen NAP (trimmed, 1,800 values): tide rows, never obs, no label', () => {
    const out = tide('nl-1-astro-vlissingen-nap', 'astro', ASTRO_CAPS);
    expect(out).toEqual(golden('nl-1-astro-vlissingen-nap', out));
    expect(out.obs).toEqual([]);
    expect(out.tide).toHaveLength(1800);
    expect(out.dropped).toEqual({});
    expect(out.tide?.every((r) => r.series === VLISSINGEN && r.kind === 'astro' && r.hilo === null)).toBe(true);
  });

  it('the astronomical high and low waters of Goeree lichteiland MSL: labelled by strict alternation', () => {
    const out = tide('nl-1-hwlw-astro-goeree-lichteiland-msl', 'extreme_astro');
    expect(out).toEqual(golden('nl-1-hwlw-astro-goeree-lichteiland-msl', out));
    expect(out.obs).toEqual([]);
    expect(out.tide).toHaveLength(1546);
    expect(out.dropped).toEqual({});
    const rows = out.tide ?? [];
    expect(rows.every((r) => r.series === GOEREE && r.kind === 'extreme_astro')).toBe(true);
    // Strictly alternating, and every high above its neighbours.
    rows.forEach((r, i) => {
      if (i > 0) expect(r.hilo).not.toBe(rows[i - 1]?.hilo);
      for (const n of [rows[i - 1], rows[i + 1]]) {
        if (n) expect(r.hilo === 'high' ? r.value > n.value : r.value < n.value).toBe(true);
      }
    });
    // Recorded 2026-10-17T07:58Z: the first value 10:32 +01:00 is -71 cm (a low), the second 105 cm (a high).
    expect(rows[0]).toEqual({
      series: GOEREE,
      kind: 'extreme_astro',
      ts: '2026-10-17T10:32:00.000Z',
      value: -71,
      hilo: 'low',
    });
    expect(rows[1]?.hilo).toBe('high');
  });

  it('measured high and low waters: RWS answers 204 (no object, never an adapter), so a payload is an error', () => {
    for (const name of ['nl-1-hwlw-vlissingen-nap', 'nl-1-hwlw-vlissingen-nap-20250901-20251001']) {
      const { body, meta } = rawFixture('NL-1', name);
      // Same treatment as the other real 204 fixtures (nl-1.test.ts): the recorder writes no object, the loader
      // counts the fetch as ok, and an empty body that did reach `parse` is drift. No golden: nothing is produced.
      expect([meta.status, body.length]).toEqual([204, 0]);
      expect(() => parseWaarnemingen(body, TIDE_CAPS)).toThrow(SchemaDrift);
    }
  });

  it('the untrimmed Vlissingen body (git-ignored .smoke): ASTRO_CAPS holds it, 57,600 rows', () => {
    const file = new URL('../../../../.smoke/nl-1-astro-vlissingen-nap.raw', import.meta.url);
    if (!existsSync(file)) return;
    const body = readFileSync(file);
    const fetchedAt = Date.parse(rawFixture('NL-1', 'nl-1-astro-vlissingen-nap').meta.recorded_at);
    const out = normaliseTide(parseWaarnemingen(body, ASTRO_CAPS), { registry, fetchedAt }, 'astro');
    expect(out.tide).toHaveLength(57_600);
    expect(out.dropped).toEqual({});
    expect(() => parseWaarnemingen(body, JSON_CAPS)).toThrow(SchemaDrift);
  });
});

describe('synthetic payloads [U]', () => {
  const name = 'nl-1-hwlw-vlissingen-nap-measured.synthetic';

  it('measured extremes (Groepering GETETM2, ProcesType meting, NAP): 12 alternating, high first', () => {
    const out = tide(name, 'extreme');
    expect(out).toEqual(golden(name, out));
    expect(out.dropped).toEqual({});
    expect(out.tide?.map((r) => r.hilo)).toEqual(Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? 'high' : 'low')));
    expect(out.tide?.every((r) => r.series === VLISSINGEN && r.kind === 'extreme')).toBe(true);
  });

  it('a measured payload read as another kind, or an astronomical one as measured, is drift', () => {
    const measured = lists(name);
    const astro = lists('nl-1-hwlw-astro-goeree-lichteiland-msl');
    expect(() => normaliseTide(measured, ctx(name), 'extreme_astro')).toThrow(new SchemaDrift('tide_process'));
    expect(() => normaliseTide(measured, ctx(name), 'astro')).toThrow(new SchemaDrift('tide_process'));
    expect(() => normaliseTide(astro, ctx(name), 'extreme')).toThrow(new SchemaDrift('tide_process'));
  });
});

describe('drift and drops', () => {
  const name = 'nl-1-hwlw-astro-goeree-lichteiland-msl';
  const base = lists(name);
  const at = ctx(name);
  const code = (l: readonly Waarnemingen[], kind: TideKind = 'extreme_astro', c: Context = at) => {
    try {
      return normaliseTide(l, c, kind);
    } catch (err) {
      return err instanceof SchemaDrift ? err.message : 'other';
    }
  };

  it('the provider answering something other than asked is drift, with a fixed code', () => {
    expect(code(alter(base, { Grootheid: 'Q' }))).toBe('tide_quantity');
    expect(code(alter(base, { Eenheid: 'm3/s' }))).toBe('tide_unit');
    expect(code(alter(base, { Compartiment: 'BS' }))).toBe('tide_compartment');
    expect(code(alter(base, { ProcesType: 'meting' }))).toBe('tide_process');
    expect(code(alter(base, { ProcesType: 'verwachting' }))).toBe('tide_process');
    // Groepering missing, foreign, or of the other kind.
    expect(code(alter(base, { Groepering: '' }))).toBe('tide_grouping');
    expect(code(alter(base, { Groepering: 'GETETBRKDMSL3' }))).toBe('tide_grouping');
    expect(code(alter(base, { Groepering: 'GETETMSL2' }))).toBe('tide_grouping');
    expect(code(alter(base, { Groepering: 'GETETBRKDMSL2' }), 'astro')).toBe('tide_grouping');
    // MSL grouping with NAP, NAP grouping with MSL: the datum and the grouping disagree.
    expect(code(alter(base, { Hoedanigheid: 'NAP' }))).toBe('tide_datum');
    expect(code(alter(base, { Groepering: 'GETETBRKD2' }))).toBe('tide_datum');
    // Any other datum is not what we asked.
    expect(code(alter(base, { Hoedanigheid: 'TAW' }))).toBe('tide_datum');
    // One bad list among good ones fails the payload.
    expect(code([...base, ...alter(base, { Eenheid: 'm' })])).toBe('tide_unit');
  });

  it('an unregistered series, a location without that datum and a second list are unknown (once per combination)', () => {
    expect(code(alter(base, {}, 'not.a.rws.point'))).toMatchObject({ tide: [], unknown: 1, dropped: {} });
    // goeree.lichteiland is registered in MSL only: a NAP list at it cannot attach.
    expect(code(alter(base, { Hoedanigheid: 'NAP', Groepering: 'GETETBRKD2' }))).toMatchObject({
      tide: [],
      unknown: 1,
    });
    expect(code([...alter(base, {}, 'nowhere'), ...alter(base, {}, 'nowhere')])).toMatchObject({ unknown: 1 });
    // A name that is no series (inherited property names).
    for (const c of ['constructor', '__proto__', 'toString'])
      expect(code(alter(base, {}, c))).toMatchObject({ unknown: 1 });
  });

  it('a method other than the declared one is withheld and reported, never stored', () => {
    expect(code(alter(base, { WaardeBepalingsMethode: 'other:F227' }))).toMatchObject({
      tide: [],
      dropped: { unregistered_method: 1546 },
    });
    // Measured extremes: F009, F010, F029 and none are accepted; the astronomical F012 is not.
    const measured = lists('nl-1-hwlw-vlissingen-nap-measured.synthetic');
    const c = ctx('nl-1-hwlw-vlissingen-nap-measured.synthetic');
    for (const m of ['other:F009', 'other:F029', '', 'NVT']) {
      expect([m, (code(alter(measured, { WaardeBepalingsMethode: m }), 'extreme', c) as Normalised).tide]).toEqual([
        m,
        expect.any(Array),
      ]);
      expect((code(alter(measured, { WaardeBepalingsMethode: m }), 'extreme', c) as Normalised).tide).toHaveLength(12);
    }
    expect(code(alter(measured, { WaardeBepalingsMethode: 'other:F012' }), 'extreme', c)).toMatchObject({
      tide: [],
      dropped: { unregistered_method: 12 },
    });
  });

  it('a registered location in a series the loader would not know stays out of obs: obs is always empty', () => {
    const out = normaliseTide(base, at, 'extreme_astro');
    expect(out.obs).toEqual([]);
    expect(out.gaugeZeros).toEqual([]);
  });

  const first = base[0]?.metingen[0] as Waarnemingen['metingen'][number];
  // A one-off payload of the given values, 6 h apart from 2026-10-17T12:00Z.
  const series = (values: readonly number[], q = '00'): Waarnemingen[] =>
    alter(
      base,
      {},
      undefined,
      values.map((v, i) => ({
        ...first,
        Meetwaarde: { Waarde_Alfanumeriek: String(v), Waarde_Numeriek: v },
        Tijdstip: `${new Date(Date.parse('2026-10-17T12:00:00Z') + i * 21_600_000 + 3_600_000).toISOString().slice(0, 19)}.000+01:00`,
        WaarnemingMetadata: {
          ...first.WaarnemingMetadata,
          Kwaliteitswaardecode: q,
        },
      })),
    );
  const labels = (values: readonly number[]) => {
    const out = code(series(values)) as Normalised;
    return { hilo: out.tide?.map((r) => r.hilo), dropped: out.dropped };
  };

  it('labels: strict alternation; first and last have one neighbour', () => {
    expect(labels([10, 90, 20, 95])).toEqual({ hilo: ['low', 'high', 'low', 'high'], dropped: {} });
    expect(labels([90, 10, 85])).toEqual({ hilo: ['high', 'low', 'high'], dropped: {} });
    expect(labels([10, 90])).toEqual({ hilo: ['low', 'high'], dropped: {} });
  });

  it('labels (extreme_astro): a series that does not alternate keeps its rows with a null label, nothing counted', () => {
    // #174: the pipeline takes RWS's label for these rows (tide_label) or stores nothing; the adapter drops no value.
    const nulls = (n: number) => ({ hilo: Array.from({ length: n }, () => null), dropped: {} });
    expect(labels([50])).toEqual(nulls(1));
    expect(labels([10, 10, 90])).toEqual(nulls(3)); // equal neighbours
    expect(labels([10, 90, 95, 20])).toEqual(nulls(4)); // two highs in a row (monotone run)
    expect(labels([90, 10, 20, 95])).toEqual(nulls(4)); // an agger's double low
    expect(labels([10, 90, 20, 20])).toEqual(nulls(4));
  });

  // The measured kind has no type series (KG-366): it keeps the adapter-level drop. Its payload is the synthetic
  // measured list, fetched late enough that nothing is future or too old.
  const measuredList = lists('nl-1-hwlw-vlissingen-nap-measured.synthetic');
  const ext: Context = { ...at, fetchedAt: Date.parse('2026-10-19T00:00:00Z') };

  // Rows at hours after 2026-10-17T12:00Z: [hours, value, quality code].
  const hoursOf = (from: readonly Waarnemingen[], ...entries: [number, number, string?][]): Waarnemingen[] =>
    alter(
      from,
      {},
      undefined,
      entries.map(([h, v, q = '00']) => ({
        ...first,
        Meetwaarde: { Waarde_Alfanumeriek: String(v), Waarde_Numeriek: v },
        Tijdstip: `${new Date(Date.parse('2026-10-17T13:00:00Z') + h * 3_600_000).toISOString().slice(0, 23)}+01:00`,
        WaarnemingMetadata: { ...first.WaarnemingMetadata, Kwaliteitswaardecode: q },
      })),
    );
  const hours = (...entries: [number, number, string?][]) => hoursOf(base, ...entries);
  const result = (l: Waarnemingen[], kind: TideKind = 'extreme_astro') => {
    const out = code(l, kind, kind === 'extreme' ? ext : at) as Normalised;
    return { hilo: out.tide?.map((r) => r.hilo), dropped: out.dropped };
  };
  const measuredHours = (...entries: [number, number, string?][]) => hoursOf(measuredList, ...entries);
  const nulls = (n: number) => Array.from({ length: n }, () => null);

  it('labels (extreme): a series that does not alternate is still dropped, counted by its values (hwlw_unlabelled)', () => {
    const measured = (...values: number[]) =>
      result(measuredHours(...values.map((v, i): [number, number] => [i * 6, v])), 'extreme');
    expect(measured(10, 90, 20, 95)).toEqual({ hilo: ['low', 'high', 'low', 'high'], dropped: {} });
    expect(measured(90, 10, 20, 95)).toEqual({ hilo: [], dropped: { hwlw_unlabelled: 4 } });
    expect(measured(10, 90, 95, 20)).toEqual({ hilo: [], dropped: { hwlw_unlabelled: 4 } });
    expect(measured(50)).toEqual({ hilo: [], dropped: { hwlw_unlabelled: 1 } });
  });

  it('labels: a value dropped between the first and last kept one (review CR-2): null labels, or withheld if measured', () => {
    // The reviewer's case: the high between -100 and -120 is a gap; the rest alternates and would label -100 high.
    expect(result(hours([0, -100], [6, -120], [12, 160], [18, -110], [24, 155]))).toEqual({
      hilo: ['high', 'low', 'high', 'low', 'high'],
      dropped: {},
    });
    // extreme_astro (#174): every kept row stays, unlabelled by us, and only the drop itself is counted.
    expect(result(hours([0, -100], [3, 0, '99'], [6, -120], [12, 160], [18, -110], [24, 155]))).toEqual({
      hilo: nulls(5),
      dropped: { gap: 1 },
    });
    // A hole near the end, an unknown quality, a conflict and an out-of-range value alike.
    expect(result(hours([0, -100], [6, 120], [12, -110], [15, 0, '50'], [18, 155]))).toEqual({
      hilo: nulls(4),
      dropped: { unknown_quality: 1 },
    });
    expect(result(hours([0, -100], [3, 5], [3, 6], [6, 120], [12, -110]))).toEqual({
      hilo: nulls(3),
      dropped: { conflict: 2 },
    });
    expect(result(hours([0, -100], [3, 600_000], [6, 120], [12, -110]))).toEqual({
      hilo: nulls(3),
      dropped: { out_of_range: 1 },
    });
    // extreme: the same holes withhold the series, as before #174.
    expect(
      result(measuredHours([0, -100], [3, 0, '99'], [6, -120], [12, 160], [18, -110], [24, 155]), 'extreme'),
    ).toEqual({ hilo: [], dropped: { gap: 1, hwlw_unlabelled: 5 } });
    expect(result(measuredHours([0, -100], [6, 120], [12, -110], [15, 0, '50'], [18, 155]), 'extreme')).toEqual({
      hilo: [],
      dropped: { unknown_quality: 1, hwlw_unlabelled: 4 },
    });
    expect(result(measuredHours([0, -100], [3, 5], [3, 6], [6, 120], [12, -110]), 'extreme')).toEqual({
      hilo: [],
      dropped: { conflict: 2, hwlw_unlabelled: 3 },
    });
    expect(result(measuredHours([0, -100], [3, 600_000], [6, 120], [12, -110]), 'extreme')).toEqual({
      hilo: [],
      dropped: { out_of_range: 1, hwlw_unlabelled: 3 },
    });
    // A drop outside the kept values (here after the last one) leaves the labels determined, for both kinds.
    expect(result(hours([0, -100], [6, 120], [12, -110], [18, 0, '99']))).toEqual({
      hilo: ['low', 'high', 'low'],
      dropped: { gap: 1 },
    });
    expect(result(measuredHours([0, -100], [6, 120], [12, -110], [18, 0, '99']), 'extreme')).toEqual({
      hilo: ['low', 'high', 'low'],
      dropped: { gap: 1 },
    });
  });

  it('labels: consecutive extremes more than 12 h apart (a missing pair): null labels, or withheld if measured', () => {
    // 12.5 h between the second and third extreme.
    expect(result(hours([0, -100], [6, 120], [18.5, -110], [24.5, 130]))).toEqual({ hilo: nulls(4), dropped: {} });
    expect(result(measuredHours([0, -100], [6, 120], [18.5, -110], [24.5, 130]), 'extreme')).toEqual({
      hilo: [],
      dropped: { hwlw_unlabelled: 4 },
    });
    // 11.5 h and exactly 12 h still count as one tide (Hoek van Holland has 10.1 h).
    for (const gap of [10.1, 11.5, 12]) {
      expect(result(hours([0, -100], [gap, 120]))).toEqual({ hilo: ['low', 'high'], dropped: {} });
      expect(result(measuredHours([0, -100], [gap, 120]), 'extreme')).toEqual({ hilo: ['low', 'high'], dropped: {} });
    }
  });

  it('values outside the observation range of the series are dropped as out_of_range (review SR-4)', () => {
    const astro = alter(hours([0, 10], [1, 1e39], [2, -2001], [3, 500_000], [4, -2000], [5, 500_001]), {
      Groepering: '',
    });
    const out = normaliseTide(astro, ctx(name), 'astro');
    expect(out.tide?.map((r) => r.value)).toEqual([10, 500_000, -2000]);
    expect(out.dropped).toEqual({ out_of_range: 3 });
  });

  it('labels do not leak across series: one non-alternating series is unlabelled, the other keeps its labels', () => {
    const good = series([10, 90, 20]);
    const bad = alter(series([10, 90, 95]), {}, 'vlissingen', undefined).map((l) => ({
      ...l,
      aquo: {
        ...l.aquo,
        Hoedanigheid: { Code: 'NAP', Omschrijving: '' },
        Groepering: { Code: 'GETETBRKD2', Omschrijving: '' },
      },
    }));
    const out = normaliseTide([...good, ...bad], at, 'extreme_astro');
    expect(out.tide?.map((r) => [r.series, r.hilo])).toEqual([
      [GOEREE, 'low'],
      [GOEREE, 'high'],
      [GOEREE, 'low'],
      [VLISSINGEN, null],
      [VLISSINGEN, null],
      [VLISSINGEN, null],
    ]);
    expect(out.dropped).toEqual({});
  });

  it('quality, duplicates and conflicts: a gap is dropped, a repeat is one row, different values withhold the instant', () => {
    const m = base[0]?.metingen[0] as Waarnemingen['metingen'][number];
    const row = (ts: string, v: number, q = '00') => ({
      ...m,
      Meetwaarde: { Waarde_Alfanumeriek: String(v), Waarde_Numeriek: v },
      Tijdstip: ts,
      WaarnemingMetadata: { ...m.WaarnemingMetadata, Kwaliteitswaardecode: q },
    });
    const t = (h: number) => `2026-10-17T${String(h).padStart(2, '0')}:00:00.000+01:00`;
    const out = normaliseTide(
      alter(base, { Groepering: '' }, undefined, [
        row(t(13), 10),
        row(t(19), 90),
        row(t(19), 90), // repeat
        row(t(20), 5, '99'), // gap
        row(t(21), 7, '50'), // unknown quality
        row(t(22), 30),
        row(t(22), 31), // conflict
        row(t(23), 20),
      ]),
      at,
      'astro',
    );
    expect(out.dropped).toEqual({ duplicate: 1, gap: 1, unknown_quality: 1, conflict: 2 });
    expect(out.tide?.map((r) => [r.ts, r.value, r.hilo])).toEqual([
      ['2026-10-17T12:00:00.000Z', 10, null],
      ['2026-10-17T18:00:00.000Z', 90, null],
      ['2026-10-17T22:00:00.000Z', 20, null],
    ]);
    // Two lists stating the same instant with the same value are one row, in any order.
    const a = alter(base, { Groepering: '' }, undefined, [row(t(13), 10), row(t(19), 90)]);
    expect(
      normaliseTide([...a, ...a.map((l) => ({ ...l, metingen: [...l.metingen].reverse() }))], at, 'astro').tide,
    ).toHaveLength(2);
  });

  it('time bounds: measured extremes drop future and too old; astronomical ones keep P400D ahead, one day back', () => {
    const m = base[0]?.metingen[0] as Waarnemingen['metingen'][number];
    const day = 86_400_000;
    const stamp = (ms: number) => `${new Date(ms + 3_600_000).toISOString().slice(0, 23)}+01:00`;
    // Values alternate by position, inside the range of the series.
    const rows = (...offsets: number[]) =>
      offsets.map((o, i) => ({
        ...m,
        Tijdstip: stamp(at.fetchedAt + o),
        Meetwaarde: { Waarde_Alfanumeriek: '1', Waarde_Numeriek: i % 2 === 0 ? -50 : 50 },
      }));
    const p = (kind: TideKind, ...offsets: number[]) => {
      const out = normaliseTide(
        alter(base, kind === 'astro' ? { Groepering: '' } : {}, undefined, rows(...offsets)),
        at,
        kind,
      );
      return [out.tide?.length, out.dropped];
    };
    // extreme: 16 minutes ahead is future, 46 days back is too old.
    const measured = normaliseTide(
      alter(measuredList, {}, undefined, rows(16 * 60_000, -46 * day, -6 * 3_600_000, 0)),
      at,
      'extreme',
    );
    expect([measured.tide?.length, measured.dropped]).toEqual([2, { future: 1, too_old: 1 }]);
    // astronomical: up to fetch + P400D + P1D and from fetch - P1D.
    expect(p('astro', 400 * day, 401 * day + 1, -day, -day - 1, 1)).toEqual([
      3,
      { beyond_horizon: 1, before_window: 1 },
    ]);
    expect(p('extreme_astro', 400 * day + 5, 402 * day)).toEqual([1, { beyond_horizon: 1 }]);
    // maxAgeMs null: nothing is too old (a catch-up).
    const old = normaliseTide(
      alter(measuredList, {}, undefined, rows(-100 * day, -100 * day + 6 * 3_600_000)),
      { ...at, maxAgeMs: null },
      'extreme',
    );
    expect(old.dropped).toEqual({});
  });
});

describe('observations at the new kinds of location (catch-up shape)', () => {
  it('a 10-minute list whose first value is 100 days before the fetch keeps every row when maxAgeMs is null', () => {
    const name = 'nl-1-obs-sea-hellevoetsluis-h-nap';
    const [l] = lists(name, JSON_CAPS) as [Waarnemingen];
    const first = l.metingen[0] as Waarnemingen['metingen'][number];
    const fetchedAt = ctx(name).fetchedAt;
    const metingen = Array.from({ length: 50 }, (_, i) => ({
      ...first,
      Tijdstip: `${new Date(fetchedAt - 100 * 86_400_000 + i * 600_000 + 3_600_000).toISOString().slice(0, 23)}+01:00`,
    }));
    const lijst = [{ ...l, metingen }];
    expect(normalise(lijst, { registry, fetchedAt }).dropped).toEqual({ too_old: 50 });
    const kept = normalise(lijst, { registry, fetchedAt, maxAgeMs: null });
    expect(kept.dropped).toEqual({});
    expect(kept.obs).toHaveLength(50);
  });
});

describe('property and fuzz tests', () => {
  const name = 'nl-1-hwlw-astro-goeree-lichteiland-msl';
  const doc = JSON.parse(rawFixture('NL-1', name).body.toString('utf8'));
  const at = ctx(name);
  const measuredList = lists('nl-1-hwlw-vlissingen-nap-measured.synthetic');
  const ext: Context = { ...at, fetchedAt: Date.parse('2026-10-19T00:00:00Z') };

  it('a mutated real payload is either still valid or a SchemaDrift; labels alternate; obs stays empty', () => {
    const mutation = fc.tuple(
      fc.constantFrom('AquoMetadata', 'Locatie', 'MetingenLijst'),
      fc.constantFrom(
        'Grootheid',
        'Eenheid',
        'Groepering',
        'Hoedanigheid',
        'ProcesType',
        'Code',
        '0',
        '1',
        '5',
        'Tijdstip',
        'Meetwaarde',
      ),
      fc.oneof(
        fc.jsonValue(),
        fc.constantFrom(
          { Code: 'GETETBRKD2', Omschrijving: '' },
          { Code: 'NAP', Omschrijving: '' },
          { Code: '99', Omschrijving: '' },
        ),
      ),
      fc.constantFrom<TideKind>('astro', 'extreme', 'extreme_astro'),
    );
    fc.assert(
      fc.property(mutation, ([part, key, junk, kind]) => {
        const copy = structuredClone(doc);
        const target = copy.WaarnemingenLijst[0][part];
        if (Array.isArray(target) && /^\d$/.test(key)) target[Number(key)] = junk;
        else if (Array.isArray(target)) target[0][key] = junk;
        else target[key] = junk;
        try {
          const out = normaliseTide(parseWaarnemingen(Buffer.from(JSON.stringify(copy)), TIDE_CAPS), at, kind);
          expect(out.obs).toEqual([]);
          const rows = out.tide ?? [];
          rows.forEach((r, i) => {
            const prev = rows[i - 1];
            if (kind === 'astro') expect(r.hilo).toBeNull();
            // Only extreme_astro may carry a null label (#174: the pipeline takes RWS's label for it).
            else if (kind === 'extreme') expect(r.hilo).not.toBeNull();
            if (r.hilo !== null && prev && prev.series === r.series) expect(r.hilo).not.toBe(prev.hilo);
          });
          // A series is labelled whole or not at all.
          for (const s of new Set(rows.map((r) => r.series)))
            expect(new Set(rows.filter((r) => r.series === s).map((r) => r.hilo === null)).size).toBe(1);
        } catch (err) {
          expect(err).toBeInstanceOf(SchemaDrift);
        }
      }),
      { numRuns: 100 },
    );
  }, 60_000);

  it('arbitrary value sequences: extreme_astro labels alternate and are strict extremes, else every label is null', () => {
    const m = (doc.WaarnemingenLijst[0].MetingenLijst as Waarnemingen['metingen']).at(
      0,
    ) as Waarnemingen['metingen'][number];
    const base = parseWaarnemingen(rawFixture('NL-1', name).body, TIDE_CAPS);
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -300, max: 400 }), { maxLength: 40 }), (values) => {
        const metingen = values.map((v, i) => ({
          ...m,
          Meetwaarde: { Waarde_Alfanumeriek: String(v), Waarde_Numeriek: v },
          Tijdstip: `${new Date(at.fetchedAt + 3_600_000 + i * 21_600_000).toISOString().slice(0, 23)}+01:00`,
        }));
        const out = normaliseTide(alter(base, {}, undefined, metingen), at, 'extreme_astro');
        const rows = out.tide ?? [];
        expect(out.obs).toEqual([]);
        expect(out.dropped).toEqual({}); // nothing is withheld by the adapter any more
        expect(rows.map((r) => r.value)).toEqual(values);
        // Labels exist exactly where the values zigzag (at least two, no equal neighbours, alternating direction).
        const zigzag =
          values.length >= 2 &&
          values.every((v, i) => i === 0 || v !== values[i - 1]) &&
          values.every(
            (v, i) =>
              i === 0 ||
              i === values.length - 1 ||
              (v - (values[i - 1] as number)) * ((values[i + 1] as number) - v) < 0,
          );
        expect(rows.every((r) => r.hilo === null)).toBe(!zigzag);
        if (!zigzag) return;
        rows.forEach((r, i) => {
          if (i > 0) expect(r.hilo).not.toBe(rows[i - 1]?.hilo);
          for (const n of [rows[i - 1], rows[i + 1]]) {
            if (n) expect(r.hilo === 'high' ? r.value > n.value : r.value < n.value).toBe(true);
          }
        });
      }),
      { numRuns: 300 },
    );
  });

  it('a value dropped between the first and last kept one: no label for extreme_astro, nothing stored for extreme (CR-2)', () => {
    const m = (doc.WaarnemingenLijst[0].MetingenLijst as Waarnemingen['metingen']).at(
      0,
    ) as Waarnemingen['metingen'][number];
    const base = parseWaarnemingen(rawFixture('NL-1', name).body, TIDE_CAPS);
    const drop = fc.constantFrom<[string, number]>(['99', 0], ['50', 0], ['00', 600_000]);
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: -300, max: 400 }), { minLength: 3, maxLength: 40 }),
        fc.nat(),
        drop,
        (values, pick, [q, v]) => {
          const hole = 1 + (pick % (values.length - 2));
          const metingen = (t0: number) =>
            values.map((value, i) => ({
              ...m,
              Meetwaarde: { Waarde_Alfanumeriek: '', Waarde_Numeriek: i === hole ? v : value },
              Tijdstip: `${new Date(t0 + 3_600_000 + i * 21_600_000).toISOString().slice(0, 23)}+01:00`,
              WaarnemingMetadata: { ...m.WaarnemingMetadata, Kwaliteitswaardecode: i === hole ? q : '00' },
            }));
          // extreme_astro: every kept row, none labelled by us, no hwlw_unlabelled.
          const astro = normaliseTide(alter(base, {}, undefined, metingen(at.fetchedAt)), at, 'extreme_astro');
          expect(astro.tide).toHaveLength(values.length - 1);
          expect(astro.tide?.every((r) => r.hilo === null)).toBe(true);
          expect(astro.dropped.hwlw_unlabelled).toBeUndefined();
          // extreme: nothing stored, the kept values counted.
          const t0 = ext.fetchedAt - 300 * 3_600_000;
          const measured = normaliseTide(alter(measuredList, {}, undefined, metingen(t0)), ext, 'extreme');
          expect(measured.tide).toEqual([]);
          expect(measured.dropped.hwlw_unlabelled).toBe(values.length - 1);
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ----------------------------------------------------------------------------------------------------- #174
// RWS's own high/low label of each astronomical extreme: the GETETTPE type series (`normaliseTideType`), asked just
// before the heights of the same location. Real recordings of 2026-10-17: Vlissingen NAP, Goeree lichteiland MSL.
// No real agger case exists (Hoek van Holland, Maassluis and Vlaardingen alternate fully): the agger case below is
// synthetic, built from the structure of the real bodies.

describe('GETETTPE type series: golden files (real payloads)', () => {
  const V = 'nl-1-hwlw-astro-vlissingen-nap-getettpe';
  const G = 'nl-1-hwlw-astro-goeree-lichteiland-msl-getettpe';
  const H = 'nl-1-hwlw-astro-goeree-lichteiland-msl';
  const typeOf = (name: string) => normaliseTideType(lists(name), ctx(name));
  const split = (out: Normalised) => {
    const labels = out.tideLabels ?? [];
    return [
      labels.length,
      labels.filter((l) => l.hilo === 'high').length,
      labels.filter((l) => l.hilo === 'low').length,
    ];
  };

  it('Vlissingen NAP: 1,546 labels, labels only, never tide or obs', () => {
    const out = typeOf(V);
    expect(out).toEqual(golden(V, out));
    expect(out.obs).toEqual([]);
    expect(out.tide).toBeUndefined();
    expect(out.dropped).toEqual({});
    expect(out.unknown).toBe(0);
    expect(split(out)).toEqual([1546, 773, 773]);
    expect(out.tideLabels?.every((l) => l.series === VLISSINGEN)).toBe(true);
  });

  it('Goeree lichteiland MSL (GETETBRKDMSL2): 1,545 labels on the MSL series', () => {
    const out = typeOf(G);
    expect(out).toEqual(golden(G, out));
    expect(out.dropped).toEqual({});
    expect(split(out)).toEqual([1545, 772, 773]);
    expect(out.tideLabels?.every((l) => l.series === GOEREE)).toBe(true);
  });

  it('the Goeree type labels equal the alternation labels of the Goeree heights on every common instant', () => {
    const labels = new Map(typeOf(G).tideLabels?.map((l) => [l.ts, l.hilo]));
    const heights = tide(H, 'extreme_astro').tide ?? [];
    const common = heights.filter((r) => labels.has(r.ts));
    expect(common).toHaveLength(1544);
    expect(common.every((r) => r.hilo !== null && labels.get(r.ts) === r.hilo)).toBe(true);
    // The windows differ by a few instants at the edges (the two recordings are 11 hours apart).
    expect(labels.size - common.length).toBe(1);
    expect(heights.length - common.length).toBe(2);
  });

  it('Hoek van Holland NAP heights (the classic agger station): the values zigzag, so every row is labelled by alternation', () => {
    const name = 'nl-1-hwlw-astro-hoekvanholland-nap-nvt';
    const out = tide(name, 'extreme_astro');
    expect(out).toEqual(golden(name, out));
    expect(out.dropped).toEqual({});
    const rows = out.tide ?? [];
    expect(rows).toHaveLength(1545);
    expect(rows.every((r) => r.series === 'hoekvanholland/WATHTE/NAP/other:F007')).toBe(true);
    // RWS's astronomical extremes alternate here (no double low): every value is a strict extreme of its neighbours...
    rows.forEach((r, i) => {
      const [a, b] = [rows[i - 1], rows[i + 1]];
      if (a && b) expect((r.value - a.value) * (b.value - r.value) < 0).toBe(true);
    });
    // ...and the largest spacing, 10.1 h (twice), is inside EXTREME_MAX_SPACING_MS (12 h), so none is withheld.
    const gaps = rows.slice(1).map((r, i) => Date.parse(r.ts) - Date.parse((rows[i] as { ts: string }).ts));
    expect(Math.max(...gaps) / 3_600_000).toBeCloseTo(10.1, 1);
    expect(gaps.filter((g) => g > 10 * 3_600_000)).toHaveLength(2);
    expect(rows.every((r) => r.hilo !== null)).toBe(true);
    rows.forEach((r, i) => {
      if (i > 0) expect(r.hilo).not.toBe(rows[i - 1]?.hilo);
      for (const n of [rows[i - 1], rows[i + 1]])
        if (n) expect(r.hilo === 'high' ? r.value > n.value : r.value < n.value).toBe(true);
    });
    expect([rows.filter((r) => r.hilo === 'high').length, rows.filter((r) => r.hilo === 'low').length]).toEqual([
      772, 773,
    ]);
  });
});

describe('GETETTPE type series: drift and drops', () => {
  const name = 'nl-1-hwlw-astro-vlissingen-nap-getettpe';
  const base = lists(name);
  const at = ctx(name);
  const code = (l: readonly Waarnemingen[], c: Context = at) => {
    try {
      return normaliseTideType(l, c);
    } catch (err) {
      return err instanceof SchemaDrift ? err.message : 'other';
    }
  };
  const out = (l: readonly Waarnemingen[], c: Context = at) => code(l, c) as Normalised;
  const first = base[0]?.metingen[0] as Waarnemingen['metingen'][number];
  const stamp = (ms: number) => `${new Date(ms + 3_600_000).toISOString().slice(0, 23)}+01:00`;
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  /** Rows at [offset from the fetch in ms, the word, quality]. */
  const rows = (...entries: [number, string, string?][]) =>
    alter(
      base,
      {},
      undefined,
      entries.map(([o, word, q = '00']) => ({
        ...first,
        Meetwaarde: { Waarde_Alfanumeriek: word, Waarde_Numeriek: 0 },
        Tijdstip: stamp(at.fetchedAt + o),
        WaarnemingMetadata: { ...first.WaarnemingMetadata, Kwaliteitswaardecode: q },
      })),
    );

  it('the provider answering something other than asked is drift, with a fixed code', () => {
    expect(code(alter(base, { Grootheid: 'WATHTE' }))).toBe('tide_quantity');
    expect(code(alter(base, { Typering: 'GETETM' }))).toBe('tide_typering');
    expect(code(alter(base, { Typering: '' }))).toBe('tide_typering');
    expect(code(alter(base, { Eenheid: 'cm' }))).toBe('tide_unit');
    expect(code(alter(base, { Compartiment: 'BS' }))).toBe('tide_compartment');
    expect(code(alter(base, { ProcesType: 'meting' }))).toBe('tide_process');
    expect(code(alter(base, { ProcesType: 'verwachting' }))).toBe('tide_process');
    expect(code(alter(base, { Hoedanigheid: 'NAP' }))).toBe('tide_datum');
    expect(code(alter(base, { Hoedanigheid: 'MSL' }))).toBe('tide_datum');
    for (const g of ['', 'GETETM2', 'GETETMSL2', 'GETETBRKDMSL3', 'constructor', '__proto__'])
      expect([g, code(alter(base, { Groepering: g }))]).toEqual([g, 'tide_grouping']);
    // One bad list among good ones fails the payload.
    expect(code([...base, ...alter(base, { Eenheid: 'm' })])).toBe('tide_unit');
    // A heights list (the other kind of response) is not a type list.
    expect(code(lists('nl-1-hwlw-astro-goeree-lichteiland-msl'))).toBe('tide_quantity');
  });

  it('an unregistered location, a datum the location lacks, a second list and two registered keys are unknown', () => {
    expect(out(alter(base, {}, 'not.a.rws.point'))).toMatchObject({ tideLabels: [], unknown: 1, dropped: {} });
    // vlissingen is registered in NAP: an MSL type list (GETETBRKDMSL2) cannot attach.
    expect(out(alter(base, { Groepering: 'GETETBRKDMSL2' }))).toMatchObject({ tideLabels: [], unknown: 1 });
    expect(out([...alter(base, {}, 'nowhere'), ...alter(base, {}, 'nowhere')])).toMatchObject({ unknown: 1 });
    for (const c of ['constructor', '__proto__', 'toString'])
      expect(out(alter(base, {}, c))).toMatchObject({ unknown: 1 });
    // Two registered keys under one location and datum: no unique series.
    const twice = new Map(registry);
    twice.set('vlissingen/WATHTE/NAP/other:F999', registry.get(VLISSINGEN) as never);
    expect(out(base, { ...at, registry: twice })).toMatchObject({ tideLabels: [], unknown: 1 });
  });

  it('a method other than F012 is withheld and reported per value, never stored', () => {
    for (const m of ['other:F227', 'other:F009', '', 'NVT'])
      expect([m, out(alter(base, { WaardeBepalingsMethode: m }))]).toEqual([
        m,
        expect.objectContaining({ tideLabels: [], dropped: { unregistered_method: 1546 } }),
      ]);
  });

  it('hoogwater is high, laagwater low; any other word is hwlw_type_unknown, counted per value and never kept', () => {
    const o = out(
      rows(
        [0, 'hoogwater'],
        [6 * HOUR, 'laagwater'],
        [12 * HOUR, 'eerste laagwater'],
        [13 * HOUR, 'x'],
        [14 * HOUR, ''],
      ),
    );
    expect(o.tideLabels?.map((l) => l.hilo)).toEqual(['high', 'low']);
    expect(o.dropped).toEqual({ hwlw_type_unknown: 3 });
    expect(JSON.stringify(o)).not.toMatch(/eerste|"x"/);
    // Names on the prototype are no words.
    const p = out(rows([0, 'constructor'], [HOUR, '__proto__'], [2 * HOUR, 'toString'], [3 * HOUR, 'HOOGWATER']));
    expect(p.tideLabels).toEqual([]);
    expect(p.dropped).toEqual({ hwlw_type_unknown: 4 });
    expect(JSON.stringify(p)).not.toMatch(/constructor|proto|toString|HOOGWATER/);
  });

  it('quality and the time window: gap, unknown_quality, before_window, beyond_horizon (edges kept)', () => {
    const o = out(
      rows(
        [0, 'hoogwater', '99'], // gap
        [HOUR, 'hoogwater', '50'], // unknown quality
        [2 * HOUR, 'laagwater', '20'], // a known quality
        [-DAY, 'hoogwater'], // exactly fetch - 1 d: kept
        [-DAY - 1, 'hoogwater'], // before the window
        [401 * DAY, 'laagwater'], // exactly fetch + 401 d: kept
        [401 * DAY + 1, 'laagwater'], // beyond the horizon
      ),
    );
    expect(o.dropped).toEqual({ gap: 1, unknown_quality: 1, before_window: 1, beyond_horizon: 1 });
    expect(o.tideLabels?.map((l) => [l.ts, l.hilo])).toEqual([
      [new Date(at.fetchedAt - DAY).toISOString(), 'high'],
      [new Date(at.fetchedAt + 2 * HOUR).toISOString(), 'low'],
      [new Date(at.fetchedAt + 401 * DAY).toISOString(), 'low'],
    ]);
  });

  it('a repeated label is one row (duplicate); two labels at one instant withhold both (conflict, counted 2)', () => {
    const o = out(
      rows(
        [0, 'hoogwater'],
        [0, 'hoogwater'],
        [6 * HOUR, 'laagwater'],
        [6 * HOUR, 'hoogwater'],
        [12 * HOUR, 'hoogwater'],
      ),
    );
    expect(o.dropped).toEqual({ duplicate: 1, conflict: 2 });
    expect(o.tideLabels?.map((l) => l.hilo)).toEqual(['high', 'high']);
    expect(o.tideLabels).toHaveLength(2);
    // A third statement at a conflicted instant is withheld too.
    expect(out(rows([0, 'hoogwater'], [0, 'laagwater'], [0, 'hoogwater'])).tideLabels).toEqual([]);
    // Two lists of one series state one set of labels, in any order.
    const a = rows([0, 'hoogwater'], [6 * HOUR, 'laagwater']);
    const b = a.map((l) => ({ ...l, metingen: [...l.metingen].reverse() }));
    expect(out([...a, ...b]).tideLabels).toHaveLength(2);
    expect(out([...a, ...b]).dropped).toEqual({ duplicate: 2 });
  });

  it('it never returns tide, obs, zeros or the provider words, whatever the payload', () => {
    const o = out(base);
    expect(o.tide).toBeUndefined();
    expect(o.obs).toEqual([]);
    expect(o.gaugeZeros).toEqual([]);
    expect(JSON.stringify(o)).not.toMatch(/hoogwater|laagwater/);
  });

  it('agger (synthetic, from the real Goeree structure): non-alternating heights get null labels, the type list labels every instant', () => {
    const G = 'nl-1-hwlw-astro-goeree-lichteiland-msl-getettpe';
    const gctx = ctx(G);
    const typeList = lists(G);
    const six = (typeList[0]?.metingen ?? []).slice(0, 6);
    const typeSix = alter(typeList, {}, undefined, six);
    // The same six instants as heights: -80, -75, -60 is a monotone run (a double low, as at an agger).
    const heights = alter(
      lists('nl-1-hwlw-astro-goeree-lichteiland-msl'),
      {},
      undefined,
      six.map((m, i) => ({
        ...m,
        Meetwaarde: { Waarde_Alfanumeriek: '', Waarde_Numeriek: [-70, 100, -80, -75, -60, 95][i] as number },
      })),
    );
    const h = normaliseTide(heights, gctx, 'extreme_astro');
    expect(h.dropped).toEqual({});
    expect(h.tide).toHaveLength(6);
    expect(h.tide?.every((r) => r.hilo === null)).toBe(true);
    const t = normaliseTideType(typeSix, gctx);
    expect(t.dropped).toEqual({});
    expect(t.tideLabels?.map((l) => l.ts)).toEqual(h.tide?.map((r) => r.ts));
    expect(t.tideLabels?.every((l) => l.hilo === 'high' || l.hilo === 'low')).toBe(true);
    expect(t.tideLabels?.map((l) => l.series)).toEqual(h.tide?.map((r) => r.series));
  });
});

describe('GETETTPE type series: property and fuzz tests', () => {
  const name = 'nl-1-hwlw-astro-vlissingen-nap-getettpe';
  const doc = JSON.parse(rawFixture('NL-1', name).body.toString('utf8'));
  const at = ctx(name);
  const CODES = new Set([
    'gap',
    'unknown_quality',
    'before_window',
    'beyond_horizon',
    'hwlw_type_unknown',
    'conflict',
    'duplicate',
    'unregistered_method',
  ]);
  /** Whatever came out is a valid result: labels only, sorted, unique, fixed drop codes, no tide, no obs. */
  const valid = (out: Normalised) => {
    expect(out.obs).toEqual([]);
    expect(out.tide).toBeUndefined();
    const labels = out.tideLabels ?? [];
    expect(labels.every((l) => l.hilo === 'high' || l.hilo === 'low')).toBe(true);
    const keys = labels.map((l) => `${l.series}|${l.ts}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const c of Object.keys(out.dropped)) expect(CODES.has(c)).toBe(true);
  };

  it('a mutated real type payload is either valid or a SchemaDrift, never another exception', () => {
    const mutation = fc.tuple(
      fc.constantFrom('AquoMetadata', 'Locatie', 'MetingenLijst'),
      fc.constantFrom(
        'Grootheid',
        'Typering',
        'Eenheid',
        'Compartiment',
        'Groepering',
        'Hoedanigheid',
        'ProcesType',
        'WaardeBepalingsMethode',
        'Code',
        '0',
        '1',
        '5',
        'Tijdstip',
        'Meetwaarde',
        'WaarnemingMetadata',
      ),
      fc.oneof(
        fc.jsonValue(),
        fc.constantFrom(
          { Code: 'GETETBRKDMSL2', Omschrijving: '' },
          { Code: 'GETETBRKD2', Omschrijving: '' },
          { Code: 'GETETTPE', Omschrijving: '' },
          { Code: 'other:F012', Omschrijving: '' },
          { Code: 'NVT', Omschrijving: '' },
          { Waarde_Alfanumeriek: 'hoogwater', Waarde_Numeriek: 0 },
          { Waarde_Alfanumeriek: 'x', Waarde_Numeriek: 1 },
        ),
      ),
    );
    fc.assert(
      fc.property(mutation, ([part, key, junk]) => {
        const copy = structuredClone(doc);
        const target = copy.WaarnemingenLijst[0][part];
        if (Array.isArray(target) && /^\d$/.test(key)) target[Number(key)] = junk;
        else if (Array.isArray(target)) target[0][key] = junk;
        else target[key] = junk;
        try {
          valid(normaliseTideType(parseWaarnemingen(Buffer.from(JSON.stringify(copy)), TIDE_CAPS), at));
        } catch (err) {
          expect(err).toBeInstanceOf(SchemaDrift);
        }
      }),
      { numRuns: 150 },
    );
  }, 60_000);

  it('arbitrary words, qualities and instants: labels are high or low, unique and sorted', () => {
    const base = parseWaarnemingen(rawFixture('NL-1', name).body, TIDE_CAPS);
    const m = (
      doc.WaarnemingenLijst[0].MetingenLijst as Waarnemingen['metingen']
    )[0] as Waarnemingen['metingen'][number];
    const entry = fc.record({
      word: fc.oneof(fc.constantFrom('hoogwater', 'laagwater'), fc.string({ maxLength: 12 })),
      q: fc.oneof(
        fc.constantFrom('00', '99', '50'),
        fc.nat(99).map((n) => String(n).padStart(2, '0')),
      ),
      hours: fc.integer({ min: -60, max: 410 * 24 }),
    });
    fc.assert(
      fc.property(fc.array(entry, { maxLength: 40 }), (entries) => {
        const metingen = entries.map(({ word, q, hours }) => ({
          ...m,
          Meetwaarde: { Waarde_Alfanumeriek: word, Waarde_Numeriek: 0 },
          Tijdstip: `${new Date(at.fetchedAt + hours * 3_600_000 + 3_600_000).toISOString().slice(0, 23)}+01:00`,
          WaarnemingMetadata: { ...m.WaarnemingMetadata, Kwaliteitswaardecode: q },
        }));
        const out = normaliseTideType(alter(base, {}, undefined, metingen), at);
        valid(out);
        const labels = out.tideLabels ?? [];
        expect(labels.map((l) => l.ts)).toEqual([...labels.map((l) => l.ts)].sort());
      }),
      { numRuns: 300 },
    );
  });
});
