import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { type Normalised, ObsRow, QC, SchemaDrift, TO_NAP } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Context, normaliseObservations, normaliseStations } from '../../src/adapters/fr-1/normalise.ts';
import { type Observation, parseObservations, parseStations, type Station } from '../../src/adapters/fr-1/parse.ts';
import { goldenUrl, rawFixture, registryOf } from './registry.ts';

// FR-1 Hub'Eau observations_tr and referentiel/stations: parse + normalise of
// real recorded payloads equals the committed golden files (invariant 9).
// `UPDATE_GOLDEN=1` rewrites them; a golden change is reviewed like code.

const registry = registryOf('FR-1');
/** Raw rows of a fixture, as the provider sent them (for the oracles of the spot checks). */
const rawData = <T>(name: string) => JSON.parse(rawFixture('FR-1', name).body.toString('utf8')).data as T[];
const rawObs = (name: string) => rawData<Observation>(name);
const rawStations = (name: string) => rawData<Station>(name);

function ctx(name: string): Context {
  return { registry, fetchedAt: Date.parse(rawFixture('FR-1', name).meta.recorded_at) };
}

function golden(name: string, actual: Normalised): Normalised {
  const url = goldenUrl('FR-1', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const obs = (name: string) => normaliseObservations(parseObservations(rawFixture('FR-1', name).body).data, ctx(name));
const stations = (name: string) => normaliseStations(parseStations(rawFixture('FR-1', name).body), ctx(name));
const find = (out: Normalised, series: string, ts: string) => out.obs.find((r) => r.series === series && r.ts === ts);

describe('golden files (real payloads)', () => {
  it('the live page (5,660 rows): every site-level duplicate dropped, the rest as published', () => {
    const out = obs('fr-1-obs');
    expect(out).toEqual(golden('fr-1-obs', out));
    const raw = rawObs('fr-1-obs');
    expect(raw).toHaveLength(5660);
    // A row without `code_station` is a site-level series that duplicates the station's own.
    const siteLevel = raw.filter((r) => r.code_station === null).length;
    expect(siteLevel).toBe(1725);
    expect(out.dropped).toEqual({ site_level: siteLevel });
    expect(out.unknown).toBe(0);
    expect(out.obs).toHaveLength(5660 - siteLevel);
    // First published rows of A402061001 at "2026-09-29T13:30:00Z": H -232 mm, Q 75 l/s.
    expect(find(out, 'A402061001/H', '2026-09-29T13:30:00.000Z')).toEqual({
      series: 'A402061001/H',
      ts: '2026-09-29T13:30:00.000Z',
      value: -23.2,
      qc: QC.RAW,
    });
    expect(find(out, 'A402061001/Q', '2026-09-29T13:30:00.000Z')?.value).toBe(0.075);
    // Time is UTC as published: every stored instant is a published one, unshifted.
    const published = new Set(raw.map((r) => new Date(r.date_obs).toISOString()));
    for (const r of out.obs) expect(published.has(r.ts)).toBe(true);
  });

  it('negative Q is kept and marked with the range bit; a negative stage is kept without it', () => {
    const out = obs('fr-1-obs');
    // E171551101 Q "2026-09-29T12:55:00Z" -5650 l/s (qualification 16: no provider bit).
    expect(find(out, 'E171551101/Q', '2026-09-29T12:55:00.000Z')).toEqual({
      series: 'E171551101/Q',
      ts: '2026-09-29T12:55:00.000Z',
      value: -5.65,
      qc: QC.RAW | QC.RANGE,
    });
    // E172751201 H -43 mm and Q -1250 l/s: the stage has no range bit, the discharge has.
    expect(find(out, 'E172751201/H', '2026-09-29T12:55:00.000Z')).toMatchObject({ value: -4.3, qc: QC.RAW });
    expect(find(out, 'E172751201/Q', '2026-09-29T12:50:00.000Z')).toMatchObject({
      value: -1.25,
      qc: QC.RAW | QC.RANGE,
    });
    // Every negative published Q (of a registered series) carries the bit, every negative H does not.
    const raw = rawObs('fr-1-obs').filter((r) => r.code_station !== null && (r.resultat_obs ?? 0) < 0);
    expect(raw.filter((r) => r.grandeur_hydro === 'Q')).toHaveLength(11);
    for (const r of raw) {
      const row = find(out, `${r.code_station}/${r.grandeur_hydro}`, r.date_obs.replace('Z', '.000Z'));
      expect(row === undefined ? null : (row.qc & QC.RANGE) !== 0).toBe(r.grandeur_hydro === 'Q');
    }
    expect(out.obs.filter((r) => r.series.endsWith('/Q') && r.value < 0).every((r) => r.qc & QC.RANGE)).toBe(true);
    expect(out.obs.filter((r) => r.series.endsWith('/H') && r.value < 0).some((r) => r.qc & QC.RANGE)).toBe(false);
  });

  it('an implausible stage (D015658001 at Eppe-Sauvage publishes about 172 m) is kept, with the range bit', () => {
    const out = obs('fr-1-obs');
    // 172327 mm "2026-09-29T13:00:00Z" → 17,232.7 cm, beyond the plausible stage range.
    expect(find(out, 'D015658001/H', '2026-09-29T13:00:00.000Z')).toEqual({
      series: 'D015658001/H',
      ts: '2026-09-29T13:00:00.000Z',
      value: 17232.7,
      qc: QC.RAW | QC.RANGE,
    });
    expect(out.obs.filter((r) => r.qc & QC.RANGE && r.value > 0).every((r) => r.series === 'D015658001/H')).toBe(true);
  });

  it('qualification 12 "douteuse" sets the provider-suspect bit; 16 and 20 set none', () => {
    const out = obs('fr-1-obs');
    // A414020201 Q "2026-09-29T13:30:00Z" 509 l/s, statut 4, qualification 12.
    expect(find(out, 'A414020201/Q', '2026-09-29T13:30:00.000Z')).toMatchObject({
      value: 0.509,
      qc: QC.RAW | QC.PROVIDER_SUSPECT,
    });
    const raw = rawObs('fr-1-obs').filter((r) => r.code_station !== null);
    const suspect = raw.filter((r) => r.code_qualification_obs === 12).length;
    expect(suspect).toBeGreaterThan(0);
    expect(out.obs.filter((r) => r.qc & QC.PROVIDER_SUSPECT)).toHaveLength(suspect);
  });

  it('page 1 of a seed walk (HTTP 206): the last 400 rows of the page, 08:40Z down to 08:30Z', () => {
    const out = obs('fr-1-obs-page1');
    expect(out).toEqual(golden('fr-1-obs-page1', out));
    expect(rawFixture('FR-1', 'fr-1-obs-page1').meta.status).toBe(206);
    // First published row: D022000201 Q 58 l/s at 08:40Z, statut 4, qualification 16.
    expect(find(out, 'D022000201/Q', '2026-09-01T08:40:00.000Z')).toEqual({
      series: 'D022000201/Q',
      ts: '2026-09-01T08:40:00.000Z',
      value: 0.058,
      qc: QC.RAW,
    });
    // The last published row is the page's cursor row: A211030001 H 196 mm, statut 12, at 08:30Z.
    expect(find(out, 'A211030001/H', '2026-09-01T08:30:00.000Z')).toEqual({
      series: 'A211030001/H',
      ts: '2026-09-01T08:30:00.000Z',
      value: 19.6,
      qc: QC.RAW,
    });
    // Every row is the page's own: site-level duplicates dropped, the rest as published and all registered
    // (E201000501 Q, a tier-1 discharge that only the seed pages show, is in the registry since the full-page derivation).
    const raw = rawObs('fr-1-obs-page1');
    const siteLevel = raw.filter((r) => r.code_station === null).length;
    expect(out.dropped).toEqual({ site_level: siteLevel });
    expect(out.unknown).toBe(0);
    expect(out.obs).toHaveLength(raw.length - siteLevel);
    expect(find(out, 'E201000501/Q', '2026-09-01T08:40:00.000Z')).toMatchObject({
      value: 1.62,
      qc: QC.RAW | QC.PROVIDER_SUSPECT,
    });
  });

  it('[CI] 491 mm → 49.1 cm on the real rows of both pages (A420063002 H at 08:35Z, 08:30Z and 08:25Z)', () => {
    const page1 = obs('fr-1-obs-page1');
    const page2 = obs('fr-1-obs-page2');
    // Published: A420063002 H 491 mm, statut 4, qualification 16, on page 1 at 08:35Z and on page 2 at 08:30Z and 08:25Z.
    expect(
      rawObs('fr-1-obs-page1')
        .filter((r) => r.code_station === 'A420063002')
        .map((r) => [r.date_obs, r.resultat_obs]),
    ).toEqual([['2026-09-01T08:35:00Z', 491]]);
    expect(
      rawObs('fr-1-obs-page2')
        .filter((r) => r.code_station === 'A420063002')
        .map((r) => [r.date_obs, r.resultat_obs]),
    ).toEqual([
      ['2026-09-01T08:30:00Z', 491],
      ['2026-09-01T08:25:00Z', 491],
    ]);
    for (const [out, ts] of [
      [page1, '2026-09-01T08:35:00.000Z'],
      [page2, '2026-09-01T08:30:00.000Z'],
      [page2, '2026-09-01T08:25:00.000Z'],
    ] as const) {
      expect(find(out, 'A420063002/H', ts)).toEqual({ series: 'A420063002/H', ts, value: 49.1, qc: QC.RAW });
    }
  });

  it('page 2: statuts 4, 8 and 12 → raw, qualification 12 → provider-suspect, a negative Q → range bit', () => {
    const out = obs('fr-1-obs-page2');
    expect(out).toEqual(golden('fr-1-obs-page2', out));
    // First published row: A211030001 Q 92 l/s, statut 12, qualification 20.
    expect(find(out, 'A211030001/Q', '2026-09-01T08:30:00.000Z')).toEqual({
      series: 'A211030001/Q',
      ts: '2026-09-01T08:30:00.000Z',
      value: 0.092,
      qc: QC.RAW,
    });
    // Statut 8 (corrected): E351851001 H 94 mm.
    expect(find(out, 'E351851001/H', '2026-09-01T08:30:00.000Z')).toMatchObject({ value: 9.4, qc: QC.RAW });
    // E361121001 Q -4960 l/s: kept, with the range bit; the negative stages of the page are plain.
    expect(find(out, 'E361121001/Q', '2026-09-01T08:30:00.000Z')).toMatchObject({
      value: -4.96,
      qc: QC.RAW | QC.RANGE,
    });
    expect(find(out, 'A764201001/H', '2026-09-01T08:30:00.000Z')).toMatchObject({ value: -29.2, qc: QC.RAW });
    // A gauge that publishes off the 5-minute grid keeps its instants as published (no thinning in FR-1).
    expect(find(out, 'D015656001/H', '2026-09-01T08:27:30.000Z')).toMatchObject({ value: -21.9 });
    const raw = rawObs('fr-1-obs-page2').filter((r) => r.code_station !== null);
    expect(raw.some((r) => r.code_statut === 12) && raw.some((r) => r.code_qualification_obs === 12)).toBe(true);
    expect(new Set(out.obs.map((r) => r.qc))).toEqual(
      new Set([QC.RAW, QC.RAW | QC.PROVIDER_SUSPECT, QC.RAW | QC.RANGE]),
    );
  });

  it('the empty last page of a walk: `count` is the walk total, never compared with the page', () => {
    const { body } = rawFixture('FR-1', 'fr-1-obs-empty');
    const page = parseObservations(body);
    expect(page).toEqual({ next: null, data: [] });
    expect(JSON.parse(body.toString('utf8')).count).toBe(89502);
    const out = obs('fr-1-obs-empty');
    expect(out).toEqual(golden('fr-1-obs-empty', out));
    expect(out).toEqual({ obs: [], gaugeZeros: [], dropped: {}, unknown: 0 });
  });

  it('referentiel A: the published gauge zero of every registered H series, datum IGN69 or NGF1884', () => {
    const out = stations('fr-1-ref');
    expect(out).toEqual(golden('fr-1-ref', out));
    expect(out.obs).toEqual([]);
    // Oracle straight from the raw stations: registered H series by zero system.
    const raw = rawStations('fr-1-ref').filter((s) => registry.has(`${s.code_station}/H`));
    const system = (s: Station) => s.code_systeme_alti_site;
    const stored = raw.filter((s) => s.altitude_ref_alti_station !== null && [2, 3].includes(system(s) ?? -1));
    expect(out.gaugeZeros).toHaveLength(stored.length);
    expect(out.dropped).toEqual({
      zero_missing: raw.filter((s) => s.altitude_ref_alti_station === null).length,
      zero_datum_unknown: raw.filter((s) => s.altitude_ref_alti_station !== null && ![2, 3].includes(system(s) ?? -1))
        .length,
    });
    for (const s of stored) {
      expect(out.gaugeZeros.find((z) => z.series === `${s.code_station}/H`)).toMatchObject({
        value_m: s.altitude_ref_alti_station,
        datum: s.code_systeme_alti_site === 3 ? 'IGN69' : 'NGF1884',
      });
    }
    // Systems 0 and 1 and no system at all are counted and never stored.
    expect(new Set(raw.map((s) => s.code_systeme_alti_site))).toEqual(new Set([0, 1, 2, 3, null]));
    expect(new Set(out.gaugeZeros.map((z) => z.datum))).toEqual(new Set(['IGN69', 'NGF1884']));
    // IGN69 and NGF1884 are never converted to NAP (D16): no stored zero can feed a NAP height.
    for (const z of out.gaugeZeros) expect(TO_NAP[z.datum].converted).toBe(false);
  });

  it('referentiel E3: the bad zeros (13318.0, 0.01267) are stored as published, untrusted by their datum', () => {
    const out = stations('fr-1-ref-E3');
    expect(out).toEqual(golden('fr-1-ref-E3', out));
    const zero = (code: string) => out.gaugeZeros.find((z) => z.series === `${code}/H`);
    // E364121002 La Lys à Merville - DREAL: 13318.0 m (a metre/millimetre mix-up at the provider).
    expect(zero('E364121002')).toEqual({
      series: 'E364121002/H',
      value_m: 13318,
      datum: 'IGN69',
      valid_from: '2013-01-31T00:00:00.000Z',
    });
    expect(zero('E367125002')).toMatchObject({ value_m: 0.01267, datum: 'IGN69' });
    for (const z of out.gaugeZeros) expect(TO_NAP[z.datum].converted).toBe(false);
  });
});

describe('pagination: a walk is several payloads (P1), each loaded on its own', () => {
  const cursorOf = (next: string | null) =>
    Buffer.from(decodeURIComponent(new URL(next as string).searchParams.get('cursor') as string), 'base64').toString(
      'latin1',
    );
  const key = (r: { series: string; ts: string }) => `${r.series}@${r.ts}`;

  it('[CI] pagination across 2 pages plus a 206 response: both say next, the rows meet at 08:30Z, the union holds each row once', () => {
    const page1 = parseObservations(rawFixture('FR-1', 'fr-1-obs-page1').body);
    const page2 = parseObservations(rawFixture('FR-1', 'fr-1-obs-page2').body);
    expect([
      rawFixture('FR-1', 'fr-1-obs-page1').meta.status,
      rawFixture('FR-1', 'fr-1-obs-page2').meta.status,
    ]).toEqual([206, 206]);
    // A page with a `next` says the walk goes on.
    expect(page1.next).toMatch(/^https:\/\/hubeau\.eaufrance\.fr\/api\/v2\/hydrometrie\/observations_tr\?/);
    expect(page2.next).not.toBeNull();
    // The cursor of page 1 is its last row (A211030001 H, 08:30Z) and page 2 goes on with the very next row
    // (A211030001 Q, 08:30Z): the pages meet at one instant, with no row missing and none stated twice.
    expect(cursorOf(page1.next)).toContain('A211030001_H_2026-09-01T08:30:00');
    expect(page1.data.at(-1)).toMatchObject({
      code_station: 'A211030001',
      grandeur_hydro: 'H',
      date_obs: '2026-09-01T08:30:00Z',
    });
    expect(page2.data[0]).toMatchObject({
      code_station: 'A211030001',
      grandeur_hydro: 'Q',
      date_obs: '2026-09-01T08:30:00Z',
    });
    expect(new Set([...page1.data, ...page2.data].map((r) => JSON.stringify(r))).size).toBe(
      page1.data.length + page2.data.length,
    );
    // The union of the two normalised pages, merged by (series, instant), is every row once, and 08:30Z is on both.
    const a = obs('fr-1-obs-page1').obs;
    const b = obs('fr-1-obs-page2').obs;
    const merged = new Map([...a, ...b].map((r) => [key(r), r]));
    expect(merged.size).toBe(a.length + b.length);
    const at0830 = (rows: typeof a) => rows.filter((r) => r.ts === '2026-09-01T08:30:00.000Z').length;
    expect([at0830(a) > 0, at0830(b) > 0]).toEqual([true, true]);
    expect(merged.get(key({ series: 'A211030001/H', ts: '2026-09-01T08:30:00.000Z' }))?.value).toBe(19.6);
    expect(merged.get(key({ series: 'A211030001/Q', ts: '2026-09-01T08:30:00.000Z' }))?.value).toBe(0.092);
  });

  it('pages of one walk overlap by a minute: a shared row is one row in the union (derived: the recorded pages are adjacent)', () => {
    const rows = parseObservations(rawFixture('FR-1', 'fr-1-obs-page2').body).data;
    // The recorded pages are adjacent, not overlapping: two pages cut from the real page 2 with 100 rows in common
    // (derived, not recorded) show what the loader's upsert gets from the one-minute overlap of successive runs.
    const first = normaliseObservations(rows.slice(0, 300), ctx('fr-1-obs-page2'));
    const second = normaliseObservations(rows.slice(200), ctx('fr-1-obs-page2'));
    const whole = obs('fr-1-obs-page2');
    const shared = first.obs.filter((r) => second.obs.some((s) => key(s) === key(r)));
    expect(shared.length).toBeGreaterThan(0);
    const merged = new Map([...first.obs, ...second.obs].map((r) => [key(r), r]));
    expect(merged.size).toBe(first.obs.length + second.obs.length - shared.length);
    expect(
      [...merged.values()].sort((x, y) => (x.series < y.series ? -1 : x.series > y.series ? 1 : x.ts < y.ts ? -1 : 1)),
    ).toEqual(whole.obs);
    // And each page states the shared rows identically.
    for (const r of shared) expect(second.obs).toContainEqual(r);
  });
});

describe('empty and error payloads (real)', () => {
  it('a referentiel prefix is not an observations page and the other way round', () => {
    expect(() => parseObservations(rawFixture('FR-1', 'fr-1-ref').body)).toThrow(SchemaDrift);
    expect(() => parseStations(rawFixture('FR-1', 'fr-1-obs').body)).toThrow(SchemaDrift);
  });

  it('error and non-JSON bodies are not a payload', () => {
    for (const body of ['', '<html>Bad Gateway</html>', '{"code":404,"message":"x"}', '[]', 'null']) {
      expect(() => parseObservations(Buffer.from(body))).toThrow(SchemaDrift);
      expect(() => parseStations(Buffer.from(body))).toThrow(SchemaDrift);
    }
  });
});

describe('synthetic payloads [U]', () => {
  const at = Date.parse('2026-09-30T12:00:00Z');
  const base: Context = { registry, fetchedAt: at };
  const row = (o: Partial<Observation> = {}): Observation => ({
    code_site: 'A8500610',
    code_station: 'A850061001',
    grandeur_hydro: 'Q',
    date_obs: '2026-09-30T11:55:00Z',
    resultat_obs: 17300,
    code_statut: 4,
    code_qualification_obs: 16,
    ...o,
  });
  const one = (o: Partial<Observation> = {}, c: Context = base) => normaliseObservations([row(o)], c);

  it("[CI] 17,300 l/s → 17.3 m³/s (a one-row synthetic page; the factor is the registry's)", () => {
    expect(one()).toEqual({
      obs: [{ series: 'A850061001/Q', ts: '2026-09-30T11:55:00.000Z', value: 17.3, qc: QC.RAW }],
      gaugeZeros: [],
      dropped: {},
      unknown: 0,
    });
    // The same row as H: 17,300 mm → 1,730 cm.
    expect(one({ grandeur_hydro: 'H' }).obs[0]).toMatchObject({ series: 'A850061001/H', value: 1730 });
  });

  it('statut 4 → raw, 16 → validated, 0, 8 and 12 → raw; any other statut is withheld (unknown_quality)', () => {
    const qc = (code_statut: number) => one({ code_statut }).obs[0]?.qc;
    expect([0, 4, 8, 12].map(qc)).toEqual([QC.RAW, QC.RAW, QC.RAW, QC.RAW]);
    expect(qc(16)).toBe(QC.VALIDATED);
    for (const code_statut of [1, 2, 20, -1, 99]) {
      expect(one({ code_statut })).toMatchObject({ obs: [], dropped: { unknown_quality: 1 } });
    }
  });

  it('qualification 12 → provider-suspect, 16 and 20 → no bit; any other is withheld (unknown_quality)', () => {
    const qc = (code_qualification_obs: number) => one({ code_qualification_obs }).obs[0]?.qc;
    expect(qc(12)).toBe(QC.RAW | QC.PROVIDER_SUSPECT);
    expect([16, 20].map(qc)).toEqual([QC.RAW, QC.RAW]);
    expect(one({ code_statut: 16, code_qualification_obs: 12 }).obs[0]?.qc).toBe(QC.VALIDATED | QC.PROVIDER_SUSPECT);
    for (const code_qualification_obs of [0, 8, 14, 21, 99]) {
      expect(one({ code_qualification_obs })).toMatchObject({ obs: [], dropped: { unknown_quality: 1 } });
    }
  });

  it('an unknown quality code withholds only its own row and is counted, the rest of the page loads', () => {
    const out = normaliseObservations([row({ code_statut: 77 }), row({ date_obs: '2026-09-30T11:50:00Z' })], base);
    expect(out.obs.map((r) => r.ts)).toEqual(['2026-09-30T11:50:00.000Z']);
    expect(out.dropped).toEqual({ unknown_quality: 1 });
  });

  it('a negative Q is kept with the range bit, a negative H without; an implausible stage gets the bit too', () => {
    expect(one({ resultat_obs: -250 }).obs[0]).toMatchObject({ value: -0.25, qc: QC.RAW | QC.RANGE });
    expect(one({ grandeur_hydro: 'H', resultat_obs: -250 }).obs[0]).toMatchObject({ value: -25, qc: QC.RAW });
    expect(one({ grandeur_hydro: 'H', resultat_obs: 80_000 }).obs[0]).toMatchObject({
      value: 8000,
      qc: QC.RAW | QC.RANGE,
    });
    expect(one({ resultat_obs: 0 }).obs[0]).toMatchObject({ value: 0, qc: QC.RAW });
  });

  it('a row of 1e300 makes the page value_out_of_range drift, never a database overflow (review SR-2)', () => {
    const page = [row({ date_obs: '2026-09-30T11:50:00Z' }), row({ resultat_obs: 1e300 })];
    expect(() => normaliseObservations(page, base)).toThrow(expect.objectContaining({ code: 'value_out_of_range' }));
    expect(() => one({ grandeur_hydro: 'H', resultat_obs: -1e300 })).toThrow(
      expect.objectContaining({ code: 'value_out_of_range' }),
    );
    // 1e10 l/s is 1e7 m³/s, the largest discharge kept (with the range bit); 100 m³/s more is drift.
    expect(one({ resultat_obs: 1e10 }).obs[0]).toMatchObject({ value: 1e7, qc: QC.RAW | QC.RANGE });
    expect(() => one({ resultat_obs: 1.00001e10 })).toThrow(expect.objectContaining({ code: 'value_out_of_range' }));
  });

  it('a null value is a gap, an unregistered station is counted, a site-level row is dropped', () => {
    expect(one({ resultat_obs: null })).toEqual({ obs: [], gaugeZeros: [], dropped: { gap: 1 }, unknown: 0 });
    expect(one({ code_station: 'Z999999999' })).toMatchObject({ obs: [], unknown: 1, dropped: {} });
    expect(one({ code_station: null })).toMatchObject({ obs: [], unknown: 0, dropped: { site_level: 1 } });
    // The unit of an unregistered series is never guessed, and a registered Q with another grandeur is another series.
    expect(one({ code_station: 'A850061001', grandeur_hydro: 'H' }).obs[0]?.series).toBe('A850061001/H');
  });

  it('a duplicate in the page is kept once; two values for one instant are both withheld (conflict)', () => {
    expect(normaliseObservations([row(), row()], base)).toMatchObject({
      obs: [{ value: 17.3 }],
      dropped: { duplicate: 1 },
    });
    const conflict = normaliseObservations([row(), row({ resultat_obs: 17400 })], base);
    expect(conflict.obs).toEqual([]);
    expect(conflict.dropped).toEqual({ conflict: 2 });
    // A third statement of a withheld instant is withheld too, whichever value it has.
    expect(normaliseObservations([row(), row({ resultat_obs: 17400 }), row()], base).dropped).toEqual({ conflict: 3 });
    // The same value with another quality is a different statement.
    const quality = normaliseObservations([row(), row({ code_qualification_obs: 12 })], base);
    expect([quality.obs, quality.dropped]).toEqual([[], { conflict: 2 }]);
    // Another instant, another series, another quantity are no conflict.
    const apart = normaliseObservations(
      [
        row(),
        row({ date_obs: '2026-09-30T11:50:00Z' }),
        row({ grandeur_hydro: 'H' }),
        row({ code_station: 'A302009050' }),
      ],
      base,
    );
    expect(apart.obs).toHaveLength(4);
    expect(apart.dropped).toEqual({});
  });

  it('an instant with an explicit offset is accepted as stated; one without an offset is drift', () => {
    expect(one({ date_obs: '2026-09-30T13:55:00+02:00' }).obs[0]?.ts).toBe('2026-09-30T11:55:00.000Z');
    expect(one({ date_obs: '2026-09-30T10:55:00-01:00' }).obs[0]?.ts).toBe('2026-09-30T11:55:00.000Z');
    for (const date_obs of ['2026-09-30T11:55:00', '2026-09-30', '30/09/2026 11:55', '', 'not a date']) {
      expect(() => one({ date_obs })).toThrow(SchemaDrift);
    }
    expect(() => one({ date_obs: '2026-09-30T11:55:00' })).toThrow(
      expect.objectContaining({ code: 'time_bad_format' }),
    );
  });

  it('a row more than 15 minutes ahead of the fetch is rejected; 15 minutes exactly is kept', () => {
    const t = (ms: number) => new Date(at + ms).toISOString().replace('.000Z', 'Z');
    expect(one({ date_obs: t(15 * 60_000) }).obs).toHaveLength(1);
    expect(one({ date_obs: t(15 * 60_000 + 1000) })).toMatchObject({ obs: [], dropped: { future: 1 } });
    expect(one({ date_obs: t(86_400_000) })).toMatchObject({ obs: [], dropped: { future: 1 } });
  });

  it('a row older than 45 days is dropped (the seed reaches 30 days back)', () => {
    const t = (ms: number) => new Date(at - ms).toISOString().replace('.000Z', 'Z');
    expect(one({ date_obs: t(45 * 86_400_000) }).obs).toHaveLength(1);
    expect(one({ date_obs: t(45 * 86_400_000 + 1000) })).toMatchObject({ obs: [], dropped: { too_old: 1 } });
  });

  it('the rows come out sorted by series, then by time, whatever order the page has', () => {
    const rows = [
      row({ date_obs: '2026-09-30T11:55:00Z' }),
      row({ code_station: 'A302009050', grandeur_hydro: 'H', date_obs: '2026-09-30T11:50:00Z' }),
      row({ date_obs: '2026-09-30T11:45:00Z' }),
      row({ grandeur_hydro: 'H', date_obs: '2026-09-30T11:50:00Z' }),
    ];
    expect(normaliseObservations(rows, base).obs.map((r) => `${r.series}@${r.ts.slice(11, 16)}`)).toEqual([
      'A302009050/H@11:50',
      'A850061001/H@11:50',
      'A850061001/Q@11:45',
      'A850061001/Q@11:55',
    ]);
  });
});

describe('gauge zeros [U]', () => {
  const real = parseStations(rawFixture('FR-1', 'fr-1-ref').body).find(
    (s) => s.code_station === 'A850061001',
  ) as Station;
  const zero = (o: Partial<Station>) =>
    normaliseStations([{ ...real, ...o }], { registry, fetchedAt: Date.parse('2026-09-30T12:00:00Z') });

  it('the real station of the template has a zero in IGN69 (system 3)', () => {
    expect(real.code_systeme_alti_site).toBe(3);
    expect(zero({}).gaugeZeros).toEqual([
      {
        series: 'A850061001/H',
        value_m: real.altitude_ref_alti_station,
        datum: 'IGN69',
        valid_from: new Date(real.date_debut_ref_alti_station as string).toISOString(),
      },
    ]);
  });

  it('system 3 → IGN69, system 2 → NGF1884; 0, 1 and no system are counted and never stored', () => {
    expect(zero({ code_systeme_alti_site: 3 }).gaugeZeros[0]?.datum).toBe('IGN69');
    expect(zero({ code_systeme_alti_site: 2 }).gaugeZeros[0]?.datum).toBe('NGF1884');
    for (const code_systeme_alti_site of [0, 1, null, 4, 99]) {
      expect(zero({ code_systeme_alti_site })).toEqual({
        obs: [],
        gaugeZeros: [],
        dropped: { zero_datum_unknown: 1 },
        unknown: 0,
      });
    }
  });

  it('a null altitude is counted, never stored as 0', () => {
    expect(zero({ altitude_ref_alti_station: null })).toEqual({
      obs: [],
      gaugeZeros: [],
      dropped: { zero_missing: 1 },
      unknown: 0,
    });
    // A zero of 0.0 m is a value, not a missing one.
    expect(zero({ altitude_ref_alti_station: 0 }).gaugeZeros[0]?.value_m).toBe(0);
  });

  it('a station the registry does not know is ignored; a zero start date is an instant or null; a bad one is drift', () => {
    expect(zero({ code_station: 'Z999999999' })).toEqual({ obs: [], gaugeZeros: [], dropped: {}, unknown: 0 });
    expect(zero({ date_debut_ref_alti_station: null }).gaugeZeros[0]?.valid_from).toBeNull();
    expect(zero({ date_debut_ref_alti_station: '2020-06-01T00:00:00Z' }).gaugeZeros[0]?.valid_from).toBe(
      '2020-06-01T00:00:00.000Z',
    );
    expect(() => zero({ date_debut_ref_alti_station: '2020-06-01' })).toThrow(
      expect.objectContaining({ code: 'time_bad_format' }),
    );
  });

  it('no stored zero ever has a datum that converts to NAP, for any system', () => {
    for (const system of [-1, 0, 1, 2, 3, 4, null]) {
      for (const z of zero({ code_systeme_alti_site: system }).gaugeZeros)
        expect(TO_NAP[z.datum].converted).toBe(false);
    }
  });
});

describe('strict schemas', () => {
  const page = (o: Record<string, unknown> = {}, data: unknown[] = []) =>
    Buffer.from(JSON.stringify({ count: 0, first: null, prev: null, next: null, api_version: '2.0.1', data, ...o }));
  const real = rawObs('fr-1-obs')[0] as Observation;

  it('a page without next/prev/first, with an unknown key or with a wrong count type is drift', () => {
    expect(parseObservations(page({ count: 0 }))).toEqual({ next: null, data: [] });
    expect(parseObservations(page({}, [real])).data).toHaveLength(1);
    for (const bad of [{ count: -1 }, { count: 1.5 }, { count: '1' }, { api_version: 2 }, { extra: 1 }, { next: 5 }]) {
      expect(() => parseObservations(page(bad))).toThrow(SchemaDrift);
    }
    expect(() => parseObservations(Buffer.from('{"count":0,"data":[]}'))).toThrow(SchemaDrift);
  });

  it('an observation with an unknown or missing field, another grandeur or a wrong type is drift with a path', () => {
    const drift = (o: Record<string, unknown>) => {
      try {
        parseObservations(page({}, [{ ...real, ...o }]));
      } catch (err) {
        return err instanceof SchemaDrift ? `${err.code} at ${err.path}` : 'other';
      }
      return 'parsed';
    };
    expect(drift({ grandeur_hydro: 'Qj' })).toBe('invalid_value at data.0.grandeur_hydro');
    expect(drift({ resultat_obs: '12' })).toBe('invalid_type at data.0.resultat_obs');
    expect(drift({ code_statut: 4.5 })).toBe('invalid_type at data.0.code_statut');
    expect(drift({ hauteur: 1 })).toBe('unrecognized_keys at data.0');
    expect(drift({ date_obs: 'x'.repeat(41) })).toBe('too_big at data.0.date_obs');
    expect(drift({ resultat_obs: null })).toBe('parsed');
  });

  it('a station with a new field is drift; a long list of networks is capped before its elements', () => {
    const station = rawStations('fr-1-ref')[0] as Station;
    const bodyOf = (s: unknown) =>
      Buffer.from(JSON.stringify({ count: 1, first: null, prev: null, next: null, api_version: '2', data: [s] }));
    expect(parseStations(bodyOf(station))).toHaveLength(1);
    expect(() => parseStations(bodyOf({ ...station, nouveau: 1 }))).toThrow(SchemaDrift);
    expect(() => parseStations(bodyOf({ ...station, code_sandre_reseau_station: Array(101).fill('x') }))).toThrow(
      expect.objectContaining({ code: 'too_big' }),
    );
  });
});

describe('bounded parsing', () => {
  // The hostile bodies themselves run in child processes with a small heap: bounded.int.test.ts.
  it('a page over its item cap is too_big before any element is parsed', () => {
    const body = Buffer.from(
      `{"count":0,"first":null,"prev":null,"next":null,"api_version":"2","data":[${Array(20_001).fill('0').join(',')}]}`,
    );
    expect(() => parseObservations(body)).toThrow(expect.objectContaining({ code: 'too_big', path: 'data' }));
  });

  it('a body with more values than the node cap is refused by the scan', () => {
    const body = Buffer.from(
      `{"count":0,"first":null,"prev":null,"next":null,"api_version":"2","data":[${Array(250_001).fill('0').join(',')}]}`,
    );
    expect(() => parseObservations(body)).toThrow(expect.objectContaining({ code: 'json_too_many_nodes' }));
    expect(() => parseObservations(Buffer.from(`${'['.repeat(5)}0${']'.repeat(5)}`))).toThrow(
      expect.objectContaining({ code: 'json_too_deep' }),
    );
  });

  it('the caps admit a full page of 20,000 recorded rows (the usual size with the 4 h window of #53)', () => {
    const rows = rawObs('fr-1-obs');
    const data = Array.from({ length: 20_000 }, (_, i) => rows[i % rows.length]);
    const page = JSON.parse(rawFixture('FR-1', 'fr-1-obs').body.toString('utf8'));
    const body = Buffer.from(JSON.stringify({ ...page, count: 20_000, data }));
    expect(parseObservations(body).data).toHaveLength(20_000);
  });

  it('the caps admit every recorded payload', () => {
    expect(parseObservations(rawFixture('FR-1', 'fr-1-obs').body).data).toHaveLength(5660);
    expect(parseStations(rawFixture('FR-1', 'fr-1-ref').body)).toHaveLength(409);
    for (const name of ['B', 'D', 'E1', 'E2', 'E3']) {
      expect(parseStations(rawFixture('FR-1', `fr-1-ref-${name}`).body).length).toBeGreaterThan(0);
    }
  });
});

describe('property and fuzz tests', () => {
  const at = Date.parse('2026-09-30T12:00:00Z');
  const base: Context = { registry, fetchedAt: at };
  const instant = fc
    .tuple(fc.integer({ min: -(50 * 288), max: 6 }), fc.constantFrom('Z', '+02:00', '+01:00'))
    .map(([step, offset]) => {
      const ms = Math.floor(at / 300_000) * 300_000 + step * 300_000;
      const shift = offset === 'Z' ? 0 : Number(offset.slice(1, 3)) * 3_600_000;
      return `${new Date(ms + shift).toISOString().slice(0, 19)}${offset}`;
    });
  const observation: fc.Arbitrary<Observation> = fc.record({
    code_site: fc.constant('A8500610'),
    code_station: fc.constantFrom('A850061001', 'A302009050', 'B720000001', 'Z999999999', null),
    grandeur_hydro: fc.constantFrom('H', 'Q'),
    date_obs: instant,
    resultat_obs: fc.oneof(
      fc.integer({ min: -5000, max: 2_000_000 }),
      fc.double({ min: -1e7, max: 1e7, noNaN: true }),
      fc.constant(null),
    ),
    code_statut: fc.constantFrom(0, 4, 8, 12, 16, 99),
    code_qualification_obs: fc.constantFrom(12, 16, 20, 0, 99),
  });
  const rows = fc.array(observation, { maxLength: 200 });

  it('normalise yields valid, sorted, unique, never-future rows, the same whatever the order, and is idempotent', () => {
    fc.assert(
      fc.property(rows, (page) => {
        const out = normaliseObservations(page, base);
        for (const r of out.obs) {
          ObsRow.parse(r);
          expect(Date.parse(r.ts)).toBeLessThanOrEqual(at + 15 * 60_000);
          expect(Date.parse(r.ts)).toBeGreaterThanOrEqual(at - 45 * 86_400_000);
        }
        const keys = out.obs.map((r) => `${r.series}\u0000${r.ts}`);
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys).toEqual([...keys].sort());
        expect(normaliseObservations(page, base)).toEqual(out);
        // The pages of a walk overlap, and the rows come in any order: the same rows.
        expect(normaliseObservations([...page, ...page], base).obs).toEqual(out.obs);
        expect(normaliseObservations([...page].reverse(), base).obs).toEqual(out.obs);
        const total = Object.values(out.dropped).reduce((a, b) => a + b, 0) + out.unknown;
        expect(total + out.obs.length).toBeLessThanOrEqual(page.length);
      }),
      { numRuns: 200 },
    );
  });

  it('parse never throws anything but SchemaDrift on arbitrary JSON or bytes', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.jsonValue().map((d) => Buffer.from(JSON.stringify(d))),
          fc.uint8Array().map(Buffer.from),
        ),
        (body) => {
          for (const parse of [parseObservations, parseStations]) {
            try {
              parse(body);
            } catch (err) {
              expect(err).toBeInstanceOf(SchemaDrift);
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('a mutated real page is either still valid or a SchemaDrift, never a crash or a wrong row', () => {
    const doc = JSON.parse(rawFixture('FR-1', 'fr-1-obs-page1').body.toString('utf8'));
    doc.data = doc.data.slice(0, 20);
    const mutation = fc.tuple(
      fc.integer({ min: 0, max: 19 }),
      fc.constantFrom(
        'code_site',
        'code_station',
        'grandeur_hydro',
        'date_obs',
        'resultat_obs',
        'code_statut',
        'code_qualification_obs',
      ),
      fc.jsonValue(),
    );
    fc.assert(
      fc.property(mutation, ([i, key, junk]) => {
        const copy = structuredClone(doc);
        copy.data[i][key] = junk;
        try {
          const out = normaliseObservations(
            parseObservations(Buffer.from(JSON.stringify(copy))).data,
            ctx('fr-1-obs-page1'),
          );
          for (const r of out.obs) ObsRow.parse(r);
        } catch (err) {
          expect(err).toBeInstanceOf(SchemaDrift);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('a mutated real station is either still valid or a SchemaDrift, and never stores a zero that converts', () => {
    const doc = JSON.parse(rawFixture('FR-1', 'fr-1-ref-E3').body.toString('utf8'));
    const mutation = fc.tuple(
      fc.integer({ min: 0, max: doc.data.length - 1 }),
      fc.constantFrom(
        'code_station',
        'altitude_ref_alti_station',
        'code_systeme_alti_site',
        'date_debut_ref_alti_station',
        'geometry',
      ),
      fc.jsonValue(),
    );
    fc.assert(
      fc.property(mutation, ([i, key, junk]) => {
        const copy = structuredClone(doc);
        copy.data[i][key] = junk;
        try {
          const out = normaliseStations(parseStations(Buffer.from(JSON.stringify(copy))), ctx('fr-1-ref-E3'));
          for (const z of out.gaugeZeros) expect(TO_NAP[z.datum].converted).toBe(false);
        } catch (err) {
          expect(err).toBeInstanceOf(SchemaDrift);
        }
      }),
      { numRuns: 200 },
    );
  });
});
