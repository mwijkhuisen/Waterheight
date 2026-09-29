import { describe, expect, it } from 'vitest';
import { strip, table01a } from '../../../../test/catalogue.ts';
import { REGISTRY_DIR, readSeed } from '../../src/capture/specs.ts';
import { registry, spec } from './helpers.ts';

// Criterion "[CI] A test enumerates catalogue §0.1a" (issue #16): every row of
// the table has enabled specs with the checklist interval and change gate, and
// forever retention (LU-1 stays obs). A new row fails this test until it is
// mapped. DE-10 (the note under the table) has no spec until P13.

type Row = { specs: string[]; cadence_s: number; gate: string; conditional?: string; retention: 'forever' | 'obs' };

/** The checklist values (issue #16, "P1a capture checklist" section 1). */
const EXPECTED: Record<string, Row> = {
  'NL-1 forecasts': {
    specs: ['nl-1-fc-1h', 'nl-1-fc-3h-0', 'nl-1-fc-3h-1', 'nl-1-fc-3h-2'],
    cadence_s: 3600,
    gate: 'hash',
    retention: 'forever',
  },
  'DE-2 WV': { specs: ['de-2-wv'], cadence_s: 3600, gate: 'field', retention: 'forever' },
  'DE-6 LHP': {
    specs: ['de-6-stations', 'de-6-alerts'],
    cadence_s: 600,
    gate: 'hash',
    conditional: 'etag',
    retention: 'forever',
  },
  'FR-4 forecasts': { specs: ['fr-4'], cadence_s: 1800, gate: 'hash', retention: 'forever' },
  'FR-5 vigilance': { specs: ['fr-5-vigilance'], cadence_s: 900, gate: 'field', retention: 'forever' },
  'LU-5 CAP': { specs: ['lu-5-cap'], cadence_s: 300, gate: 'new-resource', retention: 'forever' },
  'CH-1 LINDAS': { specs: ['ch-1-lindas'], cadence_s: 600, gate: 'hash', retention: 'forever' },
  'CH-2': { specs: ['ch-2-pq'], cadence_s: 600, gate: 'hash', conditional: 'last-modified', retention: 'forever' },
  'CH-4': {
    specs: ['ch-4-forecast'],
    cadence_s: 3600,
    gate: 'lastmod-runstart',
    conditional: 'last-modified',
    retention: 'forever',
  },
  'CH-5': { specs: ['ch-5-warn'], cadence_s: 1800, gate: 'hash', retention: 'forever' },
  'NL-4': {
    specs: ['nl-4-page', 'nl-4-xlsx'],
    cadence_s: 604800,
    gate: 'hash',
    conditional: 'last-modified',
    retention: 'forever',
  },
  'DE-1 metadata': { specs: ['de-1-meta'], cadence_s: 86400, gate: 'hash', retention: 'forever' },
  'LU-1 CSV': { specs: ['lu-1-csv'], cadence_s: 900, gate: 'hash', retention: 'obs' },
};

/** The catalogue interval cell as a range of seconds. */
function interval(cell: string): [number, number] {
  const c = strip(cell).toLowerCase();
  const range = /^(\d+)[–-](\d+) min/.exec(c);
  if (range) return [Number(range[1]) * 60, Number(range[2]) * 60];
  const min = /^(\d+) min/.exec(c);
  if (min) return [Number(min[1]) * 60, Number(min[1]) * 60];
  if (c.startsWith('hourly')) return [3600, 3600];
  if (c.startsWith('daily')) return [86400, 86400];
  if (c.startsWith('weekly')) return [604800, 604800];
  throw new Error(`unparsed interval ${cell}`);
}

describe('catalogue §0.1a', () => {
  it.each(table01a.map((r) => [strip(r[0] ?? ''), r] as const))(
    '%s has enabled, first-enabled specs as listed',
    (stream, row) => {
      const want = EXPECTED[stream];
      expect(want, `§0.1a row "${stream}" is not mapped to a spec`).toBeDefined();
      if (want === undefined) return;
      const [lo, hi] = interval(row[2] ?? '');
      for (const id of want.specs) {
        const s = spec(id);
        expect(s.cron, id).not.toBeNull();
        expect(s.first, id).toBe(true);
        expect(s.gate.kind, id).toBe(want.gate);
        if (want.conditional) expect(s.conditional, id).toBe(want.conditional);
        expect(s.retention, id).toBe(want.retention);
        if (stream === 'NL-1 forecasts') continue; // the one deliberate deviation: tiering, asserted below
        expect(s.cadence_s, id).toBe(want.cadence_s);
        expect(s.cadence_s as number, `${id} within the catalogue interval`).toBeGreaterThanOrEqual(lo);
        expect(s.cadence_s as number, `${id} within the catalogue interval`).toBeLessThanOrEqual(hi);
      }
    },
  );

  it('maps every row it knows to a row that still exists (no stale mapping)', () => {
    const streams = table01a.map((r) => strip(r[0] ?? ''));
    expect(Object.keys(EXPECTED).sort()).toEqual([...streams].sort());
  });

  it('FR-5 is gated on DtHrInfoVigiCru and DE-2 on initialized', () => {
    expect(spec('fr-5-vigilance').gate.paths).toContain('DtHrInfoVigiCru');
    expect(spec('de-2-wv').gate.paths).toEqual(['0.initialized']);
  });

  it('has no spec for DE-10 (gated; joins in P13) nor any other off source', () => {
    for (const s of registry.specs) expect(registry.sources.get(s.source)?.audience).not.toBe('off');
    expect(registry.specs.some((s) => s.source === 'DE-10')).toBe(false);
  });

  it('NL-1 forecasts: all 183 H + 13 Q locations exactly once, ≤ 40 hourly, the rest in three 3-hourly buckets', () => {
    const rows = readSeed(REGISTRY_DIR, 'nl-1-forecast');
    const keys = rows.map((r) => `${r.code}/${r.quantity}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(rows.filter((r) => r.quantity === 'H')).toHaveLength(183);
    expect(rows.filter((r) => r.quantity === 'Q')).toHaveLength(13);
    const hourly = rows.filter((r) => r.tier === '1h');
    expect(hourly.length).toBeGreaterThanOrEqual(35);
    expect(hourly.length).toBeLessThanOrEqual(40);
    const buckets = ['3h-0', '3h-1', '3h-2'].map((t) => rows.filter((r) => r.tier === t).length);
    expect(buckets.reduce((a, b) => a + b, 0) + hourly.length).toBe(196);
    expect(Math.max(...buckets) - Math.min(...buckets)).toBeLessThanOrEqual(1);
    expect(spec('nl-1-fc-1h').cadence_s).toBe(3600);
    for (const id of ['nl-1-fc-3h-0', 'nl-1-fc-3h-1', 'nl-1-fc-3h-2']) expect(spec(id).cadence_s).toBe(10800);
    // Every forecast location is covered by exactly one spec.
    const covered = registry.specs
      .filter((s) => s.id.startsWith('nl-1-fc-'))
      .flatMap((s) => s.rows.map((r) => `${r.code}/${r.quantity}`));
    expect(covered.sort()).toEqual([...keys].sort());
  });

  it('LU-3 and LU-4 are in the first-enabled group; forecast, class and threshold payloads are kept forever', () => {
    expect(spec('lu-3-percentile').first).toBe(true);
    expect(spec('lu-4-pages').first).toBe(true);
    for (const id of [
      'lu-3-percentile',
      'lu-4-pages',
      'de-2-wv',
      'de-3-files',
      'fr-5-sections',
      'de-7-pegeldaten',
      'be-3-meta',
    ]) {
      expect(spec(id).retention, id).toBe('forever');
    }
  });
});
