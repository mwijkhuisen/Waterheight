import { readFileSync } from 'node:fs';
import { SchemaDrift } from '@rws/core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { DATASETS } from '../../adapters/ch-9/normalise.ts';
import { countRecords } from '../../adapters/ch-9/parse.ts';
import { driftCode, type Provider } from '../provider.ts';
import type { Ch9BackfillSpec, Ch9Unit } from '../spec.ts';

// P14b: the CH-9 backfill provider (data.bs.ch): units are the spec's datasets, one GET of the dataset's JSON export per
// chunk (`/records` stops at offset + limit 10,000), no probe. The request is built only from the spec and the unit.

const Rows = z.looseObject({
  stations: z.array(
    z.looseObject({ provider_key: z.string(), role: z.string(), audience: z.string(), quantity: z.string() }),
  ),
});

const sql = (ms: number) => new Date(ms).toISOString().replaceAll('.000Z', 'Z');

export const provider: Provider | null = {
  units(spec: Ch9BackfillSpec, dir: URL): Ch9Unit[] {
    const rows = Rows.parse(parseYaml(readFileSync(new URL('stations/ch-1.yaml', dir), 'utf8'))).stations;
    const primary = (key: string) =>
      rows.some((r) => r.provider_key === key && r.role === 'primary' && r.audience === 'public');
    return spec.datasets.map((d) => {
      const known = Object.hasOwn(DATASETS, d.id) ? DATASETS[d.id] : undefined;
      if (known === undefined || known.station !== d.station)
        throw new Error(`registry/backfill: dataset ${d.id} is not station ${d.station} of the CH-9 adapter`);
      for (const q of known.q ? ['W', 'Q'] : ['W'])
        if (!primary(`${d.station}/${q}`))
          throw new Error(`registry/stations: ${d.station}/${q} is not a public primary CH-1 series`);
      // A record every 5 minutes with two values (W and Q); only the 10-minute grid is stored, W and (2289) Q.
      return {
        series_key: d.id,
        step_ms: 300_000,
        per_step: { values: 2, rows: known.q ? 1 : 0.5 },
        dataset: d.id,
        station: d.station,
      };
    });
  },
  chunkRequest(spec, unit: Ch9Unit, chunk) {
    const where = `timestamp >= '${sql(chunk.from.getTime())}' AND timestamp < '${sql(chunk.to.getTime())}'`;
    return {
      url: `${spec.url}${encodeURIComponent(unit.dataset)}/exports/json?where=${encodeURIComponent(where).replaceAll("'", '%27')}&order_by=timestamp`,
      method: 'GET',
      headers: { accept: 'application/json' },
      variant: unit.dataset,
    };
  },
  inspect(body) {
    try {
      return { ok: true, values: 2 * countRecords(body) };
    } catch (err) {
      if (err instanceof SchemaDrift)
        return err.code === 'too_big' || err.code === 'json_too_many_nodes'
          ? { ok: false, code: 'truncated' }
          : { ok: false, code: 'schema_drift', drift: driftCode(err) };
      throw err;
    }
  },
  // A top-level array: `count: ''` counts the root (an empty answer is valid and writes no line).
  validity: { format: 'json', required: [], reject: [], count: '', min: 0, allow_status: [204], end_html: false },
  lineVariant: true,
  // 113 B a record, 2 values (W and Q) a record; zstd_ratio is a divisor (zstd measured 18:1 on the month, 14:1 on the Birs day); a row is P14a's 90 B.
  dryRun: { bytes_per_value: 56.5, zstd_ratio: 15, db_bytes_per_row: 90 },
};
