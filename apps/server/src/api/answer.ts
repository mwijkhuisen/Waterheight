import type { AttributionEntry } from '@rws/contracts';
import { attributionFor, type SourceDate, standText } from '../attribution.ts';
import { FILLED_BY } from '../load/adapters.ts';
import type { Static } from './states.ts';
import { coded } from './util.ts';

// The `attribution` of every API answer (P9b, A§9.2, catalogue §1b): exactly the sources the body names, each with
// its rows of the family's attribution view and the date its licence asks for. One pure rule over the body, shared by
// every route: every series id names its series' source, every `source` or source `id` field names itself, and a
// value filled from another source's payload (qc bit 512) names the fill sources of its series' source. A body that
// names a source outside the family's source view fails closed (503 `unavailable`, logged `attribution_missing`):
// that catches an owner-audience source in a public body. A family source without an attribution row (LU-3, owner)
// names no entry.

/** The routes whose bodies carry attribution. */
export type BodyKind = 'meta' | 'stations' | 'snapshot' | 'series' | 'forecast' | 'healthSources';

/** qc bit 512: a row filled from another source's payload (A§6, P5a). */
export const FILL_BIT = 512;

/**
 * The sources a value of `source`'s series names: the source itself, and its fill sources when its qc (or a rollup's
 * qc_or) carries the fill bit. The one rule of the API and the static files (the publisher's renderers use it too).
 */
export const valueSources = (source: string, qc: number): string[] =>
  (qc & FILL_BIT) === 0 ? [source] : [source, ...(FILLED_BY.get(source) ?? [])];

type Named = Map<string, number | null>;
const name = (out: Named, source: string, at: number | null = null) => {
  const old = out.get(source);
  if (old === undefined || (at !== null && (old === null || at > old))) out.set(source, at);
};
const ms = (s: string) => Date.parse(s);

/**
 * The sources a body names, each with the newest instant of its data in the body (null when the body states none
 * for it). `seriesSource` maps a series id to its source (the family's static rows).
 */
export function bodySources(kind: BodyKind, body: unknown, seriesSource: (id: number) => string | undefined): Named {
  const out: Named = new Map();
  const series = (id: number, at: number | null = null) => {
    const s = seriesSource(id);
    if (s === undefined) throw coded('attribution_missing');
    name(out, s, at);
    return s;
  };
  const fills = (target: string, at: number) => {
    for (const f of FILLED_BY.get(target) ?? []) name(out, f, at);
  };
  const b = body as Record<string, unknown>;
  switch (kind) {
    case 'meta': {
      for (const s of b.sources as { id: string }[]) name(out, s.id);
      for (const h of b.forecastHorizons as { source: string }[]) name(out, h.source);
      break;
    }
    case 'stations': {
      for (const st of b.stations as { series: { source: string }[] }[]) for (const s of st.series) name(out, s.source);
      break;
    }
    case 'snapshot': {
      type Basis = { source: string } | null | undefined;
      for (const v of b.values as { series: number; ts: string; qc: number; basis: Basis; area?: { basis: Basis } }[]) {
        const at = ms(v.ts);
        const src = series(v.series, at);
        if ((v.qc & FILL_BIT) !== 0) fills(src, at);
        if (v.basis) name(out, v.basis.source);
        if (v.area?.basis) name(out, v.area.basis.source);
      }
      for (const f of (b.forecasts ?? []) as { series: number; source: string; issuedAt: string; basis: Basis }[]) {
        series(f.series);
        name(out, f.source, ms(f.issuedAt));
        if (f.basis) name(out, f.basis.source);
      }
      break;
    }
    case 'series': {
      const points = b.points as ({ ts: string; qc: number } | { bucket: string; qcOr: number })[];
      let newest: number | null = null;
      for (const p of points) {
        const at = ms('ts' in p ? p.ts : p.bucket);
        newest = newest === null || at > newest ? at : newest;
      }
      const src = series(b.id as number, newest);
      for (const p of points)
        if ((('qc' in p ? p.qc : p.qcOr) & FILL_BIT) !== 0) fills(src, ms('ts' in p ? p.ts : p.bucket));
      break;
    }
    case 'forecast': {
      series(b.series as number);
      const run = b.run as { source: string; issuedAt: string } | null;
      if (run !== null) name(out, run.source, ms(run.issuedAt));
      break;
    }
    case 'healthSources': {
      for (const s of b.sources as { id: string }[]) name(out, s.id);
      for (const q of b.quarantined_batches as { source: string }[]) name(out, q.source);
      break;
    }
  }
  return out;
}

/**
 * The `attribution` of an answer. `live` answers (meta, stations, health, a snapshot or forecast at or after now's
 * bucket) date each source by what the loader knows now (sourceDates, held 60 s with the static rows); historical
 * answers by the newest instant of that source in the body, else `at` (the answer's own instant), so an immutable
 * body is a pure function of its data. A live date the loader does not have falls back the same way.
 */
export function attributionOf(
  st: Pick<Static, 'sources' | 'attribution' | 'dates'>,
  named: Named,
  opts: { live: boolean; at: number },
): AttributionEntry[] {
  const dates = new Map<string, SourceDate>();
  for (const [source, newest] of named) {
    if (!st.sources.has(source)) throw coded('attribution_missing');
    const live = opts.live ? st.dates.get(source) : undefined;
    if (live?.date != null) dates.set(source, live);
    else {
      const when = newest ?? opts.at;
      dates.set(source, { date: new Date(when).toISOString(), dateText: source === 'DE-6' ? standText(when) : null });
    }
  }
  return attributionFor(st.attribution, named.keys(), dates);
}

/**
 * KG-114 closed (P9b): how long an answer may be kept when it holds a series without lic_history_export: until its
 * oldest such value leaves the series' history window (min over them of window − (now − ts)); Infinity when it holds
 * none. The route stores it in the LRU entry and caps the max-age it sends; such an answer is never immutable.
 */
export function historyCapMs(
  kind: BodyKind,
  body: unknown,
  history: ReadonlyMap<number, number>,
  nowMs: number,
): number {
  if (history.size === 0) return Number.POSITIVE_INFINITY;
  const b = body as Record<string, unknown>;
  let cap = Number.POSITIVE_INFINITY;
  const at = (id: number, ts: string) => {
    const w = history.get(id);
    if (w !== undefined) cap = Math.min(cap, w - (nowMs - Date.parse(ts)));
  };
  if (kind === 'snapshot') for (const v of b.values as { series: number; ts: string }[]) at(v.series, v.ts);
  if (kind === 'series')
    for (const p of b.points as ({ ts: string } | { bucket: string })[])
      at(b.id as number, 'ts' in p ? p.ts : p.bucket);
  return Math.max(0, cap);
}
