import { type ObsRow, QC } from '@rws/core';
import fc from 'fast-check';
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
