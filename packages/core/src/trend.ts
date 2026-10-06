// The 24-hour change and its trend (P7b, A§10). Imports nothing: the web takes it through `@rws/core/trend` (P10a).

/** The trend's dead band (deltaH): H ± 2 cm; Q ± max(1 m³/s, 2 % of the start value). */
export const TREND_BAND = { cm: 2, qAbs: 1, qRel: 0.02 } as const;

/** Δh since the window start (canonical units) and its trend, with the dead band of TREND_BAND (|Δh| at the band is steady). */
export function deltaH(
  curr: number | null,
  start: number | null,
  quantity: 'H' | 'Q',
): { dh: number; trend: 'rising' | 'falling' | 'steady' } | null {
  if (curr === null || start === null) return null;
  const dh = curr - start;
  const band = quantity === 'H' ? TREND_BAND.cm : Math.max(TREND_BAND.qAbs, TREND_BAND.qRel * Math.abs(start));
  return { dh, trend: dh > band ? 'rising' : dh < -band ? 'falling' : 'steady' };
}
