// Synthetic hourly-frames scenes for the P11b visual and e2e tests (plan §6): deterministic (a seeded PRNG, no
// Math.random, no clock), every value generated, never a real one. Writes, per scene, into <out>/<scene>/:
//   meta.json, stations.json   the public static shapes (StaticMeta, StaticStations; `now` is 3 days after the scene
//                              so its days are settled), stations = real ids from test/fixtures/reaches-fixture.json
//                              on the Rhine, Waal, IJssel and Meuse, with generated series ids (H and Q);
//   frames-<day>-v1.synthetic.json   one FramesFile (schemaVersion 2, with a toy `state` row per series) per UTC day;
//   <file minus .json>.meta.json     { synthetic: true, seed, scene } for each of them.
// Scenes: `flood` (a wave travelling downstream over 3 days, H and Q rising then falling) and `dst` (2026-10-24…26:
// the day file of 2026-10-25 holds both 00:00Z and 01:00Z, the hours of the local clock change, with distinct values).
//   node scripts/synthesize-frames.ts --out <dir> [--seed <n>]
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DAY_MS, dayOf } from '../packages/contracts/src/static.ts';

const root = new URL('..', import.meta.url).pathname;
const HOUR = 3_600_000;
const SOURCE = 'NL-1';
const RIVERS = ['rhine', 'waal', 'ijssel', 'meuse'];

export const SCENES = {
  flood: { first: '2026-10-10', days: 3 },
  dst: { first: '2026-10-24', days: 3 },
} as const;
/** The limits of the toy state ladder: a value under the first limit is low (1), over the last extreme (5). */
const LADDER = { H: [255, 350, 450, 550], Q: [1900, 3500, 5000, 6500] } as const;
export type Scene = keyof typeof SCENES;

/** mulberry32: a 32-bit seeded PRNG in [0, 1). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The first 16 hex digits of the sha256 of the series ids joined by ',' (the publisher's `seriesHash`). */
const seriesHash = (ids: readonly number[]): string =>
  createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 16);

type FixtureStation = { id: string; river_id: string; km_to_nl_entry: number | null };

/** The fixture's stations on the four rivers that have a position, sorted by id. */
export function sceneStations(): FixtureStation[] {
  const f = JSON.parse(readFileSync(join(root, 'test/fixtures/reaches-fixture.json'), 'utf8')) as {
    stations: FixtureStation[];
  };
  return f.stations
    .filter((s) => RIVERS.includes(s.river_id) && s.km_to_nl_entry !== null)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const entry = {
  source: SOURCE,
  lang: 'en',
  text: 'Synthetic test data, not a measurement',
  url: null,
  required: false,
  dateKind: null,
  date: null,
  dateText: null,
};
const json = (x: unknown) => `${JSON.stringify(x)}\n`;

export function synthesize(out: string, seed: number): string[] {
  const written: string[] = [];
  const stations = sceneStations();
  const kms = stations.map((s) => s.km_to_nl_entry as number);
  const far = Math.max(...kms);
  const span = far - Math.min(...kms);
  // Series ids: H = 1000 + 2i, Q = 1001 + 2i, i over the stations by id, so a file's ascending ids are the station order.
  const apiStations = stations.map((s, i) => ({
    id: s.id,
    name: `Synthetic ${s.id}`,
    waterName: s.river_id,
    country: s.id.slice(0, 2).toUpperCase(),
    lon: null,
    lat: null,
    tier: 1,
    flags: { tidal: null, impounded: null },
    series: [
      { id: 1000 + 2 * i, q: 'H' },
      { id: 1001 + 2 * i, q: 'Q' },
    ].map((x) => ({
      id: x.id,
      source: SOURCE,
      quantity: x.q,
      valueKind: x.q === 'H' ? 'stage' : null,
      unit: x.q === 'H' ? 'cm' : 'm³/s',
      datum: null,
      nativeUnit: x.q === 'H' ? 'cm' : 'm³/s',
      expectedStepSeconds: 600,
      stalenessLimitSeconds: 21_600,
      dataSince: null,
      api: true,
    })),
  }));
  const ids = apiStations.flatMap((s) => s.series.map((x) => x.id));

  for (const scene of Object.keys(SCENES) as Scene[]) {
    const { first, days } = SCENES[scene];
    const dir = join(out, scene);
    mkdirSync(dir, { recursive: true });
    const put = (name: string, body: unknown) => {
      writeFileSync(join(dir, name), json(body));
      writeFileSync(join(dir, `${name.replace(/\.json$/, '')}.meta.json`), json({ synthetic: true, seed, scene }));
      written.push(join(scene, name));
    };
    const start = Date.parse(`${first}T00:00:00Z`);
    const now = `${dayOf(start + (days + 3) * DAY_MS)}T12:00:00Z`;
    const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
    put('meta.json', {
      now,
      dataEpoch: iso(start - 30 * DAY_MS),
      displayStart: iso(start - DAY_MS),
      build: 'dev',
      sources: [
        { id: SOURCE, attribution: [{ lang: 'en', text: entry.text, url: null, required: false, needsDate: false }] },
      ],
      forecastHorizons: [],
      schemaVersion: 1,
      generatedAt: now,
      dayVersions: {},
      degraded: false,
      latestFrom: null,
      attribution: [entry],
    });
    put('stations.json', {
      schemaVersion: 2,
      seriesHash: seriesHash(ids),
      stations: apiStations,
      attribution: [entry],
    });

    const rand = prng(seed + (scene === 'flood' ? 1 : 2));
    // One wave per station: it peaks at hour 12 plus its delay, up to 36 h for the most downstream station.
    const wave = stations.map((s) => ({
      delay: (36 * (far - (s.km_to_nl_entry as number))) / span,
      size: 0.6 + 0.4 * rand(),
    }));
    for (let d = 0; d < days; d += 1) {
      const from = start + d * DAY_MS;
      const vlast: (number | null)[][] = [];
      stations.forEach((_, i) => {
        for (const q of ['H', 'Q'] as const) {
          const w = wave[i] as { delay: number; size: number };
          const row: (number | null)[] = [];
          for (let h = 0; h < 24; h += 1) {
            const t = d * 24 + h;
            const bump = Math.exp(-(((t - 12 - w.delay) / 10) ** 2)) * w.size;
            const v = q === 'H' ? 250 + 300 * bump + 2 * rand() : 1800 + 5200 * bump + 20 * rand();
            // A rare empty hour, so the carry rule and the null path are in the fixtures too.
            const gap = rand() < 0.02;
            row.push(gap ? null : Math.round(v * 100) / 100);
          }
          vlast.push(row);
        }
      });
      // Distinct hours at the DST night: 00:00Z and 01:00Z of the day file never share a value.
      for (const row of vlast) if (typeof row[0] === 'number' && row[0] === row[1]) row[1] = row[0] + 0.01;
      // The toy ladder of the scene (no_ref 0 is never used): codes 1 (low) to 5 (extreme) by fixed thresholds of the
      // value, H in cm then Q in m3/s alternately; null exactly where the value is null. No section bit.
      const state = vlast.map((row, r) =>
        row.map((v) => (v === null ? null : LADDER[r % 2 === 0 ? 'H' : 'Q'].filter((limit) => v >= limit).length + 1)),
      );
      // (the file name's v1 is the DAY version, not the schema)
      put(`frames-${dayOf(from)}-v1.synthetic.json`, {
        schemaVersion: 2,
        from: iso(from),
        to: iso(from + 24 * HOUR),
        stepSeconds: 3600,
        series: ids,
        vlast,
        state,
        attribution: [entry],
      });
    }
  }
  return written;
}

export function run(argv: string[], log: (line: string) => void = console.log): number {
  let out: string | undefined;
  let seed = 11;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && argv[i + 1] !== undefined) out = argv[++i];
    else if (argv[i] === '--seed' && argv[i + 1] !== undefined) seed = Number(argv[++i]);
    else out = undefined;
  }
  if (out === undefined || !Number.isInteger(seed)) {
    log('usage: node scripts/synthesize-frames.ts --out <dir> [--seed <n>]');
    return 64;
  }
  for (const f of synthesize(resolve(out), seed)) log(f);
  return 0;
}

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
