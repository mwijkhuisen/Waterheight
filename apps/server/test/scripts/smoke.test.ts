import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
});

describe('scripts/healthz-smoke.sh (S10)', () => {
  // A stand-in for the built server: its capture role "starts the live recorder" (hangs) whenever
  // the contact variables reach it, as the real one would.
  const FAKE_MAIN = `const [role, flag] = process.argv.slice(2);
if (role === 'api') require('node:http').createServer((q, r) => r.end('{"status":"ok"}')).listen(Number(process.env.PORT), process.env.HOST);
else if (role === 'capture' && flag === '--dry-run') console.log('1 specs loaded; RWS requests/hour (busiest 60 min): 1 (limit 400)');
else if (role === 'capture' && process.env.RWS_DOMAIN) setInterval(() => {}, 1000);
else process.exit(role === 'capture' ? 78 : 2);
`;

  it('never starts the live recorder, even with RWS_DOMAIN and RWS_CONTACT_EMAIL exported', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rws-smoke-'));
    mkdirSync(join(dir, 'apps/server/dist'), { recursive: true });
    writeFileSync(join(dir, 'apps/server/dist/main.js'), FAKE_MAIN);
    const script = new URL('../../../../scripts/healthz-smoke.sh', import.meta.url).pathname;
    const r = spawnSync('bash', [script], {
      cwd: dir,
      env: {
        ...process.env,
        RWS_DOMAIN: 'example.org',
        RWS_CONTACT_EMAIL: 'contact@example.org',
        SMOKE_PORT: String(20_000 + Math.floor(Math.random() * 20_000)),
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('role capture -> exit 78');
  }, 40_000);
});
