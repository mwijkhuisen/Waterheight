import { CANARIES, FRAMES_MAX_HOURS, FramesAnswer, stateCode } from '@rws/contracts';
import { OwnerFramesAnswer } from '@rws/contracts/api-owner';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Limiter } from '../../src/api/limiter.ts';
import { DayVersions, IMMUTABLE } from '../../src/api/versions.ts';
import { DisplayWindow } from '../../src/api/window.ts';
import { createApp } from '../../src/app.ts';
import type { Db } from '../../src/db/pool.ts';
import { openApiDb } from '../../src/main.ts';
import { seedAudienceFixture } from '../db/seed.ts';
import { createTestDb, type TestDb } from '../db/testdb.ts';
import { ask, captureLog, iso, type Req } from './sweep.ts';

// P11b W1: /api/v1/frames against a real PostgreSQL 18 as the real rws_api and rws_owner_api logins: the public answer
// holds no owner series and none of the three canaries, the owner answer holds the SPW (BE-3) series and the owner
// canary, the 14-day cap, the heavy class and the immutable rule.

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / 1000) * 1000;
const TO = Math.floor(NOW / HOUR) * HOUR;
const get = (path: string): Req => ({ path, label: path });
const span = (from: number, to: number) => `from=${iso(from)}&to=${iso(to)}&step=1h`;

let t: TestDb;
let ids: Record<string, number>;
let ownerDb: Db;
let publicDb: Db;
let owner: ReturnType<typeof createApp>;
let pub: ReturnType<typeof createApp>;
let limited: ReturnType<typeof createApp>;
let versions: DayVersions;
const logs: string[] = [];
const json = async (app: ReturnType<typeof createApp>, path: string) => {
  const a = await ask(app, get(path), 'identity', '203.0.113.50');
  return { ...a, body: JSON.parse(a.text) as Record<string, unknown> };
};

beforeAll(async () => {
  t = await createTestDb();
  ids = await seedAudienceFixture(t.admin);
  await t.admin.query(`
    INSERT INTO attribution (source_id, ord, lang, text, needs_date, date_kind, required) VALUES
      ('DE-1', 0, 'de', 'DE1-ATTRIBUTION', false, NULL, false),
      ('CH-1', 0, 'de', 'CH1-ATTRIBUTION', true, 'retrieval', true),
      ('BE-3', 0, 'fr', 'Sources des donnees : SPW', false, NULL, true),
      ('CANARY-OWNER', 0, 'nl', 'OWNERCANARY-ATTRIBUTION', false, NULL, true)`);
  await t.admin.query(`UPDATE app_meta SET value = to_jsonb($1::text) WHERE key = 'display_start'`, [
    iso(NOW - 50 * DAY),
  ]);
  // Hourly rows of every seeded series at three known hours: a recent pair and one settled hour 7 days back. The
  // seeded canaries sit in the series that must never leave their audience (value per key, as the seed has them).
  const at = [TO - 3 * HOUR, TO - 2 * HOUR, TO - 7 * DAY + 5 * HOUR];
  for (const [key, id] of Object.entries(ids)) {
    const v = key === 'ownerCanary' ? CANARIES.owner.value : key === 'withheld' ? CANARIES.withheld.value : 100;
    // A series without history export keeps its answer for the rest of its window (never immutable): no old hour there.
    const mine = key === 'window' ? at.slice(0, 2) : at;
    await t.admin.query(
      `INSERT INTO obs_1h (series_id, bucket, vmin, vmax, vavg, vlast, n, qc_or)
       SELECT $1, b, $2, $2, $2, $2, 4, 1 FROM unnest($3::timestamptz[]) b ON CONFLICT (series_id, bucket) DO NOTHING`,
      [id, v, mine.map(iso)],
    );
  }
  // #112: an hour of ids.public with 400 cm (public MNW 65 / MHW 544: normal; the owner-only LU-4 orange at 350: a state) and
  // that owner-only reference (synthetic).
  await t.admin.query(
    `INSERT INTO obs_1h (series_id, bucket, vmin, vmax, vavg, vlast, n, qc_or)
     VALUES ($1, $2, 400, 400, 400, 400, 4, 1) ON CONFLICT (series_id, bucket) DO NOTHING`,
    [ids.public, iso(TO - 5 * HOUR)],
  );
  await t.admin.query(
    `INSERT INTO reference_value (series_id, source_id, kind, value, unit, semantics, period, valid)
     VALUES ($1, 'LU-4', 'LU4_ORANGE', 350, 'cm', 'operational', NULL, tstzrange('2020-01-01', NULL)),
            ($1, 'DE-1', 'MNW', 65, 'cm', 'statistical', '[2010-11-01,2020-11-01)', tstzrange('2020-01-01', NULL)),
            ($1, 'DE-1', 'MHW', 544, 'cm', 'statistical', '[2010-11-01,2020-11-01)', tstzrange('2020-01-01', NULL))`,
    [ids.public],
  );
  const owned = openApiDb({ DATABASE_URL: t.urlFor('rws_owner_api') }, undefined, 'owner');
  const open = openApiDb({ DATABASE_URL: t.urlFor('rws_api') });
  if (typeof owned === 'string' || typeof open === 'string') throw new Error('no database');
  ownerDb = owned;
  publicDb = open;
  const ownerWindow = new DisplayWindow(ownerDb.db, undefined, 'owner');
  expect(await ownerWindow.refresh()).toBe(true);
  const publicWindow = new DisplayWindow(publicDb.db);
  expect(await publicWindow.refresh()).toBe(true);
  versions = new DayVersions(publicDb.db, 'public');
  expect(await versions.refresh()).toBe(true);
  const log = captureLog(logs);
  owner = createApp({ family: 'owner', db: ownerDb.db, window: ownerWindow, now: () => new Date(NOW), log });
  pub = createApp({ db: publicDb.db, window: publicWindow, versions, now: () => new Date(NOW), log });
  limited = createApp({
    db: publicDb.db,
    window: publicWindow,
    now: () => new Date(NOW),
    log,
    limiter: new Limiter({ now: () => 0 }),
  });
}, 120_000);

afterAll(async () => {
  versions?.stop();
  await Promise.allSettled([ownerDb?.close(), publicDb?.close()]);
  await t?.drop();
});

describe('/api/v1/frames, public', () => {
  it('answers the active api-channel series, no owner series and none of the canaries', async () => {
    const a = await json(pub, `/api/v1/frames?${span(TO - 14 * DAY, TO)}`);
    expect(a.status).toBe(200);
    const body = FramesAnswer.parse(a.body);
    expect(body.vlast.every((r) => r.length === 14 * 24)).toBe(true);
    expect(body.series).toContain(ids.public);
    for (const key of ['onlyOwner', 'ownerCanary', 'withheld', 'narrowedOff', 'narrowedOwner', 'displayOnly', 'noApi'])
      expect(body.series, key).not.toContain(ids[key]);
    for (const needle of [CANARIES.owner.text, CANARIES.owner.real, CANARIES.withheld.text, CANARIES.withheld.real])
      expect(a.text).not.toContain(needle);
    expect(a.text).not.toContain('654321.987');
    expect(a.text).not.toContain('654322');
    expect(a.text).not.toContain('OWNERCANARY');
    expect(a.text).not.toContain('"audience"');
    // The values sit in the hours the seed wrote, null elsewhere, nothing carried forward.
    const row = body.vlast[body.series.indexOf(ids.public as number)] as (number | null)[];
    expect(row.filter((v) => v !== null).length).toBeGreaterThanOrEqual(3); // the seed's midnight bucket may add one
    expect(row[row.length - 3]).toBe(100);
    expect(row[row.length - 1]).toBeNull();
    expect(a.headerMap['cache-control']).toMatch(/^public, max-age=/);
  });

  it('refuses a span over 14 days, before and after the window, and bad parameters, with the fixed codes', async () => {
    const code = async (q: string, status: number, error: string) => {
      const a = await json(pub, `/api/v1/frames?${q}`);
      expect([a.status, a.body.error], q).toEqual([status, error]);
      expect(a.body.attribution).toEqual([]);
    };
    await code(span(TO - 14 * DAY - HOUR, TO), 400, 'span_too_long');
    await code(span(TO - 60 * DAY, TO - 40 * DAY), 400, 'span_too_long');
    await code(span(TO - 80 * DAY, TO - 79 * DAY), 400, 'out_of_range');
    await code(span(TO - HOUR, TO + 2 * HOUR), 400, 'out_of_range');
    await code(`from=${iso(TO - 3 * HOUR)}&to=${iso(TO)}`, 400, 'bad_parameter');
    await code(`${span(TO - 3 * HOUR, TO)}&zz=1`, 400, 'unknown_parameter');
    await code(`${span(TO - 3 * HOUR, TO)}&step=1h`, 400, 'repeated_parameter');
  });

  it('is in the heavy class: 20 in a burst, the 21st a 429 with Retry-After', async () => {
    const q = '/api/v1/frames?step=2h';
    for (let i = 0; i < 20; i++) expect((await json(limited, q)).status, String(i)).toBe(400);
    const last = await json(limited, q);
    expect([last.status, last.body.error]).toEqual([429, 'rate_limited']);
    expect(Number(last.headerMap['retry-after'])).toBeGreaterThanOrEqual(1);
  });
});

describe('/api/v1/frames, caching', () => {
  const settled = `/api/v1/frames?${span(TO - 8 * DAY, TO - 5 * DAY)}`;
  it('is immutable only with a v equal to the version of every spanned settled day', async () => {
    const without = await json(pub, settled);
    expect(without.status).toBe(200);
    expect(without.headerMap['cache-control']).not.toMatch(/immutable/);
    const right = await json(pub, `${settled}&v=1`);
    expect(right.headerMap['cache-control']).toBe(IMMUTABLE);
    expect(right.text).toBe(without.text);
    const wrong = await json(pub, `${settled}&v=2`);
    expect(wrong.headerMap['cache-control']).not.toMatch(/immutable/);
    // The data of the settled hour is in it.
    const body = FramesAnswer.parse(right.body);
    const row = body.vlast[body.series.indexOf(ids.public as number)] as (number | null)[];
    expect(row.filter((v) => v !== null)).toEqual([100]);
  });

  it('is not immutable when a spanned day is not settled, whatever v says', async () => {
    const recent = await json(pub, `/api/v1/frames?${span(TO - 2 * DAY, TO)}&v=1`);
    expect(recent.status).toBe(200);
    expect(recent.headerMap['cache-control']).not.toMatch(/immutable/);
  });

  it('a bump of a spanned day makes a new key, so the stale v is no longer immutable', async () => {
    versions.set(new Map([[new Date(TO - 7 * DAY).toISOString().slice(0, 10), 2]]));
    try {
      const old = await json(pub, `${settled}&v=1`);
      expect(old.headerMap['cache-control']).not.toMatch(/immutable/);
    } finally {
      versions.set(new Map());
    }
  });
});

describe('/api/v1/frames, owner', () => {
  it('holds the SPW series and the owner canary, audience owner, private no-store', async () => {
    const a = await json(owner, `/api/v1/frames?${span(TO - 14 * DAY, TO)}`);
    expect(a.status).toBe(200);
    const body = OwnerFramesAnswer.parse(a.body);
    expect(body.audience).toBe('owner');
    expect(body.series).toContain(ids.onlyOwner);
    expect(body.series).toContain(ids.ownerCanary);
    expect(body.series).not.toContain(ids.withheld);
    expect(a.text).toMatch(/777777\.7/);
    expect(a.text).not.toContain(CANARIES.withheld.text);
    expect(a.text).not.toContain('654321.987');
    expect(a.headerMap['cache-control']).toBe('private, no-store');
    expect(body.attribution.map((e) => e.source)).toEqual(expect.arrayContaining(['BE-3', 'CANARY-OWNER']));
    // v never makes an owner answer cacheable.
    const v = await json(owner, `/api/v1/frames?${span(TO - 8 * DAY, TO - 5 * DAY)}&v=1`);
    expect(v.headerMap['cache-control']).toBe('private, no-store');
  });

  it('the cap is the same: 336 hours', async () => {
    expect(FRAMES_MAX_HOURS).toBe(336);
    expect((await json(owner, `/api/v1/frames?${span(TO - 14 * DAY - HOUR, TO)}`)).body.error).toBe('span_too_long');
  });
});

describe('/api/v1/frames, state codes (#112)', () => {
  const at = TO - 5 * HOUR; // an hour of ids.public with a value between the owner-only 350 and the public MHW 725
  const SETTLED_HOUR = TO - 7 * DAY + 5 * HOUR;
  const recent = `/api/v1/frames?${span(TO - 3 * DAY, TO)}`;
  const settled = `/api/v1/frames?${span(TO - 8 * DAY, TO - 5 * DAY)}`;
  const cellOf = (
    body: { series: number[]; vlast: (number | null)[][]; state: (number | null)[][] },
    start: number,
    ms: number,
  ) => {
    const row = body.series.indexOf(ids.public as number);
    const hour = Math.round((ms - start) / HOUR);
    return { value: body.vlast[row]?.[hour], code: body.state[row]?.[hour] };
  };

  it('is version 2 with a state row per series, a code exactly where a value is, in the public and owner answers', async () => {
    for (const [app, parse] of [
      [pub, (b: unknown) => FramesAnswer.parse(b)],
      [owner, (b: unknown) => OwnerFramesAnswer.parse(b)],
    ] as const) {
      const a = await json(app, recent);
      expect(a.status).toBe(200);
      const body = parse(a.body);
      expect(body.schemaVersion).toBe(2);
      expect(body.state.length).toBe(body.series.length);
      for (const [i, row] of body.vlast.entries())
        for (const [hour, v] of row.entries()) expect(body.state[i]?.[hour] === null, `${i}/${hour}`).toBe(v === null);
    }
  });

  it('a classified series gets its code, the owner-only reference counts in the owner answer only', async () => {
    const pubCell = cellOf(FramesAnswer.parse((await json(pub, recent)).body), TO - 3 * DAY, at);
    const ownCell = cellOf(OwnerFramesAnswer.parse((await json(owner, recent)).body), TO - 3 * DAY, at);
    expect(pubCell.value).toBe(400);
    // 400 cm is between the public MNW 65 and MHW 544 cm: normal; the owner-only LU-4 level of 350 cm makes it more
    expect(pubCell.code).toBe(stateCode('normal', false));
    expect(ownCell.value).toBe(400);
    expect(ownCell.code).not.toBe(pubCell.code);
    expect(ownCell.code).toBeGreaterThan(pubCell.code as number);
    // the owner answer never leaks into the public one: no owner-only series, value or audience
    const text = (await json(pub, recent)).text;
    expect(text).not.toContain('"audience"');
  });

  it('keeps the settled days per version: the same body again, a version bump recomputes', async () => {
    const first = await json(pub, settled);
    const code = (b: Record<string, unknown>) => cellOf(b as never, TO - 8 * DAY, SETTLED_HOUR);
    const before = code(first.body);
    expect(before.value).toBe(100);
    expect(before.code).toBe(stateCode('normal', false));
    expect((await json(pub, settled)).text).toBe(first.text);
    // The hour's value changes behind the day's version: the answer for that version stays as it was
    await t.admin.query('UPDATE obs_1h SET vlast = 800 WHERE series_id = $1 AND bucket = $2', [
      ids.public,
      iso(SETTLED_HOUR),
    ]);
    try {
      expect((await json(pub, settled)).text).toBe(first.text);
      versions.set(new Map([[iso(SETTLED_HOUR).slice(0, 10), 3]])); // 3: version 2's key was used by the test above
      const bumped = code((await json(pub, settled)).body);
      expect(bumped.value).toBe(800);
      expect(bumped.code).toBe(stateCode('elevated', false)); // over the public MHW 544
    } finally {
      versions.set(new Map());
      await t.admin.query('UPDATE obs_1h SET vlast = 100 WHERE series_id = $1 AND bucket = $2', [
        ids.public,
        iso(SETTLED_HOUR),
      ]);
    }
  });
});
