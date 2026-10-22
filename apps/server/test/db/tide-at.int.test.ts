import { CANARIES } from '@rws/contracts';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OBS_AT, TIDE_AT, VIEWS } from '../../src/db/audience.ts';
import { OWNER_CANARY, seedAudienceFixture, WITHHELD_CANARY, WITHHELD_KEYS } from './seed.ts';
import { createTestDb, type LoginRole, sqlState, type TestDb } from './testdb.ts';

// P18a: "the tide rows a snapshot at T can use" (TIDE_AT). Per active visible primary series at a tidal station: the
// astro values in (T − staleness_limit, T], per high/low the newest astro and measured extreme in (T − 15 h, T] and
// the oldest astro extreme in (T, T + 15 h]; never a measured extreme after T; the history rule on every row. The
// audience fixture of seed.ts gives the series; every tide row is written here. Instants are from D0, yesterday 00:00
// UTC (inside the fixture's partitions and the 30-day history windows); the fixture's series have a 45-minute limit.

const H = 3_600_000;
const D0 = Math.floor(Date.now() / 86_400_000) * 86_400_000 - 86_400_000;
const at = (h: number, m = 0, s = 0) => new Date(D0 + h * H + m * 60_000 + s * 1000);
const T = at(10, 10);
const iso = (d: Date) => d.toISOString();
const byNumber = (a: number, b: number) => a - b;

type Row = { series_id: number; kind: string; hilo: string | null; ts: Date; value: number };

let t: TestDb;
let api: pg.Client;
let owner: pg.Client;
let ids: Record<string, number>;

const rowsAt = async (client: pg.Client, fn: string, instant: Date) =>
  (
    await client.query<Row>(
      `SELECT series_id, kind, hilo, ts, value FROM ${fn}($1::timestamptz) ORDER BY series_id, kind, hilo, ts`,
      [instant],
    )
  ).rows;

const tide = (key: string, kind: string, ts: Date, value: number, hilo: string | null = null) =>
  t.admin.query('INSERT INTO tide (series_id, kind, ts, value, hilo, batch_id) VALUES ($1, $2, $3, $4, $5, 1)', [
    ids[key],
    kind,
    ts,
    value,
    hilo,
  ]);

beforeAll(async () => {
  t = await createTestDb();
  ids = await seedAudienceFixture(t.admin);
  // Every fixture station is tidal but one, which says `tidal: null` (the five astro series of D-2).
  await t.admin.query(`UPDATE station SET flags = '{"tidal": true}'`);
  await t.admin.query(`UPDATE station SET flags = '{"tidal": null}' WHERE id = 'nl.rws.public2'`);

  // The public series: astro every few minutes around T (09:25 is exactly T − 45 min), a measured value at 10:00.
  for (const [h, m] of [
    [9, 0],
    [9, 25],
    [9, 30],
    [10, 0],
    [10, 10],
    [10, 20],
  ] as const)
    await tide('public', 'astro', at(h, m), h * 60 + m);
  await t.admin.query('INSERT INTO obs (series_id, ts, value, qc, batch_id) VALUES ($1, $2, 650, 1, 1)', [
    ids.public,
    at(10),
  ]);
  // …and astro high and low waters for the window edges.
  for (const h of [-2, 0]) await tide('public', 'extreme_astro', at(h), 200 + h, 'high');
  for (const h of [20, 22]) await tide('public', 'extreme_astro', at(h), -200 - h, 'low');

  // noApi (public, display only for the API): a measured value at 10:00 without an astro value at 10:00, and
  // measured high and low waters before and after T.
  await tide('noApi', 'astro', at(9, 50), 590);
  await tide('noApi', 'astro', T, 610);
  await t.admin.query('INSERT INTO obs (series_id, ts, value, qc, batch_id) VALUES ($1, $2, 640, 1, 1)', [
    ids.noApi,
    at(10),
  ]);
  await tide('noApi', 'extreme', at(9, 10), 250, 'high');
  await tide('noApi', 'extreme', at(11, 10), 260, 'high');
  await tide('noApi', 'extreme', new Date(T.getTime() - 15 * H), -150, 'low');

  // Every other series: one astro value at T, the canaries on the series that hold them.
  const value = (key: string) =>
    (WITHHELD_KEYS as readonly string[]).includes(key) ? WITHHELD_CANARY : key === 'ownerCanary' ? OWNER_CANARY : 100;
  for (const key of Object.keys(ids)) if (key !== 'public' && key !== 'noApi') await tide(key, 'astro', T, value(key));

  // 40 days back: past the 30-day window of CH-3 (no history export), inside CH-4's export.
  const old = new Date(T.getTime() - 40 * 24 * H);
  for (const key of ['window', 'windowExport']) {
    await tide(key, 'astro', old, 300);
    await tide(key, 'extreme_astro', new Date(old.getTime() + H), 310, 'high');
  }

  api = await t.connectAs('rws_api');
  owner = await t.connectAs('rws_owner_api');
});

afterAll(async () => {
  await t.drop();
});

describe('astro values in the staleness window', () => {
  const astro = async (key: string, instant: Date) =>
    (await rowsAt(api, TIDE_AT.public, instant))
      .filter((r) => r.series_id === ids[key] && r.kind === 'astro')
      .map((r) => ({ ts: iso(r.ts), value: r.value, hilo: r.hilo }));

  it('returns the columns of the interface', async () => {
    const { fields } = await api.query(`SELECT * FROM ${TIDE_AT.public}($1::timestamptz)`, [T]);
    expect(fields.map((f) => f.name)).toEqual(['series_id', 'kind', 'hilo', 'ts', 'value']);
  });

  it('T = 10:10, measured 10:00: every astro value in (T − 45 min, T], 10:00 and 10:10 both, nothing later', async () => {
    expect(await astro('public', T)).toEqual([
      { ts: iso(at(9, 30)), value: 570, hilo: null },
      { ts: iso(at(10)), value: 600, hilo: null },
      { ts: iso(at(10, 10)), value: 610, hilo: null },
    ]);
    // The measured value Q1 takes at T has an astro value at exactly its own instant (the TS side subtracts that).
    const measured = (await api.query(`SELECT series_id, ts FROM ${OBS_AT.public}($1::timestamptz)`, [T])).rows.find(
      (r) => r.series_id === ids.public,
    );
    expect(iso(measured.ts)).toBe(iso(at(10)));
    expect((await astro('public', T)).find((r) => r.ts === iso(measured.ts))?.value).toBe(600);
  });

  it('returns no astro value older than T − staleness_limit: past a gap there is none', async () => {
    expect(await astro('public', at(11))).toEqual([{ ts: iso(at(10, 20)), value: 620, hilo: null }]);
    expect(await astro('public', at(12))).toEqual([]);
  });

  it('a measured value without an astro value at its instant gets no row at that instant', async () => {
    const measured = (await api.query(`SELECT series_id, ts FROM ${OBS_AT.public}($1::timestamptz)`, [T])).rows.find(
      (r) => r.series_id === ids.noApi,
    );
    expect(iso(measured.ts)).toBe(iso(at(10)));
    const rows = await astro('noApi', T);
    expect(rows.map((r) => r.ts)).toEqual([iso(at(9, 50)), iso(T)]);
    expect(rows.find((r) => r.ts === iso(measured.ts))).toBeUndefined();
  });
});

describe('high and low waters around T', () => {
  const extremes = async (key: string, instant: Date) =>
    (await rowsAt(api, TIDE_AT.public, instant))
      .filter((r) => r.series_id === ids[key] && r.kind !== 'astro')
      .map((r) => `${r.kind} ${r.hilo} ${iso(r.ts)}`)
      .sort();

  it('astro: per high/low the newest in (T − 15 h, T] and the oldest in (T, T + 15 h], edges included as stated', async () => {
    const high = (h: number) => `extreme_astro high ${iso(at(h))}`;
    const low = (h: number) => `extreme_astro low ${iso(at(h))}`;
    // At T itself: the previous one is the one at T (not the older one at −2 h); it is not also the next one.
    expect(await extremes('public', at(0))).toEqual([high(0)]);
    // Exactly 15 h after the high water it is no longer the previous one; the next low is the older of the two.
    expect(await extremes('public', at(15))).toEqual([low(20)]);
    expect(await extremes('public', at(14, 59, 59))).toEqual([high(0), low(20)]);
    // Exactly 15 h before the low water it is the next one; a second earlier it is not.
    expect(await extremes('public', at(5))).toEqual([high(0), low(20)]);
    expect(await extremes('public', at(4, 59, 59))).toEqual([high(0)]);
  });

  it('measured: only the newest in (T − 15 h, T], never one after T', async () => {
    // At T: the high at T − 1 h, not the one at T + 1 h; the low exactly 15 h before T is out.
    expect(await extremes('noApi', T)).toEqual([`extreme high ${iso(at(9, 10))}`]);
    // At 09:00 the low is in the window and both highs lie after it: no high at all, never a next one.
    expect(await extremes('noApi', at(9))).toEqual([`extreme low ${iso(new Date(T.getTime() - 15 * H))}`]);
  });
});

describe('filters', () => {
  const seriesAt = async (client: pg.Client, fn: string, instant = T) =>
    [
      ...new Set(
        (await rowsAt(client, fn, instant)).filter((r) => r.kind === 'astro' && +r.ts === +T).map((r) => r.series_id),
      ),
    ].sort(byNumber);
  const seriesIn = async (client: pg.Client, view: string) =>
    (
      await client.query<{ series_id: number }>(
        `SELECT DISTINCT series_id FROM ${view} WHERE kind = 'astro' AND ts = $1 ORDER BY 1`,
        [T],
      )
    ).rows.map((r) => r.series_id);
  const of = (...keys: string[]) => keys.map((k) => ids[k] as number).sort(byNumber);

  it('visibility: the display channel of each family, primary series only; the api views also need the api channel', async () => {
    const pub = of('public', 'noApi', 'displayOnly', 'window', 'windowExport');
    const own = [...pub, ...of('ownerCanary', 'onlyOwner', 'narrowedOwner', 'widenAudience')].sort(byNumber);
    expect(await seriesAt(api, TIDE_AT.public)).toEqual(pub);
    expect(await seriesAt(owner, TIDE_AT.owner)).toEqual(own);
    // The api pair: not noApi, not the display-only source.
    const apiPub = of('public', 'window', 'windowExport');
    expect(await seriesIn(api, VIEWS.public.api.tide)).toEqual(apiPub);
    expect(await seriesIn(owner, VIEWS.owner.api.tide)).toEqual(
      [...apiPub, ...of('ownerCanary', 'onlyOwner', 'narrowedOwner', 'widenAudience')].sort(byNumber),
    );
    // Never a withheld, off, mirror, twin or no-display series; the canaries follow.
    const pubText = JSON.stringify(await rowsAt(api, TIDE_AT.public, T));
    const ownText = JSON.stringify(await rowsAt(owner, TIDE_AT.owner, T));
    for (const v of [CANARIES.owner.real, CANARIES.withheld.real]) expect(pubText).not.toContain(v);
    expect(ownText).toContain(CANARIES.owner.real);
    expect(ownText).not.toContain(CANARIES.withheld.real);
    for (const key of [...WITHHELD_KEYS, 'noDisplay']) {
      expect(own, key).not.toContain(ids[key]);
      expect(await seriesIn(owner, VIEWS.owner.api.tide), key).not.toContain(ids[key]);
    }
  });

  it('a station that is not flagged tidal carries no tide in the function or the api views (D-2)', async () => {
    // The control: its row is there, in the display tide view.
    expect(await seriesIn(api, VIEWS.public.tide)).toContain(ids.public2);
    expect(await seriesAt(api, TIDE_AT.public)).not.toContain(ids.public2);
    expect(await seriesAt(owner, TIDE_AT.owner)).not.toContain(ids.public2);
    expect(await seriesIn(api, VIEWS.public.api.tide)).not.toContain(ids.public2);
    expect(await seriesIn(owner, VIEWS.owner.api.tide)).not.toContain(ids.public2);
  });

  it('the history rule: a row older than the window needs history export, extremes included', async () => {
    const old = new Date(T.getTime() - 40 * 24 * H);
    const rows = (await rowsAt(api, TIDE_AT.public, old)).filter(
      (r) => r.series_id === ids.window || r.series_id === ids.windowExport,
    );
    expect(rows.map((r) => [r.series_id, r.kind, iso(r.ts)])).toEqual([
      [ids.windowExport, 'astro', iso(old)],
      [ids.windowExport, 'extreme_astro', iso(new Date(old.getTime() + H))],
    ]);
  });

  it('EXECUTE: the family roles only; 42501 for every other login', async () => {
    const roles: [string, LoginRole[], LoginRole[]][] = [
      [TIDE_AT.public, ['rws_api', 'rws_publish'], ['rws_owner_api', 'rws_load', 'rws_backfill']],
      [TIDE_AT.owner, ['rws_owner_api'], ['rws_api', 'rws_publish', 'rws_load', 'rws_backfill']],
    ];
    for (const [fn, allowed, refused] of roles) {
      for (const [role, want] of [
        ...allowed.map((r) => [r, 'ok'] as const),
        ...refused.map((r) => [r, '42501'] as const),
      ]) {
        const c = await t.connectAs(role);
        try {
          expect(await sqlState(c, `SELECT 1 FROM ${fn}(now())`), `${role} ${fn}`).toBe(want);
        } finally {
          await c.end();
        }
      }
    }
  });
});

describe('the plan', () => {
  it('probes tide by its primary key only: no Seq Scan on tide (a copy of the body, enable_seqscan off)', async () => {
    const src = (
      await t.admin.query<{ s: string }>('SELECT prosrc AS s FROM pg_proc WHERE proname = $1', [TIDE_AT.public])
    ).rows[0]?.s as string;
    const body = src.replace(/\bp_t\b/g, '$1::timestamptz');
    expect(body).not.toBe(src);
    await t.admin.query('BEGIN');
    try {
      await t.admin.query('SET LOCAL enable_seqscan = off');
      const plan = (await t.admin.query({ text: `EXPLAIN ${body}`, values: [T], rowMode: 'array' })).rows
        .map((r: unknown[]) => String(r[0]))
        .join('\n');
      // One probe per branch: the astro range, the newest extremes (backward) and the next astro extremes.
      expect(plan.match(/Index (?:Only )?Scan(?: Backward)? using tide_pkey on tide/g), plan).toHaveLength(3);
      expect(plan).toMatch(/Index Scan Backward using tide_pkey on tide/);
      expect(plan).not.toMatch(/Seq Scan on tide\b/);
    } finally {
      await t.admin.query('ROLLBACK');
    }
  });
});
