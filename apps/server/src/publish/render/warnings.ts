import { DAY_MS, dayStartMs, WarningsFile } from '@rws/contracts';
import { sql } from 'kysely';
import { VIEWS } from '../../db/audience.ts';
import type { RenderCtx } from '../cycle.ts';
import { attributionFor } from './attribution.ts';
import { sourceDates } from './dates.ts';

// P9a (A§9.1): warnings/latest.geojson (the areas valid now) and warnings/YYYY-MM-DD.json (the areas valid at any
// time of an ended UTC day, written once). One GeoJSON feature per area row; every text is the provider's and is
// data only (invariant 3). A geometry that is not one of the contract's shapes is null, never passed on.

type Row = {
  source_id: string;
  area_key: string;
  name: string | null;
  geometry_geojson: string | null;
  level_norm: number | null;
  level_raw: string | null;
  label_raw: string | null;
  from_ts: Date;
  to_ts: Date | null;
  issued_at: Date | null;
};

// ponytail: the contract holds 5000 features; a family with more areas at once (none: DE-6 has about 400) is cut.
const MAX_FEATURES = 5000;

const geometrySchema = WarningsFile.shape.features.element.shape.geometry;

function geometryOf(text: string | null) {
  if (text === null) return null;
  try {
    const g = geometrySchema.safeParse(JSON.parse(text));
    return g.success ? g.data : null;
  } catch {
    return null;
  }
}

export async function warnings(c: RenderCtx, day: string | null): Promise<unknown> {
  const from = day === null ? new Date(c.now) : new Date(dayStartMs(day));
  const to = day === null ? from : new Date(dayStartMs(day) + DAY_MS);
  // Valid at now (latest), or overlapping [day, day + 1 d) (a dated file).
  const { rows } = await sql<Row>`
    SELECT source_id, area_key, name, geometry_geojson, level_norm::int AS level_norm, level_raw, label_raw,
           lower(valid) AS from_ts, CASE WHEN upper_inf(valid) THEN NULL ELSE upper(valid) END AS to_ts, issued_at
    FROM ${sql.table(VIEWS[c.family].warning)}
    WHERE ${day === null ? sql`valid @> ${from}::timestamptz` : sql`valid && tstzrange(${from}, ${to}, '[)')`}
    ORDER BY source_id, area_key, lower(valid), id LIMIT ${MAX_FEATURES}`.execute(c.db);
  const dates = day === null ? await sourceDates(c.db, c.family, c.attribution) : undefined;
  return {
    type: 'FeatureCollection',
    schemaVersion: 1,
    generatedAt: new Date(c.now).toISOString(),
    day,
    features: rows.map((r) => ({
      type: 'Feature',
      geometry: geometryOf(r.geometry_geojson),
      properties: {
        source: r.source_id,
        area: r.area_key,
        name: r.name,
        level: r.level_norm,
        levelRaw: r.level_raw,
        label: r.label_raw,
        from: r.from_ts.toISOString(),
        to: r.to_ts?.toISOString() ?? null,
        issuedAt: r.issued_at?.toISOString() ?? null,
      },
    })),
    attribution: attributionFor(
      c.attribution,
      rows.map((r) => r.source_id),
      dates,
    ),
  };
}
