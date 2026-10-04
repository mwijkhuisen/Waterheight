import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { checkRun, encodeRun, FORECAST_FLAGS, FORECAST_SOURCES, type Normalised, SchemaDrift } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { readEnvelope } from '../../src/adapters/_shared/vigicrues/parse.ts';
import { normalise, SOURCE, TIME } from '../../src/adapters/fr-4/normalise.ts';
import { JSON_CAPS, MAX_LISTED, MAX_PREVS, type Parsed, parseDocument } from '../../src/adapters/fr-4/parse.ts';
import type { LoadContext } from '../../src/load/adapters.ts';
import { ADAPTER } from '../../src/load/wire/fr-4.ts';
import { goldenUrl, rawFixture } from './registry.ts';

// FR-4 Vigicrues forecasts (public, catalogue §2.5): parse + normalise of the real recordings equal their goldens
// (invariant 9), the run rules on synthetic bodies (units, nulls, the order check the loader applies, the 72 h horizon,
// the variant), the v1.1 and legacy time labels of one run, the HTTP-200 error and "no content" envelopes, and the
// property tests. `UPDATE_GOLDEN=1` rewrites goldens.

const HOUR = 3_600_000;
const DECL = FORECAST_SOURCES['FR-4'];
const KEY = 'A443064001/H';

type Golden = { forecasts: Normalised['forecasts']; dropped: Normalised['dropped'] };
function golden(name: string, actual: Golden): Golden {
  const url = goldenUrl('FR-4', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const read = (name: string) => rawFixture('FR-4', name).body;
const run = (name: string, variant: string): Normalised => normalise(parseDocument(read(name)), { variant });
const projected = (n: Normalised): Golden => ({ forecasts: n.forecasts, dropped: n.dropped });
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const bytes = (v: unknown) => Buffer.from(JSON.stringify(v));
const thrown = (f: () => unknown): unknown => {
  try {
    f();
  } catch (err) {
    return err;
  }
  return undefined;
};

// ---- documents built here: a station body whose run is issued at 2030-07-07T08:00Z, labelled +02:00 as v1.1 does.
const PROD = Date.parse('2030-07-07T08:00:00Z');
const label = (ms: number, offset = '+02:00') =>
  `${new Date(ms + Number(offset.slice(0, 3)) * HOUR).toISOString().slice(0, 19)}${offset}`;
type Res = number | null;
type PrevDoc = { DtPrev: string; ResMinPrev: Res; ResMoyPrev: Res; ResMaxPrev: Res };
/** One point at `ms`, values min < moy < max (1.5, 2, 2.5 plus i/100). */
const prev = (ms: number, i = 0): PrevDoc => ({
  DtPrev: label(ms),
  ResMinPrev: 1.5 + i / 100,
  ResMoyPrev: 2 + i / 100,
  ResMaxPrev: 2.5 + i / 100,
});
/** `n` hourly points from one hour after the production. */
const prevs = (n: number, from = PROD + HOUR): PrevDoc[] =>
  Array.from({ length: n }, (_, i) => prev(from + i * HOUR, i));
const scenario = () => ({
  Flux: { Version: '1beta', DateRevision: '2019-07-08T10:00:00' },
  CodeScenario: 'VIC',
  VersionScenario: '1.1',
  NomScenario: 'Nom du scénario (synthétique)',
  DateHeureCreationFichier: '2030-07-07T08:20:00+00:00',
  Emetteur: '1524',
});
const station = (over: { code?: string; grd?: string; Prevs?: PrevDoc[]; DtProdSimul?: string } = {}) => ({
  Scenario: scenario(),
  Simul: {
    CdEntVigiCru: over.code ?? 'A443064001',
    TypEntVigiCru: '7',
    LbEntVigiCru: 'Station synthétique',
    Link: 'https://example.invalid/StaEntVigiCru.json',
    GrdSimul: over.grd ?? 'H',
    DtProdSimul: over.DtProdSimul ?? label(PROD),
    CommentSimul: 'Commentaire synthétique',
    Prevs: over.Prevs ?? prevs(3),
  },
});
const listDoc = (n: number, grd = 'H') => ({
  Scenario: scenario(),
  GrdSimul: grd,
  count: n,
  ListEntVigiCru: Array.from({ length: n }, (_, i) => ({
    DtProdSimul: label(PROD),
    CdEntVigiCru: `A44306400${i % 10}`,
    TypEntVigiCru: '7',
    LbEntVigiCru: 'Station synthétique',
    Link: 'https://example.invalid/prevision.json',
  })),
});
const norm = (doc: unknown, variant = KEY) => normalise(parseDocument(bytes(doc)), { variant });
/** The core's own checks of a run, as the loader applies them (fetched 20 minutes after the production). */
const checked = (n: Normalised) => {
  const [r] = n.forecasts ?? [];
  if (r === undefined) throw new Error('no run');
  return checkRun(r, PROD + 20 * 60_000, DECL);
};

// ---- real recordings
const REAL = [
  ['fr-4-station-l800001020-h-20260930t1620z', 'L800001020/H'],
  ['fr-4-station-l800001020-q-20260930t1620z', 'L800001020/Q'],
  ['fr-4-station-y210002001-h-20260930t1220z', 'Y210002001/H'],
  ['fr-4', 'H'],
] as const;

describe('golden files (real recordings)', () => {
  for (const [name, variant] of REAL) {
    it(`${name}: parse + normalise equals the golden, and the run passes the core bounds whole`, () => {
      const out = projected(run(name, variant));
      expect(out).toEqual(golden(name, out));
      const fetchedAt = Date.parse(rawFixture('FR-4', name).meta.recorded_at);
      for (const r of out.forecasts ?? []) {
        const c = checkRun(r, fetchedAt, DECL);
        expect(c.dropped).toEqual({});
        expect(c.run?.points).toHaveLength(r.points.length);
        // No point of any recorded run breaks the order of its columns: the loader flags none.
        expect(c.run?.points.every((p) => (p.flags & FORECAST_FLAGS.ORDER) === 0)).toBe(true);
      }
    });
  }

  it('the stage run of Saumur: 40 hourly points, centimetres, issued as stated, p10 / p50 / p90 with value = p50', () => {
    const out = run('fr-4-station-l800001020-h-20260930t1620z', 'L800001020/H');
    expect(out.dropped).toEqual({});
    expect(out.unknown).toBe(0);
    expect(out.obs).toEqual([]);
    expect(out.forecasts).toHaveLength(1);
    const [r] = out.forecasts ?? [];
    expect(r).toMatchObject({
      target: 'FR-1',
      series: 'L800001020/H',
      kind: 'quantiles',
      stepMs: null,
      issuedAt: '2026-09-30T08:52:05.000Z',
      providerSegmentEnd: null,
    });
    expect(r?.points).toHaveLength(40);
    // -0.82 m, -0.80 m, -0.78 m at 19:00+02:00: metres times 100, no binary noise.
    expect(r?.points[0]).toEqual({
      ts: '2026-09-30T17:00:00.000Z',
      flags: 0,
      value: -80,
      p10: -82,
      p50: -80,
      p90: -78,
    });
    const ms = (r?.points ?? []).map((p) => Date.parse(p.ts));
    expect(ms.every((t, i) => i === 0 || t - (ms[i - 1] as number) === HOUR)).toBe(true);
    for (const p of r?.points ?? []) expect(p.value).toBe(p.p50);
  });

  it('the discharge run of the same station: m3/s as published (factor 1), its own series', () => {
    const [r] = run('fr-4-station-l800001020-q-20260930t1620z', 'L800001020/Q').forecasts ?? [];
    expect(r).toMatchObject({ series: 'L800001020/Q', kind: 'quantiles', stepMs: null });
    expect(r?.points[0]).toEqual({
      ts: '2026-09-30T17:00:00.000Z',
      flags: 0,
      value: 90.47,
      p10: 85.23,
      p50: 90.47,
      p90: 94.16,
    });
    expect(r?.points).toHaveLength(40);
  });

  it('a body of one value is a run of one point (Laroque: a single DtPrev, 84 minutes after the production)', () => {
    const [r] = run('fr-4-station-y210002001-h-20260930t1220z', 'Y210002001/H').forecasts ?? [];
    expect(r?.points).toEqual([{ ts: '2026-09-30T13:17:00.000Z', flags: 0, value: 420, p10: 360, p50: 420, p90: 500 }]);
    expect(r?.issuedAt).toBe('2026-09-30T11:53:02.000Z');
    expect(r?.stepMs).toBeNull();
  });

  it('the smoke recording of a station (irregular steps of half a day) is a run of three points', () => {
    const [r] = run('fr-4-station', 'Q836001001/H').forecasts ?? [];
    expect(r?.series).toBe('Q836001001/H');
    expect(r?.points.map((p) => p.ts)).toEqual([
      '2026-09-29T18:00:00.000Z',
      '2026-09-30T06:20:00.000Z',
      '2026-09-30T18:50:00.000Z',
    ]);
    expect(r?.points[0]?.p50).toBe(434);
  });

  it('the national list stores nothing and counts nothing, whichever variant states its parameter', () => {
    const doc = parseDocument(read('fr-4'));
    expect(doc).toEqual({ kind: 'list', grd: 'H' });
    for (const variant of ['', 'H']) {
      const out = normalise(doc, { variant });
      expect(out.forecasts).toBeUndefined();
      expect(out.dropped).toEqual({});
      expect(out.unknown).toBe(0);
    }
  });
});

describe('what is never returned (CommentSimul, LbEntVigiCru, Link, Scenario)', () => {
  it('neither the parse nor the normalised output holds the free text, the label, the link or the header', () => {
    const body = read('fr-4-station-l800001020-h-20260930t1620z');
    const text = body.toString('utf8');
    // The recording has them all (a comment of 190 characters, the label, the link, the scenario's name).
    for (const s of ['incertitudes', 'Saumur', 'StaEntVigiCru', 'Référentiels', '"Emetteur"'])
      expect([s, text.includes(s)]).toEqual([s, true]);
    const parsed = parseDocument(body);
    expect(Object.keys(parsed).sort()).toEqual(['code', 'grd', 'kind', 'prevs', 'producedAt']);
    const out = JSON.stringify([parsed, normalise(parsed, { variant: 'L800001020/H' })]);
    for (const s of [
      'incertitudes',
      'Saumur',
      'StaEntVigiCru',
      'Référentiels',
      'Emetteur',
      'CommentSimul',
      'LbEntVigiCru',
      'Scenario',
    ])
      expect([s, out.includes(s)]).toEqual([s, false]);
  });

  it('the free text may be long (a flood may write a page) but is capped', () => {
    const doc = station();
    doc.Simul.CommentSimul = 'x'.repeat(10_000);
    expect(norm(doc).forecasts).toHaveLength(1);
    doc.Simul.CommentSimul = 'x'.repeat(10_001);
    expect(() => norm(doc)).toThrow(expect.objectContaining({ code: 'too_big' }));
  });
});

describe('the v1.1 and legacy labels of one run', () => {
  const v11 = 'fr-4-station-a443064001-h-v11.synthetic';
  const legacy = 'fr-4-station-a443064001-h-legacy.synthetic';
  const canonical = (name: string) => {
    const [r] = run(name, KEY).forecasts ?? [];
    const c = checkRun(r as NonNullable<typeof r>, Date.parse('2026-10-02T11:50:08Z'), DECL);
    const enc = encodeRun(c.run as NonNullable<typeof c.run>);
    return { run: r, enc, hash: sha256(enc) };
  };

  it('differ in their offsets (+02:00, +00:00), their file time and their comment, never in the run', () => {
    const [a, b] = [v11, legacy].map((n) => JSON.parse(read(n).toString('utf8')));
    expect(read(v11).equals(read(legacy))).toBe(false);
    expect(sha256(read(v11))).not.toBe(sha256(read(legacy)));
    expect(a.Scenario.DateHeureCreationFichier).not.toBe(b.Scenario.DateHeureCreationFichier);
    expect(a.Simul.CommentSimul).not.toBe(b.Simul.CommentSimul);
    expect(a.Simul.DtProdSimul.endsWith('+02:00')).toBe(true);
    expect(b.Simul.DtProdSimul.endsWith('+00:00')).toBe(true);
    for (const [doc, offset] of [
      [a, '+02:00'],
      [b, '+00:00'],
    ] as const) {
      expect(doc.Simul.Prevs).toHaveLength(40);
      expect(doc.Simul.Prevs.every((p: { DtPrev: string }) => p.DtPrev.endsWith(offset))).toBe(true);
    }
  });

  it('give identical canonical bytes and the same sha256 content hash', () => {
    const [a, b] = [canonical(v11), canonical(legacy)];
    expect(a.run).toEqual(b.run);
    expect(a.run?.issuedAt).toBe('2026-10-02T08:52:05.000Z');
    expect(a.run?.points).toHaveLength(40);
    expect(Buffer.from(a.enc).equals(Buffer.from(b.enc))).toBe(true);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the run is the same under any order of its points and with another file time', () => {
    const hashOf = (n: Normalised) =>
      sha256(encodeRun(checked(n).run as NonNullable<ReturnType<typeof checked>['run']>));
    const forward = norm(station({ Prevs: prevs(6) }));
    const reversed = norm(station({ Prevs: prevs(6).reverse() }));
    expect(hashOf(reversed)).toBe(hashOf(forward));
    const other = station({ Prevs: prevs(6) });
    other.Scenario.DateHeureCreationFichier = '2031-01-01T00:00:00+00:00';
    expect(norm(other)).toEqual(forward);
  });
});

describe('the HTTP-200 envelopes (shared with FR-5: _shared/vigicrues)', () => {
  it('an error body is drift `provider_error`, whatever its code, with no provider text in the error', () => {
    for (const body of [
      read('fr-4-error.synthetic'),
      bytes({ error_msg: 'Interne', code: 500 }),
      bytes({ error_msg: 'x' }),
    ]) {
      const err = thrown(() => parseDocument(body));
      expect(err).toBeInstanceOf(SchemaDrift);
      expect(err).toMatchObject({ code: 'provider_error', path: '' });
      expect(err).toEqual(new SchemaDrift('provider_error'));
    }
    expect(() => readEnvelope(read('fr-4-error.synthetic'), JSON_CAPS)).toThrow(
      expect.objectContaining({ code: 'provider_error' }),
    );
  });

  it('a "no content" body (code 204 with its message) is no forecast: no run, nothing dropped, nothing unknown', () => {
    expect(parseDocument(read('fr-4-no-forecast.synthetic'))).toEqual({ kind: 'none' });
    for (const variant of ['', KEY, 'L800001020/Q', 'H']) {
      const out = normalise(parseDocument(read('fr-4-no-forecast.synthetic')), { variant });
      expect(out.forecasts).toBeUndefined();
      expect(out.dropped).toEqual({});
      expect(out.unknown).toBe(0);
      expect(out.obs).toEqual([]);
    }
    expect(readEnvelope(read('fr-4-no-forecast.synthetic'), JSON_CAPS)).toEqual({ kind: 'none' });
  });

  it('a station with an empty Prevs is no forecast either: no run, nothing dropped', () => {
    const doc = parseDocument(read('fr-4-station-a443064001-h-empty-prevs.synthetic'));
    expect(doc).toMatchObject({ kind: 'station', code: 'A443064001', grd: 'H', prevs: [] });
    const out = normalise(doc, { variant: KEY });
    expect(out.forecasts).toBeUndefined();
    expect(out.dropped).toEqual({});
    expect(out.unknown).toBe(0);
    // Its variant is still checked: a body for another station is not "no forecast" for this one.
    expect(() => normalise(doc, { variant: 'L800001020/H' })).toThrow(
      expect.objectContaining({ code: 'variant_mismatch' }),
    );
  });

  it('only a code 204 with a message and nothing else is "no content"; any other shape is the document or drift', () => {
    for (const bad of [
      { code: 204 },
      { message: 'x', code: 204, extra: 1 },
      { message: 'x', code: 400 },
      { message: 7, code: 204 },
    ])
      expect(() => parseDocument(bytes(bad))).toThrow(SchemaDrift);
    expect(readEnvelope(bytes([1]), JSON_CAPS)).toEqual({ kind: 'document', doc: [1] });
    expect(readEnvelope(bytes({ code: 204 }), JSON_CAPS)).toEqual({ kind: 'document', doc: { code: 204 } });
    expect(readEnvelope(bytes('text'), JSON_CAPS)).toEqual({ kind: 'document', doc: 'text' });
    expect(readEnvelope(bytes(null), JSON_CAPS)).toEqual({ kind: 'document', doc: null });
  });
});

describe('units and columns (synthetic)', () => {
  it('declares ISO times with their own offset, the source and its units', () => {
    expect(TIME).toEqual({ kind: 'iso-offset' });
    expect(SOURCE).toBe('FR-4');
    // Metres of stage to centimetres, discharge as it is: the forecast source's own declaration, never FR-1's.
    expect(DECL.units).toEqual({ m: ['H', 100], 'm3/s': ['Q', 1] });
    expect(DECL.kind).toBe('quantiles');
    expect(DECL.horizonMs).toBe(72 * HOUR);
  });

  it('H is metres times 100 in cm, Q is m3/s times 1, with none of the binary noise of a product', () => {
    const doc = (grd: string) =>
      station({ grd, Prevs: [{ ...prev(PROD + HOUR), ResMinPrev: 0.57, ResMoyPrev: 1.15, ResMaxPrev: 2.3 }] });
    expect(norm(doc('H'), 'A443064001/H').forecasts?.[0]?.points[0]).toMatchObject({
      p10: 57,
      p50: 115,
      p90: 230,
      value: 115,
    });
    expect(norm(doc('Q'), 'A443064001/Q').forecasts?.[0]?.points[0]).toMatchObject({
      p10: 0.57,
      p50: 1.15,
      p90: 2.3,
      value: 1.15,
    });
    expect(norm(doc('Q'), 'A443064001/Q').forecasts?.[0]?.series).toBe('A443064001/Q');
  });

  it('a null is an absent column (never 0); a point of nothing is a gap for the core, and a run of gaps is none', () => {
    const none = { ResMinPrev: null, ResMoyPrev: null, ResMaxPrev: null };
    const points: PrevDoc[] = [
      { ...prev(PROD + HOUR), ResMinPrev: null },
      { ...prev(PROD + 2 * HOUR, 1), ResMoyPrev: null },
      { ...prev(PROD + 3 * HOUR, 2), ...none },
    ];
    const out = norm(station({ Prevs: points }));
    expect(out.dropped).toEqual({});
    const stored = out.forecasts?.[0]?.points ?? [];
    expect(stored).toHaveLength(3);
    expect(stored[0]).toMatchObject({ p10: null, p50: 200, p90: 250, value: 200 });
    expect(stored[1]).toMatchObject({ p10: 151, p50: null, p90: 251, value: null });
    expect(stored[2]).toMatchObject({ p10: null, p50: null, p90: null, value: null });
    const c = checked(out);
    expect(c.dropped).toEqual({ gap: 1 });
    expect(c.run?.points).toHaveLength(2);
    const gaps = norm(station({ Prevs: points.map((p) => ({ ...p, ...none })) }));
    expect(checked(gaps)).toEqual({ run: null, dropped: { gap: 3, empty_run: 1 } });
  });

  it('values that break the order stay as published; the loader’s check flags them, nothing is reordered', () => {
    const points: PrevDoc[] = [
      { ...prev(PROD + HOUR), ResMinPrev: 3, ResMoyPrev: 2, ResMaxPrev: 1 },
      ...prevs(2, PROD + 2 * HOUR),
    ];
    const out = norm(station({ Prevs: points }));
    expect(out.forecasts?.[0]?.points[0]).toMatchObject({ p10: 300, p50: 200, p90: 100, flags: 0 });
    const c = checked(out);
    expect(c.run?.points.map((p) => p.flags)).toEqual([FORECAST_FLAGS.ORDER, 0, 0]);
    expect(c.dropped).toEqual({});
  });

  it('a value out of range is drift, never a stored infinity; a number needs no sign convention (negative stages are real)', () => {
    const wild = station({ Prevs: [{ ...prev(PROD + HOUR), ResMaxPrev: 1e9 }] });
    expect(() => norm(wild)).toThrow(expect.objectContaining({ code: 'value_out_of_range' }));
    const low = station({ Prevs: [{ ...prev(PROD + HOUR), ResMinPrev: -0.85 }] });
    expect(norm(low).forecasts?.[0]?.points[0]?.p10).toBe(-85);
  });
});

describe('the run (synthetic)', () => {
  it('is issued at DtProdSimul with no step and no provider segment, on the FR-1 series of the body', () => {
    const [r] = norm(station()).forecasts ?? [];
    expect(r).toEqual({
      target: 'FR-1',
      series: 'A443064001/H',
      kind: 'quantiles',
      stepMs: null,
      issuedAt: '2030-07-07T08:00:00.000Z',
      providerSegmentEnd: null,
      points: expect.any(Array),
    });
  });

  it('keeps irregular steps as they are (10 minutes, half an hour, half a day)', () => {
    const at = [0, 10, 40, 12 * 60 + 40].map((m) => PROD + m * 60_000);
    const points = at.map((ms, i) => ({ ...prev(ms), ResMoyPrev: 2 + i }));
    const [r] = norm(station({ Prevs: points })).forecasts ?? [];
    expect(r?.points.map((p) => Date.parse(p.ts))).toEqual(at);
    expect(r?.stepMs).toBeNull();
  });

  it('the horizon is 72 h after the production: a point at +72 h is kept, one past +73 h is dropped by the core', () => {
    const lead = (h: number) => PROD + h * HOUR;
    const out = norm(station({ Prevs: [lead(1), lead(48), lead(72), lead(73), lead(74)].map((ms) => prev(ms)) }));
    const c = checked(out);
    expect(c.run?.points.map((p) => (p.ms - PROD) / HOUR)).toEqual([1, 48, 72, 73]);
    expect(c.dropped).toEqual({ beyond_horizon: 1 });
  });

  it('a first value up to 34 h after the production is normal (the first DtPrev of Saumur is 8 h after)', () => {
    const out = norm(station({ Prevs: prevs(2, PROD + 34 * HOUR) }));
    expect(out.forecasts?.[0]?.points).toHaveLength(2);
    expect(checked(out).dropped).toEqual({});
  });

  it('two points at one instant are drift in the loader’s check, also under two offsets; an issue time ahead of the fetch is too', () => {
    const dup = station({ Prevs: [...prevs(2), { ...prev(PROD + HOUR), DtPrev: label(PROD + HOUR, '+00:00') }] });
    expect(() => checked(norm(dup))).toThrow(expect.objectContaining({ code: 'duplicate_ts' }));
    const [r] = norm(station()).forecasts ?? [];
    expect(() => checkRun(r as NonNullable<typeof r>, PROD - HOUR, DECL)).toThrow(
      expect.objectContaining({ code: 'future_issue' }),
    );
  });

  it('a timestamp needs an offset and a real date: drift otherwise, with the place in the body', () => {
    const at = (i: number, value: string) => () =>
      norm(station({ Prevs: prevs(3).map((p, j) => (j === i ? { ...p, DtPrev: value } : p)) }));
    expect(at(2, '2030-07-07T12:00:00')).toThrow(
      expect.objectContaining({ code: 'time_bad_format', path: 'Simul.Prevs.2.DtPrev' }),
    );
    expect(at(0, 'bientôt')).toThrow(expect.objectContaining({ code: 'time_bad_format' }));
    expect(at(1, '9999-07-07T12:00:00+02:00')).toThrow(expect.objectContaining({ code: 'time_out_of_range' }));
    expect(() => norm(station({ DtProdSimul: '2030-07-07T10:00:00' }))).toThrow(
      expect.objectContaining({ code: 'time_bad_format', path: 'Simul.DtProdSimul' }),
    );
    expect(norm(station({ DtProdSimul: '2030-07-07T08:00:00Z' })).forecasts?.[0]?.issuedAt).toBe(
      '2030-07-07T08:00:00.000Z',
    );
  });
});

describe('the variant is ours and must agree with the body', () => {
  it('a station body takes its own `<code>/<grd>` or none (a recovered line)', () => {
    expect(norm(station(), '').forecasts).toHaveLength(1);
    expect(norm(station(), 'A443064001/H').forecasts).toHaveLength(1);
    expect(norm(station({ grd: 'Q' }), 'A443064001/Q').forecasts).toHaveLength(1);
    for (const bad of ['A443064001/Q', 'A021005050/H', 'H', 'Q'])
      expect(() => norm(station(), bad)).toThrow(expect.objectContaining({ code: 'variant_mismatch' }));
  });

  it('the list takes `H` or `Q` of its own parameter, or none', () => {
    const list = parseDocument(bytes(listDoc(2, 'Q')));
    expect(normalise(list, { variant: 'Q' }).forecasts).toBeUndefined();
    expect(normalise(list, { variant: '' }).forecasts).toBeUndefined();
    for (const bad of ['H', KEY, 'A443064001/Q'])
      expect(() => normalise(list, { variant: bad })).toThrow(expect.objectContaining({ code: 'variant_mismatch' }));
  });

  it('a variant that is no station code and parameter is drift `bad_variant`, on any body', () => {
    for (const bad of [
      'a443064001/H',
      'A44306400/H',
      'A443064001/h',
      'A443064001/X',
      'A443064001',
      'H/',
      '/H',
      'X',
      ' H',
    ])
      for (const doc of [parseDocument(bytes(station())), parseDocument(bytes(listDoc(1))), { kind: 'none' } as const])
        expect(() => normalise(doc, { variant: bad })).toThrow(expect.objectContaining({ code: 'bad_variant' }));
  });
});

describe('parse: strict schema, bounded, fixed codes', () => {
  it('reads a good station and a good list', () => {
    expect(parseDocument(bytes(station()))).toMatchObject({ kind: 'station', code: 'A443064001', grd: 'H' });
    expect(parseDocument(bytes(station({ grd: 'Q' })))).toMatchObject({ grd: 'Q' });
    expect(parseDocument(bytes(listDoc(3, 'Q')))).toEqual({ kind: 'list', grd: 'Q' });
    expect(parseDocument(bytes(listDoc(0)))).toEqual({ kind: 'list', grd: 'H' });
  });

  it('a key the schema does not know, anywhere, is drift', () => {
    const mutate = (f: (d: ReturnType<typeof station>) => void) => {
      const d = station();
      f(d);
      return bytes(d);
    };
    for (const body of [
      mutate((d) => Object.assign(d, { extra: 1 })),
      mutate((d) => Object.assign(d.Simul, { extra: 1 })),
      mutate((d) => Object.assign(d.Scenario, { extra: 1 })),
      mutate((d) => Object.assign(d.Scenario.Flux, { extra: 1 })),
      mutate((d) => Object.assign(d.Simul.Prevs[0] ?? {}, { ResP90Prev: 1 })),
    ])
      expect(() => parseDocument(body)).toThrow(expect.objectContaining({ code: 'unrecognized_keys' }));
    const list = listDoc(1);
    expect(() => parseDocument(bytes({ ...list, extra: 1 }))).toThrow(
      expect.objectContaining({ code: 'unrecognized_keys' }),
    );
    expect(() => parseDocument(bytes({ ...list, ListEntVigiCru: [{ ...list.ListEntVigiCru[0], extra: 1 }] }))).toThrow(
      expect.objectContaining({ code: 'unrecognized_keys' }),
    );
  });

  it('a key that is missing, a value of another type or a code that is no Sandre code is drift', () => {
    const d = station();
    const without = (path: 'Scenario' | 'Simul') => bytes({ ...d, [path]: undefined });
    expect(() => parseDocument(without('Scenario'))).toThrow(SchemaDrift);
    expect(() => parseDocument(without('Simul'))).toThrow(SchemaDrift);
    const sim = (over: object) => bytes({ ...d, Simul: { ...d.Simul, ...over } });
    const withPrev = (over: object) => sim({ Prevs: [{ ...prev(PROD + HOUR), ...over }] });
    for (const body of [
      sim({ Prevs: undefined }),
      sim({ Prevs: {} }),
      sim({ CdEntVigiCru: 'a443064001' }),
      sim({ CdEntVigiCru: 'A44306400' }),
      sim({ CdEntVigiCru: 'A4430640011' }),
      sim({ CdEntVigiCru: '' }),
      sim({ CdEntVigiCru: 7 }),
      sim({ TypEntVigiCru: '5' }),
      sim({ TypEntVigiCru: 7 }),
      sim({ GrdSimul: 'h' }),
      sim({ GrdSimul: 'X' }),
      sim({ DtProdSimul: 7 }),
      sim({ CommentSimul: null }),
      withPrev({ ResMinPrev: '1.5' }),
      withPrev({ ResMoyPrev: undefined }),
      withPrev({ DtPrev: 'x'.repeat(41) }),
      withPrev({ DtPrev: 7 }),
    ])
      expect(() => parseDocument(body)).toThrow(SchemaDrift);
    expect(() => parseDocument(sim({ CdEntVigiCru: 'a443064001' }))).toThrow(
      expect.objectContaining({ code: 'invalid_format' }),
    );
    expect(() => parseDocument(sim({ GrdSimul: 'X' }))).toThrow(expect.objectContaining({ code: 'invalid_value' }));
    expect(() => parseDocument(sim({ TypEntVigiCru: '5' }))).toThrow(
      expect.objectContaining({ code: 'invalid_value' }),
    );
    // Infinity has no JSON spelling; 1e999 reads as Infinity and is refused.
    expect(() =>
      parseDocument(Buffer.from(bytes(station()).toString().replace('"ResMinPrev":1.5', '"ResMinPrev":1e999'))),
    ).toThrow(SchemaDrift);
    expect(() => parseDocument(bytes({ ...listDoc(1), count: -1 }))).toThrow(SchemaDrift);
    expect(() => parseDocument(bytes({ ...listDoc(1), GrdSimul: 'X' }))).toThrow(SchemaDrift);
  });

  it('the path of a drift is ours (a schema path), never provider text', () => {
    const d = station();
    const bad = bytes({ ...d, Simul: { ...d.Simul, Prevs: [...prevs(2), { ...prev(PROD), 'Évil<script>': 1 }] } });
    const err = thrown(() => parseDocument(bad));
    expect(err).toBeInstanceOf(SchemaDrift);
    expect(err).toMatchObject({ code: 'unrecognized_keys', path: 'Simul.Prevs.2' });
    expect((err as SchemaDrift).message).not.toContain('script');
  });

  it('bounded: the encoding, the JSON, the depth, the values and the lists', () => {
    expect(() => parseDocument(Buffer.from([0xff, 0xfe, 0x7b]))).toThrow(expect.objectContaining({ code: 'encoding' }));
    expect(() => parseDocument(Buffer.from('{"Scenario":'))).toThrow(expect.objectContaining({ code: 'not_json' }));
    for (const root of [[], 7, 'x', null, true])
      expect(() => parseDocument(bytes(root))).toThrow(expect.objectContaining({ code: 'invalid_type' }));
    expect(() => parseDocument(bytes({ a: { b: { c: { d: { e: 1 } } } } }))).toThrow(
      expect.objectContaining({ code: 'json_too_deep' }),
    );
    expect(() => parseDocument(bytes(Array.from({ length: JSON_CAPS.maxNodes }, () => 0)))).toThrow(
      expect.objectContaining({ code: 'json_too_many_nodes' }),
    );
    // The most a station may state: 1,000 points parse (about 5,000 values), one more is refused before any is parsed.
    expect(parseDocument(bytes(station({ Prevs: prevs(MAX_PREVS) })))).toMatchObject({ kind: 'station' });
    expect(() => parseDocument(bytes(station({ Prevs: prevs(MAX_PREVS + 1) })))).toThrow(
      expect.objectContaining({ code: 'too_big' }),
    );
    expect(parseDocument(bytes(listDoc(MAX_LISTED)))).toEqual({ kind: 'list', grd: 'H' });
    expect(() => parseDocument(bytes(listDoc(MAX_LISTED + 1)))).toThrow(expect.objectContaining({ code: 'too_big' }));
  });

  it('accepts every recording and every synthetic body that is a document, and only those', () => {
    const names = [
      ...REAL.map(([n]) => n),
      'fr-4-station',
      'fr-4-station-a443064001-h-v11.synthetic',
      'fr-4-station-a443064001-h-legacy.synthetic',
      'fr-4-station-a443064001-h-empty-prevs.synthetic',
      'fr-4-no-forecast.synthetic',
    ];
    for (const n of names)
      expect([n, parseDocument(read(n)).kind]).toEqual([n, expect.stringMatching(/^(station|list|none)$/)]);
    expect(() => parseDocument(read('fr-4-error.synthetic'))).toThrow(SchemaDrift);
  });
});

describe('the loader entry (load/wire/fr-4.ts)', () => {
  const spec = ADAPTER.specs['fr-4'];
  const ctx = (variant: string): LoadContext => ({
    registry: new Map(),
    fetchedAt: Date.parse('2026-10-02T11:20:06Z'),
    variant,
    unitMismatch: new Set(),
  });

  it('is one spec for the list and the stations, attached to FR-1, 4 MiB, a variant optional', () => {
    expect(Object.keys(ADAPTER.specs)).toEqual(['fr-4']);
    expect(spec?.needsVariant).toBe(false);
    expect(spec?.refTarget).toEqual(['FR-1']);
    expect(spec?.maxBytes).toBe(4 * 1024 * 1024);
    expect(spec?.combine).toBeUndefined();
  });

  it('runs the adapter: a station body is a run, the list and the envelopes are none, an error body is drift', async () => {
    const station = await spec?.run(new Uint8Array(read('fr-4-station-a443064001-h-v11.synthetic')), ctx(KEY));
    expect(station?.forecasts?.[0]).toMatchObject({ target: 'FR-1', series: KEY });
    for (const [name, variant] of [
      ['fr-4', 'H'],
      ['fr-4', ''],
      ['fr-4-no-forecast.synthetic', KEY],
      ['fr-4-station-a443064001-h-empty-prevs.synthetic', KEY],
    ] as const) {
      const out = await spec?.run(new Uint8Array(read(name)), ctx(variant));
      expect([name, out?.forecasts, out?.dropped]).toEqual([name, undefined, {}]);
    }
    await expect(
      Promise.resolve().then(() => spec?.run(new Uint8Array(read('fr-4-error.synthetic')), ctx(KEY))),
    ).rejects.toMatchObject({
      code: 'provider_error',
    });
  });
});

describe('properties', () => {
  const column = fc.oneof(
    fc.integer({ min: -500, max: 90_000 }).map((n) => n / 100),
    fc.constant(null),
  );
  const document = fc.record({
    grd: fc.constantFrom('H', 'Q'),
    // Minutes between points: strictly increasing, at most 60 x 60 min, inside the 72 h horizon.
    steps: fc.array(fc.integer({ min: 1, max: 60 }), { minLength: 0, maxLength: 60 }),
    cols: fc.array(fc.tuple(column, column, column), { minLength: 60, maxLength: 60 }),
  });
  const build = (d: { grd: string; steps: number[]; cols: [Res, Res, Res][] }) => {
    let at = PROD;
    const points: PrevDoc[] = d.steps.map((s, i) => {
      at += s * 60_000;
      const [lo, mid, hi] = d.cols[i] as [Res, Res, Res];
      return { DtPrev: label(at), ResMinPrev: lo, ResMoyPrev: mid, ResMaxPrev: hi };
    });
    return { points, doc: station({ grd: d.grd, Prevs: points }) };
  };

  it('every point is stored as p10 / p50 / p90 in the series’ unit, value = p50, in order of the body; the core counts the empty ones', () => {
    fc.assert(
      fc.property(document, (d) => {
        const { points, doc } = build(d);
        const out = norm(doc, `A443064001/${d.grd}`);
        if (points.length === 0) {
          expect(out.forecasts).toBeUndefined();
          expect(out.dropped).toEqual({});
          return;
        }
        const factor = d.grd === 'H' ? 100 : 1;
        const stored = out.forecasts?.[0]?.points ?? [];
        expect(out.forecasts?.[0]?.series).toBe(`A443064001/${d.grd}`);
        expect(stored).toHaveLength(points.length);
        for (const [i, p] of points.entries()) {
          const s = stored[i];
          for (const [col, x] of [
            ['p10', p.ResMinPrev],
            ['p50', p.ResMoyPrev],
            ['p90', p.ResMaxPrev],
          ] as const) {
            if (x === null) expect(s?.[col]).toBeNull();
            else expect(s?.[col]).toBeCloseTo(x * factor, 2);
          }
          expect(s?.value).toBe(s?.p50);
          expect(s?.flags).toBe(0);
        }
        // The core drops exactly the points with no value at all, and flags what is out of order.
        const empty = points.filter(
          (p) => p.ResMinPrev === null && p.ResMoyPrev === null && p.ResMaxPrev === null,
        ).length;
        const c = checked(out);
        expect(c.dropped.gap ?? 0).toBe(empty);
        expect(c.run?.points.length ?? 0).toBe(points.length - empty);
        expect(c.dropped.empty_run ?? 0).toBe(empty === points.length ? 1 : 0);
      }),
    );
  });

  it('the canonical run does not depend on the offset the instants are labelled with', () => {
    fc.assert(
      fc.property(document, fc.constantFrom('+02:00', '+00:00', '-05:00', '+01:00'), (d, offset) => {
        const { points, doc } = build(d);
        if (points.length === 0) return;
        const relabelled = station({
          grd: d.grd,
          DtProdSimul: label(PROD, offset),
          Prevs: points.map((p) => ({ ...p, DtPrev: label(Date.parse(p.DtPrev), offset) })),
        });
        const [a, b] = [norm(doc, `A443064001/${d.grd}`), norm(relabelled, `A443064001/${d.grd}`)];
        expect(b).toEqual(a);
      }),
    );
  });

  it('the parser answers any bytes with a document or a SchemaDrift, never another error', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.uint8Array({ maxLength: 300 }),
          fc.json().map((j) => Buffer.from(j)),
        ),
        (b) => {
          try {
            const doc: Parsed = parseDocument(b);
            expect(['station', 'list', 'none']).toContain(doc.kind);
          } catch (err) {
            expect(err).toBeInstanceOf(SchemaDrift);
          }
        },
      ),
    );
  });
});
