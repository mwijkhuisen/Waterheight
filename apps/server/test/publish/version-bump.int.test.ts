import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FramesFile, SnapshotFile, StaticMeta, toSnapshot } from '@rws/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publishOnce } from '../../src/publish/index.ts';
import { RENDERERS } from '../../src/publish/render/index.ts';
import { type Harness, harness } from '../load/harness.ts';
import { loadLobith } from './nl1.ts';

// P9a (plan §4.10, "Version bump on a > 48 h revision"), through the real loader: a revision of a settled day bumps
// its version, the cycle renders v2 beside v1 and leaves the v1 bytes alone; a revision of a day inside 48 h bumps
// nothing.

const NOW = Date.parse('2026-10-04T12:00:00Z');
const D = '2026-09-30';
const T1 = Date.parse(`${D}T12:00:00Z`);
const MIN = 60_000;
let h: Harness;
let dir: string;
let series: number;

const versions = async () =>
  (await h.t.admin.query("SELECT value FROM app_meta WHERE key = 'day_versions:public'")).rows[0]?.value as
    | Record<string, { v: number; reason: string }>
    | undefined;
const read = (rel: string) => JSON.parse(readFileSync(join(dir, 'v1', rel), 'utf8'));
const valueAt = (rel: string): number | null => {
  const f = SnapshotFile.parse(read(rel));
  const i = f.series.indexOf(series);
  return i < 0 ? null : (f.value[i] ?? null);
};
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
/** sha256 of every file (siblings included) under a directory of v1/. */
function hashes(rel: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (r: string) => {
    for (const e of readdirSync(join(dir, 'v1', r), { withFileTypes: true }))
      if (e.isDirectory()) walk(`${r}/${e.name}`);
      else out[`${r}/${e.name}`] = sha(join(dir, 'v1', r, e.name));
  };
  walk(rel);
  return out;
}

beforeAll(async () => {
  h = await harness();
  await h.t.admin.query(`UPDATE app_meta SET value = '"2026-09-30T00:00:00Z"' WHERE key = 'display_start'`);
  await h.t.admin.query(`SELECT ensure_partitions('2026-09-01'::timestamptz, '2026-10-06'::timestamptz)`);
  dir = mkdtempSync(join(tmpdir(), 'rws-bump-'));
}, 120_000);
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await h.close();
});

describe('day versions through the loader and the cycle', { timeout: 300_000 }, () => {
  it('a revision inside 48 h of the loader clock bumps nothing', async () => {
    await loadLobith(h, [[T1, 100]], new Date(`${D}T13:00:00Z`), new Date(`${D}T13:00:00Z`));
    series = (await h.t.admin.query('SELECT DISTINCT series_id FROM obs')).rows[0]?.series_id as number;
    // The same day revised a day later (its start is less than 48 h before the clock).
    await loadLobith(h, [[T1, 101]], new Date('2026-10-01T10:00:00Z'), new Date('2026-10-01T10:00:00Z'));
    expect(await h.count('obs_revision')).toBe(1);
    // A day of the unsettled window, revised at the test clock.
    const T3 = Date.parse('2026-10-03T10:00:00Z');
    await loadLobith(h, [[T3, 5]], new Date(NOW - 7_200_000), new Date(NOW));
    await loadLobith(h, [[T3, 6]], new Date(NOW - 3_600_000), new Date(NOW));
    expect(await h.count('obs_revision')).toBe(2);
    expect(await versions()).toBeUndefined();
  });

  let v1: Record<string, string>;
  it('renders the settled day as v1 with the revised value', async () => {
    await publishOnce(h.dbAs('rws_publish', 3).db, 'public', dir, { now: NOW, render: RENDERERS });
    expect(valueAt(`settled/${D}/v1/1200.json`)).toBe(101);
    expect(valueAt(`settled/${D}/v1/1210.json`)).toBe(101); // held within its staleness
    expect(readdirSync(join(dir, 'v1/settled'))).toEqual([D, '2026-10-01']);
    expect(readdirSync(join(dir, 'v1/settled', D))).toEqual(['v1']);
    expect(StaticMeta.parse(read('meta.json')).dayVersions).toEqual({});
    v1 = { ...hashes(`settled/${D}/v1`), ...hashes(`frames/${D}`) };
    expect(Object.keys(v1).length).toBe(3 * 145);
  });

  it('a revision more than 48 h old bumps the day: v2 holds the new value, the v1 bytes are unchanged', async () => {
    await loadLobith(h, [[T1, 102]], new Date(NOW - 600_000), new Date(NOW));
    expect((await versions())?.[D]).toMatchObject({ v: 2, reason: 'revision' });
    expect(Object.keys((await versions()) ?? {})).toContain(D);
    expect((await versions())?.['2026-10-03']).toBeUndefined();

    await publishOnce(h.dbAs('rws_publish', 3).db, 'public', dir, { now: NOW + MIN, render: RENDERERS });
    expect(readdirSync(join(dir, 'v1/settled', D)).sort()).toEqual(['v1', 'v2']);
    expect(valueAt(`settled/${D}/v2/1200.json`)).toBe(102);
    expect(valueAt(`settled/${D}/v2/1210.json`)).toBe(102);
    expect(valueAt(`settled/${D}/v1/1200.json`)).toBe(101);
    // v1 is untouched, siblings and frames included (a v1 URL may sit in a CDN or a browser for a year).
    const after = { ...hashes(`settled/${D}/v1`), ...hashes(`frames/${D}`) };
    expect(Object.fromEntries(Object.entries(after).filter(([k]) => k in v1))).toEqual(v1);
    expect(Object.keys(hashes(`frames/${D}`)).sort()).toEqual([
      `frames/${D}/v1.json`,
      `frames/${D}/v1.json.gz`,
      `frames/${D}/v1.json.zst`,
      `frames/${D}/v2.json`,
      `frames/${D}/v2.json.gz`,
      `frames/${D}/v2.json.zst`,
    ]);
    FramesFile.parse(read(`frames/${D}/v2.json`));
    // A bucket without the series is the same bytes in both versions: a file is a function of (day, version).
    expect(sha(join(dir, `v1/settled/${D}/v2/0000.json`))).toBe(sha(join(dir, `v1/settled/${D}/v1/0000.json`)));
    expect(toSnapshot(read(`settled/${D}/v2/1200.json`)).values.find((v) => v.series === series)?.value).toBe(102);
    // meta names the new version, and only for the bumped day.
    expect(StaticMeta.parse(read('meta.json')).dayVersions).toEqual({ [D]: 2 });
    expect(readdirSync(join(dir, 'v1/settled/2026-10-01'))).toEqual(['v1']);
  });
});
