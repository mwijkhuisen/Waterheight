import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Cron } from 'croner';
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { server } from '../../../../test/msw.setup.ts';
import { Pinger } from '../../src/capture/pings.ts';
import { guarded, startRecorder } from '../../src/capture/scheduler.ts';
import { GROUP_SLUGS, type Registry } from '../../src/capture/specs.ts';
import type { SpecState } from '../../src/capture/state.ts';
import { testClient } from '../helpers.ts';
import { fixture, quiet, registry, runDeps, spec } from './helpers.ts';

// Scheduler, pings and healthchecks groups (code-review item 3; the
// contract's 9 slugs).

afterEach(() => {
  vi.useRealTimers();
});

describe('croner in UTC', () => {
  it('fires a 10-minute spec exactly 18 times across the 2026-10-25 DST night (00:00–03:00Z)', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-25T00:00:00Z') });
    const at: string[] = [];
    const job = new Cron('1-59/10 * * * *', { timezone: 'UTC' }, () => {
      at.push(new Date().toISOString().slice(11, 16));
    });
    await vi.advanceTimersByTimeAsync(3 * 3_600_000);
    job.stop();
    expect(at).toEqual(['00', '01', '02'].flatMap((h) => ['01', '11', '21', '31', '41', '51'].map((m) => `${h}:${m}`)));
  });

  it('protect: a slow run blocks the next ticks (counted, never queued), and later ticks keep their times', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-02T12:00:00Z') });
    const started: string[] = [];
    const blocked: string[] = [];
    let first = true;
    const hhmm = () => new Date().toISOString().slice(11, 16);
    const job = new Cron(
      '1-59/10 * * * *',
      { timezone: 'UTC' },
      guarded(
        async () => {
          started.push(hhmm());
          if (first) {
            first = false;
            await new Promise((r) => setTimeout(r, 25 * 60_000)); // a 25-minute run
          }
        },
        () => blocked.push(hhmm()),
      ),
    );
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    job.stop();
    expect(started).toEqual(['12:01', '12:31', '12:41', '12:51']);
    expect(blocked).toEqual(['12:11', '12:21']);
  });

  it("croner's own protect would queue the blocked tick late (why the scheduler guards itself)", async () => {
    vi.useFakeTimers({ now: new Date('2026-10-02T12:00:00Z') });
    const started: string[] = [];
    let first = true;
    const job = new Cron('1-59/10 * * * *', { timezone: 'UTC', protect: true }, async () => {
      started.push(new Date().toISOString().slice(11, 16));
      if (first) {
        first = false;
        await new Promise((r) => setTimeout(r, 25 * 60_000));
      }
    });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    job.stop();
    expect(started).toContain('12:26');
  });
});

describe('recorder', () => {
  const oneSpec = (id: string): Registry => {
    const s = spec(id);
    return { ...registry, specs: [s], groups: registry.groups.filter((g) => g.anchor === id) };
  };

  it('does not run on start, but catches up a tick that was missed while it was down', async () => {
    let calls = 0;
    server.use(
      http.get('https://api.hochwasserzentralen.de/public/v1/data/alerts', () => {
        calls += 1;
        return new HttpResponse(fixture('DE-6', 'de-6-alerts').body);
      }),
    );
    for (const [lastAttempt, expected] of [
      ['2026-10-02T12:08:00.000Z', 0], // the 12:08 tick ran: nothing to catch up
      ['2026-10-02T11:58:00.000Z', 1], // the 12:08 tick was missed
    ] as const) {
      calls = 0;
      vi.useFakeTimers({ now: new Date('2026-10-02T12:09:30Z') });
      const deps = runDeps({ now: () => new Date() });
      await deps.state.update<SpecState>('de-6-alerts', () => ({
        enabled_since: '2026-10-01T00:00:00.000Z',
        last_attempt: lastAttempt,
        variants: {},
        seen: [],
        pending_page: [],
      }));
      const rec = await startRecorder({
        ...deps,
        registry: oneSpec('de-6-alerts'),
        pinger: new Pinger(undefined, 'ua', quiet),
        paths: { rawDir: deps.root, statusDir: `${deps.root}/s`, ownerStatusDir: `${deps.root}/o` },
        seeds: () => [],
      });
      await vi.advanceTimersByTimeAsync(20_000);
      await rec.stop();
      vi.useRealTimers();
      expect(calls, lastAttempt).toBe(expected);
    }
  });

  it('pings the group: /start, then success when fresh, /fail with no body for an owner group', async () => {
    const pings: { path: string; body: string }[] = [];
    server.use(
      http.all('https://hc-ping.com/*', async ({ request }) => {
        pings.push({ path: new URL(request.url).pathname.replace(/^\/[^/]+\//, '/KEY/'), body: await request.text() });
        return HttpResponse.text('OK');
      }),
      http.get(
        'https://api.hochwasserzentralen.de/public/v1/data/alerts',
        () => new HttpResponse(fixture('DE-6', 'de-6-alerts').body),
      ),
      http.get('https://hydrometrie.wallonie.be/services/KiWIS/KiWIS', () => new HttpResponse('down', { status: 503 })),
    );
    const key = 'k'.repeat(22); // a dummy of the right shape
    for (const id of ['de-6-alerts', 'be-3-values']) {
      const deps = runDeps();
      await deps.state.update<SpecState>(id, () => ({
        enabled_since: '2026-01-01T00:00:00.000Z',
        variants: {},
        seen: [],
        pending_page: [],
      }));
      const pinger = new Pinger(key, 'ua', quiet, testClient({ hc: ['hc-ping.com'] }));
      const rec = await startRecorder({
        ...deps,
        registry: {
          ...oneSpec(id),
          groups: [
            {
              ...(registry.groups.find(
                (g) => g.anchor === (id === 'de-6-alerts' ? 'de-6-stations' : id),
              ) as Registry['groups'][number]),
              anchor: id,
            },
          ],
        },
        pinger,
        paths: { rawDir: deps.root, statusDir: `${deps.root}/s`, ownerStatusDir: `${deps.root}/o` },
        seeds: () => [],
      });
      await rec.run(spec(id));
      await rec.stop();
    }
    expect(pings).toEqual([
      { path: '/KEY/cap-de6/start', body: '' },
      { path: '/KEY/cap-de6', body: '' },
      { path: '/KEY/cap-owner/start', body: '' },
      { path: '/KEY/cap-owner/fail', body: '' },
    ]);
  });
});

describe('first start on an empty _state (C3)', () => {
  const key = 'k'.repeat(22); // a dummy of the right shape
  const paths = (root: string) => ({ rawDir: root, statusDir: `${root}/s`, ownerStatusDir: `${root}/o` });

  it('counts a spec that has not run as fresh, and runs a weekly spec once, staggered', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-02T08:00:00Z') });
    const pings: string[] = [];
    let nl4 = 0;
    server.use(
      http.all('https://hc-ping.com/*', ({ request }) => {
        pings.push(new URL(request.url).pathname.replace(/^\/[^/]+\//, '/KEY/'));
        return HttpResponse.text('OK');
      }),
      http.get(
        'https://geo.rijkswaterstaat.nl/services/ogc/hws/DDAPI20/wfs',
        () => new HttpResponse(fixture('NL-2', 'nl-2-wfs').body),
      ),
      http.get('https://rijkswaterstaatdata.nl/waterdata/', () => {
        nl4 += 1;
        return new HttpResponse(fixture('NL-4', 'nl-4-page').body);
      }),
    );
    const deps = runDeps({ now: () => new Date() });
    const group = registry.groups.find((g) => g.slug === 'cap-nl') as Registry['groups'][number];
    const rec = await startRecorder({
      ...deps,
      registry: {
        ...registry,
        specs: [spec('nl-2-wfs'), spec('nl-4-page')],
        groups: [{ ...group, anchor: 'nl-2-wfs', cadence_s: 600 }],
      },
      pinger: new Pinger(key, 'ua', quiet, testClient({ hc: ['hc-ping.com'] })),
      paths: paths(deps.root),
      seeds: () => [],
    });
    await rec.run(spec('nl-2-wfs'));
    // nl-4-page (weekly) has not been attempted yet: fresh, so the group pings success.
    expect(pings).toEqual(['/KEY/cap-nl/start', '/KEY/cap-nl']);
    expect(nl4).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    await rec.stop();
    expect(nl4).toBe(1);
  });

  it('reports owner_specs.fresh = total before any spec has run', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-02T08:00:00Z') });
    const deps = runDeps({ now: () => new Date() });
    const rec = await startRecorder({
      ...deps,
      registry,
      pinger: new Pinger(undefined, 'ua', quiet),
      paths: paths(deps.root),
      seeds: () => [],
    });
    await rec.writeStatusNow();
    await rec.stop();
    const status = JSON.parse(readFileSync(join(deps.root, 's', 'capture.json'), 'utf8')) as {
      owner_specs: { fresh: number; total: number };
    };
    expect(status.owner_specs.total).toBeGreaterThan(0);
    expect(status.owner_specs.fresh).toBe(status.owner_specs.total);
  });
});

describe('healthchecks groups', () => {
  it('are the 9 contract slugs, with no source ID in a name, each with a shortest cadence', () => {
    expect([...GROUP_SLUGS]).toEqual([
      'cap-nl',
      'cap-de-fed',
      'cap-de6',
      'cap-de78',
      'cap-fr',
      'cap-lu',
      'cap-ch',
      'cap-bfg',
      'cap-owner',
    ]);
    for (const g of registry.groups) {
      expect(g.slug).not.toMatch(/(?:nl|de|be|fr|lu|ch)-\d/i);
      expect(g.cadence_s).toBeGreaterThan(0);
    }
    expect(Object.fromEntries(registry.groups.map((g) => [g.slug, g.cadence_s]))).toEqual({
      'cap-nl': 600,
      'cap-de-fed': 900,
      'cap-de6': 600,
      'cap-de78': 3600,
      'cap-fr': 900,
      'cap-lu': 300,
      'cap-ch': 600,
      'cap-bfg': 3600,
      'cap-owner': 600,
    });
    expect(registry.groups.find((g) => g.slug === 'cap-owner')?.sources.sort()).toEqual([
      'BE-3',
      'LU-2',
      'LU-3',
      'LU-4',
    ]);
  });

  it('refuse a malformed ping key and never put the key in a log line', async () => {
    const warnings: unknown[] = [];
    const log = { warn: (...a: unknown[]) => warnings.push(a) };
    expect(new Pinger('short', 'ua', log).enabled).toBe(false);
    expect(new Pinger(undefined, 'ua', log).enabled).toBe(false);
    server.use(http.all('https://hc-ping.com/*', () => new HttpResponse('nope', { status: 404 })));
    const key = 'k'.repeat(22); // a dummy of the right shape
    const p = new Pinger(key, 'ua', log, testClient({ hc: ['hc-ping.com'] }));
    await p.ping('cap-nl', 'fail', 'stale x');
    expect(JSON.stringify(warnings)).not.toContain(key);
    expect(warnings.length).toBeGreaterThan(2);
  });
});
