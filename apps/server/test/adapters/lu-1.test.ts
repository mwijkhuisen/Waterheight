import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { type Normalised, ObsRow, QC, SchemaDrift } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type Context,
  LABEL_OFFSET_DEFAULT_MIN,
  label,
  normalise,
  offsetFor,
  timeAxis,
} from '../../src/adapters/lu-1/normalise.ts';
import { parseCsv } from '../../src/adapters/lu-1/parse.ts';
import { DST_PROOF, LOAD_ADAPTERS } from '../../src/load/adapters.ts';
import { scoreShifts } from '../../src/load/align.ts';
import { detectResidual, MARGIN, MIN_ALIGNED, OFFSET_PAIR } from '../../src/load/label-offset.ts';
import { goldenUrl, rawFixture, registryOf } from './registry.ts';

// LU-1 AGE `Water-Levels-LocalTime.csv` (CC0): parse + normalise of real recorded payloads equals the committed
// golden files (invariant 9), the DST proof of the naive Europe/Luxembourg labels (A§7.4 step 2: the synthetic
// fall-back and spring-forward fixtures, whose instants are checked by hand below), the label offset, and the
// rules: matched by Name, empty cells are gaps, units from the registry. `UPDATE_GOLDEN=1` rewrites goldens.

const registry = registryOf('LU-1');
const ctx = (name: string, extra: Partial<Context> = {}): Context => ({
  registry,
  fetchedAt: Date.parse(rawFixture('LU-1', name).meta.recorded_at),
  ...extra,
});

function golden(name: string, actual: Normalised): Normalised {
  const url = goldenUrl('LU-1', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const table = (name: string) => parseCsv(rawFixture('LU-1', name).body);
/**
 * The P1a recording (2026-09-29) is AGE's old 5-day file, whose labels were 15 minutes late (measured against
 * DE-1 Perl, test below); the loader would know it from the detector's app_meta state, here it is given.
 */
const OLD_FORMAT: Partial<Context> = { labelOffsets: { days: { '2026-09-20': 15 } } };
const run = (name: string, extra: Partial<Context> = {}) => normalise(table(name), ctx(name, extra));
const of = (out: Normalised, series: string) => out.obs.filter((r) => r.series === series);
const hhmm = (rows: readonly ObsRow[]) => rows.map((r) => r.ts.slice(0, 16).replace('2026-10-2', '').replace('T', ' '));
const csv = (labels: string[], rows: string[][]) =>
  Buffer.from(
    `${['Name', 'Number', 'Unit', ...labels].map((s) => `"${s}"`).join(',')}\n${rows
      .map((r) => `${r.map((s) => `"${s}"`).join(',')},""`)
      .join('\n')}\n`,
  );

describe('golden files (real payloads)', () => {
  it('one day of five rows (trimmed from the P1a recording): local labels → UTC − 15 min, Name → series', () => {
    const out = run('lu-1-csv-day', OLD_FORMAT);
    expect(out).toEqual(golden('lu-1-csv-day', out));
    // 28.09.2026 15:45 (+02:00) is 13:45Z; its value belongs to 13:30Z.
    expect(table('lu-1-csv-day').labels[0]).toBe('28.09.2026 15:45');
    expect(of(out, 'Diekirch')[0]?.ts).toBe('2026-09-28T13:30:00.000Z');
    expect(of(out, 'Diekirch').at(-1)?.ts).toBe('2026-09-29T13:15:00.000Z');
    // Esch-Sûre carries a value after the last label: its row is withheld (`row_width`), never shifted by a guess.
    expect(of(out, 'Esch-Sure')).toEqual([]);
    expect(out.dropped.row_width).toBe(97);
    // No withheld row is in a trim (review L3): the P1a recording alone holds the RLP gauges as recorded.
    expect(table('lu-1-csv-day').rows.map((r) => r.name)).toEqual([
      'Bissen',
      'Esch-Sure',
      'Perl',
      'SN_Remich',
      'Diekirch',
    ]);
    for (const r of out.obs) expect(r.qc & QC.RAW).toBe(QC.RAW);
  });

  it('a withheld RLP gauge (synthetic row, generated values) comes out under its key; the loader stores nothing of it', () => {
    const labels = ['28.09.2026 15:45', '28.09.2026 16:00', '28.09.2026 16:15'];
    const out = normalise(
      parseCsv(
        csv(labels, [
          ['Bollendorf', '', 'cm', '101.0', '', '102.5'],
          ['Gemünd_Our', '', 'cm', '7.0', '7.5', '8.0'],
        ]),
      ),
      { registry, fetchedAt: Date.parse('2026-09-29T13:43:26Z') },
    );
    expect(out.obs.map((r) => [r.series, r.ts, r.value])).toEqual([
      ['Bollendorf', '2026-09-28T13:45:00.000Z', 101],
      ['Bollendorf', '2026-09-28T14:15:00.000Z', 102.5],
      ['Gemünd_Our', '2026-09-28T13:45:00.000Z', 7],
      ['Gemünd_Our', '2026-09-28T14:00:00.000Z', 7.5],
      ['Gemünd_Our', '2026-09-28T14:15:00.000Z', 8],
    ]);
    // Both are `off` series of the public source (registry/permissions/LU-1.md; test/registry-precedence.test.ts):
    // the loader stores nothing of them (apps/server/test/load/nrw-lu.int.test.ts, on a synthetic row too).
  });

  it('the whole P1a file (42 rows × 480 labels) loads: every name is registered, only Esch-Sûre withheld', () => {
    const out = run('lu-1-csv', OLD_FORMAT);
    expect(out.unknown).toBe(0);
    expect(out.dropped).toEqual({ row_width: 481 });
    // Bissen has six empty cells: gaps, never 0.
    expect(of(out, 'Bissen')).toHaveLength(473);
    expect(of(out, 'Bissen').some((r) => r.value === 0)).toBe(false);
  });

  it('the first production capture (archive, 2026-09-30): the 672-label format without a trailing field; Esch-Sûre loads', () => {
    const out = run('lu-1-csv-seed');
    expect(out).toEqual(golden('lu-1-csv-seed', out));
    const t = table('lu-1-csv-seed');
    // Since 2026-09-30 AGE serves 7 days (672 labels) and no field after the last label; the trim kept 2 days.
    expect(t.labels).toHaveLength(192);
    expect(t.rows.every((r) => r.extra === '')).toBe(true);
    expect(out.dropped).toEqual({});
    // Esch-Sûre: m NN ×100, a level on NG95.
    expect(of(out, 'Esch-Sure')).toHaveLength(192);
    expect(of(out, 'Esch-Sure').every((r) => r.value > 31_000 && r.value < 32_000)).toBe(true);
  });

  it('[CI] the label-offset detector finds +15 min on a real payload, and 0 in the new format (both against DE-1 Perl)', async () => {
    const perl = rawFixture('DE-1', 'de-1-series-perl-w-seed');
    const de = await LOAD_ADAPTERS['DE-1']?.specs['de-1-series']?.run(perl.body, {
      registry: registryOf('DE-1'),
      fetchedAt: Date.parse(perl.meta.recorded_at),
      variant: OFFSET_PAIR.against.key,
      unitMismatch: new Set(),
    });
    const dayOf = (rows: readonly ObsRow[], key: string, iso: string, pad = 0) => {
      const from = Date.parse(iso) - pad;
      const to = Date.parse(iso) + 86_400_000 + pad;
      return rows
        .filter((r) => r.series === key && Date.parse(r.ts) >= from && Date.parse(r.ts) < to)
        .map((r) => ({ ts: Date.parse(r.ts), value: r.value }));
    };
    const deDay = (iso: string) => dayOf(de?.obs ?? [], OFFSET_PAIR.against.key, iso, 1_800_000);
    // The P1a recording (the old 5-day file), loaded with no offset applied: its Perl points sit 15 minutes late.
    const old = run('lu-1-csv');
    expect(
      detectResidual(dayOf(old.obs, OFFSET_PAIR.key, '2026-09-28T00:00:00Z'), deDay('2026-09-28T00:00:00Z')),
    ).toEqual({
      // 34 of the day's 96 instants are informative: DE-1 moved on both sides of them (review CR-4).
      residual: 15,
      n_aligned: 34,
      share: 1,
    });
    // The first production capture (the 7-day file since 2026-09-30): on time.
    const seed = run('lu-1-csv-seed');
    expect(
      detectResidual(dayOf(seed.obs, OFFSET_PAIR.key, '2026-09-29T00:00:00Z'), deDay('2026-09-29T00:00:00Z')),
    ).toEqual({
      residual: 0,
      n_aligned: 25,
      share: 1,
    });
  });

  it('[CI] the detector (review CR-4): a mostly flat day with one rise and fall still decides; flat instants do not vote', () => {
    const MIN = 60_000;
    const from = Date.parse('2026-10-05T00:00:00Z');
    // Perl at a weir: 300.0 cm all day but for one rise and fall of 17 steps (09:00 to 13:00Z), 0.1 cm a step.
    const level = (k: number) => (k < 36 || k > 52 ? 300 : 300 + (k <= 44 ? k - 35 : 53 - k) / 10);
    const de = Array.from({ length: 100 }, (_, i) => ({ ts: from + (i - 2) * 15 * MIN, value: level(i - 2) }));
    const lu = (late: number) =>
      Array.from({ length: 96 }, (_, k) => ({ ts: from + k * 15 * MIN + late * MIN, value: level(k) }));
    expect(detectResidual(lu(0), de)).toEqual({ residual: 0, n_aligned: 17, share: 1 });
    expect(detectResidual(lu(15), de)).toEqual({ residual: 15, n_aligned: 17, share: 1 });
    expect(MIN_ALIGNED).toBe(16);
    // Every instant voting (as before the fix), the flat 79 agree at every shift and no shift is clear by MARGIN.
    const all = scoreShifts(lu(0), de, [-15, 0, 15], { tolerance: 0.05 });
    expect(all.map((x) => x.share > 1 - MARGIN)).toEqual([true, true, true]);
    // Two steps fewer leave 15 informative instants, too few: no decision, with the count it saw.
    const shorter = (k: number) => (k >= 51 ? 300 : level(k));
    const de2 = de.map((p, i) => ({ ...p, value: shorter(i - 2) }));
    expect(
      detectResidual(
        lu(0).map((p, k) => ({ ...p, value: shorter(k) })),
        de2,
      ),
    ).toEqual({
      residual: null,
      n_aligned: 15,
      share: 1,
    });
    // A flat day decides nothing, and says so: no informative instant at all.
    const flat = de.map((p) => ({ ...p, value: 300 }));
    expect(
      detectResidual(
        lu(0).map((p) => ({ ...p, value: 300 })),
        flat,
      ),
    ).toEqual({
      residual: null,
      n_aligned: 0,
      share: 0,
    });
  });

  it('a header without rows (trimmed): no rows, no drift', () => {
    const out = run('lu-1-csv-empty');
    expect(out).toEqual(golden('lu-1-csv-empty', out));
    expect(out.obs).toEqual([]);
  });
});

describe('the DST proof (synthetic, hand-checked instants)', () => {
  it('lists the fixtures that load/adapters.ts DST_PROOF names, and the loader runs LU-1', () => {
    expect(DST_PROOF['lu-1-csv']).toEqual({
      fallBack: ['lu-1-csv-dst-fall-back.synthetic', 'lu-1-csv-dst-fall-back-inside.synthetic'],
      springForward: ['lu-1-csv-dst-spring-forward.synthetic'],
    });
    expect(Object.keys(LOAD_ADAPTERS['LU-1']?.specs ?? {})).toEqual(['lu-1-csv']);
  });

  it('fall-back 2026-10-25: 02:00–02:45 twice, the first pass +02:00 and the second +01:00, by column order', () => {
    const name = 'lu-1-csv-dst-fall-back.synthetic';
    const out = run(name);
    expect(out).toEqual(golden(name, out));
    // Labels 01:00 … 03:30 local (15 columns) are 23:00Z … 02:30Z: 01:00 and 01:45 are CEST (+02:00), the first
    // 02:00–02:45 too, the second 02:00–02:45 and 03:00 on are CET (+01:00). No label offset (the default, 0).
    expect(hhmm(of(out, 'Perl'))).toEqual([
      '4 23:00',
      '4 23:15',
      '4 23:30',
      '4 23:45',
      '5 00:00',
      '5 00:15',
      '5 00:30',
      '5 00:45',
      '5 01:00',
      '5 01:15',
      '5 01:30',
      '5 01:45',
      '5 02:00',
      '5 02:15',
      '5 02:30',
    ]);
    // Monotonic, no duplicate: the repeated labels are two different hours. Perl's values are 200 + column.
    expect(of(out, 'Perl').map((r) => r.value)).toEqual(Array.from({ length: 15 }, (_, i) => 200 + i));
    // Diekirch's seventh cell (the first-pass 02:30, 00:30Z) is empty: a gap, not a 0.
    expect(hhmm(of(out, 'Diekirch'))).not.toContain('5 00:30');
    expect(of(out, 'Diekirch')).toHaveLength(14);
    // Esch-Sûre: 314.01 m NN → 31,401 cm (×100 from the registry), a level.
    expect(of(out, 'Esch-Sure')[1]).toEqual({
      series: 'Esch-Sure',
      ts: '2026-10-24T23:15:00.000Z',
      value: 31401,
      qc: QC.RAW,
    });
  });

  it('fall-back, a payload that starts inside the repeated hour (second pass 02:15 = 01:15Z)', () => {
    const name = 'lu-1-csv-dst-fall-back-inside.synthetic';
    const out = run(name);
    expect(out).toEqual(golden(name, out));
    expect(hhmm(of(out, 'Diekirch'))).toEqual([
      '5 01:15',
      '5 01:30',
      '5 01:45',
      '5 02:00',
      '5 02:15',
      '5 02:30',
      '5 02:45',
      '5 03:00',
    ]);
  });

  it('spring-forward 2027-03-28: 01:45 (+01:00) is followed by 03:00 (+02:00), 15 minutes later', () => {
    const name = 'lu-1-csv-dst-spring-forward.synthetic';
    const out = run(name);
    expect(out).toEqual(golden(name, out));
    // 01:00 … 01:45 CET are 00:00Z … 00:45Z; 03:00 … 04:00 CEST are 01:00Z … 02:00Z.
    expect(of(out, 'Diekirch').map((r) => r.ts.slice(0, 16))).toEqual([
      '2027-03-28T00:00',
      '2027-03-28T00:15',
      '2027-03-28T00:30',
      '2027-03-28T00:45',
      '2027-03-28T01:00',
      '2027-03-28T01:15',
      '2027-03-28T01:30',
      '2027-03-28T01:45',
      '2027-03-28T02:00',
    ]);
  });

  it.each([
    ['a label that cannot exist (02:15 on 2027-03-28)', ['28.03.2027 01:45', '28.03.2027 02:15', '28.03.2027 03:15']],
    ['a missing column (01:30 skipped)', ['25.09.2026 01:00', '25.09.2026 01:15', '25.09.2026 01:45']],
    [
      'the repeated hour only once (02:00–02:45, then 03:00)',
      [
        '25.10.2026 01:45',
        '25.10.2026 02:00',
        '25.10.2026 02:15',
        '25.10.2026 02:30',
        '25.10.2026 02:45',
        '25.10.2026 03:00',
      ],
    ],
    [
      'the repeated hour three times',
      [
        ...['02:00', '02:15', '02:30', '02:45'],
        ...['02:00', '02:15', '02:30', '02:45'],
        ...['02:00', '02:15', '02:30', '02:45', '03:00'],
      ].map((t) => `25.10.2026 ${t}`),
    ],
    ['columns out of order', ['25.09.2026 01:15', '25.09.2026 01:00', '25.09.2026 01:30']],
    ['every label ambiguous (no anchor)', ['25.10.2026 02:00', '25.10.2026 02:15']],
  ])('refuses %s as time_axis drift (quarantined, never guessed)', (_, labels) => {
    expect(() => timeAxis(labels)).toThrow(SchemaDrift);
    try {
      timeAxis(labels);
    } catch (err) {
      expect((err as SchemaDrift).code).toBe('time_axis');
    }
  });

  it('the axis is exactly how a Luxembourg clock shows each instant (both DST nights, every 15 minutes)', () => {
    for (const [from, to] of [
      ['2026-10-24T20:00:00Z', '2026-10-25T04:00:00Z'],
      ['2027-03-27T20:00:00Z', '2027-03-28T04:00:00Z'],
    ] as const) {
      const instants: number[] = [];
      for (let t = Date.parse(from); t <= Date.parse(to); t += 15 * 60_000) instants.push(t);
      expect(timeAxis(instants.map(label))).toEqual(instants);
    }
  });
});

describe('rules (synthetic)', () => {
  const at = Date.parse('2026-09-25T12:00:00Z');
  const labels = ['25.09.2026 13:00', '25.09.2026 13:15', '25.09.2026 13:30'];
  const go = (rows: string[][], extra: Partial<Context> = {}) =>
    normalise(parseCsv(csv(labels, rows)), { registry, fetchedAt: at, ...extra });

  it('the label offset per UTC day: measured that day, else the latest measured day before, else 0', () => {
    expect(LABEL_OFFSET_DEFAULT_MIN).toBe(0);
    const days = { '2026-09-20': 0, '2026-09-24': 30 };
    expect(offsetFor('2026-09-19', { days })).toBe(0);
    expect(offsetFor('2026-09-20', { days })).toBe(0);
    expect(offsetFor('2026-09-23', { days })).toBe(0);
    expect(offsetFor('2026-09-25', { days })).toBe(30);
    // 13:00 (+02:00) is 11:00Z; with no measurement (0) the value stays there, with a measured 15 it moves to 10:45Z.
    const row = [['Diekirch', '', 'cm', '1.0', '2.0', '3.0']];
    expect(go(row).obs[0]?.ts).toBe('2026-09-25T11:00:00.000Z');
    expect(go(row, { labelOffsets: { days: { '2026-09-25': 15 } } }).obs[0]?.ts).toBe('2026-09-25T10:45:00.000Z');
  });

  it('a Name twice withholds both rows (conflict); an unknown Name is unknown, never matched loosely', () => {
    const out = go([
      ['Diekirch', '', 'cm', '1.0', '', '3.0'],
      ['Diekirch', '', 'cm', '1.0', '2.0', '3.0'],
      ['diekirch', '', 'cm', '1.0', '2.0', '3.0'],
      ['Diekirch ', '', 'cm', '1.0', '2.0', '3.0'],
    ]);
    expect(out.obs).toEqual([]);
    expect(out.dropped.conflict).toBe(5);
    expect(out.unknown).toBe(2);
  });

  it("a row's Unit other than the series' native unit withholds its values (unit_mismatch)", () => {
    const out = go([['Esch-Sure', '', 'cm', '31401', '31402', '']]);
    expect(out).toMatchObject({ obs: [], dropped: { unit_mismatch: 2 } });
  });

  it('the window (since) and the future: rows before `since` and more than 15 minutes ahead are dropped', () => {
    const out = go([['Diekirch', '', 'cm', '1.0', '2.0', '3.0']], {
      fetchedAt: Date.parse('2026-09-25T10:50:00Z'),
      since: Date.parse('2026-09-25T11:00:00Z'),
      labelOffsets: { days: { '2026-09-25': 15 } },
    });
    // Instants 10:45, 11:00 and 11:15 (a measured offset of 15): 10:45 is outside the window, 11:15 is 25 min after the fetch.
    expect(out.obs.map((r) => r.ts)).toEqual(['2026-09-25T11:00:00.000Z']);
    expect(out.dropped).toEqual({ outside_window: 1, future: 1 });
  });

  it.each([
    ['a header without Name/Number/Unit', 'Station,Number,Unit,"25.09.2026 13:00"\nA,,cm,1\n', 'csv_header'],
    ['a label in another format', 'Name,Number,Unit,"2026-09-25 13:00"\nA,,cm,1\n', 'time_bad_format'],
    ['a Number', 'Name,Number,Unit,"25.09.2026 13:00"\nA,7,cm,1\n', 'number'],
    ['another unit', 'Name,Number,Unit,"25.09.2026 13:00"\nA,,mm,1\n', 'unit'],
    ['a value with a comma decimal', 'Name,Number,Unit,"25.09.2026 13:00"\nA,,cm,"1,5"\n', 'bad_value'],
    ['a row two fields wider', 'Name,Number,Unit,"25.09.2026 13:00"\nA,,cm,1,,\n', 'csv_width'],
    ['invalid UTF-8', Buffer.from([0x4e, 0x61, 0x6d, 0x65, 0xff]), 'encoding'],
  ])('refuses %s', (_, body, code) => {
    expect(() => parseCsv(typeof body === 'string' ? Buffer.from(body) : body)).toThrow(SchemaDrift);
    try {
      parseCsv(typeof body === 'string' ? Buffer.from(body) : body);
    } catch (err) {
      expect((err as SchemaDrift).code).toBe(code);
    }
  });
});

describe('property and fuzz tests', () => {
  // At least 9 columns: the 8 ambiguous labels of a fall-back night (02:00–02:45 twice) never fill a window alone.
  it('normalise yields valid, unique, monotonic, never-future rows on 15-minute axes crossing either DST night', () => {
    const start = fc.oneof(
      fc.integer({ min: 0, max: 40 }).map((i) => Date.parse('2026-10-24T20:00:00Z') + i * 15 * 60_000),
      fc.integer({ min: 0, max: 40 }).map((i) => Date.parse('2027-03-27T20:00:00Z') + i * 15 * 60_000),
    );
    const cell = fc.oneof(
      fc.constant(''),
      fc.integer({ min: -500, max: 2000 }).map((v) => (v / 10).toFixed(1)),
    );
    fc.assert(
      fc.property(
        start,
        fc.integer({ min: 9, max: 24 }),
        fc.array(cell, { minLength: 24, maxLength: 24 }),
        (t0, n, cells) => {
          const instants = Array.from({ length: n }, (_, i) => t0 + i * 15 * 60_000);
          const body = csv(instants.map(label), [['Diekirch', '', 'cm', ...cells.slice(0, n)]]);
          const out = normalise(parseCsv(body), { registry, fetchedAt: (instants.at(-1) as number) + 3_600_000 });
          const ts = out.obs.map((r) => Date.parse(r.ts));
          for (const r of out.obs) ObsRow.parse(r);
          expect(ts).toEqual([...ts].sort((a, b) => a - b));
          expect(new Set(ts).size).toBe(ts.length);
          // Each value sits at its own label's instant less the default offset.
          out.obs.forEach((r) => {
            const i = instants.indexOf(Date.parse(r.ts) + LABEL_OFFSET_DEFAULT_MIN * 60_000);
            expect(Number(cells[i])).toBe(r.value);
          });
        },
      ),
      { numRuns: 300 },
    );
  });

  it('parse and normalise never throw anything but SchemaDrift on arbitrary or CSV-shaped input', () => {
    const shaped = fc
      .array(
        fc.array(fc.oneof(fc.string({ maxLength: 8 }), fc.constantFrom('', 'cm', 'm', '1.5', '25.10.2026 02:15')), {
          maxLength: 6,
        }),
        { maxLength: 5 },
      )
      .map((rows) => rows.map((r) => r.join(',')).join('\n'));
    fc.assert(
      fc.property(
        fc.oneof(
          fc.uint8Array().map((u) => Buffer.from(u)),
          shaped.map((s) => Buffer.from(`"Name","Number","Unit","25.10.2026 02:00","25.10.2026 02:15"\n${s}\n`)),
        ),
        (b) => {
          try {
            normalise(parseCsv(b), { registry, fetchedAt: Date.parse('2026-10-25T03:00:00Z') });
          } catch (err) {
            expect(err).toBeInstanceOf(SchemaDrift);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('the loader runs every LU-1 fixture (real and synthetic)', async () => {
    const spec = LOAD_ADAPTERS['LU-1']?.specs['lu-1-csv'];
    for (const name of ['lu-1-csv', 'lu-1-csv-day', 'lu-1-csv-empty', ...(DST_PROOF['lu-1-csv']?.fallBack ?? [])]) {
      const out = await spec?.run(rawFixture('LU-1', name).body, {
        registry,
        fetchedAt: Date.parse(rawFixture('LU-1', name).meta.recorded_at),
        variant: '',
        unitMismatch: new Set(),
      });
      expect([name, out?.gaugeZeros]).toEqual([name, []]);
    }
  });
});
