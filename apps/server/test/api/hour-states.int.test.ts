import { stateCode } from '@rws/contracts';
import fc from 'fast-check';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HourMemo, readHourStates, readStates, StaticCache, snapshotValues } from '../../src/api/states.ts';
import { DisplayWindow } from '../../src/api/window.ts';
import { createApp } from '../../src/app.ts';
import type { Db } from '../../src/db/pool.ts';
import { vigicruesSections } from '../../src/load/tables.ts';
import { rollupInsertSql } from '../e2e/seed.ts';
import { type Harness, harness, KAUB_W } from '../load/harness.ts';

// #112: the state code of every frames cell (readHourStates) against the snapshot it stands for (C1): the cell of hour
// h is what /snapshot would state at the last instant of that hour. A fast-check property over generated hourly
// observations, references (a validity range ending inside the span, NL-4 seasons), station classes (on and off the
// hour) and warning areas; then the fast path, the partial current hour, the owner boundary and the memo.

const H = 3_600_000;
const MIN = 60_000;
const NOW = Date.parse('2026-10-26T12:20:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const sections = vigicruesSections();

let h: Harness;
let pub: Db['db'];
let own: Db['db'];
const id: Record<string, number> = {};
const station: Record<string, string> = {};

type Row = Record<string, unknown>;
const q = async <R extends pg.QueryResultRow = Row>(text: string, args: unknown[] = []): Promise<R[]> =>
  (await h.t.admin.query<R>(text, args)).rows;

async function pick(what: string, where: string): Promise<{ id: number; station: string }> {
  const rows = await q<{ id: number; station_id: string }>(
    `SELECT e.series_id AS id, e.station_id FROM series_eff e JOIN series s ON s.id = e.series_id
     JOIN station st ON st.id = e.station_id WHERE ${where} ORDER BY e.series_id LIMIT 1`,
  );
  const r = rows[0];
  if (r === undefined) throw new Error(`no series for ${what}`);
  return { id: r.id, station: r.station_id };
}

type RefSpec = {
  kind: string;
  value: number;
  source: string;
  semantics: string;
  label?: string | null;
  priority?: number;
  seasonFrom?: number;
  seasonTo?: number;
  period?: string | null;
  validFrom?: number | null;
  validTo?: number | null;
  bounds?: string;
};
const addRef = (series: number, r: RefSpec) =>
  h.t.admin.query(
    `INSERT INTO reference_value (series_id, source_id, kind, value, unit, semantics, period, priority, basis_label,
                                  season_from_md, season_to_md, valid)
     VALUES ($1, $2, $3, $4, 'cm', $5, $6::daterange, $7, $8, $9, $10, tstzrange($11, $12, $13))`,
    [
      series,
      r.source,
      r.kind,
      r.value,
      r.semantics,
      r.period ?? null,
      r.priority ?? 0,
      r.label ?? null,
      r.seasonFrom ?? 101,
      r.seasonTo ?? 1231,
      iso(r.validFrom ?? Date.parse('2020-01-01T00:00:00Z')),
      r.validTo === null || r.validTo === undefined ? null : iso(r.validTo),
      r.bounds ?? '[)',
    ],
  );
const addClass = (stationId: string, source: string, ts: number, code: string | null) =>
  h.t.admin.query(
    `INSERT INTO class_obs (subject_type, subject_id, ts, source_id, provider_code, level_norm)
     VALUES ('station', $1, $2, $3, $4, NULL) ON CONFLICT DO NOTHING`,
    [stationId, iso(ts), source, code],
  );
const addObs = (series: number, ts: number, value: number) =>
  h.t.admin.query('INSERT INTO obs (series_id, ts, value, qc, batch_id) VALUES ($1, $2, $3, 1, 1)', [
    series,
    iso(ts),
    value,
  ]);
const addWarning = (areaKey: string, lo: number, hi: number | null, levelRaw: string) =>
  h.t.admin.query(
    `INSERT INTO warning_area (source_id, area_key, name, level_norm, level_raw, valid)
     VALUES ('CH-5', $1, 'Test section', 3, $2, tstzrange($3, $4))`,
    [areaKey, levelRaw, iso(lo), hi === null ? null : iso(hi)],
  );

/** Removes every generated row of the series and stations under test. */
async function clean() {
  const series = Object.values(id);
  const stations = Object.values(station);
  await q('DELETE FROM obs WHERE series_id = ANY($1)', [series]);
  await q('DELETE FROM obs_1h WHERE series_id = ANY($1)', [series]);
  await q('DELETE FROM reference_value WHERE series_id = ANY($1)', [series]);
  await q('DELETE FROM class_obs WHERE subject_id = ANY($1)', [stations]);
  await q(`DELETE FROM warning_area WHERE area_key LIKE 'river:%' AND source_id = 'CH-5'`);
}

/** The frames of the seeded observations over [from, to): ids, vlast from obs_1h, as the API assembles them. */
async function framesOf(keys: readonly string[], from: number, to: number) {
  await q(rollupInsertSql('obs_1h'));
  const ids = keys.map((k) => id[k] as number);
  const rows = await q<{ series_id: number; bucket: Date; vlast: number }>(
    'SELECT series_id, bucket, vlast FROM obs_1h WHERE series_id = ANY($1) AND bucket >= $2 AND bucket < $3',
    [ids, iso(from), iso(to)],
  );
  const hours = Math.round((to - from) / H);
  const vlast = ids.map((s) => {
    const row: (number | null)[] = Array.from({ length: hours }, () => null);
    for (const r of rows) if (r.series_id === s) row[Math.round((r.bucket.getTime() - from) / H)] = r.vlast;
    return row;
  });
  return { ids, vlast };
}

beforeAll(async () => {
  h = await harness();
  await h.t.admin.query(`SELECT ensure_partitions('2026-09-01T00:00:00Z', '2026-11-01T00:00:00Z')`);
  await h.t.admin.query(
    `UPDATE app_meta SET value = to_jsonb('2026-10-01T00:00:00Z'::text) WHERE key = 'display_start'`,
  );
  const set = async (key: string, what: string, where: string) => {
    const p = await pick(what, where);
    id[key] = p.id;
    station[key] = p.station;
  };
  await set('kaub', 'Kaub W', `s.provider_key = '${KAUB_W}'`);
  await set(
    'chq',
    'CH-1 Q',
    `e.source_id = 'CH-1' AND e.audience = 'public' AND e.role = 'primary' AND s.quantity = 'Q' AND s.active`,
  );
  await set(
    'area',
    'CH-1 H only',
    `e.source_id = 'CH-1' AND e.audience = 'public' AND e.role = 'primary' AND s.quantity = 'H' AND s.active
     AND e.station_id ~ '^ch\\.bafu\\.[0-9]+$' AND NOT EXISTS
       (SELECT 1 FROM series x WHERE x.station_id = e.station_id AND x.quantity = 'Q' AND x.active)`,
  );
  await set(
    'nl',
    'NL-1 H',
    `e.source_id = 'NL-1' AND e.audience = 'public' AND e.role = 'primary' AND s.quantity = 'H' AND s.active
     AND COALESCE((st.flags->>'tidal')::boolean, false) = false`,
  );
  await set(
    'bare',
    'FR-1 stage',
    `e.source_id = 'FR-1' AND e.audience = 'public' AND e.role = 'primary' AND s.quantity = 'H' AND s.value_kind = 'stage' AND s.active
     AND NOT EXISTS (SELECT 1 FROM class_obs c WHERE c.subject_id = e.station_id)`,
  );
  await set('diekirch', 'Diekirch', `s.provider_key = 'Diekirch' AND e.source_id = 'LU-1'`);
  pub = h.dbAs('rws_api', 4).db;
  own = h.dbAs('rws_owner_api', 2).db;
}, 180_000);

afterAll(() => h.close());

const opts = (now: number, cache?: StaticCache) => ({ now, sections, cache });

describe('readHourStates against the snapshot of the last instant of each hour', { timeout: 240_000 }, () => {
  // 2026-09-30T18:00Z: Amsterdam midnight (the NL-4 season change, 1 October) falls inside the span.
  const FROM = Date.parse('2026-09-30T18:00:00Z');
  const keys = ['kaub', 'nl', 'chq', 'area', 'bare'] as const;

  const hourly = (hours: number) =>
    fc.array(
      fc.option(
        fc.record({
          minutes: fc.uniqueArray(fc.integer({ min: 0, max: 59 }), { minLength: 1, maxLength: 3 }),
          values: fc.array(fc.integer({ min: 0, max: 700 }), { minLength: 3, maxLength: 3 }),
        }),
        { nil: null, freq: 5 },
      ),
      { minLength: hours, maxLength: hours },
    );
  const classRows = (hours: number, codes: readonly (string | null)[]) =>
    fc.array(
      fc.record({
        // minutes from FROM: before the span, anywhere, and exactly on an hour boundary (h + 1 h)
        at: fc.oneof(
          fc.integer({ min: -180, max: hours * 60 }),
          fc.integer({ min: 0, max: hours }).map((k) => k * 60),
        ),
        code: fc.constantFrom(...codes),
      }),
      { maxLength: 5 },
    );
  const arb = fc.integer({ min: 6, max: 14 }).chain((hours) =>
    fc.record({
      hours: fc.constant(hours),
      obs: fc.record({
        kaub: hourly(hours),
        nl: hourly(hours),
        chq: hourly(hours),
        area: hourly(hours),
        bare: hourly(hours),
      }),
      kaubRefs: fc.record({
        mnw: fc.integer({ min: 0, max: 300 }),
        mhw: fc.integer({ min: 300, max: 650 }),
        hsw: fc.option(fc.integer({ min: 400, max: 800 }), { nil: null }),
        // the MNW validity ends inside the span; the instant is the hour end, one ms before or after, or mid-hour
        endHour: fc.option(fc.integer({ min: 1, max: hours }), { nil: null }),
        endOffset: fc.constantFrom(0, -1, 1, 30 * MIN),
        bounds: fc.constantFrom('[)', '[]', '(]', '()'),
      }),
      nl4: fc.record({
        summerFrom: fc.integer({ min: 50, max: 350 }),
        summerWidth: fc.integer({ min: 1, max: 300 }),
        winterFrom: fc.integer({ min: 50, max: 350 }),
        winterWidth: fc.integer({ min: 1, max: 300 }),
      }),
      kaubClasses: classRows(hours, ['RP:0', 'RP:1', 'RP:2', 'RP:3', null]),
      chClasses: classRows(hours, ['1', '2', '3', '4', null]),
      warnings: fc.record({
        cuts: fc.uniqueArray(fc.integer({ min: -120, max: hours * 60 }), { minLength: 3, maxLength: 3 }),
        levels: fc.array(fc.constantFrom('1', '2', '3', '4'), { minLength: 2, maxLength: 2 }),
        open: fc.boolean(),
        gap: fc.boolean(),
      }),
    }),
  );

  const seen = { cells: 0, states: new Set<number>() };

  it('equals snapshotValues(readStates) at ts* for every cell whose value lies in the hour (property)', async () => {
    await fc.assert(
      fc.asyncProperty(arb, async (d) => {
        await clean();
        const to = FROM + d.hours * H;
        for (const k of keys)
          for (const [hour, cell] of d.obs[k].entries())
            for (const [i, m] of (cell?.minutes ?? []).entries())
              await addObs(
                id[k] as number,
                FROM + hour * H + m * MIN,
                (cell as { values: number[] }).values[i] as number,
              );
        const r = d.kaubRefs;
        const endMs = r.endHour === null ? null : FROM + r.endHour * H + r.endOffset;
        const period = '[2010-11-01,2020-11-01)';
        await addRef(id.kaub as number, {
          kind: 'MNW',
          value: r.mnw,
          source: 'DE-1',
          semantics: 'statistical',
          period,
          validTo: endMs,
          bounds: r.bounds,
        });
        await addRef(id.kaub as number, {
          kind: 'MHW',
          value: r.mhw,
          source: 'DE-1',
          semantics: 'statistical',
          period,
        });
        if (r.hsw !== null)
          await addRef(id.kaub as number, {
            kind: 'HSW',
            value: r.hsw,
            source: 'DE-1',
            semantics: 'operational',
            period,
          });
        for (const [season, from, width, md] of [
          ['summer', d.nl4.summerFrom, d.nl4.summerWidth, [401, 930]],
          ['winter', d.nl4.winterFrom, d.nl4.winterWidth, [1001, 331]],
        ] as const) {
          for (const [kind, value] of [
            ['NL4_FROM', from],
            ['NL4_TO', from + width],
          ] as const)
            await addRef(id.nl as number, {
              kind,
              value,
              source: 'NL-4',
              semantics: 'provider_class',
              label: `Band ${season}`,
              priority: 1,
              seasonFrom: md[0],
              seasonTo: md[1],
            });
        }
        for (const c of d.kaubClasses) await addClass(station.kaub as string, 'DE-6', FROM + c.at * MIN, c.code);
        for (const c of d.chClasses) await addClass(station.chq as string, 'CH-1', FROM + c.at * MIN, c.code);
        const key = `river:${String(station.area).slice('ch.bafu.'.length)}`;
        const [c0, c1, c2] = [...d.warnings.cuts].sort((a, b) => a - b) as [number, number, number];
        await addWarning(key, FROM + c0 * MIN, FROM + c1 * MIN, d.warnings.levels[0] as string);
        if (!d.warnings.gap || d.warnings.open)
          await addWarning(
            key,
            FROM + (d.warnings.gap ? c1 + 1 : c1) * MIN,
            d.warnings.open ? null : FROM + c2 * MIN,
            d.warnings.levels[1] as string,
          );

        const frames = await framesOf(keys, FROM, to);
        const cache = new StaticCache(60_000, () => NOW);
        const now = to + 5 * H;
        const codes = await readHourStates(pub, 'public', frames, FROM, to, opts(now, cache));
        expect(codes.length).toBe(keys.length);
        for (let hour = 0; hour < d.hours; hour++) {
          const ts = FROM + (hour + 1) * H - 1;
          const snap = new Map(
            snapshotValues(await readStates(pub, 'public', ts, { ...opts(now, cache), current: false })).map((v) => [
              v.series,
              v,
            ]),
          );
          frames.ids.forEach((series, i) => {
            const cell = (codes[i] as (number | null)[])[hour];
            const value = (frames.vlast[i] as (number | null)[])[hour];
            if (value === null) {
              expect(cell, `${keys[i]} hour ${hour}`).toBeNull();
              return;
            }
            const v = snap.get(series);
            if (v === undefined) return;
            const t = Date.parse(v.ts);
            if (t < FROM + hour * H || t >= FROM + (hour + 1) * H) return;
            expect(v.value).toBe(value);
            expect(cell, `${keys[i]} hour ${hour}`).toBe(stateCode(v.state, v.section));
            seen.cells += 1;
            seen.states.add(cell as number);
          });
        }
      }),
      { numRuns: 15 },
    );
    // not vacuous: many cells were compared and the generated rows reached several different codes
    expect(seen.cells).toBeGreaterThan(100);
    expect(seen.states.size).toBeGreaterThanOrEqual(4);
  });
});

describe('readHourStates cases', { timeout: 120_000 }, () => {
  const FROM = Date.parse('2026-10-20T00:00:00Z');
  const TO = FROM + 6 * H;

  it('a series with nothing to classify is 0 in every cell, without a reference, class or area', async () => {
    await clean();
    for (let k = 0; k < 6; k++) await addObs(id.bare as number, FROM + k * H + 5 * MIN, 100 + k);
    const frames = await framesOf(['bare'], FROM, TO);
    expect(await readHourStates(pub, 'public', frames, FROM, TO, opts(NOW))).toEqual([[0, 0, 0, 0, 0, 0]]);
    // null where there is no value, 0 elsewhere
    expect(
      await readHourStates(
        pub,
        'public',
        { ids: [id.bare as number], vlast: [[1, null, 3]] },
        FROM,
        FROM + 3 * H,
        opts(NOW),
      ),
    ).toEqual([[0, null, 0]]);
  });

  it('a known value gets its code: Kaub 9 cm under MNW 65 is low (1), 600 cm over MHW 544 elevated, a series outside the family is 0', async () => {
    await clean();
    const period = '[2010-11-01,2020-11-01)';
    await addRef(id.kaub as number, { kind: 'MNW', value: 65, source: 'DE-1', semantics: 'statistical', period });
    await addRef(id.kaub as number, { kind: 'MHW', value: 544, source: 'DE-1', semantics: 'statistical', period });
    await addObs(id.kaub as number, FROM + 10 * MIN, 9);
    await addObs(id.kaub as number, FROM + H + 10 * MIN, 600);
    const frames = await framesOf(['kaub'], FROM, FROM + 2 * H);
    expect(await readHourStates(pub, 'public', frames, FROM, FROM + 2 * H, opts(NOW))).toEqual([
      [stateCode('low', false), stateCode('elevated', false)],
    ]);
    // an unknown series id (not in the family) is not classified
    expect(
      await readHourStates(pub, 'public', { ids: [987_654_321], vlast: [[5]] }, FROM, FROM + H, opts(NOW)),
    ).toEqual([[0]]);
  });

  it('the partial current hour is classified at now, not at the end of the hour', async () => {
    await clean();
    const now = Date.parse('2026-10-26T12:20:00Z');
    const from = Date.parse('2026-10-26T09:00:00Z');
    const to = Date.parse('2026-10-26T13:00:00Z');
    await addObs(id.kaub as number, now - 15 * MIN, 100);
    await addClass(station.kaub as string, 'DE-6', now - 10 * MIN, 'RP:0');
    // later than now, inside the hour: ts* would see it, now must not
    await addClass(station.kaub as string, 'DE-6', now + 20 * MIN, 'RP:3');
    const frames = await framesOf(['kaub'], from, to);
    const [row] = await readHourStates(pub, 'public', frames, from, to, opts(now));
    expect(row?.slice(0, 3)).toEqual([null, null, null]);
    const at = async (t: number) => {
      const v = snapshotValues(await readStates(pub, 'public', t, { ...opts(now), current: false })).find(
        (x) => x.series === id.kaub,
      );
      return stateCode(v?.state ?? 'no_ref', v?.section ?? false);
    };
    const last = row?.[3] as number;
    expect(last).toBe(await at(now));
    expect(last).not.toBe(0);
    expect(await at(to - 1)).not.toBe(last); // the end of the hour would say something else
  });

  it('the memo: cold and warm give the same codes, a different version key recomputes', async () => {
    await clean();
    const period = '[2010-11-01,2020-11-01)';
    await addRef(id.kaub as number, { kind: 'MNW', value: 65, source: 'DE-1', semantics: 'statistical', period });
    await addRef(id.kaub as number, { kind: 'MHW', value: 544, source: 'DE-1', semantics: 'statistical', period });
    for (let k = 0; k < 6; k++) await addObs(id.kaub as number, FROM + k * H + 5 * MIN, 9);
    const frames = await framesOf(['kaub'], FROM, TO);
    const memo = new HourMemo();
    let version = 1;
    const withMemo = () => ({ ...opts(NOW), memo, versionOf: () => version });
    const low = stateCode('low', false);
    const cold = await readHourStates(pub, 'public', frames, FROM, TO, withMemo());
    expect(cold).toEqual([Array.from({ length: 6 }, () => low)]);
    // the rows change behind the memo: the warm read still gives the remembered codes
    await q('DELETE FROM reference_value WHERE series_id = $1', [id.kaub]);
    expect(await readHourStates(pub, 'public', frames, FROM, TO, withMemo())).toEqual(cold);
    // no memo: the new truth; another version key: recomputed to the same truth
    const truth = [Array.from({ length: 6 }, () => 0)];
    expect(await readHourStates(pub, 'public', frames, FROM, TO, opts(NOW))).toEqual(truth);
    version = 2;
    expect(await readHourStates(pub, 'public', frames, FROM, TO, withMemo())).toEqual(truth);
    version = 1;
    expect(await readHourStates(pub, 'public', frames, FROM, TO, withMemo())).toEqual(cold); // v1 is still kept
    // another family never shares the key
    expect(await readHourStates(own, 'owner', frames, FROM, TO, withMemo())).toEqual(truth);
  });

  it('the owner boundary: an owner-only reference decides in the owner frames and nowhere in the public ones', async () => {
    await clean();
    // Synthetic LU-4 references on Diekirch (owner-audience source); the value sits between ORANGE and RED
    await addRef(id.diekirch as number, {
      kind: 'LU4_ORANGE',
      value: 313.7,
      source: 'LU-4',
      semantics: 'operational',
      label: 'AGE',
    });
    await addRef(id.diekirch as number, {
      kind: 'LU4_RED',
      value: 417.9,
      source: 'LU-4',
      semantics: 'operational',
      label: 'AGE',
    });
    await addRef(id.diekirch as number, {
      kind: 'HQ2',
      value: 351.3,
      source: 'LU-4',
      semantics: 'statistical',
      label: 'AGE',
    });
    const from = NOW - 6 * H - 20 * MIN;
    const start = Math.floor(from / H) * H;
    const end = start + 6 * H;
    for (let k = 0; k < 6; k++) await addObs(id.diekirch as number, start + k * H + 5 * MIN, 330);
    const frames = await framesOf(['diekirch'], start, end);
    const row = (codes: (number | null)[][]) => codes[0] as number[];
    expect(row(await readHourStates(pub, 'public', frames, start, end, opts(NOW)))).toEqual([0, 0, 0, 0, 0, 0]);
    const owner = row(await readHourStates(own, 'owner', frames, start, end, opts(NOW)));
    expect(owner.every((c) => c !== 0)).toBe(true);
    const snap = snapshotValues(await readStates(own, 'owner', start + H - 1, { ...opts(NOW), current: false })).find(
      (v) => v.series === id.diekirch,
    );
    expect(owner[0]).toBe(stateCode(snap?.state ?? 'no_ref', snap?.section ?? false));

    // The answers: the public /api/v1/frames holds the series with code 0, the owner answer the real code.
    const api = h.dbAs('rws_api', 2).db;
    const win = new DisplayWindow(api);
    expect(await win.refresh()).toBe(true);
    const ownerWin = new DisplayWindow(own, undefined, 'owner');
    expect(await ownerWin.refresh()).toBe(true);
    const ask = async (app: ReturnType<typeof createApp>) => {
      const res = await app.request(`/api/v1/frames?from=${iso(start)}&to=${iso(end)}&step=1h`);
      expect(res.status).toBe(200);
      return (await res.json()) as { series: number[]; state: (number | null)[][] };
    };
    const publicBody = await ask(createApp({ db: api, window: win, now: () => new Date(NOW) }));
    const at = publicBody.series.indexOf(id.diekirch as number);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(publicBody.state[at]).toEqual([0, 0, 0, 0, 0, 0]);
    const ownerBody = await ask(createApp({ family: 'owner', db: own, window: ownerWin, now: () => new Date(NOW) }));
    expect(ownerBody.state[ownerBody.series.indexOf(id.diekirch as number)]).toEqual(owner);
  });
});
