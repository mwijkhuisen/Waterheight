import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CANARIES, CANARY_RENDERINGS } from '../packages/contracts/src/canaries.ts';

// P20a (issue #68): the storm drill's expected.json (deploy/tests/storm/), its checker (deploy/tests/e2e/storm-check.mjs,
// run in the server image with no network) and its driver (deploy/tests/storm/run.sh), tested offline. Also the flood
// drill's owner canary list, which no test pinned to canaries.ts until now.

const ROOT = new URL('../', import.meta.url);
const json = (path: string) => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'));
const text = (path: string) => readFileSync(new URL(path, ROOT), 'utf8');

type Tide = { astro: number | null; surge: number | null; derived: 'surge'; extremes: unknown[] } | null;
type Latest = {
  t: string;
  series: number[];
  value: number[];
  state: string[];
  basis: (number | null)[];
  bases: { source: string; kind: string; label: string; ref: string }[];
  tide?: Tide[];
};
type Stations = {
  stations: { id: string; flags: { tidal: boolean | null }; series: { id: number; quantity: string }[] }[];
};
type Entries = Iterable<[string, Buffer | null]>;
type Mod = {
  locate(latest: Latest | null, stations: Stations | null, e: Expected): { i: number } | null;
  checkLatest(latest: Latest | null, stations: Stations | null, e: Expected): string[];
  checkStations(stations: Stations | null, e: Expected): string[];
  checkRecent(recent: Latest | null, latest: Latest | null, stations: Stations | null, e: Expected): string[];
  canaryProblems(publicEntries: Entries, ownerEntries: Entries, canary: string[]): string[];
  entries(dir: string): Entries;
  recentPathOf(t: number): string;
};
type Expected = {
  station: { id: string; quantity: string };
  state: string;
  value: number;
  tide: { astro: number; surge: number; derived: string };
  basis: { source: string; kind: string; label: string };
  surgeUpFrom: number;
  canary: string[];
};

const expected: Expected = json('deploy/tests/storm/expected.json');
let m: Mod;
beforeAll(async () => {
  // A dynamic import: the script is plain JavaScript with no declarations.
  m = (await import(new URL('deploy/tests/e2e/storm-check.mjs', ROOT).href)) as Mod;
});

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

describe('the canary lists of the drills are the ones of canaries.ts', () => {
  it('the storm drill scans for all four renderings, owner canary first', () => {
    expect(expected.canary).toEqual([...CANARY_RENDERINGS]);
    expect(expected.canary).toHaveLength(4);
  });

  it('the flood drill expects the owner canary in the owner tree under both of its renderings', () => {
    const flood = json('deploy/tests/flood/expected.json');
    expect(flood.owner.canary).toEqual([CANARIES.owner.text, CANARIES.owner.real]);
  });
});

describe('expected.json against the NL-4 thresholds', () => {
  it('333 cm = astro 83 + surge 250 is in the Stormvloed band of Den Helder and below the Extreem one', () => {
    expect(expected.value).toBe(expected.tide.astro + expected.tide.surge);
    const rows = text('registry/thresholds/nl-4.csv')
      .split('\n')
      .filter((l) => l.startsWith('denhelder.marsdiep,'))
      .map((l) => l.split(','));
    // provider code, quantity, season, from, to, label, lower, upper, ...
    const row = rows.find((r) => r[5] === expected.basis.label);
    expect(row, expected.basis.label).toBeDefined();
    expect(expected.value).toBeGreaterThan(Number(row?.[6]));
    expect(expected.value).toBeLessThanOrEqual(Number(row?.[7]));
    expect(expected.station.id).toBe('nl.rws.denhelder.marsdiep');
    expect(expected.surgeUpFrom).toBe(50);
  });
});

// --- storm-check.mjs on small in-memory trees ----------------------------------------------------------------------

const DH = 11;
const stations = (tidal: boolean | null = true): Stations => ({
  stations: [
    { id: 'nl.rws.other', flags: { tidal: false }, series: [{ id: 7, quantity: 'H' }] },
    { id: expected.station.id, flags: { tidal }, series: [{ id: DH, quantity: 'H' }] },
  ],
});
/** latest.json or a recent file as columns: series 7 (not ours) and Den Helder at the storm. */
const snapshot = (
  over: Partial<{ state: string; value: number; tide: Tide; label: string; t: string }> = {},
): Latest => ({
  t: over.t ?? '2026-10-23T12:00:00.000Z',
  series: [7, DH],
  value: [300, over.value ?? 333],
  state: ['high', over.state ?? 'high'],
  basis: [null, 0],
  bases: [{ source: 'NL-4', kind: 'provider_class', ref: 'Stormvloed', label: over.label ?? 'Stormvloed (> 260cm)' }],
  tide: [null, 'tide' in over ? (over.tide ?? null) : { astro: 83, surge: 250, derived: 'surge', extremes: [] }],
});

describe('storm-check.mjs: the Den Helder checks', () => {
  it('passes on latest.json at the storm high, stations.json and the recent bucket file', () => {
    expect(m.checkLatest(snapshot(), stations(), expected)).toEqual([]);
    expect(m.checkStations(stations(), expected)).toEqual([]);
    expect(m.checkRecent(snapshot(), snapshot(), stations(), expected)).toEqual([]);
  });

  it('fails on the seed value alone: the state is high there too, but the tide is missing (never wait on the state)', () => {
    const seed = snapshot({ value: 320, tide: null });
    expect(m.checkLatest(seed, stations(), expected)).toEqual(
      expect.arrayContaining(['value 320, expected 333', 'no tide']),
    );
  });

  it('fails on a wrong surge, an underived tide sum, a wrong state and a wrong basis, each with its own code', () => {
    const wrongSurge = snapshot({ value: 300, tide: { astro: 83, surge: 217, derived: 'surge', extremes: [] } });
    expect(m.checkLatest(wrongSurge, stations(), expected)).toEqual(
      expect.arrayContaining(['surge 217, expected 250']),
    );
    const notSum = snapshot({ tide: { astro: 80, surge: 250, derived: 'surge', extremes: [] } });
    expect(m.checkLatest(notSum, stations(), expected)).toEqual(
      expect.arrayContaining(['astro 80, expected 83', 'value is not astro + surge']),
    );
    expect(m.checkLatest(snapshot({ state: 'extreme' }), stations(), expected)).toEqual([
      'state extreme, expected high',
    ]);
    expect(m.checkLatest(snapshot({ label: 'Extreem hoogwater (> 345cm)' }), stations(), expected)[0]).toContain(
      'basis NL-4',
    );
  });

  it('fails when the station or its series is not in the file, and on a missing file', () => {
    expect(
      m.checkLatest(
        { ...snapshot(), series: [7], value: [300], state: ['high'], basis: [null], tide: [null] },
        stations(),
        expected,
      ),
    ).toEqual([`${expected.station.id}: no H series in latest.json`]);
    expect(m.checkLatest(null, stations(), expected)).toEqual(['no latest.json or stations.json']);
    expect(m.checkStations(null, expected)).toEqual(['no stations.json']);
    expect(m.checkStations({ stations: [] }, expected)).toEqual([`${expected.station.id}: not in stations.json`]);
  });

  it('flags a station that is not tidal (the hatch input)', () => {
    expect(m.checkStations(stations(false), expected)).toEqual([`${expected.station.id}: flags.tidal is not true`]);
    expect(m.checkStations(stations(null), expected)).toEqual([`${expected.station.id}: flags.tidal is not true`]);
  });

  it('checks the recent bucket file: the same bucket, the same value and surge', () => {
    expect(m.checkRecent(null, snapshot(), stations(), expected)).toEqual([
      'no recent bucket file for the current bucket',
    ]);
    expect(m.checkRecent(snapshot({ t: '2026-10-23T11:50:00.000Z' }), snapshot(), stations(), expected)).toEqual([
      'the recent file is not at the bucket of latest.json',
    ]);
    const old = snapshot({ value: 320, tide: null });
    expect(m.checkRecent(old, snapshot(), stations(), expected)).toEqual([
      'recent value 320, expected 333',
      'recent surge null, expected 250',
    ]);
  });

  it("the recent file path is the publisher's (recent/YYYY-MM-DD/HHmm.json)", () => {
    expect(m.recentPathOf(Date.parse('2026-10-23T12:10:00Z'))).toBe('recent/2026-10-23/1210.json');
  });
});

const buf = (s: string) => Buffer.from(s);
const owner: [string, Buffer][] = [['owner/latest.json', buf(`{"value":[${CANARIES.owner.real}]}`)]];

describe('storm-check.mjs: the canary scan', () => {
  it('passes when no public file holds a rendering and the owner tree holds the owner canary', () => {
    expect(
      m.canaryProblems(
        [
          ['a.json', buf('{"x":1}')],
          ['b.json', buf('{}')],
        ],
        owner,
        expected.canary,
      ),
    ).toEqual([]);
  });

  it.each(CANARY_RENDERINGS)('fails on a public file holding %s', (c) => {
    const bad = m.canaryProblems(
      [
        ['a.json', buf('{}')],
        ['v1/deep.json', buf(`[${c}]`)],
      ],
      owner,
      expected.canary,
    );
    expect(bad).toEqual(['a public file holds a canary rendering (v1/deep.json)']);
  });

  it('fails when nothing was scanned, a file is unreadable, or the owner tree lacks the owner canary', () => {
    expect(m.canaryProblems([], owner, expected.canary)).toEqual(['no public file was scanned']);
    expect(m.canaryProblems([['a.json', null]], owner, expected.canary)).toEqual(['unreadable public file a.json']);
    expect(m.canaryProblems([['a.json', buf('{}')]], [['o.json', buf('{}')]], expected.canary)).toEqual([
      'no owner file holds the owner canary',
    ]);
    // The withheld canary in the owner tree is not the owner canary.
    expect(
      m.canaryProblems([['a.json', buf('{}')]], [['o.json', buf(CANARIES.withheld.text)]], expected.canary),
    ).toEqual(['no owner file holds the owner canary']);
  });

  it('reads a tree on disk: compressed siblings are decompressed, so a canary hidden in a .gz or .zst is found', () => {
    const dir = mkdtempSync(join(tmpdir(), 'storm-check-'));
    tmp.push(dir);
    mkdirSync(join(dir, 'public/v1/recent'), { recursive: true });
    mkdirSync(join(dir, 'owner/v1'), { recursive: true });
    writeFileSync(join(dir, 'public/v1/latest.json'), '{"value":[1]}');
    writeFileSync(join(dir, 'owner/v1/latest.json'), `{"value":[${CANARIES.owner.text}]}`);
    const clean = () =>
      m.canaryProblems(m.entries(join(dir, 'public')), m.entries(join(dir, 'owner')), expected.canary);
    expect(clean()).toEqual([]);
    writeFileSync(join(dir, 'public/v1/recent/1210.json.gz'), gzipSync(`[${CANARIES.withheld.real}]`));
    expect(clean()).toEqual([`a public file holds a canary rendering (${join(dir, 'public/v1/recent/1210.json.gz')})`]);
    rmSync(join(dir, 'public/v1/recent/1210.json.gz'));
    writeFileSync(join(dir, 'public/v1/recent/1220.json.zst'), zstdCompressSync(`[${CANARIES.owner.real}]`));
    expect(clean()).toEqual([
      `a public file holds a canary rendering (${join(dir, 'public/v1/recent/1220.json.zst')})`,
    ]);
    // A damaged compressed file is a failure, not a pass.
    writeFileSync(join(dir, 'public/v1/recent/1220.json.zst'), 'not zstd');
    expect(clean()).toEqual([`unreadable public file ${join(dir, 'public/v1/recent/1220.json.zst')}`]);
  });
});

// --- the driver, the spec and the workflow --------------------------------------------------------------------------

describe('the storm drill is wired the way the issue asks', () => {
  const run = text('deploy/tests/storm/run.sh');

  it('run.sh: replay, wait on the surge, check, publisher keeps up, Playwright, then the degraded mode, in that order', () => {
    const order = [
      'scripts/flood-drill" --phase storm',
      'wait_for "tide.surge 250',
      '"$server_image" /storm-check.mjs',
      'E2E_SPEC=storm-drill',
      'rws_compose stop api',
      'x-degraded: 1',
      'wait_for "api healthy again"',
      'The publisher kept up for the whole window',
    ].map((part) => {
      expect(run, part).toContain(part);
      return run.indexOf(part);
    });
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(run).toContain('--project=chromium');
    expect(run).toContain('.publisher.cycleSeconds');
    expect(run).toContain('((maxcyc <= 60))');
    expect(run).toContain('((age > 120))');
    expect(run).toContain('^PASS storm-check$');
    expect(run).toContain('WROTE a missing baseline');
  });

  it('run.sh starts the api again on any failure after the stop (a trap), and sources rws-lib.sh', () => {
    expect(run).toMatch(/trap\s+\S+\s+EXIT/);
    expect(run).toContain('deploy/bin/rws-lib.sh');
  });

  it('the Playwright config leaves storm-drill to the compose job and selects it by E2E_SPEC', () => {
    const config = text('apps/web/e2e/playwright.config.ts');
    expect(config).toMatch(/PUBLIC_IGNORE =\s*\/[^\n]*storm-drill/);
    // COMPOSE_SPEC matches a spec file by the name E2E_SPEC gives: storm-drill.spec.ts must exist.
    expect(text('apps/web/e2e/storm-drill.spec.ts')).toContain('storm-drill-denhelder.png');
  });

  it('loadtest.yml: the drill job runs the k6 storm scenario beside storm/run.sh in a step after the flood step', () => {
    const wf = text('.github/workflows/loadtest.yml');
    const drill = wf.slice(wf.indexOf('\n  drill:'), wf.indexOf('\n  chaos:'));
    expect(drill).toMatch(/STORM_DURATION: \d+m/);
    const flood = drill.indexOf('- name: Flood drill with the k6 flood scenario');
    const storm = drill.indexOf('- name: Storm drill with the k6 storm scenario');
    const next = drill.indexOf('- name: No container OOM-killed');
    expect(flood).toBeGreaterThan(0);
    expect(storm).toBeGreaterThan(flood);
    expect(next).toBeGreaterThan(storm);
    const step = drill.slice(storm, next);
    expect(step).toContain('SCENARIO=storm "DURATION=$STORM_DURATION" "MAP_ASSETS=$assets"');
    expect(step).toContain('sudo --preserve-env=PLAYWRIGHT_IMAGE deploy/tests/storm/run.sh');
    expect(step).toContain('((drill_rc == 0 && k6_rc == 0))');
    // No expression inside a run: block (zizmor).
    expect(step).not.toContain('${{');
  });
});
