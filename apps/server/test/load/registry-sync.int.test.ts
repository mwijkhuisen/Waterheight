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

describe('registry sync', () => {
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
    // The one narrowed series: NEUWIED STADT, off until the owner has verified its licence (review C12).
    const off = (await h.t.admin.query('SELECT station_id, audience FROM series WHERE audience IS NOT NULL')).rows;
    expect(off).toEqual([{ station_id: 'de.wsv.27100370', audience: 'off' }]);
    expect(await h.count('series')).toBe(238);
    // A cm series without a published gauge zero has a local datum.
    const local = (
      await h.t.admin.query("SELECT count(*)::int AS n FROM series WHERE native_unit = 'cm' AND datum = 'LOCAL'")
    ).rows;
    expect(local).toEqual([{ n: 8 }]);
    const tier = (await h.t.admin.query('SELECT tier, count(*)::int AS n FROM station GROUP BY 1 ORDER BY 1')).rows;
    expect(tier).toEqual([
      { tier: 1, n: 41 },
      { tier: 2, n: 158 },
    ]);
  });

  it('mirrors are role mirror by number and UUID, and never appear in a reader view', async () => {
    const { rows } = await h.t.admin.query(
      "SELECT st.id, a.provider_code, a.role FROM station st JOIN station_alias a ON a.station_id = st.id WHERE a.role <> 'primary' ORDER BY 1",
    );
    expect(rows).toEqual([
      { id: 'de.wsv.2310010', provider_code: '2310010', role: 'mirror' },
      { id: 'de.wsv.2769510000100', provider_code: '2769510000100', role: 'mirror' },
      { id: 'de.wsv.2790050', provider_code: '2790050', role: 'mirror' },
      { id: 'de.wsv.2790060', provider_code: '2790060', role: 'mirror' },
      { id: 'de.wsv.3329', provider_code: '3329', role: 'mirror' },
    ]);
    const mirrors = (
      await h.t.admin.query("SELECT provider_key, station_id FROM series WHERE role = 'mirror' ORDER BY 1")
    ).rows;
    expect(mirrors.map((m) => m.provider_key)).toEqual([
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
    // 199 stations less the five mirrors and NEUWIED STADT (off); 238 series less six mirror series and one off.
    expect((await api.query(`SELECT count(*)::int AS n FROM ${VIEWS.public.station}`)).rows).toEqual([{ n: 193 }]);
    expect((await api.query(`SELECT count(*)::int AS n FROM ${VIEWS.public.series}`)).rows).toEqual([{ n: 231 }]);
  });

  it('is idempotent: a second sync keeps every series id and changes nothing', async () => {
    const before = (await h.t.admin.query('SELECT id, provider_key, active FROM series ORDER BY id')).rows;
    const owner = h.dbAs('rws_migrator', 1);
    const result = await syncRegistry(owner.db, readRegistry());
    await owner.close();
    expect(result).toMatchObject({ stations: 199, series: 238, deactivated: 0 });
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
    expect(await stored()).toBe('00:00:00');
    await syncRegistry(owner.db, input);
    await owner.close();
    expect((await h.t.admin.query("SELECT history_window::text AS w FROM source WHERE id = 'CH-4'")).rows).toEqual([
      { w: '00:00:00' },
    ]);
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
    expect(readRegistry(url).stations).toHaveLength(238);
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
