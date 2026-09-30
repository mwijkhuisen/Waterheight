import { CANARIES } from '@rws/contracts';
import { effective } from '@rws/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
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
import { NEVER_OWNER, NEVER_PUBLIC, OWNER_CANARY_REAL, seedAudienceFixture } from './seed.ts';
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
    const text = (await sweep(api, familyViews('public'))) + (await sweepAt(api, OBS_AT.public));
    expect(text).toContain('nl.rws.public');
    expect(found(text, NEVER_PUBLIC)).toEqual([]);
  });

  it('the owner views show the owner canary and nothing off, withheld, mirror or twin', async () => {
    const text = (await sweep(owner, familyViews('owner'))) + (await sweepAt(owner, OBS_AT.owner));
    expect(text).toContain(OWNER_CANARY_REAL);
    expect(await sweepAt(owner, OBS_AT.owner)).toContain(OWNER_CANARY_REAL);
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
    expect(pairs).toHaveLength(21);
    for (const [pub, own] of pairs) {
      const d = await def(pub);
      expect(d, pub).toContain('IN <AUDIENCES>');
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
