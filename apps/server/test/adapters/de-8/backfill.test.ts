import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { StationsFile } from '@rws/contracts';
import { type Registry, SchemaDrift } from '@rws/core';
import fc from 'fast-check';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  BACKFILL_FLOOR_MS,
  MAX_HOLD_MS,
  TIME as NORMALISE_TIME,
  normaliseBackfill,
} from '../../../src/adapters/de-8/normalise.ts';
import {
  BACKFILL_HEADER,
  BACKFILL_MAX_ROWS,
  BACKFILL_ZIP,
  backfillSink,
  MEMBER_RE,
  memberStation,
  TIME,
} from '../../../src/adapters/de-8/parse.ts';
import { validate } from '../../../src/archive/validity.ts';
import { provider } from '../../../src/backfill/providers/de-8.ts';
import { De8BackfillSpec, type De8Unit } from '../../../src/backfill/spec.ts';
import { LOAD_ADAPTERS, type LoadContext } from '../../../src/load/adapters.ts';
import { goldenUrl, rawFixture, registryOf } from '../registry.ts';

// P14b: the DE-8 decade ZIPs of hydro/w (the NRW verified archive), recorded live on 2026-10-18 and run through the
// loader's own backfill spec `de-8-backfill-w` onto the DE-7 W series of the tier-1 gauges (invariant 9). The goldens
// are compared as they are; `UPDATE_GOLDEN=1` rewrites them. The three fixtures:
//  - `de-8-backfill-w-rur-2020`: Rur 2020-2029 cut to the tier-1 gauge Stah (from 2026-04-01) and 200 rows of the
//    unselected Süsterseel. Golden window [2026-06-30T20:00Z, 2026-07-01T16:00Z): it ends across Stah's last row, an `NA`
//    at 2026-07-01T12:00+01:00, after which nothing holds.
//  - `de-8-backfill-w-ibv-1950`: Issel-Berkel-Vechte 1950-1959 whole (change-driven stamps, an `NA` at 1 January of
//    each year before a gauge's data starts, tier-1 Rhedebrügge and Bilk, three unselected members). Golden window
//    [1958-12-10T00:00Z, 1958-12-10T18:00Z): Rhedebrügge's first values (gaps of 1 to 3 h, empty before 11:46+01:00) and
//    Bilk's held value since 1957.
//  - `de-8-backfill-q-erft-1930`: a discharge (Q) file under the W spec: refused by the member name.

const base = registryOf('DE-7');
const tiers = new Map(
  StationsFile.parse(
    parse(readFileSync(new URL('../../../../../registry/stations/de-7.yaml', import.meta.url), 'utf8')),
  ).stations.map((r) => [r.provider_key, r.tier] as const),
);
/** The DE-7 registry as the loader hands it to a backfill spec: with each series' tier. */
const registry: Registry = new Map([...base].map(([k, d]) => [k, { ...d, tier: tiers.get(k) as number }]));

const spec = LOAD_ADAPTERS['DE-8']?.specs['de-8-backfill-w'];
if (spec === undefined) throw new Error('no de-8-backfill-w loader');

const utc = (s: string) => Date.parse(s);
const ctx = (window?: [string, string], extra: Partial<LoadContext> = {}): LoadContext => ({
  registry,
  fetchedAt: utc('2026-10-18T22:00:00Z'),
  variant: '',
  unitMismatch: new Set(),
  ...(window === undefined ? {} : { backfill: { from: utc(window[0]), to: utc(window[1]) } }),
  ...extra,
});
type Out = Awaited<ReturnType<NonNullable<typeof spec>['run']>> & {
  provider_values: number;
  unknown_values: number;
  raw_dropped: Record<string, number>;
};
const run = (body: Uint8Array, window: [string, string], extra: Partial<LoadContext> = {}) =>
  spec.run(body, ctx(window, extra)) as Promise<Out>;

function golden<T>(name: string, actual: T): T {
  const url = goldenUrl('DE-8', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(SchemaDrift);
    return (err as SchemaDrift).code;
  }
  return 'parsed';
};

const STAH = '2829100000100';
const RHEDEBRUEGGE = '9282570000100';
const BILK = '9286190000100';
const key = (no: string) => `${no}/W`;
const bodyOf = (name: string) => rawFixture('DE-8', name).body;

/** A member as the provider spells it, from `[iso, value]` pairs. */
const member = (no: string, rows: readonly (readonly [string, string])[], name = 'x') =>
  [BACKFILL_HEADER, ...rows.map(([t, v]) => `${name};${no};${t};${v}`)].join('\n').concat('\n');
const memberName = (no: string, label = 'Station') => `${no}_${label}_2020-2025_Wasserstand_cm.csv`;
const zipOf = (members: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(members).map(([n, t]) => [n, strToU8(t)])));
// The files stamp +01:00: the same instant as a UTC ISO string, written as the provider does.
const at = (iso: string) => new Date(utc(iso) + 3_600_000).toISOString().replace('.000Z', '+01:00');
const grid15 = (from: string, n: number): (readonly [string, string])[] =>
  Array.from({ length: n }, (_, i) => [at(new Date(utc(from) + i * 900_000).toISOString()), String(100 + i)] as const);

describe('golden files (real payloads)', () => {
  it('Rur 2020-2029 cut to Stah and Süsterseel: Stah held onto the 15-minute grid, the last NA ends the hold', async () => {
    const window: [string, string] = ['2026-06-30T20:00:00Z', '2026-07-01T16:00:00Z'];
    const out = await run(bodyOf('de-8-backfill-w-rur-2020'), window);
    expect({ window, ...out }).toEqual(golden('de-8-backfill-w-rur-2020', { window, ...out }));
    expect(out.obs.every((r) => r.series === key(STAH) && r.qc === 2)).toBe(true);
    // 80 grid points: the values up to 10:45Z, the NA of 11:00Z ends the hold, nothing after.
    expect([out.provider_values, out.obs.length, out.dropped]).toEqual([80, 60, { no_value: 20 }]);
    expect(out.obs.at(-1)?.ts).toBe('2026-07-01T10:45:00.000Z');
    // The 200 rows of Süsterseel (not tier 1) are the only raw drop; nothing is unknown.
    expect([out.raw_dropped, out.unknown, out.unknown_values]).toEqual([{ unselected: 200 }, 0, 0]);
  });

  it('IBV 1950-1959 (change-driven stamps, NA rows before the data): two tier-1 gauges held, three members counted', async () => {
    const window: [string, string] = ['1958-12-10T00:00:00Z', '1958-12-10T18:00:00Z'];
    const out = await run(bodyOf('de-8-backfill-w-ibv-1950'), window);
    expect({ window, ...out }).toEqual(golden('de-8-backfill-w-ibv-1950', { window, ...out }));
    const by = (no: string) => out.obs.filter((r) => r.series === key(no));
    // Bilk's data starts in 1957: it holds from the last row before the window, never stretched past 24 h.
    expect(by(BILK).length).toBeGreaterThan(0);
    // Rhedebrügge's first value is at 1958-12-10T10:46Z: nothing before it (the rows before are NA).
    expect(by(RHEDEBRUEGGE)[0]?.ts).toBe('1958-12-10T11:00:00.000Z');
    expect([out.provider_values, out.obs.length + (out.dropped.no_value ?? 0)]).toEqual([144, 144]);
    // The other three members, their data rows counted: Lutum is registered (tier 2), Borken-Stadt and Temmingsmühle are not.
    expect(out.raw_dropped).toEqual({ unselected: 5547, unregistered: 1107 + 7057 });
  });

  it('a Q file under the W spec is refused by the member name (zip_name), nothing is read', async () => {
    const body = bodyOf('de-8-backfill-q-erft-1930');
    const code = await refusal(run(body, ['1930-01-01T00:00:00Z', '1930-02-01T00:00:00Z']));
    expect(code).toBe('zip_name');
    expect({ error: code }).toEqual(golden('de-8-backfill-q-erft-1930', { error: code }));
    // The member name is the only thing that tells Q from W (the header differs in its unit too).
    const [name] = Object.keys(unzipSync(body));
    expect([MEMBER_RE.test(name as string), memberStation(name as string)]).toEqual([false, null]);
  });

  it('the recorded W member names (32 in two recordings) all fit MEMBER_RE and give their 13 digits', () => {
    const names = [
      ...Object.keys(unzipSync(bodyOf('de-8-backfill-w-rur-2020'))),
      ...Object.keys(unzipSync(bodyOf('de-8-backfill-w-ibv-1950'))),
    ];
    expect(names).toHaveLength(7);
    for (const n of names) expect(memberStation(n)).toBe(n.slice(0, 13));
    // The 27 names of the whole Rur file, with the spaces and dots of the provider's spelling (`Zerkall 2`, `Kall-Sportpl.`).
    for (const n of [
      '2823490000100_Zerkall 2_2020-2025_Wasserstand_cm.csv',
      '2822700000200_Kall-Sportpl._2020-2025_Wasserstand_cm.csv',
      '2824410000100_Roetgen W_2020-2025_Wasserstand_cm.csv',
    ])
      expect(MEMBER_RE.test(n)).toBe(true);
  });

  it('Stah of the trimmed Rur file: its rows from 2026-04-01 on, strictly increasing, 15-minute grid with off-grid stamps', () => {
    const file = unzipSync(bodyOf('de-8-backfill-w-rur-2020'));
    const text = Buffer.from(file[memberName(STAH, 'Stah')] as Uint8Array).toString('utf8');
    const sink = backfillSink(STAH, { keep: true });
    for (const l of text.split('\n').slice(0, -1)) sink.line(l);
    const got = sink.end();
    expect(got.rows).toBe(got.ts.length);
    expect(got.ts.at(0)).toBe(utc('2026-04-01T00:00:00+01:00'));
    expect(got.ts.at(-1)).toBe(utc('2026-07-01T12:00:00+01:00'));
    expect(Number.isNaN(got.value.at(-1))).toBe(true);
    expect(got.ts.length).toBeGreaterThan(8000);
  });
});

describe('the loader spec', () => {
  it('is a backfill spec onto DE-7 with the 25 MiB cap, no variant, and a fixed +01:00 convention (ungated)', () => {
    expect([spec.backfill, spec.obsTarget, spec.needsVariant, spec.maxBytes]).toEqual([
      true,
      'DE-7',
      false,
      25 * 1024 * 1024,
    ]);
    expect(TIME).toEqual({ kind: 'fixed-offset', offset: '+01:00' });
    expect(NORMALISE_TIME).toBe(TIME);
  });

  it('needs the slice window: a line without one is refused (fail closed)', async () => {
    const r = spec.run(bodyOf('de-8-backfill-w-ibv-1950'), ctx());
    expect(await refusal(Promise.resolve(r))).toBe('backfill_window');
  });

  it('selects by the registry (tier 1) and counts every other raw row by its code, never into dropped', async () => {
    const t = (n: number) => [at('2026-06-01T00:00:00Z'), String(n)] as const;
    const rows = [t(10), [at('2026-06-01T00:15:00Z'), '11'] as const];
    const body = zipOf({
      [memberName(STAH, 'Stah')]: member(STAH, rows),
      // Registered, tier 2.
      [memberName('2581119000100', 'Feudingen')]: member('2581119000100', rows),
      // Not registered.
      [memberName('2999999000100', 'Unknown')]: member('2999999000100', rows),
      // A WSV gauge (site suffix 102).
      [memberName('2829100000102', 'Wsv')]: member('2829100000102', rows),
    });
    const out = await run(body, ['2026-06-01T00:00:00Z', '2026-06-01T00:30:00Z']);
    expect(out.obs.map((r) => [r.series, r.ts, r.value])).toEqual([
      [key(STAH), '2026-06-01T00:00:00.000Z', 10],
      [key(STAH), '2026-06-01T00:15:00.000Z', 11],
    ]);
    expect(out.raw_dropped).toEqual({ unselected: 2, unregistered: 2, wsv_duplicate: 2 });
    expect([out.dropped, out.provider_values, out.unknown, out.unknown_values]).toEqual([{}, 2, 0, 0]);
  });

  it('a placeholder number is counted as placeholder (pure normaliser)', () => {
    const out = normaliseBackfill(
      {
        rows: new Map(),
        counted: new Map([
          ['1234567', 3],
          ['123456', 4],
        ]),
      },
      { registry, window: { from: 0, to: 1 } },
    );
    expect(out.raw_dropped).toEqual({ placeholder: 7 });
    expect(out.obs).toEqual([]);
  });

  it('a selected station that was counted, not parsed, is a wiring fault: not_parsed', () => {
    const run_ = () =>
      normaliseBackfill(
        { rows: new Map(), counted: new Map([[STAH, 3]]) },
        { registry, window: { from: 0, to: 1_000_000_000_000 } },
      );
    expect(() => run_()).toThrow(SchemaDrift);
  });

  it('a station the window and the floor leave nothing of: no grid, no values (the floor is 1950-01-01)', () => {
    const rows = new Map([[STAH, { ts: [utc('1940-01-01T00:00:00Z')], value: [5] }]]);
    const out = normaliseBackfill(
      { rows, counted: new Map() },
      { registry, window: { from: utc('1900-01-01T00:00:00Z'), to: BACKFILL_FLOOR_MS } },
    );
    expect([out.provider_values, out.obs.length]).toEqual([0, 0]);
  });

  it('the value is scaled by the series (to_canonical) and carries qc VALIDATED (bit 2) and nothing else', async () => {
    const body = zipOf({ [memberName(STAH, 'Stah')]: member(STAH, [[at('2026-06-01T00:00:00Z'), '60.6']]) });
    const [row] = (await run(body, ['2026-06-01T00:00:00Z', '2026-06-01T00:15:00Z'])).obs;
    expect(row).toEqual({ series: key(STAH), ts: '2026-06-01T00:00:00.000Z', value: 60.6, qc: 2 });
  });

  it('the hold: the last row seeds the first points, ends at NA and at 24 h, and a point before the first row is empty', async () => {
    const hold = (rows: readonly (readonly [string, string])[], w: [string, string]) =>
      run(zipOf({ [memberName(STAH)]: member(STAH, rows) }), w);
    // The window starts after the file's first row: it is seeded by it (and by the next row once that is due).
    const seeded = await hold(
      [
        [at('2026-06-01T00:00:00Z'), '10'],
        [at('2026-06-01T00:40:00Z'), '12'],
      ],
      ['2026-06-01T00:30:00Z', '2026-06-01T01:00:00Z'],
    );
    expect(seeded.obs.map((r) => [r.ts.slice(11, 16), r.value])).toEqual([
      ['00:30', 10],
      ['00:45', 12],
    ]);
    // A row exactly MAX_HOLD_MS old still holds, one grid step later it does not; a gap row ends the hold at once.
    const long = await hold(
      [
        [at('2026-06-01T00:00:00Z'), '10'],
        [at('2026-06-02T12:00:00Z'), 'NA'],
        [at('2026-06-02T12:30:00Z'), '30'],
      ],
      ['2026-06-02T00:00:00Z', '2026-06-02T13:00:00Z'],
    );
    const held = long.obs.map((r) => r.ts.slice(11, 16));
    expect(MAX_HOLD_MS).toBe(24 * 3_600_000);
    // 2026-06-02T00:00Z is exactly 24 h after the row: it holds; 00:15Z does not.
    expect(held[0]).toBe('00:00');
    expect(held[1]).toBe('12:30');
    expect(long.obs.map((r) => r.value)).toEqual([10, 30, 30]);
    // 00:15 … 12:15Z (49 points) no value: too old, then the NA row; 12:30Z and 12:45Z the new value.
    expect(long.dropped).toEqual({ no_value: 49 });
    // A point before the first row stays empty.
    const before = await hold([[at('2026-06-01T01:00:00Z'), '10']], ['2026-06-01T00:00:00Z', '2026-06-01T01:30:00Z']);
    expect(before.obs.map((r) => r.ts.slice(11, 16))).toEqual(['01:00', '01:15']);
    expect(before.dropped).toEqual({ no_value: 4 });
  });

  it('a row of 1949 is held onto 1950-01-01 at the earliest: no grid point before the floor', async () => {
    const body = zipOf({ [memberName(STAH)]: member(STAH, [[at('1949-12-31T23:00:00Z'), '7']]) });
    const out = await run(body, ['1949-12-31T22:00:00Z', '1950-01-01T00:30:00Z']);
    expect(out.obs.map((r) => r.ts)).toEqual(['1950-01-01T00:00:00.000Z', '1950-01-01T00:15:00.000Z']);
    expect(out.provider_values).toBe(2);
  });

  it('keeps the parse of the last object across lines of the same memoKey, and parses again for another key', async () => {
    const a = zipOf({ [memberName(STAH)]: member(STAH, [[at('2026-06-01T00:00:00Z'), '1']]) });
    const b = zipOf({ [memberName(STAH)]: member(STAH, [[at('2026-06-01T00:00:00Z'), '2']]) });
    const w: [string, string] = ['2026-06-01T00:00:00Z', '2026-06-01T00:15:00Z'];
    const value = async (body: Uint8Array, memoKey?: string) =>
      (await run(body, w, memoKey === undefined ? {} : { memoKey })).obs[0]?.value;
    expect(await value(a, 'k1')).toBe(1);
    // The same key is the same bytes: the second line reads the memo (the body is not even looked at).
    expect(await value(b, 'k1')).toBe(1);
    expect(await value(b, 'k2')).toBe(2);
    expect(await value(a, 'k1')).toBe(1);
    // No key, no memo, and a failed parse never leaves one.
    expect(await value(b)).toBe(2);
    expect(await value(a)).toBe(1);
  });
});

describe('the ZIP guard (§6.7), with the caps of this spec', () => {
  const w: [string, string] = ['2026-06-01T00:00:00Z', '2026-06-01T00:15:00Z'];
  const ok = member(STAH, [[at('2026-06-01T00:00:00Z'), '1']]);
  const code = (body: Uint8Array) => refusal(run(body, w));

  it('refuses a path that leaves the folder, a directory, another name and a name with a backslash (zip_name)', async () => {
    for (const name of [
      `../${memberName(STAH)}`,
      `sub/${memberName(STAH)}`,
      'other.csv',
      memberName(STAH).replace('Station', 'a\\b'),
      `${memberName(STAH)}/`,
      memberName(STAH).replace('Wasserstand_cm', 'Abfluss_m3s'),
    ])
      expect([name, await code(zipOf({ [name]: ok }))]).toEqual([name, 'zip_name']);
  });

  it('refuses more than 200 members (zip_members) and takes 200', async () => {
    const members = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
          memberName(String(2000000000000 + i * 100)),
          member(String(2000000000000 + i * 100), []),
        ]),
      );
    expect(await code(zipOf(members(BACKFILL_ZIP.members + 1)))).toBe('zip_members');
    const out = await run(zipOf(members(BACKFILL_ZIP.members)), w);
    // Unregistered stations: 200 members of a header and no row, so nothing to count.
    expect([out.obs.length, out.raw_dropped]).toEqual([0, {}]);
  });

  it('refuses a member that deflates 50:1 or more (zip_ratio): a ZIP bomb', async () => {
    const bomb = `${BACKFILL_HEADER}\n${'a'.repeat(4 * 1024 * 1024)}\n`;
    expect(await code(zipOf({ [memberName(STAH)]: bomb }))).toBe('zip_ratio');
  });

  it('refuses a member whose real size is larger than its central directory says (zip_size): a lying size', async () => {
    const zip = Buffer.from(zipOf({ [memberName(STAH)]: member(STAH, grid15('2026-06-01T00:00:00Z', 200)) }));
    const cd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(zip.readUInt32LE(cd + 24) - 10, cd + 24);
    expect(await code(zip)).toBe('zip_size');
  });

  it('refuses bytes that are not a ZIP (zip_eocd) and a member that is not UTF-8 (encoding)', async () => {
    expect(await code(Buffer.from(ok))).toBe('zip_eocd');
    const latin1 = zipSync({ [memberName(STAH)]: Buffer.from(ok.replace('x;', 'Süsterseel;'), 'latin1') });
    expect(await code(latin1)).toBe('encoding');
  });
});

describe('the strict line sink', () => {
  const lines = (...l: string[]) => {
    const sink = backfillSink(STAH, { keep: true });
    for (const x of l) sink.line(x);
    return sink.end();
  };
  const row = (o: Partial<Record<'no' | 'at' | 'v', string>> = {}) =>
    `Stah;${o.no ?? STAH};${o.at ?? '2020-01-01T00:00:00+01:00'};${o.v ?? '106'}`;
  const drift = (fn: () => unknown): [string, string] | 'parsed' => {
    try {
      fn();
    } catch (err) {
      expect(err).toBeInstanceOf(SchemaDrift);
      return [(err as SchemaDrift).code, (err as SchemaDrift).path];
    }
    return 'parsed';
  };

  it('reads values, decimals, negatives and NA; a header-only member is an empty station', () => {
    const got = lines(
      BACKFILL_HEADER,
      row(),
      row({ at: '2020-01-01T00:15:00+01:00', v: '60.6' }),
      row({ at: '2020-01-01T00:30:00+01:00', v: 'NA' }),
      row({ at: '2020-01-01T00:45:00+01:00', v: '-1.25' }),
    );
    expect(got.ts).toEqual([0, 1, 2, 3].map((i) => utc('2019-12-31T23:00:00Z') + i * 900_000));
    expect(got.value.map((v) => (Number.isNaN(v) ? 'NA' : v))).toEqual([106, 60.6, 'NA', -1.25]);
    expect(lines(BACKFILL_HEADER).rows).toBe(0);
  });

  it.each([
    ['no header', [row()], ['csv_header', 'line.1']],
    ['another header', ['a;b;c;d'], ['csv_header', 'line.1']],
    ['the Q header', ['station_name;station_no;dateTime;value[m³/s]'], ['csv_header', 'line.1']],
    ['3 fields', [BACKFILL_HEADER, 'Stah;2829100000100;2020-01-01T00:00:00+01:00'], ['csv_width', 'line.2']],
    ['5 fields', [BACKFILL_HEADER, `${row()};x`], ['csv_width', 'line.2']],
    ['an empty line', [BACKFILL_HEADER, ''], ['csv_width', 'line.2']],
    ['another station than the member', [BACKFILL_HEADER, row({ no: '2829100000200' })], ['station_no', 'line.2']],
    ['a short station number', [BACKFILL_HEADER, row({ no: '282910000010' })], ['station_no', 'line.2']],
    ['the offset +02:00', [BACKFILL_HEADER, row({ at: '2020-07-01T00:00:00+02:00' })], ['time_bad_format', 'line.2']],
    ['a Z stamp', [BACKFILL_HEADER, row({ at: '2020-01-01T00:00:00Z' })], ['time_bad_format', 'line.2']],
    [
      'fraction seconds',
      [BACKFILL_HEADER, row({ at: '2020-01-01T00:00:00.000+01:00' })],
      ['time_bad_format', 'line.2'],
    ],
    [
      'a date that does not exist',
      [BACKFILL_HEADER, row({ at: '2020-02-30T00:00:00+01:00' })],
      ['time_bad_format', 'line.2'],
    ],
    ['a value with a comma', [BACKFILL_HEADER, row({ v: '1,5' })], ['bad_value', 'line.2']],
    ['a value of 7 digits', [BACKFILL_HEADER, row({ v: '1234567' })], ['bad_value', 'line.2']],
    ['nan', [BACKFILL_HEADER, row({ v: 'NaN' })], ['bad_value', 'line.2']],
    ['an empty value', [BACKFILL_HEADER, row({ v: '' })], ['bad_value', 'line.2']],
    ['a repeated stamp', [BACKFILL_HEADER, row(), row()], ['time_order', 'line.3']],
    [
      'a stamp going back',
      [BACKFILL_HEADER, row({ at: '2020-01-01T00:15:00+01:00' }), row()],
      ['time_order', 'line.3'],
    ],
    ['a line over 1 KiB', [BACKFILL_HEADER, row({ v: '1'.repeat(1100) })], ['line_length', 'line.2']],
  ])('refuses %s', (_, input, want) => {
    expect(drift(() => lines(...(input as string[])))).toEqual(want);
  });

  it('refuses a member with no line at all (csv_empty) and a header with a byte order mark (the files have none)', () => {
    expect(drift(() => lines())).toEqual(['csv_empty', '']);
    expect(drift(() => lines(`﻿${BACKFILL_HEADER}`))).toEqual(['csv_header', 'line.1']);
  });

  it('caps the rows of a member at 2,000,000 (csv_rows), also for a station nobody selects (which is only counted)', () => {
    const sink = backfillSink(STAH, { keep: false });
    sink.line(BACKFILL_HEADER);
    for (let i = 0; i < BACKFILL_MAX_ROWS; i += 1) sink.line('x');
    expect(sink.end().rows).toBe(BACKFILL_MAX_ROWS);
    expect(drift(() => sink.line('x'))).toEqual(['csv_rows', `line.${BACKFILL_MAX_ROWS + 2}`]);
  });

  it('a counting sink still checks the header and stores nothing', () => {
    const sink = backfillSink(STAH, { keep: false });
    sink.line(BACKFILL_HEADER);
    sink.line('not even a row');
    expect(sink.end()).toEqual({ ts: [], value: [], rows: 1 });
    expect(drift(() => backfillSink(STAH, { keep: false }).line('a;b'))).toEqual(['csv_header', 'line.1']);
  });
});

describe('the step-hold (property)', () => {
  const key_ = key(STAH);
  const decl = {
    ...(registry.get(key_) as NonNullable<ReturnType<typeof registry.get>>),
    tier: 1,
    native_step_ms: 900_000,
    to_canonical: 1,
  };
  const reg: Registry = new Map([[key_, decl]]);
  const STEP = 900_000;

  /** Rows: strictly increasing stamps from random gaps (a minute to three days), a value or a gap (NaN) each. */
  const input = fc.record({
    start: fc.integer({ min: Date.UTC(1950, 0, 1), max: Date.UTC(2026, 6, 1) }),
    gaps: fc.array(fc.integer({ min: 60_000, max: 3 * 86_400_000 }), { minLength: 1, maxLength: 40 }),
    values: fc.array(fc.option(fc.integer({ min: -50, max: 900 }), { nil: Number.NaN }), {
      minLength: 40,
      maxLength: 40,
    }),
    shift: fc.integer({ min: -4 * 86_400_000, max: 4 * 86_400_000 }),
    span: fc.integer({ min: 1, max: 5 * 96 }),
  });

  it('never a value between two rows; the hold ends at NA and at 24 h; provider_values = kept + no_value; every point on the grid and in the window', () => {
    fc.assert(
      fc.property(input, ({ start, gaps, values, shift, span }) => {
        const ts: number[] = [];
        let t = start;
        for (const g of gaps) {
          ts.push(t);
          t += g;
        }
        const value = ts.map((_, i) => values[i] as number);
        const from = (ts[0] as number) + shift;
        const to = from + span * STEP;
        const out = normaliseBackfill(
          { rows: new Map([[STAH, { ts, value }]]), counted: new Map() },
          { registry: reg, window: { from, to } },
        );

        // The oracle: the last row at or before g, a linear scan.
        const expected: [number, number][] = [];
        let noValue = 0;
        let points = 0;
        for (let g = Math.ceil(Math.max(from, BACKFILL_FLOOR_MS) / STEP) * STEP; g < to; g += STEP) {
          points += 1;
          let j = -1;
          for (let i = 0; i < ts.length; i += 1) if ((ts[i] as number) <= g) j = i;
          const v = j < 0 ? Number.NaN : (value[j] as number);
          if (Number.isNaN(v) || g - (ts[j] as number) > MAX_HOLD_MS) noValue += 1;
          else expected.push([g + 0, v]);
        }
        expect(out.obs.map((r) => [Date.parse(r.ts), r.value])).toEqual(expected);
        expect(out.provider_values).toBe(points);
        expect(out.provider_values).toBe(out.obs.length + (out.dropped.no_value ?? 0));
        expect(out.dropped.no_value ?? 0).toBe(noValue);
        for (const r of out.obs) {
          const g = Date.parse(r.ts);
          expect(g % STEP === 0).toBe(true);
          expect(g).toBeGreaterThanOrEqual(Math.max(from, BACKFILL_FLOOR_MS));
          expect(g).toBeLessThan(to);
          // Never interpolated: the value is the one of a row, the last one before the point.
          expect(value).toContain(r.value);
          expect(r.qc).toBe(2);
        }
        expect(out.raw_dropped).toEqual({});
      }),
      { numRuns: 300 },
    );
  });

  it('slices of one file tile: the union of two adjacent windows equals one window over both', () => {
    fc.assert(
      fc.property(input, ({ start, gaps, values, shift, span }) => {
        const ts: number[] = [];
        let t = start;
        for (const g of gaps) {
          ts.push(t);
          t += g;
        }
        const value = ts.map((_, i) => values[i] as number);
        const from = Math.ceil(((ts[0] as number) + shift) / STEP) * STEP;
        const mid = from + span * STEP;
        const to = mid + span * STEP;
        const rows = { rows: new Map([[STAH, { ts, value }]]), counted: new Map<string, number>() };
        const part = (a: number, b: number) => normaliseBackfill(rows, { registry: reg, window: { from: a, to: b } });
        const [x, y, all] = [part(from, mid), part(mid, to), part(from, to)];
        expect([...x.obs, ...y.obs]).toEqual(all.obs);
        expect(x.provider_values + y.provider_values).toBe(all.provider_values);
      }),
      { numRuns: 100 },
    );
  });
});

describe('the provider', () => {
  if (provider === null) throw new Error('no DE-8 provider');
  const p = provider;
  const dir = new URL('../../../../../registry/', import.meta.url);
  const datasets = [
    { name: 'Rureinzugsgebiet', stations: [STAH] },
    { name: 'Niers-u-Schwalmeinzugsgebiet', stations: ['2849900000100', '2869500000200'] },
    { name: 'Emseinzugsgebiet', stations: ['3190000000100'] },
    {
      name: 'Issel-Berkel-Vechteeinzugsgebiet',
      stations: ['9281700000200', RHEDEBRUEGGE, '9284730000100', BILK, '9286455000200'],
    },
  ];
  const decades = [1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020];
  const make = (over: Record<string, unknown> = {}) =>
    De8BackfillSpec.parse({
      id: 'de-8-backfill-w',
      source: 'DE-8',
      target: 'DE-7',
      version: 1,
      url: 'https://www.opengeodata.nrw.de/produkte/umwelt_klima/wasser/oberflaechengewaesser/hydro/w/',
      select: { first_release: true },
      chunk: 'P30D',
      floor: '1950-01-01',
      max_bytes: 26_214_400,
      retention: 'backfill',
      caps: {
        zip_members: BACKFILL_ZIP.members,
        zip_total: BACKFILL_ZIP.total,
        csv_rows: BACKFILL_MAX_ROWS,
        justification: 'Rur 2020-2029: 27 members and 292 MB inflated; Stah 221,283 lines.',
      },
      datasets: datasets.map((d) => ({ ...d, decades })),
      ...over,
    });

  it('plans one unit per dataset and decade: 32 files, each with its range, step and value count', () => {
    const units = p.units(make(), dir) as De8Unit[];
    expect(units).toHaveLength(32);
    expect(units[0]).toEqual({
      series_key: 'Rureinzugsgebiet/1950',
      step_ms: 900_000,
      range: { from: new Date('1950-01-01T00:00:00Z'), to: new Date('1960-01-01T00:00:00Z') },
      values: 350_592,
      dataset: 'Rureinzugsgebiet',
      decade: 1950,
      file: 'Rureinzugsgebiet-NRW-W_1950-1959_EPSG25832_CSV.zip',
    });
    expect(units.at(-1)?.file).toBe('Issel-Berkel-Vechteeinzugsgebiet-NRW-W_2020-2029_EPSG25832_CSV.zip');
    expect(units.at(-1)?.values).toBe(5 * 350_688);
    expect(new Set(units.map((u) => u.series_key)).size).toBe(32);
    // A slice of P30D over 5 stations at PT15M is 14,400 grid points (plan §3.6: at most 15,000).
    expect((5 * 30 * 86_400_000) / 900_000).toBe(14_400);
  });

  it('builds a GET of the whole file under the spec URL, with the unit as the variant and no body', () => {
    const s = make();
    const u = p.units(s, dir)[0] as De8Unit;
    const req = p.chunkRequest(
      {
        ...s,
        host: 'www.opengeodata.nrw.de',
        limits: { min_interval_ms: 30_000, max_per_hour: 20, window_utc: { from: '22:00', to: '05:00' } },
        chunk_ms: 2_592_000_000,
        series: [],
      } as never,
      u as never,
      { from: new Date('1950-01-01T00:00:00Z'), to: new Date('1950-01-31T00:00:00Z') },
      new Date('2026-10-18T22:00:00Z'),
    );
    expect(req).toEqual({
      url: 'https://www.opengeodata.nrw.de/produkte/umwelt_klima/wasser/oberflaechengewaesser/hydro/w/Rureinzugsgebiet-NRW-W_1950-1959_EPSG25832_CSV.zip',
      method: 'GET',
      variant: 'Rureinzugsgebiet/1950',
    });
    expect(req.body).toBeUndefined();
  });

  it('throws when a listed station is not a first_release DE-7 W row, when one is missing, or when one is listed twice', () => {
    // The listing of dataset `at` after `edit` (the other datasets as they are).
    const listing = (at: number, edit: (stations: string[]) => string[]) =>
      make({
        datasets: datasets.map((d, i) => ({ ...d, stations: i === at ? edit([...d.stations]) : d.stations, decades })),
      });
    // Not a first-release gauge (Feudingen is tier 2).
    expect(() =>
      p.units(
        listing(0, (s) => [...s, '2581119000100']),
        dir,
      ),
    ).toThrow(/2581119000100 is not a public primary first_release/);
    // A tier-1 gauge no dataset lists.
    expect(() =>
      p.units(
        listing(3, (s) => s.slice(0, -1)),
        dir,
      ),
    ).toThrow(/9286455000200 is a first_release DE-7 W row no dataset lists/);
    // Listed twice.
    expect(() =>
      p.units(
        listing(2, (s) => [...s, STAH]),
        dir,
      ),
    ).toThrow(/2829100000100 is listed twice/);
  });

  it('refuses a decade file as a whole only: not halvable, reused by every slice, no probe, all statuses 200/204', () => {
    expect([p.halvable, p.reuse, p.checkRequest, p.parseCheck, p.okStatus]).toEqual([
      false,
      true,
      undefined,
      undefined,
      undefined,
    ]);
    expect(p.inspect(new Uint8Array())).toEqual({ ok: true, values: 0 });
    expect(p.dryRun).toEqual({ bytes_per_value: 6.5, zstd_ratio: 1, db_bytes_per_row: 90 });
  });

  it('its validity spec accepts the recorded W files, refuses the Q file, a wrong header and a ZIP with a stranger', async () => {
    for (const name of ['de-8-backfill-w-rur-2020', 'de-8-backfill-w-ibv-1950']) {
      const v = await validate(p.validity, 200, bodyOf(name));
      expect([name, v.ok, v.count]).toEqual([name, true, name.includes('rur') ? 2 : 5]);
    }
    expect((await validate(p.validity, 200, bodyOf('de-8-backfill-q-erft-1930'))).reason).toBe('zip_name');
    const header = await validate(
      p.validity,
      200,
      Buffer.from(zipOf({ [memberName(STAH)]: member(STAH, []).replace('value[cm]', 'value[mm]') })),
    );
    expect([header.ok, header.reason]).toEqual([false, 'header']);
    const stranger = await validate(p.validity, 200, Buffer.from(zipOf({ 'readme.txt': 'x' })));
    expect([stranger.ok, stranger.reason]).toEqual([false, 'zip_name']);
    // The caps the validity spec carries are the loader's.
    expect(p.validity.zip).toMatchObject({ max_members: BACKFILL_ZIP.members, max_total: BACKFILL_ZIP.total });
  });

  it('registry/backfill.yaml, once it has the spec, carries the caps of the loader and a spec that plans', () => {
    const file = new URL('backfill.yaml', dir);
    const doc = parse(readFileSync(file, 'utf8')) as {
      specs: { id: string; caps?: Record<string, number>; max_bytes: number }[];
    };
    const entry = doc.specs.find((s) => s.id === 'de-8-backfill-w');
    if (entry === undefined) return;
    expect(entry.caps).toMatchObject({
      zip_members: BACKFILL_ZIP.members,
      zip_total: BACKFILL_ZIP.total,
      csv_rows: BACKFILL_MAX_ROWS,
    });
    expect(entry.max_bytes).toBe(spec.maxBytes);
    expect(p.units(De8BackfillSpec.parse(entry), dir)).toHaveLength(32);
  });
});
