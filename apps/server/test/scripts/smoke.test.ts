import { spawnSync } from 'node:child_process';
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
