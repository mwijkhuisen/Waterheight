import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AttributionEntry, CANARIES, HealthSourcesAnswer, MetaAnswer, SnapshotAnswer } from '@rws/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DisplayWindow } from '../../src/api/window.ts';
import { createApp } from '../../src/app.ts';
import type { Db } from '../../src/db/pool.ts';
import { FILLED_BY } from '../../src/load/adapters.ts';
import { publishTail } from '../../src/load/migrate.ts';
import { vigicruesSections } from '../../src/load/tables.ts';
import { publishOnce } from '../../src/publish/index.ts';
import { type Harness, harness, KAUB_W } from '../load/harness.ts';
import { OWNER_IDS } from '../publish/s2-ctx.ts';
import { walk } from '../publish/tree.ts';
import { ask, captureLog, iso } from './sweep.ts';

// P9b (plan 4.6, C11, C19; issue #24 "attribution lists exactly the sources present, incl. the required date"): a
// mixed fixture of Vigicrues (FR-5 section state, FR-1 values, one FR-3 fill value), LHP (a DE-6 class basis) and BAFU
// (CH-1 values and a CH-4 forecast), asked of every route of the public API and read from the P9a files. An
// INDEPENDENT extractor in this file (it does not import the server's bodySources) names the sources a body holds;
// the answer's `attribution` must be exactly those, among the sources that have attribution rows, never a withheld or
// owner-audience source, each dated source with its date (DE-6 with its "Stand"), recent/settled/frames files by set
// and kind only (their date is null by design, A§9.1).

const NOW = new Date('2026-10-26T12:00:00Z');
const T_NOW = NOW.getTime();
const OBS = { cur: '2026-10-26T11:50:00Z', past: '2026-10-20T11:50:00Z', settled: '2026-10-23T11:50:00Z' };
const HOUR = 3_600_000;

let h: Harness;
let api: Db;
const id: Record<string, number> = {};
const station: Record<string, string> = {};
const dirs: string[] = [];
const logs: string[] = [];
const q = async <R extends Record<string, unknown> = Record<string, unknown>>(text: string, args: unknown[] = []) =>
  (await h.t.admin.query<R>(text, args)).rows;

/** My own tables, read from the base tables: which source a series belongs to, who has attribution rows, who is public. */
let sourceOfSeries = new Map<number, string>();
let withRows = new Set<string>();
let publicSources = new Set<string>();
let dated = new Map<string, string>();
/** The fill rule of A§6 (qc bit 512), written out here: FR-3 fills FR-1, CH-3 fills CH-1. */
const FILLS: Record<string, readonly string[]> = { 'FR-1': ['FR-3'], 'CH-1': ['CH-3'] };

/** The sources a body names, by this file's own reading of the body (never the server's `bodySources`). */
function extract(body: unknown, fills = true): Set<string> {
  const out = new Set<string>();
  const series = (sid: number, qc?: number) => {
    const s = sourceOfSeries.get(sid);
    if (s === undefined) throw new Error(`a body names the unknown series ${sid}`);
    out.add(s);
    if (fills && qc !== undefined && (qc & 512) !== 0) for (const f of FILLS[s] ?? []) out.add(f);
  };
  const walkNode = (n: unknown, key?: string): void => {
    if (Array.isArray(n)) {
      for (const x of n) {
        if (key === 'sources' && typeof x === 'object' && x !== null && typeof (x as { id?: unknown }).id === 'string')
          out.add((x as { id: string }).id);
        walkNode(x, key);
      }
      return;
    }
    if (n === null || typeof n !== 'object') return;
    const o = n as Record<string, unknown>;
    // /snapshot values and /series/{id}/forecast: a series id, with its qc beside it.
    if (typeof o.series === 'number') series(o.series, typeof o.qc === 'number' ? o.qc : undefined);
    // The column files: parallel arrays of series ids and qc.
    if (Array.isArray(o.series) && o.series.length > 0 && o.series.every((x) => typeof x === 'number'))
      for (const [i, sid] of (o.series as number[]).entries())
        series(sid, Array.isArray(o.qc) ? (o.qc[i] as number) : undefined);
    // latest.json's `lapsed` (KG-233): the series with no value, whose newest value's age is the source's data too.
    if (Array.isArray(o.lapsed) && o.lapsed.every((x) => typeof x === 'number'))
      for (const sid of o.lapsed as number[]) series(sid);
    // A station's series row, and a /series answer (its points' qc or qcOr).
    if (typeof o.id === 'number' && 'quantity' in o) series(o.id);
    // A station file's series row: parallel ts, value and qc arrays.
    if (typeof o.id === 'number' && Array.isArray(o.qc)) for (const q of o.qc as number[]) series(o.id, q);
    if (typeof o.id === 'number' && 'res' in o) {
      series(o.id);
      for (const p of (o.points ?? []) as { qc?: number; qcOr?: number }[]) series(o.id, p.qc ?? p.qcOr);
    }
    if (typeof o.source === 'string') out.add(o.source);
    for (const [k, v] of Object.entries(o)) if (k !== 'attribution') walkNode(v, k);
  };
  walkNode(body);
  return out;
}

const entriesOf = (body: unknown): AttributionEntry[] => (body as { attribution: AttributionEntry[] }).attribution;

/** The one rule: the attribution is the named sources that have rows, none outside the public family. */
function exact(label: string, body: unknown) {
  const named = extract(body);
  for (const s of named) expect(publicSources.has(s), `${label}: names ${s}, which is not a public source`).toBe(true);
  const sources = entriesOf(body).map((a) => a.source);
  expect(new Set(sources), label).toEqual(new Set([...named].filter((s) => withRows.has(s))));
  for (const s of sources) {
    expect(publicSources.has(s), `${label}: ${s}`).toBe(true);
    expect(OWNER_IDS.includes(s), `${label}: ${s} is an owner source`).toBe(false);
  }
  return { named, entries: entriesOf(body) };
}

/** An answer of the API: its date rules (C11): every dated entry has its date, DE-6 its Stand. */
function dateRules(label: string, entries: readonly AttributionEntry[]) {
  for (const e of entries) {
    expect(e.dateKind, `${label}: ${e.source}`).toBe(dated.get(e.source) ?? null);
    if (e.dateKind !== null) expect(e.date, `${label}: ${e.source} has no date`).not.toBeNull();
    if (e.source === 'DE-6') expect(e.dateText, label).toMatch(/^Stand: \d\d\.\d\d\.\d{4} \d\d:\d\d$/);
    else expect(e.dateText, `${label}: ${e.source}`).toBeNull();
  }
}

let app: ReturnType<typeof createApp>;
const getJson = async (path: string, application = app) => {
  const a = await ask(application, { path, label: path }, 'identity');
  return { status: a.status, body: JSON.parse(a.text) as unknown, text: a.text, headers: a.headerMap };
};

async function pick(where: string): Promise<{ id: number; station: string }> {
  const rows = await q<{ id: number; station_id: string }>(
    `SELECT e.series_id AS id, e.station_id FROM series_eff e JOIN series s ON s.id = e.series_id
     JOIN station st ON st.id = e.station_id WHERE ${where} ORDER BY e.series_id LIMIT 1`,
  );
  const r = rows[0];
  if (r === undefined) throw new Error(`no series for ${where}`);
  return { id: r.id, station: r.station_id };
}

const putObs = (series: number, ts: string, value: number, qc = 1) =>
  h.t.admin.query('INSERT INTO obs (series_id, ts, value, qc, batch_id) VALUES ($1, $2, $3, $4, 1)', [
    series,
    ts,
    value,
    qc,
  ]);

beforeAll(async () => {
  h = await harness();
  const a = h.t.admin;
  await a.query(`SELECT ensure_partitions('2026-09-01T00:00:00Z', '2026-11-01T00:00:00Z')`);
  await a.query(`UPDATE app_meta SET value = to_jsonb('2026-10-01T00:00:00Z'::text) WHERE key = 'display_start'`);

  const kaub = await pick(`s.provider_key = '${KAUB_W}'`);
  id.kaub = kaub.id;
  station.kaub = kaub.station;
  const chq = await pick(
    `e.source_id = 'CH-1' AND e.audience = 'public' AND e.role = 'primary' AND s.quantity = 'Q' AND s.active`,
  );
  id.chq = chq.id;
  station.chq = chq.station;
  const sections = vigicruesSections();
  const fr = await q<{ id: number; station_id: string }>(
    `SELECT e.series_id AS id, e.station_id FROM series_eff e JOIN series s ON s.id = e.series_id
     WHERE e.source_id = 'FR-1' AND e.audience = 'public' AND e.role = 'primary' AND s.quantity = 'H'
       AND s.value_kind = 'stage' AND s.active AND e.station_id = ANY($1) ORDER BY e.series_id`,
    [[...sections.keys()]],
  );
  const frIn = fr[0];
  const frFill = fr.find(
    (r) => r.id !== frIn?.id && sections.get(r.station_id) !== sections.get(frIn?.station_id ?? ''),
  );
  if (frIn === undefined || frFill === undefined) throw new Error('no two FR-1 stage stations in Vigicrues sections');
  id.frIn = frIn.id;
  id.frFill = frFill.id;
  const be = await pick(
    `e.source_id = 'BE-3' AND e.audience = 'owner' AND e.role = 'primary' AND s.quantity = 'H' AND s.value_kind = 'stage' AND s.active`,
  );
  id.be = be.id;

  // LHP: a DE-6 class on Kaub; Vigicrues: an FR-5 vigilance on the section of frIn.
  await a.query(
    `INSERT INTO class_obs (subject_type, subject_id, ts, source_id, provider_code, level_norm)
     VALUES ('station', $1, '2026-10-01T00:00:00Z', 'DE-6', 'RP:0', 2)`,
    [station.kaub],
  );
  await a.query(
    `INSERT INTO warning_area (source_id, area_key, name, level_norm, level_raw, valid)
     VALUES ('FR-5', $1, 'Test vigilance', 3, '2', tstzrange('2026-10-01T00:00:00Z', NULL))`,
    [sections.get(frIn.station_id)],
  );
  for (const [key, value] of [
    ['kaub', 400],
    ['chq', 500],
    ['frIn', 120],
    ['be', 20],
  ] as const)
    for (const ts of Object.values(OBS)) await putObs(id[key] as number, ts, value);
  // A value filled from another source's payload (qc bit 512: FR-3 into FR-1).
  for (const ts of Object.values(OBS)) await putObs(id.frFill as number, ts, 130, 512);
  // BAFU's forecast (CH-4) on the CH-1 discharge series.
  const run = await q<{ id: string }>(
    `INSERT INTO forecast_run (series_id, source_id, issued_at, first_valid, last_valid, fetched_at, content_hash, kind)
     VALUES ($1, 'CH-4', $2, $2, $3, $2, decode(md5('p9b-attribution'), 'hex'), 'deterministic') RETURNING id`,
    [id.chq, iso(T_NOW - HOUR), iso(T_NOW + 6 * HOUR)],
  );
  await a.query(
    `INSERT INTO forecast_value (run_id, valid_ts, value)
     SELECT $1, $2::timestamptz + g * interval '1 hour', 450 + g FROM generate_series(0, 7) g`,
    [(run[0] as { id: string }).id, iso(T_NOW - HOUR)],
  );
  // The loader's state: every source fetched 5 minutes ago (a class or area counts only while it is fresh); DE-6's own
  // update instant ("Stand"), FR-5's newest data, and no instant for FR-1 (its date falls back to the body's).
  for (const source of ['DE-1', 'DE-6', 'CH-1', 'CH-4', 'FR-1', 'FR-3', 'FR-5', 'NL-1', 'BE-3'])
    await a.query(
      `INSERT INTO source_health (source_id, status, last_fetch_ok) VALUES ($1, 'ok', $2)
       ON CONFLICT (source_id) DO UPDATE SET last_fetch_ok = EXCLUDED.last_fetch_ok`,
      [source, new Date(T_NOW - 5 * 60_000)],
    );
  await a.query(
    `UPDATE source_health SET detail = detail || '{"provider_updated": "2026-10-26T10:30:00.000Z"}'::jsonb WHERE source_id = 'DE-6'`,
  );
  await a.query(`UPDATE source_health SET newest_ts = $1 WHERE source_id = 'FR-5'`, [new Date(T_NOW - 20 * 60_000)]);

  await publishTail(h.dbAs('rws_migrator', 1).db, NOW);

  sourceOfSeries = new Map(
    (await q<{ id: number; source_id: string }>('SELECT id, source_id FROM series')).map((r) => [r.id, r.source_id]),
  );
  withRows = new Set(
    (
      await q<{ source_id: string }>(
        `SELECT DISTINCT a.source_id FROM attribution a JOIN source s ON s.id = a.source_id
         WHERE s.audience = 'public' AND s.lic_display`,
      )
    ).map((r) => r.source_id),
  );
  publicSources = new Set(
    (await q<{ id: string }>(`SELECT id FROM source WHERE audience = 'public' AND lic_display`)).map((r) => r.id),
  );
  dated = new Map(
    (
      await q<{ source_id: string; date_kind: string }>(
        'SELECT DISTINCT source_id, date_kind FROM attribution WHERE date_kind IS NOT NULL',
      )
    ).map((r) => [r.source_id, r.date_kind]),
  );

  api = h.dbAs('rws_api', 4);
  const window = new DisplayWindow(api.db);
  expect(await window.refresh()).toBe(true);
  app = createApp({ db: api.db, window, now: () => NOW, log: captureLog(logs) });
}, 240_000);

afterAll(async () => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  await h?.close();
});

describe('the mixed fixture', () => {
  it('names Vigicrues, LHP and BAFU: FR-1, FR-5 and FR-3, DE-1 and DE-6, CH-1 and CH-4, with dated licences', async () => {
    const { body } = await getJson(`/api/v1/snapshot?t=${iso(T_NOW)}`);
    const snap = SnapshotAnswer.parse(body);
    const named = extract(body);
    for (const s of ['DE-1', 'DE-6', 'CH-1', 'FR-1', 'FR-5', 'FR-3']) expect(named, s).toContain(s);
    expect(snap.values.find((v) => v.series === id.kaub)?.basis?.source).toBe('DE-6');
    const fr = snap.values.find((v) => v.series === id.frIn);
    expect((fr?.basis ?? fr?.area?.basis)?.source).toBe('FR-5');
    expect(snap.values.find((v) => v.series === id.frFill)?.qc).toBe(512);
    for (const s of ['DE-6', 'FR-5', 'FR-1', 'FR-3']) expect(dated.get(s), s).toBe('update');
    for (const s of ['CH-1', 'CH-4']) expect(dated.get(s), s).toBe('retrieval');
    expect(JSON.stringify(body)).not.toMatch(/BE-3|CANARY-OWNER|nl\.canary|[^0-9]20\.0[^0-9]/);
  });

  it("my fill table is the loader's (a new fill source must be added to this file)", () => {
    expect(Object.fromEntries([...FILLED_BY].map(([k, v]) => [k, [...v]]))).toEqual(
      Object.fromEntries(Object.entries(FILLS).map(([k, v]) => [k, [...v]])),
    );
  });
});

describe('every route of the public API', { timeout: 120_000 }, () => {
  const paths = () => {
    const win = `from=${iso(T_NOW - 8 * 24 * HOUR)}&to=${iso(T_NOW)}`;
    return {
      meta: ['/api/v1/meta'],
      stations: ['/api/v1/stations'],
      snapshot: [
        `/api/v1/snapshot?t=${iso(T_NOW)}`, // now
        `/api/v1/snapshot?t=${iso(T_NOW - 6 * 24 * HOUR)}`, // past
        `/api/v1/snapshot?t=${iso(T_NOW - 3 * 24 * HOUR)}`, // a settled day
        `/api/v1/snapshot?t=${iso(T_NOW + 3 * HOUR)}`, // future: forecasts only
        `/api/v1/snapshot?t=${iso(T_NOW + 3 * HOUR)}&v=1`,
        `/api/v1/snapshot?t=${iso(T_NOW)}&v=1`,
      ],
      series: [
        ...['kaub', 'chq', 'frIn', 'frFill'].map((k) => `/api/v1/series/${id[k]}?${win}`),
        `/api/v1/series/${id.frFill}?${win}&res=1h`,
        `/api/v1/series/${id.frFill}?from=${iso(T_NOW - 20 * 24 * HOUR)}&to=${iso(T_NOW)}&res=1d`,
      ],
      forecast: [
        `/api/v1/series/${id.chq}/forecast`,
        `/api/v1/series/${id.chq}/forecast?asof=${iso(T_NOW)}`,
        `/api/v1/series/${id.chq}/forecast?asof=${iso(T_NOW - 5 * 24 * HOUR)}`, // no run yet: null
        `/api/v1/series/${id.kaub}/forecast`,
      ],
      health: ['/api/v1/health/sources'],
    } as const;
  };

  for (const route of ['meta', 'stations', 'snapshot', 'series', 'forecast', 'health'] as const) {
    it(`${route}: attribution is exactly the sources in each body, dated where a licence asks`, async () => {
      for (const path of paths()[route]) {
        const { status, body } = await getJson(path);
        expect(status, path).toBe(200);
        const { named, entries } = exact(path, body);
        dateRules(path, entries);
        expect(named.size, path).toBeGreaterThan(0);
        // Not vacuous: a body that names a source with rows has entries.
        if ([...named].some((s) => withRows.has(s))) expect(entries.length, path).toBeGreaterThan(0);
      }
    });
  }

  it('the answers differ by what they hold: the future snapshot names CH-4, the series answers their own source and fill', async () => {
    const future = exact('future', (await getJson(`/api/v1/snapshot?t=${iso(T_NOW + 3 * HOUR)}`)).body);
    expect(future.named).toContain('CH-4');
    expect(future.named).toContain('CH-1');
    const fill = exact(
      'fill',
      (await getJson(`/api/v1/series/${id.frFill}?from=${iso(T_NOW - 8 * 24 * HOUR)}&to=${iso(T_NOW)}`)).body,
    );
    expect([...fill.named].sort()).toEqual(['FR-1', 'FR-3']);
    const lone = exact(
      'kaub',
      (await getJson(`/api/v1/series/${id.kaub}?from=${iso(T_NOW - 8 * 24 * HOUR)}&to=${iso(T_NOW)}`)).body,
    );
    expect([...lone.named]).toEqual(['DE-1']);
    const empty = exact(
      'no run',
      (await getJson(`/api/v1/series/${id.chq}/forecast?asof=${iso(T_NOW - 5 * 24 * HOUR)}`)).body,
    );
    expect([...empty.named]).toEqual(['CH-1']);
  });

  it('the dates: live answers by what the loader knows (DE-6 Stand from its own update), historical by the body', async () => {
    const live = entriesOf((await getJson(`/api/v1/snapshot?t=${iso(T_NOW)}`)).body);
    const de6 = live.find((e) => e.source === 'DE-6');
    expect(de6).toMatchObject({
      dateKind: 'update',
      date: '2026-10-26T10:30:00.000Z',
      dateText: 'Stand: 26.10.2026 11:30',
    });
    // FR-5 has a stored newest instant: 11:40; FR-1 has none: the newest value of the body (11:50).
    expect(live.find((e) => e.source === 'FR-5')?.date).toBe('2026-10-26T11:40:00.000Z');
    expect(live.find((e) => e.source === 'FR-1')?.date).toBe('2026-10-26T11:50:00.000Z');
    expect(live.find((e) => e.source === 'CH-1')).toMatchObject({
      dateKind: 'retrieval',
      date: '2026-10-26T11:55:00.000Z',
    });
    // A historical answer is a pure function of its data: the newest value of each source in the body, else the
    // answer's own instant (DE-6 is named by a class basis, not by a value: 12:00Z is 14:00 in Berlin).
    const past = entriesOf((await getJson(`/api/v1/snapshot?t=${iso(T_NOW - 6 * 24 * HOUR)}`)).body);
    expect(past.find((e) => e.source === 'CH-1')?.date).toBe('2026-10-20T11:50:00.000Z');
    expect(past.find((e) => e.source === 'DE-6')?.dateText).toBe('Stand: 20.10.2026 14:00');
  });

  it('a refusal is the fixed body with an empty attribution, and a body with no source has none', async () => {
    for (const path of [
      '/api/v1/snapshot?t=bad',
      '/api/v1/series/9999999?from=2026-10-20T00:00Z&to=2026-10-21T00:00Z',
      '/api/v1/nope',
    ]) {
      const a = await getJson(path);
      expect(entriesOf(a.body), path).toEqual([]);
      expect(a.status, path).toBeGreaterThanOrEqual(400);
    }
    const quiet = await getJson(`/api/v1/snapshot?t=${iso(T_NOW - 20 * 24 * HOUR)}`);
    expect(quiet.status).toBe(200);
    exact('empty snapshot', quiet.body);
  });

  it('never lists a withheld or owner source: not in meta, health or any attribution (owner canary, BE-3 values in the database)', async () => {
    const meta = MetaAnswer.parse((await getJson('/api/v1/meta')).body);
    const health = HealthSourcesAnswer.parse((await getJson('/api/v1/health/sources')).body);
    for (const body of [meta, health]) {
      const sources = new Set(body.attribution.map((e) => e.source));
      for (const s of OWNER_IDS) expect(sources.has(s), s).toBe(false);
      for (const s of sources) expect(publicSources.has(s), s).toBe(true);
    }
    for (const text of [JSON.stringify(meta), JSON.stringify(health)])
      for (const r of [CANARIES.owner.text, CANARIES.owner.real, 'nl.canary.owner']) expect(text).not.toContain(r);
    expect(new Set(meta.attribution.map((e) => e.source)).size).toBeGreaterThan(5);
  });
});

describe('the files of the public publisher', { timeout: 300_000 }, () => {
  let files: Map<string, string>;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rws-p9b-attribution-'));
    dirs.push(dir);
    const pub = h.dbAs('rws_publish', 3);
    await publishOnce(pub.db, 'public', dir, { now: T_NOW, settledDays: 2 });
    files = walk(dir);
  }, 240_000);

  /** The mismatches of every file's attribution array against this file's reading of its body. */
  const mismatches = (fills: boolean, only?: (rel: string) => boolean) => {
    const out: string[] = [];
    for (const [rel, text] of files) {
      if (only !== undefined && !only(rel)) continue;
      const body = JSON.parse(text) as unknown;
      if (typeof body !== 'object' || body === null || !('attribution' in body)) continue;
      const listed = new Set(entriesOf(body).map((e) => e.source));
      const want = new Set([...extract(body, fills)].filter((x) => withRows.has(x)));
      if ([...want].sort().join() !== [...listed].sort().join())
        out.push(`${rel}: lists ${[...listed].sort().join(',')} for ${[...want].sort().join(',')}`);
    }
    return out;
  };

  it('every file that holds an attribution array lists exactly the sources its body names', () => {
    let checked = 0;
    const kinds = new Set<string>();
    for (const [rel, text] of files) {
      const body = JSON.parse(text) as unknown;
      if (typeof body !== 'object' || body === null || !('attribution' in body)) continue;
      for (const x of extract(body)) expect(publicSources.has(x), `${rel}: names ${x}`).toBe(true);
      kinds.add(rel.split('/')[0]?.replace(/\.json$/, '') ?? rel);
      // The date rules by kind: a dated source has its kind in every file; recent, settled and frames carry no date.
      for (const e of entriesOf(body)) {
        expect(e.dateKind, `${rel}: ${e.source}`).toBe(dated.get(e.source) ?? null);
        if (/^(recent|settled|frames)\//.test(rel)) expect(e.date, `${rel}: ${e.source}`).toBeNull();
      }
      checked++;
    }
    expect(mismatches(true)).toEqual([]);
    expect(checked).toBeGreaterThan(50);
    for (const kind of ['latest', 'stations', 'sources', 'recent', 'settled', 'frames', 'forecast', 'meta', 'status'])
      expect(kinds, kind).toContain(kind);
  });

  // Found by this file before the fix (P9b): the publisher's files attributed only their series' sources. They now name
  // the fill source of a value with qc bit 512 (FR-3 behind FR-1) and forecast/latest.json the series a run sits on, as
  // the API does (answer.ts valueSources); without fills the reading must differ, so the check above can fail.
  it('the static files attribute the fill source of a qc-512 value and the series source of a forecast, as the API does', () => {
    expect(mismatches(true)).toEqual([]);
    expect(mismatches(false).length).toBeGreaterThan(0);
  });

  it('latest.json and the settled snapshot of the mixed fixture name FR-1, FR-3, FR-5, DE-6, CH-1 and CH-4 as the API does', () => {
    const latest = JSON.parse(files.get('latest.json') as string) as unknown;
    const named = extract(latest);
    for (const s of ['DE-1', 'DE-6', 'CH-1', 'FR-1', 'FR-5', 'FR-3']) expect(named, s).toContain(s);
    const settled = [...files].find(([rel]) => rel.startsWith('settled/2026-10-23/'));
    expect(settled, 'a settled snapshot of 10-23').toBeDefined();
    const dated23 = [...files].filter(([rel]) => rel.startsWith('settled/2026-10-23/'));
    expect(dated23.some(([, text]) => extract(JSON.parse(text)).has('FR-3'))).toBe(true);
  });
});

describe('a body that names a source outside the family fails closed (C19)', () => {
  it('503 unavailable, logged as attribution_missing, with the fixed body: a stale static cache that lacks a source the live views now show', async () => {
    const win = `/api/v1/series/${id.chq}/forecast`;
    const before = logs.length;
    try {
      // CH-4 is off when this app first loads its static rows (the source view), and public again when it reads the run.
      await h.t.admin.query(`UPDATE source SET audience = 'off' WHERE id = 'CH-4'`);
      const w = new DisplayWindow(api.db);
      expect(await w.refresh()).toBe(true);
      const fresh = createApp({ db: api.db, window: w, now: () => NOW, log: captureLog(logs) });
      const warm = await ask(fresh, { path: '/api/v1/meta', label: 'meta' }, 'identity');
      expect(warm.status).toBe(200);
      await h.t.admin.query(`UPDATE source SET audience = 'public' WHERE id = 'CH-4'`);
      const a = await ask(fresh, { path: win, label: win }, 'identity');
      expect([a.status, a.text, a.headerMap['cache-control']]).toEqual([
        503,
        '{"error":"unavailable","attribution":[]}',
        'no-store',
      ]);
      expect(logs.slice(before).join('\n')).toContain('attribution_missing');
      // A fresh app (a new static cache) sees CH-4 and answers.
      const ok = createApp({ db: api.db, window: w, now: () => NOW, log: captureLog(logs) });
      expect((await ask(ok, { path: win, label: win }, 'identity')).status).toBe(200);
    } finally {
      await h.t.admin.query(`UPDATE source SET audience = 'public' WHERE id = 'CH-4'`);
    }
  });
});
