import { describe, expect, it } from 'vitest';
import { budgets } from '../../src/capture/budget.ts';
import { baseRequest } from '../../src/capture/specs.ts';
import { registry, spec } from './helpers.ts';

// Criterion "[CI] The budget config test holds" (issue #16; A§7.3), computed
// from registry/capture.yaml × the seed files, never a constant.

const peak = (host: string) => budgets(registry).find((b) => b.host === host)?.peakPerHour ?? 0;
const perHour = (id: string) => {
  const s = spec(id);
  return (s.rows.length * 3600) / (s.cadence_s as number);
};

describe('request budgets', () => {
  it('RWS: ≤ 400 requests in any 60 minutes (ddapi20-waterwebservices.rijkswaterstaat.nl)', () => {
    const rws = peak('ddapi20-waterwebservices.rijkswaterstaat.nl');
    expect(rws).toBeGreaterThan(300); // the whole tiered set is really counted
    expect(rws).toBeLessThanOrEqual(400);
  });

  it('CH-1 (LINDAS) never runs more often than every 10 min', () => {
    expect(spec('ch-1-lindas').cadence_s).toBeGreaterThanOrEqual(600);
    const ld = registry.specs.filter((s) => new URL(s.request.url).hostname === 'ld.admin.ch');
    expect(ld.map((s) => s.id)).toEqual(['ch-1-lindas']);
    expect(peak('ld.admin.ch')).toBeLessThanOrEqual(6 * spec('ch-1-lindas').rows.length);
  });

  it('DE-6 (LHP) refreshes at least every 10 min', () => {
    for (const id of ['de-6-stations', 'de-6-alerts']) expect(spec(id).cadence_s).toBeLessThanOrEqual(600);
  });

  it('FR-1 seed pages are ≥ 2 s apart', () => {
    expect(spec('fr-1-obs').seed?.kind).toBe('days');
    expect(spec('fr-1-obs').seed?.pace_ms).toBeGreaterThanOrEqual(2000);
  });

  it('Vigicrues: every spec that expands spaces its requests ≥ 2 s, and its longest run fits its deadline (#39)', () => {
    const vigi = registry.specs.filter(
      (s) => s.request.expand && new URL(s.request.url).hostname === 'www.vigicrues.gouv.fr',
    );
    expect(vigi.map((s) => s.id).sort()).toEqual(['fr-4', 'fr-5-sections']);
    for (const s of vigi) {
      const space = s.variants?.space_ms ?? 0;
      expect(space, s.id).toBeGreaterThanOrEqual(2000);
      // Every root plus a full stage 2, spaced, inside the run deadline (0.9 × cadence).
      expect((s.rows.length + s.request.max_expand) * space, s.id).toBeLessThan(0.9 * (s.cadence_s as number) * 1000);
    }
  });

  it('BE-3: ≤ 2 value requests per 10 min plus the daily metadata', () => {
    expect(spec('be-3-values').rows).toHaveLength(2);
    expect(spec('be-3-values').cadence_s).toBe(600);
    expect(spec('be-3-meta').cadence_s).toBe(86400);
    expect(
      registry.specs
        .filter((s) => s.source === 'BE-3')
        .map((s) => s.id)
        .sort(),
    ).toEqual(['be-3-meta', 'be-3-values']);
  });

  it('LU-2 ≤ 39 and LU-3 ≤ 55 requests/hour; LU-4 weekly', () => {
    expect(perHour('lu-2-json')).toBeLessThanOrEqual(39);
    expect(perHour('lu-3-percentile')).toBeLessThanOrEqual(55);
    expect(spec('lu-4-pages').cadence_s).toBe(604800);
  });

  it('no LU request carries a query string, and none fetches an LfU RLP-origin file', () => {
    // LfU RLP-origin data on the AGE site (catalogue §0.8): the LU-2 files of the RLP-operated gauges and the
    // LU-3 Moselle runs RLP computes; the LU-4 pages of the two RLP gauges are not fetched either.
    const rlp: Record<string, RegExp> = {
      'LU-2': /bollendorf|gem(?:u|ü|%C3%BC)nd/i,
      'LU-3': /percentile\/(?:perl|stadtbredimus|wasserbillig)-/i,
      'LU-4': /bollendorf|gemund/i,
    };
    for (const s of registry.specs.filter((x) => ['LU-1', 'LU-2', 'LU-3', 'LU-4'].includes(x.source))) {
      for (const row of s.rows) {
        const url = new URL(baseRequest(s, row).url);
        expect(url.search, url.href).toBe('');
        expect(url.hostname).toBe('inondations.public.lu');
        const rule = rlp[s.source];
        if (rule) expect(url.pathname, url.href).not.toMatch(rule);
      }
    }
    const lu2 = spec('lu-2-json').rows.map((r) => r.file);
    for (const f of ['Bollendorf', 'Gemünd_Our', 'SN_Remich']) expect(lu2).not.toContain(f);
    expect(lu2).toHaveLength(39);
    const lu3 = new Set(spec('lu-3-percentile').rows.map((r) => r.slug));
    for (const f of ['perl', 'stadtbredimus', 'wasserbillig', 'bollendorf']) expect(lu3.has(f)).toBe(false);
    expect(lu3.size).toBe(11);
    expect(spec('lu-3-percentile').rows).toHaveLength(55);
  });

  it('no spec for NL-3, DE-9, DE-10, DE-12, BE-1, BE-2 or any off source', () => {
    const off = [...registry.sources].filter(([, s]) => s.audience === 'off').map(([id]) => id);
    for (const id of ['NL-3', 'DE-9', 'DE-10', 'DE-12', 'BE-1', 'BE-2']) expect(off).toContain(id);
    for (const s of registry.specs) expect(off).not.toContain(s.source);
  });

  it('every owner-audience source with a spec has a private_basis', () => {
    const owners = [...new Set(registry.specs.filter((s) => s.audience === 'owner').map((s) => s.source))].sort();
    expect(owners).toEqual(['BE-3', 'DE-2', 'DE-3', 'LU-2', 'LU-3', 'LU-4']);
    for (const id of owners) expect(registry.sources.get(id)?.private_basis, id).not.toBeNull();
  });
});
