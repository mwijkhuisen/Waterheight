import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Source, type Station, validateRegistry, validateStations } from '@rws/contracts';
import { durationMs } from '@rws/core';
import { type Kysely, sql } from 'kysely';
import { parse } from 'yaml';
import { REGISTRY_DIR } from '../capture/specs.ts';
import type { DB } from '../db/generated.ts';

// Registry sync (issue #17; A§6): registry/*.yaml → provider, source,
// attribution, river, station, station_alias and series. It runs in the
// `migrate` role, as the object owner; the loader can only read these tables.
// Everything is copied as the registry states it: audience, private_basis and
// the licence channels unchanged, attribution text verbatim. A series exists
// only because a station row declares it; nothing here (or anywhere) registers
// a series from a payload.

export class RegistryError extends Error {}

export type RegistryInput = {
  sources: Source[];
  providers: ReturnType<typeof validateRegistry>['providers'];
  stations: Station[];
};

/** Reads and validates the registry; throws RegistryError with every problem found (fails closed). */
export function readRegistry(
  dir: URL = REGISTRY_DIR,
  today: string = new Date().toISOString().slice(0, 10),
): RegistryInput {
  const yaml = (name: string) => parse(readFileSync(new URL(name, dir), 'utf8'));
  const permissions = new URL('permissions/', dir);
  if (existsSync(permissions) && readdirSync(permissions).some((f) => f.endsWith('.md'))) {
    // A permission record changes what may be published; this sync does not read them yet (P13).
    throw new RegistryError('registry/permissions holds records, which the sync cannot apply yet');
  }
  const registry = validateRegistry(yaml('providers.yaml'), yaml('sources.yaml'), {
    permissionRecords: new Map(),
    today,
  });
  const problems = [...registry.problems];
  const stations: Station[] = [];
  const stationsDir = new URL('stations/', dir);
  const files = existsSync(stationsDir)
    ? readdirSync(stationsDir)
        .filter((f) => f.endsWith('.yaml'))
        .sort()
    : [];
  for (const file of files) {
    const result = validateStations(yaml(`stations/${file}`), registry.sources);
    problems.push(...result.problems.map((p) => `stations/${file}: ${p}`));
    stations.push(...result.stations);
  }
  if (problems.length > 0) throw new RegistryError(`registry is not valid:\n${problems.slice(0, 20).join('\n')}`);
  return { sources: registry.sources, providers: registry.providers, stations };
}

const ROLE_PRECEDENCE = { primary: 0, twin: 1, mirror: 2 } as const;

/**
 * The window as hours and smaller only (source.history_window has a CHECK):
 * `now() - '30 days'` depends on the session's time zone, `now() - '720 hours'`
 * does not. A month or year cannot be written as hours and fails the sync.
 */
const historyWindow = (s: Source) =>
  s.history_window === undefined ? '0' : `${durationMs(s.history_window)} milliseconds`;

function one<T>(values: readonly T[], what: string, id: string): T {
  const distinct = [...new Set(values.map((v) => JSON.stringify(v)))];
  if (distinct.length !== 1) throw new RegistryError(`station ${id}: its rows disagree on ${what}`);
  return values[0] as T;
}

export type SyncResult = { sources: number; stations: number; series: number; deactivated: number };

/** One transaction: either the whole registry is in the database, or the previous one still is. */
export async function syncRegistry(db: Kysely<DB>, input: RegistryInput): Promise<SyncResult> {
  const providerOf = new Map(input.sources.map((s) => [s.id, s.provider]));
  const audienceOf = new Map(input.sources.map((s) => [s.id, s.audience]));
  return db.transaction().execute(async (tx) => {
    for (const p of input.providers) {
      await sql`
        INSERT INTO provider (id, name, country, contact, terms_url)
        VALUES (${p.id}, ${p.name}, ${p.country}, ${p.contact}, ${p.terms_url})
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, country = EXCLUDED.country, contact = EXCLUDED.contact,
                                       terms_url = EXCLUDED.terms_url`.execute(tx);
    }
    for (const s of input.sources) {
      const basis = s.private_basis === null ? null : JSON.stringify(s.private_basis);
      await sql`
        INSERT INTO source (id, provider_id, name, licence, licence_kind, audience, permission_ref, private_basis,
                            lic_display, lic_api, lic_bulk_export, lic_history_export, history_window, capture_enabled,
                            canary)
        VALUES (${s.id}, ${s.provider}, ${s.name}, ${s.licence_text}, ${s.licence_kind}, ${s.audience}::audience,
                ${s.permission_required ? `registry/permissions/${s.id}.md` : null}, ${basis}::jsonb,
                ${s.display}, ${s.api}, ${s.bulk_export}, ${s.history_export},
                ${historyWindow(s)}::interval, ${s.capture_enabled}, ${s.canary === true})
        ON CONFLICT (id) DO UPDATE SET
          provider_id = EXCLUDED.provider_id, name = EXCLUDED.name, licence = EXCLUDED.licence,
          licence_kind = EXCLUDED.licence_kind, audience = EXCLUDED.audience, permission_ref = EXCLUDED.permission_ref,
          private_basis = EXCLUDED.private_basis, lic_display = EXCLUDED.lic_display, lic_api = EXCLUDED.lic_api,
          lic_bulk_export = EXCLUDED.lic_bulk_export, lic_history_export = EXCLUDED.lic_history_export,
          history_window = EXCLUDED.history_window, capture_enabled = EXCLUDED.capture_enabled,
          canary = EXCLUDED.canary`.execute(tx);

      // Attribution: the registry text verbatim; never reworded, trimmed or merged.
      await sql`DELETE FROM attribution WHERE source_id = ${s.id}`.execute(tx);
      if (s.needs_last_updated && s.needs_retrieval_date) {
        throw new RegistryError(`${s.id}: both date duties are set; attribution.date_kind holds one`);
      }
      const dateKind = s.needs_last_updated ? 'update' : s.needs_retrieval_date ? 'retrieval' : null;
      const texts = [
        ...(s.attribution_text === null ? [] : [{ lang: s.attribution_lang, text: s.attribution_text }]),
        ...s.attribution_variants,
      ];
      for (const [ord, a] of texts.entries()) {
        await sql`
          INSERT INTO attribution (source_id, ord, lang, text, url, needs_date, date_kind, logo_allowed, required)
          VALUES (${s.id}, ${ord}, ${a.lang}, ${a.text}, ${s.attribution_url}, ${dateKind !== null}, ${dateKind},
                  ${s.logo_allowed}, ${s.attribution_required})`.execute(tx);
      }
    }

    const byStation = new Map<string, Station[]>();
    for (const row of input.stations) byStation.set(row.id, [...(byStation.get(row.id) ?? []), row]);
    for (const river of new Set(input.stations.flatMap((r) => (r.river === null ? [] : [r.river])))) {
      await sql`INSERT INTO river (id) VALUES (${river}) ON CONFLICT (id) DO NOTHING`.execute(tx);
    }
    for (const [id, rows] of byStation) {
      const first = rows[0] as Station;
      const km = one(
        rows.map((r) => r.km),
        'km',
        id,
      );
      const role = (['primary', 'twin', 'mirror'] as const).find((r) => rows.some((x) => x.role === r)) ?? 'mirror';
      const source = one(
        rows.map((r) => r.source),
        'source',
        id,
      );
      await sql`
        INSERT INTO station (id, name, water_name, country, lon, lat, operator_provider_id, river_id, km_official,
                             km_system, flags, tier)
        VALUES (${id}, ${one(
          rows.map((r) => r.name),
          'name',
          id,
        )}, ${one(
          rows.map((r) => r.water_name),
          'water_name',
          id,
        )},
                ${one(
                  rows.map((r) => r.country),
                  'country',
                  id,
                )}, ${one(
                  rows.map((r) => r.lon),
                  'lon',
                  id,
                )},
                ${one(
                  rows.map((r) => r.lat),
                  'lat',
                  id,
                )}, ${role === 'primary' ? (providerOf.get(source) ?? null) : null},
                ${one(
                  rows.map((r) => r.river),
                  'river',
                  id,
                )}, ${km?.value ?? null}, ${km?.system ?? null},
                ${JSON.stringify(
                  one(
                    rows.map((r) => r.flags),
                    'flags',
                    id,
                  ),
                )}::jsonb, ${Math.min(...rows.map((r) => r.tier))})
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name, water_name = EXCLUDED.water_name, country = EXCLUDED.country, lon = EXCLUDED.lon,
          lat = EXCLUDED.lat, operator_provider_id = EXCLUDED.operator_provider_id, river_id = EXCLUDED.river_id,
          km_official = EXCLUDED.km_official, km_system = EXCLUDED.km_system, flags = EXCLUDED.flags,
          tier = EXCLUDED.tier`.execute(tx);
      await sql`
        INSERT INTO station_alias (station_id, source_id, provider_code, role, precedence)
        VALUES (${id}, ${source}, ${first.provider_code}, ${role}, ${ROLE_PRECEDENCE[role]})
        ON CONFLICT (source_id, provider_code) DO UPDATE SET
          station_id = EXCLUDED.station_id, role = EXCLUDED.role, precedence = EXCLUDED.precedence`.execute(tx);
    }

    const kept: number[] = [];
    for (const row of input.stations) {
      // A station row may narrow its source's audience (validateStations refuses anything wider).
      const narrowed = row.audience === audienceOf.get(row.source) ? null : row.audience;
      const datum = row.quantity === 'Q' ? null : (('datum' in row ? row.datum : null) ?? 'LOCAL');
      const { rows } = await sql<{ id: number }>`
        INSERT INTO series (station_id, source_id, quantity, value_kind, provider_key, native_unit, to_canonical, datum,
                            native_step, expected_step, staleness_limit, audience, role, active)
        VALUES (${row.id}, ${row.source}, ${row.quantity}, ${row.value_kind}, ${row.provider_key}, ${row.native_unit},
                ${row.to_canonical}, ${datum}, ${row.native_step}::interval, ${row.expected_step}::interval,
                ${row.staleness_limit}::interval, ${narrowed}::audience, ${row.role}, true)
        ON CONFLICT (source_id, provider_key) DO UPDATE SET
          station_id = EXCLUDED.station_id, quantity = EXCLUDED.quantity, value_kind = EXCLUDED.value_kind,
          native_unit = EXCLUDED.native_unit, to_canonical = EXCLUDED.to_canonical, datum = EXCLUDED.datum,
          native_step = EXCLUDED.native_step, expected_step = EXCLUDED.expected_step,
          staleness_limit = EXCLUDED.staleness_limit, audience = EXCLUDED.audience, role = EXCLUDED.role, active = true
        RETURNING id`.execute(tx);
      kept.push((rows[0] as { id: number }).id);
    }
    // A series that left the registry keeps its history and stops loading; nothing is deleted.
    const synced = [...new Set(input.stations.map((r) => r.source))];
    const gone = await sql`
      UPDATE series SET active = false
      WHERE active AND source_id = ANY(${synced}::text[]) AND NOT (id = ANY(${kept}::int[]))`.execute(tx);
    return {
      sources: input.sources.length,
      stations: byStation.size,
      series: kept.length,
      deactivated: Number(gone.numAffectedRows ?? 0n),
    };
  });
}

export const REGISTRY_PATH = fileURLToPath(REGISTRY_DIR);
