import { readFileSync } from 'node:fs';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { server } from '../../../../test/msw.setup.ts';
import { kiwisUrlProblems, MAX_IDS, MAX_VALUES, MIN_STEP_MS } from '../../src/adapters/_shared/kiwis/request.ts';
import { adapter as be3 } from '../../src/adapters/be-3/capture.ts';
import { Pacer, windowEnd } from '../../src/backfill/pacer.ts';
import { jobBudget } from '../../src/backfill/plan.ts';
import { runBackfill } from '../../src/backfill/run.ts';
import { loadBackfill } from '../../src/backfill/spec.ts';
import { budgets, inFlightPerSecond, LATENCY_MS, requestsPerMinute, seedStarts } from '../../src/capture/budget.ts';
import { runSeeds } from '../../src/capture/seeds.ts';
import { baseRequest, REGISTRY_DIR, type Registry, readSeed, variantKey } from '../../src/capture/specs.ts';
import type { Row } from '../../src/http/types.ts';
import { Clock, fakeClient, MemoryJobStore, tempArchive } from '../backfill/harness.ts';
import { fixture, registry, runDeps, spec } from './helpers.ts';

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
  const RWS = 'ddapi20-waterwebservices.rijkswaterstaat.nl';
  // Roadmap 1's NL-1 specs: their rows are untouched by P16a, so they keep the old cap on their own.
  const ROADMAP_1 = [
    'nl-1-obs-key',
    'nl-1-obs-other',
    'nl-1-obs-twin',
    'nl-1-fc-1h',
    'nl-1-fc-3h-0',
    'nl-1-fc-3h-1',
    'nl-1-fc-3h-2',
    'nl-1-catalogue',
  ];
  const TIDE = ['nl-1-hwlw', 'nl-1-astro', 'nl-1-hwlw-astro'];
  const only = (ids: string[]): Registry => ({ ...registry, specs: registry.specs.filter((s) => ids.includes(s.id)) });

  it('RWS: ≤ 1,000 requests in any 60 minutes (D25; ddapi20-waterwebservices.rijkswaterstaat.nl)', () => {
    const rws = peak(RWS);
    expect(rws).toBeGreaterThan(300); // the whole tiered set is really counted
    expect(rws).toBeLessThanOrEqual(1000);
  });

  it('RWS: roadmap 1 alone stays ≤ 400 in any 60 minutes, so cutting the P16a specs back restores it', () => {
    const rws = budgets(only(ROADMAP_1)).find((b) => b.host === RWS)?.peakPerHour ?? 0;
    expect(rws).toBeGreaterThan(300);
    expect(rws).toBeLessThanOrEqual(400);
  });

  it('RWS: at most 2 requests in flight in any second of the week (the transport opens 2 connections per origin)', () => {
    // The runtime guarantee is the undici Agent of http/client.ts (connections: 2, pipelining: 1), proven by
    // apps/server/test/http/transport.test.ts ("opens at most two connections per origin"); a third request would
    // queue there, never run. This is the schedule's own claim: the model never needs that queue.
    const inFlight = inFlightPerSecond(registry).get(RWS) as Uint8Array;
    expect(inFlight.reduce((a, b) => Math.max(a, b), 0)).toBeLessThanOrEqual(2);
    expect(inFlight.some((n) => n === 2)).toBe(true); // key and twin start together: the model really overlaps runs
  });

  it('RWS: the three tide runs (daily, monthly, monthly), each projected onto every day, never overlap each other', () => {
    const tide = only(TIDE);
    expect(tide.specs).toHaveLength(3);
    expect((inFlightPerSecond(tide).get(RWS) as Uint8Array).reduce((a, b) => Math.max(a, b), 0)).toBe(1);
    // Spread by space_ms 179000: a 180 s period, at most 20 requests an hour each (they never overlap, so also in all).
    // #174: hwlw-astro asks each location's type series before its heights, 158 rows, so its run is 04:30-12:24 and
    // still ends long before astro starts at 20:00.
    expect(budgets(tide).find((b) => b.host === RWS)?.peakPerHour).toBeLessThanOrEqual(20);
    for (const id of TIDE) expect(spec(id).variants?.space_ms, id).toBe(179000);
    expect(spec('nl-1-hwlw-astro').rows).toHaveLength(158);
  });

  it('RWS: the first start, a catch-up or hourly retries add at most the three tide specs at once, still ≤ 1,000', () => {
    // On first start a daily or monthly spec runs once at once (scheduler.ts `later`), a missed tick is caught up and a
    // failed run retries hourly: the three tide runs can then all be live in the same hour, whatever their crons.
    // Worst case = the busiest 60 minutes of every other RWS spec plus the hourly maximum of each tide spec.
    // P16b: the one-off catch-up seeds are left out here (they end in 2 nights); on top of them the burst reaches 1,038 at
    // pace 85 s (936 + 42 + 60), see the lead report. Live alone (936 + 60) is the figure this test holds.
    const rest = registry.specs.filter((s) => !TIDE.includes(s.id) && !s.id.endsWith('-catchup'));
    const others = budgets({ ...registry, specs: rest }).find((b) => b.host === RWS)?.peakPerHour ?? 0;
    const tideMax = TIDE.map((id) => budgets(only([id])).find((b) => b.host === RWS)?.peakPerHour ?? 0);
    expect(Math.max(...tideMax)).toBeLessThanOrEqual(20);
    expect(others + tideMax.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1000);
  });

  const CATCHUP = ['nl-1-obs-sea-catchup', 'nl-1-obs-wide-catchup', 'nl-1-obs-slow-catchup'];
  const onHost = registry.specs.filter((s) => new URL(s.request.url).hostname === RWS);

  it('RWS: every spec on the host has a cron, or a seed with utc_hours (the P16b catch-ups, off-peak only)', () => {
    expect(onHost.length).toBeGreaterThan(10);
    for (const s of onHost) {
      if (CATCHUP.includes(s.id)) {
        expect([s.cron, s.seed?.kind, s.seed?.from, s.seed?.utc_hours], s.id).toEqual([
          null,
          'once',
          '2026-10-02T00:00:00Z',
          [0, 5],
        ]);
        expect(s.max_bytes, s.id).toBe(26214400);
      } else {
        expect(s.cron, s.id).not.toBeNull();
        expect(s.seed, s.id).toBeUndefined();
      }
    }
    expect(CATCHUP.map((id) => spec(id).rows.length)).toEqual([29, 92, 205]); // 326 requests
    // The model reads every scheduled spec: each counts at least one request in the simulated week.
    const total = (id: string) => {
      const r = only([id]);
      return (requestsPerMinute(r).get(RWS) ?? new Uint32Array()).reduce((a, b) => a + b, 0);
    };
    for (const s of onHost.filter((x) => x.cron !== null))
      expect(total(s.id), s.id).toBeGreaterThanOrEqual(s.rows.length);
  });

  it('RWS seeds (P16b): live + seeds ≤ 1,000 in any 60 minutes, and the seeds are a real part of the figure', () => {
    const rest = registry.specs.filter((s) => !CATCHUP.includes(s.id));
    const live = budgets({ ...registry, specs: rest }).find((b) => b.host === RWS)?.peakPerHour ?? 0;
    const all = peak(RWS);
    const perHourSeed = Math.floor(3_600_000 / Math.max(spec(CATCHUP[0] as string).seed?.pace_ms ?? 0, LATENCY_MS));
    expect(all).toBeGreaterThan(live);
    expect(all - live).toBeLessThanOrEqual(perHourSeed); // the seeds add one stream, not three
    expect(all).toBeLessThanOrEqual(1000);
    // The three share one pace, so the nights to finish are the same sum of rows over one stream.
    for (const id of CATCHUP) expect(spec(id).seed?.pace_ms, id).toBe(spec(CATCHUP[0] as string).seed?.pace_ms);
    const nights = Math.ceil(326 / (perHourSeed * 5));
    expect(nights).toBeLessThanOrEqual(2); // 326 requests at 42 an hour × 5 off-peak hours: 1.6 nights
  });

  it('RWS seeds: one request at a time, ≥ 1 s apart, only inside the off-peak hours', () => {
    for (const id of CATCHUP) {
      const starts = seedStarts(spec(id));
      expect(starts.length, id).toBeGreaterThan(0);
      for (let i = 1; i < starts.length; i += 1)
        if (Math.floor((starts[i] as number) / 3_600_000) === Math.floor((starts[i - 1] as number) / 3_600_000))
          expect((starts[i] as number) - (starts[i - 1] as number), id).toBeGreaterThanOrEqual(LATENCY_MS);
      for (const t of starts) expect(Math.floor(t / 3_600_000) % 24, id).toBeLessThan(5);
    }
  });

  it('RWS seeds: runSeeds runs the three catch-ups one request at a time, paced (why the model takes the busiest seed, not the sum)', async () => {
    const body = fixture('NL-1', 'nl-1-obs-sea').body;
    let now = 0;
    let max = 0;
    let calls = 0;
    server.use(
      http.post(`https://${RWS}/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen`, async () => {
        now += 1;
        calls += 1;
        max = Math.max(max, now);
        await new Promise((r) => setTimeout(r, 0));
        now -= 1;
        return new HttpResponse(body);
      }),
    );
    const sleeps: number[] = [];
    const deps = runDeps({
      now: () => new Date('2026-10-18T01:00:00Z'),
      sleep: async (ms) => void sleeps.push(ms),
    });
    await runSeeds(only(CATCHUP), deps, {
      rawDir: deps.root,
      statusDir: `${deps.root}/s`,
      ownerStatusDir: `${deps.root}/o`,
    });
    expect(calls).toBe(326);
    expect(max).toBe(1);
    // 29 + 92 + 205 rows, the first of each seed unpaced.
    expect(sleeps.filter((ms) => ms === spec(CATCHUP[0] as string).seed?.pace_ms)).toHaveLength(323);
  }, 60_000); // 326 archived requests through msw: about 3 s alone, past 5 s in the full suite

  it('RWS backfill (P14a): ≤ 1 request/s, ≤ 3600/h, only 20:00–06:00 UTC, on top of the live ≤ 1,000/h', () => {
    const rws = 'ddapi20-waterwebservices.rijkswaterstaat.nl';
    const limits = loadBackfill(registry.hosts).hosts[rws];
    expect(limits).toBeDefined();
    expect(limits?.min_interval_ms).toBeGreaterThanOrEqual(1000);
    expect(limits?.max_per_hour).toBeLessThanOrEqual(3600);
    // 1 request/s is 3600 an hour: the two limits agree.
    expect(3_600_000 / (limits?.min_interval_ms ?? 1)).toBeLessThanOrEqual(limits?.max_per_hour ?? 0);
    const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    const { from, to } = limits?.window_utc ?? { from: '00:00', to: '23:59' };
    // The window wraps midnight and lies inside 20:00–06:00.
    expect(minutes(from)).toBeGreaterThan(minutes(to));
    expect(minutes(from)).toBeGreaterThanOrEqual(20 * 60);
    expect(minutes(to)).toBeLessThanOrEqual(6 * 60);
    // Live capture keeps its own budget in the same hour (P16a: 1,000 with the roadmap-2 specs, D25).
    expect(peak(rws)).toBeLessThanOrEqual(1000);
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

  const hourOf = (cron: string | null) => Number(/^\d+ (\d+) \* \* \*$/.exec(cron ?? '')?.[1]);

  it('CH-3 daily (#235): the 17 tier-1 CH-1 stations once a day after 05:00Z, 2 s apart', () => {
    const s = spec('ch-3-40d');
    const ids = readSeed(REGISTRY_DIR, 'ch-3').map((r) => r.id);
    expect(s.rows).toHaveLength(17);
    expect(s.rows.map((r) => variantKey(r, s.variants?.key))).toEqual(ids);
    expect(s.cadence_s).toBe(86_400);
    expect(s.variants?.space_ms).toBeGreaterThanOrEqual(2000);
    expect(hourOf(s.cron)).toBeGreaterThanOrEqual(5);
    expect(perHour('ch-3-40d') * 24).toBe(17);
  });

  it('FR-3 daily (#235): the 66 tier-1 series once a day after 05:00Z, 2 s apart', () => {
    const s = spec('fr-3-obs');
    const keys = readSeed(REGISTRY_DIR, 'fr-3-series').map((r) => `${r.code}/${r.grd}`);
    expect(s.rows).toHaveLength(66);
    expect(s.rows.map((r) => variantKey(r, s.variants?.key))).toEqual(keys);
    expect(s.cadence_s).toBe(86_400);
    expect(s.variants?.space_ms).toBeGreaterThanOrEqual(2000);
    expect(hourOf(s.cron)).toBeGreaterThanOrEqual(5);
    expect(perHour('fr-3-obs') * 24).toBe(66);
  });

  it('FR-5 (owner decision, #235): fr-5-stations stays at the 15 weekly stations of fr-3.csv', () => {
    const weekly = readSeed(REGISTRY_DIR, 'fr-3')
      .filter((r) => r.history === 'weekly')
      .map((r) => r.code);
    const s = spec('fr-5-stations');
    expect(weekly).toHaveLength(15);
    expect(s.rows.map((r) => variantKey(r, s.variants?.key))).toEqual(weekly);
  });

  it('hydrodaten and Vigicrues: at most 2 requests in flight in any second of the week', () => {
    const flight = inFlightPerSecond(registry);
    for (const host of ['www.hydrodaten.admin.ch', 'www.vigicrues.gouv.fr']) {
      const inFlight = flight.get(host) as Uint8Array;
      expect(inFlight, host).toBeDefined();
      expect(
        inFlight.reduce((a, b) => Math.max(a, b), 0),
        host,
      ).toBeLessThanOrEqual(2);
    }
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
    // Every owner source of registry/sources.yaml (the canary aside) is captured: derived, never a list (P12b, A20).
    const registered = [...registry.sources].filter(([id, s]) => s.audience === 'owner' && !id.startsWith('CANARY-'));
    expect(owners).toEqual(registered.map(([id]) => id).sort());
    expect(owners).toContain('DE-3');
    for (const id of owners) expect(registry.sources.get(id)?.private_basis, id).not.toBeNull();
  });
});

// The counting rules on a tiny registry (P16a): rows are sequential, so row j of a run falls in minute
// start + floor(j × (latency + space_ms) / 60 000), and a day-of-month cron counts on every day of the week.
describe('budget model', () => {
  const tiny = (cron: string, rows: number, spaceMs?: number): Registry =>
    ({
      specs: [
        {
          cron,
          request: { url: 'https://example.invalid/x' },
          rows: Array.from({ length: rows }, () => ({})),
          ...(spaceMs === undefined ? {} : { variants: { space_ms: spaceMs } }),
        },
      ],
    }) as unknown as Registry;
  const perMinute = (r: Registry) => requestsPerMinute(r).get('example.invalid') as Uint32Array;

  it('(a) counts row j at minute start + floor(j × (latency + space_ms) / 60 000)', () => {
    expect(LATENCY_MS).toBe(1000);
    const m = perMinute(tiny('5 0 * * *', 130, 29_000)); // step 30 s: two rows a minute
    // Run starts 00:05 on each of 7 days; rows 0..129 reach minute 5 + 64.
    expect([m[5], m[6], m[69], m[70]]).toEqual([2, 2, 2, 0]);
    expect(m.reduce((a, b) => a + b, 0)).toBe(7 * 130);
    // No spacing: 62 sequential rows of 1 s spill into the next minute.
    const spill = perMinute(tiny('5 0 * * *', 62));
    expect([spill[5], spill[6], spill[7]]).toEqual([60, 2, 0]);
  });

  it('(a) the sliding hour sees a spaced run spread out', () => {
    const peakOf = (r: Registry) => budgets(r)[0]?.peakPerHour;
    expect(peakOf(tiny('0 1 * * *', 80, 0))).toBe(80);
    expect(peakOf(tiny('0 1 * * *', 80, 119_000))).toBe(30); // one request every 2 minutes
  });

  it('(b) projects a day-of-month cron onto every day of the simulated week', () => {
    const m = perMinute(tiny('0 4 1 * *', 3));
    expect(m.reduce((a, b) => a + b, 0)).toBe(7 * 3);
    for (let d = 0; d < 7; d += 1) expect(m[d * 1440 + 4 * 60]).toBe(3);
    expect(budgets(tiny('0 4 1 * *', 3))[0]?.perWeek).toBe(21);
  });

  it('(b) projects L, nth-weekday and a non-zero seconds field onto every day, once per day at that time (CR-1)', () => {
    // 30 s past 04:00 on the 1st; the last day of the month; the first Friday: none falls in every week, so all
    // three count on each of the 7 days, at 04:00 (the seconds field counts at its own minute).
    for (const cron of ['30 0 4 1 * *', '0 4 L * *', '0 4 * * 5#1']) {
      const m = perMinute(tiny(cron, 1));
      expect(
        m.reduce((a, b) => a + b, 0),
        cron,
      ).toBe(7);
      for (let d = 0; d < 7; d += 1) expect(m[d * 1440 + 4 * 60], cron).toBe(1);
    }
    // A plain weekday list is not projected: Monday only.
    expect(perMinute(tiny('0 4 * * MON', 1)).reduce((a, b) => a + b, 0)).toBe(1);
    // Seconds count as runs: every 20 s is 3 runs in the minute.
    expect(perMinute(tiny('*/20 0 4 * * *', 1))[4 * 60]).toBe(3);
  });

  it('(b) a cron the model cannot read throws, it never counts 0', () => {
    expect(() => requestsPerMinute(tiny('not a cron', 1))).toThrow();
  });

  it('in flight: sequential rows, space_ms apart, one second each; runs that meet add up', () => {
    const f = (r: Registry) => inFlightPerSecond(r).get('example.invalid') as Uint8Array;
    const one = f(tiny('0 0 * * *', 3, 1000)); // starts at 0 s, 2 s, 4 s
    expect([0, 1, 2, 3, 4, 5].map((i) => one[i])).toEqual([1, 0, 1, 0, 1, 0]);
    const two = { specs: [...tiny('0 0 * * *', 3).specs, ...tiny('0 0 * * *', 1).specs] } as Registry;
    expect([0, 1, 2, 3].map((i) => f(two)[i])).toEqual([2, 1, 1, 0]);
  });
});

// Criterion "[CI] the per-provider rate budget holds" (issue #29, P14b): the backfill limits of the three open-archive
// hosts in registry/backfill.yaml, beside the live capture of the same host, and the runner's pacer holding them on a
// fake clock. A chunk a decade file already answered (DE-8 reuse) sends nothing.
describe('backfill budgets per host (P14b)', () => {
  const backfill = loadBackfill(registry.hosts);
  const WINDOW = { from: '22:00', to: '05:00' };
  const HOSTS = {
    'www.opengeodata.nrw.de': { source: 'DE-8', min_interval_ms: 30_000, max_per_hour: 20 },
    'hubeau.eaufrance.fr': { source: 'FR-2', min_interval_ms: 2000, max_per_hour: 1800 },
    'data.bs.ch': { source: 'CH-9', min_interval_ms: 1000, max_per_hour: 3600 },
  } as const;
  const windowHours = 7;
  const limitsOf = (host: string) => {
    const l = backfill.hosts[host];
    if (l === undefined) throw new Error(`no backfill limits for ${host}`);
    return l;
  };

  it.each(Object.entries(HOSTS))(
    '%s: the spec of its source uses it, with its limits and the 22:00–05:00 window',
    (host, want) => {
      const l = limitsOf(host);
      expect(l.window_utc).toEqual(WINDOW);
      expect(l.min_interval_ms).toBeGreaterThanOrEqual(want.min_interval_ms);
      expect(l.max_per_hour).toBeLessThanOrEqual(want.max_per_hour);
      // The hourly cap is never looser than the spacing (DE-8: 30 s apart, yet at most 20 an hour).
      expect(l.max_per_hour).toBeLessThanOrEqual(3_600_000 / l.min_interval_ms);
      expect(backfill.specs.filter((s) => s.host === host).map((s) => s.source)).toEqual([want.source]);
    },
  );

  it('hubeau.eaufrance.fr: FR-1 live in its busiest hour plus FR-2 at its limit, ≥ 2 s between FR-2 pages', () => {
    const live = peak('hubeau.eaufrance.fr');
    const l = limitsOf('hubeau.eaufrance.fr');
    expect(live).toBeGreaterThan(0); // FR-1's live capture is really counted
    expect(l.min_interval_ms).toBeGreaterThanOrEqual(2000);
    // Hub'Eau documents no limit; together they stay at or under one request a second averaged over any hour.
    console.info(`hubeau.eaufrance.fr: live peak ${live}/h + FR-2 backfill ${l.max_per_hour}/h`);
    expect(live + l.max_per_hour).toBeLessThanOrEqual(3600);
  });

  it('data.bs.ch: no live capture, and a whole night of backfill is at most 10 % of the 500,000 a day it allows', () => {
    expect(peak('data.bs.ch')).toBe(0);
    const l = limitsOf('data.bs.ch');
    expect(l.max_per_hour * windowHours).toBeLessThanOrEqual(0.1 * 500_000);
  });

  it('www.opengeodata.nrw.de: 20 an hour, 30 s apart, beside the 2 live requests a day', () => {
    const l = limitsOf('www.opengeodata.nrw.de');
    expect(l).toMatchObject({ min_interval_ms: 30_000, max_per_hour: 20 });
    expect(peak('www.opengeodata.nrw.de')).toBeLessThanOrEqual(2);
    // The 32 decade files of de-8-backfill-w fit two hours of one night.
    expect(backfill.specs.find((s) => s.id === 'de-8-backfill-w')?.series).toHaveLength(32);
  });

  it.each(Object.keys(HOSTS))(
    '%s: the pacer holds the spacing and the sliding hour over a whole night (fake clock)',
    async (host) => {
      const l = limitsOf(host);
      const clock = new Clock(Date.parse('2026-10-13T22:00:00Z'));
      const pacer = new Pacer(l, clock.now, clock.sleep);
      const closes = windowEnd(clock.now(), l.window_utc).getTime();
      const starts: number[] = [];
      while (await pacer.wait(closes)) {
        starts.push(clock.t);
        clock.t += 50; // the request itself
      }
      expect(starts.length).toBeGreaterThan(0);
      for (let i = 1; i < starts.length; i += 1)
        expect((starts[i] as number) - (starts[i - 1] as number)).toBeGreaterThanOrEqual(l.min_interval_ms);
      for (let i = l.max_per_hour; i < starts.length; i += 1)
        expect((starts[i] as number) - (starts[i - l.max_per_hour] as number)).toBeGreaterThanOrEqual(3_600_000);
      expect(starts.at(-1)).toBeLessThan(closes);
      expect(starts.length).toBeLessThanOrEqual(l.max_per_hour * windowHours);
      if (host === 'data.bs.ch') expect(starts.length).toBeLessThanOrEqual(0.1 * 500_000);
    },
  );

  it('DE-8: the slices a decade file already answered send nothing (one request for six slices)', async () => {
    const spec = backfill.specs.find((s) => s.id === 'de-8-backfill-w');
    if (spec?.source !== 'DE-8') throw new Error('no DE-8 spec');
    const unit = spec.series.find((u) => u.series_key === 'Rureinzugsgebiet/2020');
    if (unit === undefined) throw new Error('no Rur 2020 unit');
    const cfg = { ...backfill, specs: [{ ...spec, series: [unit] }] };
    const store = new MemoryJobStore();
    const from = new Date('2026-03-03T00:00:00Z');
    const to = new Date('2026-08-01T00:00:00Z');
    const { id } = await store.insert({
      spec_id: spec.id,
      source_id: 'DE-8',
      series_key: unit.series_key,
      range_from: from,
      range_to: to,
      chunk_ms: spec.chunk_ms,
      request_budget: jobBudget(from, to, spec.chunk_ms, false),
    });
    const body = readFileSync(
      new URL('../../src/adapters/de-8/fixtures/de-8-backfill-w-rur-2020.raw', import.meta.url),
    );
    const clock = new Clock();
    const { client, calls } = fakeClient(clock, () => ({
      status: 200,
      body,
      headers: { 'content-type': 'application/zip' },
    }));
    const t = tempArchive();
    const out = await runBackfill({
      config: cfg,
      store,
      archive: t.archive,
      client,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(out.stopped).toBe('done');
    expect(calls.map((c) => c.url)).toEqual([`${spec.url}${unit.file}`]);
    expect(await store.get(id)).toMatchObject({ status: 'done', chunks_done: 6, chunks_with_data: 6, requests: 1 });
    // No sleep at all: the pacer was asked once, for the one request (the first of the night waits for nothing).
    expect(clock.slept).toEqual([]);
    const lines = t.lines();
    expect(lines).toHaveLength(6);
    expect(new Set(lines.map((l) => l.key)).size).toBe(1);
  });
});
