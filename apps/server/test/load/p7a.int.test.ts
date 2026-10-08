import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildP7aFixtureArchive, recorded, writePayload } from '../../../../scripts/fixture-archive.ts';
import { VIEWS } from '../../src/db/audience.ts';
import { computeHealth } from '../../src/load/health.ts';
import { parsedOkIn } from '../../src/load/prune.ts';
import { replay } from '../../src/load/replay.ts';
import { type Harness, harness } from './harness.ts';

// P7a end to end through the real loader: the recorded reference, class and warning payloads of DE-1, DE-6, DE-7,
// CH-1, CH-2, CH-5, FR-5 and LU-5 go archive -> manifest -> LOAD_ADAPTERS -> load/refs.ts -> tables -> views in one
// tick; a changed threshold, gauge zero, wl_* and dangerLevel open a new validity range (and promote their payload);
// the owner source LU-4 reaches the owner views only; a replay of every source writes nothing.

let h: Harness;
const NOW = new Date('2026-10-03T12:00:00Z');
const LATER = new Date('2026-10-12T12:00:00Z');
const KAUB = '1d26e504-7f9e-480a-b52c-5932be6549ab';
const SYN = (name: string, source: string) =>
  readFileSync(new URL(`../../src/adapters/${source.toLowerCase()}/fixtures/${name}.synthetic.raw`, import.meta.url));

type Row = Record<string, unknown>;
const q = async (sql: string, args: unknown[] = []): Promise<Row[]> => (await h.t.admin.query(sql, args)).rows;
const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : null);
const counts = async () => ({
  ref: await h.count('reference_value'),
  cls: await h.count('class_obs'),
  warn: await h.count('warning_area'),
  zero: await h.count('gauge_zero'),
});
/** The stored ranges of one series' reference kind, oldest first. */
async function ranges(source: string, key: string, kind: string) {
  const rows = await q(
    `SELECT r.value, lower(r.valid) AS lo, upper(r.valid) AS hi FROM reference_value r JOIN series s ON s.id = r.series_id
     WHERE r.source_id = $1 AND s.provider_key = $2 AND r.kind = $3 ORDER BY lower(r.valid) NULLS FIRST`,
    [source, key, kind],
  );
  return rows.map((r) => ({ value: r.value, lo: iso(r.lo), hi: iso(r.hi) }));
}
const batchKeys = async (source: string) =>
  (await q('SELECT id, archive_key FROM ingest_batch WHERE source_id = $1 ORDER BY id', [source])) as {
    id: string;
    archive_key: string;
  }[];

beforeAll(async () => {
  h = await harness();
}, 120_000);
afterAll(() => h.close());

describe('P7a through the loader', { timeout: 300_000 }, () => {
  it('loads the whole archive in one tick: nothing quarantined, only warning alerts', async () => {
    const lines = await buildP7aFixtureArchive(h.raw);
    expect(lines).toHaveLength(36);
    expect(await h.loader({ now: NOW }).tick()).toEqual({ lines: lines.length, loaded: lines.length });
    expect(await q("SELECT 1 FROM ingest_batch WHERE parse_status <> 'ok'")).toEqual([]);
    expect(new Set(h.alerts.map((a) => a.code))).toEqual(new Set(['warning_changed']));
    for (const a of h.alerts) expect(Object.keys(a.fields).sort()).toEqual(['n', 'source', 'spec']);
  });

  it('DE-6 keeps the newest provider `updated` in source_health.detail (the "Stand" date)', async () => {
    const [row] = await q("SELECT detail ->> 'provider_updated' AS at FROM source_health WHERE source_id = 'DE-6'");
    expect(row?.at).toBe('2026-10-03T08:42:47.000Z');
    // A source without `updated` (DE-1) gets none.
    expect(await q("SELECT 1 FROM source_health WHERE source_id = 'DE-1' AND detail ? 'provider_updated'")).toEqual([]);
  });

  it('reference_value: DE-1 Kaub (C22), DE-7 LANUV, CH-2 wl on the CH-1 series, FR-5 floods on the FR-1 stage', async () => {
    const mnw = await ranges('DE-1', `${KAUB}/W`, 'MNW');
    expect(mnw).toEqual([{ value: 65, lo: null, hi: null }]);
    const kaub = await q(
      `SELECT r.kind, r.value, r.semantics, r.period::text AS period, r.unit FROM reference_value r JOIN series s ON s.id = r.series_id
       WHERE r.source_id = 'DE-1' AND s.provider_key = $1 ORDER BY r.kind`,
      [`${KAUB}/W`],
    );
    const by = Object.fromEntries(kaub.map((r) => [r.kind as string, r]));
    expect(by.MNW).toMatchObject({
      value: 65,
      semantics: 'statistical',
      period: '[2010-11-01,2020-11-01)',
      unit: 'cm',
    });
    expect(by.HSW).toMatchObject({ value: 640, semantics: 'operational' });
    // C22: "NW 25" and "HW 719" are the extremes of the 2010..2020 period, kept as historical.
    expect(by.NW).toMatchObject({ value: 25, semantics: 'historical', period: '[2010-11-01,2020-11-01)' });
    expect(by.HW).toMatchObject({ value: 719, semantics: 'historical', period: '[2010-11-01,2020-11-01)' });

    const lanuv = await q(
      `SELECT r.kind, r.value FROM reference_value r JOIN series s ON s.id = r.series_id
       WHERE r.source_id = 'DE-7' AND s.source_id = 'DE-7' AND s.provider_key = '2829100000100/W' ORDER BY r.kind`,
    );
    expect(lanuv.map((r) => r.kind)).toEqual([
      'LANUV_INFO_1',
      'LANUV_INFO_2',
      'LANUV_INFO_3',
      'LANUV_MHW',
      'LANUV_MNW',
      'LANUV_MW',
    ]);

    const wl = await q(
      `SELECT DISTINCT s.source_id AS series_source, r.kind FROM reference_value r JOIN series s ON s.id = r.series_id
       WHERE r.source_id = 'CH-2' ORDER BY r.kind`,
    );
    expect(wl).toEqual(['WL2', 'WL3', 'WL4', 'WL5'].map((kind) => ({ series_source: 'CH-1', kind })));

    const crue = await q(
      `SELECT s.source_id AS series_source, s.provider_key, r.value, r.semantics FROM reference_value r JOIN series s ON s.id = r.series_id
       WHERE r.source_id = 'FR-5' ORDER BY r.value`,
    );
    expect(crue).toEqual(
      [405, 472, 547].map((value) => ({
        series_source: 'FR-1',
        provider_key: 'B540001001/H',
        value,
        semantics: 'historical',
      })),
    );
  });

  it('class_obs: CH-1 dangerLevel and DE-6 station classes; no class for a station that is off', async () => {
    const ch = await q(
      "SELECT provider_code, count(*)::int AS n FROM class_obs WHERE source_id = 'CH-1' GROUP BY 1 ORDER BY 1",
    );
    expect(ch.map((r) => r.provider_code)).toEqual(['1', 'undefined']);
    // 2043 Berlingen (Bodensee: Rhine, level 1); 2074 Brissago (Lago Maggiore: Ticino, off for scope, Undefined).
    expect(await q("SELECT provider_code, level_norm FROM class_obs WHERE subject_id = 'ch.bafu.2043'")).toEqual([
      { provider_code: '1', level_norm: 2 },
    ]);
    expect(await q("SELECT 1 FROM class_obs WHERE subject_id = 'ch.bafu.2074'")).toEqual([]);

    // Worms: the Rhineland-Palatinate class at 0 (the operator rule of catalogue 4.9), stored with its provenance.
    expect(
      await q("SELECT provider_code FROM class_obs WHERE source_id = 'DE-6' AND subject_id = 'de.wsv.23900200'"),
    ).toEqual([{ provider_code: 'RP:0' }]);
    // The BW class-3 gauge of the 2026-10-02 payload is in no registry table: not stored (and not an error).
    expect(await q("SELECT 1 FROM class_obs WHERE provider_code LIKE 'BW:%'")).toEqual([]);

    // No class row belongs to a station whose every series is off (F).
    expect(
      await q(
        `SELECT c.subject_id FROM class_obs c WHERE c.subject_type = 'station' AND NOT EXISTS
           (SELECT 1 FROM series_eff e WHERE e.station_id = c.subject_id AND e.audience <> 'off')`,
      ),
    ).toEqual([]);
    // The lake payload does list off stations (the premise of the check above).
    const lakeIds = readFileSync(
      new URL('../../src/adapters/ch-1/fixtures/ch-1-lindas-lake.raw', import.meta.url),
      'utf8',
    )
      .split('\n')
      .slice(1)
      .map((l) => l.split(',')[0])
      .filter((id): id is string => !!id);
    const off = await q(
      `SELECT st.id FROM station st WHERE st.id = ANY($1) AND NOT EXISTS
         (SELECT 1 FROM series_eff e WHERE e.station_id = st.id AND e.audience <> 'off')`,
      [lakeIds.map((id) => `ch.bafu.${id}`)],
    );
    expect(off.length).toBeGreaterThan(0);
  });

  it('warning_area: FR-5 sections, CH-5 de only, DE-6 test alerts, the LU-5 timeline of Sud du Luxembourg', async () => {
    const per = Object.fromEntries(
      (await q('SELECT source_id, count(*)::int AS n FROM warning_area GROUP BY 1')).map((r) => [r.source_id, r.n]),
    );
    expect(per).toMatchObject({ 'FR-5': 56, 'CH-5': 93, 'DE-6': 40, 'LU-5': 19 });
    // The en file only translates labels: its batch stored nothing.
    expect(await q("SELECT n_rows FROM ingest_batch WHERE source_id = 'CH-5' ORDER BY id")).toEqual([
      { n_rows: 93 },
      { n_rows: 0 },
    ]);

    const sud = await q(
      `SELECT level_raw, lower(valid) AS lo, upper(valid) AS hi, provider_ref, issued_at, texts FROM warning_area
       WHERE source_id = 'LU-5' AND area_key = 'Sud du Luxembourg' AND lower(valid) < '2025-09-10' ORDER BY lower(valid)`,
    );
    expect(sud.map((r) => [r.level_raw, iso(r.lo), iso(r.hi)])).toEqual([
      ['ALERT_LVL_3', '2025-09-08T11:00:00.000Z', '2025-09-08T15:44:07.000Z'],
      // An Update keeps its original's `effective`, but holds only from its own `sent` (18:32:32+02:00).
      ['ALERT_LVL_2', '2025-09-08T15:44:21.000Z', '2025-09-08T16:32:32.000Z'],
      ['ALERT_LVL_2', '2025-09-08T16:32:32.000Z', '2025-09-08T21:15:02.000Z'],
      // The red alert sent 23:15:02+02:00 = 21:15:02Z holds until its Update (08:04:58+02:00), which holds until the
      // next message (12:00Z).
      ['ALERT_LVL_1', '2025-09-08T21:15:02.000Z', '2025-09-09T06:04:58.000Z'],
      ['ALERT_LVL_1', '2025-09-09T06:04:58.000Z', '2025-09-09T12:00:00.000Z'],
      ['ALERT_LVL_2', '2025-09-09T12:00:00.000Z', '2025-09-09T15:00:00.000Z'],
      ['ALERT_LVL_4', '2025-09-09T15:00:00.000Z', '2025-09-09T22:00:00.000Z'],
    ]);
    // Three languages in the texts of the red row, each with a headline.
    const red = sud[3] as { texts: Record<string, Record<string, string>> };
    expect(Object.keys(red.texts).sort()).toEqual(['de', 'en-US', 'fr-FR']);
    for (const t of Object.values(red.texts)) expect(typeof t.headline).toBe('string');
    // The TEST message of 2026-02-02 (status Actual, a TEST headline) left no row.
    expect(
      await q("SELECT 1 FROM warning_area WHERE source_id = 'LU-5' AND valid && tstzrange('2026-02-02', '2026-02-03')"),
    ).toEqual([]);
    // No two rows of an area overlap (the constraint holds; the red row is not doubled by its Update).
    expect(
      await q(
        `SELECT 1 FROM warning_area a JOIN warning_area b ON a.id < b.id AND a.source_id = b.source_id AND a.area_key = b.area_key AND a.valid && b.valid`,
      ),
    ).toEqual([]);
  });

  it('a changed threshold and gauge zero close the old range at the fetch and open a new one, with counts-only alerts', async () => {
    const { body, at, url } = recorded('de-1-meta');
    const stations = JSON.parse(body.toString('utf8')) as {
      uuid: string;
      timeseries: {
        shortname: string;
        gaugeZero?: { value: number };
        characteristicValues: { shortname: string; value: number }[];
      }[];
    }[];
    const w = stations.find((s) => s.uuid === KAUB)?.timeseries.find((t) => t.shortname === 'W');
    if (w?.gaugeZero === undefined) throw new Error('Kaub W has no gauge zero in the fixture');
    const zero = w.gaugeZero.value;
    w.gaugeZero.value = Math.round((zero + 0.01) * 1000) / 1000;
    const mnw = w.characteristicValues.find((c) => c.shortname === 'MNW');
    if (mnw === undefined) throw new Error('Kaub W has no MNW');
    mnw.value = 66;
    const next = new Date(at.getTime() + 86_400_000);
    h.alerts.length = 0;
    await writePayload(h.archive, {
      source: 'DE-1',
      spec: 'de-1-meta',
      variant: '',
      at: next,
      body: Buffer.from(JSON.stringify(stations)),
      url,
      retention: 'forever',
    });
    await h.loader({ now: LATER }).tick();

    expect(await ranges('DE-1', `${KAUB}/W`, 'MNW')).toEqual([
      { value: 65, lo: null, hi: next.toISOString() },
      { value: 66, lo: next.toISOString(), hi: null },
    ]);
    const gz = await q(
      `SELECT z.value_m, lower(z.valid) AS lo, upper(z.valid) AS hi FROM gauge_zero z JOIN series s ON s.id = z.series_id
       WHERE s.provider_key = $1 ORDER BY lower(z.valid)`,
      [`${KAUB}/W`],
    );
    expect(gz).toHaveLength(2);
    expect(gz[0]?.value_m).toBeCloseTo(zero, 6);
    expect(gz[1]?.value_m).toBeCloseTo(zero + 0.01, 6);
    expect(iso(gz[0]?.hi)).toBe(next.toISOString());
    expect(iso(gz[1]?.lo)).toBe(next.toISOString());
    expect(gz[1]?.hi).toBeNull();
    expect(h.alerts).toEqual([
      { code: 'gauge_zero_changed', fields: { source: 'DE-1', spec: 'de-1-meta', n: 1 } },
      { code: 'reference_changed', fields: { source: 'DE-1', spec: 'de-1-meta', n: 1 } },
    ]);
    // Only Kaub changed: every other DE-1 key was confirmed, not re-opened.
    expect(await h.count('gauge_zero')).toBeGreaterThan(2);
    expect(await q("SELECT 1 FROM reference_value WHERE source_id = 'DE-1' AND upper(valid) IS NOT NULL")).toHaveLength(
      1,
    );
  });

  it('a changed CH-2 wl and CH-1 dangerLevel open a new range and a new class; only those payloads are promoted forever', async () => {
    const wl = recorded('ch-2-pq-relative', 'CH-2');
    const lake = recorded('ch-1-lindas-lake', 'CH-1');
    // ch-2-pq-wl-changed.synthetic edits wl_2 of 2269 (Lonza, a Rhone station: off for scope), so it changes no
    // stored range. A copy of the real body with wl_2 of 2437 (Rhine, 11450 l/s) raised to 12000 l/s does.
    const edited = Buffer.from(wl.body.toString('utf8').replace('"wl_2":"11450 l/s"', '"wl_2":"12000 l/s"'));
    expect(edited.equals(wl.body)).toBe(false);
    const at = (hour: number) => new Date(`2026-10-04T${String(hour).padStart(2, '0')}:00:00Z`);
    const put = (source: string, spec: string, variant: string, when: Date, body: Buffer, url: string) =>
      writePayload(h.archive, {
        source,
        spec,
        variant,
        at: when,
        body,
        url,
        retention: 'forever',
        ...(source === 'CH-1' ? { method: 'POST' as const } : {}),
      });
    // A class is keyed by the observation's own time. The shipped dl-changed copy keeps the recorded `time`: a newer
    // payload's class at the same instant replaces the stored one in place (newest fetch wins, review CR-1). The
    // same cube read at a later instant opens a row.
    const shift = (body: Buffer, time: string) =>
      Buffer.from(body.toString('utf8').replaceAll('2026-09-30T12:40:00+01:00', time));
    const dl = shift(SYN('ch-1-lindas-dl-changed', 'CH-1'), '2026-10-04T08:40:00+01:00');
    const back = shift(lake.body, '2026-10-04T10:40:00+01:00');
    await put('CH-2', 'ch-2-pq', 'default', at(9), SYN('ch-2-pq-wl-changed', 'CH-2'), wl.url);
    await put('CH-1', 'ch-1-lindas', 'lake', at(9), SYN('ch-1-lindas-dl-changed', 'CH-1'), lake.url);
    await put('CH-1', 'ch-1-lindas', 'lake', at(10), dl, lake.url);
    await put('CH-2', 'ch-2-pq', 'default', at(10), edited, wl.url);
    // The same bodies again: a confirmation opens nothing.
    await put('CH-2', 'ch-2-pq', 'default', at(11), edited, wl.url);
    await put('CH-1', 'ch-1-lindas', 'lake', at(11), dl, lake.url);
    // The original bodies, fetched last: they change the values back (a new range each, not an edit).
    await put('CH-2', 'ch-2-pq', 'default', at(12), wl.body, wl.url);
    await put('CH-1', 'ch-1-lindas', 'lake', at(12), back, lake.url);
    h.alerts.length = 0;
    await h.loader({ now: LATER }).tick();
    expect(await q("SELECT 1 FROM ingest_batch WHERE parse_status <> 'ok'")).toEqual([]);

    // WL3 (wl_2) of 2437: 11.45 m³/s, 12 from 10:00, 11.45 again from 12:00.
    const wl3 = (await ranges('CH-2', '2437/Q', 'WL3')).map((r) => ({
      ...r,
      value: Math.round(Number(r.value) * 100) / 100,
    }));
    expect(wl3).toEqual([
      { value: 11.45, lo: null, hi: at(10).toISOString() },
      { value: 12, lo: at(10).toISOString(), hi: at(12).toISOString() },
      { value: 11.45, lo: at(12).toISOString(), hi: null },
    ]);
    // The off Rhone station takes no reference, changed or not.
    expect(await ranges('CH-2', '2269/Q', 'WL3')).toEqual([]);
    // 2043 Berlingen: dl 1 at the recorded instant, replaced by 3 (the changed copy, fetched later), then 1 again at a
    // later instant.
    const berlingen = await q("SELECT provider_code FROM class_obs WHERE subject_id = 'ch.bafu.2043' ORDER BY ts");
    expect(berlingen.map((r) => r.provider_code)).toEqual(['3', '1']);
    expect(h.alerts.map((a) => a.code).sort()).toEqual([
      'class_changed',
      'class_changed',
      'reference_changed',
      'reference_changed',
    ]);
    for (const a of h.alerts) expect(Object.keys(a.fields).sort()).toEqual(['n', 'source', 'spec']);

    // parsedOkIn never lists a batch that opened a reference range or a class row (the forever promotion of a
    // changed wl_* or dangerLevel payload, A7.2); it lists one that opened nothing.
    const listed = async (source: string) => {
      const rows = await batchKeys(source);
      const ok = await parsedOkIn(h.load.db)(rows.map((r) => r.archive_key));
      return rows.map((r) => ok.has(r.archive_key));
    };
    // CH-2: the first load (opened), the Lonza edit (opened nothing), the 12000 l/s body (opened), its repeat
    // (nothing), the original again (opened).
    expect(await listed('CH-2')).toEqual([false, true, false, true, false]);
    // CH-1: the first load (its rows now held by the newer copy of the same instant), the shipped copy at the
    // recorded instant (holds every class of that instant, Berlingen's changed), the changed cube at a later instant
    // (nothing new: the same classes), its repeat (nothing), dl 1 again (opened).
    expect(await listed('CH-1')).toEqual([true, false, true, true, false]);
  });

  it('LU-4 (owner): references only in the owner view, a changed orange level is a new range, alerts hold counts only', async () => {
    const t = (d: number) => new Date(`2026-10-0${d}T13:00:00Z`);
    const pages: [string, string, number][] = [
      ['lu-4-page-normal', 'alzette/alzette/mersch', 4],
      ['lu-4-pages-hesperange', 'alzette/alzette/hesperange', 5],
      ['lu-4-pages-stadtbredimus', 'moselle/moselle/stadtbredimus', 6],
      ['lu-4-pages-heiderscheidergrund', 'sure/sure/heiderscheidergrund', 7],
    ];
    for (const [name, variant, day] of pages)
      await writePayload(h.archive, {
        source: 'LU-4',
        spec: 'lu-4-pages',
        variant,
        at: t(day),
        body: SYN(name, 'LU-4'),
        url: `https://inondations.public.lu/fr/${variant}.html`,
        retention: 'forever',
      });
    h.alerts.length = 0;
    await h.loader({ now: LATER }).tick();
    expect(await q("SELECT 1 FROM ingest_batch WHERE source_id = 'LU-4' AND parse_status <> 'ok'")).toEqual([]);
    expect(await q("SELECT 1 FROM ingest_batch WHERE source_id = 'LU-4'")).toHaveLength(4);
    const kinds = (await q("SELECT DISTINCT kind FROM reference_value WHERE source_id = 'LU-4' ORDER BY kind")).map(
      (r) => r.kind,
    );
    expect(kinds).toEqual(expect.arrayContaining(['LU4_ORANGE', 'LU4_RED', 'LU4_YELLOW']));
    // The references sit on the gauge's LU-1 and LU-2 stage series and, for Stadtbredimus, on its DE-1 twin.
    const onSeries = await q(
      `SELECT DISTINCT s.source_id FROM reference_value r JOIN series s ON s.id = r.series_id
       WHERE r.source_id = 'LU-4' AND s.provider_key IN ('Mersch', 'SN_Stadtbredimus', 'dfdf753b-75bd-46f0-8cde-15545be9bfba/W')
       ORDER BY 1`,
    );
    expect(onSeries.map((r) => r.source_id)).toEqual(['DE-1', 'LU-1']);

    // Later: the orange level of the Mersch page moves from 341 to 352 cm.
    await writePayload(h.archive, {
      source: 'LU-4',
      spec: 'lu-4-pages',
      variant: 'alzette/alzette/mersch',
      at: new Date('2026-10-10T13:00:00Z'),
      body: SYN('lu-4-page-orange-changed', 'LU-4'),
      url: 'https://inondations.public.lu/fr/alzette/alzette/mersch.html',
      retention: 'forever',
    });
    h.alerts.length = 0;
    await h.loader({ now: LATER }).tick();
    const merschOrange = await q(
      `SELECT r.value, upper(r.valid) AS hi, s.source_id FROM reference_value r JOIN series s ON s.id = r.series_id
       WHERE r.source_id = 'LU-4' AND r.kind = 'LU4_ORANGE' AND r.value IN (341, 352) ORDER BY s.source_id, lower(r.valid) NULLS FIRST`,
    );
    // The Mersch gauge has an LU-1 and an LU-2 series: each closes 341 at the fetch and opens 352.
    expect(merschOrange.map((r) => [r.source_id, r.value, iso(r.hi)])).toEqual([
      ['LU-1', 341, '2026-10-10T13:00:00.000Z'],
      ['LU-1', 352, null],
      ['LU-2', 341, '2026-10-10T13:00:00.000Z'],
      ['LU-2', 352, null],
    ]);
    expect(h.alerts).toEqual([{ code: 'reference_changed', fields: { source: 'LU-4', spec: 'lu-4-pages', n: 2 } }]);
    // Invariant 11: no alert carries a value; the only number is the count n.
    for (const a of h.alerts)
      for (const [k, v] of Object.entries(a.fields)) if (typeof v === 'number') expect(k).toBe('n');

    const api = await h.t.connectAs('rws_api');
    const own = await h.t.connectAs('rws_owner_api');
    const where = "source_id IN ('LU-4', 'BE-3')";
    expect((await api.query(`SELECT 1 FROM ${VIEWS.public.reference} WHERE ${where}`)).rows).toEqual([]);
    const seen = await own.query(`SELECT DISTINCT source_id FROM ${VIEWS.owner.reference} WHERE ${where}`);
    expect(seen.rows).toEqual([{ source_id: 'LU-4' }]);
    // The public views still show the public references (DE-1) and the owner family shows them too.
    expect(
      (await api.query(`SELECT 1 FROM ${VIEWS.public.reference} WHERE source_id = 'DE-1' LIMIT 1`)).rows,
    ).toHaveLength(1);
  });

  it('a replay of every P7a source twice writes nothing', async () => {
    const before = await counts();
    const shape = () =>
      q(
        `SELECT md5(string_agg(concat_ws('|', series_id, source_id, kind, value, valid::text, period::text), ',' ORDER BY series_id, source_id, kind, lower(valid))) AS s
         FROM reference_value`,
      );
    const refs = await shape();
    const deps = {
      db: h.load.db,
      reader: h.reader,
      alert: (code: string, fields: Record<string, string | number> = {}) => h.alerts.push({ code, fields }),
      now: () => LATER,
    };
    for (const source of ['DE-1', 'DE-6', 'DE-7', 'CH-1', 'CH-2', 'CH-5', 'FR-5', 'LU-5', 'LU-4']) {
      for (let round = 0; round < 2; round++) {
        const r = await replay(deps, { source, spec: null, from: '2026-09-01', to: '2026-12-31', dryRun: false });
        expect({ source, round, ...r }).toMatchObject({ source, round, quarantined: 0, n_new: 0, n_changed: 0 });
        expect(r.lines).toBeGreaterThan(0);
      }
    }
    expect(await counts()).toEqual(before);
    expect(await shape()).toEqual(refs);
  });

  it('#72: other senders’ files load ok with no rows, and a replay turns the batches the first deploy quarantined ok', async () => {
    const names = ['unrecognized-keys', 'too-big', 'text-char', 'lu-alert'].map((n) => `lu-5-other-${n}`);
    const keys: string[] = [];
    for (const name of names) {
      const { body, at, url } = recorded(name, 'LU-5');
      const { variant } = JSON.parse(
        readFileSync(new URL(`../../src/adapters/lu-5/fixtures/${name}.meta.json`, import.meta.url), 'utf8'),
      ) as { variant: string };
      const line = await writePayload(h.archive, {
        source: 'LU-5',
        spec: 'lu-5-cap',
        variant,
        at,
        body,
        url,
        retention: 'forever',
      });
      keys.push(line.key as string);
    }
    const batches = () =>
      q(
        'SELECT parse_status, error, n_rows, n_skipped, adapter_version FROM ingest_batch WHERE archive_key = ANY($1)',
        [keys],
      );
    const ok = names.map(() => ({ parse_status: 'ok', error: null, n_rows: 0, n_skipped: 0, adapter_version: 2 }));
    const rows = async () => (await q("SELECT count(*)::int AS n FROM warning_area WHERE source_id = 'LU-5'"))[0]?.n;
    const quarantines = async () => {
      const backlog = { files: 0, bytes: 0, age_s: null };
      await computeHealth(h.load.db, { cadenceS: new Map(), lagP95Ms: new Map(), backlog, badLines: 0, now: LATER });
      return (await q("SELECT quarantine_count FROM source_health WHERE source_id = 'LU-5'"))[0]?.quarantine_count;
    };

    h.alerts.length = 0;
    expect(await h.loader({ now: LATER }).tick()).toEqual({ lines: 4, loaded: 4 });
    expect(await batches()).toEqual(ok);
    expect(h.alerts).toEqual([]);
    expect(await rows()).toBe(19);
    expect(await quarantines()).toBe(0);

    // The state the first deploy left: adapter version 1 quarantined these files under its strict schema.
    await q(
      "UPDATE ingest_batch SET parse_status = 'quarantined', error = 'unrecognized_keys', adapter_version = 1 WHERE archive_key = ANY($1)",
      [keys],
    );
    expect(await quarantines()).toBe(4);
    const r = await replay(
      {
        db: h.load.db,
        reader: h.reader,
        alert: (code: string, fields: Record<string, string | number> = {}) => h.alerts.push({ code, fields }),
        now: () => LATER,
      },
      { source: 'LU-5', spec: 'lu-5-cap', from: '2026-09-01', to: '2026-12-31', dryRun: false },
    );
    expect(r).toMatchObject({ quarantined: 0, n_new: 0, n_changed: 0, loaded: r.lines });
    expect(r.lines).toBeGreaterThanOrEqual(4);
    expect(await batches()).toEqual(ok);
    expect(h.alerts).toEqual([]);
    expect(await rows()).toBe(19);
    expect(await quarantines()).toBe(0);
  });

  it('#72: through the wire, an empty or repeated sender is quarantined as not_cap, never other_sender', async () => {
    const { body, at, url } = recorded('lu-5-other-unrecognized-keys', 'LU-5');
    const police = '<sender>[Police]</sender>';
    const senders = ['<sender></sender>', `${police}${police}`];
    const keys: string[] = [];
    for (const [i, sender] of senders.entries()) {
      const line = await writePayload(h.archive, {
        source: 'LU-5',
        spec: 'lu-5-cap',
        variant: `file/not-cap-${i}`,
        at: new Date(at.getTime() + (i + 1) * 1000),
        body: Buffer.from(body.toString('utf8').replace(police, sender)),
        url,
        retention: 'forever',
      });
      keys.push(line.key as string);
    }
    h.alerts.length = 0;
    expect(await h.loader({ now: LATER }).tick()).toEqual({ lines: 2, loaded: 0 });
    expect(await q('SELECT parse_status, error, n_rows FROM ingest_batch WHERE archive_key = ANY($1)', [keys])).toEqual(
      senders.map(() => ({ parse_status: 'quarantined', error: 'not_cap', n_rows: 0 })),
    );
    expect(h.alerts.map((a) => [a.code, a.fields.code])).toEqual(senders.map(() => ['quarantined', 'not_cap']));
    expect(await q("SELECT count(*)::int AS n FROM warning_area WHERE source_id = 'LU-5'")).toEqual([{ n: 19 }]);
  });
});
