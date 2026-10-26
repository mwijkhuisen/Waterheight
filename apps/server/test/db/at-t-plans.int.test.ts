import { CANARIES } from '@rws/contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { obsAt, tideAt } from '../../../../scripts/gen-views.ts';
import { DayVersions } from '../../src/api/versions.ts';
import { DisplayWindow } from '../../src/api/window.ts';
import { createApp } from '../../src/app.ts';
import { OBS_AT, TIDE_AT } from '../../src/db/audience.ts';
import { type Db, type DbConfig, dbConfig, openDb } from '../../src/db/pool.ts';
import { syncOwnerCanary } from '../../src/load/canary.ts';
import { lock } from '../../src/load/store.ts';
import { seedAudienceFixture } from './seed.ts';
import { createTestDb, type LoginRole, type TestDb } from './testdb.ts';

// #212 (PR A): the capped public Q1 and the fenced TIDE_AT functions return exactly the rows of the frozen v1 bodies
// of the generator (created here under neutral names), at instants near the data, on the boundary of the 2-day cap
// and in the yearly history partitions; the owner Q1 is still the frozen body; the owner canary is marked `owner` by
// syncOwnerCanary (also on a row of the old shape) and stays visible to the owner and invisible to the public.

const H = 3_600_000;
const SEC = 1000;
const H0 = Math.floor(Date.now() / H) * H;
const T0 = H0 - 6 * H;
const old = new Date('2005-03-10T12:00:00Z').getTime();
const iso = (ms: number) => new Date(ms).toISOString();

let t: TestDb;
let ids: Record<string, number>;

/** Extra series on stations of their own: key, limit, active. */
const EXTRA: [string, string, boolean][] = [
  ['capIn', '2 days', true], // obs at T0 − 2 d + 1 s: in
  ['capOut', '2 days', true], // obs at T0 − 2 d: out
  ['slow25', '25 hours', true],
  ['stale', '45 minutes', true], // only values older than 2 days
  ['inactive', '45 minutes', false],
];

/** The instants compared: near the fixture's rows (H0, −10 d, −40 d), the extras (T0), the cap and 2005. */
const INSTANTS = [
  H0,
  H0 + 10 * 60_000,
  H0 + 5 * 24 * H,
  H0 - 10 * 24 * H,
  H0 - 10 * 24 * H + 20 * 60_000,
  H0 - 40 * 24 * H,
  T0,
  T0 + 30 * 60_000,
  T0 - 2 * 24 * H + 2 * SEC,
  T0 - 24 * H,
  old,
  old + 10 * 60_000,
  old + 50 * 60_000,
  Date.parse('2005-06-01T00:00:00Z'),
];

beforeAll(async () => {
  t = await createTestDb();
  ids = await seedAudienceFixture(t.admin);
  await t.admin.query(`SELECT ensure_history_partitions('1950-01-01', now() - interval '60 days')`);

  // Every station tidal but three: null, false and missing.
  await t.admin.query(`UPDATE station SET flags = '{"tidal": true}'`);
  await t.admin.query(`UPDATE station SET flags = '{"tidal": null}' WHERE id = 'ch.bafu.display-only'`);
  await t.admin.query(`UPDATE station SET flags = '{"tidal": false}' WHERE id = 'de.wsv.no-api'`);
  await t.admin.query(`UPDATE station SET flags = '{}' WHERE id = 'nl.rws.public2'`);

  for (const [key, limit, active] of EXTRA) {
    await t.admin.query(
      `INSERT INTO station (id, name, country, tier, flags) VALUES ($1, $1, 'NL', 2, '{"tidal": true}')`,
      [`nl.ap.${key}`],
    );
    const { rows } = await t.admin.query<{ id: number }>(
      `INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                           native_step, expected_step, staleness_limit, role, active)
       VALUES ($1, 'NL-1', 'H', 'stage', $2, 'cm', 1, 'LOCAL', '15 min', '15 min', $3::interval, 'primary', $4)
       RETURNING id`,
      [`nl.ap.${key}`, key, limit, active],
    );
    ids[key] = (rows[0] as { id: number }).id;
  }
  const put = (key: string, ts: number, value: number) =>
    t.admin.query(`INSERT INTO obs (series_id, ts, value, qc, batch_id) VALUES ($1, $2, $3, 1, 1)`, [
      ids[key],
      iso(ts),
      value,
    ]);
  await put('capIn', T0 - 48 * H + SEC, 11);
  await put('capOut', T0 - 48 * H, 12);
  await put('slow25', T0 - 24 * H, 13);
  await put('slow25', T0 - 26 * H, 14);
  await put('stale', T0 - 72 * H, 15);
  await put('stale', T0 - 100 * H, 16);
  await put('inactive', T0, 17);
  // Values older than 2 days on fixture series, 35 days back on the CH-3 window series (history rule), and the yearly
  // partitions: 2005 on public, window (hidden by its 30-day window) and windowExport.
  await put('public2', T0 - 3 * 24 * H, 18);
  await put('window', H0 - 35 * 24 * H, 19);
  await put('windowExport', H0 - 35 * 24 * H, 20);
  for (const [key, v] of [
    ['public', 21],
    ['window', 22],
    ['windowExport', 23],
    ['capIn', 24],
    ['noApi', 25],
  ] as const)
    await put(key, old, v);

  // Tide rows round every centre, for every series: astro every 10 min, astro and measured high and low waters
  // before and after the instant.
  const centres = [H0, T0, H0 - 10 * 24 * H, H0 - 40 * 24 * H, old].map(iso);
  await t.admin.query(
    `INSERT INTO tide (series_id, kind, ts, value, hilo, batch_id)
     SELECT s.id, 'astro', c + g * interval '10 min', 100 + g, NULL, 1
     FROM series s, unnest($1::timestamptz[]) c, generate_series(-6, 1) g
     ON CONFLICT DO NOTHING`,
    [centres],
  );
  await t.admin.query(
    `INSERT INTO tide (series_id, kind, ts, value, hilo, batch_id)
     SELECT s.id, k.kind, c + k.h * interval '1 hour', 200 + k.h, k.hilo, 1
     FROM series s, unnest($1::timestamptz[]) c,
          (VALUES ('extreme_astro', 'high', -9), ('extreme_astro', 'low', -3), ('extreme_astro', 'high', 4),
                  ('extreme_astro', 'low', 10), ('extreme', 'high', -8), ('extreme', 'low', -2),
                  ('extreme', 'high', 2)) k (kind, hilo, h)
     ON CONFLICT DO NOTHING`,
    [centres],
  );

  // The frozen v1 bodies, under neutral names.
  await t.admin.query(obsAt('q1_frozen_public', { audience: 'public', api: false }));
  await t.admin.query(obsAt('q1_frozen_owner', { audience: 'owner', api: false }));
  await t.admin.query(tideAt('tide_frozen_public', { audience: 'public', api: false }));
  await t.admin.query(tideAt('tide_frozen_owner', { audience: 'owner', api: false }));
}, 120_000);

afterAll(async () => {
  await t.drop();
});

const rows = async (fn: string, ms: number) =>
  (
    await t.admin.query<{ series_id: number; ts: Date; value: number }>(`SELECT * FROM ${fn}($1::timestamptz)`, [
      iso(ms),
    ])
  ).rows;
const diff = async (a: string, b: string, ms: number) =>
  (await t.admin.query(`SELECT * FROM ${a}($1::timestamptz) EXCEPT ALL SELECT * FROM ${b}($1::timestamptz)`, [iso(ms)]))
    .rows;

describe('same rows as the frozen bodies', () => {
  const pairs = [
    ['the public Q1', OBS_AT.public, 'q1_frozen_public'],
    ['the public tide rows', TIDE_AT.public, 'tide_frozen_public'],
    ['the owner tide rows', TIDE_AT.owner, 'tide_frozen_owner'],
  ] as const;

  it.each(pairs)('%s: EXCEPT ALL is empty both ways at every instant', async (_n, fn, frozen) => {
    for (const ms of INSTANTS) {
      expect(await diff(fn, frozen, ms), `${iso(ms)} new minus frozen`).toEqual([]);
      expect(await diff(frozen, fn, ms), `${iso(ms)} frozen minus new`).toEqual([]);
    }
  });

  it('the comparisons are not vacuous; the cap boundary holds at T0', async () => {
    expect(INSTANTS.length).toBeGreaterThanOrEqual(10);
    for (const [, fn] of pairs) {
      const sizes: number[] = [];
      for (const ms of INSTANTS) sizes.push((await rows(fn, ms)).length);
      expect(sizes.filter((n) => n > 0).length, fn).toBeGreaterThanOrEqual(5);
    }
    const q1 = await rows(OBS_AT.public, T0);
    const cap = q1.find((r) => r.series_id === ids.capIn);
    expect(cap && iso(cap.ts.getTime())).toBe(iso(T0 - 48 * H + SEC));
    expect(q1.find((r) => r.series_id === ids.capOut)).toBeUndefined();
    expect(q1.find((r) => r.series_id === ids.stale)).toBeUndefined();
    expect(q1.find((r) => r.series_id === ids.inactive)).toBeUndefined();
    expect(q1.find((r) => r.series_id === ids.slow25)).toBeDefined();
    // 2005: the yearly partition is read; the window series' value is out by the history rule.
    const q05 = await rows(OBS_AT.public, old + 10 * 60_000);
    expect(q05.find((r) => r.series_id === ids.public)).toBeDefined();
    expect(q05.find((r) => r.series_id === ids.windowExport)).toBeDefined();
    expect(q05.find((r) => r.series_id === ids.window)).toBeUndefined();
  });

  it('OBS_AT.owner is the frozen body', async () => {
    const meta = async (name: string) =>
      (
        await t.admin.query(
          `SELECT prosrc, proconfig, prosecdef, prorows FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace`,
          [name],
        )
      ).rows;
    const a = await meta(OBS_AT.owner);
    expect(a).toHaveLength(1);
    expect(a).toEqual(await meta('q1_frozen_owner'));
  });

  it('the at-T functions are still owned by rws_owner', async () => {
    const names = [OBS_AT.public, OBS_AT.owner, TIDE_AT.public, TIDE_AT.owner];
    const { rows: owners } = await t.admin.query<{ proname: string; owner: string }>(
      `SELECT proname, pg_get_userbyid(proowner) AS owner FROM pg_proc
       WHERE proname = ANY($1) AND pronamespace = 'public'::regnamespace ORDER BY proname`,
      [names],
    );
    expect(owners).toEqual([...names].sort().map((proname) => ({ proname, owner: 'rws_owner' })));
  });
});

describe('tide rows by audience and flag', () => {
  it('owner-audience tidal series are in the owner function only; tidal null, false and missing give no rows', async () => {
    for (const ms of [H0, T0]) {
      const pub = new Set((await rows(TIDE_AT.public, ms)).map((r) => r.series_id));
      const own = new Set((await rows(TIDE_AT.owner, ms)).map((r) => r.series_id));
      for (const key of ['narrowedOwner', 'ownerCanary']) {
        expect(own.has(ids[key] as number), `${key} owner`).toBe(true);
        expect(pub.has(ids[key] as number), `${key} public`).toBe(false);
      }
      for (const key of ['noApi', 'public2', 'displayOnly']) {
        expect(own.has(ids[key] as number), `${key} owner`).toBe(false);
        expect(pub.has(ids[key] as number), `${key} public`).toBe(false);
      }
      expect(pub.has(ids.public as number)).toBe(true);
    }
  });
});

describe('the owner canary', () => {
  const open = (role: LoginRole, max = 2): Db =>
    openDb(dbConfig({ DATABASE_URL: t.urlFor(role) }, role) as DbConfig, { max });
  const NOW = Math.floor(Date.now() / SEC) * SEC;
  const GRID = 600_000;
  const snapshotAt = Math.floor(NOW / GRID) * GRID;
  const dbs: Db[] = [];
  afterAll(async () => {
    await Promise.all(dbs.map((d) => d.close()));
  });
  const marked = async (admin: pg.Client) =>
    (
      await admin.query<{ id: number; audience: string | null }>(
        `SELECT id, audience FROM series WHERE provider_key = 'owner-canary'`,
      )
    ).rows;
  const sync = async () => {
    const migrator = open('rws_migrator', 1);
    dbs.push(migrator);
    await migrator.db.transaction().execute(async (tx) => {
      await lock(tx);
      await syncOwnerCanary(tx);
    });
  };

  it('syncOwnerCanary marks the series owner; owner Q1 and /snapshot have it, the public ones do not', async () => {
    // A snapshot attributes every source it names (a source without a row fails closed).
    await t.admin.query(`
      INSERT INTO attribution (source_id, ord, lang, text, needs_date, required) VALUES
        ('DE-1', 0, 'de', 'a', false, false), ('CH-1', 0, 'de', 'a', false, false), ('CH-3', 0, 'de', 'a', false, false),
        ('CH-4', 0, 'de', 'a', false, false), ('BE-3', 0, 'fr', 'a', false, true),
        ('CANARY-OWNER', 0, 'nl', 'a', false, true)`);
    await sync();
    const [canary] = await marked(t.admin);
    expect(canary?.audience).toBe('owner');
    const id = canary?.id as number;
    const ownerQ1 = (await rows(OBS_AT.owner, NOW)).find((r) => r.series_id === id);
    expect(ownerQ1?.value).toBeCloseTo(CANARIES.owner.value, 0);
    const publicQ1 = await rows(OBS_AT.public, NOW);
    expect(publicQ1.find((r) => r.series_id === id)).toBeUndefined();
    expect(JSON.stringify(publicQ1)).not.toContain(CANARIES.owner.real);

    const apps = {} as Record<'public' | 'owner', ReturnType<typeof createApp>>;
    for (const [family, role] of [
      ['public', 'rws_api'],
      ['owner', 'rws_owner_api'],
    ] as const) {
      const db = open(role);
      dbs.push(db);
      const window = new DisplayWindow(db.db, undefined, family);
      expect(await window.refresh()).toBe(true);
      const versions = new DayVersions(db.db, family);
      expect(await versions.refresh()).toBe(true);
      apps[family] = createApp({ family, db: db.db, window, versions, now: () => new Date(NOW) });
    }
    const ask = async (family: 'public' | 'owner') => {
      const res = await apps[family].request(`/api/v1/snapshot?t=${iso(snapshotAt)}`);
      expect(res.status, family).toBe(200);
      return (await res.json()) as { values: { series: number; value: number }[] };
    };
    expect((await ask('owner')).values.find((v) => v.series === id)?.value).toBeCloseTo(CANARIES.owner.value, 0);
    const pub = await ask('public');
    expect(pub.values.find((v) => v.series === id)).toBeUndefined();
    expect(JSON.stringify(pub)).not.toContain(CANARIES.owner.real);
  });

  it('a canary row of the old shape (audience NULL) is marked owner by the ON CONFLICT path and still reaches the owner Q1', async () => {
    const t2 = await createTestDb();
    try {
      await t2.admin.query(`
        INSERT INTO provider (id, name, country) VALUES ('canary', 'canary', 'none');
        INSERT INTO source (id, provider_id, name, audience, private_basis, lic_display, lic_api, lic_bulk_export,
                            lic_history_export, history_window, capture_enabled, canary)
        VALUES ('CANARY-OWNER', 'canary', 'owner canary', 'owner',
                '{"clause": "c", "url": "https://example.org/terms", "retrieved": "2026-09-24"}'::jsonb,
                true, true, false, true, '0', true, true);
        INSERT INTO station (id, name, country, tier) VALUES ('nl.canary.owner', 'owner canary', 'NL', 2);
        INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                            native_step, expected_step, staleness_limit, role, active, audience)
        VALUES ('nl.canary.owner', 'CANARY-OWNER', 'H', 'stage', 'owner-canary', 'cm', 1, 'LOCAL', '1 hour', '1 hour',
                '36500 days', 'primary', true, NULL)`);
      expect((await marked(t2.admin)).map((r) => r.audience)).toEqual([null]);
      const migrator = openDb(dbConfig({ DATABASE_URL: t2.urlFor('rws_migrator') }, 'rws_migrator') as DbConfig, {
        max: 1,
      });
      try {
        await migrator.db.transaction().execute(async (tx) => {
          await lock(tx);
          await syncOwnerCanary(tx);
        });
      } finally {
        await migrator.close();
      }
      const [row] = await marked(t2.admin);
      expect(row?.audience).toBe('owner');
      const owner = await t2.connectAs('rws_owner_api');
      const { rows: q1 } = await owner.query<{ series_id: number; value: number }>(
        `SELECT series_id, value FROM ${OBS_AT.owner}(now())`,
      );
      expect(q1.find((r) => r.series_id === row?.id)?.value).toBeCloseTo(CANARIES.owner.value, 0);
    } finally {
      await t2.drop();
    }
  });
});
