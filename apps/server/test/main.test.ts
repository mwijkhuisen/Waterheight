import { execFileSync } from 'node:child_process';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureEnv, captureUserAgent, readSecret } from '../src/capture/env.ts';
import { healthy } from '../src/heartbeat.ts';
import { dryRun, EXIT_CONFIG, EXIT_USAGE, parseListen, publishArgs, ROLES, run } from '../src/main.ts';

const quiet = () => {};

describe('role dispatcher', () => {
  it('publish takes --audience public|owner and --once, each once; it needs database settings: exit 78', async () => {
    expect(publishArgs([])).toEqual({ family: 'public', once: false });
    expect(publishArgs(['--once', '--audience', 'owner'])).toEqual({ family: 'owner', once: true });
    for (const bad of [
      ['--audience'],
      ['--audience', 'off'],
      ['--once', '--once'],
      ['--audience', 'owner', '--audience', 'public'],
      ['--dry-run'],
    ]) {
      expect(publishArgs(bad), bad.join(' ')).toBeUndefined();
      expect(await run(['publish', ...bad], {}, quiet)).toBe(EXIT_USAGE);
    }
    expect(await run(['publish'], {}, quiet)).toBe(EXIT_CONFIG);
    expect(await run(['publish', '--audience', 'owner', '--once'], { RWS_DB_HOST: 'db' }, quiet)).toBe(EXIT_CONFIG);
  });

  it.each(['load', 'migrate'])('%s refuses to start without database settings: exit 78', async (role) => {
    expect(await run([role], {}, quiet)).toBe(EXIT_CONFIG);
    // A host without the role's file secret is not enough.
    expect(await run([role], { RWS_DB_HOST: 'db' }, quiet)).toBe(EXIT_CONFIG);
    expect(await run([role], { RWS_DB_HOST: 'db; drop' }, quiet)).toBe(EXIT_CONFIG);
  });

  it.each([
    [['replay']],
    [['replay', '--source', 'DE-1']],
    [['replay', '--source', 'DE-1', '--from', '2026-10-01']],
    // A source without a loader adapter (NL-4 is converted offline, never replayed).
    [['replay', '--source', 'NL-4', '--from', '2026-10-01', '--to', '2026-10-02']],
    [['replay', '--source', "DE-1'; --", '--from', '2026-10-01', '--to', '2026-10-02']],
    [['replay', '--source', 'DE-1', '--spec', 'nl-1-obs', '--from', '2026-10-01', '--to', '2026-10-02']],
    [['replay', '--source', 'DE-1', '--spec', '../x', '--from', '2026-10-01', '--to', '2026-10-02']],
    [['replay', '--source', 'DE-1', '--from', '2026-10-02', '--to', '2026-10-01']],
    [['replay', '--source', 'DE-1', '--from', '2026-02-30', '--to', '2026-03-01']],
    [['replay', '--source', 'DE-1', '--from', '2026-10-01T00:00', '--to', '2026-10-02']],
    // An instant is to the second, in UTC (`Z`), and real; --to stays a day (review R3-1).
    [['replay', '--source', 'DE-1', '--from', '2026-10-01T07:10:00+02:00', '--to', '2026-10-02']],
    [['replay', '--source', 'DE-1', '--from', '2026-10-01T07:10:00.000Z', '--to', '2026-10-02']],
    [['replay', '--source', 'DE-1', '--from', '2026-10-01 07:10:00Z', '--to', '2026-10-02']],
    [['replay', '--source', 'DE-1', '--from', '2026-10-01t07:10:00z', '--to', '2026-10-02']],
    [['replay', '--source', 'DE-1', '--from', '2026-10-01T24:00:00Z', '--to', '2026-10-02']],
    [['replay', '--source', 'DE-1', '--from', '2026-10-01T23:59:60Z', '--to', '2026-10-02']],
    [['replay', '--source', 'DE-1', '--from', '2026-02-30T07:10:00Z', '--to', '2026-03-01']],
    [['replay', '--source', 'DE-1', '--from', '2026-10-03T07:10:00Z', '--to', '2026-10-02']],
    [['replay', '--source', 'DE-1', '--from', '2026-10-01', '--to', '2026-10-02T07:10:00Z']],
    [['replay', '--source', 'DE-1', '--from', '2026-10-01', '--to', '2026-10-02', '--force']],
    [['replay', '--source', 'DE-1', '--from', '2026-10-01', '--to']],
  ])('replay rejects %j with a usage error before it touches anything', async (argv) => {
    expect(await run(argv, { DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none' }, quiet)).toBe(EXIT_USAGE);
  });

  it('replay with valid arguments needs database settings: exit 78', async () => {
    const argv = ['replay', '--source', 'DE-1', '--spec', 'de-1-series', '--from', '2026-10-01', '--to', '2026-10-02'];
    expect(await run(argv, {}, quiet)).toBe(EXIT_CONFIG);
    expect(await run([...argv, '--dry-run'], {}, quiet)).toBe(EXIT_CONFIG);
    // --from may be a UTC instant, on the day of --to at the latest.
    for (const from of ['2026-10-01T07:10:00Z', '2026-10-02T23:59:59Z'])
      expect(await run(['replay', '--source', 'DE-1', '--from', from, '--to', '2026-10-02'], {}, quiet)).toBe(
        EXIT_CONFIG,
      );
  });

  it('knows the contract roles capture, watchdog and healthcheck', () => {
    for (const r of ['capture', 'watchdog', 'healthcheck']) expect(ROLES).toContain(r);
  });

  it('refuses to capture without a contact User-Agent (the A2 switch): exit 78', async () => {
    expect(await run(['capture'], {}, quiet)).toBe(EXIT_CONFIG);
    expect(await run(['capture'], { RWS_DOMAIN: 'example.org' }, quiet)).toBe(EXIT_CONFIG);
    expect(await run(['capture'], { RWS_DOMAIN: 'example.org', RWS_CONTACT_EMAIL: 'x' }, quiet)).toBe(EXIT_CONFIG);
  });

  it('capture --dry-run loads every spec and prints the schedule and the RWS requests/hour', () => {
    const out: string[] = [];
    expect(dryRun((l) => out.push(l))).toBe(0);
    const text = out.join('\n');
    expect(text).toMatch(/specs loaded; RWS requests\/hour \(busiest 60 min\): \d+ \(limit 400\)/);
    expect(text).toContain('nl-1-fc-1h');
    expect(text).toContain('ddapi20-waterwebservices.rijkswaterstaat.nl');
  });

  it.each([
    [[]],
    [['nope']],
    [['api', 'extra']],
    [['API']],
    [['capture', '--now']],
    [['healthcheck', 'x']],
    [['watchdog', '--now']],
    [['api', '--once']],
    [['load', '--dry-run']],
    [['migrate', 'up']],
  ])('rejects %j with a usage error', async (argv) => {
    expect(await run(argv, {}, quiet)).toBe(EXIT_USAGE);
  });

  it('refuses to serve on a malformed PORT', async () => {
    expect(await run(['api'], { PORT: '80a' }, quiet)).toBe(EXIT_USAGE);
  });
});

describe('capture keeps running after an unexpected error (T-CAP-8)', () => {
  it('logs fixed fields only, never a message, and does not exit', () => {
    const child = new URL('./keep-alive-child.ts', import.meta.url).pathname;
    const out = execFileSync(process.execPath, ['--no-experimental-webstorage', child], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    const lines = out.trim().split('\n');
    expect(lines.at(-1)).toBe('alive');
    expect(lines.slice(0, -1).map((l) => JSON.parse(l).o)).toEqual([
      { event: 'unhandledRejection', name: 'Error', code: 'other' },
      { event: 'uncaughtException', name: 'Error', code: 'ECONNRESET' },
    ]);
    expect(out).not.toContain('DUMMYKEY');
  });
});

describe('parseListen', () => {
  it('defaults to localhost:8080', () => {
    expect(parseListen({})).toEqual({ hostname: '127.0.0.1', port: 8080 });
  });

  it('takes HOST and PORT from the environment', () => {
    expect(parseListen({ HOST: '0.0.0.0', PORT: '3000' })).toEqual({ hostname: '0.0.0.0', port: 3000 });
  });

  it.each(['0', '65536', '-1', '1e3', ' 80', ''])('rejects PORT %j', (PORT) => {
    expect(typeof parseListen({ PORT })).toBe('string');
  });

  it('rejects an empty HOST', () => {
    expect(typeof parseListen({ HOST: '' })).toBe('string');
  });
});

describe('heartbeat and healthcheck', () => {
  it('is healthy only while the heartbeat is under 120 s old', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'rws-hb-')), 'hb');
    expect(healthy(f)).toBe(false);
    writeFileSync(f, '');
    expect(healthy(f)).toBe(true);
    const old = new Date(Date.now() - 121_000);
    utimesSync(f, old, old);
    expect(healthy(f)).toBe(false);
  });
});

describe('capture environment', () => {
  it('reads the contract variables with their defaults and builds the contact User-Agent', () => {
    const env = captureEnv({ RWS_DOMAIN: 'rivierstanden.nl', RWS_CONTACT_EMAIL: 'contact@rivierstanden.nl' });
    expect(env).toEqual({
      rawDir: '/data/raw',
      statusDir: '/data/status',
      ownerStatusDir: '/data/owner-status',
      domain: 'rivierstanden.nl',
      contactEmail: 'contact@rivierstanden.nl',
    });
    if (typeof env !== 'string') {
      expect(captureUserAgent(env)).toBe(
        'rivierstanden/0.1.0 (+https://rivierstanden.nl/over; contact@rivierstanden.nl)',
      );
    }
  });

  it('reads file secrets only by fixed names', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rws-sec-'));
    writeFileSync(join(dir, 'rws_x_api_key'), 'abc\n');
    expect(readSecret('rws_x_api_key', dir)).toBe('abc');
    expect(readSecret('../etc/passwd', dir)).toBeUndefined();
    expect(readSecret('missing', dir)).toBeUndefined();
  });
});
