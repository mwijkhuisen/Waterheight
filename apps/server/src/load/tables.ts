import { existsSync, readFileSync } from 'node:fs';
import {
  type LhpStationsFile,
  LhpStationsFile as LhpStationsSchema,
  type VigicruesOverridesFile,
  VigicruesOverridesFile as VigicruesOverridesSchema,
  type VigicruesSectionsFile,
  VigicruesSectionsFile as VigicruesSectionsSchema,
} from '@rws/contracts';
import { parse } from 'yaml';
import type { z } from 'zod';
import { REGISTRY_DIR } from '../capture/specs.ts';

// P7a: the registry tables an adapter needs beside its source's series (the LHP station map of DE-6, the
// Vigicrues station → section table of FR-5). Adapters are pure and read no file (scripts/check-boundaries.ts):
// the loader reads each table once, on first use (the API imports load/adapters.ts and must read nothing), checks
// it strictly and hands it to the normaliser as an argument. A table changes only at a deploy, like the registry.

function reader<T>(file: string, schema: z.ZodType<T>, dir: URL = REGISTRY_DIR): () => T {
  let value: T | undefined;
  return () => {
    if (value === undefined) {
      // Aliases off: a reviewed table has no use for them, and they are the YAML expansion attack.
      value = schema.parse(parse(readFileSync(new URL(file, dir), 'utf8'), { maxAliasCount: 0 }));
    }
    return value;
  };
}

/** registry/classes/de-6.yaml (scripts/gen-de6-stations.ts). */
export const lhpStations: () => LhpStationsFile = reader('classes/de-6.yaml', LhpStationsSchema);

const sections = reader('vigicrues-sections.yaml', VigicruesSectionsSchema);
const overrides = (dir: URL): VigicruesOverridesFile =>
  existsSync(new URL('vigicrues-overrides.yaml', dir))
    ? reader('vigicrues-overrides.yaml', VigicruesOverridesSchema, dir)()
    : { overrides: [] };

/**
 * The station → section map of a registry directory with the reviewed overrides applied: our FR-1 station id → its
 * section (code), for the stations we register. An override moves a Vigicrues station to another section or to none.
 * Not cached (tests call it with a temporary directory); `vigicruesSections` is the cached one of the registry.
 */
export function sectionMap(dir: URL = REGISTRY_DIR): ReadonlyMap<string, string> {
  const moved = new Map(overrides(dir).overrides.map((o) => [o.vigicrues, o.section]));
  const out = new Map<string, string>();
  const file = reader('vigicrues-sections.yaml', VigicruesSectionsSchema, dir)();
  for (const s of file.sections)
    for (const m of s.stations) {
      if (m.station === null) continue;
      const section = moved.has(m.vigicrues) ? moved.get(m.vigicrues) : s.section;
      if (section !== null && section !== undefined) out.set(m.station, section);
    }
  return out;
}

const lazy = <T>(make: () => T): (() => T) => {
  let value: T | undefined;
  return () => {
    if (value === undefined) value = make();
    return value;
  };
};

/** Our FR-1 station id → its section code (registry/vigicrues-sections.yaml and overrides), read once. */
export const vigicruesSections: () => ReadonlyMap<string, string> = lazy(() => sectionMap());

/** The section codes of registry/vigicrues-sections.yaml: the only sections whose vigilance is stored (FR-5). */
export const vigicruesSectionCodes: () => ReadonlySet<string> = lazy(
  () => new Set((sections() as VigicruesSectionsFile).sections.map((s) => s.section)),
);

/**
 * Section code → its territory and the Vigicrues station codes the file lists for it, as generated (overrides are
 * our corrections of the provider's structure and are not part of what the daily drift report compares).
 */
export const vigicruesSectionTable: () => ReadonlyMap<string, { territory: string; stations: readonly string[] }> =
  lazy(
    () =>
      new Map(
        (sections() as VigicruesSectionsFile).sections.map((s) => [
          s.section,
          { territory: s.territory, stations: s.stations.map((m) => m.vigicrues) },
        ]),
      ),
  );
