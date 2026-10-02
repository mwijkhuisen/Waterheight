import {
  emptyNormalised,
  isFuture,
  type Normalised,
  parseInstant,
  QC,
  type Registry,
  rangeBit,
  SchemaDrift,
  scale,
  type TimeConvention,
  TimeError,
  toIso,
} from '@rws/core';
import type { File } from './parse.ts';

// LU-2 AGE per-station JSON → canonical rows (owner audience; catalogue §2.6, §0.8). The same gauges as LU-1,
// kept as a twin of the LU-1 series in both audiences (never primary). Declared here, never inferred per row:
//  - series: `ts_path` verbatim (AGE's own numbers, the Service de la navigation's for the Moselle, the WSV's
//    for Perl); one file is one series, and a path the registry does not know is `unknown`, nothing stored;
//  - time: ISO 8601 with the stamp's own offset (`iso-offset`), so the repeated hour of 2026-10-25 reads
//    `+02:00` then `+01:00` and comes out as strictly increasing UTC. These instants are on time: no label offset
//    is applied (LU-1's labels are the ones that may be late, load/label-offset.ts);
//  - values as published, cm above the gauge zero (stage); only the Esch-Sûre dam (`W_out_LAC`) is `m` NN, an
//    absolute level on NG95, which the registry row's factor turns into cm. No other conversion;
//  - unit: the payload's `ts_unitsymbol` must be the series' native unit, else every value is withheld
//    (`unit_mismatch`, withheld and alerted). It is not listed in `unitMismatch`: the loader keeps one such list per
//    source, and each of the 39 files states one series, so a file would erase the others' entries; each payload
//    carries its own unit;
//  - missing values are omitted from the file (30-minute holes): no row is ever invented. A `null` value is a
//    gap, never 0; a time stated twice with one value is kept once (`duplicate`), with two values neither is
//    stored (`conflict`);
//  - qc raw; our range bit; a stamp more than 15 minutes ahead or older than 45 days is dropped.

export const SOURCE = 'LU-2';
export const TIME: TimeConvention = { kind: 'iso-offset' };

const MAX_AGE_MS = 45 * 86_400_000;

export type Context = {
  registry: Registry;
  /** When the payload was fetched (UTC ms): the reference for "future" and "too old". */
  fetchedAt: number;
};

const count = (out: Normalised, code: string, n = 1) => {
  out.dropped[code] = (out.dropped[code] ?? 0) + n;
};

function instant(raw: string): number {
  try {
    return parseInstant(TIME, raw);
  } catch (err) {
    if (err instanceof TimeError) throw new SchemaDrift(`time_${err.code}`);
    throw err;
  }
}

export function normalise(file: File, ctx: Context): Normalised {
  const out = emptyNormalised();
  const decl = ctx.registry.get(file.ts_path);
  if (decl === undefined) {
    out.unknown = 1;
    return out;
  }
  if (file.ts_unitsymbol !== decl.native_unit) {
    if (file.data.length > 0) count(out, 'unit_mismatch', file.data.length);
    return out;
  }
  // Per instant: the value, or null once two stamps disagree.
  const byTime = new Map<number, number | null>();
  for (const [stamp, raw] of file.data) {
    if (raw === null) {
      count(out, 'gap');
      continue;
    }
    const ts = instant(stamp);
    if (isFuture(ts, ctx.fetchedAt)) {
      count(out, 'future');
      continue;
    }
    if (ts < ctx.fetchedAt - MAX_AGE_MS) {
      count(out, 'too_old');
      continue;
    }
    const before = byTime.get(ts);
    if (before === undefined) byTime.set(ts, raw);
    else if (before === null) count(out, 'conflict');
    else if (before === raw) count(out, 'duplicate');
    else {
      byTime.set(ts, null);
      count(out, 'conflict', 2);
    }
  }
  for (const ts of [...byTime.keys()].sort((a, b) => a - b)) {
    const raw = byTime.get(ts);
    if (raw === null || raw === undefined) continue;
    const value = scale(decl.to_canonical, raw);
    out.obs.push({ series: decl.key, ts: toIso(ts), value, qc: QC.RAW | rangeBit(decl.value_kind ?? 'stage', value) });
  }
  return out;
}
