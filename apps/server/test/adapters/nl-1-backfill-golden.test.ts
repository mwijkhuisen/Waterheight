import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { SchemaDrift } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseCheck, parseWaarnemingen, type Waarnemingen } from '../../src/adapters/nl-1/parse.ts';
import { LOAD_ADAPTERS, type LoadContext } from '../../src/load/adapters.ts';
import { goldenUrl, rawFixture, registryOf } from './registry.ts';

// P14a: the NL-1 backfill payloads recorded live on 2026-10-12 (scripts/smoke-capture.ts --backfill / --check),
// run through the loader's own backfill spec (maxAgeMs null) and compared with their goldens (invariant 9).
// `UPDATE_GOLDEN=1` rewrites them. The facts they show are in catalogue §2.1.

const registry = registryOf('NL-1');
const LOBITH_Q = 'lobith.bovenrijn.tolkamer/Q/NVT/other:F230';
const LOBITH_F216 = 'lobith.bovenrijn.tolkamer/Q/NVT/other:F216';
const LITH = 'lith.boven/WATHTE/NAP/other:F007';
const MEGEN_Q = 'megen.maas/Q/NVT/other:F103';
const BORGHAREN_Q = 'maastricht.borgharen.maas.beneden/Q/NVT/other:F006';
/** The rows of a run per series. */
const perSeries = (out: { obs: { series: string }[] }) => {
  const n: Record<string, number> = {};
  for (const o of out.obs) n[o.series] = (n[o.series] ?? 0) + 1;
  return n;
};
/** The recording's own chunk, as the runner's line names it (meta.request, [from, to) at 00:00Z). */
const chunkOf = (name: string): LoadContext['backfill'] => {
  const { request } = rawFixture('NL-1', name).meta as unknown as { request: { from: string; to: string } };
  return { from: Date.parse(`${request.from}T00:00:00Z`), to: Date.parse(`${request.to}T00:00:00Z`) };
};
const run = (name: string, backfill?: LoadContext['backfill'], edit?: (text: string) => string) => {
  const { body: raw, meta } = rawFixture('NL-1', name);
  const body = edit === undefined ? raw : new TextEncoder().encode(edit(new TextDecoder().decode(raw)));
  const ctx: LoadContext = {
    registry,
    fetchedAt: Date.parse(meta.recorded_at),
    variant: '',
    unitMismatch: new Set(),
    ...(backfill === undefined ? {} : { backfill }),
  };
  const loader = LOAD_ADAPTERS['NL-1']?.specs['nl-1-backfill-obs'];
  if (loader === undefined) throw new Error('no nl-1-backfill-obs loader');
  return loader.run(body, ctx) as unknown as {
    obs: { series: string; ts: string; value: number; qc: number }[];
    provider_values: number;
    unknown_values: number;
    dropped: Record<string, number>;
  };
};
function golden(name: string, actual: unknown) {
  const url = goldenUrl('NL-1', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

describe('backfill golden files (real payloads)', () => {
  it('Lobith H, the flood of 1995-01-25 .. 02-05: 265 hourly F007 values, Definitief', () => {
    const out = run('nl-1-backfill-lobith-h-19950125');
    expect(out).toEqual(golden('nl-1-backfill-lobith-h-19950125', out));
    expect(out.obs).toHaveLength(265);
    expect(out.obs[0]?.ts).toBe('1995-01-25T00:00:00.000Z');
    expect(out.provider_values).toBe(265);
    expect(Math.max(...out.obs.map((o) => o.value))).toBe(1666);
  });

  it('Lobith Q 2010 with Hoedanigheid NVT: the hourly F216 list and its daily mean load into their twins (#184 stage 2), the F230 series gets nothing', () => {
    const out = run('nl-1-backfill-lobith-q-20100101');
    expect(out).toEqual(golden('nl-1-backfill-lobith-q-20100101', out));
    expect(out.provider_values).toBe(251);
    // Before stage 2: 241 unregistered_method and 10 processed, no rows.
    expect(perSeries(out)).toEqual({ [LOBITH_F216]: 241, [`${LOBITH_F216}/GEM24H`]: 10 });
    expect(out.dropped).toEqual({});
  });

  it('Lobith H 1960: a daily F009 list, not the live method: nothing is stored', () => {
    const out = run('nl-1-backfill-lobith-h-19600101');
    expect(out).toEqual(golden('nl-1-backfill-lobith-h-19600101', out));
    expect(out.obs).toHaveLength(0);
    expect(out.provider_values).toBe(40);
    expect(out.dropped).toEqual({ unregistered_method: 40 });
  });
});

// #184 stage 2: recorded live on 2026-11-06 (smoke-capture --backfill, five requests) and cut by the committed rule
// (node scripts/trim-fixtures.ts --p184, scripts/lib/trim-nl-1.ts); each run with the recording's own chunk.
describe('history twins and the Megen mislabel (#184 stage 2, real payloads)', () => {
  const twin = (key: string, bewerking?: string) => (bewerking === undefined ? key : `${key}/${bewerking}`);

  it('Megen Q 2024-03-01: the 10-minute readings labelled GEM24H under F103 are the series (D-1), the F006 daily means its twin, nothing processed', () => {
    const name = 'nl-1-backfill-megen-q-20240301';
    const out = run(name, chunkOf(name));
    expect(out).toEqual(golden(name, out));
    expect(perSeries(out)).toEqual({ [MEGEN_Q]: 288, [twin('megen.maas/Q/NVT/other:F006', 'GEM24H')]: 2 });
    expect(out.dropped).toEqual({});
    expect(out.provider_values).toBe(290);
    // The readings keep RWS's status (Ongecontroleerd: the raw bit), as the code before #184 stored them.
    expect(out.obs.filter((o) => o.series === MEGEN_Q).every((o) => (o.qc & 1) === 1)).toBe(true);
    // The F006 means are stamped 12:00+01:00.
    expect(out.obs.filter((o) => o.series !== MEGEN_Q).map((o) => o.ts)).toEqual([
      '2024-03-01T11:00:00.000Z',
      '2024-03-02T11:00:00.000Z',
    ]);
  });

  it('Megen Q at the D-1 boundary: the NVT list to 22:50Z, the readings from 23:00Z fill the series, the F103 daily means go to their twin', () => {
    const name = 'nl-1-backfill-megen-q-20231228';
    const out = run(name, chunkOf(name));
    expect(out).toEqual(golden(name, out));
    const lists = parseWaarnemingen(rawFixture('NL-1', name).body);
    // Two GEM24H lists under F103: the readings (10-minute) and the daily means (one a day).
    const f103 = lists.filter(
      (l) => l.aquo.WaardeBepalingsMethode.Code === 'other:F103' && l.aquo.WaardeBewerkingsMethode.Code === 'GEM24H',
    );
    expect(f103.map((l) => l.metingen.length).sort((a, b) => a - b)).toEqual([2, 150]);
    expect(perSeries(out)).toEqual({
      [MEGEN_Q]: 66 + 150,
      [twin(MEGEN_Q, 'GEM24H')]: 2,
      [twin('megen.maas/Q/NVT/other:F006', 'GEM24H')]: 1,
    });
    expect(out.dropped).toEqual({});
    // A daily mean and a reading share 23:00Z twice; each is in its own series.
    for (const ts of ['2023-12-30T23:00:00.000Z', '2023-12-31T23:00:00.000Z']) {
      const at = out.obs.filter((o) => o.ts === ts);
      expect(at.map((o) => o.series).sort()).toEqual([MEGEN_Q, twin(MEGEN_Q, 'GEM24H')]);
      expect(at[0]?.value).not.toBe(at[1]?.value);
    }
    const series = out.obs.filter((o) => o.series === MEGEN_Q).map((o) => o.ts);
    expect([series[0], series[65], series[66], series.at(-1)]).toEqual([
      '2023-12-30T12:00:00.000Z',
      '2023-12-30T22:50:00.000Z',
      '2023-12-30T23:00:00.000Z',
      '2023-12-31T23:50:00.000Z',
    ]);
  });

  it('Lobith Q 2017-01-01: F230 is the series, the F216 list and its daily mean are its twins', () => {
    const name = 'nl-1-backfill-lobith-q-20170101';
    const out = run(name, chunkOf(name));
    expect(out).toEqual(golden(name, out));
    const n = perSeries(out);
    expect(Object.keys(n).sort()).toEqual([LOBITH_F216, twin(LOBITH_F216, 'GEM24H'), LOBITH_Q]);
    expect([n[LOBITH_Q], n[twin(LOBITH_F216, 'GEM24H')]]).toEqual([288, 2]);
    // F216 carries two gap values (quality 99) in the recording; whatever falls in the cut is dropped as `gap`.
    expect((n[LOBITH_F216] ?? 0) + (out.dropped.gap ?? 0)).toBe(288);
  });

  it('Lith H 1993-09-04 .. 09-09: F001 (hourly) and F007 (from 1993-09-06T23:00Z) with their daily means: the series and three twins', () => {
    const name = 'nl-1-backfill-lith-h-19930904';
    const out = run(name, chunkOf(name));
    expect(out).toEqual(golden(name, out));
    const F001 = 'lith.boven/WATHTE/NAP/other:F001';
    const n = perSeries(out);
    expect(Object.keys(n).sort()).toEqual([F001, twin(F001, 'GEM24H'), LITH, twin(LITH, 'GEM24H')]);
    expect([n[twin(F001, 'GEM24H')], n[twin(LITH, 'GEM24H')]]).toEqual([2, 3]);
    expect(out.obs.find((o) => o.series === LITH)?.ts).toBe('1993-09-06T23:00:00.000Z');
    expect(out.obs.filter((o) => o.series === F001).at(-1)?.ts).toBe('1993-09-06T22:00:00.000Z');
    expect(out.provider_values).toBe(126);
  });

  it('Borgharen Q 2016-03-01: the F006 daily mean comes twice (00:00 and 12:00 +01:00, the same value) and both stamps go to the twin (D-6)', () => {
    const name = 'nl-1-backfill-maastricht-q-20160301';
    const out = run(name, chunkOf(name));
    expect(out).toEqual(golden(name, out));
    // The NVT list carries quality 1004 only (KG-355): nothing of it is stored.
    expect(out.dropped).toEqual({ unknown_quality: 288 });
    const means = out.obs.filter((o) => o.series === twin(BORGHAREN_Q, 'GEM24H'));
    expect(perSeries(out)).toEqual({ [twin(BORGHAREN_Q, 'GEM24H')]: 4 });
    expect(means.map((o) => o.ts)).toEqual([
      '2016-03-01T11:00:00.000Z',
      '2016-03-01T23:00:00.000Z',
      '2016-03-02T11:00:00.000Z',
      '2016-03-02T23:00:00.000Z',
    ]);
    // The day 2016-03-02 (+01:00) is stated at its start (03-01T23:00Z) and at its middle (03-02T11:00Z): one value.
    expect(means[1]?.value).toBe(means[2]?.value);
  });
});

describe('KG-355: older history carries a 4-digit quality code', () => {
  it('Lith H 2003-01-29 .. 03-10: 5,801 provider values: 5,750 stored in the series (Gecontroleerd), 10 code 1004 unknown_quality, the daily means in their twin (#184 stage 2)', () => {
    const win = { from: Date.parse('2003-01-29T00:00:00Z'), to: Date.parse('2003-03-10T00:00:00Z') };
    const out = run('nl-1-backfill-lith-h-20030129', win);
    expect(out).toEqual(golden('nl-1-backfill-lith-h-20030129', out));
    const series = out.obs.filter((o) => o.series === LITH);
    expect(series).toHaveLength(5750);
    expect(series.every((o) => (o.qc & 2) === 2)).toBe(true);
    expect(out.provider_values).toBe(5801);
    // Before stage 2 the 40 daily means (2003-01-29T23:00Z to 03-09T23:00Z) were `processed`.
    expect(perSeries(out)).toEqual({ [LITH]: 5750, [`${LITH}/GEM24H`]: 40 });
    expect(out.dropped).toEqual({ unknown_quality: 10, outside_backfill: 1 });
    // The second list is RWS's daily mean (GEM24H), stamped D 00:00+01:00 on instants the 10-minute list also states,
    // with other values at 26 of them. Before #184 it was merged into the series: those 26 midnights became
    // conflicts and were lost, and the other 14 duplicates. Now every row of the series is the instantaneous value.
    const lists = parseWaarnemingen(rawFixture('NL-1', 'nl-1-backfill-lith-h-20030129').body);
    const at = (list: Waarnemingen) =>
      new Map(list.metingen.map((m) => [Date.parse(m.Tijdstip), m.Meetwaarde.Waarde_Numeriek]));
    const nvt = lists.filter((l) => l.aquo.WaardeBewerkingsMethode.Code === 'NVT').map(at);
    const means = lists.filter((l) => l.aquo.WaardeBewerkingsMethode.Code === 'GEM24H').map(at);
    expect([nvt.length, means.length]).toEqual([1, 1]);
    const stored = new Map(series.map((o) => [Date.parse(o.ts), o.value]));
    // The twin holds the daily means as RWS states them.
    for (const o of out.obs.filter((x) => x.series === `${LITH}/GEM24H`))
      expect(o.value).toBe(means[0]?.get(Date.parse(o.ts)));
    let differing = 0;
    for (const [ts, mean] of means[0] ?? []) {
      expect(stored.get(ts)).toBe(nvt[0]?.get(ts));
      if (mean !== nvt[0]?.get(ts)) differing += 1;
    }
    expect(differing).toBe(26);
  });
});

describe('the load window (review S3)', () => {
  const H95 = 'nl-1-backfill-lobith-h-19950125';
  const balanced = (out: ReturnType<typeof run>) => {
    const dropped = Object.values(out.dropped).reduce((n, v) => n + v, 0) + out.unknown_values;
    expect(out.provider_values).toBe(out.obs.length + dropped);
  };

  it('rows outside the line’s chunk [from, to) are dropped as outside_backfill, and the ledger still balances', () => {
    const from = Date.parse('1995-01-30T00:00:00Z');
    const to = Date.parse('1995-02-01T00:00:00Z');
    const out = run(H95, { from, to });
    expect(out.obs).toHaveLength(48);
    expect(out.obs.every((o) => Date.parse(o.ts) >= from && Date.parse(o.ts) < to)).toBe(true);
    expect(out.dropped.outside_backfill).toBe(265 - 48);
    balanced(out);
  });

  it('rows below the spec floor (1990-01-01) are dropped whatever the line says', () => {
    const out = run(H95, undefined, (t) => t.replaceAll('"1995-', '"1985-'));
    expect(out.provider_values).toBe(265);
    expect(out.obs).toHaveLength(0);
    expect(out.dropped.outside_backfill).toBe(265);
    balanced(out);
  });
});

describe('parseCheck on the recorded answers', () => {
  const body = (name: string) => rawFixture('NL-1', name).body;
  it('1995 is true, 1950 is false', () => {
    expect(parseCheck(body('nl-1-check-lobith-h-1995'))).toBe(true);
    expect(parseCheck(body('nl-1-check-lobith-h-1950'))).toBe(false);
  });

  it('property: only the strings true and false parse; anything else, or a missing key, is drift', () => {
    const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    fc.assert(
      fc.property(
        fc.oneof(fc.constantFrom('true', 'false'), fc.string(), fc.boolean(), fc.integer(), fc.constant(null)),
        (v) => {
          const doc = { Succesvol: true, WaarnemingenAanwezig: v };
          if (v === 'true' || v === 'false') return parseCheck(enc(doc)) === (v === 'true');
          try {
            parseCheck(enc(doc));
            return false;
          } catch (e) {
            return e instanceof SchemaDrift;
          }
        },
      ),
    );
    expect(() => parseCheck(enc({ Succesvol: true }))).toThrow(SchemaDrift);
    expect(() => parseCheck(new Uint8Array())).toThrow(SchemaDrift);
  });
});
