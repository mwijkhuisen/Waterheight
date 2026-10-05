import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../../../test/msw.setup.ts';
import { Pinger } from '../../src/capture/pings.ts';
import { EXIT_CONFIG } from '../../src/main.ts';
import {
  CHECKS,
  check,
  type Got,
  liveProbe,
  type Probe,
  report,
  runWatchdog,
  type Verdicts,
} from '../../src/watchdog/watchdog.ts';
import { testClient } from '../helpers.ts';

// The watchdog role (issue #16 P1b build item 8): public-URL probe, capture.json
// and ops.json freshness, backup age, certificate >= 14 days, disk < 75%.

const NOW = new Date('2026-10-02T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

const capture = (generatedAt = ago(MIN)) => ({
  generated_at: generatedAt,
  specs: [
    {
      source: 'NL-1',
      spec: 'nl-1-obs-key',
      cadence_s: 600,
      last_success: ago(2 * MIN),
      last_failure_status: null,
      next_due: ago(-8 * MIN),
      bytes_today: 1,
    },
  ],
  days: [],
  seeds: [],
  owner_specs: { fresh: 9, total: 9 },
});
const ops = (over: Record<string, unknown> = {}) => ({
  generated_at: ago(5 * MIN),
  last_backup: ago(30 * MIN),
  drill: null,
  disk_pct: 41,
  ...over,
});
const ok = (doc: unknown): Got => ({ status: 200, body: Buffer.from(JSON.stringify(doc)) });
/** /api/v1/health as the loader-fed api serves it (A§9.2); `over` replaces top-level fields. */
const health = (over: Record<string, unknown> = {}) => ({
  status: 'ok',
  generated_at: ago(MIN),
  loader: {
    lag_p95_s: 34,
    backlog_files: 0,
    backlog_bytes: 0,
    backlog_age_s: null,
    bad_manifest_lines: 0,
    last_commit: null,
  },
  sources: { ok: 10, degraded: 0, down: 0, unknown: 2, total: 12 },
  owner_sources: { healthy: 5, total: 6 },
  quarantined: 0,
  twins: { ok: 0, failing: 0 },
  attribution: [],
  ...over,
});

// Without /api/v1/health the probe answers 404, as production does until the P2a release is deployed.
function probe(over: Partial<Record<string, Got>> = {}, days: number | 'tls' = 60): Probe {
  const pages: Record<string, Got> = {
    '/healthz': { status: 200, body: Buffer.alloc(0) },
    '/status/capture.json': ok(capture()),
    '/status/ops.json': ok(ops()),
    ...over,
  };
  return {
    get: async (path) => pages[path] ?? { status: 404, body: Buffer.alloc(0) },
    certDaysLeft: async () => days,
  };
}

describe('watchdog checks', () => {
  it('all green when the site, both status files, the backup, the certificate and the disk are fine', async () => {
    expect(await check(probe(), NOW)).toEqual({ watchdog: [], cert: [], disk: [], load: null, publisher: null });
  });

  it.each<[string, Partial<Record<string, Got>>, number | 'tls', Omit<Verdicts, 'load' | 'publisher'>]>([
    [
      'healthz down',
      { '/healthz': { status: 503, body: Buffer.alloc(0) } },
      60,
      { watchdog: ['healthz_503'], cert: [], disk: [] },
    ],
    [
      'healthz unreachable',
      { '/healthz': { error: 'timeout' } },
      60,
      { watchdog: ['healthz_timeout'], cert: [], disk: [] },
    ],
    [
      'capture.json stale',
      { '/status/capture.json': ok(capture(ago(6 * MIN))) },
      60,
      { watchdog: ['capture_stale'], cert: [], disk: [] },
    ],
    [
      'capture.json off-contract',
      { '/status/capture.json': ok({ ...capture(), host: 'x' }) },
      60,
      { watchdog: ['capture_contract'], cert: [], disk: [] },
    ],
    [
      'capture.json not JSON',
      { '/status/capture.json': { status: 200, body: Buffer.from('<html>') } },
      60,
      { watchdog: ['capture_json'], cert: [], disk: [] },
    ],
    [
      'ops.json stale',
      { '/status/ops.json': ok(ops({ generated_at: ago(31 * MIN) })) },
      60,
      { watchdog: ['ops_stale'], cert: [], disk: ['ops_stale'] },
    ],
    [
      'ops.json missing',
      { '/status/ops.json': { status: 404, body: Buffer.alloc(0) } },
      60,
      { watchdog: ['ops_status_404'], cert: [], disk: ['ops_status_404'] },
    ],
    [
      'no backup yet',
      { '/status/ops.json': ok(ops({ last_backup: null })) },
      60,
      { watchdog: ['backup_none'], cert: [], disk: [] },
    ],
    [
      'backup older than 2 h',
      { '/status/ops.json': ok(ops({ last_backup: ago(2 * HOUR + MIN) })) },
      60,
      { watchdog: ['backup_stale'], cert: [], disk: [] },
    ],
    [
      'disk at 75%',
      { '/status/ops.json': ok(ops({ disk_pct: 75 })) },
      60,
      { watchdog: [], cert: [], disk: ['disk_full'] },
    ],
    [
      'disk unknown',
      { '/status/ops.json': ok(ops({ disk_pct: null })) },
      60,
      { watchdog: [], cert: [], disk: ['disk_unknown'] },
    ],
    ['certificate expires in 13 days', {}, 13, { watchdog: [], cert: ['cert_expiring'], disk: [] }],
    ['no valid certificate', {}, 'tls', { watchdog: [], cert: ['tls'], disk: [] }],
  ])('%s', async (_, over, days, want) => {
    expect(await check(probe(over, days), NOW)).toEqual({ ...want, load: null, publisher: null });
  });

  it('keeps a backup of exactly 2 h and a certificate of exactly 14 days green', async () => {
    const p = probe({ '/status/ops.json': ok(ops({ last_backup: ago(2 * HOUR) })) }, 14);
    expect(await check(p, NOW)).toEqual({ watchdog: [], cert: [], disk: [], load: null, publisher: null });
  });

  it('every failure code is a fixed identifier, never provider or owner text', async () => {
    const worst = await check(
      probe(
        { '/healthz': { error: 'dns' }, '/status/capture.json': ok({ x: 'BE-3' }), '/status/ops.json': ok({}) },
        'tls',
      ),
      NOW,
    );
    for (const code of [
      ...worst.watchdog,
      ...worst.cert,
      ...worst.disk,
      ...(worst.load ?? []),
      ...(worst.publisher ?? []),
    ])
      expect(code).toMatch(/^[a-z0-9_]+$/);
  });

  it('lists its checks for --dry-run and refuses to start without the contract env', async () => {
    const lines: string[] = [];
    expect(await runWatchdog({}, 'dry-run', (l) => lines.push(l))).toBe(0);
    expect(lines).toEqual(CHECKS);
    expect(await runWatchdog({}, 'once', () => {})).toBe(EXIT_CONFIG);
  });
});

describe('watchdog probe and pings', () => {
  const domain = 'rivierstanden.example';

  it('probes our own domain only, through the guarded client', async () => {
    server.use(
      http.get(`https://${domain}/healthz`, () => new HttpResponse(null, { status: 200 })),
      http.get(`https://${domain}/status/capture.json`, () => HttpResponse.json(capture(new Date().toISOString()))),
      http.get(`https://${domain}/status/ops.json`, () =>
        HttpResponse.json(ops({ generated_at: new Date().toISOString(), last_backup: new Date().toISOString() })),
      ),
      http.get(`https://${domain}/api/v1/health`, () =>
        HttpResponse.json(health({ generated_at: new Date().toISOString() })),
      ),
      http.get(`https://${domain}/data/v1/meta.json`, () =>
        HttpResponse.json({ generatedAt: new Date().toISOString() }),
      ),
    );
    const live = liveProbe(domain, 'ua', testClient({ own: [domain] }));
    const p: Probe = { get: live.get, certDaysLeft: async () => 60 };
    expect(await check(p, new Date())).toEqual({ watchdog: [], cert: [], disk: [], load: [], publisher: [] });
  });

  it('probes /api/v1/health on the same domain and treats its 404 as not deployed yet', async () => {
    const seen: string[] = [];
    server.use(
      http.get(`https://${domain}/api/v1/health`, ({ request }) => {
        seen.push(new URL(request.url).pathname + new URL(request.url).search);
        return HttpResponse.json(health({ generated_at: new Date().toISOString() }));
      }),
    );
    const live = liveProbe(domain, 'ua', testClient({ own: [domain] }));
    const got = await live.get('/api/v1/health');
    expect(got).toMatchObject({ status: 200 });
    expect(seen).toEqual(['/api/v1/health']);
    server.use(http.get(`https://${domain}/api/v1/health`, () => new HttpResponse(null, { status: 404 })));
    expect(await live.get('/api/v1/health')).toMatchObject({ status: 404 });
  });

  it('pings success for a green check and /fail with the codes for a red one', async () => {
    const seen: string[] = [];
    server.use(
      http.all('https://hc-ping.com/*', async ({ request }) => {
        const url = new URL(request.url);
        seen.push(`${url.pathname.split('/').slice(2).join('/')} ${await request.text()}`);
        return new HttpResponse('OK');
      }),
    );
    const pinger = new Pinger('k'.repeat(22), 'ua', { warn: () => {} }, testClient({ hc: ['hc-ping.com'] }));
    await report(
      { watchdog: [], cert: ['cert_expiring'], disk: ['disk_full', 'ops_stale'], load: null, publisher: null },
      pinger,
    );
    // `load` and `publisher` are null before their releases: not pinged at all, neither success nor fail.
    expect(seen).toEqual(['watchdog ', 'cert/fail cert_expiring', 'disk/fail disk_full ops_stale']);
    seen.length = 0;
    await report({ watchdog: [], cert: [], disk: [], load: [], publisher: [] }, pinger);
    await report(
      { watchdog: [], cert: [], disk: [], load: ['load_down', 'load_stale'], publisher: ['publisher_stale'] },
      pinger,
    );
    expect(seen).toEqual([
      'watchdog ',
      'cert ',
      'disk ',
      'load ',
      'publisher ',
      'watchdog ',
      'cert ',
      'disk ',
      'load/fail load_down load_stale',
      'publisher/fail publisher_stale',
    ]);
  });

  it('the pinger refuses any slug but the capture groups and the five watchdog checks', async () => {
    const seen: string[] = [];
    server.use(
      http.all('https://hc-ping.com/*', ({ request }) => {
        seen.push(new URL(request.url).pathname);
        return new HttpResponse('OK');
      }),
    );
    const pinger = new Pinger('k'.repeat(22), 'ua', { warn: () => {} }, testClient({ hc: ['hc-ping.com'] }));
    await pinger.ping('backup', 'success');
    await pinger.ping('../x', 'success');
    await pinger.ping('cap-nl', 'success');
    await pinger.ping('load', 'success');
    await pinger.ping('publisher', 'success');
    await pinger.ping('owner-publisher', 'success');
    await pinger.ping('loader', 'success');
    await pinger.ping('load/fail', 'success');
    expect(seen).toEqual([`/${'k'.repeat(22)}/cap-nl`, `/${'k'.repeat(22)}/load`, `/${'k'.repeat(22)}/publisher`]);
  });
});

describe('the load check (P2a)', () => {
  const load = async (page: Got) => (await check(probe({ '/api/v1/health': page }), NOW)).load;

  it('is green for a fresh, healthy loader, and a degraded source alone is not the loader', async () => {
    expect(await load(ok(health()))).toEqual([]);
    expect(
      await load(ok(health({ status: 'degraded', sources: { ok: 9, degraded: 1, down: 0, unknown: 2, total: 12 } }))),
    ).toEqual([]);
    // Exactly 5 minutes old and a lag just under 2 minutes are still green.
    expect(await load(ok(health({ generated_at: ago(5 * MIN) })))).toEqual([]);
    expect(await load(ok(health({ loader: { ...health().loader, lag_p95_s: 119.9 } })))).toEqual([]);
    expect(await load(ok(health({ loader: { ...health().loader, lag_p95_s: null } })))).toEqual([]);
    // A backlog that is younger than 15 minutes is a loader catching up, not a stall.
    expect(
      await load(
        ok(health({ loader: { ...health().loader, backlog_files: 3, backlog_bytes: 1e6, backlog_age_s: 899 } })),
      ),
    ).toEqual([]);
  });

  it('is not deployed yet on a 404: no verdict, and the other checks are untouched', async () => {
    expect(await load({ status: 404, body: Buffer.alloc(0) })).toBeNull();
    expect(await check(probe({ '/api/v1/health': { status: 404, body: Buffer.alloc(0) } }), NOW)).toEqual({
      watchdog: [],
      cert: [],
      disk: [],
      load: null,
      publisher: null,
    });
  });

  it.each<[string, Got, string[]]>([
    ['the request fails', { error: 'timeout' }, ['load_unreachable']],
    [
      'a 503',
      { status: 503, body: Buffer.from('{"status":"down","error":"unavailable","attribution":[]}') },
      ['load_unreachable'],
    ],
    ['a 502 from the proxy', { status: 502, body: Buffer.from('<html>bad gateway</html>') }, ['load_unreachable']],
    ['not JSON', { status: 200, body: Buffer.from('<html>') }, ['load_contract']],
    ['off-contract', ok(health({ version: '1.2.3' })), ['load_contract']],
    ['an owner field', ok(health({ owner_sources: { healthy: 1, total: 6, ids: ['BE-3'] } })), ['load_contract']],
    ['status down', ok(health({ status: 'down' })), ['load_down']],
    ['never computed', ok(health({ status: 'down', generated_at: null })), ['load_down', 'load_stale']],
    ['stale by the watchdog clock', ok(health({ generated_at: ago(5 * MIN + 1000) })), ['load_stale']],
    ['a quarantined payload', ok(health({ status: 'degraded', quarantined: 2 })), ['load_quarantined']],
    ['lag of 2 minutes', ok(health({ loader: { ...health().loader, lag_p95_s: 120 } })), ['load_lag']],
    [
      'a stall: a manifest line unconsumed for 15 minutes',
      ok(health({ loader: { ...health().loader, backlog_files: 1, backlog_bytes: 812, backlog_age_s: 900 } })),
      ['load_backlog'],
    ],
    [
      'a twin pair outside its tolerance',
      ok(health({ status: 'degraded', twins: { ok: 0, failing: 1 } })),
      ['load_twin'],
    ],
    ['every twin pair within its tolerance', ok(health({ twins: { ok: 1, failing: 0 } })), []],
    [
      'several at once',
      ok(health({ generated_at: ago(6 * MIN), quarantined: 1, loader: { ...health().loader, lag_p95_s: 500 } })),
      ['load_stale', 'load_quarantined', 'load_lag'],
    ],
  ])('%s', async (_, page, codes) => {
    expect(await load(page)).toEqual(codes);
  });

  it('the failure codes are fixed identifiers, whatever the response says', async () => {
    const hostile = 'BE-3 <script>777777.777</script>';
    for (const page of [
      ok(health({ status: hostile, note: hostile })),
      { status: 200, body: Buffer.from(hostile) },
      { status: 500, body: Buffer.from(hostile) },
      { error: hostile },
    ] satisfies Got[])
      for (const code of (await load(page)) ?? []) expect(code).toMatch(/^load_[a-z]+$/);
  });

  it('a red load check does not fail the watchdog ping, and --once counts it', async () => {
    const v = await check(probe({ '/api/v1/health': ok(health({ status: 'down', generated_at: null })) }), NOW);
    expect(v).toEqual({
      watchdog: [],
      cert: [],
      disk: [],
      load: ['load_down', 'load_stale'],
      publisher: null,
    });
  });
});

describe('the publisher check (P9a)', () => {
  const pub = async (page: Got) => (await check(probe({ '/data/v1/meta.json': page }), NOW)).publisher;
  const meta = (generatedAt: string) => ok({ schemaVersion: 1, generatedAt, anything: 'else' });

  it('is green for a fresh meta.json, including exactly 5 minutes old', async () => {
    expect(await pub(meta(ago(MIN)))).toEqual([]);
    expect(await pub(meta(ago(5 * MIN)))).toEqual([]);
  });

  it('is not deployed yet on a 404: no verdict, no ping', async () => {
    expect(await pub({ status: 404, body: Buffer.alloc(0) })).toBeNull();
    expect((await check(probe(), NOW)).publisher).toBeNull();
  });

  it.each<[string, Got, string[]]>([
    ['stale', meta(ago(5 * MIN + 1000)), ['publisher_stale']],
    ['unreachable', { error: 'timeout' }, ['publisher_unreachable']],
    ['a 503', { status: 503, body: Buffer.from('x') }, ['publisher_unreachable']],
    ['not JSON', { status: 200, body: Buffer.from('<html>') }, ['publisher_contract']],
    ['no generatedAt', ok({ schemaVersion: 1 }), ['publisher_contract']],
    ['a hostile generatedAt', ok({ generatedAt: 'BE-3 777777.777' }), ['publisher_contract']],
  ])('%s', async (_, page, codes) => {
    expect(await pub(page)).toEqual(codes);
  });

  it('a red publisher check does not fail the watchdog ping', async () => {
    const v = await check(probe({ '/data/v1/meta.json': meta(ago(HOUR)) }), NOW);
    expect(v).toMatchObject({ watchdog: [], publisher: ['publisher_stale'] });
  });
});
