import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { BACKFILL_HEADER, BACKFILL_ZIP, MEMBER_RE } from '../../adapters/de-8/parse.ts';
import type { Provider } from '../provider.ts';
import type { De8BackfillSpec, De8Unit } from '../spec.ts';

// P14b: the DE-8 backfill provider (the NRW decade ZIPs of hydro/w): units from the spec's datasets, one GET per
// decade file, no probe, never halved (a file is a file), the response reused by every slice of the file.

const STEP_MS = 900_000;
const DECADE_YEARS = 10;

const Row = z.looseObject({
  provider_key: z.string(),
  quantity: z.enum(['H', 'Q']),
  role: z.string(),
  audience: z.string(),
  first_release: z.boolean(),
});
const Stations = z.looseObject({ stations: z.array(Row) });

/**
 * The stations the spec's datasets list must be exactly the `public`, `primary`, `first_release` W rows of
 * registry/stations/de-7.yaml, each once: the selection is the registry's, the datasets only say which file holds a gauge.
 */
function registered(dir: URL): Set<string> {
  const file = Stations.parse(parseYaml(readFileSync(new URL('stations/de-7.yaml', dir), 'utf8')));
  return new Set(
    file.stations
      .filter((r) => r.first_release && r.role === 'primary' && r.audience === 'public' && r.quantity === 'H')
      .map((r) => r.provider_key.replace(/\/W$/, '')),
  );
}

export const provider: Provider | null = {
  units(spec: De8BackfillSpec, dir: URL): De8Unit[] {
    const want = registered(dir);
    const listed = spec.datasets.flatMap((d) => d.stations);
    const problems = [
      ...listed.filter((s) => !want.has(s)).map((s) => `${s} is not a public primary first_release DE-7 W row`),
      ...[...want].filter((s) => !listed.includes(s)).map((s) => `${s} is a first_release DE-7 W row no dataset lists`),
      ...listed.filter((s, i) => listed.indexOf(s) !== i).map((s) => `${s} is listed twice`),
    ];
    if (problems.length > 0) throw new Error(`backfill spec ${spec.id}: ${problems.join('; ')}`);
    return spec.datasets.flatMap((d) =>
      [...d.decades]
        .sort((a, b) => a - b)
        .map((decade) => {
          const from = new Date(Date.UTC(decade, 0, 1));
          const to = new Date(Date.UTC(decade + DECADE_YEARS, 0, 1));
          return {
            series_key: `${d.name}/${decade}`,
            step_ms: STEP_MS,
            range: { from, to },
            values: (d.stations.length * (to.getTime() - from.getTime())) / STEP_MS,
            dataset: d.name,
            decade,
            file: `${d.name}-NRW-W_${decade}-${decade + DECADE_YEARS - 1}_EPSG25832_CSV.zip`,
          };
        }),
    );
  },
  chunkRequest(spec, unit: De8Unit) {
    // The whole decade file, whatever the slice: a slice is cut by the loader, not by the request.
    return { url: `${spec.url}${encodeURIComponent(unit.file)}`, method: 'GET', variant: unit.series_key };
  },
  // The ZIP's integrity (members, header, caps) is `validity`'s and the loader's; there is no value count to read here.
  inspect: () => ({ ok: true, values: 0 }),
  validity: {
    format: 'zip',
    required: [],
    reject: [],
    min: 1,
    allow_status: [],
    zip: {
      members: [],
      member_pattern: MEMBER_RE.source,
      header_all: BACKFILL_HEADER,
      header: {},
      encoding: 'utf-8',
      max_members: BACKFILL_ZIP.members,
      max_total: BACKFILL_ZIP.total,
    },
    end_html: false,
  },
  halvable: false,
  reuse: true,
  // Measured on the recorded index of hydro/w (2026-10-18): the 32 files of the four catchments are 163,981,521 bytes
  // for 25,246,080 grid points (the stations x decades x PT15M of the spec): 6.5 bytes per stored value. A ZIP does not
  // compress again, so zstd 1.
  dryRun: { bytes_per_value: 6.5, zstd_ratio: 1, db_bytes_per_row: 90 },
};
