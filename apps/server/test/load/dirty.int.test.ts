import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { floorBucket, SnapshotFile } from '@rws/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StaticCache } from '../../src/api/states.ts';
import { DisplayWindow } from '../../src/api/window.ts';
import { VIEWS } from '../../src/db/audience.ts';
import { publishTail } from '../../src/load/migrate.ts';
import { vigicruesSections } from '../../src/load/tables.ts';
import { Publisher } from '../../src/publish/cycle.ts';
import { dirtyBuckets } from '../../src/publish/plan.ts';
import { RENDERERS } from '../../src/publish/render/index.ts';
import { Output } from '../../src/publish/write.ts';
import { loadLobith } from '../publish/nl1.ts';
import { type Harness, harness } from './harness.ts';

// P9a (plan §4.3, §4.10): what the loader's dirty rows reach, with the real loader and a long-lived publisher.
// A revision at ts dirties up to ts + staleness (across midnight, so a recent file of the next day changes); an
// owner-only change writes no public row and no public bump, an `off` one nothing; a registry change that only adds
// a series bumps nothing in migrate's tail.

const NOW = Date.parse('2026-10-04T12:00:00Z');
const TS0 = Date.parse('2026-10-03T23:50:00Z');
const OLD = Date.parse('2026-09-29T12:00:00Z');
const MIN = 60_000;
let h: Harness;
let series: number;
let station: string;
let stalenessMs: number;
let dir: string;

const q = <R extends object = Record<string, unknown>>(text: string, values: unknown[] = []) =>
  h.t.admin.query<R>(text, values);
const maxId = async () =>
  Number((await q<{ n: string }>('SELECT COALESCE(max(id), 0)::text AS n FROM publish_dirty')).rows[0]?.n);
const rowsAfter = async (id: number) =>
  (await q('SELECT family, kind, from_ts, to_ts, stations FROM publish_dirty WHERE id > $1 ORDER BY id', [id])).rows;
const versions = async (family: string) =>
  (await q<{ value: unknown }>('SELECT value FROM app_meta WHERE key = $1', [`day_versions:${family}`])).rows[0]
    ?.value as Record<string, { v: number; reason: string }> | undefined;
const ISO = (ms: number) => new Date(ms).toISOString();

beforeAll(async () => {
  h = await harness();
  await q(`UPDATE app_meta SET value = '"2026-10-03T00:00:00Z"' WHERE key = 'display_start'`);
  await q(`SELECT ensure_partitions('2026-09-01'::timestamptz, '2026-10-06'::timestamptz)`);
  dir = mkdtempSync(join(tmpdir(), 'rws-dirty-'));
}, 120_000);
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await h.close();
});

describe('dirty completeness', { timeout: 300_000 }, () => {
  it('a revision dirties [ts, ts + staleness] across midnight, and the next day’s recent file changes', async () => {
    await loadLobith(h, [[TS0, 100]], new Date(NOW - 3 * 3_600_000), new Date(NOW));
    series = (await q<{ series_id: number }>('SELECT DISTINCT series_id FROM obs')).rows[0]?.series_id as number;
    const s = (
      await q<{ station_id: string; ms: number }>(
        `SELECT station_id, (EXTRACT(EPOCH FROM staleness_limit) * 1000)::bigint::float8 AS ms FROM series WHERE id = $1`,
        [series],
      )
    ).rows[0];
    station = s?.station_id as string;
    stalenessMs = s?.ms as number;
    expect(stalenessMs).toBeGreaterThanOrEqual(20 * MIN);
    // The last bucket that still holds the value: ts > t − staleness, so the bucket at ts + staleness has expired.
    const probe = Math.ceil((TS0 + stalenessMs) / (10 * MIN)) * 10 * MIN - 10 * MIN;
    expect(probe).toBeGreaterThan(Date.parse('2026-10-04T00:00:00Z')); // the dirtied range crosses midnight

    // The long-lived publisher: its first cycle renders everything, the second only what the dirty rows reach.
    let clock = NOW;
    const pub = h.dbAs('rws_publish', 3);
    const publisher = new Publisher({
      db: pub.db,
      family: 'public',
      out: new Output(dir),
      render: RENDERERS,
      window: new DisplayWindow(pub.db, undefined, 'public'),
      now: () => clock,
      build: 'dev',
      sections: vigicruesSections(),
      cache: new StaticCache(60_000, () => clock),
      inputs: undefined,
      log: { error: () => undefined },
      budgetMs: Number.POSITIVE_INFINITY,
      settledPerCycle: 0,
      strict: true,
    });
    await publisher.cycle();
    const read = (t: number) =>
      SnapshotFile.parse(
        JSON.parse(
          readFileSync(
            join(dir, 'v1/recent', ISO(t).slice(0, 10), `${ISO(t).slice(11, 16).replace(':', '')}.json`),
            'utf8',
          ),
        ),
      );
    const valueAt = (t: number) => {
      const f = read(t);
      const i = f.series.indexOf(series);
      return i < 0 ? null : f.value[i];
    };
    const T_BEFORE_MIDNIGHT = floorBucket(TS0);
    const T_AFTER = probe + 10 * MIN;
    expect(valueAt(T_BEFORE_MIDNIGHT)).toBe(100);
    expect(valueAt(probe)).toBe(100);
    expect(valueAt(T_AFTER)).toBeNull(); // stale by now

    const before = await maxId();
    await loadLobith(h, [[TS0, 101]], new Date(NOW - 2 * 3_600_000), new Date(NOW));
    const rows = await rowsAfter(before);
    expect(rows.map((r) => [r.family, r.kind])).toEqual([
      ['public', 'obs'],
      ['owner', 'obs'],
    ]);
    for (const r of rows) {
      expect(r.from_ts).toEqual(new Date(TS0));
      expect(r.to_ts).toEqual(new Date(TS0 + stalenessMs));
      expect(r.stations).toEqual([station]);
    }
    // What the publisher reads: its family's rows only, expanded to the buckets of the range.
    const seen = (
      await sql<{ id: string; kind: string; from_ts: Date; to_ts: Date; stations: string[] }>`
        SELECT id::text AS id, kind, from_ts, to_ts, stations FROM ${sql.table(VIEWS.public.dirty)}
        WHERE id > ${before}::bigint`.execute(pub.db)
    ).rows;
    expect(seen).toHaveLength(1);
    const buckets = dirtyBuckets(seen, NOW);
    expect(buckets.has(T_BEFORE_MIDNIGHT)).toBe(true);
    expect(buckets.has(probe)).toBe(true);
    expect(buckets.has(T_AFTER + 10 * MIN)).toBe(false); // the bucket at ts + staleness itself is over-dirtied, harmlessly
    expect(buckets.has(T_BEFORE_MIDNIGHT - 10 * MIN)).toBe(false);

    clock = NOW + MIN;
    await publisher.cycle();
    expect(valueAt(T_BEFORE_MIDNIGHT)).toBe(101);
    expect(valueAt(probe)).toBe(101); // the file after midnight changed
    expect(valueAt(T_AFTER)).toBeNull();
    // No bump: the day is not older than 48 h.
    expect(await versions('public')).toBeUndefined();
  });

  it('an owner-only change writes no public row and no public bump; an off one writes nothing', async () => {
    await q('UPDATE series SET audience = $2::audience WHERE id = $1', [series, 'owner']);
    const before = await maxId();
    const pubVersions = await versions('public');
    await loadLobith(h, [[OLD, 7]], new Date(NOW - 3600_000), new Date(NOW)); // a day older than 48 h
    const rows = await rowsAfter(before);
    expect(rows.map((r) => [r.family, r.kind])).toEqual([['owner', 'obs']]);
    expect(await versions('public')).toEqual(pubVersions);
    expect(Object.keys((await versions('owner')) ?? {})).toContain('2026-09-29');
    expect((await versions('owner'))?.['2026-09-29']).toMatchObject({ v: 2, reason: 'revision' });

    await q('UPDATE series SET audience = $2::audience WHERE id = $1', [series, 'off']);
    const mark = await maxId();
    const ownerBefore = await versions('owner');
    await loadLobith(h, [[OLD + 10 * MIN, 8]], new Date(NOW - 1800_000), new Date(NOW));
    expect(await rowsAfter(mark)).toEqual([]);
    expect(await versions('owner')).toEqual(ownerBefore);
    expect(await versions('public')).toEqual(pubVersions);
    await q('UPDATE series SET audience = NULL WHERE id = $1', [series]);
  });

  it('a public change older than 48 h dirties and bumps both families', async () => {
    const before = await maxId();
    await loadLobith(h, [[OLD + 20 * MIN, 9]], new Date(NOW - 1200_000), new Date(NOW));
    expect((await rowsAfter(before)).map((r) => r.family)).toEqual(['public', 'owner']);
    expect((await versions('public'))?.['2026-09-29']).toMatchObject({ v: 2, reason: 'revision' });
    expect((await versions('owner'))?.['2026-09-29']).toMatchObject({ v: 3, reason: 'revision' });
  });
});

describe('registry bumps in the migrate tail (§9 C10)', { timeout: 120_000 }, () => {
  it('a registry change that only adds series bumps nothing, public or owner', async () => {
    const migrator = h.dbAs('rws_migrator', 1);
    const now = new Date(NOW);
    expect((await publishTail(migrator.db, now)).bumped).toEqual({});
    const before = { pub: await versions('public'), own: await versions('owner') };
    for (const [key, audience] of [
      ['p9a-added-public', null],
      ['p9a-added-owner', 'owner'],
    ] as const)
      await q(
        `INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                             native_step, expected_step, staleness_limit, role, audience)
         VALUES ($1, 'NL-1', 'H', 'stage', $2, 'cm', 1, 'LOCAL', '15 min', '15 min', '45 min', 'primary', $3::audience)`,
        [station, key, audience],
      );
    expect(await publishTail(migrator.db, now)).toMatchObject({ bumped: {} });
    expect({ pub: await versions('public'), own: await versions('owner') }).toEqual(before);
    // The added series is in the stored map now: removing the owner-only one narrows the owner family alone.
    await q(`DELETE FROM series WHERE provider_key = 'p9a-added-owner'`);
    expect((await publishTail(migrator.db, now)).bumped).toEqual({ owner: 'narrowed' });
  });
});
