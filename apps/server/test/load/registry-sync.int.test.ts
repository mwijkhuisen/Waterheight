import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { VIEWS } from '../../src/db/audience.ts';
import { readRegistry, syncRegistry } from '../../src/load/registry-sync.ts';
import { sqlState } from '../db/testdb.ts';
import { type Harness, harness } from './harness.ts';

// Registry sync (issue #17 †): audience, private_basis and the licence channels
// are copied unchanged, attribution verbatim; series come only from the
// station rows; the loader role cannot run it.

let h: Harness;
const yaml = (name: string) => parse(readFileSync(new URL(`../../../../registry/${name}`, import.meta.url), 'utf8'));

beforeAll(async () => {
  h = await harness();
});

afterAll(async () => {
  await h.close();
});

// A sync writes about 1,700 series and 1,000 stations since P5a (1–2 s); the tests that sync again and again need more
// than the default 5 s.
describe('registry sync', { timeout: 60_000 }, () => {
  it('copies audience, private_basis and the channel flags of every source unchanged', async () => {
    const sources = yaml('sources.yaml').sources as Record<string, unknown>[];
    const { rows } = await h.t.admin.query(
      'SELECT id, provider_id, name, licence, licence_kind, audience, private_basis, lic_display, lic_api, lic_bulk_export, lic_history_export, capture_enabled, canary FROM source ORDER BY id',
    );
    expect(rows).toHaveLength(sources.length);
    const expected = sources
      .map((s) => ({
        id: s.id,
        provider_id: s.provider,
        name: s.name,
        licence: s.licence_text,
        licence_kind: s.licence_kind,
        audience: s.audience,
        private_basis: s.private_basis,
        lic_display: s.display,
        lic_api: s.api,
        lic_bulk_export: s.bulk_export,
        lic_history_export: s.history_export,
        capture_enabled: s.capture_enabled,
        canary: s.canary === true,
      }))
      .sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));
    expect(rows).toEqual(expected);
    // The owner sources of the plan carry their verbatim clause.
    const owner = rows.filter((r) => r.audience === 'owner').map((r) => r.id);
    expect(owner).toEqual(['BE-3', 'CANARY-OWNER', 'DE-2', 'DE-3', 'LU-2', 'LU-3', 'LU-4']);
    for (const r of rows) expect(r.private_basis === null, r.id).toBe(r.audience !== 'owner');
  });

  it("never rewrites attribution: text, language and variants are the registry's, byte for byte", async () => {
    const sources = yaml('sources.yaml').sources as {
      id: string;
      attribution_text: string | null;
      attribution_lang: string | null;
      attribution_variants: { lang: string | null; text: string }[];
      attribution_required: boolean;
    }[];
    const { rows } = await h.t.admin.query(
      'SELECT source_id, ord, lang, text, required FROM attribution ORDER BY source_id, ord',
    );
    const expected = sources
      .flatMap((s) =>
        [
          ...(s.attribution_text === null ? [] : [{ lang: s.attribution_lang, text: s.attribution_text }]),
          ...s.attribution_variants,
        ].map((a, ord) => ({ source_id: s.id, ord, lang: a.lang, text: a.text, required: s.attribution_required })),
      )
      .sort((a, b) => (a.source_id === b.source_id ? a.ord - b.ord : a.source_id < b.source_id ? -1 : 1));
    expect(rows).toEqual(expected);
    expect(rows.find((r) => r.source_id === 'DE-1')?.text).toBe(
      'Pegeldaten: WSV/GDWS via PEGELONLINE (pegelonline.wsv.de), Datenlizenz Deutschland – Zero – Version 2.0 (https://www.govdata.de/dl-de/zero-2-0). Ungeprüfte Rohdaten.',
    );
  });

  it('declares unit, factor, datum, steps and staleness per series, from the station rows only', async () => {
    const { rows } = await h.t.admin.query(
      `SELECT count(*)::int AS series, count(DISTINCT station_id)::int AS stations,
              (count(*) FILTER (WHERE native_unit = 'm+NN' AND to_canonical = 100 AND datum = 'NN' AND value_kind = 'level'))::int AS m_nn,
              (count(*) FILTER (WHERE native_unit = 'm+NN'))::int AS m_nn_all,
              (count(*) FILTER (WHERE native_unit = 'cm' AND to_canonical = 1 AND value_kind = 'stage'))::int AS cm,
              (count(*) FILTER (WHERE quantity = 'Q' AND native_unit = 'm³/s' AND datum IS NULL AND value_kind IS NULL))::int AS q,
              (count(*) FILTER (WHERE native_step = '1 min' AND expected_step = '15 min'))::int AS one_minute,
              (count(*) FILTER (WHERE staleness_limit = '45 min'))::int AS stale45,
              (count(*) FILTER (WHERE audience IS NOT NULL OR lic_override IS NOT NULL))::int AS narrowed
       FROM series WHERE source_id = 'DE-1'`,
    );
    expect(rows).toEqual([
      { series: 238, stations: 199, m_nn: 9, m_nn_all: 9, cm: 189, q: 40, one_minute: 20, stale45: 238, narrowed: 1 },
    ]);
    // The one narrowed DE-1 series: NEUWIED STADT, off until the owner has verified its licence (review C12).
    const off = (
      await h.t.admin.query("SELECT station_id, audience FROM series WHERE audience IS NOT NULL AND source_id = 'DE-1'")
    ).rows;
    expect(off).toEqual([{ station_id: 'de.wsv.27100370', audience: 'off' }]);
    // P5a narrows by scope, never by licence: CH-1 stations outside the Rhine basin (and their CH-2 twins) and three
    // foreign Hub'Eau stations nobody publishes from this site are off.
    const offBy = (
      await h.t.admin.query(
        'SELECT source_id, count(*)::int AS n FROM series WHERE audience IS NOT NULL GROUP BY 1 ORDER BY 1',
      )
    ).rows;
    expect(offBy).toEqual([
      { source_id: 'CH-1', n: 136 },
      { source_id: 'CH-2', n: 129 },
      { source_id: 'DE-1', n: 1 },
      { source_id: 'FR-1', n: 5 },
    ]);
    // DE-1 238, NL-1 85, FR-1 550, FR-3 26, CH-1 412 and CH-2 380 series (registry/stations/*.yaml).
    expect(await h.count('series')).toBe(1691);
    // A cm series without a published gauge zero has a local datum.
    const local = (
      await h.t.admin.query("SELECT count(*)::int AS n FROM series WHERE native_unit = 'cm' AND datum = 'LOCAL'")
    ).rows;
    expect(local).toEqual([{ n: 8 }]);
    const tier = (await h.t.admin.query('SELECT tier, count(*)::int AS n FROM station GROUP BY 1 ORDER BY 1')).rows;
    expect(tier).toEqual([
      // DE-1: 41 and 158; NL-1: 31 and 41 (P5a: the 7 Belgian points); FR-1: 39 and 265; CH-1: 17 and 210; the 15
      // FR-3 and 207 CH-2 twin stations are tier 2.
      { tier: 1, n: 128 },
      { tier: 2, n: 896 },
    ]);
  });

  it('mirrors are role mirror by number and UUID, and never appear in a reader view', async () => {
    const { rows } = await h.t.admin.query(
      "SELECT st.id, a.provider_code, a.role FROM station st JOIN station_alias a ON a.station_id = st.id WHERE a.role <> 'primary' AND a.source_id = 'DE-1' ORDER BY 1",
    );
    expect(rows).toEqual([
      { id: 'de.wsv.2310010', provider_code: '2310010', role: 'mirror' },
      { id: 'de.wsv.2769510000100', provider_code: '2769510000100', role: 'mirror' },
      { id: 'de.wsv.2790050', provider_code: '2790050', role: 'mirror' },
      { id: 'de.wsv.2790060', provider_code: '2790060', role: 'mirror' },
      { id: 'de.wsv.3329', provider_code: '3329', role: 'mirror' },
    ]);
    // P5a: the FR-1 copies of gauges whose operators' own feeds are public (A§7.2): Basel (CH-1), Breisach, Kehl,
    // Plittersdorf, Maxau and Hanweiler (DE-1).
    const frMirrors = (
      await h.t.admin.query("SELECT provider_key FROM series WHERE role = 'mirror' AND source_id = 'FR-1' ORDER BY 1")
    ).rows;
    expect(frMirrors.map((m) => m.provider_key)).toEqual([
      'A021005050/H',
      'A021005050/Q',
      'A040000101/H',
      'A060005050/H',
      'A355005050/H',
      'A355005050/Q',
      'A375005050/H',
      'A375005050/Q',
      'A940000101/H',
    ]);
    const aliases = (
      await h.t.admin.query('SELECT source_id, role, count(*)::int AS n FROM station_alias GROUP BY 1, 2 ORDER BY 1, 2')
    ).rows;
    expect(aliases).toEqual([
      { source_id: 'CH-1', role: 'primary', n: 227 },
      { source_id: 'CH-2', role: 'twin', n: 207 },
      { source_id: 'DE-1', role: 'mirror', n: 5 },
      { source_id: 'DE-1', role: 'primary', n: 194 },
      { source_id: 'FR-1', role: 'mirror', n: 6 },
      { source_id: 'FR-1', role: 'primary', n: 298 },
      { source_id: 'FR-3', role: 'twin', n: 15 },
      { source_id: 'NL-1', role: 'primary', n: 72 },
    ]);
    const mirrors = (
      await h.t.admin.query(
        "SELECT provider_key, station_id FROM series WHERE role <> 'primary' AND source_id <> 'NL-1' ORDER BY 1",
      )
    ).rows;
    expect(mirrors.filter((m) => m.station_id.startsWith('de.')).map((m) => m.provider_key)).toEqual([
      '3046493f-971f-4d22-9f29-7ef8e3b645a4/W',
      '94f6eff1-4f3f-4850-82e0-a086198e9ffd/W',
      'c0594fb5-77ff-4287-9b8d-7ff326afe9ff/Q',
      'c0594fb5-77ff-4287-9b8d-7ff326afe9ff/W',
      'e020e651-e422-46d3-ae28-34887c5a4a8e/W',
      'efe13a3d-f239-4655-9c13-4ac56dfa4478/W',
    ]);
    const api = await h.t.connectAs('rws_api');
    for (const view of [VIEWS.public.station, VIEWS.owner.station]) {
      const client = view === VIEWS.public.station ? api : await h.t.connectAs('rws_owner_api');
      const seen = (await client.query(`SELECT id FROM ${view} WHERE id = ANY($1)`, [mirrors.map((m) => m.station_id)]))
        .rows;
      expect(seen, view).toEqual([]);
    }
    // DE-1: 199 stations less the five mirrors and NEUWIED STADT (off); 238 series less six mirror series and one
    // off: 193 and 231. NL-1: its 72 stations, and its 85 series less the Eijsden-grens TAW twin. FR-1: 304 stations
    // less 6 mirrors and 3 off: 295, with 536 series. CH-1: 227 less 75 off: 152, with 276 series. No FR-3 or CH-2
    // (twin) station.
    expect((await api.query(`SELECT count(*)::int AS n FROM ${VIEWS.public.station}`)).rows).toEqual([{ n: 712 }]);
    expect((await api.query(`SELECT count(*)::int AS n FROM ${VIEWS.public.series}`)).rows).toEqual([{ n: 1127 }]);
  });

  it('is idempotent: a second sync keeps every series id and changes nothing', async () => {
    const before = (await h.t.admin.query('SELECT id, provider_key, active FROM series ORDER BY id')).rows;
    const owner = h.dbAs('rws_migrator', 1);
    const result = await syncRegistry(owner.db, readRegistry());
    await owner.close();
    expect(result).toMatchObject({ stations: 1024, series: 1691, deactivated: 0, twins: 1, references: 742 });
    expect((await h.t.admin.query('SELECT id, provider_key, active FROM series ORDER BY id')).rows).toEqual(before);
  });

  it('a series that leaves the registry is deactivated, never deleted; a changed audience is copied as it is', async () => {
    const input = readRegistry();
    const dropped = input.stations.filter((r) => r.provider_code !== '2790020');
    const be3 = input.sources.map((s) => (s.id === 'DE-9' ? { ...s, name: 'renamed' } : s));
    const owner = h.dbAs('rws_migrator', 1);
    const result = await syncRegistry(owner.db, { ...input, stations: dropped, sources: be3 });
    expect(result.deactivated).toBe(2);
    const gone = (await h.t.admin.query("SELECT active FROM series WHERE provider_key LIKE '9598e4cb-%' ORDER BY 1"))
      .rows;
    expect(gone).toEqual([{ active: false }, { active: false }]);
    expect((await h.t.admin.query("SELECT name, audience FROM source WHERE id = 'DE-9'")).rows).toEqual([
      { name: 'renamed', audience: 'off' },
    ]);
    // Back again: reactivated with the same ids.
    await syncRegistry(owner.db, input);
    await owner.close();
    expect((await h.t.admin.query('SELECT count(*)::int AS n FROM series WHERE NOT active')).rows).toEqual([{ n: 0 }]);
  });

  it('writes a history window as hours, so it never depends on the session time zone (review S3)', async () => {
    const input = readRegistry();
    const owner = h.dbAs('rws_migrator', 1);
    const windowed = (history_window: string) =>
      input.sources.map((s) => (s.id === 'CH-4' ? { ...s, history_window } : s));
    await syncRegistry(owner.db, { ...input, sources: windowed('P30D') });
    expect((await h.t.admin.query("SELECT history_window::text AS w FROM source WHERE id = 'CH-4'")).rows).toEqual([
      { w: '720:00:00' },
    ]);
    // Weeks, fractions of a second and a zero duration are valid too (review R2-7).
    const stored = async () =>
      (await h.t.admin.query("SELECT history_window::text AS w FROM source WHERE id = 'CH-4'")).rows[0]?.w;
    for (const [window, expected] of [
      ['P1W', '168:00:00'],
      ['P2DT3H', '51:00:00'],
      ['PT90M', '01:30:00'],
      ['PT1.5S', '00:00:01.5'],
      ['PT0S', '00:00:00'],
      ['P366D', '8784:00:00'],
      ['P0D', '00:00:00'],
    ] as const) {
      await syncRegistry(owner.db, { ...input, sources: windowed(window) });
      expect([window, await stored()]).toEqual([window, expected]);
    }
    // A month or a year is no fixed number of hours: the sync refuses it with a registry error, and the previous
    // registry stays.
    for (const window of ['P1M', 'P1Y', 'P1Y2D'])
      await expect(syncRegistry(owner.db, { ...input, sources: windowed(window) })).rejects.toThrow(
        /CH-4: history_window .* no fixed length/,
      );
    // Nor is a window over 366 days: it would pass the CHECK and make every reader query on the source fail (R3-5).
    for (const window of ['P367D', 'P53W', 'PT8784H1S', 'PT31622401S', 'P2500000D', 'PT99999999999999999999S'])
      await expect(syncRegistry(owner.db, { ...input, sources: windowed(window) })).rejects.toThrow(
        /CH-4: history_window .* longer than 366 days/,
      );
    expect(await stored()).toBe('00:00:00');
    await syncRegistry(owner.db, input);
    await owner.close();
    expect((await h.t.admin.query("SELECT history_window::text AS w FROM source WHERE id = 'CH-4'")).rows).toEqual([
      { w: '00:00:00' },
    ]);
  });

  it('NL-1: level series in cm above NAP, discharge in m³/s, a 10-minute step, staleness by capture tier', async () => {
    const { rows } = await h.t.admin.query(
      `SELECT count(*)::int AS series, count(DISTINCT station_id)::int AS stations,
              (count(*) FILTER (WHERE quantity = 'H' AND native_unit = 'cm' AND to_canonical = 1 AND value_kind = 'level'
                                  AND datum = 'NAP' AND role = 'primary'))::int AS h_nap,
              (count(*) FILTER (WHERE quantity = 'Q' AND native_unit = 'm³/s' AND datum IS NULL AND value_kind IS NULL))::int AS q,
              (count(*) FILTER (WHERE role = 'twin' AND datum = 'TAW'))::int AS twin,
              (count(*) FILTER (WHERE native_step = '10 min' AND expected_step = '10 min'))::int AS ten_minutes,
              (count(*) FILTER (WHERE staleness_limit = '1 hour'))::int AS stale60,
              (count(*) FILTER (WHERE staleness_limit = '90 min'))::int AS stale90,
              (count(*) FILTER (WHERE staleness_limit = '2 hours'))::int AS stale120,
              (count(*) FILTER (WHERE audience IS NOT NULL OR lic_override IS NOT NULL))::int AS narrowed
       FROM series WHERE source_id = 'NL-1'`,
    );
    // P5a adds the 7 Belgian points of catalogue §0.6 (6 H, 3 Q), fetched every 30 minutes: 90 min.
    expect(rows).toEqual([
      {
        series: 85,
        stations: 72,
        h_nap: 68,
        q: 16,
        twin: 1,
        ten_minutes: 85,
        stale60: 26,
        stale90: 58,
        stale120: 1,
        narrowed: 0,
      },
    ]);
    // Eijsden Q arrives about 75 minutes late: the one series with two hours.
    const late = await h.t.admin.query("SELECT provider_key FROM series WHERE staleness_limit = '2 hours'");
    expect(late.rows).toEqual([{ provider_key: 'eijsden.grens/Q/NVT/other:F216' }]);
    // One station carries both Eijsden-grens level series; it is a primary station with one alias.
    const eijsden = await h.t.admin.query(
      `SELECT s.provider_key, s.role, st.tier, a.role AS alias_role
       FROM series s JOIN station st ON st.id = s.station_id JOIN station_alias a ON a.station_id = st.id
       WHERE st.id = 'nl.rws.eijsden.grens' AND s.quantity = 'H' ORDER BY 1`,
    );
    expect(eijsden.rows).toEqual([
      { provider_key: 'eijsden.grens/WATHTE/NAP/other:F007', role: 'primary', tier: 1, alias_role: 'primary' },
      { provider_key: 'eijsden.grens/WATHTE/TAW/other:F007', role: 'twin', tier: 1, alias_role: 'primary' },
    ]);
    const tidal = await h.t.admin.query(
      "SELECT id FROM station WHERE flags->>'tidal' = 'true' AND id LIKE 'nl.rws.%' ORDER BY 1",
    );
    expect(tidal.rows.map((r) => r.id)).toEqual([
      // P5a: the Zeeschelde at Antwerp (catalogue §0.6).
      'nl.rws.antwerpen',
      'nl.rws.delfzijl',
      'nl.rws.hansweert',
      'nl.rws.nieuwestatenzijl.dollard',
      'nl.rws.rilland.bath',
      'nl.rws.terneuzen',
      'nl.rws.vlissingen',
    ]);
    // No audience or channel flag of an RWS source changed (invariant 8): NL-3 stays off.
    const sources = await h.t.admin.query(
      "SELECT id, audience::text, lic_display, lic_api, lic_bulk_export, lic_history_export FROM source WHERE id IN ('NL-1', 'NL-2', 'NL-3', 'NL-4') ORDER BY 1",
    );
    const open = {
      audience: 'public',
      lic_display: true,
      lic_api: true,
      lic_bulk_export: true,
      lic_history_export: true,
    };
    const closed = {
      audience: 'off',
      lic_display: false,
      lic_api: false,
      lic_bulk_export: false,
      lic_history_export: false,
    };
    expect(sources.rows).toEqual([
      { id: 'NL-1', ...open },
      { id: 'NL-2', ...open },
      { id: 'NL-3', ...closed },
      { id: 'NL-4', ...open },
    ]);
  });

  it('NL-4: the display classes of the workbook, as provider_class bounds with their season and priority', async () => {
    const ref = (where: string, params: unknown[] = []) =>
      h.t.admin.query(
        `SELECT s.provider_key, r.kind, r.value, r.unit, r.season_from_md AS from_md, r.season_to_md AS to_md,
                r.priority, r.basis_label AS label
         FROM reference_value r JOIN series s ON s.id = r.series_id WHERE ${where}
         ORDER BY s.provider_key, r.priority, r.season_from_md, r.kind`,
        params,
      );
    const totals = await h.t.admin.query(
      `SELECT count(*)::int AS n, count(DISTINCT r.series_id)::int AS series,
              (count(*) FILTER (WHERE r.source_id = 'NL-4' AND r.semantics = 'provider_class'
                                  AND r.kind IN ('NL4_FROM', 'NL4_TO') AND r.period IS NULL AND r.batch_id IS NULL
                                  AND r.valid = tstzrange('2026-04-15T00:00:00Z', NULL)))::int AS as_declared,
              (count(*) FILTER (WHERE (s.quantity = 'H') = (r.unit = 'cm')
                                  AND (s.quantity = 'Q') = (r.unit = 'm³/s')))::int AS unit_ok,
              (count(*) FILTER (WHERE s.source_id = 'NL-1' AND s.role = 'primary'
                                  AND (s.quantity = 'Q' OR s.datum = 'NAP')))::int AS on_nl1
       FROM reference_value r JOIN series s ON s.id = r.series_id`,
    );
    // 58 level and 11 discharge series have classes; a class row is one or two bounds.
    // P5a: lanaken H, maaseik H and Q and smeermaas.zuidwillemsvaart H and Q (Belgian points) bring their classes.
    expect(totals.rows).toEqual([{ n: 742, series: 74, as_declared: 742, unit_ok: 742, on_nl1: 742 }]);

    // Lobith discharge (issue #17): the whole-year bounds, and Normaal/Verlaagd at 1,400 in May, 1,000 in September.
    const lobith = 'lobith.bovenrijn.tolkamer/Q/NVT/other:F230';
    const on = async (md: number) =>
      (
        await ref(
          `s.provider_key = $1 AND CASE WHEN r.season_from_md <= r.season_to_md
             THEN $2 BETWEEN r.season_from_md AND r.season_to_md
             ELSE $2 >= r.season_from_md OR $2 <= r.season_to_md END`,
          [lobith, md],
        )
      ).rows.map((r) => `${r.priority} ${r.kind} ${r.value} ${r.from_md}-${r.to_md}`);
    const wholeYear = [
      '0 NL4_FROM 11800 101-1231',
      '1 NL4_FROM 8100 101-1231',
      '1 NL4_TO 11800 101-1231',
      '2 NL4_FROM 5400 101-1231',
      '2 NL4_TO 8100 101-1231',
      '3 NL4_FROM 4450 101-1231',
      '3 NL4_TO 5400 101-1231',
    ];
    const season = (bound: number, window: string) => [
      `4 NL4_TO ${bound} ${window}`,
      `5 NL4_FROM ${bound} ${window}`,
      `5 NL4_TO 4450 ${window}`,
    ];
    expect(await on(515)).toEqual([...wholeYear, ...season(1400, '501-531')]);
    expect(await on(915)).toEqual([...wholeYear, ...season(1000, '901-930')]);
    // Winterstand runs from 1 October to 30 April: a season that wraps the year.
    expect(await on(115)).toEqual([...wholeYear, ...season(1000, '1001-430')]);
    // The label is the workbook's, verbatim; the unit is the series' canonical one.
    expect((await ref('s.provider_key = $1 AND r.priority = 0', [lobith])).rows).toEqual([
      {
        provider_key: lobith,
        kind: 'NL4_FROM',
        value: 11800,
        unit: 'm³/s',
        from_md: 101,
        to_md: 1231,
        priority: 0,
        label: 'Extreme afvoer (>11800 m3/s)',
      },
    ]);
    // Eijsden-grens level: cm above NAP on the NAP series; nothing on the TAW twin.
    const eijsden = (await ref(`s.provider_key LIKE 'eijsden.grens/WATHTE/%'`)).rows;
    expect(new Set(eijsden.map((r) => r.provider_key))).toEqual(new Set(['eijsden.grens/WATHTE/NAP/other:F007']));
    expect(eijsden.map((r) => `${r.priority} ${r.kind} ${r.value}`)).toEqual([
      '0 NL4_FROM 5000',
      '1 NL4_FROM 4885',
      '1 NL4_TO 5000',
      '2 NL4_FROM 4715',
      '2 NL4_TO 4885',
      '3 NL4_FROM 4610',
      '3 NL4_TO 4715',
      '4 NL4_TO 4390',
      '5 NL4_FROM 4390',
      '5 NL4_TO 4610',
    ]);
    // No row is invented for a registered series the workbook has no classes for.
    const without = await h.t.admin.query(
      `SELECT s.provider_key FROM series s
       WHERE s.source_id = 'NL-1' AND s.role = 'primary'
         AND NOT EXISTS (SELECT 1 FROM reference_value r WHERE r.series_id = s.id)
       ORDER BY 1`,
    );
    // P5a: four of the Belgian points have no NL-4 classes (antwerpen, herenlaak, kanne Q, lixhebiefaval).
    expect(without.rows.map((r) => r.provider_key.split('/').slice(0, 2).join('/'))).toEqual([
      'antwerpen/WATHTE',
      'hagestein.boven/Q',
      'herenlaak/WATHTE',
      'holtheme.vecht/WATHTE',
      'kanne/Q',
      'lith.beneden/WATHTE',
      'lixhebiefaval/WATHTE',
      'millingenaanderijn.pannerdensekop/WATHTE',
      'millingenaanderijn/Q',
      'rhenen.grebbeberg/WATHTE',
    ]);
    // The public reader sees them through its reference view, by the audience of NL-4 itself.
    const api = await h.t.connectAs('rws_api');
    expect((await api.query(`SELECT count(*)::int AS n FROM ${VIEWS.public.reference}`)).rows).toEqual([{ n: 742 }]);
  });

  it('NL-4: a second sync replaces the classes with the same rows, and a registry without the file has none', async () => {
    const owner = h.dbAs('rws_migrator', 1);
    const input = readRegistry();
    const rows = () =>
      h.t.admin
        .query(
          'SELECT series_id, kind, value, season_from_md, season_to_md, priority, basis_label FROM reference_value ORDER BY 1, 2, 4, 5, 6',
        )
        .then((r) => r.rows);
    const before = await rows();
    expect((await syncRegistry(owner.db, input)).references).toBe(742);
    expect(await rows()).toEqual(before);
    expect((await syncRegistry(owner.db, { ...input, thresholds: null })).references).toBe(0);
    expect(await h.count('reference_value')).toBe(0);
    await syncRegistry(owner.db, input);
    expect(await rows()).toEqual(before);
    await owner.close();
  });

  it('the loader role cannot sync the registry', async () => {
    await expect(syncRegistry(h.load.db, readRegistry())).rejects.toMatchObject({ code: '42501' });
    const load = await h.t.connectAs('rws_load');
    expect(await sqlState(load, "UPDATE source SET audience = 'public' WHERE id = 'BE-3'")).toBe('42501');
  });

  it('refuses an invalid registry and a permission record it cannot apply', async () => {
    const { mkdtempSync, cpSync, writeFileSync, mkdirSync, readFileSync: read } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { pathToFileURL } = await import('node:url');
    const dir = mkdtempSync(`${tmpdir()}/rws-registry-`);
    cpSync(new URL('../../../../registry/', import.meta.url), dir, { recursive: true });
    const url = pathToFileURL(`${dir}/`);
    expect(readRegistry(url).stations).toHaveLength(1691);
    // An owner source that loses its private_basis.
    const sources = read(`${dir}/sources.yaml`, 'utf8');
    writeFileSync(
      `${dir}/sources.yaml`,
      sources.replace(/(id: BE-3[\s\S]*?)private_basis:[\s\S]*?retrieved: "[0-9-]+"/, '$1private_basis: null'),
    );
    expect(() => readRegistry(url)).toThrow(/registry is not valid/);
    writeFileSync(`${dir}/sources.yaml`, sources);
    mkdirSync(`${dir}/permissions`);
    writeFileSync(`${dir}/permissions/BE-3.md`, '---\nsource: BE-3\n---\n');
    expect(() => readRegistry(url)).toThrow(/permissions/);
  });
});
