import type { ClassRow, GaugeZeroRow, WarningRow, Warnings } from '@rws/core';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VIEWS } from '../../src/db/audience.ts';
import { parsedOkIn } from '../../src/load/prune.ts';
import { applyClasses, applyReferences, applyWarnings, closesKey, type ResolvedRef } from '../../src/load/refs.ts';
import { applyGaugeZeros, openBatch, readMeta, seriesOf, type Tx } from '../../src/load/store.ts';
import { type Harness, harness, KAUB_W } from './harness.ts';

// P7a: the validity ranges of references, gauge zeros, classes and warnings (load/refs.ts, store.ts), straight
// against PostgreSQL 18 as rws_load: a change closes a range and opens one, nothing is overwritten by another
// payload, a late payload never inserts behind a newer range, and a replay writes nothing.

let h: Harness;
let kaub: number;
let n = 0;

beforeAll(async () => {
  h = await harness();
  kaub = await h.seriesId(KAUB_W);
}, 120_000);
afterAll(() => h.close());

const tx = <T>(fn: (tx: Tx) => Promise<T>) => h.load.db.transaction().execute(fn);
/** An ok batch of `source` fetched at `at` (its id). */
const batch = (source: string, at: string) =>
  tx(async (t) => {
    n += 1;
    const state = await openBatch(
      t,
      {
        source,
        spec: 'p7a-test',
        key: `raw/${source}/p7a-test/2026/10/03/${String(n).padStart(6, '0')}.zst`,
        sha256: null,
        fetchedAt: new Date(at),
        status: 200,
        bytes: 1,
        adapterVersion: 1,
      },
      'ok',
    );
    return state.id;
  });

const ref = (over: Partial<ResolvedRef> = {}): ResolvedRef => ({
  series: KAUB_W,
  kind: 'MNW',
  value: 65,
  unit: 'cm',
  semantics: 'statistical',
  convention: null,
  period: ['2010-11-01', '2020-10-31'],
  season_from_md: 101,
  season_to_md: 1231,
  priority: 0,
  basis_label: 'Mittel der Niedrigwasserstände',
  valid_from: null,
  id: kaub,
  counted: true,
  ...over,
});

const refsOf = async (kind: string, source = 'DE-1') =>
  (
    await h.t.admin.query<{ value: number; lo: Date | null; hi: Date | null; batch: string }>(
      `SELECT value, lower(valid) AS lo, upper(valid) AS hi, batch_id::text AS batch FROM reference_value
       WHERE series_id = $1 AND source_id = $2 AND kind = $3 ORDER BY lower(valid) NULLS FIRST`,
      [kaub, source, kind],
    )
  ).rows.map((r) => ({ value: r.value, lo: r.lo?.toISOString() ?? null, hi: r.hi?.toISOString() ?? null }));

const apply = async (source: string, at: string, rows: ResolvedRef[], scope: number[] = [kaub]) => {
  const b = await batch(source, at);
  const out = await tx((t) => applyReferences(t, source, rows, new Set(scope), b, new Date(at)));
  return { batch: b, ...out };
};

describe('reference_value validity ranges', () => {
  it('opens a range, confirms it, and a changed value closes it and opens a new one at the fetch', async () => {
    const first = await apply('DE-1', '2026-10-02T04:20:00Z', [ref()]);
    expect(first.changes).toEqual({ new: 1 });
    const again = await apply('DE-1', '2026-10-03T04:20:00Z', [ref()]);
    expect(again.changes).toEqual({});
    const changed = await apply('DE-1', '2026-10-04T04:20:00Z', [ref({ value: 66 })]);
    expect(changed.changes).toEqual({ changed: 1 });
    expect(await refsOf('MNW')).toEqual([
      { value: 65, lo: null, hi: '2026-10-04T04:20:00.000Z' },
      { value: 66, lo: '2026-10-04T04:20:00.000Z', hi: null },
    ]);
    // The opener stays the batch that opened the range; a confirmation moved only seen_*.
    const { rows } = await h.t.admin.query<{ batch: string }>(
      `SELECT batch_id::text AS batch FROM reference_value WHERE series_id = $1 AND kind = 'MNW' ORDER BY lower(valid) NULLS FIRST`,
      [kaub],
    );
    expect(rows.map((r) => r.batch)).toEqual([first.batch, changed.batch]);
  });

  it('a replay of the newest payload and a late older payload write nothing', async () => {
    const before = await refsOf('MNW');
    // A payload fetched between the two (2026-10-03T12:00Z) stating the old value: older than the newest statement.
    const late = await apply('DE-1', '2026-10-03T12:00:00Z', [ref()]);
    expect(late.changes).toEqual({ older_ignored: 1 });
    expect(late.writes).toBe(0);
    expect(await refsOf('MNW')).toEqual(before);
  });

  it('a later provider validity opens the new range at that date', async () => {
    await apply('DE-1', '2026-10-02T04:20:00Z', [ref({ kind: 'HSW', value: 640, valid_from: '1949-12-31T23:00:00Z' })]);
    await apply('DE-1', '2026-10-05T04:20:00Z', [ref({ kind: 'HSW', value: 650, valid_from: '2026-10-01T22:00:00Z' })]);
    expect(await refsOf('HSW')).toEqual([
      { value: 640, lo: '1949-12-31T23:00:00.000Z', hi: '2026-10-01T22:00:00.000Z' },
      { value: 650, lo: '2026-10-01T22:00:00.000Z', hi: null },
    ]);
  });

  it('a kind the payload no longer states is closed for a series in scope, and re-opens when stated again', async () => {
    await apply('DE-1', '2026-10-06T04:20:00Z', [ref({ kind: 'GLW', value: 77 })]);
    const removed = await apply('DE-1', '2026-10-07T04:20:00Z', [ref({ value: 66 })]);
    expect(removed.changes.removed).toBeGreaterThanOrEqual(1);
    expect(await refsOf('GLW')).toEqual([{ value: 77, lo: null, hi: '2026-10-07T04:20:00.000Z' }]);
    // A late payload from before the removal neither re-opens it nor inserts behind it.
    const late = await apply('DE-1', '2026-10-06T12:00:00Z', [ref({ kind: 'GLW', value: 77 })]);
    expect(late.writes).toBe(0);
    await apply('DE-1', '2026-10-08T04:20:00Z', [ref({ kind: 'GLW', value: 77 })]);
    expect(await refsOf('GLW')).toEqual([
      { value: 77, lo: null, hi: '2026-10-07T04:20:00.000Z' },
      { value: 77, lo: '2026-10-08T04:20:00.000Z', hi: null },
    ]);
  });

  it('two payloads fetched in the same instant: the greater batch wins in place, no empty range', async () => {
    await apply('DE-1', '2026-10-09T04:20:00Z', [ref({ kind: 'MW', value: 208 })]);
    await apply('DE-1', '2026-10-10T04:20:00Z', [ref({ kind: 'MW', value: 209 })]);
    await apply('DE-1', '2026-10-10T04:20:00Z', [ref({ kind: 'MW', value: 210 })]);
    expect(await refsOf('MW')).toEqual([
      { value: 208, lo: null, hi: '2026-10-10T04:20:00.000Z' },
      { value: 210, lo: '2026-10-10T04:20:00.000Z', hi: null },
    ]);
  });

  it('owner-audience references (source LU-4) on a public series reach the owner views only', async () => {
    await apply('LU-4', '2026-10-02T03:40:00Z', [ref({ kind: 'LU4_ORANGE', value: 341, semantics: 'operational' })]);
    const as = async (role: 'rws_api' | 'rws_owner_api', view: string) => {
      const db = h.dbAs(role, 1);
      try {
        const { rows } = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM ${sql.table(view)} WHERE source_id = 'LU-4'`.execute(db.db);
        return rows[0]?.n;
      } finally {
        await db.close();
      }
    };
    expect(await as('rws_api', VIEWS.public.reference)).toBe(0);
    // Kaub is a public DE-1 series, so the owner family shows the owner source's row on it.
    expect(await as('rws_owner_api', VIEWS.owner.reference)).toBe(1);
  });
});

describe('gauge_zero history (P7a, R-072): nothing is overwritten by another payload', () => {
  const zero = (over: Partial<GaugeZeroRow> = {}): GaugeZeroRow => ({
    series: KAUB_W,
    value_m: 67.669,
    datum: 'NHN',
    valid_from: '2019-10-31T23:00:00.000Z',
    ...over,
  });
  const zerosOf = async () =>
    (
      await h.t.admin.query<{ value_m: number; lo: Date | null; hi: Date | null }>(
        'SELECT value_m, lower(valid) AS lo, upper(valid) AS hi FROM gauge_zero WHERE series_id = $1 ORDER BY lower(valid) NULLS FIRST',
        [kaub],
      )
    ).rows.map((r) => [r.value_m, r.lo?.toISOString() ?? null, r.hi?.toISOString() ?? null]);
  const applyZero = async (at: string, z: GaugeZeroRow) => {
    const b = await batch('DE-1', at);
    const ids = await seriesOf(h.load.db, 'DE-1');
    return tx((t) => applyGaugeZeros(t, [z], ids, b, new Date(at)));
  };

  it('a newer payload with another value for the same validity closes at its fetch and opens a new range', async () => {
    expect(await applyZero('2026-10-02T04:20:00Z', zero())).toEqual({ new: 1 });
    expect(await applyZero('2026-10-03T04:20:00Z', zero())).toEqual({});
    expect(await applyZero('2026-10-04T04:20:00Z', zero({ value_m: 67.7 }))).toEqual({ changed: 1 });
    expect(await zerosOf()).toEqual([
      [67.669, '2019-10-31T23:00:00.000Z', '2026-10-04T04:20:00.000Z'],
      [67.7, '2026-10-04T04:20:00.000Z', null],
    ]);
    // The same statement again confirms; an older payload with the old value leaves it alone.
    expect(await applyZero('2026-10-05T04:20:00Z', zero({ value_m: 67.7 }))).toEqual({});
    expect(await applyZero('2026-10-03T12:00:00Z', zero())).toEqual({});
    expect((await zerosOf()).length).toBe(2);
  });
});

describe('class_obs on change', () => {
  const cls = (over: Partial<ClassRow> = {}): ClassRow => ({
    station: 'de.wsv.25700100',
    ts: '2026-10-02T10:00:00.000Z',
    code: 'RP:0',
    label: 'Kein Hochwasser',
    level: 2,
    ...over,
  });
  const station = async () => {
    const { rows } = await h.t.admin.query<{ id: string }>(
      'SELECT station_id AS id FROM series WHERE provider_key = $1',
      [KAUB_W],
    );
    return rows[0]?.id as string;
  };

  it('stores a class once, then only its changes; a replay writes nothing; an unknown station is counted', async () => {
    const id = await station();
    const b1 = await batch('DE-6', '2026-10-02T10:08:00Z');
    expect(await tx((t) => applyClasses(t, 'DE-6', [cls({ station: id })], b1))).toMatchObject({ new: 1, writes: 1 });
    const b2 = await batch('DE-6', '2026-10-02T10:18:00Z');
    const same = cls({ station: id, ts: '2026-10-02T10:15:00.000Z' });
    expect(await tx((t) => applyClasses(t, 'DE-6', [same], b2))).toMatchObject({ writes: 0 });
    const b3 = await batch('DE-6', '2026-10-02T10:28:00Z');
    const up = cls({ station: id, ts: '2026-10-02T10:25:00.000Z', code: 'RP:1', level: 3 });
    expect(await tx((t) => applyClasses(t, 'DE-6', [up], b3))).toMatchObject({ changed: 1, writes: 1 });
    expect(await tx((t) => applyClasses(t, 'DE-6', [up], b3))).toMatchObject({ writes: 0 });
    expect(await tx((t) => applyClasses(t, 'DE-6', [cls({ station: 'de.wsv.nowhere' })], b3))).toMatchObject({
      unknown: 1,
      writes: 0,
    });
    expect(await h.count('class_obs')).toBe(2);
  });
});

describe('warning_area', () => {
  const area = (over: Partial<WarningRow> = {}): WarningRow => ({
    area_key: 'LO18',
    name: 'Meuse frontalière - Semoy',
    geometry: null,
    level: 2,
    level_raw: '1',
    label_raw: null,
    valid_from: '2026-10-02T08:00:00.000Z',
    valid_to: null,
    issued_at: null,
    ...over,
  });
  const areasOf = async (source: string, key: string) =>
    (
      await h.t.admin.query<{ level_raw: string; lo: Date; hi: Date | null }>(
        'SELECT level_raw, lower(valid) AS lo, upper(valid) AS hi FROM warning_area WHERE source_id = $1 AND area_key = $2 ORDER BY lower(valid)',
        [source, key],
      )
    ).rows.map((r) => [r.level_raw, r.lo.toISOString(), r.hi?.toISOString() ?? null]);
  const warn = async (source: string, fetched: string, w: Warnings) => {
    const b = await batch(source, fetched);
    return tx((t) => applyWarnings(t, source, w, b, new Date(fetched)));
  };
  const snap = (at: string, rows: WarningRow[]): Warnings => ({ mode: 'snapshot', at, rows });

  it('snapshot: confirms, closes and opens on a level change, closes an area no longer listed, ignores a late one', async () => {
    const at1 = '2026-10-02T08:00:00.000Z';
    expect((await warn('FR-5', '2026-10-02T08:02:00Z', snap(at1, [area()]))).changes).toEqual({ new: 1 });
    expect((await warn('FR-5', '2026-10-02T08:17:00Z', snap(at1, [area()]))).writes).toBe(1);
    const at2 = '2026-10-02T12:00:00.000Z';
    const up = area({ valid_from: at2, level: 3, level_raw: '2' });
    expect((await warn('FR-5', '2026-10-02T12:02:00Z', snap(at2, [up]))).changes).toEqual({ changed: 1 });
    // A late payload fetched before the change: ignored.
    expect((await warn('FR-5', '2026-10-02T10:02:00Z', snap(at1, [area()]))).changes).toEqual({ older_ignored: 1 });
    const at3 = '2026-10-03T08:00:00.000Z';
    expect((await warn('FR-5', '2026-10-03T08:02:00Z', snap(at3, []))).changes).toEqual({ removed: 1 });
    expect(await areasOf('FR-5', 'LO18')).toEqual([
      ['1', at1, at2],
      ['2', at2, at3],
    ]);
  });

  it('message: an Update loaded before its Alert caps it, a Cancel loaded first closes it, a replay adds nothing', async () => {
    const msg = (sent: string, rows: WarningRow[], cancels: string[] = []): Warnings => ({
      mode: 'message',
      sent,
      rows,
      cancels,
    });
    const sud = (sent: string, level_raw: string, ref: string, expires: string) =>
      area({ area_key: 'Sud du Luxembourg', valid_from: sent, valid_to: expires, level_raw, ref, issued_at: sent });
    // Newest first, as the seed loads them: a Cancel of the red alert, the red alert, the yellow alert before it.
    await warn('LU-5', '2026-09-30T14:06:00Z', msg('2025-09-09T06:04:50.000Z', [], ['LU-Alert.red']));
    await warn(
      'LU-5',
      '2026-09-30T14:06:01Z',
      msg('2025-09-08T21:15:02.000Z', [
        sud('2025-09-08T21:15:02.000Z', 'ALERT_LVL_1', 'LU-Alert.red', '2025-09-10T21:15:02.000Z'),
      ]),
    );
    await warn(
      'LU-5',
      '2026-09-30T14:06:02Z',
      msg('2025-09-08T10:52:33.000Z', [
        sud('2025-09-08T10:52:33.000Z', 'ALERT_LVL_3', 'LU-Alert.yellow', '2025-09-09T10:52:33.000Z'),
      ]),
    );
    expect(await areasOf('LU-5', 'Sud du Luxembourg')).toEqual([
      ['ALERT_LVL_3', '2025-09-08T10:52:33.000Z', '2025-09-08T21:15:02.000Z'],
      ['ALERT_LVL_1', '2025-09-08T21:15:02.000Z', '2025-09-09T06:04:50.000Z'],
    ]);
    expect(await readMeta(h.load.db, closesKey('LU-5'))).toEqual({ 'LU-Alert.red': '2025-09-09T06:04:50.000Z' });
    const replay = await warn(
      'LU-5',
      '2026-09-30T14:06:01Z',
      msg('2025-09-08T21:15:02.000Z', [
        sud('2025-09-08T21:15:02.000Z', 'ALERT_LVL_1', 'LU-Alert.red', '2025-09-10T21:15:02.000Z'),
      ]),
    );
    expect(replay.writes).toBe(0);
  });
});

describe('the forever promotion of a payload that opened a class or a reference (A§7.2)', () => {
  it('parsedOkIn leaves out an archived payload whose batch opened a class_obs row or a reference range', async () => {
    const { rows } = await h.t.admin.query<{ key: string; opener: boolean }>(
      `SELECT b.archive_key AS key,
              EXISTS (SELECT 1 FROM class_obs c WHERE c.batch_id = b.id)
              OR EXISTS (SELECT 1 FROM reference_value r WHERE r.batch_id = b.id) AS opener
       FROM ingest_batch b WHERE b.spec_id = 'p7a-test'`,
    );
    const ok = await parsedOkIn(h.load.db)(rows.map((r) => r.key));
    expect(rows.some((r) => r.opener)).toBe(true);
    expect(rows.some((r) => !r.opener)).toBe(true);
    for (const r of rows) expect([r.key, ok.has(r.key)]).toEqual([r.key, !r.opener]);
  });
});
