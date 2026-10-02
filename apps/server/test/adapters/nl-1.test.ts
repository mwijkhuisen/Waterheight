import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { type Normalised, ObsRow, QC, SchemaDrift, scale } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Context, normalise, STALE_SERIES } from '../../src/adapters/nl-1/normalise.ts';
import { JSON_CAPS, parseWaarnemingen, type Waarnemingen } from '../../src/adapters/nl-1/parse.ts';
import { goldenUrl, rawFixture, registryOf } from './registry.ts';

// NL-1 RWS observations: parse + normalise of real recorded payloads equals
// the committed golden files (invariant 9). `UPDATE_GOLDEN=1` rewrites them; a
// golden change is reviewed like code.

const registry = registryOf('NL-1');
/** The registered key of a `<code>/<Grootheid>/<Hoedanigheid>`: its method is the registry's to state. */
const keyOf = (combination: string): string => {
  const keys = [...registry.keys()].filter((k) => k.startsWith(`${combination}/`));
  if (keys.length !== 1) throw new Error(`${combination}: ${keys.length} registered series`);
  return keys[0] as string;
};
const LOBITH_H = 'lobith.bovenrijn.tolkamer/WATHTE/NAP/other:F007';
const LOBITH_Q = 'lobith.bovenrijn.tolkamer/Q/NVT/other:F230';
const EIJSDEN_NAP = 'eijsden.grens/WATHTE/NAP/other:F007';
const EIJSDEN_TAW = 'eijsden.grens/WATHTE/TAW/other:F007';
const EIJSDEN_Q = 'eijsden.grens/Q/NVT/other:F216';

const ctx = (name: string): Context => ({
  registry,
  fetchedAt: Date.parse(rawFixture('NL-1', name).meta.recorded_at),
});
const lists = (name: string) => parseWaarnemingen(rawFixture('NL-1', name).body);
const run = (name: string) => normalise(lists(name), ctx(name));

function golden(name: string, actual: Normalised): Normalised {
  const url = goldenUrl('NL-1', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

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

describe('golden files (real payloads)', () => {
  it('a level series (Lobith H, 16 values): +01:00 all year, quality code 25 kept without a bit', () => {
    const out = run('nl-1-obs-key');
    expect(out).toEqual(golden('nl-1-obs-key', out));
    expect(out.obs).toHaveLength(16);
    // First raw value: "2026-09-29T11:50:00.000+01:00", 610.0, Kwaliteitswaardecode "25", Ongecontroleerd.
    expect(out.obs[0]).toEqual({ series: LOBITH_H, ts: '2026-09-29T10:50:00.000Z', value: 610, qc: QC.RAW });
    expect(out.obs.at(-1)).toEqual({ series: LOBITH_H, ts: '2026-09-29T13:20:00.000Z', value: 607, qc: QC.RAW });
    expect(out.dropped).toEqual({});
    expect(out.unknown).toBe(0);
  });

  it('a discharge series (Lobith Q, method F230, m3/s)', () => {
    const out = run('nl-1-obs-other-lobith-bovenrijn-tolkamer-q');
    expect(out).toEqual(golden('nl-1-obs-other-lobith-bovenrijn-tolkamer-q', out));
    expect(out.obs).toHaveLength(35);
    // First raw value: "2026-09-30T10:50:00.000+01:00", 544.32.
    expect(out.obs[0]).toEqual({ series: LOBITH_Q, ts: '2026-09-30T09:50:00.000Z', value: 544.32, qc: QC.RAW });
    expect(out.dropped).toEqual({});
  });

  it('the Eijsden-grens pair: NAP, and the TAW twin 233 cm above it at every timestamp', () => {
    const nap = run('nl-1-obs-key-eijsden-grens-h');
    const taw = run('nl-1-obs-twin');
    expect(nap).toEqual(golden('nl-1-obs-key-eijsden-grens-h', nap));
    expect(taw).toEqual(golden('nl-1-obs-twin', taw));
    expect(nap.obs).toHaveLength(17);
    expect(taw.obs).toHaveLength(17);
    // First raw values: NAP "2026-09-30T13:50:00.000+01:00" 4409.0, TAW 4642.0.
    expect(nap.obs[0]).toEqual({ series: EIJSDEN_NAP, ts: '2026-09-30T12:50:00.000Z', value: 4409, qc: QC.RAW });
    expect(taw.obs[0]).toEqual({ series: EIJSDEN_TAW, ts: '2026-09-30T12:50:00.000Z', value: 4642, qc: QC.RAW });
    const napAt = new Map(nap.obs.map((r) => [r.ts, r.value]));
    for (const r of taw.obs) expect(r.value - (napAt.get(r.ts) as number)).toBe(233);
    expect(taw.dropped).toEqual({});
  });

  it('Driel Q: 35 values of quality code 99 with 0.0, on a series we never store', () => {
    const out = run('nl-1-obs-other-driel-boven-q');
    expect(out).toEqual(golden('nl-1-obs-other-driel-boven-q', out));
    expect(out).toEqual({ obs: [], gaugeZeros: [], dropped: { stale_series: 35 }, unknown: 0 });
    // The same 35 real values under a registered series: every one is a gap, none is stored as 0.0.
    const megen = keyOf('megen.maas/Q/NVT');
    const method = megen.split('/')[3] as string;
    const asMegen = recode(lists('nl-1-obs-other-driel-boven-q'), 'megen.maas', { WaardeBepalingsMethode: method });
    expect(normalise(asMegen, ctx('nl-1-obs-other-driel-boven-q'))).toEqual({
      obs: [],
      gaugeZeros: [],
      dropped: { gap: 35 },
      unknown: 0,
    });
  });
});

describe('empty and error payloads', () => {
  it('"no data" is HTTP 204 with an empty body (real): not a payload, and never handed to the adapter', () => {
    const { body, meta } = rawFixture('NL-1', 'nl-1-obs-other-arnhem-nederrijn-q');
    expect([meta.status, body.length]).toEqual([204, 0]);
    // The recorder writes no object for a 204 and the loader counts the fetch as ok (load/pipeline.ts classify).
    expect(() => parseWaarnemingen(body)).toThrow(SchemaDrift);
  });

  it('the plain-text and JSON bodies of a 400 are not a payload', () => {
    for (const body of ['Ongeldige aanvraag', '{"Succesvol":false,"Foutmelding":"x"}', '{"Succesvol":false}', '[]']) {
      expect(() => parseWaarnemingen(Buffer.from(body))).toThrow(SchemaDrift);
    }
  });
});

describe('synthetic payloads [U]', () => {
  it('a split list: merged and sorted, one row per instant, every filter counted', () => {
    const out = run('nl-1-obs-split.synthetic');
    expect(out).toEqual(golden('nl-1-obs-split.synthetic', out));
    const nap = out.obs.filter((r) => r.series === EIJSDEN_NAP);
    // List A (Definitief, Gecontroleerd) 12:50Z–14:00Z; list B (Ongecontroleerd, in reverse order) 14:00Z–15:30Z.
    expect(nap.map((r) => r.ts)).toEqual([...new Set(nap.map((r) => r.ts))].sort());
    expect(nap).toHaveLength(14);
    expect(nap.slice(0, 8).every((r) => r.qc === QC.VALIDATED)).toBe(true);
    // 14:00Z is stated by both lists with the same value: one row, the validated one.
    expect(nap.filter((r) => r.ts === '2026-09-30T14:00:00.000Z')).toEqual([
      { series: EIJSDEN_NAP, ts: '2026-09-30T14:00:00.000Z', value: 4411, qc: QC.VALIDATED },
    ]);
    const at = (ts: string) => nap.find((r) => r.ts === ts);
    expect(at('2026-09-30T14:10:00.000Z')?.qc).toBe(QC.RAW);
    // 14:40Z is a gap (code 99, 0.0); 14:50Z has two different values; 15:00Z has a quality code we cannot read.
    expect(at('2026-09-30T14:40:00.000Z')).toBeUndefined();
    expect(at('2026-09-30T14:50:00.000Z')).toBeUndefined();
    expect(at('2026-09-30T15:00:00.000Z')).toBeUndefined();
    // Quality code 25 is kept, with no bit of its own.
    expect(at('2026-09-30T15:10:00.000Z')).toMatchObject({ qc: QC.RAW });
    expect(out.obs.some((r) => r.value === 0 || r.value === 9999)).toBe(false);
    // The discharge list: a raw and a validated statement of 14:00Z with one value.
    expect(out.obs.filter((r) => r.series === EIJSDEN_Q)).toEqual([
      { series: EIJSDEN_Q, ts: '2026-09-30T13:50:00.000Z', value: 47.6, qc: QC.RAW },
      { series: EIJSDEN_Q, ts: '2026-09-30T14:00:00.000Z', value: 47.9, qc: QC.VALIDATED },
    ]);
    expect(out.obs).toHaveLength(16);
    expect(out.dropped).toEqual({
      duplicate: 2,
      gap: 1,
      unknown_quality: 1,
      conflict: 3,
      future: 1,
      too_old: 1,
      // 2 Eijsden values, and (since P5a registers maaseik Q with its live method F006) the 2 F103 maaseik values.
      unregistered_method: 4,
      datum: 2,
      // The verwachting (2 values), GETETM2 (1) and BS (1) lists are under the registered Eijsden NAP key.
      registered_dropped: 4,
      sommatie: 1,
      excluded: 2,
      stale_series: 2,
      unit_mismatch: 2,
      quantity: 1,
    });
    // maaseik Q is registered since P5a (catalogue §0.6): its F103 list is another method, not an unknown series.
    expect(out.unknown).toBe(0);
  });
});

describe('rules', () => {
  const name = 'nl-1-obs-key-eijsden-grens-h';
  const base = ctx(name);
  const eijsden = lists(name);
  const values = (n: number) => eijsden.map((l) => ({ ...l, metingen: l.metingen.slice(0, n) }));
  const withFirst = (change: (m: Waarnemingen['metingen'][number]) => Waarnemingen['metingen'][number]) =>
    eijsden.map((l) => ({ ...l, metingen: l.metingen.map((m, i) => (i === 0 ? change(m) : m)) }));

  it('the time is a fixed +01:00 all year; any other offset is drift', () => {
    const at = (Tijdstip: string, fetchedAt = base.fetchedAt) =>
      normalise(
        withFirst((m) => ({ ...m, Tijdstip })),
        { registry, fetchedAt },
      ).obs.map((r) => r.ts);
    // The plan's known instant: 20:50 +01:00 is 19:50Z, in September (CEST) as in January.
    const september = Date.parse('2026-09-23T20:10:00Z');
    expect(
      normalise(
        values(1).map((l) => ({
          ...l,
          metingen: l.metingen.map((m) => ({ ...m, Tijdstip: '2026-09-23T20:50:00.000+01:00' })),
        })),
        { registry, fetchedAt: september },
      ).obs[0]?.ts,
    ).toBe('2026-09-23T19:50:00.000Z');
    expect(at('2026-01-15T12:00:00.000+01:00', Date.parse('2026-01-15T12:00:00Z'))).toContain(
      '2026-01-15T11:00:00.000Z',
    );
    for (const bad of ['2026-09-30T13:50:00.000+02:00', '2026-09-30T13:50:00.000Z', '2026-09-30T13:50:00', 'gisteren'])
      expect(() => at(bad)).toThrow(SchemaDrift);
  });

  it('TAW, MSL and PLAATSLR duplicates are dropped; only the registered Eijsden-grens TAW twin is kept', () => {
    const taw = lists('nl-1-obs-twin');
    expect(normalise(taw, base).obs).toHaveLength(17);
    expect(registry.has(EIJSDEN_TAW)).toBe(true);
    // The same TAW list at Stevensweert (RWS publishes that duplicate too) is not a series of ours.
    expect(normalise(recode(taw, 'stevensweert'), base)).toEqual({
      obs: [],
      gaugeZeros: [],
      dropped: { datum: 17 },
      unknown: 0,
    });
    for (const Hoedanigheid of ['MSL', 'PLAATSLR']) {
      expect(normalise(recode(eijsden, 'eijsden.grens', { Hoedanigheid }), base).dropped).toEqual({ datum: 17 });
    }
  });

  it('the stale series are never stored; westervoort.1 carries the IJssel discharge', () => {
    const q = lists('nl-1-obs-other-lobith-bovenrijn-tolkamer-q');
    const dropped = (from: Waarnemingen[], code: string, aquo: Record<string, string> = {}) =>
      normalise(recode(from, code, aquo), ctx('nl-1-obs-other-lobith-bovenrijn-tolkamer-q'));
    expect(STALE_SERIES).toEqual([
      'arnhem.nederrijn/WATHTE/NAP',
      'arnhem.nederrijn/Q/NVT',
      'driel.boven/Q/NVT',
      'westervoort.ijsselkop/Q/NVT/other:F230',
    ]);
    expect(dropped(eijsden, 'arnhem.nederrijn').dropped).toEqual({ stale_series: 17 });
    expect(dropped(q, 'arnhem.nederrijn').dropped).toEqual({ stale_series: 35 });
    expect(dropped(q, 'arnhem.nederrijn', { WaardeBepalingsMethode: 'other:F999' }).dropped).toEqual({
      stale_series: 35,
    });
    expect(dropped(q, 'driel.boven').dropped).toEqual({ stale_series: 35 });
    expect(dropped(q, 'westervoort.ijsselkop').dropped).toEqual({ stale_series: 35 });
    for (const key of registry.keys()) expect(STALE_SERIES.some((s) => key.startsWith(s))).toBe(false);
    // driel.boven H and westervoort.ijsselkop H are live tier-1 series.
    const method = (key: string) => ({ WaardeBepalingsMethode: key.split('/')[3] as string });
    expect(dropped(eijsden, 'driel.boven', method(keyOf('driel.boven/WATHTE/NAP'))).obs).toHaveLength(17);
    expect(
      dropped(eijsden, 'westervoort.ijsselkop', method(keyOf('westervoort.ijsselkop/WATHTE/NAP'))).obs,
    ).toHaveLength(17);
    const ijssel = keyOf('westervoort.1/Q/NVT');
    const out = dropped(q, 'westervoort.1', method(ijssel));
    expect(out.obs).toHaveLength(35);
    expect(new Set(out.obs.map((r) => r.series))).toEqual(new Set([ijssel]));
  });

  it('pannerden.regelwerk.* is excluded, whatever it publishes', () => {
    for (const code of ['pannerden.regelwerk.boven', 'pannerden.regelwerk.beneden']) {
      expect(normalise(recode(eijsden, code, { WaardeBepalingsMethode: 'other:F155' }), base)).toEqual({
        obs: [],
        gaugeZeros: [],
        dropped: { excluded: 17 },
        unknown: 0,
      });
    }
    expect([...registry.keys()].some((k) => k.startsWith('pannerden.regelwerk.'))).toBe(false);
  });

  it('only measurements: a forecast, an astronomical tide, another compartment and a grouped extreme are dropped', () => {
    // Under a key the registry does not hold (RWS publishes forecasts, tides and extremes under methods of
    // their own): only counted.
    const other = (code: string, aquo: Record<string, string>) => normalise(recode(eijsden, code, aquo), base);
    for (const ProcesType of ['verwachting', 'astronomisch']) {
      expect(other('eijsden.grens', { ProcesType, WaardeBepalingsMethode: 'RWSM-F232' })).toEqual({
        obs: [],
        gaugeZeros: [],
        dropped: { process: 17 },
        unknown: 0,
      });
    }
    expect(other('nowhere', { Compartiment: 'BS' }).dropped).toEqual({ compartment: 17 });
    expect(other('eijsden.grens', { Groepering: 'GETETM2', WaardeBepalingsMethode: 'other:F009' }).dropped).toEqual({
      grouping: 17,
    });
    // Under a registered key (review F3): a series we store changed its ProcesType, compartment or grouping.
    // Withheld under registered_dropped, which the loader retains for a replay and alerts on.
    expect(registry.has(EIJSDEN_NAP)).toBe(true);
    for (const aquo of [
      { ProcesType: 'verwachting' },
      { ProcesType: 'astronomisch' },
      { Compartiment: 'BS' },
      { Groepering: 'GETETM2' },
    ]) {
      expect([aquo, other('eijsden.grens', aquo)]).toEqual([
        aquo,
        { obs: [], gaugeZeros: [], dropped: { registered_dropped: 17 }, unknown: 0 },
      ]);
    }
  });

  it('a registered series under another method is withheld and reported, never stored under the old key', () => {
    const out = normalise(recode(eijsden, 'eijsden.grens', { WaardeBepalingsMethode: 'other:F155' }), base);
    expect(out).toEqual({ obs: [], gaugeZeros: [], dropped: { unregistered_method: 17 }, unknown: 0 });
  });

  it('a series the registry does not know is counted, never registered; an inherited name is no series', () => {
    // sasvangent is a live RWS point in NL that the registry does not hold (catalogue §0.6 correction).
    for (const code of ['sasvangent', 'nowhere', 'constructor', '__proto__', 'toString']) {
      expect([code, normalise(recode(eijsden, code), base)]).toEqual([
        code,
        { obs: [], gaugeZeros: [], dropped: {}, unknown: 1 },
      ]);
    }
  });

  it('m3/d (Sommatie) and other quantities are not series of ours; a wrong unit on a registered series is counted', () => {
    const q = lists('nl-1-obs-other-lobith-bovenrijn-tolkamer-q');
    const at = ctx('nl-1-obs-other-lobith-bovenrijn-tolkamer-q');
    const lobith = 'lobith.bovenrijn.tolkamer';
    expect(normalise(recode(q, lobith, { Eenheid: 'm3/d' }), at).dropped).toEqual({ sommatie: 35 });
    expect(normalise(recode(q, lobith, { Grootheid: 'STROOMSHD' }), at).dropped).toEqual({ quantity: 35 });
    for (const Eenheid of ['l/s', 'cm', 'constructor', 'm³/s']) {
      expect([Eenheid, normalise(recode(q, lobith, { Eenheid }), at).dropped]).toEqual([
        Eenheid,
        { unit_mismatch: 35 },
      ]);
    }
    expect(normalise(recode(eijsden, 'eijsden.grens', { Eenheid: 'm' }), base).dropped).toEqual({ unit_mismatch: 17 });
  });

  it('quality: 99 is a gap whatever the value; the six known codes are kept; any other code is withheld', () => {
    const withCode = (Kwaliteitswaardecode: string, Waarde_Numeriek = 4409) =>
      normalise(
        withFirst((m) => ({
          ...m,
          Meetwaarde: { ...m.Meetwaarde, Waarde_Numeriek },
          WaarnemingMetadata: { ...m.WaarnemingMetadata, Kwaliteitswaardecode },
        })),
        base,
      );
    expect(withCode('99', 0).dropped).toEqual({ gap: 1 });
    expect(withCode('99', 4409).dropped).toEqual({ gap: 1 });
    expect(withCode('99', 4409).obs).toHaveLength(16);
    for (const code of ['00', '10', '20', '25', '30', '40']) {
      const out = withCode(code);
      expect([code, out.dropped, out.obs[0]?.qc]).toEqual([code, {}, QC.RAW]);
    }
    for (const code of ['50', '98', '31', '01']) expect(withCode(code).dropped).toEqual({ unknown_quality: 1 });
    // A real zero with a normal code is a value (a small stream can stand still).
    expect(withCode('00', 0).obs[0]).toMatchObject({ value: 0, qc: QC.RAW });
  });

  it('status: Ongecontroleerd is raw; Gecontroleerd and Definitief are validated', () => {
    const withStatus = (Statuswaarde: 'Ongecontroleerd' | 'Gecontroleerd' | 'Definitief') =>
      normalise(
        withFirst((m) => ({ ...m, WaarnemingMetadata: { ...m.WaarnemingMetadata, Statuswaarde } })),
        base,
      ).obs[0]?.qc;
    expect(withStatus('Ongecontroleerd')).toBe(QC.RAW);
    expect(withStatus('Gecontroleerd')).toBe(QC.VALIDATED);
    expect(withStatus('Definitief')).toBe(QC.VALIDATED);
  });

  it('rejects a timestamp more than 15 minutes ahead and one older than any window we ask for', () => {
    const at = (Tijdstip: string) =>
      normalise(
        withFirst((m) => ({ ...m, Tijdstip })),
        base,
      ).dropped;
    // Fetched at 15:49:46Z: 16:04 is inside the slack, 16:05 is not.
    expect(at('2026-09-30T17:04:00.000+01:00')).toEqual({});
    expect(at('2026-09-30T17:05:00.000+01:00')).toEqual({ future: 1 });
    expect(at('2026-08-01T00:00:00.000+01:00')).toEqual({ too_old: 1 });
  });

  it('an implausible value keeps its value and gets the range bit', () => {
    const out = normalise(
      withFirst((m) => ({ ...m, Meetwaarde: { ...m.Meetwaarde, Waarde_Numeriek: 600_000 } })),
      base,
    );
    expect(out.obs[0]).toMatchObject({ value: 600_000, qc: QC.RAW | QC.RANGE });
  });

  it('two statements of one instant: the same value is one row; different values are withheld, in any order', () => {
    const [list] = eijsden as [Waarnemingen];
    const first = list.metingen[0] as Waarnemingen['metingen'][number];
    const other = { ...first, Meetwaarde: { ...first.Meetwaarde, Waarde_Numeriek: 1 } };
    const validated = {
      ...first,
      WaarnemingMetadata: { ...first.WaarnemingMetadata, Statuswaarde: 'Definitief' as const },
    };
    const of = (...metingen: Waarnemingen['metingen']) => normalise([{ ...list, metingen }], base);
    expect(of(first, first)).toMatchObject({ dropped: { duplicate: 1 }, obs: [{ value: 4409, qc: QC.RAW }] });
    expect(of(first, validated).obs).toEqual(of(validated, first).obs);
    expect(of(first, validated).obs[0]?.qc).toBe(QC.VALIDATED);
    for (const order of [
      [first, other],
      [other, first],
      [first, other, first],
      [first, first, other],
      [other, validated, first],
    ]) {
      const out = of(...order);
      expect(out.obs).toEqual([]);
      // Every statement of the instant is counted: as a conflict, or as the duplicate it first was.
      expect((out.dropped.conflict ?? 0) + (out.dropped.duplicate ?? 0)).toBe(order.length);
    }
  });

  it('the strict schema: an unknown key, status or quality code, a missing field and a failed answer are drift', () => {
    const doc = () => JSON.parse(rawFixture('NL-1', name).body.toString('utf8'));
    const drift = (change: (d: ReturnType<typeof doc>) => void) => {
      const d = doc();
      change(d);
      try {
        parseWaarnemingen(Buffer.from(JSON.stringify(d)));
      } catch (err) {
        if (err instanceof SchemaDrift) return err.message;
        throw err;
      }
      return 'parsed';
    };
    const value = (d: ReturnType<typeof doc>) => d.WaarnemingenLijst[0].MetingenLijst[3];
    expect(drift(() => {})).toBe('parsed');
    expect(drift((d) => (value(d).Extra = 1))).toBe('unrecognized_keys at WaarnemingenLijst.0.MetingenLijst.3');
    expect(drift((d) => (value(d).WaarnemingMetadata.Statuswaarde = 'Voorlopig'))).toBe(
      'invalid_value at WaarnemingenLijst.0.MetingenLijst.3.WaarnemingMetadata.Statuswaarde',
    );
    expect(drift((d) => (value(d).WaarnemingMetadata.Kwaliteitswaardecode = 'AB'))).toBe(
      'invalid_format at WaarnemingenLijst.0.MetingenLijst.3.WaarnemingMetadata.Kwaliteitswaardecode',
    );
    expect(drift((d) => delete value(d).WaarnemingMetadata)).toBe(
      'invalid_type at WaarnemingenLijst.0.MetingenLijst.3.WaarnemingMetadata',
    );
    expect(drift((d) => (value(d).Meetwaarde.Waarde_Numeriek = '4409'))).toBe(
      'invalid_type at WaarnemingenLijst.0.MetingenLijst.3.Meetwaarde.Waarde_Numeriek',
    );
    expect(drift((d) => (d.WaarnemingenLijst[0].Locatie.Lat = 91))).toBe('too_big at WaarnemingenLijst.0.Locatie.Lat');
    expect(drift((d) => (d.Succesvol = false))).toBe('invalid_value at Succesvol');
    expect(drift((d) => (d.Foutmelding = 'x'))).toBe('unrecognized_keys');
    expect(drift((d) => delete d.WaarnemingenLijst)).toBe('invalid_type at WaarnemingenLijst');
  });
});

describe('bounded parsing', () => {
  // The hostile bodies themselves run in child processes with a small heap: bounded.int.test.ts.
  it('the caps admit every recorded payload and refuse a longer one', () => {
    for (const fixture of ['nl-1-obs-key', 'nl-1-obs-twin', 'nl-1-obs-other-lobith-bovenrijn-tolkamer-q']) {
      expect(lists(fixture)).toHaveLength(1);
    }
    const doc = JSON.parse(rawFixture('NL-1', 'nl-1-obs-key').body.toString('utf8'));
    const [list] = doc.WaarnemingenLijst;
    const code = (d: unknown) => {
      try {
        parseWaarnemingen(Buffer.from(JSON.stringify(d)));
      } catch (err) {
        return err instanceof SchemaDrift ? err.message : 'other';
      }
      return 'parsed';
    };
    // P31D of a 10-minute series: 4,464 values.
    const month = { ...list, MetingenLijst: Array.from({ length: 4464 }, () => list.MetingenLijst[0]) };
    expect(code({ ...doc, WaarnemingenLijst: [month] })).toBe('parsed');
    const tooLong = { ...list, MetingenLijst: Array.from({ length: JSON_CAPS.maxValues + 1 }, () => 0) };
    expect(code({ ...doc, WaarnemingenLijst: [tooLong] })).toBe('too_big at WaarnemingenLijst.0.MetingenLijst');
    const few = { ...list, MetingenLijst: [] };
    expect(code({ ...doc, WaarnemingenLijst: Array.from({ length: JSON_CAPS.maxLists + 1 }, () => few) })).toBe(
      'too_big at WaarnemingenLijst',
    );
    expect(code({ ...doc, WaarnemingenLijst: Array.from({ length: JSON_CAPS.maxLists }, () => few) })).toBe('parsed');
    expect(code(Array.from({ length: JSON_CAPS.maxNodes }, () => 0))).toBe('json_too_many_nodes');
    expect(() => parseWaarnemingen(Buffer.from(`${'['.repeat(9)}${']'.repeat(9)}`))).toThrow(SchemaDrift);
  });
});

describe('property and fuzz tests', () => {
  const name = 'nl-1-obs-key-eijsden-grens-h';
  const base = ctx(name);
  const [template] = lists(name) as [Waarnemingen];
  const first = template.metingen[0] as Waarnemingen['metingen'][number];
  const slot = Math.floor(base.fetchedAt / 600_000) * 600_000;
  const meting = fc
    .record({
      // 50 days back to 80 minutes ahead, on the 10-minute grid.
      step: fc.integer({ min: -50 * 144, max: 8 }),
      value: fc.oneof(
        fc.integer({ min: -500, max: 6000 }),
        fc.constant(0),
        fc.double({ min: -1e6, max: 1e6, noNaN: true }),
      ),
      quality: fc.constantFrom('00', '10', '20', '25', '30', '40', '99', '99', '50', '98'),
      status: fc.constantFrom('Ongecontroleerd', 'Gecontroleerd', 'Definitief'),
    })
    .map(({ step, value, quality, status }) => ({
      ms: slot + step * 600_000,
      quality,
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

  it('normalise never stores a gap, an unreadable code, a future or a repeated instant, and is idempotent', () => {
    fc.assert(
      fc.property(payload, (groups) => {
        const out = normalise(toLists(groups), base);
        const all = groups.flat();
        const known = new Set(['00', '10', '20', '25', '30', '40']);
        for (const r of out.obs) {
          ObsRow.parse(r);
          const ms = Date.parse(r.ts);
          expect(ms).toBeLessThanOrEqual(base.fetchedAt + 15 * 60_000);
          expect(ms).toBeGreaterThanOrEqual(base.fetchedAt - 45 * 86_400_000);
          // Every stored row is a statement of the payload with a readable quality code, never a 99,
          // and no other value was stated for that instant.
          const stated = all.filter((x) => x.ms === ms && known.has(x.quality));
          expect([...new Set(stated.map((x) => scale(1, x.meting.Meetwaarde.Waarde_Numeriek)))]).toEqual([r.value]);
        }
        const times = out.obs.map((r) => r.ts);
        expect(times).toEqual([...new Set(times)].sort());
        expect(normalise([...toLists(groups), ...toLists(groups)], base).obs).toEqual(out.obs);
      }),
      { numRuns: 200 },
    );
  });

  it('the rows do not depend on how the values are split into lists or on their order', () => {
    fc.assert(
      fc.property(payload, fc.integer({ min: 0, max: 1_000_000 }), (groups, seed) => {
        const all = groups.flat();
        const shuffled = all
          .map((x, i) => ({ x, k: (Math.imul(i + 1, seed + 0x9e3779b1) >>> 0) % 1009 }))
          .sort((a, b) => a.k - b.k)
          .map((e) => e.x);
        const half = Math.floor(shuffled.length / 2);
        const regrouped = [shuffled.slice(0, half), shuffled.slice(half)];
        expect(normalise(toLists(regrouped), base).obs).toEqual(normalise(toLists(groups), base).obs);
      }),
      { numRuns: 200 },
    );
  });

  it('parse never throws anything but SchemaDrift on arbitrary JSON', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (doc) => {
        for (const d of [doc, { Succesvol: true, WaarnemingenLijst: doc }]) {
          try {
            parseWaarnemingen(Buffer.from(JSON.stringify(d)));
          } catch (err) {
            expect(err).toBeInstanceOf(SchemaDrift);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it('a mutated real payload is either still valid or a SchemaDrift, never a crash or a wrong row', () => {
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
          const out = normalise(parseWaarnemingen(Buffer.from(JSON.stringify(copy))), base);
          for (const r of out.obs) ObsRow.parse(r);
        } catch (err) {
          expect(err).toBeInstanceOf(SchemaDrift);
        }
      }),
      { numRuns: 300 },
    );
  });
});
