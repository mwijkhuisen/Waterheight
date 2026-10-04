import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  type CanonRun,
  checkRun,
  encodeRun,
  FORECAST_SOURCES,
  type ForecastRunIn,
  firstValid,
  isTail,
  lastValid,
  mergeDecision,
  type Normalised,
  SchemaDrift,
  type SeriesDecl,
  type StoredRun,
  scale,
} from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Context, forecastMethod, normaliseForecast } from '../../src/adapters/nl-1/normalise.ts';
import { parseWaarnemingen, type Waarnemingen } from '../../src/adapters/nl-1/parse.ts';
import { goldenUrl, rawFixture, registryOf } from './registry.ts';

// NL-1 RWS forecasts (P8a): parse + normaliseForecast of real captures exported from the production archive equal
// the committed golden files (invariant 9), consecutive captures of one run are tails of each other and a run change
// is a new run (the merge the loader applies, packages/core mergeDecision, shown here on the real captures in every
// load order), and every drop and drift path. `UPDATE_GOLDEN=1` rewrites the goldens; a golden change is reviewed.

const registry = registryOf('NL-1');
const DECL = FORECAST_SOURCES['NL-1'];
const LOBITH_Q = 'lobith.bovenrijn.tolkamer/Q/NVT/other:F230';
const DRIEL_H = 'driel.beneden/WATHTE/NAP/other:F007';
const MIN = 60_000;

/** Lobith Q (spec nl-1-fc-1h): the last two captures of one run, then the first two of the next (2026-10-01, UTC). */
const Q0425 = 'nl-1-fc-1h-lobith-q-20261001t0425z';
const Q0525 = 'nl-1-fc-1h-lobith-q-20261001t0525z';
const Q0625 = 'nl-1-fc-1h-lobith-q-20261001t0625z';
const Q0725 = 'nl-1-fc-1h-lobith-q-20261001t0725z';
/** Driel beneden H (spec nl-1-fc-3h-0): the last capture of one run, the first of the next and its tail. */
const D0345 = 'nl-1-fc-3h-0-driel-beneden-h-20261001t0345z';
const D0645 = 'nl-1-fc-3h-0-driel-beneden-h-20261001t0645z';
const D0945 = 'nl-1-fc-3h-0-driel-beneden-h-20261001t0945z';
const NOVALUE = 'nl-1-fc-3h-0-alblasserdam-h-novalue';

const ctx = (name: string): Context => ({
  registry,
  fetchedAt: Date.parse(rawFixture('NL-1', name).meta.recorded_at),
});
const lists = (name: string) => parseWaarnemingen(rawFixture('NL-1', name).body);
const run = (name: string) => normaliseForecast(lists(name), ctx(name));
const runsOf = (out: Normalised): ForecastRunIn[] => out.forecasts ?? [];

function golden(name: string, actual: Normalised): Normalised {
  const url = goldenUrl('NL-1', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

/** The capture's one run as the loader's bounds (core checkRun) leave it: nothing dropped. */
function canon(name: string): CanonRun {
  const [r] = runsOf(run(name));
  const checked = checkRun(r as ForecastRunIn, ctx(name).fetchedAt, DECL);
  expect(checked.dropped).toEqual({});
  return checked.run as CanonRun;
}
const sha = (r: CanonRun) => createHash('sha256').update(encodeRun(r)).digest('hex');
const at = (name: string) => ctx(name).fetchedAt;

/** The same lists as if another series had published them. */
const recode = (from: readonly Waarnemingen[], code: string, aquo: Record<string, string> = {}): Waarnemingen[] =>
  from.map((l) => ({
    ...l,
    locatie: { ...l.locatie, Code: code },
    aquo: {
      ...l.aquo,
      ...Object.fromEntries(
        Object.entries(aquo).map(([k, v]) => [k, k === 'ProcesType' ? v : { Code: v, Omschrijving: '' }]),
      ),
    } as Waarnemingen['aquo'],
  }));

/** The store the loader keeps, in memory: the same merge decision, applied to the captures in the given order. */
type Held = StoredRun & { fetchedAt: number };
function load(store: Held[], r: CanonRun, fetchedAt: number): void {
  const hash = sha(r);
  const d = mergeDecision(store, r, hash, DECL.headDrops);
  if (d.kind === 'insert') {
    store.push({ ...r, id: String(store.length), hash, fetchedAt });
  } else if (d.kind === 'same' || d.kind === 'extend') {
    const s = store.find((x) => x.id === d.id) as Held;
    s.fetchedAt = Math.min(s.fetchedAt, fetchedAt);
    if (d.kind === 'extend') {
      s.points = [...d.add, ...s.points];
      s.hash = hash;
    }
  }
}
const permutations = <T>(xs: readonly T[]): T[][] =>
  xs.length <= 1
    ? [[...xs]]
    : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));

describe('golden files (real captures)', () => {
  it('a normal capture (Lobith Q, 2026-10-01T05:25Z): one deterministic run, 143 values on the 10-minute grid', () => {
    const out = run(Q0525);
    expect(out).toEqual(golden(Q0525, out));
    expect(out.obs).toEqual([]);
    expect([out.dropped, out.unknown]).toEqual([{}, 0]);
    const [r, ...rest] = runsOf(out);
    expect(rest).toEqual([]);
    expect(r).toMatchObject({
      series: LOBITH_Q,
      kind: 'deterministic',
      stepMs: 10 * MIN,
      issuedAt: null,
      providerSegmentEnd: null,
    });
    const points = (r as ForecastRunIn).points;
    expect(points).toHaveLength(143);
    // First raw value: "2026-10-01T06:20:00.000+01:00", 540.0, quality 00; last "2026-10-02T06:00:00.000+01:00", 524.0.
    expect(points[0]).toEqual({ ts: '2026-10-01T05:20:00.000Z', value: 540, flags: 0 });
    expect(points.at(-1)).toEqual({ ts: '2026-10-02T05:00:00.000Z', value: 524, flags: 0 });
    // RWS asks T-10 min: the first value is five minutes before the fetch, the last is the run's end at 05:00Z.
    expect(Date.parse(points[0]?.ts as string)).toBe(at(Q0525) - 5 * MIN);
    const ms = points.map((p) => Date.parse(p.ts));
    expect(ms.every((t, i) => i === 0 || t - (ms[i - 1] as number) === 10 * MIN)).toBe(true);
    // The loader's bounds keep every point (nothing is past issue + 48 h + 1 h).
    expect(canon(Q0525).points).toHaveLength(143);
  });

  it('the first capture of a new run (Lobith Q, 06:25Z): a run of its own that ends a day later and differs on the overlap', () => {
    const out = run(Q0625);
    expect(out).toEqual(golden(Q0625, out));
    expect([out.dropped, out.unknown]).toEqual([{}, 0]);
    expect(runsOf(out)[0]?.points).toHaveLength(281);
    const old = canon(Q0525);
    const next = canon(Q0625);
    expect(lastValid(old)).toBe(Date.parse('2026-10-02T05:00:00Z'));
    expect(lastValid(next)).toBe(Date.parse('2026-10-03T05:00:00Z'));
    const oldAt = new Map(old.points.map((p) => [p.ms, p.v[0]]));
    const overlap = next.points.filter((p) => oldAt.has(p.ms));
    expect(overlap.length).toBeGreaterThan(100);
    expect(overlap.filter((p) => oldAt.get(p.ms) !== p.v[0]).length).toBeGreaterThan(0);
    expect(isTail(old, next)).toBe(false);
    expect(isTail(next, old)).toBe(false);
    expect(mergeDecision([{ ...old, id: '1', hash: sha(old) }], next, sha(next), true)).toEqual({ kind: 'insert' });
  });

  it('a 3-hour tier capture (Driel beneden H, 06:45Z): the first capture of a new run, in cm', () => {
    const out = run(D0645);
    expect(out).toEqual(golden(D0645, out));
    expect([out.dropped, out.unknown]).toEqual([{}, 0]);
    expect(runsOf(out)).toHaveLength(1);
    expect(runsOf(out)[0]).toMatchObject({ series: DRIEL_H, kind: 'deterministic', stepMs: 10 * MIN });
    expect(runsOf(out)[0]?.points).toHaveLength(279);
    expect(canon(D0345).points).toHaveLength(153);
    expect(canon(D0945).points).toHaveLength(261);
  });

  it('an all-gap list (Alblasserdam H, quality code 99 on every one of 288 values) at a location the registry does not hold', () => {
    const out = run(NOVALUE);
    expect(out).toEqual(golden(NOVALUE, out));
    // The list is counted unknown and never read: no run, no drop counts.
    expect(out).toEqual({ obs: [], gaugeZeros: [], dropped: {}, unknown: 1, forecasts: [] });
    // The same real values under a registered series: every one is a gap (the placeholder 2147483648 is never
    // scaled), and a run left without a value is no run.
    const registered = normaliseForecast(recode(lists(NOVALUE), 'driel.beneden'), ctx(NOVALUE));
    expect(registered).toEqual({ obs: [], gaugeZeros: [], dropped: { gap: 288 }, unknown: 0, forecasts: [] });
  });

  it('the P1a recording of the 1-hour spec (Lobith Q, 2026-09-29T13:43Z): the run of the days before', () => {
    const out = run('nl-1-fc-1h');
    expect([out.dropped, out.unknown]).toEqual([{}, 0]);
    const [r] = runsOf(out);
    expect(r).toMatchObject({ series: LOBITH_Q, points: expect.any(Array) });
    expect(r?.points).toHaveLength(237);
    expect(r?.points[0]?.ts).toBe('2026-09-29T13:40:00.000Z');
    expect(r?.points.at(-1)?.ts).toBe('2026-10-01T05:00:00.000Z');
  });
});

describe('runs and captures (the real captures through the loader’s merge, in every order)', () => {
  it('consecutive captures of one run are tails of the first; the heads they drop are exactly the hours that passed', () => {
    const [a, b, c, d] = [Q0425, Q0525, Q0625, Q0725].map(canon) as [CanonRun, CanonRun, CanonRun, CanonRun];
    expect(isTail(a, b)).toBe(true);
    expect(isTail(c, d)).toBe(true);
    expect([a, b, c, d].map((r) => r.points.length)).toEqual([149, 143, 281, 275]);
    // One capture an hour: six 10-minute values less.
    expect(a.points.length - b.points.length).toBe(6);
    expect(c.points.length - d.points.length).toBe(6);
    const [e, f, g] = [D0345, D0645, D0945].map(canon) as [CanonRun, CanonRun, CanonRun];
    expect(isTail(f, g)).toBe(true);
    expect(isTail(e, f)).toBe(false);
    // The tail shares its hash input only from its own first value on: its hash is its own.
    expect(sha(a)).not.toBe(sha(b));
    expect(firstValid(b)).toBeGreaterThan(firstValid(a));
  });

  it('the merge: a later capture is that run (same), an earlier one extends it, a new run inserts', () => {
    const [a, b] = [Q0425, Q0525].map(canon) as [CanonRun, CanonRun];
    const held = (r: CanonRun) => [{ ...r, id: '7', hash: sha(r) }];
    expect(mergeDecision(held(a), b, sha(b), true)).toEqual({ kind: 'same', id: '7' });
    const extend = mergeDecision(held(b), a, sha(a), true);
    expect(extend).toMatchObject({ kind: 'extend', id: '7' });
    expect(extend.kind === 'extend' ? extend.add.map((p) => p.ms) : []).toEqual(a.points.slice(0, 6).map((p) => p.ms));
    expect(mergeDecision(held(a), canon(Q0625), sha(canon(Q0625)), true)).toEqual({ kind: 'insert' });
  });

  it('the four Lobith Q captures in any of the 24 orders are the same two runs, each held as its earliest capture', () => {
    const captures = [Q0425, Q0525, Q0625, Q0725].map((name) => ({ name, run: canon(name), at: at(name) }));
    const first = canon(Q0425);
    const next = canon(Q0625);
    for (const order of permutations(captures)) {
      const store: Held[] = [];
      for (const c of order) load(store, c.run, c.at);
      store.sort((x, y) => firstValid(x) - firstValid(y));
      expect(store.map((s) => [firstValid(s), s.hash, s.points.length, s.fetchedAt])).toEqual([
        [firstValid(first), sha(first), 149, at(Q0425)],
        [firstValid(next), sha(next), 281, at(Q0625)],
      ]);
    }
  });

  it('the three Driel captures in any of the 6 orders are two runs; a second pass over them changes nothing', () => {
    const captures = [D0345, D0645, D0945].map((name) => ({ run: canon(name), at: at(name) }));
    for (const order of permutations(captures)) {
      const store: Held[] = [];
      for (const c of order) load(store, c.run, c.at);
      store.sort((x, y) => firstValid(x) - firstValid(y));
      expect(store.map((s) => [s.points.length, s.fetchedAt])).toEqual([
        [153, at(D0345)],
        [279, at(D0645)],
      ]);
      const before = JSON.stringify(store);
      for (const c of order) load(store, c.run, c.at);
      expect(JSON.stringify(store)).toBe(before);
    }
  });
});

describe('synthetic payloads [U]', () => {
  it('a run across the night of 2026-10-25: RWS labels a fixed +01:00, so every instant of 00:00Z to 03:00Z is there once', () => {
    const name = 'nl-1-fc-1h-run-across-dst.synthetic';
    const out = run(name);
    expect([out.dropped, out.unknown]).toEqual([{}, 0]);
    const [r] = runsOf(out);
    expect(r?.points).toHaveLength(287);
    const ms = (r as ForecastRunIn).points.map((p) => Date.parse(p.ts));
    expect(ms.every((t, i) => i === 0 || t - (ms[i - 1] as number) === 10 * MIN)).toBe(true);
    const from = Date.parse('2026-10-25T00:00:00Z');
    const grid = Array.from({ length: 18 }, (_, i) => new Date(from + i * 10 * MIN).toISOString());
    expect(
      (r as ForecastRunIn).points
        .map((p) => p.ts)
        .filter((t) => Date.parse(t) >= from && Date.parse(t) < from + 3 * 60 * MIN),
    ).toEqual(grid);
    // The local label 02:00+01:00 is 01:00Z, the instant the clocks of the Netherlands go back.
    expect(
      JSON.parse(rawFixture('NL-1', name).body.toString('utf8')).WaarnemingenLijst[0].MetingenLijst.some(
        (m: { Tijdstip: string }) => m.Tijdstip === '2026-10-25T02:00:00.000+01:00',
      ),
    ).toBe(true);
    expect(canon(name).points).toHaveLength(287);
  });

  it('split lists with a code 99: merged and sorted, one value per instant, every filter counted, two series', () => {
    const name = 'nl-1-fc-split.synthetic';
    const out = run(name);
    // Lobith Q: list A has 30 values (one gap), list B 20 in reverse order (two instants repeated with the same
    // value, a gap with the placeholder 2147483648, a quality code 25): 29 + 18 - 2 = 45.
    expect(out.dropped).toEqual({ gap: 2, duplicate: 2, unknown_quality: 1 });
    expect(out.unknown).toBe(0);
    const [q, h] = runsOf(out) as [ForecastRunIn, ForecastRunIn];
    expect([q.series, h.series]).toEqual([LOBITH_Q, DRIEL_H]);
    expect(q.points).toHaveLength(45);
    const ts = q.points.map((p) => p.ts);
    expect(ts).toEqual([...new Set(ts)].sort());
    expect(q.points.every((p) => p.flags === 0)).toBe(true);
    // The gap at the fifth instant (value 0.0, code 99) is absent, the repeated instants keep their value.
    const t0 = Date.parse('2026-10-01T05:20:00Z');
    const value = (i: number) => q.points.find((p) => Date.parse(p.ts) === t0 + i * 10 * MIN)?.value;
    expect([value(3), value(4), value(5), value(28), value(29), value(30)]).toEqual([
      503,
      undefined,
      505,
      528,
      529,
      530,
    ]);
    expect([value(40), value(42), value(41), value(43)]).toEqual([undefined, undefined, 541, 543]);
    expect(h.points).toHaveLength(12);
    expect(h.points[0]).toEqual({ ts: '2026-10-01T05:40:00.000Z', value: 600, flags: 0 });
    // The loader's bounds keep both runs whole.
    for (const r of [q, h]) expect(checkRun(r, ctx(name).fetchedAt, DECL).dropped).toEqual({});
  });
});

describe('the forecast method per series (maaseik Q: other:F058)', () => {
  const MAASEIK_Q = 'maaseik/Q/NVT/other:F006';
  // Real captures (the owner's export of 2026-10-03, `import-fixtures --p8a-maaseik`): the last of a run and the first
  // of the next.
  const MAASEIK = 'nl-1-fc-1h-maaseik-q-20261001t0525z';
  const MAASEIK_NEXT = 'nl-1-fc-1h-maaseik-q-20261001t0625z';

  it('the declared method of every forecast series of the seed is the one the recorded catalogue lists for it', () => {
    const cat = JSON.parse(rawFixture('NL-1', 'nl-1-catalogue').body.toString('utf8')) as {
      AquoMetadataLijst: {
        AquoMetadata_MessageID: number;
        ProcesType: string;
        Compartiment: { Code: string };
        Groepering: { Code: string };
        Grootheid: { Code: string };
        Hoedanigheid: { Code: string };
        WaardeBepalingsMethode: { Code: string };
      }[];
      LocatieLijst: { Locatie_MessageID: number; Code: string }[];
      AquoMetadataLocatieLijst: { AquoMetaData_MessageID: number; Locatie_MessageID: number }[];
    };
    const aquo = new Map(cat.AquoMetadataLijst.map((a) => [a.AquoMetadata_MessageID, a]));
    const loc = new Map(cat.LocatieLijst.map((l) => [l.Locatie_MessageID, l.Code]));
    // Only the catalogue rows the adapter would attach (review F1): Grootheid → quantity and its Hoedanigheid,
    // compartment OW, no grouping.
    const attaches = new Map([
      ['WATHTE', ['H', 'NAP']],
      ['Q', ['Q', 'NVT']],
    ]);
    const listed = new Map<string, Set<string>>();
    for (const link of cat.AquoMetadataLocatieLijst) {
      const a = aquo.get(link.AquoMetaData_MessageID);
      const code = loc.get(link.Locatie_MessageID);
      const [qty, datum] = attaches.get(a?.Grootheid.Code ?? '') ?? [];
      if (
        a?.ProcesType !== 'verwachting' ||
        code === undefined ||
        qty === undefined ||
        a.Hoedanigheid.Code !== datum ||
        a.Compartiment.Code !== 'OW' ||
        a.Groepering.Code !== ''
      )
        continue;
      const k = `${code}/${qty}`;
      listed.set(k, new Set([...(listed.get(k) ?? []), a.WaardeBepalingsMethode.Code]));
    }
    const seed = readFileSync(new URL('../../../../registry/seed/nl-1-forecast.csv', import.meta.url), 'utf8')
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith('#'))
      .slice(1)
      .map((l) => l.split(','));
    expect(seed).toHaveLength(196);
    const methods = new Map<string, number>();
    for (const [code, qty] of seed as [string, 'H' | 'Q'][]) {
      const declared = forecastMethod(code, qty);
      expect([code, qty, [...(listed.get(`${code}/${qty}`) ?? [])]]).toEqual([code, qty, [declared]]);
      methods.set(declared, (methods.get(declared) ?? 0) + 1);
    }
    expect(Object.fromEntries(methods)).toEqual({ 'RWSM-F232': 195, 'other:F058': 1 });
    expect(forecastMethod('maaseik', 'Q')).toBe('other:F058');
    expect(forecastMethod('maaseik', 'H')).toBe('RWSM-F232');
  });

  it('real maaseik Q captures under other:F058 equal their goldens: a run on the registered series, then the next one', () => {
    expect(registry.has(MAASEIK_Q)).toBe(true);
    const out = run(MAASEIK);
    expect(out).toEqual(golden(MAASEIK, out));
    expect([out.dropped, out.unknown]).toEqual([{}, 0]);
    expect(runsOf(out).map((r) => [r.series, r.points.length, r.stepMs])).toEqual([[MAASEIK_Q, 143, 10 * MIN]]);
    // First raw value "2026-10-01T06:20:00.000+01:00" (16 m³/s), last "2026-10-02T06:00:00.000+01:00" (7 m³/s).
    expect(runsOf(out)[0]?.points[0]).toEqual({ ts: '2026-10-01T05:20:00.000Z', value: 16, flags: 0 });
    expect(runsOf(out)[0]?.points.at(-1)).toEqual({ ts: '2026-10-02T05:00:00.000Z', value: 7, flags: 0 });
    expect(canon(MAASEIK).points).toHaveLength(143);
    const next = run(MAASEIK_NEXT);
    expect(next).toEqual(golden(MAASEIK_NEXT, next));
    expect(runsOf(next).map((r) => [r.series, r.points.length])).toEqual([[MAASEIK_Q, 287]]);
    // The next day's run ends a day later: never the tail of the earlier capture.
    expect(isTail(canon(MAASEIK), canon(MAASEIK_NEXT))).toBe(false);
  });

  it('the same list under RWSM-F232 is unregistered_method; a maaseik stage list takes RWSM-F232 and refuses F058', () => {
    const n = (lists(MAASEIK)[0] as Waarnemingen).metingen.length;
    const f232 = recode(lists(MAASEIK), 'maaseik', { WaardeBepalingsMethode: 'RWSM-F232' });
    expect(normaliseForecast(f232, ctx(MAASEIK))).toEqual({
      obs: [],
      gaugeZeros: [],
      dropped: { unregistered_method: n },
      unknown: 0,
      forecasts: [],
    });
    const h = lists(D0645);
    const stage = (WaardeBepalingsMethode: string) =>
      normaliseForecast(recode(h, 'maaseik', { WaardeBepalingsMethode }), ctx(D0645));
    expect(runsOf(stage('RWSM-F232')).map((r) => r.series)).toEqual(['maaseik/WATHTE/NAP/other:F007']);
    expect(stage('other:F058').dropped).toEqual({ unregistered_method: (h[0] as Waarnemingen).metingen.length });
  });
});

describe('what a forecast list is, and what is only counted', () => {
  const base = ctx(Q0525);
  const q = lists(Q0525);
  const h = lists(D0645);
  const norm = (l: readonly Waarnemingen[], c: Context = base) => normaliseForecast(l, c);

  it('only ProcesType verwachting is read: a list of any other ProcesType is drift of the whole payload', () => {
    const code = (l: readonly Waarnemingen[]) => {
      try {
        norm(l);
      } catch (err) {
        return err instanceof SchemaDrift ? err.code : 'other';
      }
      return 'parsed';
    };
    expect(code(q)).toBe('parsed');
    for (const ProcesType of ['meting', 'astronomisch', '']) {
      expect([ProcesType, code(recode(q, 'lobith.bovenrijn.tolkamer', { ProcesType }))]).toEqual([
        ProcesType,
        'forecast_process',
      ]);
    }
    // One wrong list among good ones fails the payload, and it does not matter which comes first.
    const bad = recode(h, 'driel.beneden', { ProcesType: 'meting' });
    expect(code([...q, ...bad])).toBe('forecast_process');
    expect(code([...bad, ...q])).toBe('forecast_process');
    // Before anything is stored a wrong list is drift even under a location the registry does not hold.
    expect(code(recode(q, 'nowhere', { ProcesType: 'meting' }))).toBe('forecast_process');
  });

  it('the method is declared per series: a list under another method is unregistered_method, never drift, and the rest loads', () => {
    const n = (q[0] as Waarnemingen).metingen.length;
    for (const WaardeBepalingsMethode of ['other:F230', 'RWSM-F233', 'other:F058', 'constructor', '']) {
      expect([
        WaardeBepalingsMethode,
        norm(recode(q, 'lobith.bovenrijn.tolkamer', { WaardeBepalingsMethode })),
      ]).toEqual([
        WaardeBepalingsMethode,
        { obs: [], gaugeZeros: [], dropped: { unregistered_method: n }, unknown: 0, forecasts: [] },
      ]);
    }
    // The payload's other lists still load, in either order.
    const bad = recode(q, 'lobith.bovenrijn.tolkamer', { WaardeBepalingsMethode: 'RWSM-F233' });
    for (const l of [
      [...bad, ...h],
      [...h, ...bad],
    ]) {
      const out = norm(l);
      expect(out.dropped).toEqual({ unregistered_method: n });
      expect(runsOf(out).map((r) => r.series)).toEqual([DRIEL_H]);
    }
    // A series the registry does not attach to stays unknown whatever its method (the method is never asked).
    expect(norm(recode(q, 'nowhere', { WaardeBepalingsMethode: 'other:F058' }))).toMatchObject({
      dropped: {},
      unknown: 1,
    });
    // The method comes before the unit, as for observations.
    expect(
      norm(recode(q, 'lobith.bovenrijn.tolkamer', { WaardeBepalingsMethode: 'x', Eenheid: 'cm' })).dropped,
    ).toEqual({
      unregistered_method: n,
    });
  });

  it('a time with another offset is drift', () => {
    const [list] = q as [Waarnemingen];
    const first = list.metingen[0] as Waarnemingen['metingen'][number];
    const drift = (Tijdstip: string) => {
      try {
        norm([{ ...list, metingen: [{ ...first, Tijdstip }] }]);
      } catch (err) {
        return err instanceof SchemaDrift ? err.code : 'other';
      }
      return 'parsed';
    };
    expect(drift('2026-10-01T06:20:00.000+01:00')).toBe('parsed');
    expect(drift('2026-10-01T06:20:00.000+02:00')).toMatch(/^time_/);
    expect(drift('2026-10-01T05:20:00.000Z')).toMatch(/^time_/);
    expect(drift('not a time')).toMatch(/^time_/);
  });

  it('a series the registry does not attach to is counted once, never registered, whatever it publishes', () => {
    // 125 of the 196 forecast locations are not stored (decision 1 of P8a): coastal and estuary points, IJsselmeer,
    // the stale arnhem.nederrijn Q and driel.boven Q, tiel.sluis.waal Q.
    for (const code of ['sasvangent', 'nowhere', 'arnhem.nederrijn', 'tiel.sluis.waal', 'constructor', '__proto__']) {
      expect([code, norm(recode(q, code))]).toEqual([
        code,
        { obs: [], gaugeZeros: [], dropped: {}, unknown: 1, forecasts: [] },
      ]);
    }
    // Two lists of one unregistered series are one series; two series are two.
    expect(norm([...recode(q, 'nowhere'), ...recode(q, 'nowhere')]).unknown).toBe(1);
    expect(norm([...recode(q, 'nowhere'), ...recode(h, 'nowhere')]).unknown).toBe(2);
    // A stage list at another registered location attaches there; a Q list at a location with no Q series does not.
    expect(norm(recode(h, 'lobith.bovenrijn.tolkamer')).forecasts).toHaveLength(1);
    expect(norm(recode(q, 'driel.beneden')).unknown).toBe(1);
  });

  it('only the registered NAP stage and Q series attach: not the TAW twin, another datum, quantity, compartment or grouping', () => {
    const taw = recode(h, 'eijsden.grens', { Hoedanigheid: 'TAW' });
    expect(registry.has('eijsden.grens/WATHTE/TAW/other:F007')).toBe(true);
    expect(registry.has('eijsden.grens/WATHTE/NAP/other:F007')).toBe(true);
    // The TAW twin is registered, but a forecast never attaches to it; the NAP series of the same gauge does.
    expect(norm(taw)).toMatchObject({ unknown: 1, forecasts: [] });
    expect(norm(recode(h, 'eijsden.grens')).forecasts?.map((r) => r.series)).toEqual([
      'eijsden.grens/WATHTE/NAP/other:F007',
    ]);
    for (const aquo of [
      { Hoedanigheid: 'NVT' },
      { Compartiment: 'BS' },
      { Groepering: 'GETETM2' },
      { Grootheid: 'STROOMSHD' },
    ]) {
      expect([aquo, norm(recode(h, 'driel.beneden', aquo))]).toEqual([
        aquo,
        { obs: [], gaugeZeros: [], dropped: {}, unknown: 1, forecasts: [] },
      ]);
    }
    expect(norm(recode(q, 'lobith.bovenrijn.tolkamer', { Hoedanigheid: 'NAP' })).unknown).toBe(1);
  });

  it('two registered series under one location and quantity are no one series: unknown, never a guess', () => {
    const twice: ReadonlyMap<string, SeriesDecl> = new Map([
      ...registry,
      [LOBITH_Q.replace('F230', 'F999'), registry.get(LOBITH_Q) as SeriesDecl],
    ]);
    expect(norm(q, { ...base, registry: twice })).toMatchObject({ unknown: 1, forecasts: [] });
    expect(norm(q).forecasts).toHaveLength(1);
  });

  it('the unit is the forecast declaration’s, per quantity: another unit or the other quantity’s is unit_mismatch', () => {
    const n = (q[0] as Waarnemingen).metingen.length;
    const mismatch = (l: readonly Waarnemingen[]) => norm(l).dropped;
    for (const Eenheid of ['cm', 'm', 'l/s', 'm3/d', 'constructor', '__proto__', '']) {
      expect([Eenheid, mismatch(recode(q, 'lobith.bovenrijn.tolkamer', { Eenheid }))]).toEqual([
        Eenheid,
        { unit_mismatch: n },
      ]);
    }
    expect(mismatch(recode(h, 'driel.beneden', { Eenheid: 'm3/s' }))).toEqual({
      unit_mismatch: (h[0] as Waarnemingen).metingen.length,
    });
    // The declaration lists both spellings of the discharge unit; a stage is cm only.
    expect(norm(recode(q, 'lobith.bovenrijn.tolkamer', { Eenheid: 'm³/s' }))).toMatchObject({ dropped: {} });
    expect(norm(recode(q, 'lobith.bovenrijn.tolkamer', { Eenheid: 'm³/s' })).forecasts).toHaveLength(1);
    expect(norm(recode(h, 'driel.beneden', { Eenheid: 'm³/s' })).dropped).toEqual({
      unit_mismatch: (h[0] as Waarnemingen).metingen.length,
    });
    // The registered observation series is never asked: a Q series declared in another unit changes nothing here.
    const odd: ReadonlyMap<string, SeriesDecl> = new Map([
      ...registry,
      [LOBITH_Q, { ...(registry.get(LOBITH_Q) as SeriesDecl), native_unit: 'l/s', to_canonical: 0.001 }],
    ]);
    expect(norm(q, { ...base, registry: odd }).forecasts?.[0]?.points[0]?.value).toBe(540);
  });

  const withFirst = (change: (m: Waarnemingen['metingen'][number]) => Waarnemingen['metingen'][number]) => {
    const [list] = q as [Waarnemingen];
    return [{ ...list, metingen: list.metingen.map((m, i) => (i === 0 ? change(m) : m)) }];
  };

  it('quality: 99 is a gap whatever the value; 00 is kept; every other code is withheld and counted', () => {
    const withCode = (Kwaliteitswaardecode: string, Waarde_Numeriek = 540) =>
      norm(
        withFirst((m) => ({
          ...m,
          Meetwaarde: { ...m.Meetwaarde, Waarde_Numeriek },
          WaarnemingMetadata: { ...m.WaarnemingMetadata, Kwaliteitswaardecode },
        })),
      );
    for (const value of [0, 540, 2147483648]) {
      const out = withCode('99', value);
      expect([value, out.dropped, out.forecasts?.[0]?.points.length]).toEqual([value, { gap: 1 }, 142]);
    }
    expect(withCode('00').dropped).toEqual({});
    for (const code of ['10', '20', '25', '30', '40', '50', '98', '31', '01']) {
      expect([code, withCode(code).dropped]).toEqual([code, { unknown_quality: 1 }]);
    }
    // A real zero with a normal code is a value (a small stream can stand still).
    expect(withCode('00', 0).forecasts?.[0]?.points[0]).toEqual({ ts: '2026-10-01T05:20:00.000Z', value: 0, flags: 0 });
  });

  it('no value is "in the future" or "too old": a forecast is both by nature', () => {
    const [r0] = runsOf(norm(q));
    for (const days of [-90, 0, 90]) {
      const out = norm(q, { ...base, fetchedAt: base.fetchedAt + days * 86_400_000 });
      expect([days, out.dropped, runsOf(out)[0]?.points.length]).toEqual([days, {}, r0?.points.length]);
    }
    // Hours ahead, a day ahead, past the end of any horizon: the adapter keeps them (core checkRun bounds the run).
    const far = withFirst((m) => ({ ...m, Tijdstip: '2026-12-31T06:20:00.000+01:00' }));
    expect(norm(far).dropped).toEqual({});
    expect(runsOf(norm(far))[0]?.points.at(-1)?.ts).toBe('2026-12-31T05:20:00.000Z');
    expect(checkRun(runsOf(norm(far))[0] as ForecastRunIn, base.fetchedAt, DECL).dropped).toEqual({
      beyond_horizon: 1,
    });
  });

  it('two statements of one instant: the same value is one row; different values are withheld, in any order', () => {
    const [list] = q as [Waarnemingen];
    const first = list.metingen[0] as Waarnemingen['metingen'][number];
    const other = { ...first, Meetwaarde: { ...first.Meetwaarde, Waarde_Numeriek: 1 } };
    const of = (...metingen: Waarnemingen['metingen']) => norm([{ ...list, metingen }]);
    expect(of(first, first)).toMatchObject({ dropped: { duplicate: 1 } });
    expect(of(first, first).forecasts?.[0]?.points).toEqual([{ ts: '2026-10-01T05:20:00.000Z', value: 540, flags: 0 }]);
    for (const order of [
      [first, other],
      [other, first],
      [first, other, first],
      [first, first, other],
      [other, first, first, other],
    ]) {
      const out = of(...order);
      expect(out.forecasts).toEqual([]);
      // Every statement of the instant is counted: as a conflict, or as the duplicate it first was.
      expect((out.dropped.conflict ?? 0) + (out.dropped.duplicate ?? 0)).toBe(order.length);
      expect(out.dropped.conflict).toBeGreaterThan(0);
    }
    // The other instants of the list survive a conflict.
    const two = of(first, other, ...list.metingen.slice(1));
    expect(two.forecasts?.[0]?.points).toHaveLength(list.metingen.length - 1);
  });

  it('a list with no values, or none left, is no run; an out-of-range value is drift', () => {
    const [list] = q as [Waarnemingen];
    expect(norm([{ ...list, metingen: [] }])).toEqual({
      obs: [],
      gaugeZeros: [],
      dropped: {},
      unknown: 0,
      forecasts: [],
    });
    expect(norm([])).toEqual({ obs: [], gaugeZeros: [], dropped: {}, unknown: 0, forecasts: [] });
    const first = list.metingen[0] as Waarnemingen['metingen'][number];
    const big = { ...first, Meetwaarde: { ...first.Meetwaarde, Waarde_Numeriek: 1e300 } };
    expect(() => norm([{ ...list, metingen: [big] }])).toThrow(SchemaDrift);
  });

  it('the strict schema is the observations’: an unknown key or status and a failed answer are drift', () => {
    const doc = () => JSON.parse(rawFixture('NL-1', Q0525).body.toString('utf8'));
    const drift = (change: (d: ReturnType<typeof doc>) => void) => {
      const d = doc();
      change(d);
      try {
        norm(parseWaarnemingen(Buffer.from(JSON.stringify(d))));
      } catch (err) {
        if (err instanceof SchemaDrift) return err.code;
        throw err;
      }
      return 'parsed';
    };
    expect(drift(() => {})).toBe('parsed');
    expect(drift((d) => (d.WaarnemingenLijst[0].MetingenLijst[2].Extra = 1))).toBe('unrecognized_keys');
    expect(drift((d) => (d.WaarnemingenLijst[0].MetingenLijst[2].WaarnemingMetadata.Statuswaarde = 'Voorlopig'))).toBe(
      'invalid_value',
    );
    expect(drift((d) => (d.Succesvol = false))).toBe('invalid_value');
    expect(drift((d) => (d.WaarnemingenLijst[0].AquoMetadata.ProcesType = 'meting'))).toBe('forecast_process');
  });
});

describe('property and fuzz tests', () => {
  const name = Q0525;
  const base = ctx(name);
  const [template] = lists(name) as [Waarnemingen];
  const first = template.metingen[0] as Waarnemingen['metingen'][number];
  const slot = Math.floor(base.fetchedAt / 600_000) * 600_000;
  const known = '00';
  const meting = fc
    .record({
      // 100 steps back to 280 ahead (about 46 hours), on the 10-minute grid, with few distinct instants so that
      // statements of one instant meet.
      step: fc.integer({ min: -100, max: 280 }).map((n) => n - (n % 5)),
      value: fc.oneof(
        fc.integer({ min: 0, max: 9000 }),
        fc.constant(0),
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
      ),
      quality: fc.constantFrom('00', '00', '00', '99', '99', '10', '25', '50'),
      status: fc.constantFrom('Ongecontroleerd', 'Gecontroleerd', 'Definitief'),
    })
    .map(({ step, value, quality, status }) => ({
      ms: slot + step * 600_000,
      quality,
      value,
      meting: {
        ...first,
        Tijdstip: `${new Date(slot + step * 600_000 + 3_600_000).toISOString().slice(0, 23)}+01:00`,
        Meetwaarde: { Waarde_Alfanumeriek: String(value), Waarde_Numeriek: value },
        WaarnemingMetadata: { ...first.WaarnemingMetadata, Kwaliteitswaardecode: quality, Statuswaarde: status },
      } as Waarnemingen['metingen'][number],
    }));
  const payload = fc.array(fc.array(meting, { maxLength: 60 }), { minLength: 1, maxLength: 4 });
  const toLists = (groups: { meting: Waarnemingen['metingen'][number] }[][]): Waarnemingen[] =>
    groups.map((g) => ({ ...template, metingen: g.map((x) => x.meting) }));

  it('a run is sorted, has one value per instant, never a gap or an unreadable code, and passes the loader’s bounds', () => {
    fc.assert(
      fc.property(payload, (groups) => {
        const out = normaliseForecast(toLists(groups), base);
        const all = groups.flat();
        const runs = runsOf(out);
        expect(runs.length).toBeLessThanOrEqual(1);
        for (const r of runs) {
          expect(r).toMatchObject({ series: LOBITH_Q, kind: 'deterministic', stepMs: 600_000, issuedAt: null });
          const times = r.points.map((p) => p.ts);
          expect(times).toEqual([...new Set(times)].sort());
          for (const p of r.points) {
            const ms = Date.parse(p.ts);
            expect(p.flags).toBe(0);
            // Every stored point is a statement of the payload with the readable code, never a 99, and no other
            // value was stated for that instant.
            const stated = all.filter((x) => x.ms === ms && x.quality === known);
            expect([...new Set(stated.map((x) => scale(1, x.value)))]).toEqual([p.value]);
          }
          const checked = checkRun(r, base.fetchedAt, DECL);
          expect([checked.dropped, checked.run?.points.length]).toEqual([{}, r.points.length]);
        }
        // Every gap and every refused code is counted, whatever else is stated at its instant.
        expect(out.dropped.gap ?? 0).toBe(all.filter((x) => x.quality === '99').length);
        expect(out.dropped.unknown_quality ?? 0).toBe(
          all.filter((x) => x.quality !== known && x.quality !== '99').length,
        );
        // The same lists again are the same run.
        expect(runsOf(normaliseForecast([...toLists(groups), ...toLists(groups)], base))).toEqual(runs);
      }),
      { numRuns: 200 },
    );
  });

  it('the run does not depend on how the values are split into lists or on their order', () => {
    fc.assert(
      fc.property(payload, fc.integer({ min: 0, max: 1_000_000 }), (groups, seed) => {
        const all = groups.flat();
        const shuffled = all
          .map((x, i) => ({ x, k: (Math.imul(i + 1, seed + 0x9e3779b1) >>> 0) % 1009 }))
          .sort((a, b) => a.k - b.k)
          .map((e) => e.x);
        const half = Math.floor(shuffled.length / 2);
        const regrouped = [shuffled.slice(0, half), shuffled.slice(half)];
        expect(runsOf(normaliseForecast(toLists(regrouped), base))).toEqual(
          runsOf(normaliseForecast(toLists(groups), base)),
        );
      }),
      { numRuns: 200 },
    );
  });

  it('a capture that drops the head of a run is its tail, and the merge holds it as one run in any order', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 9000 }), { minLength: 3, maxLength: 80 }),
        fc.array(fc.integer({ min: 1, max: 12 }), { minLength: 1, maxLength: 4 }),
        (values, cuts) => {
          const stated = (from: number) =>
            values.slice(from).map((value, i) => ({
              ...first,
              Tijdstip: `${new Date(slot + (from + i) * 600_000 + 3_600_000).toISOString().slice(0, 23)}+01:00`,
              Meetwaarde: { Waarde_Alfanumeriek: String(value), Waarde_Numeriek: value },
            }));
          const heads = [0, ...cuts.map((c) => Math.min(c, values.length - 1))];
          const captures = [...new Set(heads)].map((from, i) => ({
            run: checkRun(
              runsOf(normaliseForecast([{ ...template, metingen: stated(from) }], base))[0] as ForecastRunIn,
              base.fetchedAt,
              DECL,
            ).run as CanonRun,
            at: base.fetchedAt + i * 3_600_000,
          }));
          const results = new Set<string>();
          for (const order of [captures, [...captures].reverse(), [...captures.slice(1), ...captures.slice(0, 1)]]) {
            const store: Held[] = [];
            for (const c of order) load(store, c.run, c.at);
            results.add(JSON.stringify(store.map((s) => [firstValid(s), s.hash, s.points.length, s.fetchedAt])));
          }
          expect(results.size).toBe(1);
          const whole = captures[0] as { run: CanonRun };
          expect(JSON.parse([...results][0] as string)).toEqual([
            [firstValid(whole.run), sha(whole.run), whole.run.points.length, base.fetchedAt],
          ]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('a mutated real payload is either still valid or a SchemaDrift, never a crash or a wrong run', () => {
    const doc = JSON.parse(rawFixture('NL-1', name).body.toString('utf8'));
    const mutation = fc.tuple(
      fc.constantFrom('AquoMetadata', 'Locatie', 'MetingenLijst'),
      fc.constantFrom('Grootheid', 'Eenheid', 'Code', 'Lat', '0', '3', 'Tijdstip', 'Meetwaarde', 'WaarnemingMetadata'),
      fc.jsonValue(),
    );
    fc.assert(
      fc.property(mutation, ([part, key, junk]) => {
        const copy = structuredClone(doc);
        const target = copy.WaarnemingenLijst[0][part];
        if (Array.isArray(target) && /^\d$/.test(key)) target[Number(key)] = junk;
        else if (Array.isArray(target)) target[0][key] = junk;
        else target[key] = junk;
        try {
          const out = normaliseForecast(parseWaarnemingen(Buffer.from(JSON.stringify(copy))), base);
          for (const r of runsOf(out)) expect(checkRun(r, base.fetchedAt, DECL).run).not.toBeNull();
        } catch (err) {
          expect(err).toBeInstanceOf(SchemaDrift);
        }
      }),
      { numRuns: 300 },
    );
  });
});
