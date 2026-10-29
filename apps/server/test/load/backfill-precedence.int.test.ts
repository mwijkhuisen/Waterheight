import { readFileSync } from 'node:fs';
import { type ObsRow, QC } from '@rws/core';
import fc from 'fast-check';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bareLine, writePayload } from '../../../../scripts/fixture-archive.ts';
import type { ManifestLine } from '../../src/archive/manifest.ts';
import { sha256 } from '../../src/archive/writer.ts';
import { VIEWS } from '../../src/db/audience.ts';
import { syncOwnerCanary } from '../../src/load/canary.ts';
import { findCoverage, findOutages } from '../../src/load/health.ts';
import { lock, openBatch, type SeriesRow, seriesOf, type UpsertMode, upsertObs } from '../../src/load/store.ts';
import { rawFixture } from '../adapters/registry.ts';
import { type Harness, harness } from './harness.ts';

// P14a, the row rules (plan §3.5): the precedence of live, fill and backfill rows in upsertObs, as a matrix and as a
// fast-check property over random load orders; a backfill payload leaves the source's fetch health, outages and
// coverage alone; and a backfill of an owner-audience series stays in the owner views (invariant 11).

let h: Harness;
let nl1: Map<string, SeriesRow>;
/** Two NL-1 series of the registry: one for the matrix, one for the property (cleared between its runs). */
let MATRIX: SeriesRow;
let PROP: SeriesRow;
/** A third one for the fill rows and obs_latest (#235): no other test touches it. */
let FILLSER: SeriesRow;
const OLD = new Date('2026-10-01T00:00:00Z');
const NEW = new Date('2026-10-02T00:00:00Z');
let n = 0;
/** A fresh archive key per batch. */
const nextKey = () => {
  n += 1;
  return `test/${n}`;
};

type Kind = UpsertMode;
type Point = { ts: string; value: number; validated: boolean };

/** One payload of `kind` for one series, in its own transaction as the loader does it. `key` reuses a batch. */
async function load(kind: Kind, series: SeriesRow, at: Date, points: readonly Point[], key = nextKey()) {
  return h.load.db.transaction().execute(async (tx) => {
    await lock(tx);
    const batch = await openBatch(
      tx,
      {
        source: 'NL-1',
        spec: kind === 'backfill' ? 'nl-1-backfill-obs' : 'nl-1-obs-key',
        key,
        sha256: null,
        fetchedAt: at,
        status: 200,
        bytes: null,
        adapterVersion: 1,
        ...(kind === 'backfill' ? { origin: 'backfill' as const } : {}),
      },
      'ok',
    );
    const rows: ObsRow[] = points.map((p) => ({
      series: series.key,
      ts: p.ts,
      value: p.value,
      qc: p.validated ? QC.VALIDATED : QC.RAW,
    }));
    const written = await upsertObs(tx, rows, nl1, batch.id, at, kind, []);
    return { batch: batch.id, key, written };
  });
}

type Stored = { ts: string; value: number; qc: number; batch_id: string };
async function stored(series: number, ts?: string): Promise<Stored[]> {
  const { rows } = await h.t.admin.query<{ ts: Date; value: number; qc: number; batch_id: string }>(
    `SELECT ts, value, qc, batch_id::text FROM obs WHERE series_id = $1 AND ($2::timestamptz IS NULL OR ts = $2)
     ORDER BY ts`,
    [series, ts ?? null],
  );
  return rows.map((r) => ({ ts: r.ts.toISOString(), value: r.value, qc: r.qc, batch_id: r.batch_id }));
}
async function revisions(series: number, ts?: string) {
  const { rows } = await h.t.admin.query<{
    ts: Date;
    old_value: number;
    new_value: number;
    old_qc: number;
    new_qc: number;
    batch_id: string;
  }>(
    `SELECT ts, old_value, new_value, old_qc, new_qc, batch_id::text FROM obs_revision
     WHERE series_id = $1 AND ($2::timestamptz IS NULL OR ts = $2) ORDER BY batch_id, ts`,
    [series, ts ?? null],
  );
  return rows.map((r) => ({ ...r, ts: r.ts.toISOString() }));
}

const qcOf = (kind: Kind, validated: boolean) =>
  (validated ? QC.VALIDATED : QC.RAW) | (kind === 'live' ? 0 : QC.BACKFILLED);

beforeAll(async () => {
  h = await harness();
  nl1 = await seriesOf(h.load.db, 'NL-1');
  const usable = [...nl1.values()].filter((s) => !s.off && s.sameAudience).sort((a, b) => a.id - b.id);
  MATRIX = usable[0] as SeriesRow;
  PROP = usable[1] as SeriesRow;
  FILLSER = usable[2] as SeriesRow;
}, 60_000);

afterAll(async () => {
  await h.close();
});

type Side = { kind: Kind; validated: boolean; value: number; at: 'old' | 'new' | 'same' };
type Case = {
  name: string;
  stored: Side | null;
  incoming: Side;
  expect: 'insert' | 'replace' | 'skip' | 'confirm';
  revision: boolean;
};
const s = (kind: Kind, validated: boolean, value: number, at: Side['at']): Side => ({ kind, validated, value, at });
const V = true;
const U = false;

/** The table of plan §3.5, row by row (stored ↓, incoming →). */
const CASES: Case[] = [
  { name: 'none ← live', stored: null, incoming: s('live', U, 1, 'new'), expect: 'insert', revision: false },
  { name: 'none ← fill', stored: null, incoming: s('fill', U, 1, 'new'), expect: 'insert', revision: false },
  { name: 'none ← backfill', stored: null, incoming: s('backfill', U, 1, 'new'), expect: 'insert', revision: false },
  {
    name: 'live ← newer live',
    stored: s('live', U, 1, 'old'),
    incoming: s('live', U, 2, 'new'),
    expect: 'replace',
    revision: true,
  },
  {
    name: 'live ← older live',
    stored: s('live', U, 1, 'new'),
    incoming: s('live', U, 2, 'old'),
    expect: 'skip',
    revision: false,
  },
  {
    name: 'live ← its own batch corrected',
    stored: s('live', U, 1, 'old'),
    incoming: s('live', U, 2, 'same'),
    expect: 'replace',
    revision: true,
  },
  {
    name: 'live ← newer live, same value',
    stored: s('live', U, 1, 'old'),
    incoming: s('live', U, 1, 'new'),
    expect: 'confirm',
    revision: false,
  },
  {
    name: 'live ← fill',
    stored: s('live', U, 1, 'old'),
    incoming: s('fill', U, 2, 'new'),
    expect: 'skip',
    revision: false,
  },
  {
    name: 'unvalidated live ← validated backfill (older fetch)',
    stored: s('live', U, 1, 'new'),
    incoming: s('backfill', V, 2, 'old'),
    expect: 'replace',
    revision: true,
  },
  {
    name: 'unvalidated live ← validated backfill of the same value',
    stored: s('live', U, 1, 'old'),
    incoming: s('backfill', V, 1, 'new'),
    expect: 'replace',
    revision: true,
  },
  {
    name: 'unvalidated live ← unvalidated backfill',
    stored: s('live', U, 1, 'old'),
    incoming: s('backfill', U, 2, 'new'),
    expect: 'skip',
    revision: false,
  },
  {
    name: 'validated live ← validated backfill',
    stored: s('live', V, 1, 'old'),
    incoming: s('backfill', V, 2, 'new'),
    expect: 'skip',
    revision: false,
  },
  {
    name: 'validated live ← unvalidated backfill',
    stored: s('live', V, 1, 'old'),
    incoming: s('backfill', U, 2, 'new'),
    expect: 'skip',
    revision: false,
  },
  {
    name: 'fill ← older live',
    stored: s('fill', U, 1, 'new'),
    incoming: s('live', U, 2, 'old'),
    expect: 'replace',
    revision: false,
  },
  {
    name: 'fill ← newer fill',
    stored: s('fill', U, 1, 'old'),
    incoming: s('fill', U, 2, 'new'),
    expect: 'replace',
    revision: false,
  },
  {
    name: 'fill ← older fill',
    stored: s('fill', U, 1, 'new'),
    incoming: s('fill', U, 2, 'old'),
    expect: 'skip',
    revision: false,
  },
  {
    name: 'fill ← older backfill',
    stored: s('fill', U, 1, 'new'),
    incoming: s('backfill', U, 2, 'old'),
    expect: 'replace',
    revision: false,
  },
  {
    name: 'validated backfill ← unvalidated live',
    stored: s('backfill', V, 1, 'old'),
    incoming: s('live', U, 2, 'new'),
    expect: 'skip',
    revision: false,
  },
  {
    name: 'validated backfill ← older validated live',
    stored: s('backfill', V, 1, 'new'),
    incoming: s('live', V, 2, 'old'),
    expect: 'replace',
    revision: false,
  },
  {
    name: 'unvalidated backfill ← older unvalidated live',
    stored: s('backfill', U, 1, 'new'),
    incoming: s('live', U, 2, 'old'),
    expect: 'replace',
    revision: false,
  },
  {
    name: 'unvalidated backfill ← validated live',
    stored: s('backfill', U, 1, 'old'),
    incoming: s('live', V, 2, 'new'),
    expect: 'replace',
    revision: false,
  },
  {
    name: 'backfill ← fill',
    stored: s('backfill', U, 1, 'old'),
    incoming: s('fill', U, 2, 'new'),
    expect: 'skip',
    revision: false,
  },
  {
    name: 'backfill ← newer backfill',
    stored: s('backfill', U, 1, 'old'),
    incoming: s('backfill', U, 2, 'new'),
    expect: 'replace',
    revision: false,
  },
  {
    name: 'backfill ← older validated backfill',
    stored: s('backfill', U, 1, 'new'),
    incoming: s('backfill', V, 2, 'old'),
    expect: 'skip',
    revision: false,
  },
  {
    name: 'backfill ← its own batch corrected',
    stored: s('backfill', U, 1, 'old'),
    incoming: s('backfill', U, 2, 'same'),
    expect: 'replace',
    revision: false,
  },
];

describe('the row rules (plan §3.5)', { timeout: 60_000 }, () => {
  it('follow the precedence table cell by cell, with a revision for every change of a live row', async () => {
    const base = Date.parse('2025-03-01T00:00:00Z');
    for (const [i, c] of CASES.entries()) {
      const ts = new Date(base + i * 3_600_000).toISOString();
      const point = (side: Side) => [{ ts, value: side.value, validated: side.validated }];
      const fetched = (side: Side) => (side.at === 'old' ? OLD : NEW);
      const first = c.stored && (await load(c.stored.kind, MATRIX, fetched(c.stored), point(c.stored)));
      const before = await stored(MATRIX.id, ts);
      const inc = c.incoming;
      const second =
        inc.at === 'same' && first
          ? await load(inc.kind, MATRIX, fetched(c.stored as Side), point(inc), first.key)
          : await load(inc.kind, MATRIX, fetched(inc), point(inc));
      const after = await stored(MATRIX.id, ts);
      const mine = { value: inc.value, qc: qcOf(inc.kind, inc.validated), batch_id: second.batch };
      const counts = { inserted: 0, revised: 0, skipped: 0 };
      if (c.expect === 'insert' || (c.expect === 'replace' && c.stored?.kind !== 'live')) counts.inserted = 1;
      else if (c.expect === 'replace') counts.revised = 1;
      else counts.skipped = 1;
      if (c.expect === 'skip') expect(after, c.name).toEqual(before);
      else if (c.expect === 'confirm')
        expect(after, c.name).toEqual([{ ...(before[0] as Stored), batch_id: second.batch }]);
      else expect(after, c.name).toEqual([{ ts, ...mine }]);
      expect(
        { inserted: second.written.inserted, revised: second.written.revised, skipped: second.written.skipped },
        c.name,
      ).toEqual(counts);
      const logged = await revisions(MATRIX.id, ts);
      if (c.revision) {
        const old = before[0] as Stored;
        expect(logged, c.name).toEqual([
          {
            ts,
            old_value: old.value,
            new_value: mine.value,
            old_qc: old.qc,
            new_qc: mine.qc,
            batch_id: second.batch,
          },
        ]);
      } else {
        expect(logged, c.name).toEqual([]);
      }
    }
  });

  it('a backfill never moves obs_latest; live does', async () => {
    const latest = async () =>
      (await h.t.admin.query<{ ts: Date }>('SELECT ts FROM obs_latest WHERE series_id = $1', [MATRIX.id])).rows.map(
        (r) => r.ts.toISOString(),
      );
    const before = await latest();
    await load('backfill', MATRIX, NEW, [{ ts: '2026-01-01T00:00:00.000Z', value: 3, validated: true }]);
    expect(await latest()).toEqual(before);
    await load('live', MATRIX, NEW, [{ ts: '2026-01-01T00:00:00.000Z', value: 3, validated: true }]);
    expect(await latest()).toEqual(['2026-01-01T00:00:00.000Z']);
  });

  it('a fill row never moves obs_latest; a live row of the series replaces it, whatever its fetch time (#235)', async () => {
    await clear(FILLSER.id);
    const latest = async () =>
      (
        await h.t.admin.query<{ ts: Date; value: number; qc: number }>(
          'SELECT ts, value, qc FROM obs_latest WHERE series_id = $1',
          [FILLSER.id],
        )
      ).rows.map((r) => ({ ts: r.ts.toISOString(), value: r.value, qc: r.qc }));
    const hour = async (bucket: string) =>
      (
        await h.t.admin.query<{ n: number; vlast: number }>(
          'SELECT n, vlast FROM obs_1h WHERE series_id = $1 AND bucket = $2',
          [FILLSER.id, bucket],
        )
      ).rows;
    const T0 = '2026-09-10T10:00:00.000Z';
    const T1 = '2026-09-10T11:00:00.000Z';
    const T2 = '2026-09-10T12:00:00.000Z';
    const T3 = '2026-09-10T13:00:00.000Z';
    const pt = (ts: string, value: number): Point[] => [{ ts, value, validated: false }];
    expect(await latest()).toEqual([]);

    // (1) live at T1: obs_latest is T1. A fill at T2 > T1 (a later instant) leaves it at T1.
    await load('live', FILLSER, OLD, pt(T1, 1));
    const atT1 = [{ ts: T1, value: 1, qc: QC.RAW }];
    expect(await latest()).toEqual(atT1);
    await load('fill', FILLSER, NEW, pt(T2, 2));
    expect(await latest()).toEqual(atT1);
    expect(await stored(FILLSER.id, T2)).toMatchObject([{ value: 2, qc: QC.RAW | QC.BACKFILLED }]);

    // (2) a fill at T0 < T1, in a hole: stored with the backfilled bit, counted by its hour, no revision, obs_latest at T1.
    await load('fill', FILLSER, NEW, pt(T0, 7));
    expect(await stored(FILLSER.id, T0)).toMatchObject([{ value: 7, qc: QC.RAW | QC.BACKFILLED }]);
    expect(await hour(T0)).toEqual([{ n: 1, vlast: 7 }]);
    expect(await latest()).toEqual(atT1);
    expect(await revisions(FILLSER.id)).toEqual([]);

    // (3) live at T2, a later fetch: replaces the fill row (bit cleared), no revision, obs_latest moves to T2.
    await load('live', FILLSER, NEW, pt(T2, 3));
    expect(await stored(FILLSER.id, T2)).toMatchObject([{ value: 3, qc: QC.RAW }]);
    expect(await revisions(FILLSER.id)).toEqual([]);
    expect(await latest()).toEqual([{ ts: T2, value: 3, qc: QC.RAW }]);

    // (4) a fill at T3 fetched LATER than the live row that then arrives: the live row of the series still replaces it
    // and moves obs_latest.
    await load('fill', FILLSER, new Date('2026-10-05T00:00:00Z'), pt(T3, 4));
    expect(await latest()).toEqual([{ ts: T2, value: 3, qc: QC.RAW }]);
    await load('live', FILLSER, OLD, pt(T3, 5));
    expect(await stored(FILLSER.id, T3)).toMatchObject([{ value: 5, qc: QC.RAW }]);
    expect(await revisions(FILLSER.id)).toEqual([]);
    expect(await latest()).toEqual([{ ts: T3, value: 5, qc: QC.RAW }]);
  });

  it('counts each input row in one class: off series, repeats in the payload, rules, confirmations', async () => {
    const off = [...nl1.values()].find((x) => x.off);
    const ts = '2025-06-01T00:00:00.000Z';
    const rows: ObsRow[] = [
      { series: MATRIX.key, ts, value: 1, qc: QC.RAW },
      { series: MATRIX.key, ts, value: 2, qc: QC.RAW }, // the payload states ts again: the last one counts
      ...(off === undefined ? [] : [{ series: off.key, ts, value: 1, qc: QC.RAW }]),
    ];
    const written = await h.load.db.transaction().execute(async (tx) => {
      await lock(tx);
      const b = await openBatch(
        tx,
        {
          source: 'NL-1',
          spec: 'nl-1-backfill-obs',
          key: nextKey(),
          sha256: null,
          fetchedAt: NEW,
          status: 200,
          bytes: null,
          adapterVersion: 1,
          origin: 'backfill',
        },
        'ok',
      );
      return upsertObs(tx, rows, nl1, b.id, NEW, 'backfill', []);
    });
    expect({ inserted: written.inserted, revised: written.revised, skipped: written.skipped }).toEqual({
      inserted: 1,
      revised: 0,
      skipped: rows.length - 1,
    });
    expect((await stored(MATRIX.id, ts)).map((r) => r.value)).toEqual([2]);
  });
});

// ------------------------------------------------------------------------------------------------- the property
// A scenario is a list of payloads in fetch order (payload i fetched i minutes after the first). The provider never
// takes a value back from validated to unvalidated: at each instant a value is validated from a fetch index on (or
// never), for live and backfill payloads alike; a fill's flag is its own. Loaded in fetch order and in a random order,
// the final obs rows are the same; each step writes a revision for every live row it changes, and no unvalidated
// backfill changes a live row.

const NTS = 3;
const PTS = Array.from({ length: NTS }, (_, i) =>
  new Date(Date.parse('2005-07-01T00:00:00Z') + i * 600_000).toISOString(),
);
const payloadArb = fc.record({
  kind: fc.constantFrom<Kind>('live', 'fill', 'backfill'),
  values: fc.array(fc.option(fc.integer({ min: 1, max: 3 }), { nil: undefined }), {
    minLength: NTS,
    maxLength: NTS,
  }),
  fillValidated: fc.boolean(),
});
const MAX_PAYLOADS = 7;
const scenarioArb = fc
  .record({
    payloads: fc.array(payloadArb, { minLength: 1, maxLength: MAX_PAYLOADS }),
    validatedFrom: fc.array(fc.integer({ min: 0, max: MAX_PAYLOADS }), { minLength: NTS, maxLength: NTS }),
  })
  .chain((sc) =>
    fc.record({
      sc: fc.constant(sc),
      order: fc.shuffledSubarray([...sc.payloads.keys()], {
        minLength: sc.payloads.length,
        maxLength: sc.payloads.length,
      }),
    }),
  );
async function clear(series: number) {
  for (const table of ['obs', 'obs_revision', 'obs_latest', 'obs_1h', 'obs_1d'])
    await h.t.admin.query(`DELETE FROM ${table} WHERE series_id = $1`, [series]);
}

describe('order independence (plan §3.5, fast-check)', { timeout: 120_000 }, () => {
  it('gives the same final rows in any load order; every live change is a revision; no unvalidated backfill changes a live row', async () => {
    const base = Date.parse('2026-10-03T00:00:00Z');
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ sc, order }) => {
        const pointsOf = (i: number): Point[] => {
          const p = sc.payloads[i] as (typeof sc.payloads)[number];
          return p.values.flatMap((value, t) =>
            value === undefined
              ? []
              : [
                  {
                    ts: PTS[t] as string,
                    value,
                    validated: p.kind === 'fill' ? p.fillValidated : i >= (sc.validatedFrom[t] as number),
                  },
                ],
          );
        };
        const run = async (sequence: readonly number[]) => {
          await clear(PROP.id);
          for (const i of sequence) {
            const p = sc.payloads[i] as (typeof sc.payloads)[number];
            const points = pointsOf(i);
            const before = new Map((await stored(PROP.id)).map((r) => [r.ts, r]));
            const step = await load(p.kind, PROP, new Date(base + i * 60_000), points);
            const after = new Map((await stored(PROP.id)).map((r) => [r.ts, r]));
            const { inserted, revised, skipped } = step.written;
            expect(inserted + revised + skipped).toBe(points.length);
            // Every live row this step changed: one revision of this batch, with the old and the new value.
            const changedLive = [...before.values()].filter((b) => {
              const a = after.get(b.ts) as Stored;
              return (b.qc & QC.BACKFILLED) === 0 && (a.value !== b.value || a.qc !== b.qc);
            });
            const logged = (await revisions(PROP.id)).filter((r) => r.batch_id === step.batch);
            expect(logged.map((r) => r.ts).sort()).toEqual(changedLive.map((b) => b.ts).sort());
            for (const b of changedLive) {
              const a = after.get(b.ts) as Stored;
              expect(logged.find((r) => r.ts === b.ts)).toMatchObject({
                old_value: b.value,
                old_qc: b.qc,
                new_value: a.value,
                new_qc: a.qc,
              });
              if (p.kind === 'backfill') expect(points.find((x) => x.ts === b.ts)?.validated).toBe(true);
              expect(p.kind).not.toBe('fill');
            }
            expect(revised).toBe(changedLive.length);
          }
          return (await stored(PROP.id)).map(({ ts, value, qc }) => ({ ts, value, qc }));
        };
        const inFetchOrder = await run([...sc.payloads.keys()]);
        const shuffled = await run(order);
        expect(shuffled).toEqual(inFetchOrder);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------------- health and audience (§3.4)

const BACKFILL_URL =
  'https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen';

/** A backfill manifest line as the runner writes it: variant '', retention 'backfill', always a key. */
async function putBackfill(
  source: string,
  spec: string,
  at: Date,
  body: Buffer,
  backfill?: NonNullable<ManifestLine['backfill']>,
) {
  const hash = sha256(body);
  const { key, stored: bytes } = await h.archive.put(source, spec, at, body, hash);
  const line = bareLine(source, spec, at, {
    request: { method: 'POST', url: BACKFILL_URL },
    sha256: hash,
    bytes: body.length,
    stored_bytes: bytes,
    key,
    validity: { ok: true, reason: null, count: 1 },
    retention: 'backfill',
    ...(backfill === undefined ? {} : { backfill }),
  });
  await h.archive.append(line);
  return line;
}

/** A real NL-1 payload with its instants moved back to `year` (history the provider would serve). */
const movedTo = (name: string, year: string) =>
  Buffer.from(rawFixture('NL-1', name).body.toString('utf8').replaceAll('"2026-09-', `"${year}-09-`));

describe('a backfill payload is not a fetch of the source (plan §3.4)', { timeout: 60_000 }, () => {
  it('changes no fetch health, intervals, outages or coverage', async () => {
    const fixture = rawFixture('NL-1', 'nl-1-obs-key');
    const live = new Date(fixture.meta.recorded_at);
    await writePayload(h.archive, {
      source: 'NL-1',
      spec: 'nl-1-obs-key',
      variant: 'lobith.bovenrijn.tolkamer/H',
      at: live,
      body: fixture.body,
      url: fixture.meta.url,
    });
    const now = new Date(live.getTime() + 3 * 3_600_000);
    expect(await h.loader({ now }).tick()).toEqual({ lines: 1, loaded: 1 });
    const health = async () =>
      (
        await h.t.admin.query(
          `SELECT h.last_fetch_ok, h.consecutive_failures, h.last_new_data, h.newest_ts, h.updated_at,
                  (SELECT value FROM app_meta WHERE key = 'intervals:NL-1') AS intervals
           FROM source_health h WHERE source_id = 'NL-1'`,
        )
      ).rows;
    const cadence = new Map([['NL-1', 600]]);
    const before = {
      health: await health(),
      outages: await findOutages(h.load.db, cadence, now),
      coverage: await findCoverage(h.load.db, cadence, now),
    };
    expect(before.outages).toEqual(new Map());

    // Two hours later, a backfill payload of 2005 and a failed backfill request: a gap of live batches if counted.
    const later = new Date(live.getTime() + 2 * 3_600_000);
    await putBackfill('NL-1', 'nl-1-backfill-obs', later, movedTo('nl-1-obs-key', '2005'));
    await h.archive.append(
      bareLine('NL-1', 'nl-1-backfill-obs', new Date(later.getTime() + 60_000), {
        status: 503,
        retention: 'backfill',
      }),
    );
    const alerts = h.alerts.length;
    expect(await h.loader({ now }).tick()).toEqual({ lines: 2, loaded: 1 });
    expect(h.alerts.slice(alerts)).toEqual([]);
    const { rows } = await h.t.admin.query(
      "SELECT origin, n_new FROM ingest_batch WHERE spec_id = 'nl-1-backfill-obs' AND archive_key LIKE 'raw/%'",
    );
    expect(rows).toEqual([{ origin: 'backfill', n_new: 16 }]);
    expect({
      health: await health(),
      outages: await findOutages(h.load.db, cadence, now),
      coverage: await findCoverage(h.load.db, cadence, now),
    }).toEqual(before);
  });
});

describe('the load window of a backfill line (review S3)', { timeout: 60_000 }, () => {
  it('stores no row outside the line’s chunk: a forged or misplaced line loads nothing there', async () => {
    const at = new Date('2026-10-14T01:00:00Z');
    const count = () => h.count("obs WHERE ts >= '2006-01-01' AND ts < '2007-01-01'");
    const before = await count();
    // The payload's values are in 2006-09; the line names a chunk that ends before them.
    await putBackfill('NL-1', 'nl-1-backfill-obs', at, movedTo('nl-1-obs-key', '2006'), {
      job: 999_999,
      chunk: 0,
      from: '2006-01-01T00:00:00.000Z',
      to: '2006-09-01T00:00:00.000Z',
    });
    expect(await h.loader({ now: new Date(at.getTime() + 3_600_000) }).tick()).toEqual({ lines: 1, loaded: 1 });
    expect(await count()).toBe(before);
    const { rows } = await h.t.admin.query(
      "SELECT n_new, n_rows FROM ingest_batch WHERE spec_id = 'nl-1-backfill-obs' ORDER BY id DESC LIMIT 1",
    );
    expect(rows).toEqual([{ n_new: 0, n_rows: 0 }]);
  });
});

describe('audience (invariant 11)', { timeout: 60_000 }, () => {
  it('a backfill row of the owner canary series is in the owner views only', async () => {
    const migrator = h.dbAs('rws_migrator', 1);
    await migrator.db.transaction().execute(async (tx) => {
      await lock(tx);
      await syncOwnerCanary(tx);
    });
    const owner = await seriesOf(h.load.db, 'CANARY-OWNER');
    // The manifest names provider sources only, so the canary's backfill goes straight through the upsert: a batch of
    // origin `backfill` and one validated value of 2005, as a backfill payload of an owner-audience source would.
    await h.load.db.transaction().execute(async (tx) => {
      await lock(tx);
      const b = await openBatch(
        tx,
        {
          source: 'CANARY-OWNER',
          spec: 'canary-backfill',
          key: nextKey(),
          sha256: null,
          fetchedAt: NEW,
          status: 200,
          bytes: null,
          adapterVersion: 1,
          origin: 'backfill',
        },
        'ok',
      );
      const row = { series: 'owner-canary', ts: '2005-03-01T12:00:00.000Z', value: 777777.777, qc: QC.VALIDATED };
      expect((await upsertObs(tx, [row], owner, b.id, NEW, 'backfill', [])).inserted).toBe(1);
    });
    const canary = owner.get('owner-canary') as SeriesRow;
    const count = async (view: string, col: string) =>
      (
        await h.t.admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${view} WHERE series_id = $1 AND ${col} < '2026-01-01'`,
          [canary.id],
        )
      ).rows[0]?.n;
    for (const family of ['public', 'owner'] as const) {
      const v = VIEWS[family];
      const want = family === 'owner' ? 1 : 0;
      expect([family, await count(v.obs, 'ts')]).toEqual([family, want]);
      expect([family, await count(v.obs1h, 'bucket')]).toEqual([family, want]);
      expect([family, await count(v.obs1d, 'bucket')]).toEqual([family, want]);
    }
  });
});

// ------------------------------------------------------------------- P14b: the open archives through the real wires
// Criterion "[CI] backfill never changes a live row unless the provider-validated flag is set, and every such change
// is in obs_revision" for DE-8 (every row validated), FR-2 (code_statut 16 validated, 4 raw) and CH-9 (always raw):
// each payload goes through the real loader, its real wire and its target's registry (DE-7, FR-1, CH-1), as a
// backfill line of a job. A live row of the target series is stored first through the live path. No row of any of
// the three reaches DATA_FLOOR, whatever the line's chunk says, and every line's ledger row reconciles.

const FLOOR = '2026-08-01T00:00:00.000Z';
const STAH = '2829100000100/W';
const UCKANGE_QMNJ = 'A850061001/QmnJ';
const BASEL_W = '2289/W';
const BASEL_Q = '2289/Q';
const P14B_LIVE = new Date('2026-10-01T06:00:00Z');
let p14bAt = Date.parse('2026-10-18T22:30:00Z');
const P14B_NOW = new Date('2026-10-19T04:00:00Z');
const p14bJobs: number[] = [];

const fixtureBody = (id: string, name: string) =>
  readFileSync(new URL(`../../src/adapters/${id}/fixtures/${name}.raw`, import.meta.url));

/** A live row of a target series, stored as its source's own payload would store it. */
async function liveRow(source: string, spec: string, key: string, ts: string, value: number, qc: number) {
  const series = await seriesOf(h.load.db, source);
  return h.load.db.transaction().execute(async (tx) => {
    await lock(tx);
    const b = await openBatch(
      tx,
      { source, spec, key: nextKey(), sha256: null, fetchedAt: P14B_LIVE, status: 200, bytes: null, adapterVersion: 1 },
      'ok',
    );
    const w = await upsertObs(tx, [{ series: key, ts, value, qc }], series, b.id, P14B_LIVE, 'live', []);
    expect(w.inserted).toBe(1);
    return b.id;
  });
}

/** A job of the backfill spec, so that its lines get ledger rows (`recordChunk` names the job). */
async function p14bJob(source: string, spec: string, unit: string, from: string, to: string): Promise<number> {
  const { rows } = await h.t.admin.query<{ id: string }>(
    `INSERT INTO backfill_job (spec_id, source_id, series_key, range_from, range_to, chunk, cursor_ts, request_budget,
                               status)
     VALUES ($1, $2, $3, $4, $5, interval '30 days', $4, 10, 'running') RETURNING id`,
    [spec, source, unit, from, to],
  );
  const id = Number(rows[0]?.id);
  p14bJobs.push(id);
  return id;
}

type Ledger = {
  provider_values: number;
  kept: number;
  inserted: number;
  revised: number;
  skipped: number;
  dropped: number;
  reconciled: boolean;
};

/** A backfill line as the runner writes it, for one chunk, loaded by the real loader with the real adapters. */
async function p14bLoad(
  o: { source: string; spec: string; url: string; variant?: string; job: number },
  body: Buffer,
  chunk: [string, string],
): Promise<{ batch: string; ledger: Ledger }> {
  p14bAt += 60_000;
  const at = new Date(p14bAt);
  const hash = sha256(body);
  const { key, stored: bytes } = await h.archive.put(o.source, o.spec, at, body, hash);
  await h.archive.append(
    bareLine(o.source, o.spec, at, {
      variant: o.variant ?? '',
      request: { method: 'GET', url: o.url },
      sha256: hash,
      bytes: body.length,
      stored_bytes: bytes,
      key,
      gate: { kind: 'hash', key: null, open: true },
      validity: { ok: true, reason: null, count: 1 },
      retention: 'backfill',
      backfill: { job: o.job, chunk: 0, from: chunk[0], to: chunk[1] },
    }),
  );
  const alerts = h.alerts.length;
  expect(await h.loader({ now: P14B_NOW }).tick()).toEqual({ lines: 1, loaded: 1 });
  expect(h.alerts.slice(alerts)).toEqual([]);
  const { rows: batch } = await h.t.admin.query<{ parse_status: string; origin: string; id: string }>(
    'SELECT parse_status, origin, id::text FROM ingest_batch WHERE archive_key = $1',
    [key],
  );
  expect(batch).toEqual([{ parse_status: 'ok', origin: 'backfill', id: expect.any(String) }]);
  const { rows: ledger } = await h.t.admin.query<Ledger>(
    `SELECT provider_values::int, kept::int, inserted::int, revised::int, skipped::int, dropped::int, reconciled
     FROM backfill_chunk WHERE archive_key = $1`,
    [key],
  );
  expect(ledger).toHaveLength(1);
  const l = ledger[0] as Ledger;
  expect(l.reconciled).toBe(true);
  expect(l.provider_values).toBe(l.kept + l.dropped);
  expect(l.kept).toBe(l.inserted + l.revised + l.skipped);
  return { batch: (batch[0] as { id: string }).id, ledger: l };
}

const rowAt = async (key: string, ts: string) =>
  (
    await h.t.admin.query<{ value: number; qc: number; batch_id: string }>(
      `SELECT o.value, o.qc, o.batch_id::text FROM obs o JOIN series s ON s.id = o.series_id
       WHERE s.provider_key = $1 AND o.ts = $2`,
      [key, ts],
    )
  ).rows;
const revisionsAt = async (key: string, ts: string) =>
  (
    await h.t.admin.query<{ old_value: number; new_value: number; old_qc: number; new_qc: number; batch_id: string }>(
      `SELECT r.old_value, r.new_value, r.old_qc, r.new_qc, r.batch_id::text FROM obs_revision r
       JOIN series s ON s.id = r.series_id WHERE s.provider_key = $1 AND r.ts = $2`,
      [key, ts],
    )
  ).rows;
const rowsIn = async (key: string, from: string, to: string) =>
  (
    await h.t.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM obs o JOIN series s ON s.id = o.series_id
       WHERE s.provider_key = $1 AND o.ts >= $2 AND o.ts < $3`,
      [key, from, to],
    )
  ).rows[0]?.n;

/** The value a DE-8 decade member holds at grid point `g` (ms): the last row at or before it, not NA, within 24 h. */
function heldAt(zip: Buffer, station: string, g: number): number {
  const files = unzipSync(zip);
  const name = Object.keys(files).find((n) => n.startsWith(`${station}_`)) as string;
  let value = Number.NaN;
  let at = Number.NEGATIVE_INFINITY;
  for (const line of strFromU8(files[name] as Uint8Array)
    .split('\n')
    .slice(1)) {
    const [, , time, v] = line.split(';');
    if (time === undefined || Date.parse(time) > g) continue;
    at = Date.parse(time);
    value = v === 'NA' ? Number.NaN : Number(v);
  }
  if (Number.isNaN(value) || g - at > 86_400_000) throw new Error('no held value');
  return value;
}

/** An obs_elab record in the recorded form (the 14 keys of fr-2-uckange-qmnj-2026), for one day and statut. */
function elab(day: string, value: number, statut: 16 | 4): Record<string, unknown> {
  const [template] = JSON.parse(fixtureBody('fr-2', 'fr-2-elab-uckange-qmnj-2026').toString('utf8')).data;
  return {
    ...template,
    date_obs_elab: day,
    resultat_obs_elab: value,
    code_statut: statut,
    libelle_statut: statut === 16 ? 'Donnée validée' : 'Donnée brute',
    code_qualification: 20,
    libelle_qualification: 'Bonne',
  };
}
const elabBody = (records: Record<string, unknown>[]) =>
  Buffer.from(
    JSON.stringify({ count: records.length, first: null, prev: null, next: null, api_version: '2.0.1', data: records }),
  );

const DE8 = {
  source: 'DE-8',
  spec: 'de-8-backfill-w',
  url: 'https://www.opengeodata.nrw.de/produkte/umwelt_klima/wasser/oberflaechengewaesser/hydro/w/Rureinzugsgebiet-NRW-W_2020-2029_EPSG25832_CSV.zip',
};
const FR2 = {
  source: 'FR-2',
  spec: 'fr-2-backfill-elab',
  url: 'https://hubeau.eaufrance.fr/api/v2/hydrometrie/obs_elab?code_entite=A850061001&grandeur_hydro_elab=QmnJ',
};
const CH9 = {
  source: 'CH-9',
  spec: 'ch-9-backfill-bs',
  url: 'https://data.bs.ch/api/explore/v2.1/catalog/datasets/100089/exports/json',
  variant: '100089',
};

describe('P14b: no live change unless validated, each in obs_revision (DE-8, FR-2, CH-9)', { timeout: 120_000 }, () => {
  it('DE-8 (validated): a raw live DE-7 row is replaced with one revision; a validated live row stays', async () => {
    const raw = '2026-06-15T00:00:00.000Z';
    const validated = '2026-06-16T00:00:00.000Z';
    await liveRow('DE-7', 'de-7-messwerte', STAH, raw, 999, QC.RAW);
    const liveValidated = await liveRow('DE-7', 'de-7-messwerte', STAH, validated, 999, QC.VALIDATED);
    const body = fixtureBody('de-8', 'de-8-backfill-w-rur-2020');
    const want = heldAt(body, '2829100000100', Date.parse(raw));
    expect(want).not.toBe(999);
    const job = await p14bJob('DE-8', DE8.spec, 'Rureinzugsgebiet/2020', '2026-03-03', '2026-08-01');
    const { batch, ledger } = await p14bLoad({ ...DE8, job }, body, [
      '2026-06-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
    ]);

    expect(await rowAt(STAH, raw)).toEqual([{ value: want, qc: QC.VALIDATED | QC.BACKFILLED, batch_id: batch }]);
    expect(await revisionsAt(STAH, raw)).toEqual([
      { old_value: 999, new_value: want, old_qc: QC.RAW, new_qc: QC.VALIDATED | QC.BACKFILLED, batch_id: batch },
    ]);
    expect(await rowAt(STAH, validated)).toEqual([{ value: 999, qc: QC.VALIDATED, batch_id: liveValidated }]);
    expect(await revisionsAt(STAH, validated)).toEqual([]);
    // One revised (the raw row), one skipped (the validated one), every other grid point of June new.
    expect(ledger).toMatchObject({ revised: 1, skipped: 1, inserted: ledger.kept - 2 });
    expect(await rowsIn(STAH, '2026-06-01', '2026-07-01')).toBe(ledger.kept);
    console.info(`DE-8 precedence: ${JSON.stringify(ledger)}`);
  });

  it('CH-9 (raw): a raw live CH-1 row stays, counted skipped, no revision', async () => {
    const ts = '2026-06-02T00:00:00.000Z';
    const w = await liveRow('CH-1', 'ch-1-lindas', BASEL_W, ts, 99_999, QC.RAW);
    const q = await liveRow('CH-1', 'ch-1-lindas', BASEL_Q, ts, 99_999, QC.RAW);
    const job = await p14bJob('CH-9', CH9.spec, '100089', '2026-06-01', '2026-08-01');
    const { ledger } = await p14bLoad({ ...CH9, job }, fixtureBody('ch-9', 'ch-9-backfill-100089'), [
      '2026-06-01T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
    ]);
    expect(await rowAt(BASEL_W, ts)).toEqual([{ value: 99_999, qc: QC.RAW, batch_id: w }]);
    expect(await rowAt(BASEL_Q, ts)).toEqual([{ value: 99_999, qc: QC.RAW, batch_id: q }]);
    expect(await revisionsAt(BASEL_W, ts)).toEqual([]);
    expect(await revisionsAt(BASEL_Q, ts)).toEqual([]);
    expect(ledger).toMatchObject({ revised: 0, skipped: 2, inserted: ledger.kept - 2 });
    expect(ledger.kept).toBeGreaterThan(1000);
    console.info(`CH-9 precedence: ${JSON.stringify(ledger)}`);
  });

  it('FR-2 (statut 16 validated, 4 raw): over raw live rows of an aggregate twin, 16 replaces with a revision, 4 stays', async () => {
    const d16 = '2010-05-01T00:00:00.000Z';
    const d4 = '2010-05-02T00:00:00.000Z';
    await liveRow('FR-1', 'fr-1-obs', UCKANGE_QMNJ, d16, 1.5, QC.RAW);
    const live4 = await liveRow('FR-1', 'fr-1-obs', UCKANGE_QMNJ, d4, 1.5, QC.RAW);
    const job = await p14bJob('FR-2', FR2.spec, UCKANGE_QMNJ, '1990-01-01', '2009-12-27');
    const { batch, ledger } = await p14bLoad(
      { ...FR2, job },
      elabBody([elab('2010-05-01', 50_000, 16), elab('2010-05-02', 60_000, 4)]),
      ['2010-01-01T00:00:00.000Z', '2011-01-01T00:00:00.000Z'],
    );
    // l/s × 0.001: 50 m³/s.
    expect(await rowAt(UCKANGE_QMNJ, d16)).toEqual([{ value: 50, qc: QC.VALIDATED | QC.BACKFILLED, batch_id: batch }]);
    expect(await revisionsAt(UCKANGE_QMNJ, d16)).toEqual([
      { old_value: 1.5, new_value: 50, old_qc: QC.RAW, new_qc: QC.VALIDATED | QC.BACKFILLED, batch_id: batch },
    ]);
    expect(await rowAt(UCKANGE_QMNJ, d4)).toEqual([{ value: 1.5, qc: QC.RAW, batch_id: live4 }]);
    expect(await revisionsAt(UCKANGE_QMNJ, d4)).toEqual([]);
    expect(ledger).toEqual({
      provider_values: 2,
      kept: 2,
      inserted: 0,
      revised: 1,
      skipped: 1,
      dropped: 0,
      reconciled: true,
    });
    // An aggregate series takes no rollup (plan §3.5).
    expect(await h.count(`obs_1d WHERE series_id = ${await h.seriesId(UCKANGE_QMNJ)}`)).toBe(0);
  });

  it('no row of any of the three at or after DATA_FLOOR, even when a forged line’s chunk says so', async () => {
    // DE-8: a decade member of Stah that runs past the floor (the recorded member format, values generated).
    const rows = ['station_name;station_no;dateTime;value[cm]'];
    for (let t = Date.parse('2026-07-30T00:00:00+01:00'); t < Date.parse('2026-08-03T00:00:00+01:00'); t += 900_000)
      rows.push(
        `Stah;2829100000100;${new Date(t + 3_600_000).toISOString().slice(0, 19)}+01:00;${100 + ((t / 900_000) % 7)}`,
      );
    const zip = Buffer.from(
      zipSync({ '2829100000100_Stah_2020-2029_Wasserstand_cm.csv': strToU8(`${rows.join('\n')}\n`) }),
    );
    const de8 = await p14bJob('DE-8', DE8.spec, 'Rureinzugsgebiet/2020', '2026-07-01', '2026-08-01');
    const a = await p14bLoad({ ...DE8, job: de8 }, zip, ['2026-07-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
    // 2026-07-29T23:00Z .. the floor: 2 days and 1 hour of 15-minute grid points.
    expect(await rowsIn(STAH, '2026-07-29T23:00:00Z', FLOOR)).toBe(2 * 96 + 4);
    expect(await rowsIn(STAH, FLOOR, '2027-01-01')).toBe(0);

    // FR-2: the days 2026-07-28 .. 2026-08-04, validated.
    const days = Array.from({ length: 8 }, (_, i) => new Date(Date.UTC(2026, 6, 28 + i)).toISOString().slice(0, 10));
    const fr2 = await p14bJob('FR-2', FR2.spec, UCKANGE_QMNJ, '2009-12-27', '2026-08-01');
    const b = await p14bLoad({ ...FR2, job: fr2 }, elabBody(days.map((d, i) => elab(d, 40_000 + i, 16))), [
      '2026-07-01T00:00:00.000Z',
      '2026-09-01T00:00:00.000Z',
    ]);
    expect(await rowsIn(UCKANGE_QMNJ, '2026-07-28', FLOOR)).toBe(4);
    expect(await rowsIn(UCKANGE_QMNJ, FLOOR, '2027-01-01')).toBe(0);
    expect(b.ledger).toMatchObject({ provider_values: 8, kept: 4, dropped: 4 });

    // CH-9: 5-minute records from 2026-07-31T22:00Z to 2026-08-01T02:00Z, pegel and pegelhoehe consistent.
    const records = [];
    for (let t = Date.parse('2026-07-31T22:00:00Z'); t < Date.parse('2026-08-01T02:00:00Z'); t += 300_000) {
      const cm = 500 + ((t / 300_000) % 9);
      records.push({
        timestamp: new Date(t).toISOString().replaceAll('.000Z', '+00:00'),
        abfluss: 900,
        pegelhoehe: cm,
        pegel: (24_000 + cm) / 100,
      });
    }
    const ch9 = await p14bJob('CH-9', CH9.spec, '100089', '2026-07-01', '2026-08-01');
    const c = await p14bLoad({ ...CH9, job: ch9 }, Buffer.from(JSON.stringify(records)), [
      '2026-07-31T00:00:00.000Z',
      '2026-08-02T00:00:00.000Z',
    ]);
    for (const key of [BASEL_W, BASEL_Q]) {
      expect(await rowsIn(key, '2026-07-31T22:00:00Z', FLOOR), key).toBe(12);
      expect(await rowsIn(key, FLOOR, '2027-01-01'), key).toBe(0);
    }
    expect(c.ledger).toMatchObject({ provider_values: 96, kept: 24 });
    console.info(
      `past the floor: DE-8 ${JSON.stringify(a.ledger)} FR-2 ${JSON.stringify(b.ledger)} CH-9 ${JSON.stringify(c.ledger)}`,
    );

    // Nothing of the three specs at or after the floor in any series, and every line of their jobs reconciles.
    const { rows: late } = await h.t.admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM obs o JOIN ingest_batch b ON b.id = o.batch_id
       WHERE b.spec_id = ANY($1) AND o.ts >= $2`,
      [[DE8.spec, FR2.spec, CH9.spec], FLOOR],
    );
    expect(late).toEqual([{ n: 0 }]);
    const { rows: ledger } = await h.t.admin.query<{ reconciled: boolean; n: number }>(
      'SELECT reconciled, count(*)::int AS n FROM backfill_chunk WHERE job_id = ANY($1) GROUP BY 1',
      [p14bJobs],
    );
    expect(ledger).toEqual([{ reconciled: true, n: p14bJobs.length }]); // one line per job
  });
});
