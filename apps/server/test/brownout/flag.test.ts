import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { BROWNOUT_DIR_DEFAULT, brownoutActive, brownoutFlag, CACHE_MS } from '../../src/brownout/flag.ts';

const dir = mkdtempSync(join(tmpdir(), 'rws-brownout-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('brownoutFlag', () => {
  it('follows <dir>/active with a 2 s cache', () => {
    let t = 1_000_000;
    const on = brownoutFlag(dir, () => t);
    expect(CACHE_MS).toBe(2_000);
    expect(on()).toBe(false);

    writeFileSync(join(dir, 'active'), '');
    t += 1_999; // still cached
    expect(on()).toBe(false);
    t += 1; // 2 s after the first read
    expect(on()).toBe(true);

    rmSync(join(dir, 'active'));
    t += 1_999;
    expect(on()).toBe(true);
    t += 1;
    expect(on()).toBe(false);
  });

  it('ignores the `mode` file; a missing directory is off', () => {
    const other = mkdtempSync(join(tmpdir(), 'rws-brownout-'));
    try {
      writeFileSync(join(other, 'mode'), 'on\n');
      expect(brownoutFlag(other, () => 0)()).toBe(false);
      expect(brownoutFlag(join(other, 'absent'), () => 0)()).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('the process flag is off without the mount', () => {
    expect(BROWNOUT_DIR_DEFAULT).toBe('/run/rws-brownout');
    expect(brownoutActive()).toBe(false);
  });
});
