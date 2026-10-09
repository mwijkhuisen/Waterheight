import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OwnerRivers } from '../../src/publish/rivers.ts';

// P11a review round 2: publish-owner reads the public river release as untrusted input. A FIFO in place of the
// manifest must not hang the open (O_NONBLOCK), and a link must not be followed (O_NOFOLLOW); either is a fixed code.

let dir = '';
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function codesFor(make: (manifest: string) => void): Promise<unknown[]> {
  dir = mkdtempSync(join(tmpdir(), 'owner-rivers-'));
  make(join(dir, 'manifest.json'));
  const logged: unknown[] = [];
  const rivers = new OwnerRivers(dir, { error: (o: object) => logged.push(o) } as never, () => ({ stations: [] }));
  expect(await rivers.next(new Set())).toBeNull();
  return logged;
}

describe('the owner rivers reader', () => {
  it('refuses a FIFO as the manifest without hanging', { timeout: 5000 }, async () => {
    const logged = await codesFor((path) => execFileSync('mkfifo', [path]));
    expect(logged).toEqual([expect.objectContaining({ code: 'rivers_manifest_unreadable' })]);
  });

  it('never follows a link as the manifest', async () => {
    const logged = await codesFor((path) => {
      writeFileSync(`${path}.real`, '{}');
      symlinkSync(`${path}.real`, path);
    });
    expect(logged).toEqual([expect.objectContaining({ code: 'rivers_manifest_unreadable' })]);
  });
});
