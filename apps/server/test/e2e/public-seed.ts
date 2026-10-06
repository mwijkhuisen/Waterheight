// P10a (C2): synthetic gauge zeros, classes and warning areas for the web e2e, on BASE TABLES only (never a view),
// at the fixed e2e clock. Every value is made up; the XSS string is data the page must show as text.
import type { Client } from 'pg';

export const XSS = '<img src=x onerror=alert(1)>';
/** The FR-1 station (section AP1 of registry/vigicrues-sections.yaml) and the DE-1 station (Rhine at Basel). */
export const FR_STATION = 'fr.sandre.D015850001';
export const FR_SECTION = 'AP1';
export const DE_STATION = 'de.wsv.23300130';
/** The ended day's warnings file. */
export const ENDED_DAY = '2026-10-25';

const POLYGON = '{"type":"Polygon","coordinates":[[[7.45,47.65],[7.6,47.65],[7.6,47.78],[7.45,47.78],[7.45,47.65]]]}';
const HATCHED = '{"type":"Polygon","coordinates":[[[7.2,47.4],[7.4,47.4],[7.4,47.55],[7.2,47.55],[7.2,47.4]]]}';
const LINE = '{"type":"LineString","coordinates":[[7.5,47.5],[7.53,47.71],[7.6,47.9]]}';

type Area = [source: string, key: string, name: string, geom: string | null, level: number, raw: string, label: string];
const AREAS: [...Area, valid: string, issued: string][] = [
  // FR-5 section AP1: attaches to FR_STATION through the section table; French label with the XSS string.
  [
    'FR-5',
    FR_SECTION,
    'Sambre amont',
    null,
    2,
    '2',
    `Vigilance jaune ${XSS}`,
    '[2026-10-26T06:00Z,)',
    '2026-10-26T06:00Z',
  ],
  // DE-6 LHP class 4 over the DE station; the name carries the XSS string.
  [
    'DE-6',
    'e2e-4',
    `Hochwasserwarnung ${XSS}`,
    POLYGON,
    4,
    '4',
    'Hochwasser mit hohem Schaden',
    '[2026-10-26T08:00Z,)',
    '2026-10-26T08:00Z',
  ],
  // LHP class 2 (hatched), issued the previous UTC day and still valid.
  ['DE-6', 'e2e-2', 'Vorwarnung Oberrhein', HATCHED, 2, '2', 'Vorwarnung', '[2026-10-25T08:00Z,)', '2026-10-25T08:00Z'],
  // A river alert (LineString): attaches to no station (KG-189).
  ['DE-6', 'e2e-river', 'Rheinwarnung', LINE, 5, '5', 'Gewaesserwarnung', '[2026-10-26T09:00Z,)', '2026-10-26T09:00Z'],
  // Ended on 2026-10-25: only the dated file warnings/2026-10-25.json holds it.
  [
    'DE-6',
    'e2e-ended',
    'Beendete Warnung',
    POLYGON,
    4,
    '4',
    'Beendet',
    '[2026-10-25T06:00Z,2026-10-25T18:00Z)',
    '2026-10-25T06:00Z',
  ],
];

export async function seedPublic(admin: Client, now: string): Promise<void> {
  // The gauge zero of the FR-1 H series: IGN69 is never converted to NAP, so the snapshot carries `zero` and no `nap`.
  const zero = await admin.query(
    `INSERT INTO gauge_zero (series_id, value_m, datum, valid, batch_id)
     SELECT id, 123.45, 'IGN69', tstzrange('2020-01-01Z', NULL), 1 FROM series
     WHERE station_id = $1 AND quantity = 'H' AND role = 'primary'`,
    [FR_STATION],
  );
  if (zero.rowCount !== 1) throw new Error(`seed: no FR-1 H series on ${FR_STATION}`);

  for (const [source, key, name, geom, level, raw, label, valid, issued] of AREAS)
    await admin.query(
      `INSERT INTO warning_area (source_id, area_key, name, geometry_geojson, level_norm, level_raw, label_raw, valid, issued_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::tstzrange, $9)`,
      [source, key, name, geom, level, raw, label, valid, issued],
    );

  // A DE-6 gauge class HE:3 with a provider label that is hostile text, stated twice (provenance).
  await admin.query(
    `INSERT INTO class_obs (subject_type, subject_id, ts, source_id, provider_code, provider_label, level_norm)
     VALUES ('station', $1, $2::timestamptz - interval '30 min', 'DE-6', 'HE:3', $3, 5),
            ('station', $1, $2::timestamptz - interval '20 min', 'DE-6', 'HE:3', $3, 5)`,
    [DE_STATION, now, `Meldestufe 3 ${XSS}`],
  );
  // Classes and areas count at the current bucket only while their source was fetched lately; and every public source
  // whose licence asks for a date (catalogue 1b) needs the row the publisher reads it from (attribution.ts
  // `sourceDates`), or its sources.json date is null and the Sources page says "datum onbekend":
  //   `update` (FR-1, FR-3, FR-4, FR-5): `newest_ts`, the newest value we hold (the provider's own date is DE-6's only);
  //   `update` of DE-6: `detail.provider_updated`, shown as "Stand: TT.MM.JJJJ hh:mm" in Berlin time;
  //   `retrieval` (CH-1 .. CH-5): `last_fetch_ok`, the last successful fetch.
  // The dates are fixed relative to NOW and on different Amsterdam days, so a spec sees which column fed which source:
  // the French sources say 25 October 2026 (their newest value is 16 h old, 21:00 CET), the Swiss ones 26 October 2026,
  // DE-6 "Stand: 26.10.2026 09:30" (08:30Z; Berlin is on CET after the DST change of the 25th).
  type Health = [source: string, fetched: string, newest: string | null, detail: object];
  const rows: Health[] = [
    ['DE-6', now, null, { provider_updated: '2026-10-26T08:30:00Z' }],
    ...['FR-1', 'FR-3', 'FR-4', 'FR-5'].map((id): Health => [id, now, '2026-10-25T20:00:00Z', {}]),
    ...['CH-1', 'CH-2', 'CH-3', 'CH-4', 'CH-5'].map((id): Health => [id, '2026-10-26T11:55:00Z', null, {}]),
  ];
  for (const [source, fetched, newest, detail] of rows)
    await admin.query(
      `INSERT INTO source_health (source_id, last_fetch_ok, newest_ts, detail, status)
       VALUES ($1, $2, $3, $4::jsonb, 'ok')
       ON CONFLICT (source_id) DO UPDATE
         SET last_fetch_ok = EXCLUDED.last_fetch_ok, newest_ts = EXCLUDED.newest_ts, detail = EXCLUDED.detail, status = 'ok'`,
      [source, fetched, newest, JSON.stringify(detail)],
    );
}
