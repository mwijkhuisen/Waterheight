import { WarningsFile } from '@rws/contracts';
import { OwnerWarningsFile } from '@rws/contracts/static-owner';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/pool.ts';
import { publishTail } from '../../src/load/migrate.ts';
import { warnings } from '../../src/publish/render/warnings.ts';
import { type Harness, harness } from '../load/harness.ts';
import { ctxFor, NOW } from './s2-ctx.ts';

// P9a: warnings/latest.geojson and the dated files against the real views: latest = valid now, a dated file = valid at
// any time of that UTC day, a bad geometry is null, and the public files never hold an owner source's area.

let h: Harness;
let pubDb: Db;
let ownDb: Db;
const POLYGON = '{"type":"Polygon","coordinates":[[[6,51],[7,51],[7,52],[6,51]]]}';
const OWNER_AREA = 'owner-only-area-x';

async function area(source: string, key: string, valid: string, geometry: string | null, level: number | null) {
  await h.t.admin.query(
    `INSERT INTO warning_area (source_id, area_key, name, geometry_geojson, level_norm, level_raw, label_raw, valid, issued_at)
     VALUES ($1, $2, $3, $4, $5, 'raw', 'label <b>x</b>', $6::tstzrange, '2026-10-04T09:00:00Z')`,
    [source, key, `name ${key}`, geometry, level, valid],
  );
}

beforeAll(async () => {
  h = await harness();
  pubDb = h.dbAs('rws_publish', 1);
  ownDb = h.dbAs('rws_owner_api', 1);
  await publishTail(h.dbAs('rws_migrator', 1).db, new Date(NOW));
  await area('DE-6', 'area-a', '[2026-10-04T10:00Z,)', POLYGON, 3);
  await area('DE-6', 'area-b', '[2026-10-03T22:00Z,2026-10-04T01:00Z)', 'not json', 2);
  await area('DE-6', 'area-c', '[2026-10-01T00:00Z,2026-10-02T00:00Z)', '{"type":"Polygon","coordinates":"x"}', null);
  await area('BE-3', OWNER_AREA, '[2026-10-04T10:00Z,)', POLYGON, 4);
  await h.t.admin.query(
    `INSERT INTO source_health (source_id, detail) VALUES ('DE-6', '{"provider_updated": "2026-10-04T12:30:00.000Z"}')
     ON CONFLICT (source_id) DO UPDATE SET detail = source_health.detail || EXCLUDED.detail`,
  );
}, 120_000);
afterAll(() => h.close());

const props = (body: unknown) =>
  (body as { features: { properties: { area: string } }[] }).features.map((f) => f.properties.area);

describe('warnings files', { timeout: 120_000 }, () => {
  it('latest.geojson holds the areas valid now, with the DE-6 date, and no owner area', async () => {
    const ctx = await ctxFor(pubDb, 'public');
    const body = await warnings(ctx, null);
    const file = WarningsFile.parse(body);
    expect(file.day).toBeNull();
    expect(props(body)).toEqual(['area-a']);
    expect(file.features[0]).toMatchObject({
      geometry: { type: 'Polygon' },
      properties: {
        source: 'DE-6',
        name: 'name area-a',
        level: 3,
        levelRaw: 'raw',
        // Provider text is data: carried verbatim, never interpreted.
        label: 'label <b>x</b>',
        from: '2026-10-04T10:00:00.000Z',
        to: null,
        issuedAt: '2026-10-04T09:00:00.000Z',
      },
    });
    expect(file.attribution.filter((a) => a.source === 'DE-6').some((a) => a.date !== null)).toBe(true);
    expect(JSON.stringify(body)).not.toContain(OWNER_AREA);
    expect(JSON.stringify(body)).not.toContain('BE-3');
  });

  it('a dated file holds the areas overlapping that UTC day, with no dates, an invalid geometry as null', async () => {
    const ctx = await ctxFor(pubDb, 'public');
    const day = async (d: string) => warnings(ctx, d);
    expect(props(await day('2026-10-03'))).toEqual(['area-b']);
    expect(props(await day('2026-10-04'))).toEqual(['area-a', 'area-b']);
    expect(props(await day('2026-10-02'))).toEqual([]);
    expect(props(await day('2026-10-01'))).toEqual(['area-c']);
    const b = WarningsFile.parse(await day('2026-10-03'));
    expect(b.day).toBe('2026-10-03');
    expect(b.features[0]).toMatchObject({ geometry: null, properties: { to: '2026-10-04T01:00:00.000Z' } });
    const c = WarningsFile.parse(await day('2026-10-01'));
    expect(c.features[0]).toMatchObject({ geometry: null, properties: { level: null } });
    for (const a of WarningsFile.parse(await day('2026-10-04')).attribution)
      expect([a.date, a.dateText]).toEqual([null, null]);
  });

  it("the owner file holds the public areas and the owner source's own", async () => {
    const ctx = await ctxFor(ownDb, 'owner');
    const body = await warnings(ctx, null);
    OwnerWarningsFile.parse(body);
    expect(props(body).sort()).toEqual(['area-a', OWNER_AREA]);
  });
});
