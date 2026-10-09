import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seriesHash } from '../apps/server/src/publish/render/stations.ts';
import { FramesFile, StaticMeta, StaticStations } from '../packages/contracts/src/static.ts';
import { prng, run, SCENES, sceneStations, synthesize } from '../scripts/synthesize-frames.ts';

// scripts/synthesize-frames.ts (P11b): deterministic, synthetic, and every file parses with the public contracts.

const tmp = () => mkdtempSync(join(tmpdir(), 'synth-frames-'));
const read = (...p: string[]) => JSON.parse(readFileSync(join(...p), 'utf8'));

describe('synthesize-frames', () => {
  const a = tmp();
  const files = synthesize(a, 11);

  it('is deterministic: two runs are byte-identical, another seed differs', () => {
    const b = tmp();
    expect(synthesize(b, 11)).toEqual(files);
    for (const f of files) expect(readFileSync(join(a, f))).toEqual(readFileSync(join(b, f)));
    const c = tmp();
    synthesize(c, 12);
    const day = 'flood/frames-2026-10-10-v1.synthetic.json';
    expect(readFileSync(join(c, day))).not.toEqual(readFileSync(join(a, day)));
    expect(prng(1)()).toBe(prng(1)());
  });

  it('writes meta, stations and one day file per day for each scene, with a synthetic meta each', () => {
    for (const scene of Object.keys(SCENES) as (keyof typeof SCENES)[]) {
      const names = readdirSync(join(a, scene)).sort();
      const days = SCENES[scene].days;
      expect(names.filter((n) => /^frames-.*-v1\.synthetic\.json$/.test(n))).toHaveLength(days);
      expect(names).toContain('meta.json');
      expect(names).toContain('stations.json');
      for (const n of names.filter((x) => !x.endsWith('.meta.json'))) {
        const m = read(a, scene, `${n.replace(/\.json$/, '')}.meta.json`);
        expect(m).toEqual({ synthetic: true, seed: 11, scene });
      }
    }
  });

  it('parses every file with the public contracts, and the days are settled at `now`', () => {
    for (const scene of Object.keys(SCENES) as (keyof typeof SCENES)[]) {
      const meta = StaticMeta.parse(read(a, scene, 'meta.json'));
      const st = StaticStations.parse(read(a, scene, 'stations.json'));
      const ids = st.stations.flatMap((s) => s.series.map((x) => x.id));
      expect(st.seriesHash).toBe(seriesHash(ids));
      expect(Date.parse(meta.now)).toBeGreaterThan(
        Date.parse(`${SCENES[scene].first}T00:00:00Z`) + (SCENES[scene].days + 2) * 86_400_000,
      );
      expect(Date.parse(meta.displayStart)).toBeLessThan(Date.parse(`${SCENES[scene].first}T00:00:00Z`));
      for (const n of readdirSync(join(a, scene)).filter((x) => x.startsWith('frames-') && !x.endsWith('.meta.json'))) {
        const f = FramesFile.parse(read(a, scene, n));
        expect(f.series).toEqual(ids);
        expect(f.series).toEqual([...f.series].sort((x, y) => x - y));
      }
    }
  });

  it('uses real fixture station ids on the four rivers, with an H and a Q series each', () => {
    const fixture = new Set(sceneStations().map((s) => s.id));
    const st = StaticStations.parse(read(a, 'flood', 'stations.json'));
    expect(st.stations.length).toBeGreaterThan(20);
    for (const s of st.stations) {
      expect(fixture.has(s.id)).toBe(true);
      expect(s.series.map((x) => x.quantity)).toEqual(['H', 'Q']);
    }
    expect(new Set(sceneStations().map((s) => s.id.slice(0, 2)))).toContain('nl');
  });

  it('flood: a wave that rises and falls and reaches downstream stations later', () => {
    const days = ['2026-10-10', '2026-10-11', '2026-10-12'].map((d) =>
      FramesFile.parse(read(a, 'flood', `frames-${d}-v1.synthetic.json`)),
    );
    const st = StaticStations.parse(read(a, 'flood', 'stations.json'));
    const rowOf = (id: number) => days.flatMap((f) => f.vlast[f.series.indexOf(id)] as (number | null)[]);
    const peakAt = (row: (number | null)[]) =>
      row.reduce<number>((best, v, i) => (v !== null && v > (row[best] ?? -1) ? i : best), 0);
    const ordered = [...sceneStations()].sort((x, y) => (y.km_to_nl_entry as number) - (x.km_to_nl_entry as number));
    const idOf = (sid: string) =>
      (st.stations.find((s) => s.id === sid) as { series: { id: number }[] }).series[0]?.id as number;
    const up = rowOf(idOf((ordered[0] as { id: string }).id));
    const down = rowOf(idOf((ordered.at(-1) as { id: string }).id));
    expect(peakAt(down)).toBeGreaterThan(peakAt(up));
    for (const row of [up, down]) {
      const nums = row.filter((v): v is number => v !== null);
      expect(Math.max(...nums)).toBeGreaterThan(Math.min(...nums) + 100);
      expect(peakAt(row)).toBeGreaterThan(0);
      expect(peakAt(row)).toBeLessThan(71);
    }
  });

  it('dst: the day file of 2026-10-25 holds 00:00Z and 01:00Z with distinct values for every series', () => {
    const f = FramesFile.parse(read(a, 'dst', 'frames-2026-10-25-v1.synthetic.json'));
    expect(f.from).toBe('2026-10-25T00:00:00Z');
    expect(f.vlast[0]).toHaveLength(24);
    for (const row of f.vlast) if (row[0] !== null && row[1] !== null) expect(row[0]).not.toBe(row[1]);
  });

  it('the CLI needs --out', () => {
    const lines: string[] = [];
    expect(run([], (l) => lines.push(l))).toBe(64);
    expect(run(['--out', tmp(), '--seed', '3'], () => {})).toBe(0);
  });
});
