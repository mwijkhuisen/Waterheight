import { existsSync, readFileSync } from 'node:fs';
import { TwinsFile } from '@rws/contracts';
import { SchemaDrift, type TimeConvention } from '@rws/core';
import { parse } from 'yaml';
import { normalise, withReferences } from '../../adapters/lu-4/normalise.ts';
import { parsePage } from '../../adapters/lu-4/parse.ts';
import { REGISTRY_DIR, readSeed } from '../../capture/specs.ts';
import type { DstProof, LoadAdapter } from '../adapters.ts';

// P7a: the loader wiring of LU-4 (its specs, its time convention and, for a gated convention, its DST proof),
// merged into load/adapters.ts. A wiring file may use the guards and the registry tables; the adapter stays pure.
// The owner station pages (spec `lu-4-pages`, variant = the page path) state the vigilance levels and the HQ lines of
// an LU-1 gauge; they become references on that gauge's LU-1 and LU-2 series and, for the Moselle gauges that
// twins.yaml pairs with a DE-1 series, on that DE-1 series too (source_id LU-4: the owner views only).

export const SOURCE = 'LU-4';
export const TIME: TimeConvention | null = null; // a page has no observation timestamps

/** Page path → the LU-1 slug of its gauge (registry/seed/lu-4.csv), read once on first use. */
let stations: ReadonlyMap<string, string> | undefined;
/** LU-1 provider key → the DE-1 provider key of the twin pair (registry/twins.yaml), read once on first use. */
let twins: ReadonlyMap<string, string> | undefined;

function tables(): { stations: ReadonlyMap<string, string>; twins: ReadonlyMap<string, string> } {
  stations ??= new Map(readSeed(REGISTRY_DIR, 'lu-4').map((r) => [r.path as string, r.station as string]));
  if (twins === undefined) {
    const file = new URL('twins.yaml', REGISTRY_DIR);
    const pairs = existsSync(file)
      ? TwinsFile.parse(parse(readFileSync(file, 'utf8'), { maxAliasCount: 0 })).twins
      : [];
    twins = new Map(
      pairs
        .filter((t) => t.a.source === 'LU-1' && t.b.source === 'DE-1')
        .map((t) => [t.a.provider_key, t.b.provider_key]),
    );
  }
  return { stations, twins };
}

export const ADAPTER: LoadAdapter = {
  version: 1,
  specs: {
    'lu-4-pages': {
      maxBytes: 4 * 1024 * 1024,
      // The page does not name its gauge: the manifest variant (the page path) does.
      needsVariant: true,
      refTarget: ['LU-1', 'LU-2', 'DE-1'],
      run: (body, ctx) => {
        const t = tables();
        const station = t.stations.get(ctx.variant);
        if (station === undefined) throw new SchemaDrift('bad_variant');
        // Positions are not stored from LU-4 (LU-6 holds them): an empty map, so no point is looked up.
        const out = normalise(parsePage(body), { station, positions: new Map() });
        return withReferences(out, ctx.refRegistries ?? new Map(), t.twins);
      },
    },
  },
};

export const PROOF: Readonly<Record<string, DstProof>> = {};
