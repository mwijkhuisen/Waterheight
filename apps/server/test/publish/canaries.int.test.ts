import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CANARIES, floorBucket } from '@rws/contracts';
import { Kysely, PostgresDialect } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classCoverage, readStates, StaticCache } from '../../src/api/states.ts';
import { DisplayWindow } from '../../src/api/window.ts';
import type { ChannelAudience } from '../../src/db/audience.ts';
import type { DB } from '../../src/db/generated.ts';
import type { Db } from '../../src/db/pool.ts';
import { publishTail } from '../../src/load/migrate.ts';
import { vigicruesSections } from '../../src/load/tables.ts';
import { Publisher, type RenderCtx, type Renderers } from '../../src/publish/cycle.ts';
import { publishOnce } from '../../src/publish/index.ts';
import { RENDERERS } from '../../src/publish/render/index.ts';
import { Output } from '../../src/publish/write.ts';
import { type Harness, harness } from '../load/harness.ts';
import { OWNER_IDS } from './s2-ctx.ts';
import { contract, walk } from './tree.ts';

// P9a (plan §4.10, "the file canaries"): both publishers on a seeded database, every file of both trees walked
// (siblings decompressed and byte-equal), parsed with its family's contract, and searched for what must never be
// there: the withheld canary anywhere, owner data in a public file, a series without display, and (§9 C5) a series
// without history_export outside latest.json and anything older than its window.

const NOW = Date.parse('2026-10-04T12:00:00Z');
const BASE = Date.parse('2026-10-01T00:00:00Z');
const MARK = { nodisplay: '424242.5', ownerOnly: '313131.5', histOld: '555555.5', histNew: '666666.5' } as const;
let h: Harness;
const ids = {} as Record<'a' | 'b' | 'withheld' | 'nodisplay' | 'ownerOnly' | 'hist', number>;
const dirs: string[] = [];

type Tree = { files: Map<string, string> };
const trees = {} as Record<ChannelAudience, Tree>;
/** Each publisher's pool (rws_owner_api allows 4 connections): the #218 describe below reuses them. */
const pools = {} as Record<ChannelAudience, Db>;

const q = (text: string, values: unknown[] = []) => h.t.admin.query(text, values);
const iso = (ms: number) => new Date(ms).toISOString();

async function mkSeries(
  station: string,
  key: string,
  over: { audience?: string; override?: object } = {},
): Promise<number> {
  await q("INSERT INTO station (id, name, country, tier) VALUES ($1, $2, 'NL', 2)", [station, `name of ${station}`]);
  const r = await q(
    `INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                         native_step, expected_step, staleness_limit, role, audience, lic_override)
     VALUES ($1, 'NL-1', 'H', 'stage', $2, 'cm', 1, 'LOCAL', '10 min', '10 min', '45 min', 'primary', $3::audience, $4)
     RETURNING id`,
    [station, key, over.audience ?? null, over.override === undefined ? null : JSON.stringify(over.override)],
  );
  return r.rows[0].id;
}
/** Observations every 10 min from `from` to `to` (ms), value `value(k)`. */
const obs = (series: number, from: number, to: number, value: string) =>
  q(
    `INSERT INTO obs (series_id, ts, value, qc, batch_id)
     SELECT $1, to_timestamp(k / 1000.0), ${value}, 0, 0
     FROM generate_series($2::bigint, $3::bigint, 600000) k`,
    [series, from, to],
  );

/** The series ids a parsed file names. */
function idsIn(rel: string, body: Record<string, unknown>): number[] {
  if (rel === 'stations.json')
    return (body.stations as { series: { id: number }[] }[]).flatMap((s) => s.series.map((x) => x.id));
  if (rel.startsWith('series/')) return (body.series as { id: number }[]).map((x) => x.id);
  if (Array.isArray(body.series)) return (body.series as unknown[]).filter((x): x is number => typeof x === 'number');
  return [];
}

beforeAll(async () => {
  h = await harness();
  await q(`UPDATE app_meta SET value = '"2026-10-01T00:00:00Z"' WHERE key = 'display_start'`);
  await q(`SELECT ensure_partitions('2026-09-28'::timestamptz, '2026-10-06'::timestamptz)`);
  // Two real NL-1 stage series (their NL-4 bands classify them, so the files hold bases).
  const real = await q(
    `SELECT s.id FROM series s WHERE s.source_id = 'NL-1' AND s.active AND s.role = 'primary' AND s.quantity = 'H'
       AND NOT EXISTS (SELECT 1 FROM series o WHERE o.station_id = s.station_id AND o.id <> s.id)
     ORDER BY s.id LIMIT 2`,
  );
  ids.a = real.rows[0].id;
  ids.b = real.rows[1].id;
  ids.withheld = await mkSeries('nl.canary.withheld', 'canary-withheld', { audience: 'off' });
  ids.nodisplay = await mkSeries('nl.p9a.nodisplay', 'p9a-nodisplay', { override: { display: false } });
  ids.ownerOnly = await mkSeries('nl.p9a.owneronly', 'p9a-owneronly', { audience: 'owner' });
  ids.hist = await mkSeries('nl.p9a.hist', 'p9a-hist', { override: { history_export: false } });
  await q("UPDATE source SET history_window = '24 hours' WHERE id = 'NL-1'");
  for (const s of [ids.a, ids.b]) await obs(s, BASE, NOW, `100 + (k - ${BASE}) / 600000 * 0.5`);
  await obs(ids.withheld, NOW - 3_600_000, NOW, String(CANARIES.withheld.value));
  await obs(ids.nodisplay, BASE, NOW, MARK.nodisplay);
  await obs(ids.ownerOnly, BASE, NOW, MARK.ownerOnly);
  await obs(ids.hist, NOW - 3 * 86_400_000, NOW - 3 * 86_400_000 + 3_600_000, MARK.histOld);
  await obs(ids.hist, NOW - 4 * 3_600_000, NOW, MARK.histNew);
  // The withheld series also has a reference and a forecast run: its value in every table that can leak.
  await q(
    `INSERT INTO reference_value (series_id, source_id, kind, value, unit, semantics, valid)
     VALUES ($1, 'NL-1', 'MHW', ${CANARIES.withheld.value}, 'cm', 'statistical', tstzrange('2020-01-01', NULL))`,
    [ids.withheld],
  );
  const run = await q(
    `INSERT INTO forecast_run (series_id, source_id, issued_at, first_valid, last_valid, fetched_at, content_hash, kind)
     VALUES ($1, 'NL-1', $2, $2, $3, $2, decode(md5('p9a-withheld'), 'hex'), 'deterministic') RETURNING id`,
    [ids.withheld, iso(NOW - 3_600_000), iso(NOW + 86_400_000)],
  );
  await q(
    `INSERT INTO forecast_value (run_id, valid_ts, value)
     SELECT $1, $2::timestamptz + h * interval '1 hour', ${CANARIES.withheld.value} FROM generate_series(0, 20) h`,
    [run.rows[0].id, iso(NOW - 3_600_000)],
  );
  // A visible forecast too, so forecast/latest.json is not empty in the public tree.
  const ok = await q(
    `INSERT INTO forecast_run (series_id, source_id, issued_at, first_valid, last_valid, fetched_at, content_hash, kind)
     VALUES ($1, 'NL-1', $2, $2, $3, $2, decode(md5('p9a-a'), 'hex'), 'deterministic') RETURNING id`,
    [ids.a, iso(NOW - 3_600_000), iso(NOW + 86_400_000)],
  );
  await q(
    `INSERT INTO forecast_value (run_id, valid_ts, value)
     SELECT $1, $2::timestamptz + h * interval '1 hour', 150 + h FROM generate_series(0, 20) h`,
    [ok.rows[0].id, iso(NOW - 3_600_000)],
  );
  await publishTail(h.dbAs('rws_migrator', 1).db, new Date(NOW));
  for (const [family, role] of [
    ['public', 'rws_publish'],
    ['owner', 'rws_owner_api'],
  ] as const) {
    const dir = mkdtempSync(join(tmpdir(), `rws-canary-${family}-`));
    dirs.push(dir);
    pools[family] = h.dbAs(role, 3);
    await publishOnce(pools[family].db, family, dir, { now: NOW, render: RENDERERS });
    trees[family] = { files: walk(dir) };
  }
}, 300_000);
afterAll(async () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  await h.close();
});

const all = (family: ChannelAudience) => [...trees[family].files];
const parsed = (family: ChannelAudience) =>
  all(family).map(([rel, text]) => [rel, JSON.parse(text) as Record<string, unknown>] as const);

describe('the files of both publishers', { timeout: 300_000 }, () => {
  for (const family of ['public', 'owner'] as const) {
    it(`${family}: every file parses with its family's contract, and the tree is not trivially small`, () => {
      expect(trees[family].files.size).toBeGreaterThan(300);
      for (const [rel, text] of all(family))
        expect(() => contract(family, rel).parse(JSON.parse(text)), rel).not.toThrow();
    });

    it(`${family}: the withheld canary, its station and its series are in no file`, () => {
      for (const [rel, text] of all(family)) {
        for (const s of [CANARIES.withheld.text, CANARIES.withheld.real, 'nl.canary.withheld', 'canary-withheld'])
          expect(text, `${rel} has ${s}`).not.toContain(s);
      }
      for (const [rel, body] of parsed(family)) expect(idsIn(rel, body), rel).not.toContain(ids.withheld);
    });

    it(`${family}: no series without effective lic_display is in any file`, () => {
      for (const [rel, text] of all(family)) {
        for (const s of [MARK.nodisplay, 'nl.p9a.nodisplay']) expect(text, `${rel} has ${s}`).not.toContain(s);
      }
      for (const [rel, body] of parsed(family)) expect(idsIn(rel, body), rel).not.toContain(ids.nodisplay);
    });

    it(`${family}: a series without history_export is in latest.json and stations.json only; nothing older than its window anywhere`, () => {
      for (const [rel, text] of all(family)) {
        expect(text, `${rel} has the value older than the window`).not.toContain(MARK.histOld);
        if (rel !== 'latest.json') expect(text, `${rel} has a history value`).not.toContain(MARK.histNew);
      }
      for (const [rel, body] of parsed(family))
        if (rel !== 'latest.json' && rel !== 'stations.json') expect(idsIn(rel, body), rel).not.toContain(ids.hist);
      // stations.json is metadata: it lists the series while the window (1 day) exceeds its staleness + 1 h.
      expect(idsIn('stations.json', JSON.parse(trees[family].files.get('stations.json') as string))).toContain(
        ids.hist,
      );
      // latest.json carries it only inside its window, and the value of that window is never the old one.
      const latest = JSON.parse(trees[family].files.get('latest.json') as string) as {
        series: number[];
        value: number[];
      };
      const at = latest.series.indexOf(ids.hist);
      if (at >= 0) expect(latest.value[at]).toBe(Number(MARK.histNew));
    });
  }

  it('public: no owner datum in any file (canary value, station, source, attribution, private basis, owner-only series)', async () => {
    const owner = await q("SELECT id, private_basis->>'clause' AS clause FROM source WHERE audience = 'owner'");
    const ownerTexts = await q(
      `SELECT a.text FROM attribution a JOIN source s ON s.id = a.source_id WHERE s.audience = 'owner'
         AND a.text NOT IN (SELECT a2.text FROM attribution a2 JOIN source s2 ON s2.id = a2.source_id WHERE s2.audience = 'public')`,
    );
    expect(owner.rows.length).toBeGreaterThan(3);
    expect(ownerTexts.rows.map((r) => r.text)).toContain('Owner canary: synthetic test data');
    const never = [
      CANARIES.owner.text,
      CANARIES.owner.real,
      'nl.canary.owner',
      'CANARY-OWNER',
      'owner-canary',
      MARK.ownerOnly,
      'nl.p9a.owneronly',
      ...owner.rows.map((r) => r.clause as string),
      ...ownerTexts.rows.map((r) => r.text as string),
    ];
    for (const [rel, text] of all('public')) for (const s of never) expect(text, `${rel} has ${s}`).not.toContain(s);
    for (const [rel, body] of parsed('public')) {
      expect(idsIn(rel, body), rel).not.toContain(ids.ownerOnly);
    }
  });

  // P12b, launch checklist: the two files that name sources hold public sources only, whichever way the canaries run.
  it('public: sources.json and status.json name only public sources and neither canary', async () => {
    const pub = new Set(
      (await q("SELECT id FROM source WHERE audience = 'public' AND NOT canary")).rows.map((r) => r.id as string),
    );
    const files = trees.public.files;
    const sources = JSON.parse(files.get('sources.json') as string) as { sources: { id: string }[] };
    const status = JSON.parse(files.get('status.json') as string) as { sources: { id: string }[] };
    expect(sources.sources.map((s) => s.id).sort()).toEqual([...pub].sort());
    for (const { id } of [...sources.sources, ...status.sources]) expect(pub.has(id), id).toBe(true);
    for (const rel of ['sources.json', 'status.json']) {
      const text = files.get(rel) as string;
      for (const c of [CANARIES.owner.text, CANARIES.owner.real, CANARIES.withheld.text, CANARIES.withheld.real])
        expect(text, `${rel} has ${c}`).not.toContain(c);
      for (const id of OWNER_IDS) expect(text, `${rel} names ${id}`).not.toContain(`"${id}"`);
    }
  });

  it('owner: the canary value, station, source, attribution text and private basis are in the owner files', async () => {
    const files = trees.owner.files;
    const text = (rel: string) => files.get(rel) as string;
    const clause = (await q("SELECT private_basis->>'clause' AS c FROM source WHERE id = 'CANARY-OWNER'")).rows[0]
      .c as string;
    expect(text('latest.json')).toContain(CANARIES.owner.real);
    expect(text('latest.json')).toContain(MARK.ownerOnly);
    expect(text('forecast/latest.json')).toContain(CANARIES.owner.real);
    expect(text('series/nl.canary.owner/recent.json')).toContain(CANARIES.owner.real);
    expect(text('stations.json')).toContain('nl.canary.owner');
    expect(text('stations.json')).toContain('nl.p9a.owneronly');
    expect(text('sources.json')).toContain('CANARY-OWNER');
    expect(text('sources.json')).toContain('Owner canary: synthetic test data');
    // The private basis is in sources.json, escaped as JSON would.
    expect(
      JSON.parse(text('sources.json')).sources.find((s: { id: string }) => s.id === 'CANARY-OWNER').privateBasis.clause,
    ).toBe(clause);
    const recent = [...files.keys()].filter((r) => r.startsWith('recent/') && r.endsWith('.json'));
    expect(recent.length).toBeGreaterThan(100);
    for (const rel of recent.slice(0, 10)) expect(text(rel), rel).toContain(CANARIES.owner.real);
    expect([...files.keys()].some((r) => r.startsWith('settled/') || r.startsWith('frames/'))).toBe(false);
  });
});

// #218: the reads the renderers of a cycle share (render/series.ts `once`, hung on the cycle's RenderCtx), on this seed
// plus a loader commit and dated source health, so the shared commit and dates are real values. Last in the file: the
// trees above were written before these rows.
describe('the reads a cycle shares (#218)', { timeout: 300_000 }, () => {
  const FAMILIES = ['public', 'owner'] as const;
  const COMMIT = iso(NOW - 300_000);
  /** Every render with its own copy of the context: nothing is shared, each render reads for itself as before. */
  const unshared = Object.fromEntries(
    Object.entries(RENDERERS).map(([name, fn]) => [
      name,
      (c: RenderCtx, ...a: unknown[]) => (fn as (c: RenderCtx, ...x: unknown[]) => Promise<unknown>)({ ...c }, ...a),
    ]),
  ) as Renderers;
  /** status.json's lastDayRender.seconds is a wall-clock duration (cycle.ts): the one field two runs may differ in. */
  const comparable = (files: Map<string, string>) =>
    new Map(
      [...files].map(([rel, text]) => {
        if (rel !== 'status.json') return [rel, text] as const;
        const s = JSON.parse(text);
        if (s.publisher.lastDayRender !== null) s.publisher.lastDayRender.seconds = 0;
        return [rel, JSON.stringify(s)] as const;
      }),
    );
  const publish = async (family: ChannelAudience, render: Renderers) => {
    const dir = mkdtempSync(join(tmpdir(), `rws-o2-${family}-`));
    dirs.push(dir);
    await publishOnce(pools[family].db, family, dir, { now: NOW, render });
    return comparable(walk(dir));
  };
  /** One statement each (unique in src): readFacts, sourceDates, lastCommit and the current bucket's states. */
  const FRAGMENTS = {
    facts: 'AS history_window_s',
    dates: 'AS provider_updated',
    commit: 'max(loaded_at)',
    statesNow: 'SELECT source_id, last_fetch_ok FROM',
  } as const;

  beforeAll(async () => {
    await q(
      `INSERT INTO ingest_batch (id, source_id, spec_id, archive_key, fetched_at, adapter_version, parse_status, loaded_at)
       VALUES (9001, 'NL-1', 'nl-1-obs-key', 'o2/9001', $1, 1, 'ok', $2)`,
      [iso(NOW - 600_000), COMMIT],
    );
    const dated = await q(
      `INSERT INTO source_health (source_id, last_fetch_ok, newest_ts, status, detail)
       SELECT DISTINCT a.source_id, $1::timestamptz, $2::timestamptz, 'ok',
              CASE WHEN a.source_id = 'DE-6' THEN jsonb_build_object('provider_updated', $3::text) ELSE '{}' END
       FROM attribution a WHERE a.date_kind IS NOT NULL
       ON CONFLICT (source_id) DO UPDATE
         SET last_fetch_ok = EXCLUDED.last_fetch_ok, newest_ts = EXCLUDED.newest_ts, detail = EXCLUDED.detail`,
      [iso(NOW - 120_000), iso(NOW - 600_000), iso(NOW - 900_000)],
    );
    expect(dated.rowCount).toBeGreaterThan(0);
  });

  it('every file is byte-identical to the one each render reading for itself writes; both families at once', async () => {
    const shared = await Promise.all(FAMILIES.map((f) => publish(f, RENDERERS)));
    for (const [i, family] of FAMILIES.entries()) {
      const files = shared[i] as Map<string, string>;
      const alone = await publish(family, unshared);
      expect([...files.keys()].sort()).toEqual([...alone.keys()].sort());
      expect([...files].filter(([rel, text]) => alone.get(rel) !== text).map(([rel]) => rel)).toEqual([]);
      // The shared commit and dates are real values here, not nulls that would match anyway.
      expect(JSON.parse(files.get('meta.json') as string).latestFrom).toBe(COMMIT);
      expect(JSON.parse(files.get('status.json') as string).loader.lastCommit).toBe(COMMIT);
      expect(
        JSON.parse(files.get('sources.json') as string).sources.some((s: { date: unknown }) => s.date !== null),
      ).toBe(true);
      // Run side by side, no read crossed families: no withheld canary anywhere, no owner canary in a public file.
      const never: string[] = [CANARIES.withheld.text, CANARIES.withheld.real];
      if (family === 'public') never.push(CANARIES.owner.text, CANARIES.owner.real);
      for (const [rel, text] of files) for (const s of never) expect(text, `${rel} has ${s}`).not.toContain(s);
    }
  });

  it('a cycle reads the facts, dates, last commit and current states once; the next cycle, same clock, again', async () => {
    for (const family of FAMILIES) {
      const seen = { facts: 0, dates: 0, commit: 0, statesNow: 0 };
      // A second Kysely over the family's pool that sees every statement (never destroyed: it shares the pool).
      const db = new Kysely<DB>({
        dialect: new PostgresDialect({ pool: pools[family].pool }),
        log: (e) => {
          if (e.level !== 'query') return;
          for (const [k, f] of Object.entries(FRAGMENTS)) if (e.query.sql.includes(f)) seen[k as keyof typeof seen]++;
        },
      });
      // The static rows (with their own sourceDates read) are the app's 60 s cache, not this memo: read beforehand.
      const cache = new StaticCache(60_000, () => NOW);
      await cache.get(pools[family].db, family);
      const dir = mkdtempSync(join(tmpdir(), `rws-o2-count-${family}-`));
      dirs.push(dir);
      const publisher = new Publisher({
        db,
        family,
        out: new Output(dir),
        render: RENDERERS,
        window: new DisplayWindow(db, { error: () => undefined }, family),
        now: () => NOW,
        build: 'dev',
        sections: vigicruesSections(),
        cache,
        inputs: undefined,
        log: { error: () => undefined },
        brownout: () => false,
        budgetMs: Number.POSITIVE_INFINITY,
        settledPerCycle: Number.POSITIVE_INFINITY,
        strict: true,
      });
      await publisher.cycle();
      expect([family, seen]).toEqual([family, { facts: 1, dates: 1, commit: 1, statesNow: 1 }]);
      await publisher.cycle();
      expect([family, seen]).toEqual([family, { facts: 2, dates: 2, commit: 2, statesNow: 2 }]);
    }
  });

  it("status.json's classification from latest.json's read (tide rows included) equals its own read's", async () => {
    for (const family of FAMILIES) {
      const opts = {
        now: NOW,
        current: true,
        sections: vigicruesSections(),
        cache: new StaticCache(60_000, () => NOW),
      };
      const t = floorBucket(NOW);
      const own = await readStates(pools[family].db, family, t, opts);
      const shared = await readStates(pools[family].db, family, t, { ...opts, tide: true });
      expect(shared.tide).toBeDefined();
      expect(classCoverage(shared)).toEqual(classCoverage(own));
    }
  });
});
