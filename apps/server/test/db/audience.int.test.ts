import { CANARIES, CANARY_RENDERINGS } from '@rws/contracts';
import { effective } from '@rws/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FORECAST_AT,
  familyViews,
  INGEST_BATCH_COLUMNS,
  LOADER_COLUMNS,
  OBS_AT,
  OWNER_HEALTH_COLUMNS,
  OWNER_ONLY_VIEWS,
  PUBLIC_ONLY_VIEWS,
  SOURCE_HEALTH_COLUMNS,
  TWIN_CHECK_COLUMNS,
  VIEWS,
} from '../../src/db/audience.ts';
import {
  NEVER_OWNER,
  NEVER_PUBLIC,
  OWNER_CANARY,
  OWNER_CANARY_REAL,
  seedAudienceFixture,
  WITHHELD_CANARY,
  WITHHELD_KEYS,
} from './seed.ts';
import { createTestDb, type TestDb } from './testdb.ts';

// The audience filter at every join (issue #17; invariants 8 and 11). Every
// query below runs as a real reader login, through the view names of audience.ts.

let t: TestDb;
let api: pg.Client;
let owner: pg.Client;
let ids: Record<string, number>;

const PUB = VIEWS.public;
const OWN = VIEWS.owner;

beforeAll(async () => {
  t = await createTestDb();
  ids = await seedAudienceFixture(t.admin);
  api = await t.connectAs('rws_api');
  owner = await t.connectAs('rws_owner_api');
});

afterAll(async () => {
  await t.drop();
});

const column = async (client: pg.Client, sql: string, values: unknown[] = []) =>
  (await client.query({ text: sql, values, rowMode: 'array' })).rows.map((r: unknown[]) => r[0]).sort();

/** Every row of every view, as text: what a reader could ever see. */
async function sweep(client: pg.Client, views: readonly string[]): Promise<string> {
  let text = '';
  for (const view of views) {
    const { rows } = await client.query<{ j: string }>(`SELECT row_to_json(v)::text AS j FROM ${view} v`);
    text += `${view}\n${rows.map((r) => r.j).join('\n')}\n`;
  }
  return text;
}

/** Ten minutes after the fixture's newest rows (they sit on the current hour): inside every staleness limit. */
const FIXTURE_NOW = "date_trunc('hour', now()) + interval '10 minutes'";

/** What the at-T function of a family returns. */
async function sweepAt(client: pg.Client, fn: string): Promise<string> {
  const { rows } = await client.query<{ j: string }>(`SELECT row_to_json(v)::text AS j FROM ${fn}(${FIXTURE_NOW}) v`);
  return rows.map((r) => r.j).join('\n');
}
const found = (text: string, terms: readonly string[]) => terms.filter((term) => text.includes(term));

/**
 * The fixture's forecast runs start at the seed's `now()` and reach two days; each holds one point an hour after it.
 * Seventy minutes later is inside every run, as both the instant of knowledge and the instant asked (Q2).
 */
const FORECAST_NOW = "now() + interval '70 minutes'";

/** What the latest-run-as-of function of a family returns, as text. */
async function sweepForecastAt(client: pg.Client, fn: string, instant = FORECAST_NOW): Promise<string> {
  const { rows } = await client.query<{ j: string }>(
    `SELECT row_to_json(v)::text AS j FROM ${fn}(${instant}, ${instant}) v`,
  );
  return rows.map((r) => r.j).join('\n');
}

describe('series and stations', () => {
  it('pub_* keeps effective audience public and role primary', async () => {
    expect(await column(api, `SELECT station_id FROM ${PUB.series}`)).toEqual([
      'ch.bafu.display-only',
      'ch.bafu.window',
      'ch.bafu.window-export',
      'de.wsv.no-api',
      'nl.rws.public',
      'nl.rws.public2',
    ]);
  });

  it('own_* adds the owner rows and nothing that is off, a mirror or a twin', async () => {
    expect(await column(owner, `SELECT station_id FROM ${OWN.series}`)).toEqual([
      'be.spw.only-owner',
      'be.spw.only-owner', // the series that tried to widen itself to public is still an owner series
      'ch.bafu.display-only',
      'ch.bafu.window',
      'ch.bafu.window-export',
      'de.wsv.no-api',
      'nl.canary.owner',
      'nl.rws.narrowed-owner',
      'nl.rws.public',
      'nl.rws.public2',
    ]);
  });

  it('a station whose only series is owner-audience is absent from the public station view', async () => {
    const pub = await column(api, `SELECT id FROM ${PUB.station}`);
    expect(pub).not.toContain('be.spw.only-owner');
    expect(pub).toContain('nl.rws.public');
    expect(await column(owner, `SELECT id FROM ${OWN.station}`)).toContain('be.spw.only-owner');
  });

  it('a series that narrows a public source to owner or off disappears from pub_*', async () => {
    for (const view of [PUB.series, PUB.api.series]) {
      const series = await column(api, `SELECT id FROM ${view}`);
      expect(series).not.toContain(ids.narrowedOwner);
      expect(series).not.toContain(ids.narrowedOff);
    }
    const own = await column(owner, `SELECT id FROM ${OWN.series}`);
    expect(own).toContain(ids.narrowedOwner);
    expect(own).not.toContain(ids.narrowedOff);
    for (const view of [PUB.obs, PUB.obsLatest, PUB.obs1h, PUB.obs1d, PUB.api.obs, PUB.api.obs1h, PUB.api.obs1d]) {
      const n = await column(api, `SELECT count(*)::int FROM ${view} WHERE series_id = ANY($1)`, [
        [ids.narrowedOwner, ids.narrowedOff, ids.withheld, ids.ownerCanary, ids.onlyOwner, ids.mirror, ids.twin],
      ]);
      expect(n, view).toEqual([0]);
    }
  });

  it('a series cannot widen its source: audience public on an owner source stays owner', async () => {
    expect(await column(api, `SELECT id FROM ${PUB.series}`)).not.toContain(ids.widenAudience);
    const { rows } = await owner.query(`SELECT audience FROM ${OWN.series} WHERE id = $1`, [ids.widenAudience]);
    expect(rows).toEqual([{ audience: 'owner' }]);
  });

  it('mirrors and twins are in neither family, latest values included', async () => {
    for (const [client, family] of [
      [api, PUB],
      [owner, OWN],
    ] as const) {
      for (const view of [family.series, family.api.series]) {
        const series = await column(client, `SELECT id FROM ${view}`);
        expect(series).not.toContain(ids.mirror);
        expect(series).not.toContain(ids.twin);
      }
      for (const view of [family.obsLatest, family.obs]) {
        const seen = await column(client, `SELECT DISTINCT series_id FROM ${view}`);
        expect(seen, view).not.toContain(ids.mirror);
        expect(seen, view).not.toContain(ids.twin);
      }
      expect(await column(client, `SELECT id FROM ${family.station}`)).not.toContain('de.wsv.mirror');
    }
  });
});

describe('the value of every series at T (A§8 Q1)', () => {
  const at = async (client: pg.Client, fn: string, t = FIXTURE_NOW) =>
    column(client, `SELECT series_id FROM ${fn}(${t})`);

  it('returns the visible primary series of its family only', async () => {
    expect(await at(api, OBS_AT.public)).toEqual(
      [ids.public, ids.public2, ids.noApi, ids.displayOnly, ids.window, ids.windowExport].sort(),
    );
    expect(await at(owner, OBS_AT.owner)).toEqual(
      [
        ids.public,
        ids.public2,
        ids.noApi,
        ids.displayOnly,
        ids.window,
        ids.windowExport,
        ids.ownerCanary,
        ids.onlyOwner,
        ids.narrowedOwner,
        ids.widenAudience,
      ].sort(),
    );
  });

  it('carries the last observation forward only within the staleness limit, and honours the history window', async () => {
    // 50 minutes after the newest rows: past the 45-minute limit of every fixture series.
    expect(await at(api, OBS_AT.public, "date_trunc('hour', now()) + interval '50 minutes'")).toEqual([]);
    const tenDays = "date_trunc('hour', now()) - interval '10 days' + interval '20 minutes'";
    const rows = (await api.query(`SELECT series_id, ts, value FROM ${OBS_AT.public}(${tenDays})`)).rows;
    expect(rows).toHaveLength(6);
    for (const r of rows) expect(r.value).toBe(100);
    // 40 days back: outside the 30-day window of the source without history export.
    const fortyDays = "date_trunc('hour', now()) - interval '40 days' + interval '20 minutes'";
    const old = await at(api, OBS_AT.public, fortyDays);
    expect(old).not.toContain(ids.window);
    expect(old).toContain(ids.windowExport);
    expect(await at(owner, OBS_AT.owner, fortyDays)).not.toContain(ids.window);
  });

  it('is executable by its own family only, and is a locked-down SECURITY DEFINER function', async () => {
    const load = await t.connectAs('rws_load');
    const denied = async (client: pg.Client, fn: string) =>
      client.query(`SELECT 1 FROM ${fn}(${FIXTURE_NOW})`).then(
        () => 'ok',
        (e) => e.code,
      );
    expect(await denied(api, OBS_AT.owner)).toBe('42501');
    expect(await denied(owner, OBS_AT.public)).toBe('42501');
    expect(await denied(load, OBS_AT.public)).toBe('42501');
    expect(await denied(load, OBS_AT.owner)).toBe('42501');
    const { rows } = await t.admin.query(
      `SELECT proname, prosecdef, proconfig, provolatile, pg_get_userbyid(proowner) AS owner, prolang::regproc::text AS lang, proacl::text AS acl
       FROM pg_proc WHERE proname = ANY($1) ORDER BY 1`,
      [Object.values(OBS_AT)],
    );
    const common = {
      prosecdef: true,
      // The caller's time zone never reaches the body (review S3).
      proconfig: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC'],
      provolatile: 's',
      owner: 'rws_owner',
    };
    expect(rows).toMatchObject([
      { proname: OBS_AT.owner, ...common, acl: '{rws_owner=X/rws_owner,rws_owner_api=X/rws_owner}' },
      { proname: OBS_AT.public, ...common, acl: '{rws_owner=X/rws_owner,rws_api=X/rws_owner,rws_publish=X/rws_owner}' },
    ]);
    // A hostile search_path and a temporary table named like a base table change nothing.
    await t.admin.query(
      'CREATE TEMP TABLE obs (series_id int, ts timestamptz, value real, qc int2); SET search_path = pg_temp, public',
    );
    try {
      expect((await t.admin.query(`SELECT count(*)::int AS n FROM ${OBS_AT.public}(${FIXTURE_NOW})`)).rows).toEqual([
        { n: 6 },
      ]);
    } finally {
      await t.admin.query('RESET search_path; DROP TABLE pg_temp.obs');
    }
  });

  it('the two functions are one template: the same body except the audience set', async () => {
    const src = async (fn: string) =>
      (await t.admin.query<{ s: string }>('SELECT prosrc AS s FROM pg_proc WHERE proname = $1', [fn])).rows[0]?.s ?? '';
    const pub = await src(OBS_AT.public);
    expect(pub).toContain("e.audience IN ('public')");
    expect(pub.replace("IN ('public')", "IN ('public', 'owner')")).toBe(await src(OBS_AT.owner));
  });
});

describe('the latest forecast run as of T (A§8 Q2)', () => {
  const pairs = async (client: pg.Client, fn: string) =>
    (
      await client.query(
        `SELECT series_id, source_id, value FROM ${fn}(${FORECAST_NOW}, ${FORECAST_NOW}) ORDER BY series_id, source_id`,
      )
    ).rows;

  it('returns the runs of visible primary series of its family, from sources of its family, and nothing else', async () => {
    // The public family: NL-1's run on a public series. Not DE-2's run on the same series (an owner source), not NL-1's
    // run on an owner series, not the owner canary's run, and none of the withheld ones (off, narrowed, mirror, twin).
    expect(await pairs(api, FORECAST_AT.public)).toEqual([{ series_id: ids.public, source_id: 'NL-1', value: 200 }]);
    expect(await pairs(owner, FORECAST_AT.owner)).toEqual([
      { series_id: ids.public, source_id: 'DE-2', value: 201 },
      { series_id: ids.public, source_id: 'NL-1', value: 200 },
      { series_id: ids.ownerCanary, source_id: 'CANARY-OWNER', value: Number(OWNER_CANARY_REAL) },
      { series_id: ids.onlyOwner, source_id: 'NL-1', value: 202 },
    ]);
  });

  it('is executable by its own family only, and is a locked-down SECURITY DEFINER function', async () => {
    const load = await t.connectAs('rws_load');
    const publish = await t.connectAs('rws_publish');
    const denied = async (client: pg.Client, fn: string) =>
      client.query(`SELECT 1 FROM ${fn}(${FORECAST_NOW}, ${FORECAST_NOW})`).then(
        () => 'ok',
        (e) => e.code,
      );
    expect(await denied(api, FORECAST_AT.public)).toBe('ok');
    expect(await denied(publish, FORECAST_AT.public)).toBe('ok');
    expect(await denied(owner, FORECAST_AT.owner)).toBe('ok');
    expect(await denied(api, FORECAST_AT.owner)).toBe('42501');
    expect(await denied(publish, FORECAST_AT.owner)).toBe('42501');
    expect(await denied(owner, FORECAST_AT.public)).toBe('42501');
    expect(await denied(load, FORECAST_AT.public)).toBe('42501');
    expect(await denied(load, FORECAST_AT.owner)).toBe('42501');
    await load.end();
    await publish.end();
    const { rows } = await t.admin.query(
      `SELECT proname, prosecdef, proconfig, provolatile, pg_get_userbyid(proowner) AS owner, prolang::regproc::text AS lang, proacl::text AS acl
       FROM pg_proc WHERE proname = ANY($1) ORDER BY 1`,
      [Object.values(FORECAST_AT)],
    );
    const common = {
      prosecdef: true,
      // The caller's time zone never reaches the body, like the observation functions.
      proconfig: ['search_path=pg_catalog, pg_temp', 'TimeZone=UTC'],
      provolatile: 's',
      owner: 'rws_owner',
    };
    expect(rows).toMatchObject([
      { proname: FORECAST_AT.owner, ...common, acl: '{rws_owner=X/rws_owner,rws_owner_api=X/rws_owner}' },
      {
        proname: FORECAST_AT.public,
        ...common,
        acl: '{rws_owner=X/rws_owner,rws_api=X/rws_owner,rws_publish=X/rws_owner}',
      },
    ]);
    // A hostile search_path and temporary tables named like the base tables change nothing: the body names `public.`.
    await t.admin.query(`
      CREATE TEMP TABLE forecast_run (id bigint, series_id int, source_id text, issued_at timestamptz, issued_inferred boolean,
        fetched_at timestamptz, first_valid timestamptz, last_valid timestamptz, kind text, step interval,
        provider_segment_end timestamptz);
      CREATE TEMP TABLE forecast_value (run_id bigint, valid_ts timestamptz, value real, p05 real, p10 real, p25 real,
        p30 real, p50 real, p70 real, p75 real, p90 real, p95 real, vmin real, vmax real, flags int2);
      SET search_path = pg_temp, public`);
    try {
      expect(await pairs(t.admin, FORECAST_AT.public)).toEqual([
        { series_id: ids.public, source_id: 'NL-1', value: 200 },
      ]);
    } finally {
      await t.admin.query('RESET search_path; DROP TABLE pg_temp.forecast_run; DROP TABLE pg_temp.forecast_value');
    }
  });

  it('the two functions are one template: the same body except the audience sets', async () => {
    const src = async (fn: string) =>
      (await t.admin.query<{ s: string }>('SELECT prosrc AS s FROM pg_proc WHERE proname = $1', [fn])).rows[0]?.s ?? '';
    const pub = await src(FORECAST_AT.public);
    // The series' effective audience and the run's own source: both are filtered.
    expect(pub).toContain("e.audience IN ('public')");
    expect(pub).toContain("fs.audience IN ('public')");
    expect(pub.replaceAll("IN ('public')", "IN ('public', 'owner')")).toBe(await src(FORECAST_AT.owner));
  });
});

describe('dependent rows are filtered by their own source AND their parent', () => {
  it('an owner-audience reference on a public series is in the owner reference view, not in the public one', async () => {
    expect(await column(api, `SELECT kind FROM ${PUB.reference} WHERE series_id = $1`, [ids.public])).toEqual(['MHW']);
    expect(await column(owner, `SELECT kind FROM ${OWN.reference} WHERE series_id = $1`, [ids.public])).toEqual([
      'MHW',
      'WAAK_OWNER',
    ]);
  });

  it('a public reference on an owner series or a mirror is not public either', async () => {
    expect(
      await column(api, `SELECT count(*)::int FROM ${PUB.reference} WHERE series_id = ANY($1)`, [
        [ids.onlyOwner, ids.mirror],
      ]),
    ).toEqual([0]);
    expect(
      await column(owner, `SELECT count(*)::int FROM ${OWN.reference} WHERE series_id = $1`, [ids.onlyOwner]),
    ).toEqual([1]);
    expect(
      await column(owner, `SELECT count(*)::int FROM ${OWN.reference} WHERE series_id = $1`, [ids.mirror]),
    ).toEqual([0]);
  });

  it('a reference from an off source is in neither family', async () => {
    for (const [client, view] of [
      [api, PUB.reference],
      [owner, OWN.reference],
    ] as const) {
      expect(await column(client, `SELECT count(*)::int FROM ${view} WHERE kind = 'OFF_REF'`)).toEqual([0]);
    }
  });

  it('an owner forecast run on a public series is in the owner forecast-run view, not in the public one', async () => {
    for (const view of [PUB.forecastRun, PUB.api.forecastRun]) {
      expect(await column(api, `SELECT source_id FROM ${view}`), view).toEqual(['NL-1']);
    }
    expect(await column(owner, `SELECT source_id FROM ${OWN.forecastRun} WHERE series_id = $1`, [ids.public])).toEqual([
      'DE-2',
      'NL-1',
    ]);
    // …and the values follow their run.
    for (const view of [PUB.forecastValue, PUB.api.forecastValue]) {
      expect(await column(api, `SELECT value FROM ${view}`), view).toEqual([200]);
    }
    expect(await column(owner, `SELECT value FROM ${OWN.forecastValue}`)).toEqual([
      200,
      201,
      202,
      Number(CANARIES.owner.real),
    ]);
  });

  it('warnings, classes and attribution follow their own source', async () => {
    expect(await column(api, `SELECT name FROM ${PUB.warning}`)).toEqual(['PUBLIC-WARNING']);
    expect(await column(owner, `SELECT name FROM ${OWN.warning}`)).toEqual(['OWNER-WARNING', 'PUBLIC-WARNING']);
    // The public class on an owner-only station is hidden too (the station is not public).
    expect(await column(api, `SELECT provider_code FROM ${PUB.class}`)).toEqual(['PUBLIC_AREA', 'PUBLIC_CLASS']);
    expect(await column(owner, `SELECT provider_code FROM ${OWN.class}`)).toEqual([
      'OWNER_CLASS',
      'OWNER_CLASS',
      'PUBLIC_AREA',
      'PUBLIC_CLASS',
      'PUBLIC_CLASS_ON_OWNER_STATION',
    ]);
    expect(await column(api, `SELECT text FROM ${PUB.attribution}`)).toEqual(['PUBLIC-ATTRIBUTION']);
    expect(await column(owner, `SELECT text FROM ${OWN.attribution}`)).toEqual([
      'OWNER-ATTRIBUTION',
      'PUBLIC-ATTRIBUTION',
    ]);
  });

  it('health, batches and twins follow the same split', async () => {
    expect(await column(api, `SELECT source_id FROM ${PUB.sourceHealth}`)).toEqual(['DE-1', 'NL-1']);
    expect(await column(owner, `SELECT source_id FROM ${OWN.sourceHealth}`)).toEqual([
      'BE-3',
      'CANARY-OWNER',
      'DE-1',
      'DE-2',
      'LU-4',
      'NL-1',
    ]);
    expect(await column(api, `SELECT spec_id FROM ${PUB.ingestBatch}`)).toEqual(['spec-public']);
    expect(await column(owner, `SELECT spec_id FROM ${OWN.ingestBatch}`)).toEqual(['spec-owner', 'spec-public']);
    // A twin pair is public only if both series are; its role does not matter.
    expect(await column(api, `SELECT twin_id FROM ${PUB.twinCheck}`)).toEqual(['public-and-twin', 'public-pair']);
    expect(await column(owner, `SELECT twin_id FROM ${OWN.twinCheck}`)).toEqual([
      'public-and-twin',
      'public-owner-pair',
      'public-pair',
    ]);
  });

  it('public health sees owner sources only as two counts', async () => {
    const { rows, fields } = await api.query(`SELECT * FROM ${PUBLIC_ONLY_VIEWS.ownerHealth}`);
    expect(fields.map((f) => f.name)).toEqual([...OWNER_HEALTH_COLUMNS]);
    // BE-3, DE-2 ok; LU-4 down; the canary source is not counted.
    expect(rows).toEqual([{ healthy: 2, total: 3 }]);
  });

  it('only the owner channel reads a private_basis', async () => {
    const { rows } = await owner.query(`SELECT source_id FROM ${OWNER_ONLY_VIEWS.privateBasis} ORDER BY 1`);
    expect(rows.map((r) => r.source_id)).toEqual(['BE-3', 'CANARY-OWNER', 'DE-2', 'LU-4']);
  });
});

describe('the canaries', () => {
  it('are grepped in the spelling PostgreSQL prints for a stored `real`, and in their decimal spelling', async () => {
    for (const canary of Object.values(CANARIES)) {
      expect(String(canary.value)).toBe(canary.text);
      const { rows } = await t.admin.query('SELECT $1::real::text AS real, $2::numeric::text AS text', [
        canary.value,
        canary.value,
      ]);
      expect(rows).toEqual([{ real: canary.real, text: canary.text }]);
    }
    expect(NEVER_PUBLIC).toEqual(expect.arrayContaining([CANARIES.owner.real, CANARIES.withheld.real]));
  });
});

describe('sweeps over whole families', () => {
  it('no public view shows an owner, off, withheld, mirror or canary row in any column', async () => {
    const forecast = await sweepForecastAt(api, FORECAST_AT.public);
    const text = (await sweep(api, familyViews('public'))) + (await sweepAt(api, OBS_AT.public)) + forecast;
    expect(text).toContain('nl.rws.public');
    expect(forecast).toContain('"source_id":"NL-1"'); // the sweep has a forecast row to look at
    expect(found(text, NEVER_PUBLIC)).toEqual([]);
  });

  it('the owner views show the owner canary and nothing off, withheld, mirror or twin', async () => {
    const forecast = await sweepForecastAt(owner, FORECAST_AT.owner);
    const text = (await sweep(owner, familyViews('owner'))) + (await sweepAt(owner, OBS_AT.owner)) + forecast;
    expect(text).toContain(OWNER_CANARY_REAL);
    expect(await sweepAt(owner, OBS_AT.owner)).toContain(OWNER_CANARY_REAL);
    expect(forecast).toContain(OWNER_CANARY_REAL);
    expect(forecast).toContain('"source_id":"DE-2"'); // an owner source's run on a public series
    expect(text).toContain('CANARY-OWNER');
    expect(text).toContain('SECRET-CLAUSE');
    expect(found(text, NEVER_OWNER)).toEqual([]);
  });

  it('the sweep does catch a view that lost its filter (mutation check)', async () => {
    await t.admin.query(`
      CREATE SCHEMA mutant;
      CREATE VIEW mutant.obs_without_filter AS SELECT o.series_id, o.ts, o.value, o.qc FROM obs o;
      CREATE VIEW mutant.reference_without_source_filter AS
        SELECT r.series_id, r.source_id, r.kind FROM reference_value r JOIN series_eff e ON e.series_id = r.series_id
        WHERE e.audience = 'public' AND e.role = 'primary';
      CREATE VIEW mutant.station_without_filter AS SELECT id FROM station;`);
    try {
      expect(found(await sweep(t.admin, ['mutant.obs_without_filter']), NEVER_PUBLIC)).toEqual([
        CANARIES.owner.real,
        CANARIES.withheld.real,
      ]);
      expect(found(await sweep(t.admin, ['mutant.reference_without_source_filter']), NEVER_PUBLIC)).toEqual([
        'LU-4',
        'DE-9',
        'WAAK_OWNER',
      ]);
      expect(found(await sweep(t.admin, ['mutant.station_without_filter']), NEVER_PUBLIC).length).toBeGreaterThan(5);
    } finally {
      await t.admin.query('DROP SCHEMA mutant CASCADE');
    }
  });
});

describe('the withheld canary on every series that must stay hidden (invariant 8, issue #20)', () => {
  const hidden = () => WITHHELD_KEYS.map((k) => ids[k] as number);

  it('is stored on the withheld series, the series narrowed to off (the LU-1 RLP case), a mirror and a twin', async () => {
    expect([...WITHHELD_KEYS]).toEqual(['withheld', 'narrowedOff', 'mirror', 'twin']);
    for (const key of WITHHELD_KEYS) {
      const { rows } = await t.admin.query(
        `SELECT (SELECT count(*) FROM obs WHERE series_id = $1 AND value = $2::real)::int AS obs,
                (SELECT count(*) FROM obs_latest WHERE series_id = $1 AND value = $2::real)::int AS latest,
                (SELECT count(*) FROM obs_1h WHERE series_id = $1 AND vmax = $2::real)::int AS h1,
                (SELECT count(*) FROM obs_1d WHERE series_id = $1 AND vmax = $2::real)::int AS d1,
                (SELECT count(*) FROM forecast_run r JOIN forecast_value v ON v.run_id = r.id
                 WHERE r.series_id = $1 AND v.value = $2)::int AS forecast`,
        [ids[key], WITHHELD_CANARY],
      );
      expect(rows, key).toEqual([{ obs: 3, latest: 1, h1: 2, d1: 2, forecast: 1 }]);
    }
    // …and the mirror's reference carries it too.
    const ref = await t.admin.query(
      'SELECT count(*)::int AS n FROM reference_value WHERE series_id = $1 AND value = $2',
      [ids.mirror, WITHHELD_CANARY],
    );
    expect(ref.rows).toEqual([{ n: 1 }]);
  });

  it('is in no view and no at-T function of either family, series, reference and forecast views included', async () => {
    for (const [client, family, fn, forecastFn] of [
      [api, PUB, OBS_AT.public, FORECAST_AT.public],
      [owner, OWN, OBS_AT.owner, FORECAST_AT.owner],
    ] as const) {
      const bySeries = [
        family.obs,
        family.obsLatest,
        family.obs1h,
        family.obs1d,
        family.api.obs,
        family.api.obs1h,
        family.api.obs1d,
        family.reference,
        family.forecastRun,
        family.api.forecastRun,
      ];
      for (const view of bySeries)
        expect(
          await column(client, `SELECT count(*)::int FROM ${view} WHERE series_id = ANY($1)`, [hidden()]),
          view,
        ).toEqual([0]);
      for (const view of [family.series, family.api.series])
        expect(await column(client, `SELECT count(*)::int FROM ${view} WHERE id = ANY($1)`, [hidden()]), view).toEqual([
          0,
        ]);
      expect(
        await column(client, `SELECT count(*)::int FROM ${fn}(${FIXTURE_NOW}) WHERE series_id = ANY($1)`, [hidden()]),
      ).toEqual([0]);
      // The forecast side: the values of the withheld runs, and the latest-run function (any t the runs reach).
      for (const view of [family.forecastValue, family.api.forecastValue])
        expect(
          await column(client, `SELECT count(*)::int FROM ${view} WHERE value = $1::real`, [WITHHELD_CANARY]),
          view,
        ).toEqual([0]);
      expect(
        await column(
          client,
          `SELECT count(*)::int FROM ${forecastFn}(${FORECAST_NOW}, ${FORECAST_NOW}) WHERE series_id = ANY($1)`,
          [hidden()],
        ),
      ).toEqual([0]);
      expect(
        found(await sweepForecastAt(client, forecastFn), [CANARIES.withheld.real, CANARIES.withheld.text]),
      ).toEqual([]);
    }
  });

  it('would be found by the sweeps in a view that forgot the role rule (mirror, twin) or the series narrowing (off)', async () => {
    await t.admin.query(`
      CREATE SCHEMA mutant;
      CREATE VIEW mutant.obs_any_role AS
        SELECT o.series_id, o.value FROM obs o JOIN series_eff e ON e.series_id = o.series_id
        WHERE e.audience = 'public' AND e.lic_display;
      CREATE VIEW mutant.obs_source_audience AS
        SELECT o.series_id, o.value FROM obs o JOIN series s ON s.id = o.series_id JOIN source src ON src.id = s.source_id
        WHERE src.audience = 'public' AND s.role = 'primary';`);
    try {
      for (const [view, keys] of [
        ['mutant.obs_any_role', ['mirror', 'twin']],
        ['mutant.obs_source_audience', ['narrowedOff', 'withheld']],
      ] as const) {
        const seen = new Set(
          (await t.admin.query<{ series_id: number }>(`SELECT series_id FROM ${view}`)).rows.map((r) => r.series_id),
        );
        for (const key of keys) expect(seen.has(ids[key] as number), `${view} ${key}`).toBe(true);
        expect(found(await sweep(t.admin, [view]), NEVER_PUBLIC), view).toContain(CANARIES.withheld.real);
      }
    } finally {
      await t.admin.query('DROP SCHEMA mutant CASCADE');
    }
  });
});

describe('the families are one template', () => {
  // pg_get_viewdef prints "IN ('public')" as an equality and the owner set as "= ANY (ARRAY[…])" in parentheses.
  const normalise = (def: string) =>
    def
      .replace(/\((\w+\.audience) = ANY \(ARRAY\['public'::audience, 'owner'::audience\]\)\)/g, '$1 IN <AUDIENCES>')
      .replace(/(\w+\.audience) = ANY \(ARRAY\['public'::audience, 'owner'::audience\]\)/g, '$1 IN <AUDIENCES>')
      .replace(/(\w+\.audience) = 'public'::audience/g, '$1 IN <AUDIENCES>');

  it('every pub/own pair has the same definition except the audience set', async () => {
    const def = async (view: string) =>
      normalise(
        (await t.admin.query<{ d: string }>('SELECT pg_get_viewdef($1::regclass, true) AS d', [view])).rows[0]?.d ?? '',
      );
    const pairs: [string, string][] = [];
    const { api: pubApi, ...pubDisplay } = PUB;
    const { api: ownApi, ...ownDisplay } = OWN;
    for (const k of Object.keys(pubDisplay) as (keyof typeof pubDisplay)[]) pairs.push([pubDisplay[k], ownDisplay[k]]);
    for (const k of Object.keys(pubApi) as (keyof typeof pubApi)[]) pairs.push([pubApi[k], ownApi[k]]);
    expect(pairs).toHaveLength(23);
    for (const [pub, own] of pairs) {
      const d = await def(pub);
      // The meta pair holds the two display-window instants and no audience data, so it has no filter.
      if (pub !== PUB.meta) expect(d, pub).toContain('IN <AUDIENCES>');
      expect(await def(own), `${pub} vs ${own}`).toBe(d);
    }
  });

  it('audience.ts names exactly the views of the database, all security_barrier, all owned by rws_owner', async () => {
    const { rows } = await t.admin.query<{ name: string; barrier: boolean; owner: string }>(
      `SELECT c.relname AS name, coalesce(c.reloptions::text LIKE '%security_barrier=true%', false) AS barrier,
              pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'v' AND c.relname <> 'series_eff' ORDER BY 1`,
    );
    expect(rows.map((r) => r.name)).toEqual([...familyViews('public'), ...familyViews('owner')].sort());
    for (const r of rows) expect(r, r.name).toMatchObject({ barrier: true, owner: 'rws_owner' });
  });

  it('the row types in audience.ts match the view columns', async () => {
    const columns = async (view: string) =>
      (
        await t.admin.query<{ c: string }>(
          'SELECT attname AS c FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 ORDER BY attnum',
          [view],
        )
      ).rows.map((r) => r.c);
    for (const family of [PUB, OWN]) {
      expect(await columns(family.sourceHealth)).toEqual([...SOURCE_HEALTH_COLUMNS]);
      expect(await columns(family.ingestBatch)).toEqual([...INGEST_BATCH_COLUMNS]);
      expect(await columns(family.twinCheck)).toEqual([...TWIN_CHECK_COLUMNS]);
    }
    expect(await columns(PUBLIC_ONLY_VIEWS.loader)).toEqual([...LOADER_COLUMNS]);
    expect(await columns(PUBLIC_ONLY_VIEWS.ownerHealth)).toEqual([...OWNER_HEALTH_COLUMNS]);
  });

  it('the forecast value views carry p30 and p70 after the original columns, and the run views are unchanged', async () => {
    const columns = async (view: string) =>
      (
        await t.admin.query<{ c: string }>(
          'SELECT attname AS c FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 ORDER BY attnum',
          [view],
        )
      ).rows.map((r) => r.c);
    const value = [
      'run_id',
      'valid_ts',
      'value',
      'p05',
      'p10',
      'p25',
      'p50',
      'p75',
      'p90',
      'p95',
      'vmin',
      'vmax',
      'flags',
    ];
    const run = [
      'id',
      'series_id',
      'source_id',
      'issued_at',
      'issued_inferred',
      'first_valid',
      'last_valid',
      'fetched_at',
      'kind',
      'step',
      'provider_segment_end',
    ];
    for (const family of [PUB, OWN]) {
      for (const view of [family.forecastValue, family.api.forecastValue])
        expect(await columns(view), view).toEqual([...value, 'p30', 'p70']);
      for (const view of [family.forecastRun, family.api.forecastRun]) expect(await columns(view), view).toEqual(run);
    }
  });
});

describe('effective audience and channels: SQL equals packages/core effective()', () => {
  it('for every combination of source audience, series audience, source flags and override', async () => {
    const audiences = ['public', 'owner', 'off'] as const;
    const tri = [undefined, true, false] as const;
    const flags = [true, false] as const;
    type Case = { key: string; source: string; seriesAudience: string | null; override: Record<string, boolean> };
    const cases: Case[] = [];
    const sources: string[] = [];
    let n = 0;
    await t.admin.query("INSERT INTO station (id, name, country, tier) VALUES ('fr.grid.station', 'grid', 'FR', 2)");
    for (const audience of audiences) {
      for (const display of flags) {
        for (const api_ of flags) {
          for (const history of flags) {
            n += 1;
            const source = `FR-${n}`;
            sources.push(source);
            await t.admin.query(
              `INSERT INTO source (id, provider_id, name, audience, private_basis, lic_display, lic_api, lic_bulk_export,
                                   lic_history_export, capture_enabled)
               VALUES ($1, 'rws', 'grid', $2::audience,
                       CASE WHEN $2 = 'owner' THEN '{"clause":"c","url":"https://example.org","retrieved":"2026-09-24"}'::jsonb END,
                       $3, $4, false, $5, true)`,
              [source, audience, display, api_, history],
            );
            for (const seriesAudience of [null, ...audiences]) {
              for (const d of tri) {
                for (const a of tri) {
                  for (const h of tri) {
                    const override: Record<string, boolean> = {};
                    if (d !== undefined) override.display = d;
                    if (a !== undefined) override.api = a;
                    if (h !== undefined) override.history_export = h;
                    cases.push({ key: `grid-${cases.length}`, source, seriesAudience, override });
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(cases).toHaveLength(3 * 8 * 4 * 27);
    await t.admin.query(
      `INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                           native_step, expected_step, staleness_limit, role, audience, lic_override)
       SELECT 'fr.grid.station', c.source, 'H', 'stage', c.key, 'cm', 1, 'LOCAL', '15 min', '15 min', '45 min', 'primary',
              c.audience::audience, nullif(c.override, '{}')::jsonb
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[]) AS c(key, source, audience, override)`,
      [
        cases.map((c) => c.key),
        cases.map((c) => c.source),
        cases.map((c) => c.seriesAudience),
        cases.map((c) => JSON.stringify(c.override)),
      ],
    );

    type Flags = Parameters<typeof effective>[0];
    const src = new Map<string, Flags>(
      (
        await t.admin.query(
          'SELECT id, audience, lic_display, lic_api, lic_bulk_export, lic_history_export FROM source WHERE id = ANY($1)',
          [sources],
        )
      ).rows.map((r) => [
        r.id,
        {
          audience: r.audience,
          display: r.lic_display,
          api: r.lic_api,
          bulk_export: r.lic_bulk_export,
          history_export: r.lic_history_export,
        },
      ]),
    );
    const eff = new Map(
      (
        await t.admin.query(
          `SELECT s.provider_key AS key, e.audience, e.lic_display, e.lic_api, e.lic_bulk_export, e.lic_history_export
         FROM series_eff e JOIN series s ON s.id = e.series_id WHERE s.provider_key LIKE 'grid-%'`,
        )
      ).rows.map((r) => [r.key, r]),
    );
    const inView = async (client: pg.Client, view: string) =>
      new Set(
        (
          await client
            .query({
              text: `SELECT s.provider_key FROM ${view} v JOIN series s ON s.id = v.id WHERE s.provider_key LIKE 'grid-%'`,
              rowMode: 'array',
            })
            .catch(() => ({ rows: [] }))
        ).rows.map((r: unknown[]) => r[0]),
      );
    // The reader views are read as the superuser here only to join provider_key; grants are tested elsewhere.
    const pub = await inView(t.admin, PUB.series);
    const pubApi = await inView(t.admin, PUB.api.series);
    const own = await inView(t.admin, OWN.series);
    const ownApi = await inView(t.admin, OWN.api.series);

    let widened = 0;
    for (const c of cases) {
      const source = src.get(c.source) as Flags;
      const expected = effective(source, {
        key: 'k',
        reason: 'grid',
        ...(c.seriesAudience === null ? {} : { audience: c.seriesAudience }),
        ...c.override,
      });
      const row = eff.get(c.key);
      expect(
        {
          audience: row.audience,
          display: row.lic_display,
          api: row.lic_api,
          bulk_export: row.lic_bulk_export,
          history_export: row.lic_history_export,
        },
        c.key,
      ).toEqual(expected);
      expect(pub.has(c.key), `${c.key} pub`).toBe(expected.audience === 'public' && expected.display);
      expect(pubApi.has(c.key), `${c.key} pub api`).toBe(
        expected.audience === 'public' && expected.display && expected.api,
      );
      expect(own.has(c.key), `${c.key} own`).toBe(expected.audience !== 'off' && expected.display);
      expect(ownApi.has(c.key), `${c.key} own api`).toBe(
        expected.audience !== 'off' && expected.display && expected.api,
      );
      // Never wider than the source, whatever the series asks for.
      const order = { off: 0, owner: 1, public: 2 } as const;
      if (order[expected.audience] > order[source.audience]) widened += 1;
      if ((expected.display && !source.display) || (expected.api && !source.api)) widened += 1;
    }
    expect(widened).toBe(0);
  });
});

// Invariant 11, P8a: an owner source's forecast run hangs on a series that is public. DE-2's run is on a DE-1 series,
// LU-3's on an LU-1 series (the way the registry attaches them), both valued with the owner canary. It is in the
// owner run view, owner value view and owner latest-run function, and in no public one, for either public login.
// This describe goes last: it adds public stations and series, which the exact lists above do not expect.
describe('the owner canary as a forecast run on a public series', { timeout: 300_000 }, () => {
  let publish: pg.Client;
  let de1: number; // the public DE-1 series that DE-2's canary run hangs on
  let lu1: number; // the public LU-1 series that LU-3's canary run hangs on
  const HOUR = "date_trunc('hour', now())";

  beforeAll(async () => {
    publish = await t.connectAs('rws_publish');
    await t.admin.query(`
      INSERT INTO source (id, provider_id, name, audience, private_basis, lic_display, lic_api, lic_bulk_export,
                          lic_history_export, history_window, capture_enabled, canary) VALUES
        ('LU-1', 'age', 'public obs', 'public', NULL, true, true, true, true, '0', true, false),
        ('LU-3', 'age', 'owner forecasts', 'owner',
         '{"clause": "c", "url": "https://example.org/terms", "retrieved": "2026-09-24"}'::jsonb,
         true, true, false, true, '0', true, false);
      INSERT INTO station (id, name, country, tier) VALUES
        ('de.wsv.fc-canary', 'forecast canary DE', 'DE', 1), ('lu.age.fc-canary', 'forecast canary LU', 'LU', 1);`);
    const series = async (station: string, source: string, key: string) =>
      (
        await t.admin.query<{ id: number }>(
          `INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                               native_step, expected_step, staleness_limit, role)
           VALUES ($1, $2, 'H', 'stage', $3, 'cm', 1, 'LOCAL', '15 min', '15 min', '45 min', 'primary') RETURNING id`,
          [station, source, key],
        )
      ).rows[0]?.id as number;
    de1 = await series('de.wsv.fc-canary', 'DE-1', 'fc-canary-de');
    lu1 = await series('lu.age.fc-canary', 'LU-1', 'fc-canary-lu');
    const run = async (
      seriesId: number,
      source: string,
      o: { issued: boolean; hours: number; kind: string; value: number; band?: number },
    ) => {
      const { rows } = await t.admin.query<{ id: string }>(
        `INSERT INTO forecast_run (series_id, source_id, issued_at, issued_inferred, first_valid, last_valid, fetched_at,
                                   content_hash, kind)
         VALUES ($1, $2, CASE WHEN $3 THEN ${HOUR} END, NOT $3, ${HOUR}, ${HOUR} + make_interval(hours => $4::int), ${HOUR},
                 sha256(convert_to($2 || $6, 'UTF8')), $5)
         RETURNING id`,
        [seriesId, source, o.issued, o.hours, o.kind, String(seriesId)],
      );
      // Two points, an hour apart; a quantile run states p30 and p70 as well.
      await t.admin.query(
        `INSERT INTO forecast_value (run_id, valid_ts, value, p30, p70)
         SELECT $1, ${HOUR} + make_interval(hours => h), $2, $3, $3 FROM generate_series(0, 1) h`,
        [(rows[0] as { id: string }).id, o.value, o.band ?? null],
      );
    };
    // Public runs on both series (a public reader sees the series and their forecast), then the owner canary runs.
    await run(de1, 'NL-1', { issued: false, hours: 48, kind: 'deterministic', value: 300 });
    await run(lu1, 'NL-1', { issued: false, hours: 48, kind: 'deterministic', value: 300 });
    await run(de1, 'DE-2', { issued: true, hours: 96, kind: 'deterministic', value: OWNER_CANARY });
    await run(lu1, 'LU-3', { issued: false, hours: 48, kind: 'quantiles', value: OWNER_CANARY, band: OWNER_CANARY });
  });

  it('the canary runs are stored, one per series, in value, p30 and p70', async () => {
    const { rows } = await t.admin.query(
      `SELECT r.series_id, r.source_id, count(*)::int AS n,
              count(*) FILTER (WHERE v.p30 = $1::real AND v.p70 = $1::real)::int AS band
       FROM forecast_run r JOIN forecast_value v ON v.run_id = r.id
       WHERE r.series_id = ANY($2) AND v.value = $1::real GROUP BY 1, 2 ORDER BY 1`,
      [OWNER_CANARY, [de1, lu1]],
    );
    expect(rows).toEqual([
      { series_id: de1, source_id: 'DE-2', n: 2, band: 0 },
      { series_id: lu1, source_id: 'LU-3', n: 2, band: 2 },
    ]);
  });

  it.each([
    ['rws_api', () => api],
    ['rws_publish', () => publish],
  ] as const)('is in no public forecast view and no public latest-run function (%s)', async (_role, client) => {
    const c = client();
    // The run views and the value views, display and api variants: no owner run, no canary in any column.
    for (const view of [PUB.forecastRun, PUB.api.forecastRun])
      expect(await column(c, `SELECT source_id FROM ${view} WHERE series_id = ANY($1)`, [[de1, lu1]]), view).toEqual([
        'NL-1',
        'NL-1',
      ]);
    for (const view of [PUB.forecastValue, PUB.api.forecastValue])
      expect(
        await column(
          c,
          `SELECT count(*)::int FROM ${view} WHERE $1::real IN (value, p05, p10, p25, p30, p50, p70, p75, p90, p95, vmin, vmax)`,
          [OWNER_CANARY],
        ),
        view,
      ).toEqual([0]);
    // The latest-run function: only the public runs, at the instant of the runs and well inside every one of them.
    for (const instant of [FIXTURE_NOW, `${HOUR} + interval '90 minutes'`]) {
      const rows = (
        await c.query(
          `SELECT series_id, source_id, value FROM ${FORECAST_AT.public}(${instant}, ${instant}) WHERE series_id = ANY($1) ORDER BY 1, 2`,
          [[de1, lu1]],
        )
      ).rows;
      expect(rows).toEqual([
        { series_id: de1, source_id: 'NL-1', value: 300 },
        { series_id: lu1, source_id: 'NL-1', value: 300 },
      ]);
    }
    // And the whole of it as text: both renderings of both canaries, and the owner source IDs.
    const text =
      (await sweep(c, familyViews('public'))) +
      (await sweepForecastAt(c, FORECAST_AT.public, FIXTURE_NOW)) +
      (await sweepForecastAt(c, FORECAST_AT.public, `${HOUR} + interval '90 minutes'`));
    expect(text).toContain('fc-canary'); // the series are in the sweep
    expect(found(text, [...CANARY_RENDERINGS, 'DE-2', 'LU-3'])).toEqual([]);
  });

  it('is in the owner run view, value view and latest-run function (rws_owner_api), and the withheld canary is nowhere', async () => {
    for (const view of [OWN.forecastRun, OWN.api.forecastRun]) {
      expect(await column(owner, `SELECT source_id FROM ${view} WHERE series_id = $1`, [de1]), view).toEqual([
        'DE-2',
        'NL-1',
      ]);
      expect(await column(owner, `SELECT source_id FROM ${view} WHERE series_id = $1`, [lu1]), view).toEqual([
        'LU-3',
        'NL-1',
      ]);
    }
    for (const [view, runs] of [
      [OWN.forecastValue, OWN.forecastRun],
      [OWN.api.forecastValue, OWN.api.forecastRun],
    ] as const) {
      const { rows } = await owner.query(
        `SELECT count(*) FILTER (WHERE value = $1::real)::int AS value,
                count(*) FILTER (WHERE p30 = $1::real AND p70 = $1::real)::int AS band,
                count(*) FILTER (WHERE $2::real IN (value, p30, p70))::int AS withheld
         FROM ${view} v JOIN ${runs} r ON r.id = v.run_id
         WHERE r.series_id = ANY($3)`,
        [OWNER_CANARY, WITHHELD_CANARY, [de1, lu1]],
      );
      expect(rows, view).toEqual([{ value: 4, band: 2, withheld: 0 }]);
    }
    const rows = (
      await owner.query(
        `SELECT series_id, source_id, value, p30, p70 FROM ${FORECAST_AT.owner}(${FIXTURE_NOW}, ${FIXTURE_NOW})
         WHERE series_id = ANY($1) ORDER BY 1, 2`,
        [[de1, lu1]],
      )
    ).rows;
    const canary = Number(OWNER_CANARY_REAL);
    expect(rows).toEqual([
      { series_id: de1, source_id: 'DE-2', value: canary, p30: null, p70: null },
      { series_id: de1, source_id: 'NL-1', value: 300, p30: null, p70: null },
      { series_id: lu1, source_id: 'LU-3', value: canary, p30: canary, p70: canary },
      { series_id: lu1, source_id: 'NL-1', value: 300, p30: null, p70: null },
    ]);
    const text = (await sweep(owner, familyViews('owner'))) + (await sweepForecastAt(owner, FORECAST_AT.owner));
    expect(text).toContain(OWNER_CANARY_REAL);
    expect(found(text, [CANARIES.withheld.real, CANARIES.withheld.text])).toEqual([]);
    expect(text).toContain('DE-2');
    expect(text).toContain('LU-3');
  });
});
