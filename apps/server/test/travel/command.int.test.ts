import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type TravelEmpirical, validateTravelEmpirical } from '@rws/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { REGISTRY_DIR } from '../../src/capture/specs.ts';
import { travelTimesMain } from '../../src/travel/cli.ts';
import { comparePairs } from '../../src/travel/format.ts';
import { type Harness, harness } from '../load/harness.ts';

// P14f: `main.js travel-times` against a real database as the real rws_publish login. Synthetic hourly observations
// (a random walk per station, the downstream series the upstream one delayed by a known lag) on public NL-1 stations
// whose ids the registry gives; the reaches are written to a throw-away rivernet.yaml. The output holds the public
// pairs with their lags and nothing else: not the reach with an owner station, not a tidal or impounded one, not a
// series whose values are all suspect.

const NOW = new Date('2026-10-18T10:00:00Z');
const START = Date.UTC(2026, 0, 1);
const HOURS = 282 * 24; // 1 January to 9 October: 42 windows of the configured 336 hours
const OWNER_STATION = 'be.spw.1046';

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const walk = (n: number, rand: () => number): number[] => {
  let x = 300;
  return Array.from({ length: n }, () => (x += rand() + rand() + rand() - 1.5));
};
/** `x` seen `lag` hours later, plus a little noise. */
const after = (x: readonly number[], lag: number, rand: () => number): number[] =>
  x.map((_, i) => (x[Math.max(0, i - lag)] as number) + (rand() - 0.5) * 0.1);

let h: Harness;
let dir: string;
let ids: { hq: string[]; ho: string[] };
const log: string[] = [];

const rivernet = (
  reaches: { id: string; up: string | null; down: string | null; tidal?: boolean; impounded?: boolean }[],
) =>
  JSON.stringify({
    version: 1,
    fixture: {
      source_run: 'https://github.com/mwijkhuisen/Waterheight/actions/runs/1',
      ways_sha256: '0'.repeat(64),
      osm_replication_timestamp: '2026-10-01T00:00:00Z',
    },
    stations: [...new Set(reaches.flatMap((r) => [r.up, r.down]).filter((s): s is string => s !== null))].map((id) => ({
      id,
      rule: 'name',
      river: 'alpha',
      reach: null,
      km_official: null,
      km_official_system: null,
      km_graph: null,
      km_to_nl_entry: null,
      nl_entry_node: null,
    })),
    reaches: reaches.map((r) => {
      const [river, seq] = r.id.split('.') as [string, string];
      return {
        id: r.id,
        river,
        seq: Number(seq),
        up_station: r.up,
        down_station: r.down,
        length_km: 30,
        flags: { tidal: r.tidal ?? false, impounded: r.impounded ?? false, bifurcation: false },
        travel_time_h: null,
        travel_time_source: null,
      };
    }),
  });

async function seed(seriesId: number, values: readonly number[], qc = 1) {
  await h.t.admin.query(
    `INSERT INTO obs (series_id, ts, value, qc, batch_id)
     SELECT $1, to_timestamp($2::float8 + (u.i - 1) * 3600), u.v, $4, 1 FROM unnest($3::real[]) WITH ORDINALITY AS u(v, i)`,
    [seriesId, START / 1000, values, qc],
  );
}

/** The series id of a station's primary series of a quantity. */
async function seriesOf(station: string, quantity: 'H' | 'Q'): Promise<number> {
  const { rows } = await h.t.admin.query<{ id: number }>(
    `SELECT id FROM series WHERE station_id = $1 AND quantity = $2 AND role = 'primary' ORDER BY id`,
    [station, quantity],
  );
  if (rows[0] === undefined) throw new Error(`no ${quantity} series at ${station}`);
  return rows[0].id;
}

const env = () => ({ DATABASE_URL: h.t.urlFor('rws_publish') });
const run = async (argv: string[] = ['--from', '2026']) => {
  const out: string[] = [];
  log.length = 0;
  const code = await travelTimesMain(
    argv,
    env(),
    (l) => log.push(l),
    (t) => out.push(t),
    { now: () => NOW, registry: pathToFileURL(`${dir}/`) },
  );
  return { code, text: out.join('') };
};

beforeAll(async () => {
  h = await harness();
  await h.t.admin.query(`SELECT ensure_partitions('2026-01-01'::timestamptz, '2026-11-01'::timestamptz)`);
  // Public NL-1 stations with a discharge series as well (hq) and with a stage only (ho).
  const { rows } = await h.t.admin.query<{ station_id: string; q: boolean; hh: boolean }>(
    `SELECT s.station_id, bool_or(s.quantity = 'Q') AS q, bool_or(s.quantity = 'H') AS hh
     FROM series s JOIN series_eff e ON e.series_id = s.id
     WHERE s.source_id = 'NL-1' AND e.audience = 'public' AND e.role = 'primary' AND e.lic_display AND s.active
       AND s.station_id NOT LIKE 'nl.canary.%'
     GROUP BY 1 ORDER BY 1`,
  );
  ids = {
    hq: rows.filter((r) => r.q && r.hh).map((r) => r.station_id),
    ho: rows.filter((r) => r.hh && !r.q).map((r) => r.station_id),
  };
  const [a, b] = ids.hq as [string, string];
  const [d, e, f, g] = ids.ho as [string, string, string, string];
  const rand = prng(2026);

  // A -> B discharge, lag 13; B -> D stage, lag 9 (D has no discharge series); D -> E stage, lag 6.
  const aH = walk(HOURS, rand);
  const aQ = walk(HOURS, rand);
  const bH = after(aH, 13, rand);
  const dH = after(bH, 9, rand);
  const eH = after(dH, 6, rand);
  await seed(await seriesOf(a, 'H'), aH);
  await seed(await seriesOf(a, 'Q'), aQ);
  await seed(await seriesOf(b, 'Q'), after(aQ, 13, rand));
  await seed(await seriesOf(b, 'H'), bH);
  await seed(await seriesOf(d, 'H'), dH);
  await seed(await seriesOf(e, 'H'), eH);
  // F -> G: G follows F at lag 11, but every G value carries the provider-suspect bit (4), so G has no usable hour.
  const fH = walk(HOURS, rand);
  await seed(await seriesOf(f, 'H'), fH);
  await seed(await seriesOf(g, 'H'), after(fH, 11, rand), 4);
  // An owner-audience series that follows A's stage at lag 11: a public reach to it must find nothing.
  await seed(await seriesOf(OWNER_STATION, 'H'), after(aH, 11, rand));

  dir = mkdtempSync(join(tmpdir(), 'travel-'));
  mkdirSync(dir, { recursive: true });
  copyFileSync(new URL('rivers.yaml', REGISTRY_DIR), join(dir, 'rivers.yaml'));
  writeFileSync(
    join(dir, 'rivernet.yaml'),
    rivernet([
      { id: 'alpha.1', up: a, down: b },
      { id: 'alpha.2', up: b, down: d },
      { id: 'alpha.3', up: d, down: e },
      { id: 'beta.1', up: b, down: e, tidal: true }, // E follows B, but the reach is tidal
      { id: 'beta.2', up: a, down: d, impounded: true }, // D follows A, but the reach is impounded
      { id: 'gamma.1', up: a, down: OWNER_STATION }, // the downstream end is an owner station
      { id: 'delta.1', up: f, down: g }, // every value of G is suspect
      { id: 'delta.2', up: null, down: g },
    ]),
  );
}, 180_000);
afterAll(async () => {
  await h?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('travel-times against a database, as rws_publish', { timeout: 120_000 }, () => {
  it('finds the lags of the public pairs, and nothing from an owner, tidal, impounded or suspect series', async () => {
    const [a, b] = ids.hq as [string, string];
    const [d, e] = ids.ho as [string, string];
    const before = (await h.t.admin.query('SELECT count(*)::int AS n FROM obs')).rows[0]?.n;
    const { code, text } = await run();
    expect(code).toBe(0);
    const file = validateTravelEmpirical(parse(text)) as { problems: string[]; empirical?: TravelEmpirical };
    expect(file.problems).toEqual([]);
    const pairs = file.empirical?.pairs ?? [];
    expect(file.empirical?.generated).toBe('2026-10-18T10:00:00Z');
    const want = [
      { from_station: a, to_station: b, quantity: 'Q' },
      { from_station: b, to_station: d, quantity: 'H' },
      { from_station: d, to_station: e, quantity: 'H' },
    ].sort(comparePairs);
    expect(
      pairs.map((p) => ({ from_station: p.from_station, to_station: p.to_station, quantity: p.quantity })),
    ).toEqual(want);
    const lag = new Map(pairs.map((p) => [p.to_station, p]));
    for (const [to, want] of [
      [b, 13],
      [d, 9],
      [e, 6],
    ] as const) {
      const p = lag.get(to);
      expect(p?.h[0], to).toBeGreaterThanOrEqual(want - 1);
      expect(p?.h[1], to).toBeLessThanOrEqual(want + 1);
      expect(p?.years).toEqual([2026, 2026]);
      expect(p?.windows).toBeGreaterThanOrEqual(18);
    }
    expect(text).not.toContain(OWNER_STATION);
    expect(text).not.toContain('be.spw');
    // counts only on the log: reaches 8, eligible 5 (gamma, delta.1, alpha x3; beta x2 and the open-ended one are out)
    expect(log).toHaveLength(1);
    expect(log[0]).toMatch(
      /reaches 8, eligible 5, without public series 1, without a common quantity 0, queries \d+, years 2026-2026, pairs 3$/,
    );
    // read-only: no row written
    expect((await h.t.admin.query('SELECT count(*)::int AS n FROM obs')).rows[0]?.n).toBe(before);
  });

  it('writes the same bytes twice', async () => {
    expect((await run()).text).toBe((await run()).text);
  });

  it('exits 64 on a bad argument and 78 without database settings', async () => {
    for (const argv of [
      ['--from'],
      ['--from', '99'],
      ['--to', '2026', '--to', '2026'],
      ['--x', '1'],
      ['--from', '2030'],
      ['--from', '2026', '--to', '2025'],
      ['2026'],
    ])
      expect((await run(argv)).code, argv.join(' ')).toBe(64);
    expect(
      await travelTimesMain(
        [],
        {},
        () => {},
        () => {},
        { now: () => NOW, registry: pathToFileURL(`${dir}/`) },
      ),
    ).toBe(78);
  });
});
