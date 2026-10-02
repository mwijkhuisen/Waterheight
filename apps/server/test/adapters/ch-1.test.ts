import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { type Normalised, ObsRow, QC, type Registry, SchemaDrift, type SeriesDecl } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Context, normaliseCube } from '../../src/adapters/ch-1/normalise.ts';
import { HEADER, MAX_ROWS, type Observation, parseCube, UNDEFINED_LEVEL } from '../../src/adapters/ch-1/parse.ts';
import { goldenUrl, rawFixture, registryOf } from './registry.ts';

// CH-1 BAFU LINDAS (SPARQL CSV of the river and lake cubes): parse + normalise
// of real recorded payloads equals the committed golden files (invariant 9).
// `UPDATE_GOLDEN=1` rewrites them; a golden change is reviewed like code.

const registry = registryOf('CH-1');
/** One CSV field, quoted when it has to be. */
const field = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);

function ctx(name: string): Context {
  return { registry, fetchedAt: Date.parse(rawFixture('CH-1', name).meta.recorded_at) };
}

function golden(name: string, actual: Normalised): Normalised {
  const url = goldenUrl('CH-1', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const cube = (name: string) => parseCube(rawFixture('CH-1', name).body);
const run = (name: string) => normaliseCube(cube(name), ctx(name));
const find = (out: Normalised, series: string) => out.obs.filter((r) => r.series === series);

describe('golden files (real payloads)', () => {
  it('the river cube (205 rows, 199 stations): +01:00 → UTC, the latest row of a station that comes twice', () => {
    const out = run('ch-1-lindas');
    expect(out).toEqual(golden('ch-1-lindas', out));
    expect(cube('ch-1-lindas')).toHaveLength(205);
    // Six stations come twice (520, 2283, 2288, 2252, 2303, 2417): one older row each is superseded; two series of
    // the destroyed station 2269 (a rock fall, 2025-05-28) are too old.
    expect(out.dropped).toEqual({ superseded: 6, too_old: 2 });
    expect(out.unknown).toBe(0);
    // Basel Rheinhalle "2026-09-29T14:20:00+01:00": 244.782 m ü. M. is 24,478.2 cm, Q 340.204 m³/s.
    expect(find(out, '2289/W')).toEqual([
      { series: '2289/W', ts: '2026-09-29T13:20:00.000Z', value: 24478.2, qc: QC.RAW },
    ]);
    expect(find(out, '2289/Q')).toEqual([
      { series: '2289/Q', ts: '2026-09-29T13:20:00.000Z', value: 340.204, qc: QC.RAW },
    ]);
    expect(find(out, '2473/W')[0]).toMatchObject({ value: 40692.7, qc: QC.RAW });
    // Only the stored fields: no danger level and no temperature in a row.
    for (const r of out.obs) expect(Object.keys(r).sort()).toEqual(['qc', 'series', 'ts', 'value']);
  });

  it('duplicates are resolved to the latest observation (real: 520 and 2283 and four more)', () => {
    const out = run('ch-1-lindas');
    // 520 Rämismühle: 13:45 and 13:55 (+01:00), the same values; the later one stands.
    expect(find(out, '520/W')).toEqual([
      { series: '520/W', ts: '2026-09-29T12:55:00.000Z', value: 52372.4, qc: QC.RAW },
    ]);
    expect(find(out, '520/Q')).toEqual([{ series: '520/Q', ts: '2026-09-29T12:55:00.000Z', value: 0.072, qc: QC.RAW }]);
    // 2283 Wasen, Riedbad: 2026-09-17 and 2026-09-29; one row, the 29th.
    expect(find(out, '2283/W').map((r) => r.ts)).toEqual(['2026-09-29T13:20:00.000Z']);
    expect(find(out, '2288/Q').map((r) => r.ts)).toEqual(['2026-09-29T13:20:00.000Z']);
    // The older rows are gone, not stored as history.
    const ids = cube('ch-1-lindas').map((o) => o.id);
    const twice = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))].sort();
    expect(twice).toEqual(['2252', '2283', '2288', '2303', '2417', '520']);
    for (const id of twice)
      expect(
        new Set(
          find(out, `${id}/W`)
            .concat(find(out, `${id}/Q`))
            .map((r) => r.ts),
        ).size,
      ).toBe(1);
  });

  it('a relative gauge (2283 Wasen, Riedbad) is a stage on LOCAL in the registry: −0.136 m is stored as −13.6 cm', () => {
    const decl = registry.get('2283/W');
    expect([decl?.value_kind, decl?.native_unit, decl?.to_canonical]).toEqual(['stage', 'm', 100]);
    const out = run('ch-1-lindas');
    expect(find(out, '2283/W')).toEqual([
      { series: '2283/W', ts: '2026-09-29T13:20:00.000Z', value: -13.6, qc: QC.RAW },
    ]);
    // Every real station whose level is below 150 m is declared as a stage; none is dropped as a datum mismatch.
    expect(out.dropped.datum_mismatch).toBeUndefined();
    for (const o of cube('ch-1-lindas')) {
      if (o.w !== null && o.w < 150) expect(registry.get(`${o.id}/W`)?.value_kind).toBe('stage');
    }
  });

  it('the danger level is parsed for its shape only: 1–5 is a number, the Undefined IRI is null, never 0', () => {
    const rows = cube('ch-1-lindas');
    expect(rows.filter((o) => o.dangerLevel === null)).toHaveLength(36);
    expect(rows.filter((o) => o.dangerLevel === 1)).toHaveLength(169);
    expect(rows.every((o) => o.dangerLevel === null || (o.dangerLevel >= 1 && o.dangerLevel <= 5))).toBe(true);
    const raw = rawFixture('CH-1', 'ch-1-lindas').body.toString('utf8');
    expect(raw.split(UNDEFINED_LEVEL).length - 1).toBe(36);
  });

  it('the lake cube (34 rows): lake levels are levels in cm, no discharge; Bodensee 2032 and 2043', () => {
    const out = run('ch-1-lindas-lake');
    expect(out).toEqual(golden('ch-1-lindas-lake', out));
    expect(cube('ch-1-lindas-lake')).toHaveLength(34);
    expect(out.obs).toHaveLength(34);
    expect(out.dropped).toEqual({});
    expect(out.obs.every((r) => r.series.endsWith('/W') && r.qc === QC.RAW)).toBe(true);
    // Romanshorn "2026-09-30T12:40:00+01:00" 394.713 m; Berlingen 394.2 m.
    expect(find(out, '2032/W')).toEqual([
      { series: '2032/W', ts: '2026-09-30T11:40:00.000Z', value: 39471.3, qc: QC.RAW },
    ]);
    expect(find(out, '2043/W')[0]?.value).toBe(39420);
    for (const id of ['2032', '2043']) expect(registry.get(`${id}/W`)?.value_kind).toBe('level');
  });

  it('a header-only body (the river query answered with nothing) is a valid, empty cube', () => {
    expect(cube('ch-1-lindas-empty')).toEqual([]);
    const out = run('ch-1-lindas-empty');
    expect(out).toEqual(golden('ch-1-lindas-empty', out));
    expect(out).toEqual({ obs: [], gaugeZeros: [], dropped: {}, unknown: 0 });
  });
});

describe('synthetic payloads [U]', () => {
  const at = Date.parse('2026-09-23T19:50:00Z');
  const base: Context = { registry, fetchedAt: at };
  const WATER = 'https://environment.ld.admin.ch/foen/hydro/waterbody/Rhein';
  type Fields = Partial<Record<'id' | 'name' | 'water' | 'time' | 'q' | 'w' | 't' | 'dl' | 'wkt', string>>;
  const line = (f: Fields = {}) =>
    [
      f.id ?? '2289',
      field(f.name ?? 'Basel, Rheinhalle'),
      f.water ?? WATER,
      f.time ?? '2026-09-23T20:40:00+01:00',
      f.q ?? '340.204',
      f.w ?? '244.782',
      f.t ?? '',
      f.dl ?? '1',
      f.wkt ?? 'POINT(7.606 47.557)',
    ].join(',');
  const csv = (...rows: string[]) => Buffer.from(`${HEADER.join(',')}\n${rows.join('\n')}\n`);
  const norm = (rows: string[], c: Context = base) => normaliseCube(parseCube(csv(...rows)), c);

  it('[CI] `2026-09-23T20:40:00+01:00` → 19:40Z (a one-row synthetic CSV with the real header)', () => {
    // The recorded cubes are RFC 4180: CRLF line ends.
    expect(rawFixture('CH-1', 'ch-1-lindas').body.toString('utf8').split('\r\n')[0]).toBe(HEADER.join(','));
    expect(norm([line()])).toEqual({
      obs: [
        { series: '2289/W', ts: '2026-09-23T19:40:00.000Z', value: 24478.2, qc: QC.RAW },
        { series: '2289/Q', ts: '2026-09-23T19:40:00.000Z', value: 340.204, qc: QC.RAW },
      ],
      gaugeZeros: [],
      dropped: {},
      unknown: 0,
    });
  });

  it('the offset is +01:00 all year: a summer date is not +02:00, and any other offset or none is drift', () => {
    expect(
      norm([line({ time: '2026-07-15T12:00:00+01:00' })], { ...base, fetchedAt: Date.parse('2026-07-15T12:00:00Z') })
        .obs[0]?.ts,
    ).toBe('2026-07-15T11:00:00.000Z');
    for (const time of [
      '2026-09-23T20:40:00+02:00',
      '2026-09-23T19:40:00Z',
      '2026-09-23T19:40:00+00:00',
      '2026-09-23T20:40:00-01:00',
    ]) {
      expect(() => norm([line({ time })]), time).toThrow(expect.objectContaining({ code: 'time_offset_mismatch' }));
    }
    for (const time of ['2026-09-23T20:40:00', '2026-09-23 20:40:00+01:00', '', 'yesterday']) {
      expect(() => norm([line({ time })]), time).toThrow(expect.objectContaining({ code: 'time_bad_format' }));
    }
  });

  it('two different values at the same latest time are withheld (conflict), the older row does not stand in', () => {
    const same = '2026-09-23T20:40:00+01:00';
    const out = norm([
      line({ time: '2026-09-23T20:30:00+01:00' }),
      line({ time: same, q: '1' }),
      line({ time: same, q: '2' }),
    ]);
    expect(out.obs).toEqual([]);
    expect(out.dropped).toEqual({ superseded: 1, conflict: 2 });
    // A third statement of the same instant is withheld too; the same values are only a duplicate.
    expect(norm([line({ q: '1' }), line({ q: '2' }), line({ q: '1' })]).dropped).toEqual({ conflict: 3 });
    expect(norm([line(), line()])).toMatchObject({
      dropped: { duplicate: 1 },
      obs: [{ series: '2289/W' }, { series: '2289/Q' }],
    });
    // Another instant wins over a conflict at an older one, and a conflict does not touch another station.
    const later = norm([
      line({ q: '1' }),
      line({ q: '2' }),
      line({ time: '2026-09-23T20:50:00+01:00', q: '3' }),
      line({ id: '2473' }),
    ]);
    expect(later.obs.map((r) => `${r.series}@${r.ts.slice(11, 16)}=${r.value}`)).toEqual([
      '2289/W@19:50=24478.2',
      '2289/Q@19:50=3',
      '2473/W@19:40=24478.2',
      '2473/Q@19:40=340.204',
    ]);
  });

  it('the latest row wins whatever the order of the cube', () => {
    const rows = [
      line({ time: '2026-09-23T20:10:00+01:00', q: '1' }),
      line({ time: '2026-09-23T20:30:00+01:00', q: '3' }),
      line({ time: '2026-09-23T20:20:00+01:00', q: '2' }),
    ];
    for (const order of [rows, [...rows].reverse(), [rows[1], rows[0], rows[2]] as string[]]) {
      expect(norm(order).obs.find((r) => r.series === '2289/Q')).toMatchObject({
        ts: '2026-09-23T19:30:00.000Z',
        value: 3,
      });
    }
    expect(norm(rows).dropped).toEqual({ superseded: 2 });
  });

  it('an empty discharge or level gives no row (a lake has no Q); a row with neither gives none and counts nothing', () => {
    expect(norm([line({ q: '' })])).toMatchObject({ obs: [{ series: '2289/W' }], dropped: {} });
    expect(norm([line({ w: '' })])).toMatchObject({ obs: [{ series: '2289/Q' }], dropped: {} });
    expect(norm([line({ q: '', w: '' })])).toEqual({ obs: [], gaugeZeros: [], dropped: {}, unknown: 0 });
  });

  it('a station the registry does not know is counted once per value, never registered', () => {
    expect(norm([line({ id: '999999' })])).toMatchObject({ obs: [], unknown: 2 });
    expect(norm([line({ id: '999999', q: '' })])).toMatchObject({ obs: [], unknown: 1 });
  });

  it('datum_mismatch, one way: a level station (2289, LN02) that reports a relative value is withheld, its Q is not', () => {
    expect(registry.get('2289/W')?.value_kind).toBe('level');
    const out = norm([line({ w: '0.5' })]);
    expect(out.obs.map((r) => r.series)).toEqual(['2289/Q']);
    expect(out.dropped).toEqual({ datum_mismatch: 1 });
    // 149.999 m is below the floor of every Swiss water level; 150 m is a level.
    expect(norm([line({ w: '149.999' })]).dropped).toEqual({ datum_mismatch: 1 });
    expect(norm([line({ w: '150' })]).obs.find((r) => r.series === '2289/W')?.value).toBe(15000);
  });

  it('datum_mismatch, the other way: a relative gauge (2283, stage on LOCAL) that reports a level is withheld', () => {
    expect(registry.get('2283/W')?.value_kind).toBe('stage');
    const out = norm([line({ id: '2283', w: '244.782' })]);
    expect(out.obs.map((r) => r.series)).toEqual(['2283/Q']);
    expect(out.dropped).toEqual({ datum_mismatch: 1 });
    expect(norm([line({ id: '2283', w: '150' })]).dropped).toEqual({ datum_mismatch: 1 });
    // The declaration is the registry's: a relative value is stored for it, negative ones too.
    expect(norm([line({ id: '2283', w: '-0.136' })]).obs.find((r) => r.series === '2283/W')).toMatchObject({
      value: -13.6,
      qc: QC.RAW,
    });
    expect(norm([line({ id: '2283', w: '149.9' })]).obs.find((r) => r.series === '2283/W')?.value).toBe(14990);
    // The guard also holds when the registry says the other thing: the same row against a flipped declaration.
    const flipped: Registry = new Map(registry).set('2289/W', {
      ...(registry.get('2289/W') as SeriesDecl),
      value_kind: 'stage',
    });
    expect(norm([line({ w: '244.782' })], { ...base, registry: flipped }).dropped).toEqual({ datum_mismatch: 1 });
  });

  it('the guard does not apply to discharge, and Q has its own plausible range', () => {
    expect(norm([line({ id: '2283', q: '0.003', w: '' })]).obs[0]).toMatchObject({ series: '2283/Q', value: 0.003 });
    expect(norm([line({ q: '1000000', w: '' })]).obs[0]).toMatchObject({ value: 1_000_000, qc: QC.RAW | QC.RANGE });
  });

  it('a level that overflows the ×100 factor, or any canonical value over 1e7: value_out_of_range drift', () => {
    for (const w of ['1.8e306', '9999999e300', '1e300', '100001']) {
      expect(() => norm([line({ w })]), w).toThrow(expect.objectContaining({ code: 'value_out_of_range' }));
    }
    // A relative gauge (a stage) at the negative edge: the same drift.
    expect(() => norm([line({ id: '2283', w: '-1.8e306' })])).toThrow(
      expect.objectContaining({ code: 'value_out_of_range' }),
    );
    // A finite ×1 discharge over 1e7 is drift too (review SR-2: it would overflow the real column); 1e7 is kept.
    expect(() => norm([line({ q: '1.8e306', w: '' })])).toThrow(
      expect.objectContaining({ code: 'value_out_of_range' }),
    );
    expect(norm([line({ w: '100000', q: '' })]).obs[0]).toMatchObject({ value: 1e7, qc: QC.RAW | QC.RANGE });
    expect(norm([line({ q: '9999999', w: '' })]).obs[0]).toMatchObject({ value: 9_999_999, qc: QC.RAW | QC.RANGE });
  });

  it('a value more than 15 minutes ahead of the fetch is dropped; a station not heard for 45 days is too_old', () => {
    const ahead = (min: number) =>
      `2026-09-23T${String(20 + Math.floor((50 + min) / 60)).padStart(2, '0')}:${String((50 + min) % 60).padStart(2, '0')}:00+01:00`;
    expect(norm([line({ time: ahead(15) })]).obs).toHaveLength(2);
    expect(norm([line({ time: ahead(16) })])).toMatchObject({ obs: [], dropped: { future: 2 } });
    expect(norm([line({ time: '2026-08-09T20:50:00+01:00' })]).obs).toHaveLength(2);
    expect(norm([line({ time: '2026-08-09T20:49:00+01:00' })])).toMatchObject({ obs: [], dropped: { too_old: 2 } });
    // The age is judged per value's own time, not the cube's: a stale station beside a fresh one.
    const mixed = norm([
      line({ time: '2025-05-28T14:20:00+01:00' }),
      line({ id: '2473', time: '2026-09-23T20:40:00+01:00' }),
    ]);
    expect(mixed.obs.map((r) => r.series)).toEqual(['2473/W', '2473/Q']);
    expect(mixed.dropped).toEqual({ too_old: 2 });
  });

  it('an implausible level or discharge is kept with the range bit', () => {
    expect(norm([line({ w: '99999' })]).obs.find((r) => r.series === '2289/W')).toMatchObject({
      qc: QC.RAW | QC.RANGE,
    });
  });
});

describe('parse rules [U]', () => {
  const WATER = 'https://environment.ld.admin.ch/foen/hydro/waterbody/Rhein';
  const row = (o: Partial<Record<(typeof HEADER)[number], string>> = {}) =>
    HEADER.map((h) =>
      field(
        o[h] ??
          {
            id: '2289',
            name: 'Basel',
            water: WATER,
            time: '2026-09-23T20:40:00+01:00',
            q: '1',
            w: '244',
            t: '',
            dl: '1',
            wkt: 'POINT(7.6 47.5)',
          }[h],
      ),
    ).join(',');
  const body = (...rows: string[]) => Buffer.from(`${HEADER.join(',')}\n${rows.join('\n')}\n`);
  const drift = (b: Uint8Array) => {
    try {
      parseCube(b);
    } catch (err) {
      return err instanceof SchemaDrift ? err.message : 'other';
    }
    return 'parsed';
  };

  it("the header must be the query's own variables, in order", () => {
    const rest = row();
    // Same width, other names or order: csv_header. Another width fails the width rule first.
    for (const header of [
      'id,name,water,time,w,q,t,dl,wkt',
      'ID,name,water,time,q,w,t,dl,wkt',
      '\uFEFFid,name,water,time,q,w,t,dl,wkt',
      'id,name,water,time,q,w,t,dl,geom',
    ]) {
      expect(drift(Buffer.from(`${header}\n${rest}\n`)), header).toBe('csv_header');
    }
    for (const header of ['id,name,water,time,q,w,t,dl', 'id,name,water,time,q,w,t,dl,wkt,extra', '', 'x']) {
      expect(drift(Buffer.from(`${header}\n${rest}\n`)), header).toBe('csv_width');
    }
    expect(drift(Buffer.from(''))).toBe('csv_empty');
  });

  it('a wider or narrower row is drift (the extraField rule): a shifted column must never pass', () => {
    expect(drift(body(`${row()},extra`))).toBe('csv_width');
    expect(drift(body(`${row()},`))).toBe('csv_width');
    expect(drift(body(row().split(',').slice(0, 8).join(',')))).toBe('csv_width');
    expect(drift(body(row()))).toBe('parsed');
  });

  it('the id is 1–6 digits', () => {
    for (const id of ['', 'abc', '1234567', '12 3', '-1', '1.5', '٣'])
      expect(drift(body(row({ id }))), id).toBe('bad_id at rows.0');
    for (const id of ['0', '520', '123456']) expect(drift(body(row({ id }))), id).toBe('parsed');
  });

  it('the name is 1–200 characters; a quoted name may hold a comma and quotes', () => {
    expect(drift(body(row({ name: '' })))).toBe('bad_name at rows.0');
    expect(drift(body(row({ name: 'x'.repeat(201) })))).toBe('bad_name at rows.0');
    expect(drift(body(row({ name: 'x'.repeat(200) })))).toBe('parsed');
    // The real cube has "Allaman, Le Coulet": the comma stays inside the field.
    expect(parseCube(body(row({ name: 'Allaman, "Le" Coulet' })))).toHaveLength(1);
  });

  it('the water body is an https IRI or empty; the geometry is a WKT point or empty', () => {
    for (const water of [
      'http://environment.ld.admin.ch/x',
      'ftp://x',
      'Rhein',
      'https://x y',
      'https://x"y',
      `https://${'x'.repeat(501)}`,
    ]) {
      expect(drift(body(row({ water }))), water).toBe('bad_water at rows.0');
    }
    expect(drift(body(row({ water: '' })))).toBe('parsed');
    for (const wkt of ['POINT(1 2 3)', 'LINESTRING(1 2,3 4)', 'POINT(1,2)', 'POINT(a b)', 'POINT(1 2', 'POINT (1 2)']) {
      expect(drift(body(row({ wkt }))), wkt).toBe('bad_wkt at rows.0');
    }
    for (const wkt of ['', 'POINT(7.552070650295653 46.4859592583082)', 'POINT(-7 -46)'])
      expect(drift(body(row({ wkt }))), wkt).toBe('parsed');
  });

  it('q, w and t are plain decimal numbers or empty: anything else is bad_number, with the column in the path', () => {
    for (const bad of [
      '1,5',
      'NaN',
      'Infinity',
      '0x10',
      '1.',
      '.5',
      '--1',
      '+1',
      '1 2',
      '12345678',
      '1e999',
      '1e-',
      'abc',
      "1'234",
    ]) {
      expect(drift(body(row({ q: bad }))), bad).toBe('bad_number at rows.0.q');
      expect(drift(body(row({ w: bad }))), bad).toBe('bad_number at rows.0.w');
      expect(drift(body(row({ t: bad }))), bad).toBe('bad_number at rows.0.t');
    }
    for (const ok of ['', '0', '-0.136', '1234567', '123.123456789', '1e3', '1E+3', '-1e-3']) {
      expect(drift(body(row({ q: ok, w: ok, t: ok }))), ok).toBe('parsed');
    }
    expect(parseCube(body(row({ q: '1e3', w: '-0.136' })))[0]).toMatchObject({ q: 1000, w: -0.136 });
    expect(parseCube(body(row({ q: '', w: '' })))[0]).toMatchObject({ q: null, w: null });
  });

  it('the danger level is 1–5, the Undefined IRI or empty: anything else is drift (never level 0)', () => {
    for (const dl of [
      '0',
      '6',
      '10',
      'x',
      '1.5',
      '-1',
      'https://cube.link/Other',
      'https://cube.link/undefined',
      ' 1',
    ]) {
      expect(drift(body(row({ dl }))), dl).toBe('bad_danger_level at rows.0');
    }
    expect(parseCube(body(row({ dl: '' })))[0]?.dangerLevel).toBeNull();
    expect(parseCube(body(row({ dl: UNDEFINED_LEVEL })))[0]?.dangerLevel).toBeNull();
    expect([1, 2, 3, 4, 5].map((dl) => parseCube(body(row({ dl: String(dl) })))[0]?.dangerLevel)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it('CRLF line endings and a missing final newline parse; a truncated or unclosed row fails', () => {
    expect(parseCube(Buffer.from(`${HEADER.join(',')}\r\n${row()}\r\n${row({ id: '2473' })}`))).toHaveLength(2);
    expect(drift(Buffer.from(`${HEADER.join(',')}\n${row()}\n2289,Bas`))).toBe('csv_width');
    expect(drift(Buffer.from(`${HEADER.join(',')}\n2289,"Basel,${WATER},t,1,2,,1,\n`))).toBe('csv_quote');
    expect(drift(Buffer.from(`${HEADER.join(',')}\n${row({ name: 'x'.repeat(1025) })}\n`))).toBe('csv_field');
  });

  it('bounded: at most MAX_ROWS rows and fields of 1 KB, whatever the byte size', () => {
    expect(MAX_ROWS).toBe(2000);
    expect(parseCube(body(...Array(MAX_ROWS).fill(row())))).toHaveLength(MAX_ROWS);
    expect(drift(body(...Array(MAX_ROWS + 1).fill(row())))).toBe('csv_rows');
    // The quote-aware scan stops at the first oversize field of an unterminated quote.
    expect(drift(Buffer.from(`${HEADER.join(',')}\n"${'x'.repeat(100_000)}`))).toBe('csv_field');
  });

  it('a bad UTF-8 byte is replaced, never a crash; the body of a SPARQL error is not a cube', () => {
    expect(drift(Buffer.concat([Buffer.from(`${HEADER.join(',')}\n`), Buffer.from([0xff, 0xfe, 0x2c, 0x0a])]))).toBe(
      'csv_width',
    );
    expect(drift(Buffer.from('<html><body>Internal Server Error</body></html>'))).toBe('csv_header');
    expect(drift(Buffer.from('{"error":"Query timed out"}'))).toBe('csv_header');
  });
});

describe('property and fuzz tests', () => {
  const at = Date.parse('2026-09-30T12:40:00Z');
  const base: Context = { registry, fetchedAt: at };
  const time = fc
    .integer({ min: -(50 * 144), max: 3 })
    .map(
      (step) =>
        `${new Date(Math.floor(at / 600_000) * 600_000 + step * 600_000 + 3_600_000).toISOString().slice(0, 19)}+01:00`,
    );
  const value = (low: number, high: number) =>
    fc.oneof(
      fc.constant(null),
      fc.double({ min: low, max: high, noNaN: true, noDefaultInfinity: true }).map((v) => Number(v.toFixed(3))),
    );
  const observation: fc.Arbitrary<Observation> = fc.record({
    id: fc.constantFrom('2289', '2473', '2283', '2032', '520', '999999', '10', '9'),
    time,
    q: value(-5, 5000),
    w: fc.oneof(value(-3, 3), value(150, 800)),
    dangerLevel: fc.constantFrom(null, 1, 3, 5),
  });
  const observations = fc.array(observation, { maxLength: 100 });

  it('normalise yields valid, unique, never-future rows, the same whatever the order, and is idempotent', () => {
    fc.assert(
      fc.property(observations, (rows) => {
        const out = normaliseCube(rows, base);
        for (const r of out.obs) {
          ObsRow.parse(r);
          expect(Date.parse(r.ts)).toBeLessThanOrEqual(at + 15 * 60_000);
          expect(Date.parse(r.ts)).toBeGreaterThanOrEqual(at - 45 * 86_400_000);
        }
        const keys = out.obs.map((r) => `${r.series}@${r.ts}`);
        expect(new Set(keys).size).toBe(keys.length);
        // Stations come out in id order, W before Q, each station at one instant (its latest).
        const ids = out.obs.map((r) => r.series.split('/')[0] as string);
        expect(ids).toEqual([...ids].sort());
        for (const id of new Set(ids)) {
          expect(new Set(out.obs.filter((r) => r.series.startsWith(`${id}/`)).map((r) => r.ts)).size).toBe(1);
        }
        expect(normaliseCube(rows, base)).toEqual(out);
        expect(normaliseCube([...rows].reverse(), base).obs).toEqual(out.obs);
        expect(normaliseCube([...rows, ...rows], base).obs).toEqual(out.obs);
      }),
      { numRuns: 200 },
    );
  });

  it('parse never throws anything but SchemaDrift on arbitrary text, bytes or CSV-shaped garbage', () => {
    const header = HEADER.join(',');
    const cell = fc.oneof(
      fc.string({ maxLength: 12 }),
      fc.constantFrom('', '1', '2289', '1.5', 'POINT(1 2)', UNDEFINED_LEVEL, '"', '""', 'https://x'),
    );
    const shaped = fc
      .array(fc.array(cell, { minLength: 7, maxLength: 11 }), { maxLength: 8 })
      .map((rows) =>
        rows.map((r) => r.map((c) => (/[",\n\r]/.test(c) ? `"${c.replaceAll('"', '""')}"` : c)).join(',')).join('\n'),
      );
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string().map((s) => Buffer.from(s)),
          fc.uint8Array().map(Buffer.from),
          shaped.map((s) => Buffer.from(`${header}\n${s}`)),
        ),
        (b) => {
          try {
            normaliseCube(parseCube(b), base);
          } catch (err) {
            expect(err).toBeInstanceOf(SchemaDrift);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('a mutated real cube is either still valid or a SchemaDrift, never a crash or a wrong row', () => {
    const lines = rawFixture('CH-1', 'ch-1-lindas').body.toString('utf8').split('\n').slice(0, 21);
    const mutation = fc.tuple(
      fc.integer({ min: 1, max: 19 }),
      fc.integer({ min: 0, max: 8 }),
      fc.string({ maxLength: 12 }),
    );
    fc.assert(
      fc.property(mutation, ([i, col, junk]) => {
        const copy = [...lines];
        const cells = (copy[i] as string).split(',');
        cells[col] = junk;
        copy[i] = cells.join(',');
        try {
          const out = normaliseCube(parseCube(Buffer.from(copy.join('\n'))), ctx('ch-1-lindas'));
          for (const r of out.obs) ObsRow.parse(r);
        } catch (err) {
          expect(err).toBeInstanceOf(SchemaDrift);
        }
      }),
      { numRuns: 300 },
    );
  });
});
