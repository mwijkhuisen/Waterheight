import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { QC, SchemaDrift } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  dayInstant,
  type ElabNormalised,
  FLOOR_DAY,
  normaliseElab,
  TIME,
  UTC_FROM_DAY,
} from '../../../src/adapters/fr-2/normalise.ts';
import { type ElabRecord, JSON_CAPS, parseElab } from '../../../src/adapters/fr-2/parse.ts';
import { ADAPTER_TIME, DST_PROOF, DST_REFUSED, LOAD_ADAPTERS } from '../../../src/load/adapters.ts';
import { goldenUrl, rawFixture, registryOf } from '../registry.ts';

// FR-2 Hub'Eau obs_elab (QmnJ, HIXnJ): parse + normalise of real recorded answers equals the committed goldens
// (invariant 9). `UPDATE_GOLDEN=1` rewrites them; a golden change is reviewed like code. The facts they show are in
// catalogue §2.5: a day before 2007-03-23 starts at its Europe/Paris midnight, from then on at 00:00Z.

const registry = registryOf('FR-1');
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const window = (from: string, to: string) => ({ from: day(from), to: day(to) });

function load(name: string) {
  const { body, meta } = rawFixture('FR-2', name);
  const recorded = (meta as { recorded_at?: string }).recorded_at;
  // A synthetic payload has no recording time; the DST gate uses the same stand-in.
  return { body, fetchedAt: Date.parse(recorded ?? '2030-01-01T00:00:00Z'), raw: JSON.parse(body.toString('utf8')) };
}
const run = (name: string, win?: { from: number; to: number }) => {
  const { body, fetchedAt } = load(name);
  return normaliseElab(parseElab(body).data, { registry, fetchedAt, ...(win === undefined ? {} : { backfill: win }) });
};
function golden(name: string, actual: ElabNormalised): ElabNormalised {
  const url = goldenUrl('FR-2', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}
const find = (out: ElabNormalised, series: string, ts: string) =>
  out.obs.find((r) => r.series === series && r.ts === ts);
/** The ledger's identity (plan §3.6): every record of the answer is a row, a dropped record or an unknown one. */
const ledger = (out: ElabNormalised) =>
  out.obs.length + Object.values(out.dropped).reduce((a, b) => a + b, 0) + out.unknown_values;

describe('golden files (real payloads)', () => {
  it('Uckange QmnJ 1981-10-02 .. : 400 days stamped at the Paris midnight (CET in winter, CEST in summer), validated', () => {
    const out = run('fr-2-elab-uckange-qmnj-1981', window('1981-10-02', '1982-11-30'));
    expect(out).toEqual(golden('fr-2-elab-uckange-qmnj-1981', out));
    const { raw } = load('fr-2-elab-uckange-qmnj-1981');
    expect(raw.count).toBe(400);
    expect(out.obs).toHaveLength(400);
    expect(out.provider_values).toBe(400);
    expect(out.dropped).toEqual({});
    expect(out.unknown).toBe(0);
    // The first day, 1981-10-02, in CET: its midnight is 22:00 + 1 h = 23:00Z of the day before; 89,141 l/s style values
    // are scaled to m³/s (x0.001); statut 16 sets validated and qualification 20 none.
    const first = raw.data[0] as ElabRecord;
    expect(first.date_obs_elab).toBe('1981-10-02');
    expect(out.obs[0]).toMatchObject({ series: 'A850061001/QmnJ', ts: '1981-10-01T23:00:00.000Z', qc: QC.VALIDATED });
    expect(out.obs[0]?.value).toBeCloseTo(first.resultat_obs_elab * 0.001, 9);
    // 1982-07-01 is summer time: the Paris midnight is 22:00Z of 06-30.
    const july = (raw.data as ElabRecord[]).find((r) => r.date_obs_elab === '1982-07-01');
    expect(find(out, 'A850061001/QmnJ', '1982-06-30T22:00:00.000Z')?.value).toBeCloseTo(
      (july?.resultat_obs_elab ?? Number.NaN) * 0.001,
      9,
    );
    // Qualification 12 "Douteuse" sets provider-suspect, 20 none; every row is validated.
    const doubtful = (raw.data as ElabRecord[]).filter((r) => r.code_qualification === 12).length;
    expect(out.obs.filter((r) => r.qc & QC.PROVIDER_SUSPECT)).toHaveLength(doubtful);
    expect(out.obs.every((r) => (r.qc & QC.VALIDATED) !== 0)).toBe(true);
    // Every stamp is a Paris midnight: the zone says 00:00 on the labelled day.
    for (const [i, r] of out.obs.entries()) {
      const z = Temporal.Instant.from(r.ts).toZonedDateTimeISO('Europe/Paris');
      expect([z.hour, z.minute, z.toPlainDate().toString()]).toEqual([0, 0, (raw.data[i] as ElabRecord).date_obs_elab]);
    }
  });

  it('Chooz HIXnJ across the cutover (2007-03-01 .. 04-30): Paris midnights up to 03-22, UTC midnights from 03-23', () => {
    const out = run('fr-2-elab-chooz-hixnj-cutover', window('2007-03-01', '2007-05-01'));
    expect(out).toEqual(golden('fr-2-elab-chooz-hixnj-cutover', out));
    expect(out.obs).toHaveLength(61);
    expect(out.provider_values).toBe(61);
    const k = 'B720000001/HIXnJ';
    // 2007-03-01 in CET; 03-22 is still a Paris day (03-21 23:00Z); 03-23 is the first UTC day.
    expect(out.obs[0]?.ts).toBe('2007-02-28T23:00:00.000Z');
    expect(find(out, k, '2007-03-21T23:00:00.000Z')).toBeDefined();
    expect(find(out, k, '2007-03-22T00:00:00.000Z')).toBeUndefined();
    expect(find(out, k, '2007-03-23T00:00:00.000Z')).toBeDefined();
    expect(find(out, k, '2007-03-24T00:00:00.000Z')).toBeDefined();
    expect(out.obs.at(-1)?.ts).toBe('2007-04-30T00:00:00.000Z');
    // The step from 03-22 to 03-23 is 25 hours; every later step is 24.
    const steps = out.obs.slice(1).map((r, i) => Date.parse(r.ts) - Date.parse(out.obs[i]?.ts ?? ''));
    expect(steps.filter((s) => s === 25 * 3_600_000)).toHaveLength(1);
    // Millimetres become centimetres (x0.1): 2,770 mm on 2007-03-01 is 277 cm.
    const mm = (load('fr-2-elab-chooz-hixnj-cutover').raw.data as ElabRecord[])[0]?.resultat_obs_elab;
    expect([mm, out.obs[0]?.value]).toEqual([2770, 277]);
  });

  it('Uckange QmnJ 2026: pre-validated (12) and raw (4) days are raw; the instant is the UTC day', () => {
    const out = run('fr-2-elab-uckange-qmnj-2026', window('2026-06-01', '2026-10-18'));
    expect(out).toEqual(golden('fr-2-elab-uckange-qmnj-2026', out));
    const { raw } = load('fr-2-elab-uckange-qmnj-2026');
    const data = raw.data as ElabRecord[];
    expect(out.obs).toHaveLength(139);
    expect(data.filter((r) => r.code_statut === 12)).toHaveLength(122);
    expect(data.filter((r) => r.code_statut === 4)).toHaveLength(17);
    expect(out.obs.every((r) => r.qc === QC.RAW)).toBe(true);
    expect(out.obs[0]).toEqual({
      series: 'A850061001/QmnJ',
      ts: '2026-06-01T00:00:00.000Z',
      value: 23.596,
      qc: QC.RAW,
    });
    expect(out.obs.at(-1)?.ts).toBe('2026-10-17T00:00:00.000Z');
  });

  it('an empty answer (count 0) is no row and no drop', () => {
    const out = run('fr-2-elab-empty', window('1950-01-01', '1970-01-01'));
    expect(out).toEqual(golden('fr-2-elab-empty', out));
    expect(ledger(out)).toBe(0);
    expect(out.provider_values).toBe(0);
  });

  it('a page (HTTP 206, three records of a 366-day answer) parses, and says it has a next', () => {
    const { body } = load('fr-2-elab-page');
    expect(rawFixture('FR-2', 'fr-2-elab-page').meta.status).toBe(206);
    const page = parseElab(body);
    expect([page.count, page.data.length, page.next?.includes('cursor=')]).toEqual([366, 3, true]);
    const out = run('fr-2-elab-page', window('2000-01-01', '2001-01-01'));
    expect(out).toEqual(golden('fr-2-elab-page', out));
    // 2000-01-01 .. 03, CET: 1999-12-31T23:00Z ..
    expect(out.obs.map((r) => r.ts)).toEqual([
      '1999-12-31T23:00:00.000Z',
      '2000-01-01T23:00:00.000Z',
      '2000-01-02T23:00:00.000Z',
    ]);
  });
});

describe('the DST proof fixtures (synthetic, before the cutover)', () => {
  it('fall-back night of 2006-10-29: a Paris midnight is +02:00 up to the 29th and +01:00 from the 30th', () => {
    const out = run('fr-2-elab-dst-fall-back.synthetic');
    expect(out).toEqual(golden('fr-2-elab-dst-fall-back.synthetic', out));
    expect(out.obs.filter((r) => r.series === 'A850061001/QmnJ').map((r) => r.ts)).toEqual([
      '2006-10-26T22:00:00.000Z',
      '2006-10-27T22:00:00.000Z',
      '2006-10-28T22:00:00.000Z',
      '2006-10-29T23:00:00.000Z',
      '2006-10-30T23:00:00.000Z',
    ]);
    // The 29th is a 25-hour day.
    expect(Date.parse('2006-10-29T23:00:00Z') - Date.parse('2006-10-28T22:00:00Z')).toBe(25 * 3_600_000);
  });

  it('spring-forward night of 2006-03-26: a Paris midnight is +01:00 up to the 26th and +02:00 from the 27th', () => {
    const out = run('fr-2-elab-dst-spring-forward.synthetic');
    expect(out).toEqual(golden('fr-2-elab-dst-spring-forward.synthetic', out));
    expect(out.obs.filter((r) => r.series === 'B720000001/HIXnJ').map((r) => r.ts)).toEqual([
      '2006-03-22T23:00:00.000Z',
      '2006-03-23T23:00:00.000Z',
      '2006-03-24T23:00:00.000Z',
      '2006-03-25T23:00:00.000Z',
      '2006-03-26T22:00:00.000Z',
    ]);
  });

  it('the loader wiring: FR-2 is gated, its spec has the proof, and it is a backfill into FR-1', async () => {
    expect(TIME).toEqual({ kind: 'naive-local', zone: 'Europe/Paris', dst: { gap: 'reject', overlap: 'earlier' } });
    expect(ADAPTER_TIME['FR-2']).toEqual(TIME);
    expect(DST_PROOF['fr-2-backfill-elab']).toEqual({
      fallBack: ['fr-2-elab-dst-fall-back.synthetic'],
      springForward: ['fr-2-elab-dst-spring-forward.synthetic'],
    });
    expect(DST_REFUSED).not.toContain('fr-2-backfill-elab');
    const spec = LOAD_ADAPTERS['FR-2']?.specs['fr-2-backfill-elab'];
    // windowSlackMs: a pre-2007 day starts at Paris midnight, at most 2 h before its UTC day (the pipeline's clip).
    expect(spec).toMatchObject({
      maxBytes: 16 * 1024 * 1024,
      needsVariant: false,
      backfill: true,
      obsTarget: 'FR-1',
      windowSlackMs: 2 * 3_600_000,
    });
    // The spec's run is parse + normalise with the line's window.
    const win = window('2007-03-01', '2007-05-01');
    const { body, fetchedAt } = load('fr-2-elab-chooz-hixnj-cutover');
    expect(await spec?.run(body, { registry, fetchedAt, variant: '', unitMismatch: new Set(), backfill: win })).toEqual(
      run('fr-2-elab-chooz-hixnj-cutover', win),
    );
  });
});

describe('the time rule', () => {
  it('a day whose midnight came twice starts at the first one (1976-09-26: summer time ended at 01:00; round 2 F1)', () => {
    expect(new Date(dayInstant('1976-09-26')).toISOString()).toBe('1976-09-25T22:00:00.000Z');
    expect(new Date(dayInstant('1976-09-27')).toISOString()).toBe('1976-09-26T23:00:00.000Z');
    // Every day of 1950-2007 has an instant (the property below once drew 1976-09-26 and failed).
    for (let t = Date.UTC(1950, 0, 1); t < Date.UTC(2007, 2, 23); t += 86_400_000)
      expect(Number.isFinite(dayInstant(new Date(t).toISOString().slice(0, 10)))).toBe(true);
  });

  it('the cutover is 2007-03-23: the day before is a Paris day, the day itself a UTC day', () => {
    expect(UTC_FROM_DAY).toBe('2007-03-23');
    expect(new Date(dayInstant('2007-03-21')).toISOString()).toBe('2007-03-20T23:00:00.000Z');
    expect(new Date(dayInstant('2007-03-22')).toISOString()).toBe('2007-03-21T23:00:00.000Z');
    expect(new Date(dayInstant('2007-03-23')).toISOString()).toBe('2007-03-23T00:00:00.000Z');
    expect(new Date(dayInstant('2007-03-24')).toISOString()).toBe('2007-03-24T00:00:00.000Z');
    // Summer time before the cutover (1999-07-14) and after it (2007-07-14, a UTC day all the same).
    expect(new Date(dayInstant('1999-07-14')).toISOString()).toBe('1999-07-13T22:00:00.000Z');
    expect(new Date(dayInstant('2007-07-14')).toISOString()).toBe('2007-07-14T00:00:00.000Z');
  });

  it('the changes of the 1990s: the Paris midnight on either side of each DST night', () => {
    // 1995-03-26 (spring forward) and 1995-09-24 (fall back, in the 1990s the change was on the last Sunday of September).
    expect(new Date(dayInstant('1995-03-26')).toISOString()).toBe('1995-03-25T23:00:00.000Z');
    expect(new Date(dayInstant('1995-03-27')).toISOString()).toBe('1995-03-26T22:00:00.000Z');
    expect(new Date(dayInstant('1995-09-24')).toISOString()).toBe('1995-09-23T22:00:00.000Z');
    expect(new Date(dayInstant('1995-09-25')).toISOString()).toBe('1995-09-24T23:00:00.000Z');
    // 1997-10-26: the first fall-back on the last Sunday of October.
    expect(new Date(dayInstant('1997-10-26')).toISOString()).toBe('1997-10-25T22:00:00.000Z');
    expect(new Date(dayInstant('1997-10-27')).toISOString()).toBe('1997-10-26T23:00:00.000Z');
  });

  it('a day that does not exist is drift, not a guess', () => {
    for (const bad of ['2000-02-30', '2010-13-01', '2007-02-29'])
      expect(() => dayInstant(bad), bad).toThrow(SchemaDrift);
  });
});

/** A record as the provider sends it, with the fields a test varies. */
const rec = (over: Partial<ElabRecord> = {}): ElabRecord => ({
  code_site: 'A8500610',
  code_station: 'A850061001',
  date_obs_elab: '2020-01-15',
  resultat_obs_elab: 50000,
  date_prod: '2026-08-18T10:28:43Z',
  code_statut: 16,
  libelle_statut: 'Donnée validée',
  code_methode: 10,
  libelle_methode: 'Expertisée',
  code_qualification: 20,
  libelle_qualification: 'Bonne',
  longitude: 6.17,
  latitude: 49.31,
  grandeur_hydro_elab: 'QmnJ',
  ...over,
});
const norm = (rows: ElabRecord[], fetchedAt = Date.parse('2026-10-18T12:00:00Z'), win?: { from: number; to: number }) =>
  normaliseElab(rows, { registry, fetchedAt, ...(win === undefined ? {} : { backfill: win }) });

describe('flags, values and drops', () => {
  it('code_statut 0, 4, 8 and 12 are raw, 16 is validated; the qualification adds provider-suspect for 12 and nothing for 16 and 20', () => {
    for (const [statut, qc] of [
      [0, QC.RAW],
      [4, QC.RAW],
      [8, QC.RAW],
      [12, QC.RAW],
      [16, QC.VALIDATED],
    ] as const)
      expect(norm([rec({ code_statut: statut })]).obs[0]?.qc, `statut ${statut}`).toBe(qc);
    for (const [qualification, qc] of [
      [12, QC.VALIDATED | QC.PROVIDER_SUSPECT],
      [16, QC.VALIDATED],
      [20, QC.VALIDATED],
    ] as const)
      expect(norm([rec({ code_qualification: qualification })]).obs[0]?.qc, `qualification ${qualification}`).toBe(qc);
  });

  it('any other statut or qualification is withheld as unknown_quality, never guessed', () => {
    for (const over of [
      { code_statut: 1 },
      { code_statut: 99 },
      { code_qualification: 0 },
      { code_qualification: 99 },
    ]) {
      const out = norm([rec(over)]);
      expect([over, out.obs, out.dropped]).toEqual([over, [], { unknown_quality: 1 }]);
    }
    // Inherited property names are no codes (Maps, not objects).
    expect(norm([rec({ code_statut: Number('constructor') })]).dropped).toEqual({ unknown_quality: 1 });
  });

  it('QmnJ l/s → m³/s (x0.001) and HIXnJ mm → cm (x0.1); a negative mean discharge or an absurd stage carries the range bit', () => {
    const out = norm([
      rec({ resultat_obs_elab: 89141 }),
      rec({ date_obs_elab: '2020-01-16', resultat_obs_elab: -1250 }),
      rec({
        code_station: 'B720000001',
        code_site: 'B7200000',
        grandeur_hydro_elab: 'HIXnJ',
        resultat_obs_elab: 867,
      }),
      rec({
        code_station: 'B720000001',
        code_site: 'B7200000',
        grandeur_hydro_elab: 'HIXnJ',
        date_obs_elab: '2020-01-16',
        resultat_obs_elab: 90000,
      }),
    ]);
    expect(out.obs.map((r) => [r.series, r.ts.slice(0, 10), r.value, r.qc])).toEqual([
      ['A850061001/QmnJ', '2020-01-15', 89.141, QC.VALIDATED],
      ['A850061001/QmnJ', '2020-01-16', -1.25, QC.VALIDATED | QC.RANGE],
      ['B720000001/HIXnJ', '2020-01-15', 86.7, QC.VALIDATED],
      ['B720000001/HIXnJ', '2020-01-16', 9000, QC.VALIDATED | QC.RANGE],
    ]);
  });

  it('a series the registry does not have is unknown once, and its records are counted apart', () => {
    const out = norm([
      rec({ code_station: 'Z999999999' }),
      rec({ code_station: 'Z999999999', date_obs_elab: '2020-01-16' }),
      // A grandeur the station has no aggregate row for (Brevilly has no Q): unknown as well.
      rec({ code_station: 'B466010101', grandeur_hydro_elab: 'QmnJ' }),
      rec(),
    ]);
    expect([out.unknown, out.unknown_values, out.obs.length, out.provider_values]).toEqual([2, 3, 1, 4]);
    expect(ledger(out)).toBe(4);
  });

  it('the window is the days asked for, as UTC days, whatever instant a day stands for', () => {
    // 2000-01-02 (a Paris day) is stamped 2000-01-01T23:00Z, before the window's `from`, and is still inside it.
    const win = window('2000-01-02', '2000-01-04');
    const out = norm(
      ['2000-01-01', '2000-01-02', '2000-01-03', '2000-01-04'].map((d) => rec({ date_obs_elab: d })),
      undefined,
      win,
    );
    expect(out.obs.map((r) => r.ts)).toEqual(['2000-01-01T23:00:00.000Z', '2000-01-02T23:00:00.000Z']);
    expect(out.dropped).toEqual({ outside_backfill: 2 });
    // From the cutover on, the same rule: [from, to) of UTC days.
    const after = norm(
      ['2020-05-01', '2020-05-02', '2020-05-03'].map((d) => rec({ date_obs_elab: d })),
      undefined,
      window('2020-05-02', '2020-05-03'),
    );
    expect(after.obs.map((r) => r.ts)).toEqual(['2020-05-02T00:00:00.000Z']);
  });

  it('a day before 1950-01-01 is outside the backfill, with no window as well', () => {
    expect(FLOOR_DAY).toBe('1950-01-01');
    const out = norm([
      rec({ date_obs_elab: '1949-12-31' }),
      rec({ date_obs_elab: '1950-01-01' }),
      rec({ date_obs_elab: '1800-01-01' }),
    ]);
    expect(out.obs.map((r) => r.ts)).toEqual(['1949-12-31T23:00:00.000Z']);
    expect(out.dropped).toEqual({ outside_backfill: 2 });
  });

  it('a stamp more than 15 minutes after the fetch is future; 10 minutes is not', () => {
    const t = Date.parse('2026-10-17T00:00:00Z');
    const r = rec({ date_obs_elab: '2026-10-17' });
    expect(norm([r], t - 20 * 60_000).dropped).toEqual({ future: 1 });
    expect(norm([r], t - 10 * 60_000).obs).toHaveLength(1);
  });

  it('two records of one series and day: equal is a duplicate, different is a conflict that withholds both (and a third)', () => {
    const dup = norm([rec(), rec()]);
    expect([dup.obs.length, dup.dropped]).toEqual([1, { duplicate: 1 }]);
    const conflict = norm([rec(), rec({ resultat_obs_elab: 1 })]);
    expect([conflict.obs.length, conflict.dropped]).toEqual([0, { conflict: 2 }]);
    const three = norm([rec(), rec({ resultat_obs_elab: 1 }), rec({ resultat_obs_elab: 2 })]);
    expect([three.obs.length, three.dropped]).toEqual([0, { conflict: 3 }]);
    // The same value with another qualification is a different row too.
    expect(norm([rec(), rec({ code_qualification: 12 })]).dropped).toEqual({ conflict: 2 });
  });
});

describe('parse is strict and bounded', () => {
  const answer = (data: unknown[], over: Record<string, unknown> = {}) =>
    Buffer.from(
      JSON.stringify({ count: data.length, first: null, prev: null, next: null, api_version: '2.0.1', data, ...over }),
    );
  const drift = (body: Buffer) => {
    try {
      parseElab(body);
    } catch (err) {
      if (err instanceof SchemaDrift) return err.code;
      throw err;
    }
    return 'parsed';
  };

  it('reads an answer of the 14 keys, `next` and `prev` a string or null', () => {
    expect(parseElab(answer([rec()])).data).toEqual([rec()]);
    expect(
      parseElab(answer([], { next: 'https://hubeau.eaufrance.fr/x', prev: 'https://hubeau.eaufrance.fr/y' })).next,
    ).toBe('https://hubeau.eaufrance.fr/x');
  });

  it('refuses a record with another key, a missing key, a wrong type or a bad date', () => {
    const { code_site: _, ...missing } = rec();
    for (const bad of [
      { ...rec(), extra: 1 },
      missing,
      rec({ resultat_obs_elab: '5' as unknown as number }),
      rec({ resultat_obs_elab: null as unknown as number }),
      rec({ code_statut: 1.5 }),
      rec({ date_obs_elab: '2020-1-5' }),
      rec({ date_obs_elab: '2020-01-15T00:00:00Z' }),
      rec({ grandeur_hydro_elab: 'QmM' as 'QmnJ' }),
    ])
      expect(drift(answer([bad])), JSON.stringify(bad)).not.toBe('parsed');
  });

  it('refuses an envelope with another key, a wrong count or a non-array data, and text that is no JSON', () => {
    expect(drift(answer([], { surprise: true }))).not.toBe('parsed');
    expect(drift(answer([], { count: -1 }))).not.toBe('parsed');
    expect(drift(answer([], { data: {} }))).not.toBe('parsed');
    expect(drift(Buffer.from('<html>'))).toBe('not_json');
    expect(drift(Buffer.from('[]'))).not.toBe('parsed');
  });

  it('caps the nodes, the depth and the records before it reads them', () => {
    expect(drift(answer(Array.from({ length: JSON_CAPS.maxItems + 1 }, () => 0)))).toBe('too_big');
    expect(drift(answer([[[[[1]]]]]))).toBe('json_too_deep');
    expect(drift(answer(Array.from({ length: 31_000 }, () => rec())))).toBe('json_too_many_nodes');
  });
});

describe('property: any set of records in the window', () => {
  const stations = [
    ['A850061001', 'A8500610', 'QmnJ'],
    ['B720000001', 'B7200000', 'HIXnJ'],
    ['A443064001', 'A4430640', 'QmnJ'],
    ['Z999999999', 'Z9999999', 'QmnJ'],
    ['B466010101', 'B4660101', 'QmnJ'], // no Q aggregate: unknown
  ] as const;
  const record = fc
    .record({
      station: fc.constantFrom(...stations),
      // 1949-12-20 .. 2030-01-01, around both limits.
      days: fc.integer({ min: -7500, max: 21_915 }),
      value: fc.double({ min: -1e5, max: 1e7, noNaN: true }),
      statut: fc.constantFrom(0, 4, 8, 12, 16, 7),
      qualification: fc.constantFrom(12, 16, 20, 5),
    })
    .map(({ station, days, value, statut, qualification }) =>
      rec({
        code_station: station[0],
        code_site: station[1],
        grandeur_hydro_elab: station[2],
        date_obs_elab: new Date(days * 86_400_000).toISOString().slice(0, 10),
        resultat_obs_elab: value,
        code_statut: statut,
        code_qualification: qualification,
      }),
    );
  const cutover = Date.parse(`${UTC_FROM_DAY}T00:00:00Z`);

  it('every stamp is a day start by the rule, the rows are sorted, and provider_values = rows + dropped + unknown_values', () => {
    const win = window('1990-01-01', '2010-01-01');
    fc.assert(
      fc.property(fc.array(record, { maxLength: 60 }), (rows) => {
        const out = normaliseElab(rows, { registry, fetchedAt: Date.parse('2026-10-18T12:00:00Z'), backfill: win });
        expect(out.provider_values).toBe(rows.length);
        expect(ledger(out)).toBe(rows.length);
        for (const r of out.obs) {
          const ts = Date.parse(r.ts);
          if (ts >= cutover) expect(ts % 86_400_000).toBe(0);
          else {
            const z = Temporal.Instant.from(r.ts).toZonedDateTimeISO('Europe/Paris');
            expect([z.hour, z.minute, z.second]).toEqual([0, 0, 0]);
          }
          expect(Number.isFinite(r.value)).toBe(true);
        }
        const order = out.obs.map((r) => `${r.series} ${r.ts}`);
        expect(order).toEqual([...order].sort());
        expect(new Set(order).size).toBe(order.length);
      }),
      { numRuns: 300 },
    );
  });

  it('is deterministic and independent of the order of the records', () => {
    fc.assert(
      fc.property(fc.array(record, { maxLength: 40 }), (rows) => {
        const ctx = { registry, fetchedAt: Date.parse('2026-10-18T12:00:00Z') };
        const a = normaliseElab(rows, ctx);
        const b = normaliseElab([...rows].reverse(), ctx);
        // The rows do not depend on the order; the split of the drops between duplicate and conflict does (as in FR-1).
        expect(b.obs).toEqual(a.obs);
        expect(ledger(b)).toBe(ledger(a));
        expect(b.unknown_values).toBe(a.unknown_values);
      }),
      { numRuns: 200 },
    );
  });
});
