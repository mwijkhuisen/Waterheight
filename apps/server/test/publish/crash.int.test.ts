import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { publishOnce } from '../../src/publish/index.ts';
import { RENDERERS } from '../../src/publish/render/index.ts';
import { type Harness, harness } from '../load/harness.ts';
import { contract, walk } from './tree.ts';

// P9a (plan §4.10, "the crash test"): the publisher writes `.zst`, `.gz` and then the plain file, each by a rename
// out of `.tmp/`. (a) A fault between two of those renames leaves every served file whole, and the next start (which
// writes every mutable file again) makes the siblings match. (b) A child process killed with SIGKILL at random points,
// 20 times, then one clean run: every file parses with its contract, the siblings decompress to the plain bytes and
// `.tmp/` is empty.

const hook = vi.hoisted(() => ({ rename: undefined as undefined | ((from: string, to: string) => void) }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    rename: async (from: string, to: string) => {
      hook.rename?.(from, to);
      return fs.rename(from, to);
    },
  };
});

const T1 = Date.parse('2026-10-04T12:00:00Z');
const T2 = T1 + 3_600_000;
const CHILD = fileURLToPath(new URL('./crash-child.ts', import.meta.url));
let h: Harness;
let dirs: string[] = [];

const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), 'rws-crash-'));
  dirs.push(d);
  return d;
};
let pub: ReturnType<Harness['dbAs']>;
const run = (dir: string, now: number) => publishOnce(pub.db, 'public', dir, { now, render: RENDERERS });
/** Every plain file of the tree parses as JSON (a served file is never half written). */
function allParse(dir: string): number {
  let n = 0;
  const go = (rel: string) => {
    for (const e of readdirSync(join(dir, 'v1', rel), { withFileTypes: true })) {
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) go(r);
      else if (!/\.(zst|gz)$/.test(e.name)) {
        JSON.parse(readFileSync(join(dir, 'v1', r), 'utf8'));
        n++;
      }
    }
  };
  go('');
  return n;
}

beforeAll(async () => {
  h = await harness();
  pub = h.dbAs('rws_publish', 3);
  await h.t.admin.query(`UPDATE app_meta SET value = '"2026-10-01T00:00:00Z"' WHERE key = 'display_start'`);
}, 120_000);
afterAll(async () => {
  hook.rename = undefined;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  await h.close();
});

describe('a fault between write and rename', { timeout: 300_000 }, () => {
  it('leaves served files whole, and the next start repairs the siblings', async () => {
    const baseline = fresh();
    await run(baseline, T1);
    const before = allParse(baseline);
    for (const failAt of [2, 40, 301, 777]) {
      const dir = fresh();
      cpSync(baseline, dir, { recursive: true });
      // The next cycle (an hour later) changes latest.json, meta.json, status.json and the frames; the failing
      // rename is the failAt-th of that cycle, so a file may have its new `.zst` and still its old plain file.
      let n = 0;
      hook.rename = () => {
        if (++n === failAt) throw Object.assign(new Error('injected'), { code: 'EIO' });
      };
      await expect(run(dir, T2), `fault at rename ${failAt}`).rejects.toThrow('injected');
      hook.rename = undefined;
      expect(n, `the cycle reached rename ${failAt}`).toBeGreaterThanOrEqual(failAt);
      // Nothing served is half written (allParse throws on a plain file that is not whole JSON): the deterministic
      // proof of a crash between write and rename; the random kills below add timing coverage (review CR-5).
      expect(allParse(dir)).toBeGreaterThanOrEqual(before - 1);
      // The next start: every mutable file is written again.
      await run(dir, T2);
      expect(walk(dir).size).toBeGreaterThan(before - 5);
      expect(readdirSync(join(dir, '.tmp'))).toEqual([]);
      for (const [rel, text] of walk(dir)) contract('public', rel).parse(JSON.parse(text));
    }
  });
});

describe('a process killed at random points', { timeout: 600_000 }, () => {
  beforeAll(() => pub.close());
  it('SIGKILL 20 times, then one clean run: every file parses, siblings match, .tmp is empty', async () => {
    const dir = fresh();
    const url = h.t.urlFor('rws_publish');
    const start = () => {
      const child = spawn(process.execPath, ['--no-experimental-webstorage', CHILD, url, dir, String(T1)], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
        child.on('exit', (code, signal) => resolve({ code, signal })),
      );
      return { child, exited };
    };
    // A full run first: its length bounds the random kill times (and proves the child works).
    const t0 = Date.now();
    const full = start();
    expect((await full.exited).code).toBe(0);
    const total = Date.now() - t0;
    rmSync(dir, { recursive: true, force: true });
    // A seeded generator: a failure reproduces.
    let seed = 20261004;
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    let killed = 0;
    for (let i = 0; i < 20; i++) {
      const { child, exited } = start();
      await new Promise((r) => setTimeout(r, Math.round(rand() * total * 0.95)));
      child.kill('SIGKILL');
      const { signal } = await exited;
      if (signal === 'SIGKILL') killed++;
      if (existsSync(join(dir, 'v1'))) allParse(dir); // whatever is served is whole
    }
    expect(killed).toBeGreaterThanOrEqual(15);
    // One clean run (in a child, as production would restart): the repair.
    const clean = start();
    expect((await clean.exited).code).toBe(0);
    const files = walk(dir); // checks every sibling's bytes and an empty .tmp
    expect(files.size).toBeGreaterThan(300);
    for (const [rel, text] of files) expect(() => contract('public', rel).parse(JSON.parse(text)), rel).not.toThrow();
    expect(readdirSync(join(dir, '.state')).filter((f) => f.endsWith('.done'))).toEqual(['settled-2026-10-01-v1.done']);
    dirs = dirs.filter(Boolean);
  });
});
