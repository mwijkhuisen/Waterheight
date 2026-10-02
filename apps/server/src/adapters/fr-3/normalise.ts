import {
  emptyNormalised,
  isFuture,
  type Normalised,
  type ObsRow,
  parseInstant,
  QC,
  type Registry,
  rangeBit,
  SchemaDrift,
  scale,
  type TimeConvention,
  TimeError,
  thin,
  toIso,
} from '@rws/core';
import type { Serie } from './parse.ts';

// FR-3 Vigicrues → canonical rows (catalogue §2.5, §4.4, §4.5; A§7.2). FR-3 is
// a twin and a gap-fill source, never primary. Declared here, never inferred
// per row:
//  - series: `<CdStationHydro>/<GrdSerie>`, the same key as the FR-1 series of
//    that station: the rows go to the FR-3 twin series and, as gap-fill rows,
//    to the FR-1 series (the loader stores a fill row only where FR-1 states
//    no value, with the backfilled bit, and never as a revision);
//  - time: epoch milliseconds UTC;
//  - unit and factor from the twin's registry row: H in m relative to the
//    gauge zero (×100), Q in m³/s (×1);
//  - only on-grid samples of the declared step (the FR-1 series' step), so a
//    fill row never adds an instant that FR-1 would not have;
//  - Vigicrues publishes raw values: qc "raw"; a negative Q gets our range bit
//    as in FR-1;
//  - the document holds about 72 days, all of it kept (the seed's point):
//    90 days is the age limit, not the 45 days of the live sources.

export const SOURCE = 'FR-3';
export const TIME: TimeConvention = { kind: 'epoch-ms' };

const MAX_AGE_MS = 90 * 86_400_000;

export type Context = {
  registry: Registry;
  fetchedAt: number;
  /** The manifest line's variant: `<code>/<H|Q>`, or empty for a recovered line. */
  variant: string;
};

const count = (out: Normalised, code: string, n = 1) => {
  out.dropped[code] = (out.dropped[code] ?? 0) + n;
};

export function normaliseSerie(serie: Serie, ctx: Context): Normalised {
  const out = emptyNormalised();
  const key = `${serie.CdStationHydro}/${serie.GrdSerie}`;
  // The payload names its own series; one that is not the series we asked for is drift.
  if (ctx.variant !== '' && ctx.variant !== key) throw new SchemaDrift('bad_variant');
  const decl = ctx.registry.get(key);
  if (decl === undefined) {
    out.unknown = 1;
    return out;
  }
  const byTime = new Map<number, number | null>();
  for (const [raw, value] of serie.ObssHydro) {
    let ts: number;
    try {
      ts = parseInstant(TIME, raw);
    } catch (err) {
      if (err instanceof TimeError) throw new SchemaDrift(`time_${err.code}`);
      throw err;
    }
    if (value === null) {
      count(out, 'gap');
      continue;
    }
    const before = byTime.get(ts);
    if (before === undefined) byTime.set(ts, value);
    else if (before === null) count(out, 'conflict');
    else if (before === value) count(out, 'duplicate');
    else {
      byTime.set(ts, null);
      count(out, 'conflict', 2);
    }
  }
  const samples = [...byTime]
    .flatMap(([ts, value]) => (value === null ? [] : [{ ts, value }]))
    .sort((a, b) => a.ts - b.ts);
  const kept = thin(samples, decl.expected_step_ms);
  if (kept.length < samples.length) count(out, 'thinned', samples.length - kept.length);
  const rows: ObsRow[] = [];
  for (const s of kept) {
    if (isFuture(s.ts, ctx.fetchedAt)) count(out, 'future');
    else if (s.ts < ctx.fetchedAt - MAX_AGE_MS) count(out, 'too_old');
    else {
      const value = scale(decl.to_canonical, s.value);
      const kind = decl.quantity === 'Q' ? 'Q' : (decl.value_kind ?? 'stage');
      const negativeQ = decl.quantity === 'Q' && value < 0 ? QC.RANGE : 0;
      rows.push({ series: key, ts: toIso(s.ts), value, qc: QC.RAW | rangeBit(kind, value) | negativeQ });
    }
  }
  out.obs = rows;
  out.fill = rows.map((r) => ({ ...r }));
  return out;
}
