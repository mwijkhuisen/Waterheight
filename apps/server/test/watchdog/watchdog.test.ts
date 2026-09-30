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
    expect(await check(probe(), NOW)).toEqual({ watchdog: [], cert: [], disk: [] });
  });

  it.each<[string, Partial<Record<string, Got>>, number | 'tls', Verdicts]>([
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
    expect(await check(probe(over, days), NOW)).toEqual(want);
  });

  it('keeps a backup of exactly 2 h and a certificate of exactly 14 days green', async () => {
    const p = probe({ '/status/ops.json': ok(ops({ last_backup: ago(2 * HOUR) })) }, 14);
    expect(await check(p, NOW)).toEqual({ watchdog: [], cert: [], disk: [] });
  });

  it('every failure code is a fixed identifier, never provider or owner text', async () => {
    const worst = await check(
      probe(
        { '/healthz': { error: 'dns' }, '/status/capture.json': ok({ x: 'BE-3' }), '/status/ops.json': ok({}) },
        'tls',
      ),
      NOW,
    );
    for (const code of [...worst.watchdog, ...worst.cert, ...worst.disk]) expect(code).toMatch(/^[a-z0-9_]+$/);
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
    );
    const live = liveProbe(domain, 'ua', testClient({ own: [domain] }));
    const p: Probe = { get: live.get, certDaysLeft: async () => 60 };
    expect(await check(p, new Date())).toEqual({ watchdog: [], cert: [], disk: [] });
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
    await report({ watchdog: [], cert: ['cert_expiring'], disk: ['disk_full', 'ops_stale'] }, pinger);
    expect(seen).toEqual(['watchdog ', 'cert/fail cert_expiring', 'disk/fail disk_full ops_stale']);
  });

  it('the pinger refuses any slug but the capture groups and the three watchdog checks', async () => {
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
    expect(seen).toEqual([`/${'k'.repeat(22)}/cap-nl`]);
  });
});
