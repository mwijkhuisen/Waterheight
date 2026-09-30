import type pg from 'pg';

// The audience fixture of the database tests: public, owner and off sources,
// both canaries, narrowed series, a mirror, and owner-audience rows hanging on
// public series. Every id below is synthetic (no provider data).

export const WITHHELD_CANARY = 123456.789;
export const OWNER_CANARY = 777777.777;
/** How PostgreSQL prints the canaries once they are stored as `real`. */
export const WITHHELD_CANARY_REAL = '123456.79';
export const OWNER_CANARY_REAL = '777777.75';

const BASIS = `'{"clause": "SECRET-CLAUSE personal use only", "url": "https://example.org/terms", "retrieved": "2026-09-24"}'::jsonb`;

/** Things that must never be visible through a public view, in any column. */
export const NEVER_PUBLIC = [
  'LU-4',
  'DE-2',
  'BE-3',
  'CANARY-OWNER',
  'DE-9',
  'nl.canary.owner',
  'nl.canary.withheld',
  'be.spw.only-owner',
  'nl.rws.narrowed-owner',
  'nl.rws.narrowed-off',
  'de.wsv.mirror',
  'de.wsv.twin',
  'ch.bafu.no-display',
  'SECRET-CLAUSE',
  'OWNER-ATTRIBUTION',
  'OFF-ATTRIBUTION',
  'OWNER-WARNING',
  'OWNER_CLASS',
  'WAAK_OWNER',
  'spec-owner',
  OWNER_CANARY_REAL,
  WITHHELD_CANARY_REAL,
] as const;

/** Things no owner view may show either: `off` rows, and series that are not primary. */
export const NEVER_OWNER = [
  'DE-9',
  'nl.canary.withheld',
  'nl.rws.narrowed-off',
  'de.wsv.mirror',
  'de.wsv.twin',
  'ch.bafu.no-display',
  'OFF-ATTRIBUTION',
  WITHHELD_CANARY_REAL,
] as const;

export async function seedAudienceFixture(admin: pg.Client): Promise<Record<string, number>> {
  await admin.query(`
    INSERT INTO provider (id, name, country) VALUES
      ('rws', 'RWS', 'NL'), ('wsv', 'WSV', 'DE'), ('age', 'AGE', 'LU'), ('spw', 'SPW', 'BE'),
      ('bafu', 'BAFU', 'CH'), ('nlwkn', 'NLWKN', 'DE'), ('bfg', 'BfG', 'DE'), ('canary', 'canary', 'none');

    INSERT INTO source (id, provider_id, name, audience, private_basis, lic_display, lic_api, lic_bulk_export,
                        lic_history_export, history_window, capture_enabled, canary) VALUES
      ('NL-1', 'rws', 'public obs', 'public', NULL, true, true, true, true, '0', true, false),
      ('DE-1', 'wsv', 'public obs', 'public', NULL, true, true, true, true, '0', true, false),
      ('LU-4', 'age', 'owner thresholds', 'owner', ${BASIS}, true, true, false, true, '0', true, false),
      ('DE-2', 'bfg', 'owner forecasts', 'owner', ${BASIS}, true, true, false, true, '0', true, false),
      ('BE-3', 'spw', 'owner obs', 'owner', ${BASIS}, true, true, false, true, '0', true, false),
      ('CANARY-OWNER', 'canary', 'owner canary', 'owner', ${BASIS}, true, true, false, true, '0', true, true),
      ('DE-9', 'nlwkn', 'off', 'off', NULL, false, false, false, false, '0', false, false),
      ('CH-1', 'bafu', 'display only', 'public', NULL, true, false, false, true, '0', true, false),
      ('CH-2', 'bafu', 'no display', 'public', NULL, false, false, false, false, '0', true, false),
      ('CH-3', 'bafu', '30-day window, no history export', 'public', NULL, true, true, false, false, '30 days', true, false),
      ('CH-4', 'bafu', '30-day window, history export', 'public', NULL, true, true, true, true, '30 days', true, false);

    INSERT INTO attribution (source_id, ord, lang, text, needs_date, required) VALUES
      ('NL-1', 0, 'nl', 'PUBLIC-ATTRIBUTION', false, false),
      ('LU-4', 0, 'fr', 'OWNER-ATTRIBUTION', false, true),
      ('DE-9', 0, 'de', 'OFF-ATTRIBUTION', false, true);

    INSERT INTO station (id, name, country, tier) VALUES
      ('nl.rws.public', 'Public', 'NL', 1),
      ('nl.rws.public2', 'Public 2', 'NL', 1),
      ('nl.canary.withheld', 'withheld canary', 'NL', 2),
      ('nl.canary.owner', 'owner canary', 'NL', 2),
      ('be.spw.only-owner', 'only an owner series', 'BE', 1),
      ('nl.rws.narrowed-owner', 'narrowed to owner', 'NL', 2),
      ('nl.rws.narrowed-off', 'narrowed to off', 'NL', 2),
      ('de.wsv.mirror', 'a mirror', 'DE', 2),
      ('de.wsv.twin', 'a twin', 'DE', 2),
      ('de.wsv.no-api', 'series without api', 'DE', 2),
      ('ch.bafu.display-only', 'display only', 'CH', 2),
      ('ch.bafu.no-display', 'no display', 'CH', 2),
      ('ch.bafu.window', 'history window', 'CH', 2),
      ('ch.bafu.window-export', 'history window with export', 'CH', 2);
  `);
  const series: [string, string, string, string, string | null, string | null][] = [
    // key, station, source, role, series audience, lic_override
    ['public', 'nl.rws.public', 'NL-1', 'primary', null, null],
    ['public2', 'nl.rws.public2', 'NL-1', 'primary', null, null],
    ['withheld', 'nl.canary.withheld', 'NL-1', 'primary', 'off', null],
    ['ownerCanary', 'nl.canary.owner', 'CANARY-OWNER', 'primary', null, null],
    ['onlyOwner', 'be.spw.only-owner', 'BE-3', 'primary', null, null],
    ['narrowedOwner', 'nl.rws.narrowed-owner', 'NL-1', 'primary', 'owner', null],
    ['narrowedOff', 'nl.rws.narrowed-off', 'NL-1', 'primary', 'off', null],
    ['mirror', 'de.wsv.mirror', 'DE-1', 'mirror', null, null],
    ['twin', 'de.wsv.twin', 'DE-1', 'twin', null, null],
    ['noApi', 'de.wsv.no-api', 'DE-1', 'primary', null, '{"api": false}'],
    ['displayOnly', 'ch.bafu.display-only', 'CH-1', 'primary', null, null],
    // Attempts to widen: a series cannot switch a channel or an audience on.
    ['noDisplay', 'ch.bafu.no-display', 'CH-2', 'primary', 'public', '{"display": true, "api": true}'],
    ['widenAudience', 'be.spw.only-owner', 'BE-3', 'primary', 'public', null],
    ['window', 'ch.bafu.window', 'CH-3', 'primary', null, null],
    ['windowExport', 'ch.bafu.window-export', 'CH-4', 'primary', null, null],
  ];
  const ids: Record<string, number> = {};
  for (const [key, station, source, role, audience, override] of series) {
    const { rows } = await admin.query<{ id: number }>(
      `INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                           native_step, expected_step, staleness_limit, role, audience, lic_override)
       VALUES ($1, $2, 'H', 'stage', $3, 'cm', 1, 'LOCAL', '15 min', '15 min', '45 min', $4, $5::audience, $6::jsonb)
       RETURNING id`,
      [station, source, key, role, audience, override],
    );
    ids[key] = (rows[0] as { id: number }).id;
  }

  await admin.query(`SELECT ensure_partitions(now() - interval '45 days', now() + interval '10 days')`);
  const value = (key: string) => (key === 'withheld' ? WITHHELD_CANARY : key === 'ownerCanary' ? OWNER_CANARY : 100);
  for (const [key, id] of Object.entries(ids)) {
    await admin.query(
      `INSERT INTO obs (series_id, ts, value, qc, batch_id)
       SELECT $1, t, $2, 1, 1 FROM unnest(ARRAY[date_trunc('hour', now()) - interval '40 days',
                                                 date_trunc('hour', now()) - interval '10 days',
                                                 date_trunc('hour', now())]) t`,
      [id, value(key)],
    );
    await admin.query(
      `INSERT INTO obs_latest (series_id, ts, value, qc, batch_id) VALUES ($1, date_trunc('hour', now()), $2, 1, 1)`,
      [id, value(key)],
    );
    for (const table of ['obs_1h', 'obs_1d']) {
      await admin.query(
        `INSERT INTO ${table} (series_id, bucket, vmin, vmax, vavg, vlast, n, qc_or)
         SELECT $1, t, $2, $2, $2, $2, 1, 1 FROM unnest(ARRAY[date_trunc('day', now()) - interval '40 days',
                                                                  date_trunc('day', now())]) t`,
        [id, value(key)],
      );
    }
  }

  // Dependent rows. Owner-audience rows hang on PUBLIC series and stations (the
  // LU-4-on-LU-1 case), and public rows on series that are not public.
  await admin.query(
    `
    INSERT INTO reference_value (series_id, source_id, kind, value, unit, semantics, valid) VALUES
      ($1, 'NL-1', 'MHW', 725, 'cm', 'statistical', tstzrange('2020-01-01', NULL)),
      ($1, 'LU-4', 'WAAK_OWNER', 350, 'cm', 'operational', tstzrange('2020-01-01', NULL)),
      ($1, 'DE-9', 'OFF_REF', 1, 'cm', 'operational', tstzrange('2020-01-01', NULL)),
      ($2, 'NL-1', 'MHW', 1, 'cm', 'statistical', tstzrange('2020-01-01', NULL)),
      ($3, 'NL-1', 'MHW', 2, 'cm', 'statistical', tstzrange('2020-01-01', NULL)),
      ($4, 'CANARY-OWNER', 'CANARY', ${OWNER_CANARY}, 'cm', 'operational', tstzrange('2020-01-01', NULL));
    `,
    [ids.public, ids.onlyOwner, ids.mirror, ids.ownerCanary],
  );
  const run = async (seriesId: number | undefined, source: string, v: number) => {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO forecast_run (series_id, source_id, issued_at, first_valid, last_valid, fetched_at, content_hash, kind)
       VALUES ($1::int, $2::text, now(), now(), now() + interval '2 days', now(),
               decode(md5($2::text || $1::int::text), 'hex'), 'deterministic')
       RETURNING id`,
      [seriesId, source],
    );
    await admin.query(
      'INSERT INTO forecast_value (run_id, valid_ts, value) VALUES ($1, now() + interval $$1 hour$$, $2)',
      [(rows[0] as { id: string }).id, v],
    );
  };
  await run(ids.public, 'NL-1', 200);
  await run(ids.public, 'DE-2', 201); // an owner run on a public series
  await run(ids.onlyOwner, 'NL-1', 202); // a public run on an owner series
  await run(ids.ownerCanary, 'CANARY-OWNER', OWNER_CANARY);
  await run(ids.withheld, 'NL-1', WITHHELD_CANARY);

  await admin.query(
    `
    INSERT INTO warning_area (source_id, area_key, name, level_norm, valid) VALUES
      ('NL-1', 'a1', 'PUBLIC-WARNING', 2, tstzrange(now() - interval '1 day', NULL)),
      ('LU-4', 'a2', 'OWNER-WARNING', 3, tstzrange(now() - interval '1 day', NULL)),
      ('DE-9', 'a3', 'OFF-WARNING', 3, tstzrange(now() - interval '1 day', NULL));
    INSERT INTO class_obs (subject_type, subject_id, ts, source_id, provider_code, level_norm) VALUES
      ('station', 'nl.rws.public', now(), 'NL-1', 'PUBLIC_CLASS', 1),
      ('station', 'nl.rws.public', now(), 'LU-4', 'OWNER_CLASS', 2),
      ('station', 'be.spw.only-owner', now(), 'NL-1', 'PUBLIC_CLASS_ON_OWNER_STATION', 1),
      ('area', 'area-1', now(), 'NL-1', 'PUBLIC_AREA', 1),
      ('area', 'area-1', now(), 'LU-4', 'OWNER_CLASS', 2);
    INSERT INTO source_health (source_id, status, last_fetch_ok) VALUES
      ('NL-1', 'ok', now()), ('DE-1', 'ok', now()), ('BE-3', 'ok', now()), ('LU-4', 'down', now()),
      ('DE-2', 'ok', now()), ('CANARY-OWNER', 'ok', now());
    INSERT INTO ingest_batch (source_id, spec_id, archive_key, fetched_at, adapter_version, parse_status) VALUES
      ('NL-1', 'spec-public', 'raw/NL-1/spec-public/2026/10/01/000000Z-aaaaaaaaaaaaaaaa.zst', now(), 1, 'ok'),
      ('BE-3', 'spec-owner', 'raw/BE-3/spec-owner/2026/10/01/000000Z-bbbbbbbbbbbbbbbb.zst', now(), 1, 'quarantined');
    `,
  );
  await admin.query(
    `INSERT INTO twin (id, series_a, series_b) VALUES
       ('public-pair', $1, $2), ('public-and-twin', $1, $5), ('public-owner-pair', $1, $3), ('public-off-pair', $1, $4)`,
    [ids.public, ids.public2, ids.onlyOwner, ids.narrowedOff, ids.twin],
  );
  await admin.query(`
    INSERT INTO twin_check (twin_id, window_end, n_aligned, ok) VALUES
      ('public-pair', now(), 10, true), ('public-and-twin', now(), 10, true),
      ('public-owner-pair', now(), 10, true), ('public-off-pair', now(), 10, false)`);
  return ids;
}
