import { type ChildProcess, fork } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ManifestLine } from '../../src/archive/manifest.ts';
import { Archive } from '../../src/archive/writer.ts';

// Criterion "[CI] A kill -9 of a capture child process during a write leaves
// no object under a final key and no manifest line for it" (issue #16). The
// child pauses itself at a stage and tells us over IPC; no sleeps, no env.

const child = new URL('./kill-child.ts', import.meta.url).pathname;
const KEY = 'raw/NL-1/nl-1-obs-key/2026/10/02';

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name));
}

async function killAt(stage: 'tmp' | 'rename'): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'rws-kill-'));
  const proc: ChildProcess = fork(child, [root, stage], { execArgv: ['--no-experimental-webstorage'], stdio: 'pipe' });
  const outcome = await new Promise<string>((resolve, reject) => {
    proc.on('message', (m) => resolve(String(m)));
    proc.on('exit', (code) => reject(new Error(`child exited early (${code})`)));
  });
  expect(outcome).toBe('paused');
  proc.kill('SIGKILL');
  const signal = await new Promise((resolve) => proc.on('exit', (_c, s) => resolve(s)));
  expect(signal).toBe('SIGKILL');
  return root;
}

describe('kill -9 during a capture write', () => {
  it('after the tmp write: no object under a final key, no manifest line; recovery cleans up', async () => {
    const root = await killAt('tmp');
    expect(files(join(root, 'NL-1'))).toEqual([]);
    expect(existsSync(join(root, '_manifest'))).toBe(false);
    expect(files(join(root, '.tmp'))).toHaveLength(1);
    const archive = new Archive(root);
    expect(await archive.recover(() => ({ retention: 'obs', version: 1 }), new Date('2026-10-02T12:05:00Z'))).toBe(0);
    expect(files(join(root, '.tmp'))).toEqual([]);
    expect(files(join(root, 'NL-1'))).toEqual([]);
  });

  it('after the rename, before the line: recovery records the object as recovered', async () => {
    const root = await killAt('rename');
    const [object] = files(join(root, 'NL-1'));
    expect(object).toContain('NL-1/nl-1-obs-key/2026/10/02/120107Z-');
    expect(existsSync(join(root, '_manifest'))).toBe(false);
    const archive = new Archive(root);
    expect(await archive.recover(() => ({ retention: 'obs', version: 1 }), new Date('2026-10-02T12:05:00Z'))).toBe(1);
    const lines = readFileSync(join(root, '_manifest', '2026-10-02.jsonl'), 'utf8')
      .trim()
      .split('\n');
    const recovered = ManifestLine.parse(JSON.parse(lines[0] as string));
    expect(recovered).toMatchObject({ recovered: true, source: 'NL-1', spec: 'nl-1-obs-key' });
    expect(recovered.key?.startsWith(KEY)).toBe(true);
  });
});
