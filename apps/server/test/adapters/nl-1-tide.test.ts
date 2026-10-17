import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { type Normalised, SchemaDrift } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Context, normalise, normaliseTide, type TideKind } from '../../src/adapters/nl-1/normalise.ts';
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

  it('labels: a series that does not alternate stores nothing, counted by its values (hwlw_unlabelled)', () => {
    const none = (n: number) => ({ hilo: [], dropped: { hwlw_unlabelled: n } });
    expect(labels([50])).toEqual(none(1));
    expect(labels([10, 10, 90])).toEqual(none(3)); // equal neighbours
    expect(labels([10, 90, 95, 20])).toEqual(none(4)); // two highs in a row (monotone run)
    expect(labels([90, 10, 20, 95])).toEqual(none(4)); // an agger's double low
    expect(labels([10, 90, 20, 20])).toEqual(none(4));
  });

  it('labels do not leak across series: one bad series leaves the other stored', () => {
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
    expect(out.tide?.map((r) => r.series)).toEqual([GOEREE, GOEREE, GOEREE]);
    expect(out.dropped).toEqual({ hwlw_unlabelled: 3 });
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
    const rows = (...offsets: number[]) =>
      offsets.map((o) => ({
        ...m,
        Tijdstip: stamp(at.fetchedAt + o),
        Meetwaarde: { Waarde_Alfanumeriek: '1', Waarde_Numeriek: o },
      }));
    const p = (kind: TideKind, ...offsets: number[]) => {
      const out = normaliseTide(
        alter(base, kind === 'astro' ? { Groepering: '' } : {}, undefined, rows(...offsets)),
        at,
        kind,
      );
      return [out.tide?.length, out.dropped];
    };
    const measuredList = lists('nl-1-hwlw-vlissingen-nap-measured.synthetic');
    // extreme: 16 minutes ahead is future, 46 days back is too old.
    const measured = normaliseTide(
      alter(measuredList, {}, undefined, rows(16 * 60_000, -46 * day, -day, 0)),
      at,
      'extreme',
    );
    expect([measured.tide?.length, measured.dropped]).toEqual([2, { future: 1, too_old: 1 }]);
    // astronomical: up to fetch + P400D + P1D and from fetch - P1D.
    expect(p('astro', 400 * day, 401 * day + 1, -day, -day - 1, 1)).toEqual([
      3,
      { beyond_horizon: 1, before_window: 1 },
    ]);
    expect(p('extreme_astro', 400 * day + 5, 402 * day)[1]).toEqual({ beyond_horizon: 1, hwlw_unlabelled: 1 });
    // maxAgeMs null: nothing is too old (a catch-up).
    const old = normaliseTide(
      alter(measuredList, {}, undefined, rows(-100 * day, -day)),
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
            if (kind === 'astro') expect(r.hilo).toBeNull();
            else {
              expect(r.hilo).not.toBeNull();
              const prev = rows[i - 1];
              if (prev && prev.series === r.series) expect(r.hilo).not.toBe(prev.hilo);
            }
          });
        } catch (err) {
          expect(err).toBeInstanceOf(SchemaDrift);
        }
      }),
      { numRuns: 100 },
    );
  }, 60_000);

  it('arbitrary value sequences: labelled rows alternate and are strict extremes, else nothing is stored', () => {
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
        if (rows.length === 0) return;
        expect(rows.map((r) => r.value)).toEqual(values);
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
});
