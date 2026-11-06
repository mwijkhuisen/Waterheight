import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bareLine } from '../../../../scripts/fixture-archive.ts';
import { INSTANTANEOUS } from '../../src/adapters/nl-1/normalise.ts';
import { parseWaarnemingen, type Waarnemingen } from '../../src/adapters/nl-1/parse.ts';
import { sha256 } from '../../src/archive/writer.ts';
import { beforeFix } from '../../src/backfill/census.ts';
import { familyViews, OBS_AT } from '../../src/db/audience.ts';
import { LOAD_ADAPTERS, type LoadAdapter, loadNl1Backfill, type SpecLoader } from '../../src/load/adapters.ts';
import { replay } from '../../src/load/replay.ts';
import { rawFixture, registryOf } from '../adapters/registry.ts';
import { type Harness, harness } from './harness.ts';

// #184 stage 2, PR A: the owner's replay of the archived NL-1 backfill lines onto a database as production holds it.
// The archive holds the five chunks recorded for stage 2 (cut by scripts/lib/trim-nl-1.ts) and the two older ones (Lith
// 2003, Lobith Q 2010). Replay 1 loads them with the code before #184 (a daily mean merged into the series, the history
// under another method unregistered), replay 2 with stage 1 (every processed list `processed`, no twin), replay 3 with
// the real loader: the twins fill, no row of a primary series changes, and the only primary rows it adds are Megen's
// two readings that the old merge withheld as conflicts with a daily mean (D-1). A fourth replay writes nothing. The
// twins are in no view or at-T function of either family. The lines have no `backfill_job` row (no ledger row).

const SPEC = 'nl-1-backfill-obs';
const URL_ = 'https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen';
const FIRST_FETCH = Date.parse('2026-11-06T08:00:00Z');
const FIXTURES = [
  'nl-1-backfill-megen-q-20240301',
  'nl-1-backfill-megen-q-20231228',
  'nl-1-backfill-lobith-q-20170101',
  'nl-1-backfill-lith-h-19930904',
  'nl-1-backfill-maastricht-q-20160301',
  'nl-1-backfill-lith-h-20030129',
  'nl-1-backfill-lobith-q-20100101',
] as const;
const MEGEN_Q = 'megen.maas/Q/NVT/other:F103';
/** The two Megen readings at a daily mean's stamp (recorded chunk nl-1-backfill-megen-q-20231228). */
const MEGEN_NEW = ['2023-12-30T23:00:00.000Z', '2023-12-31T23:00:00.000Z'];
/** A value no fixture holds, as a real: written into twins inside the display window, it must show nowhere. */
const CANARY = 271828;
/** The same kind of value in a primary series: the sweep's positive control. */
const CONTROL = 314159;

const registry = registryOf('NL-1');
/** The #184 history twins: every NL-1 twin but the TAW series of a Meuse gauge. */
const isHistory = (key: string) => registry.get(key)?.role === 'twin' && !key.includes('/TAW/');
const chunkOf = (name: string) => {
  const { request } = rawFixture('NL-1', name).meta as unknown as { request: { from: string; to: string } };
  return { from: `${request.from}T00:00:00.000Z`, to: `${request.to}T00:00:00.000Z` };
};

/** The NL-1 backfill loader with its run replaced (the earlier stages of the code, on a registry without the twins). */
const withRun = (run: SpecLoader['run']): Readonly<Record<string, LoadAdapter>> => {
  const nl1 = LOAD_ADAPTERS['NL-1'] as LoadAdapter;
  const spec = nl1.specs[SPEC] as SpecLoader;
  return { ...LOAD_ADAPTERS, 'NL-1': { ...nl1, specs: { ...nl1.specs, [SPEC]: { ...spec, run } } } };
};
const noTwins = <T extends { role?: string }>(r: ReadonlyMap<string, T>) =>
  new Map([...r].filter(([k]) => !isHistory(k)));
/** Before #184: every processed list read as instantaneous (census.ts `beforeFix`), and no history twin. */
const PRE_184 = withRun((b, c) =>
  loadNl1Backfill(beforeFix(parseWaarnemingen(b)), { ...c, registry: noTwins(c.registry) }),
);
/** Stage 1 (#186): every processed list is `processed` (no twin to take it, no Megen reading). */
const asProcessed = (lists: Waarnemingen[]): Waarnemingen[] =>
  lists.map((l) =>
    l.aquo.WaardeBewerkingsMethode.Code === INSTANTANEOUS
      ? l
      : { ...l, aquo: { ...l.aquo, WaardeBewerkingsMethode: { ...l.aquo.WaardeBewerkingsMethode, Code: 'STAGE1' } } },
  );
const STAGE_1 = withRun((b, c) =>
  loadNl1Backfill(asProcessed(parseWaarnemingen(b)), { ...c, registry: noTwins(c.registry) }),
);

let h: Harness;
const deps = (adapters?: Readonly<Record<string, LoadAdapter>>) => ({
  db: h.load.db,
  reader: h.reader,
  alert: (code: string, fields: Record<string, string | number> = {}) => h.alerts.push({ code, fields }),
  now: () => new Date(FIRST_FETCH + 86_400_000),
  ...(adapters === undefined ? {} : { adapters }),
});
const ARGS = { source: 'NL-1', spec: SPEC, from: '2026-11-06', to: '2026-11-06', dryRun: false } as const;

type Row = { key: string; role: string; ts: string; value: number; qc: number };
/** Every stored NL-1 row with its series' key and role (the base tables, never a view). */
const rows = async (): Promise<Row[]> =>
  (
    await h.t.admin.query<Row>(
      `SELECT s.provider_key AS key, s.role, to_char(o.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ts,
              o.value, o.qc
       FROM obs o JOIN series s ON s.id = o.series_id WHERE s.source_id = 'NL-1' ORDER BY 1, 3`,
    )
  ).rows;
const id = (r: Row) => `${r.key}\n${r.ts}`;

describe('the stage-2 replay of the history twins (#184 PR A)', { timeout: 180_000 }, () => {
  let afterStage1: Row[];
  let stage2: Awaited<ReturnType<typeof replay>>;
  /** What the real loader makes of each chunk, per series: the expectation of the twins' rows. */
  const expected = new Map<string, number>();

  beforeAll(async () => {
    h = await harness();
    for (const [i, name] of FIXTURES.entries()) {
      const body = rawFixture('NL-1', name).body;
      const when = new Date(FIRST_FETCH + (i + 1) * 60_000);
      const hash = sha256(body);
      const { key, stored } = await h.archive.put('NL-1', SPEC, when, body, hash);
      const chunk = chunkOf(name);
      await h.archive.append(
        bareLine('NL-1', SPEC, when, {
          request: { method: 'POST', url: URL_ },
          sha256: hash,
          bytes: body.length,
          stored_bytes: stored,
          key,
          validity: { ok: true, reason: null, count: 1 },
          retention: 'backfill',
          backfill: { job: i + 1, chunk: 0, ...chunk },
        }),
      );
      const out = loadNl1Backfill(parseWaarnemingen(body), {
        registry,
        fetchedAt: when.getTime(),
        backfill: { from: Date.parse(chunk.from), to: Date.parse(chunk.to) },
      });
      for (const r of out.obs) if (isHistory(r.series)) expected.set(r.series, (expected.get(r.series) ?? 0) + 1);
    }
    expect((await replay(deps(PRE_184), ARGS)).quarantined).toBe(0);
    expect((await replay(deps(STAGE_1), ARGS)).quarantined).toBe(0);
    afterStage1 = await rows();
    stage2 = await replay(deps(), ARGS);
  }, 180_000);
  afterAll(() => h?.close());

  it('before stage 2 no twin holds a row, and Megen holds the 2024 readings the old code stored', () => {
    expect(afterStage1.filter((r) => isHistory(r.key))).toEqual([]);
    expect(afterStage1.filter((r) => r.key === MEGEN_Q && r.ts.startsWith('2024-03-0'))).toHaveLength(288);
  });

  it('the real loader fills the twins: quarantined 0, n_changed 0, n_new = the twin rows and the two Megen readings', async () => {
    const twinRows = [...expected.values()].reduce((n, v) => n + v, 0);
    expect(stage2).toEqual({ lines: 7, loaded: 7, quarantined: 0, skipped: 0, n_new: twinRows + 2, n_changed: 0 });
    const now = await rows();
    const perTwin = new Map<string, number>();
    for (const r of now) if (isHistory(r.key)) perTwin.set(r.key, (perTwin.get(r.key) ?? 0) + 1);
    expect(Object.fromEntries([...perTwin].sort())).toEqual(Object.fromEntries([...expected].sort()));
    // Megen F006 and F103 daily means, Lobith F216 and its daily mean, Lith F001 and its daily mean, Lith F007's daily
    // mean (also from the 2003 chunk), Borgharen F006's daily mean.
    expect(perTwin.size).toBe(8);
    expect(now.filter((r) => isHistory(r.key)).every((r) => r.role === 'twin' && (r.qc & 512) !== 0)).toBe(true);
  });

  it('no row of a primary series changes; the only new primary rows are the two Megen readings (D-1)', async () => {
    const now = new Map((await rows()).filter((r) => !isHistory(r.key)).map((r) => [id(r), r]));
    for (const r of afterStage1) expect([id(r), now.get(id(r))]).toEqual([id(r), r]);
    const added = [...now.values()].filter((r) => !afterStage1.some((o) => id(o) === id(r)));
    expect(added.map((r) => [r.key, r.ts])).toEqual(MEGEN_NEW.map((ts) => [MEGEN_Q, ts]));
  });

  it('a fourth replay writes nothing', async () => {
    const before = await h.checksums();
    const r = await replay(deps(), ARGS);
    expect(r).toMatchObject({ lines: 7, loaded: 7, quarantined: 0, n_new: 0, n_changed: 0 });
    expect(await h.checksums()).toEqual(before);
  });

  it('no twin is in any view or at-T function of either family, even with rows inside the display window', async () => {
    const twinIds = (
      await h.t.admin.query<{ id: number }>(
        "SELECT id FROM series WHERE source_id = 'NL-1' AND role = 'twin' AND provider_key NOT LIKE '%/TAW/%'",
      )
    ).rows.map((r) => String(r.id));
    expect(twinIds).toHaveLength(56);
    // Canary rows in two twins (an instantaneous one and a daily mean) where the site shows data, and the control
    // value in their primary (Lobith Q F230): the sweep must find the control, or finding no canary proves nothing.
    const at = '2026-10-01T00:00:00Z';
    await h.t.admin.query(`SELECT ensure_partitions('2026-09-01T00:00:00Z', '2026-11-01T00:00:00Z')`);
    const write = async (key: string, value: number) => {
      const sid = await h.seriesId(key);
      await h.t.admin.query('INSERT INTO obs (series_id, ts, value, qc, batch_id) VALUES ($1, $2, $3, 0, 0)', [
        sid,
        at,
        value,
      ]);
      await h.t.admin.query('INSERT INTO obs_latest (series_id, ts, value, qc, batch_id) VALUES ($1, $2, $3, 0, 0)', [
        sid,
        at,
        value,
      ]);
      for (const table of ['obs_1h', 'obs_1d'])
        await h.t.admin.query(
          `INSERT INTO ${table} (series_id, bucket, vmin, vmax, vavg, vlast, n, qc_or) VALUES ($1, $2, $3, $3, $3, $3, 1, 0)`,
          [sid, at, value],
        );
    };
    await write('lobith.bovenrijn.tolkamer/Q/NVT/other:F216', CANARY);
    await write('lith.boven/WATHTE/NAP/other:F007/GEM24H', CANARY);
    await write('lobith.bovenrijn.tolkamer/Q/NVT/other:F230', CONTROL);
    const sweep = async (from: string, params: unknown[]) =>
      (
        await h.t.admin.query<{ n: number; c: number; k: number }>(
          `SELECT count(*) FILTER (WHERE to_jsonb(v) ->> 'series_id' = ANY($1::text[]))::int AS n,
                  count(*) FILTER (WHERE row_to_json(v)::text LIKE '%${CANARY}%')::int AS c,
                  count(*) FILTER (WHERE row_to_json(v)::text LIKE '%${CONTROL}%')::int AS k
           FROM ${from} v`,
          params,
        )
      ).rows[0] as { n: number; c: number; k: number };
    for (const audience of ['public', 'owner'] as const) {
      let control = 0;
      for (const view of familyViews(audience)) {
        const { n, c, k } = await sweep(view, [twinIds]);
        expect([view, { n, c }]).toEqual([view, { n: 0, c: 0 }]);
        control += k;
      }
      const atT = await sweep(`${OBS_AT[audience]}($2::timestamptz)`, [twinIds, '2026-10-01T00:05:00Z']);
      expect([audience, { n: atT.n, c: atT.c }]).toEqual([audience, { n: 0, c: 0 }]);
      // The primary's control value is in the views (obs, latest, hourly, daily) and in the at-T answer.
      expect([audience, control >= 4, atT.k]).toEqual([audience, true, 1]);
    }
  });
});
