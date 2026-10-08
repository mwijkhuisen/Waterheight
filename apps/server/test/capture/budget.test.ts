import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { kiwisUrlProblems, MAX_IDS, MAX_VALUES, MIN_STEP_MS } from '../../src/adapters/_shared/kiwis/request.ts';
import { adapter as be3 } from '../../src/adapters/be-3/capture.ts';
import { budgets, requestsPerMinute } from '../../src/capture/budget.ts';
import { baseRequest, variantKey } from '../../src/capture/specs.ts';
import type { Row } from '../../src/http/types.ts';
import { fixture, registry, spec } from './helpers.ts';

// Criterion "[CI] The budget config test holds" (issue #16; A§7.3), computed
// from registry/capture.yaml × the seed files, never a constant.

const peak = (host: string) => budgets(registry).find((b) => b.host === host)?.peakPerHour ?? 0;
const perHour = (id: string) => {
  const s = spec(id);
  return (s.rows.length * 3600) / (s.cadence_s as number);
};

/** The `environment` of one service of deploy/compose.yaml, parsed (a comment there names RWS_PRUNE_APPLY=1: never grep). */
function composeEnv(service: string): Record<string, string> {
  const doc = parse(readFileSync(new URL('../../../../deploy/compose.yaml', import.meta.url), 'utf8')) as {
    services: Record<string, { environment?: Record<string, unknown> | string[] }>;
  };
  const env = doc.services[service]?.environment;
  expect(env, `compose service ${service} has an environment`).toBeDefined();
  const pairs = Array.isArray(env)
    ? env.map((e): [string, string] => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)])
    : Object.entries(env ?? {}).map(([k, v]): [string, string] => [k, String(v)]);
  return Object.fromEntries(pairs);
}

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

  it('CH-4 (#78): the 54 forecast stations split by figure, 41 on q_forecast and the 13 lakes on p_forecast, once an hour each', () => {
    const q = spec('ch-4-forecast');
    const p = spec('ch-4-forecast-lake');
    expect([q.rows.length, p.rows.length]).toEqual([41, 13]);
    const ids = (s: typeof q) => s.rows.map((r) => variantKey(r, s.variants?.key));
    expect(new Set([...ids(q), ...ids(p)]).size).toBe(54);
    expect(ids(q)).toContain('2646');
    expect(ids(p)).toEqual([
      '2004',
      '2022',
      '2023',
      '2027',
      '2032',
      '2043',
      '2093',
      '2101',
      '2118',
      '2207',
      '2208',
      '2209',
      '2642',
    ]);
    expect(baseRequest(p, p.rows.find((r) => r.id === '2209') as Row).url).toBe(
      'https://www.hydrodaten.admin.ch/plots/p_forecast/2209_p_forecast_de.json',
    );
    expect(baseRequest(q, q.rows[0] as Row).url).toBe(
      'https://www.hydrodaten.admin.ch/plots/q_forecast/2009_q_forecast_de.json',
    );
    expect([q.cadence_s, p.cadence_s]).toEqual([3600, 3600]);
    expect(perHour('ch-4-forecast') + perHour('ch-4-forecast-lake')).toBe(54);
  });

  it('DE-6 (LHP) refreshes at least every 10 min', () => {
    for (const id of ['de-6-stations', 'de-6-alerts']) expect(spec(id).cadence_s).toBeLessThanOrEqual(600);
  });

  it('FR-1 seed pages are ≥ 2 s apart', () => {
    expect(spec('fr-1-obs').seed?.kind).toBe('days');
    expect(spec('fr-1-obs').seed?.pace_ms).toBeGreaterThanOrEqual(2000);
  });

  it('FR-3 twins (P5a): Chooz H and Uckange Q every 6 h, 2 s apart, 8 requests a day', () => {
    const s = spec('fr-3-twin');
    expect(s.rows.map((r) => variantKey(r, s.variants?.key))).toEqual(['B720000001/H', 'A850061001/Q']);
    expect(s.cadence_s).toBe(6 * 3600);
    expect(s.variants?.space_ms).toBeGreaterThanOrEqual(2000);
    expect(perHour('fr-3-twin') * 24).toBe(8);
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

  it('BE-3: ≤ 2 value requests per 10 min plus the daily metadata and the weekly references', () => {
    expect(spec('be-3-values').rows).toHaveLength(2);
    expect(spec('be-3-values').cadence_s).toBe(600);
    expect(spec('be-3-meta').cadence_s).toBe(86400);
    expect(
      registry.specs
        .filter((s) => s.source === 'BE-3')
        .map((s) => s.id)
        .sort(),
    ).toEqual(['be-3-catchup', 'be-3-meta', 'be-3-refs', 'be-3-values']);
  });

  it('BE-3 references (P7a): weekly, one list plus at most 45 values calls 5 s apart, inside the run deadline', () => {
    const s = spec('be-3-refs');
    expect(s.cadence_s).toBe(7 * 86400);
    expect(s.rows).toHaveLength(1);
    expect(s.request.max_expand).toBe(45);
    expect(s.variants?.space_ms).toBeGreaterThanOrEqual(5000);
    // (1 list + 45 calls) × 5 s is under four minutes a week: 46 requests a week at the most.
    expect((s.rows.length + s.request.max_expand) * (s.variants?.space_ms ?? 0)).toBeLessThan(
      0.9 * (s.cadence_s as number) * 1000,
    );
    expect(s.rows.length + s.request.max_expand).toBeLessThanOrEqual(46);
  });

  it('BE-3 catch-up (P5c): seed only, off-peak, 5 s apart, from the display start, KiWIS call limits', () => {
    const s = spec('be-3-catchup');
    expect([s.cron, s.seed?.kind, s.seed?.from, s.seed?.utc_hours]).toEqual([
      null,
      'once',
      '2026-08-24T00:00:00Z',
      [0, 5],
    ]);
    expect(s.seed?.pace_ms).toBeGreaterThanOrEqual(5000);
    expect(s.variants?.space_ms).toBeGreaterThanOrEqual(5000);
    expect(s.rows.map((r) => r.group)).toEqual(['1962373', '1962340']);
    // Every call the expand builds over the longest window this release can have stays within the KiWIS limits.
    const list = JSON.parse(fixture('BE-3', 'be-3-catchup').body.toString('utf8')) as unknown[];
    const many = [
      list[0],
      ...Array.from({ length: 330 }, (_, i) => [`${i}`, 'x', `${100000 + i}`, 'p', 'H', 'm', 'DGH', '']),
    ];
    const window = { from: new Date('2026-08-24T00:00:00Z'), to: new Date('2027-01-01T00:00:00Z') };
    const { reqs } = be3.expand?.({
      req: baseRequest(s, s.rows[0] as Row),
      doc: many,
      now: window.to,
      seen: new Set(),
      seed: true,
      window,
      checkUrl: (raw) => raw,
    }) ?? { reqs: [] };
    // 130 days: three batches of 100 in one-day calls, and the last 30 series in five-day calls (26).
    expect(reqs.length).toBe(3 * 130 + 26);
    expect(reqs.length).toBeLessThanOrEqual(s.request.max_expand);
    for (const r of reqs) {
      const u = new URL(r.url);
      expect(u.hostname).toBe('hydrometrie.wallonie.be');
      expect((u.searchParams.get('ts_id') ?? '').split(',').length).toBeLessThanOrEqual(MAX_IDS);
      const span = Date.parse(u.searchParams.get('to') ?? '') - Date.parse(u.searchParams.get('from') ?? '');
      expect((u.searchParams.get('ts_id') ?? '').split(',').length * (span / MIN_STEP_MS + 1)).toBeLessThanOrEqual(
        MAX_VALUES,
      );
      expect(kiwisUrlProblems(r.url)).toEqual([]);
    }
  });

  it('every KiWIS URL of the registry asks in UTC, without a wildcard or the frontend services (catalogue §2.4)', () => {
    for (const s of registry.specs.filter((x) => x.source === 'BE-3'))
      for (const row of s.rows) expect([s.id, kiwisUrlProblems(baseRequest(s, row).url)]).toEqual([s.id, []]);
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

  it('DE-7 (P5b): every 15 minutes exactly when the retention pruner is applied, else hourly', () => {
    // 96 fetches a day of the 0.9 MB ZIP need the pruner to delete what the 90-day window drops: the two switches
    // (RWS_PRUNE_APPLY=1 on the load service of deploy/compose.yaml, the cron of de-7-messwerte) flip together.
    const env = composeEnv('load');
    expect(env.RWS_RAW_DIR, 'the parse reads the load service').toBe('/data/raw');
    const apply = env.RWS_PRUNE_APPLY === '1';
    const s = spec('de-7-messwerte');
    expect(s.rows).toHaveLength(1);
    expect(s.cadence_s, apply ? 'pruner applied: DE-7 every 15 minutes' : 'pruner dry run: DE-7 hourly').toBe(
      apply ? 900 : 3600,
    );
    if (!apply) expect(s.cron).toBe('50 * * * *');
    // The weekly pegeldaten and the seed are not on this switch.
    expect(spec('de-7-pegeldaten').cadence_s).toBe(604800);
  });

  it('DE-8 (P5b): the hydro file is weekly, and www.opengeodata.nrw.de gets at most 2 requests in any 24 hours', () => {
    expect(spec('de-8-hydro').cadence_s).toBe(604800);
    expect(spec('de-8-hydro').rows).toHaveLength(1);
    expect(spec('de-8-stations').cadence_s).toBe(86400);
    const specs = registry.specs.filter((x) => new URL(x.request.url).hostname === 'www.opengeodata.nrw.de');
    expect(specs.map((x) => x.id).sort()).toEqual(['de-8-hydro', 'de-8-stations']);
    const minutes = requestsPerMinute(registry).get('www.opengeodata.nrw.de');
    expect(minutes).toBeDefined();
    // The busiest sliding 24 h of the simulated week, wrapped around Sunday to Monday.
    const week = minutes?.length ?? 0;
    let window = 0;
    let peak = 0;
    for (let i = 0; i < week + 1440; i += 1) {
      window += minutes?.[i % week] ?? 0;
      if (i >= 1440) window -= minutes?.[(i - 1440) % week] ?? 0;
      peak = Math.max(peak, window);
    }
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(2);
    expect(budgets(registry).find((b) => b.host === 'www.opengeodata.nrw.de')?.perWeek).toBe(8);
  });

  it('inondations.public.lu: no request of any spec carries a query string (its robots.txt says Disallow: /*?*)', () => {
    const age = registry.specs.filter(
      (x) => new URL(baseRequest(x, x.rows[0] ?? {}).url).hostname === 'inondations.public.lu',
    );
    expect(age.map((x) => x.source)).toContain('LU-1');
    for (const s of age)
      for (const row of s.rows) {
        const url = baseRequest(s, row).url;
        expect(url, s.id).not.toContain('?');
        expect(new URL(url).search, s.id).toBe('');
      }
    // LU-6 is a geoportail.lu feature service (it needs ?f=json&limit=100), not the AGE site.
    expect(new URL(spec('lu-6-geo').request.url).hostname).toBe('features.geoportail.lu');
    expect(registry.hosts.get('LU-6')).toEqual(['features.geoportail.lu']);
    expect(registry.hosts.get('LU-1')).toEqual(['inondations.public.lu']);
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
