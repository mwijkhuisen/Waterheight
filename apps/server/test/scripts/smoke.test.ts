import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { args, getProblem, keepAsProblem, windowProblem } from '../../../../scripts/smoke-capture.ts';
import { requestFor } from '../../src/capture/adapters.ts';
import { loadRegistry } from '../../src/capture/specs.ts';

// The opt-in fixture recorder never runs in CI and needs a contact address.
const script = new URL('../../../../scripts/smoke-capture.ts', import.meta.url).pathname;

describe('scripts/smoke-capture.ts', () => {
  it('refuses to run under CI', () => {
    const r = spawnSync(
      process.execPath,
      [script, '--contact', 'a@b.nl', '--info-url', 'https://x.nl', '--spec', 'lu-1-csv'],
      {
        env: { ...process.env, CI: 'true' },
        encoding: 'utf8',
      },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/refuses to run under CI/);
  });

  it('needs a contact e-mail and an https info URL, and caps a run at 30 specs', () => {
    const env = { ...process.env, CI: '' };
    const noContact = spawnSync(process.execPath, [script, '--spec', 'lu-1-csv'], { env, encoding: 'utf8' });
    expect(noContact.status).toBe(64);
    const many = Array.from({ length: 31 }, () => ['--spec', 'lu-1-csv']).flat();
    const tooMany = spawnSync(
      process.execPath,
      [script, '--contact', 'a@b.nl', '--info-url', 'https://x.nl', ...many],
      {
        env,
        encoding: 'utf8',
      },
    );
    expect(tooMany.status).toBe(64);
  });

  // Every --keep-as refusal happens before the first request (no network here: msw is not even loaded).
  const keep = (...a: string[]) =>
    spawnSync(process.execPath, [script, '--contact', 'a@b.nl', '--info-url', 'https://x.nl', ...a], {
      env: { ...process.env, CI: '' },
      encoding: 'utf8',
    });

  it('--keep-as takes a lower-case name of at most 40 characters and is never combined with --row', () => {
    for (const bad of ['Full', '-full', '../x', 'x'.repeat(41)]) {
      const r = keep('--spec', 'nl-1-catalogue', '--keep-as', bad);
      expect([bad, r.status]).toEqual([bad, 64]);
    }
    const withRow = keep('--spec', 'nl-1-fc-1h', '--row', 'lobith.bovenrijn.tolkamer/Q', '--keep-as', 'full');
    expect(withRow.status).toBe(64);
    expect(withRow.stderr).toMatch(/not combined with --row/);
  }, 30_000);

  it('--keep-as refuses an owner-audience spec and an existing fixture, before any request', () => {
    const owner = keep('--spec', 'be-3-values', '--keep-as', 'full');
    expect(owner.status).toBe(1);
    expect(owner.stderr).toMatch(/public spec only/);
    // fixtures/nl-1-fc-1h-lobith-q-20261001t0425z.raw is a committed recording; a refusal of the second
    // spec also spends nothing on the first.
    const exists = keep(
      '--spec',
      'nl-2-wfs',
      '--keep-as',
      'x',
      '--spec',
      'nl-1-fc-1h',
      '--keep-as',
      'lobith-q-20261001t0425z',
    );
    expect(exists.status).toBe(1);
    expect(exists.stderr).toMatch(/nl-1-fc-1h-lobith-q-20261001t0425z\.raw exists/);
    expect(exists.stdout).toBe('');
  }, 30_000);

  it('keepAsProblem refuses a stray .meta.json without its .raw, a .raw, and a repeated pair (fake exists)', () => {
    const t = (name: string) => ({ spec: 'nl-2-wfs', name, dir: '/f' });
    const only = (path: string) => (p: string) => p === path;
    expect(keepAsProblem([t('a')], () => false)).toBeNull();
    expect(keepAsProblem([t('a')], only('/f/nl-2-wfs-a.meta.json'))).toMatchObject({
      code: 1,
      message: expect.stringContaining('nl-2-wfs-a.meta.json exists'),
    });
    expect(keepAsProblem([t('a')], only('/f/nl-2-wfs-a.raw'))).toMatchObject({ code: 1 });
    expect(keepAsProblem([t('a'), t('b'), t('a')], () => false)).toMatchObject({ code: 64 });
  });

  it('--keep-as refuses the same name twice on the command line, before any request', () => {
    const twice = keep('--spec', 'nl-2-wfs', '--keep-as', 'zz-twice', '--spec', 'nl-2-wfs', '--keep-as', 'zz-twice');
    expect(twice.status).toBe(64);
    expect(twice.stderr).toMatch(/given twice/);
    expect(twice.stdout).toBe('');
  }, 30_000);
});

describe('smoke-capture --from/--to/--method (P16b)', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  const reg = loadRegistry();
  const spec = (id: string) => {
    const s = reg.specs.find((x) => x.id === id);
    if (s === undefined) throw new Error(id);
    return s;
  };
  const hwlw = spec('nl-1-hwlw');
  const hRow = { code: 'vlissingen', quantity: 'WATHTE', hoedanigheid: 'NAP' };
  const win = { from: '2025-09-01', to: '2025-09-30' };

  it('attaches --from/--to to the last --spec and still to the last --backfill', () => {
    const a = args([
      '--spec',
      'a',
      '--spec',
      'nl-1-hwlw',
      '--from',
      '2025-09-01',
      '--to',
      '2025-09-30',
      '--method',
      'other:F010',
    ]);
    expect(a.specs[0]).toEqual({ id: 'a' });
    expect(a.specs[1]).toMatchObject({ from: '2025-09-01', to: '2025-09-30', method: 'other:F010' });
    expect(a.items).toEqual([]);
    const b = args(['--spec', 'a', '--backfill', 's', '--series', 'k', '--from', '2025-09-01', '--to', '2025-09-02']);
    expect(b.specs[0]).toEqual({ id: 'a' });
    expect(b.items[0]).toMatchObject({ from: '2025-09-01', to: '2025-09-02' });
  });

  it('accepts a window and a method on an NL-1 H row', () => {
    const p = windowProblem(hwlw, hRow, { ...win, method: 'other:F010' }, now);
    expect(p).toEqual({ window: { from: new Date('2025-09-01T00:00:00Z'), to: new Date('2025-09-30T00:00:00Z') } });
  });

  it('refuses a long span, from >= to, a bad date, a far end, a non-NL-1 spec, an ahead spec', () => {
    const msg = (s: Parameters<typeof windowProblem>[0], w: Parameters<typeof windowProblem>[2]) =>
      (windowProblem(s, hRow, w, now) as { message?: string }).message;
    expect(msg(hwlw, { from: '2025-09-01', to: '2025-10-03' })).toMatch(/at most 31 days/);
    expect(msg(hwlw, { from: '2025-09-30', to: '2025-09-30' })).toMatch(/before --to/);
    expect(msg(hwlw, { from: 'x', to: '2025-09-30' })).toMatch(/YYYY-MM-DD/);
    expect(msg(hwlw, { from: '2026-10-20', to: '2026-10-22' })).toMatch(/one day after now/);
    expect(msg(hwlw, { from: '2025-09-01' })).toMatch(/together/);
    expect(msg(spec('lu-1-csv'), win)).toMatch(/NL-1 spec/);
    expect(msg(spec('nl-1-astro'), win)).toMatch(/ahead or verwachting/);
    expect(msg(spec('nl-1-fc-1h'), win)).toMatch(/ahead or verwachting/);
  });

  it('refuses a bad --method and a method on a Q row', () => {
    const m = (row: Record<string, string>, method: string) =>
      (windowProblem(hwlw, row, { method }, now) as { message?: string }).message;
    for (const bad of ['F010', 'other:F10', 'RWSM-F232', 'other:F0100']) expect(m(hRow, bad)).toMatch(/--method takes/);
    expect(m({ code: 'lobith', quantity: 'Q' }, 'other:F010')).toMatch(/Q row/);
  });

  it('passes the window and a method override into the NL-1 body', () => {
    const w = { from: new Date('2025-09-01T00:00:00Z'), to: new Date('2025-09-30T00:00:00Z') };
    const body = JSON.parse(String(requestFor(hwlw, { ...hRow, method: 'other:F010' }, now, w).body));
    expect(body.Periode).toEqual({
      Begindatumtijd: '2025-09-01T00:00:00Z',
      Einddatumtijd: '2025-09-30T00:00:00Z',
    });
    expect(JSON.stringify(body)).toContain('other:F010');
  });
});

describe('scripts/healthz-smoke.sh (S10)', () => {
  // A stand-in for the built server: its capture and watchdog roles "start live" (hang) whenever
  // the contact variables reach them, as the real ones would; without them they exit `liveExit`.
  // load and migrate "start live" whenever database settings reach them.
  const fakeMain = (liveExit: number) => `const [role, flag] = process.argv.slice(2);
const live = role === 'capture' || role === 'watchdog';
const db = role === 'load' || role === 'migrate';
if (db) { if (process.env.DATABASE_URL || process.env.RWS_DB_HOST) setInterval(() => {}, 1000); else process.exit(78); }
else if (role === 'api') require('node:http').createServer((q, r) => r.end('{"status":"ok"}')).listen(Number(process.env.PORT), process.env.HOST);
else if (role === 'capture' && flag === '--dry-run') console.log('1 specs loaded; RWS requests/hour (busiest 60 min): 1 (limit 400)');
else if (role === 'watchdog' && flag === '--dry-run') console.log('cert: the certificate is valid');
else if (live && process.env.RWS_DOMAIN) setInterval(() => {}, 1000);
else process.exit(live ? ${liveExit} : 2);
`;
  const smoke = (captureExit: number) => {
    const dir = mkdtempSync(join(tmpdir(), 'rws-smoke-'));
    mkdirSync(join(dir, 'apps/server/dist'), { recursive: true });
    writeFileSync(join(dir, 'apps/server/dist/main.js'), fakeMain(captureExit));
    const script = new URL('../../../../scripts/healthz-smoke.sh', import.meta.url).pathname;
    return spawnSync('bash', [script], {
      cwd: dir,
      env: {
        ...process.env,
        RWS_DOMAIN: 'example.org',
        RWS_CONTACT_EMAIL: 'contact@example.org',
        // A developer shell or the agent sandbox has these: the smoke test must not start a loader with them.
        DATABASE_URL: 'postgres://rws@localhost:5433/rws',
        RWS_DB_HOST: 'db',
        SMOKE_PORT: String(20_000 + Math.floor(Math.random() * 20_000)),
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
  };

  it('never starts the live recorder, even with RWS_DOMAIN and RWS_CONTACT_EMAIL exported', () => {
    const r = smoke(78);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('role capture -> exit 78');
    expect(r.stdout).toContain('role watchdog -> exit 78');
    expect(r.stdout).toContain('role load -> exit 78');
    expect(r.stdout).toContain('role migrate -> exit 78');
  }, 40_000);

  it('fails unless capture exits exactly 78, e.g. on the exit 124 of its timeout (N8)', () => {
    const r = smoke(124);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('role capture exited 124');
  }, 40_000);

  describe('--get (P14b)', () => {
    const hosts = new Map([
      ['FR-2', ['hubeau.eaufrance.fr']],
      ['CH-9', ['data.bs.ch']],
    ]);
    const ok = { url: 'https://data.bs.ch/api/x?a=1', source: 'CH-9', out: 'ch-9-x.1' };
    const none = () => false;

    it('accepts an allowlisted https URL and parses triples', () => {
      expect(getProblem([ok], hosts, none)).toBeNull();
      const a = args(['--get', ok.url, '--source', 'CH-9', '--out', 'ch-9-x', '--max-mib', '64']);
      expect(a.gets).toEqual([{ url: ok.url, source: 'CH-9', out: 'ch-9-x' }]);
      expect(a.maxMib).toBe(64);
    });

    it('refuses http, a foreign host, credentials, a port, a bad, repeated or existing name, a big cap, a sixth', () => {
      const bad = (g: object, exists = none, mib = 25) => getProblem([{ ...ok, ...g }], hosts, exists, mib);
      expect(bad({ url: 'http://data.bs.ch/x' })).toMatch(/https only/);
      expect(bad({ url: 'https://example.org/x' })).toMatch(/not in CH-9/);
      expect(bad({ source: 'FR-2' })).toMatch(/not in FR-2/);
      expect(bad({ url: 'https://u:p@data.bs.ch/x' })).toMatch(/credentials/);
      expect(bad({ url: 'https://data.bs.ch:8443/x' })).toMatch(/port/);
      for (const out of ['Up', '-x', '../x', 'a'.repeat(82)]) expect(bad({ out }), out).toMatch(/--out takes/);
      expect(bad({}, () => true)).toMatch(/exists/);
      expect(bad({}, none, 65)).toMatch(/--max-mib/);
      expect(getProblem([ok, ok], hosts, none)).toMatch(/twice/);
      const six = Array.from({ length: 6 }, (_, i) => ({ ...ok, out: `n${i}` }));
      expect(getProblem(six, hosts, none)).toMatch(/at most 5/);
    });

    it('needs RWS_LIVE=1 and refuses under CI', () => {
      const argv = [
        '--contact',
        'a@b.nl',
        '--info-url',
        'https://x.nl',
        '--get',
        ok.url,
        '--source',
        'CH-9',
        '--out',
        'ch-9-t',
      ];
      const run = (env: Record<string, string>) =>
        spawnSync(process.execPath, [script, ...argv], {
          env: { ...process.env, CI: '', RWS_LIVE: '', ...env },
          encoding: 'utf8',
        });
      expect(run({}).status).toBe(2);
      expect(run({ CI: 'true', RWS_LIVE: '1' }).status).toBe(2);
    }, 30_000);
  });
});
