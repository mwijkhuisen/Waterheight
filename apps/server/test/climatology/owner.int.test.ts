import { CANARIES, CANARY_RENDERINGS, FramesAnswer, SnapshotAnswer } from '@rws/contracts';
import { OwnerFramesAnswer, OwnerSnapshotAnswer } from '@rws/contracts/api-owner';
import { OwnerStatusFile, StatusFile } from '@rws/contracts/status';
import { sql } from 'kysely';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DisplayWindow } from '../../src/api/window.ts';
import { createApp } from '../../src/app.ts';
import { climatologyMain } from '../../src/climatology/cli.ts';
import { VIEWS } from '../../src/db/audience.ts';
import type { Db } from '../../src/db/pool.ts';
import type { PublisherStatus } from '../../src/publish/cycle.ts';
import { renderStation } from '../../src/publish/render/series.ts';
import { status } from '../../src/publish/render/status.ts';
import { ask } from '../api/sweep.ts';
import { rollupInsertSql } from '../e2e/seed.ts';
import { type Harness, harness } from '../load/harness.ts';
import { ctxFor } from '../publish/s2-ctx.ts';
import { seedHourly } from './seed.ts';

// P14f, the owner criterion of issue #29 ("the owner-canary fixture never appears in public output", and the owner
// outputs show it): ten synthetic years around the owner canary's value on an owner-audience BE-3 discharge series give
// day-of-year rows under source BE-3. They exist in the owner family only: the owner reference view, the owner
// /snapshot basis, /frames and the owner coverage show them; the public reference view, /snapshot, /frames, recent.json,
// status.json and /api/v1/health/sources show none of them and hold no canary rendering. A public series computed in the
// same run keeps its rows in both families. The command runs as the real rws_migrator login and the readers as the
// real rws_api, rws_publish and rws_owner_api logins. Every value is synthetic (invariants 9 and 11).

const H = 3_600_000;
const RUN = new Date('2026-10-25T00:00:00Z');
const NOW = new Date('2026-10-26T12:00:00Z');
const T_NOW = NOW.getTime();
const TEN_YEARS = { from: '2010-01-01T00:00:00Z', to: '2020-01-01T00:00:00Z' };
const P: PublisherStatus = {
  cycleAt: NOW.toISOString(),
  cycleSeconds: 3,
  lastDayRender: null,
  pendingDays: 0,
  settledBytes: 0,
};
const ISO = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

let h: Harness;
let publicDb: Db;
let publishDb: Db;
let ownerDb: Db;
let publicApp: ReturnType<typeof createApp>;
let ownerApp: ReturnType<typeof createApp>;
let pub: number;
let own: number;
let pubStation: string;
let ownStation: string;
const q = async <R extends pg.QueryResultRow = Record<string, unknown>>(text: string, args: unknown[] = []) =>
  (await h.t.admin.query<R>(text, args)).rows;

/** Strings no public body may hold: the canary renderings and the synthetic owner values. */
const NEEDLES = [...CANARY_RENDERINGS, CANARIES.owner.text, 'CANARY-OWNER', 'BE-3'];

async function pickOwned(): Promise<{ id: number; station: string }> {
  const rows = await q<{ id: number; station_id: string }>(
    `SELECT s.id, s.station_id FROM series s JOIN series_eff e ON e.series_id = s.id JOIN station st ON st.id = s.station_id
     WHERE s.source_id = 'BE-3' AND s.quantity = 'Q' AND e.audience = 'owner' AND e.role = 'primary'
       AND e.lic_history_export AND s.active
     ORDER BY st.tier, s.id LIMIT 1`,
  );
  const r = rows[0];
  if (r === undefined) throw new Error('no BE-3 discharge series');
  return { id: r.id, station: r.station_id };
}

beforeAll(async () => {
  h = await harness();
  const a = h.t.admin;
  await a.query(`SELECT ensure_history_partitions('2009-01-01', '2021-01-01')`);
  await a.query(`SELECT ensure_partitions('2026-09-01', '2026-11-01')`);
  await a.query(`UPDATE app_meta SET value = to_jsonb('2026-10-01T00:00:00Z'::text) WHERE key = 'display_start'`);
  const owned = await pickOwned();
  own = owned.id;
  ownStation = owned.station;
  // A Meuse reach is impounded in the registry; this test is about the audience, so the station is made eligible.
  await a.query(`UPDATE station SET flags = COALESCE(flags, '{}'::jsonb) - 'impounded' - 'tidal' WHERE id = $1`, [
    ownStation,
  ]);
  const open = await q<{ id: number; station_id: string }>(
    `SELECT s.id, s.station_id FROM series s JOIN series_eff e ON e.series_id = s.id JOIN station st ON st.id = s.station_id
     WHERE s.source_id = 'NL-1' AND s.quantity = 'Q' AND e.audience = 'public' AND e.role = 'primary'
       AND e.lic_history_export AND s.active AND st.id NOT LIKE 'nl.canary.%'
       AND COALESCE((st.flags->>'tidal')::boolean, false) = false
       AND COALESCE((st.flags->>'impounded')::boolean, false) = false
     ORDER BY st.tier, s.id LIMIT 1`,
  );
  pub = (open[0] as { id: number }).id;
  pubStation = (open[0] as { station_id: string }).station_id;

  // Ten years around the canary value with a jitter (P10 < P90), and the canary itself as the current value.
  await seedHourly(a, own, TEN_YEARS, { base: CANARIES.owner.value, amp: 40 });
  await seedHourly(a, pub, TEN_YEARS, { base: 100, amp: 40 });
  for (const [series, value] of [
    [own, CANARIES.owner.value],
    [pub, 400],
  ] as const) {
    await a.query(
      `INSERT INTO obs (series_id, ts, value, qc, batch_id) VALUES ($1, '2026-10-26T11:50:00Z', $2, 1, 1)`,
      [series, value],
    );
  }
  await a.query(rollupInsertSql('obs_1h', { from: '2026-10-26T00:00:00Z', to: '2026-10-26T13:00:00Z' }));

  // The real command, both families, as rws_migrator (the whole registry, no --series).
  const log: string[] = [];
  const code = await climatologyMain([], { DATABASE_URL: h.t.urlFor('rws_migrator') }, (l) => log.push(l), {
    now: () => RUN,
  });
  expect(code).toBe(0);
  expect(log).toHaveLength(2);
  expect(log[0]).toMatch(/family public: .*with a set 1, complete years 10-10, rows new 730,/);
  expect(log[1]).toMatch(/family owner: .*with a set 1, complete years 10-10, rows new 730,/);

  publicDb = h.dbAs('rws_api', 4);
  publishDb = h.dbAs('rws_publish', 2);
  ownerDb = h.dbAs('rws_owner_api', 4);
  const publicWindow = new DisplayWindow(publicDb.db);
  expect(await publicWindow.refresh()).toBe(true);
  const ownerWindow = new DisplayWindow(ownerDb.db, undefined, 'owner');
  expect(await ownerWindow.refresh()).toBe(true);
  publicApp = createApp({ db: publicDb.db, window: publicWindow, now: () => NOW });
  ownerApp = createApp({ family: 'owner', db: ownerDb.db, window: ownerWindow, now: () => NOW });
}, 300_000);
afterAll(() => h.close());

const refCount = async (db: Db, family: 'public' | 'owner', series: number) =>
  (
    await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ${sql.table(VIEWS[family].reference)}
      WHERE series_id = ${series} AND kind IN ('P10_DOY', 'P90_DOY')`.execute(db.db)
  ).rows[0]?.n;

describe('day-of-year rows of an owner series', { timeout: 300_000 }, () => {
  it('are stored under the owner source and seen through the owner reference view only', async () => {
    const stored = await q<{ source_id: string; n: number }>(
      `SELECT source_id, count(*)::int AS n FROM reference_value
       WHERE series_id = $1 AND kind IN ('P10_DOY', 'P90_DOY') AND upper_inf(valid) GROUP BY 1`,
      [own],
    );
    expect(stored).toEqual([{ source_id: 'BE-3', n: 730 }]);
    expect(await refCount(ownerDb, 'owner', own)).toBe(730);
    expect(await refCount(publicDb, 'public', own)).toBe(0);
    // The public series is computed once and seen by both families.
    expect(await refCount(publicDb, 'public', pub)).toBe(730);
    expect(await refCount(ownerDb, 'owner', pub)).toBe(730);
    const once = await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM reference_value WHERE series_id = $1 AND kind IN ('P10_DOY', 'P90_DOY')`,
      [pub],
    );
    expect(once[0]?.n).toBe(730);
  });

  it('the owner /snapshot states the DOY basis and the canary; the public one holds neither', async () => {
    const owner = await ask(
      ownerApp,
      { path: `/api/v1/snapshot?t=${ISO(T_NOW)}`, label: 'owner snapshot' },
      'identity',
    );
    expect(owner.status).toBe(200);
    const snap = OwnerSnapshotAnswer.parse(JSON.parse(owner.text));
    const mine = snap.values.find((v) => v.series === own);
    expect(mine?.basis).toMatchObject({ source: 'BE-3', kind: 'statistical' });
    expect(mine?.basis?.ref.split('/').every((k) => k.endsWith('_DOY'))).toBe(true);
    expect(owner.text).toContain('777777.75');

    const pubSnap = await ask(
      publicApp,
      { path: `/api/v1/snapshot?t=${ISO(T_NOW)}`, label: 'public snapshot' },
      'identity',
    );
    expect(pubSnap.status).toBe(200);
    const doc = SnapshotAnswer.parse(JSON.parse(pubSnap.text));
    expect(doc.values.find((v) => v.series === own)).toBeUndefined();
    expect(doc.values.find((v) => v.series === pub)?.basis?.ref).toBe('P90_DOY');
    for (const needle of NEEDLES) expect(pubSnap.text, needle).not.toContain(needle);
    expect(pubSnap.text).not.toMatch(/7777[0-9]{2}/);
  });

  it('/frames: the owner answer has the series, the public one neither it nor a canary', async () => {
    const path = `/api/v1/frames?from=${ISO(T_NOW - 4 * H)}&to=${ISO(T_NOW)}&step=1h`;
    const owner = await ask(ownerApp, { path, label: 'owner frames' }, 'identity');
    expect(owner.status).toBe(200);
    expect(OwnerFramesAnswer.parse(JSON.parse(owner.text)).series).toContain(own);
    const pubFrames = await ask(publicApp, { path, label: 'public frames' }, 'identity');
    expect(pubFrames.status).toBe(200);
    const body = FramesAnswer.parse(JSON.parse(pubFrames.text));
    expect(body.series).not.toContain(own);
    expect(body.series).toContain(pub);
    for (const needle of NEEDLES) expect(pubFrames.text, needle).not.toContain(needle);
  });

  it('the coverage counts the owner station in the owner report only', async () => {
    const pubStatus = await status(await ctxFor(publishDb, 'public', { now: T_NOW }), P);
    const ownStatus = await status(await ctxFor(ownerDb, 'owner', { now: T_NOW }), P);
    const pubFile = StatusFile.parse(pubStatus);
    const ownFile = OwnerStatusFile.parse(ownStatus);
    const p = pubFile.classification;
    expect(p?.tier1.climatology).toBeGreaterThanOrEqual(1);
    // The public half of the owner file is the public coverage; the owner half counts the BE-3 station beside it.
    expect(ownFile.classification.public?.tier1.climatology).toBe(p?.tier1.climatology);
    expect(ownFile.classification.owner?.tier1.climatology).toBe((p?.tier1.climatology ?? 0) + 1);
    expect(ownFile.classification.owner?.tier1.by_climatology).toBe((p?.tier1.by_climatology ?? 0) + 1);
    const text = JSON.stringify(pubStatus);
    for (const needle of NEEDLES) expect(text, needle).not.toContain(needle);
  });

  it('/api/v1/health/sources carries the public counts and no owner trace', async () => {
    const res = await ask(publicApp, { path: '/api/v1/health/sources', label: 'public health' }, 'identity');
    expect(res.status).toBe(200);
    const doc = JSON.parse(res.text) as { classification: { tier1: { climatology: number } } | null };
    expect(doc.classification?.tier1.climatology).toBeGreaterThanOrEqual(1);
    for (const needle of NEEDLES) expect(res.text, needle).not.toContain(needle);
  });

  it('recent.json carries no day-of-year row in either family, and no canary in the public one', async () => {
    const pubRecent = JSON.stringify(
      await renderStation(await ctxFor(publishDb, 'public', { now: T_NOW }), pubStation),
    );
    expect(pubRecent).not.toContain('_DOY');
    const ownRecent = JSON.stringify(await renderStation(await ctxFor(ownerDb, 'owner', { now: T_NOW }), ownStation));
    expect(ownRecent).not.toContain('_DOY');
    expect(ownRecent).toContain('777777.75');
    for (const needle of NEEDLES) expect(pubRecent, needle).not.toContain(needle);
  });
});
