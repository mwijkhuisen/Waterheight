import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normaliseRecords } from '../../../src/adapters/ch-9/normalise.ts';
import { parseRecords } from '../../../src/adapters/ch-9/parse.ts';
import { registryOf } from '../registry.ts';

// The twin bound of the plan (§3.8): at every instant both sides state, CH-9's value equals the CH-1 value of our own
// API (raw answers recorded 2026-10-10, see twin/README.md) within 1 cm (W) or 1 % (Q). Rhine 2289 passes both;
// the Birs 2106 passes W only, which is why its Q is never loaded.

type Points = { points: { ts: string; value: number | null }[] };
const dir = new URL('./twin/', import.meta.url);
const file = (name: string) => readFileSync(new URL(name, dir));
const ch1 = (id: number) =>
  new Map((JSON.parse(file(`ch-9-twin-ch1-${id}.json`).toString()) as Points).points.map((p) => [p.ts, p.value]));
const window = { from: Date.parse('2026-10-10T00:00:00Z'), to: Date.parse('2026-10-11T00:00:00Z') };
const load = (name: string, dataset: string) =>
  normaliseRecords(parseRecords(file(name), dataset), {
    registry: registryOf('CH-1'),
    fetchedAt: Date.parse('2026-10-18T12:00:00Z'),
    dataset,
    backfill: window,
  });

/** Max |Δ| (cm for W, % for Q) and the number of shared instants. */
function compare(out: ReturnType<typeof load>, series: string, theirs: Map<string, number | null>, relative: boolean) {
  let shared = 0;
  let max = 0;
  for (const r of out.obs.filter((o) => o.series === series)) {
    const v = theirs.get(r.ts);
    if (v === undefined || v === null) continue;
    shared += 1;
    max = Math.max(max, relative ? (Math.abs(v - r.value) / r.value) * 100 : Math.abs(v - r.value));
  }
  return { shared, max };
}

describe('CH-9 against CH-1 on 2026-10-10', () => {
  const rhine = load('ch-9-export-100089-twin.raw', '100089');
  const birs = load('ch-9-export-100236-day.raw', '100236');

  it('Rhine W: within 1 cm at every shared instant', () => {
    const { shared, max } = compare(rhine, '2289/W', ch1(2399), false);
    expect(shared).toBeGreaterThanOrEqual(100);
    expect(max).toBeLessThanOrEqual(1);
  });

  it('Rhine Q: within 1 % at every shared instant', () => {
    const { shared, max } = compare(rhine, '2289/Q', ch1(2400), true);
    expect(shared).toBeGreaterThanOrEqual(100);
    expect(max).toBeLessThanOrEqual(1);
  });

  it('Birs W: within 1 cm at every shared instant', () => {
    const { shared, max } = compare(birs, '2106/W', ch1(2281), false);
    expect(shared).toBeGreaterThanOrEqual(100);
    expect(max).toBeLessThanOrEqual(1);
  });

  it('Birs Q: is not produced (it fails the 1 % bound against CH-1)', () => {
    expect(birs.obs.some((r) => r.series.endsWith('/Q'))).toBe(false);
    expect(birs.dropped.q_not_twin).toBe(288);
    // The recorded numbers behind that: the Birs's Q would not hold the bound.
    const theirs = ch1(2282);
    let worst = 0;
    for (const r of parseRecords(file('ch-9-export-100236-day.raw'), '100236')) {
      const v = theirs.get(new Date(r.timestamp).toISOString());
      if (v !== undefined && v !== null && r.abfluss !== null)
        worst = Math.max(worst, (Math.abs(v - r.abfluss) / r.abfluss) * 100);
    }
    expect(worst).toBeGreaterThan(1);
  });
});
