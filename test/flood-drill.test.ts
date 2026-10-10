import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { LAYOUT_DE } from '../apps/server/src/adapters/ch-4/normalise.ts';
import { ManifestLine } from '../apps/server/src/archive/manifest.ts';
import { ArchiveReader } from '../apps/server/src/archive/reader.ts';
import { sha256 } from '../apps/server/src/archive/writer.ts';
import { E2E_DOMAIN, MARKER, main, plan, refusal, SCENES, writeDrill } from '../scripts/flood-drill.ts';
import { deriveLevel4, RAISED } from '../scripts/lib/shift-fr5.ts';
import {
  anchorCap,
  anchorDe2,
  anchorDe6,
  anchorDe6Events,
  CIARAN_DE,
  CIARAN_IT,
} from '../scripts/lib/shift-sources.ts';

// scripts/flood-drill.ts (P12a, issue #27): where it refuses to run, what it plans and what it writes.

const ROOT = new URL('../', import.meta.url);
const FIXTURES = new URL('apps/server/src/adapters/', ROOT);
const NOW = Date.parse('2026-10-12T10:00:00Z');
const GOOD_ENV = { RWS_E2E: '1', RWS_E2E_DOMAIN: E2E_DOMAIN };
const marker = (m: object | string) => (path: string) =>
  path === MARKER ? (typeof m === 'string' ? m : JSON.stringify(m)) : null;
const stack = marker({ mode: 'drill', domain: E2E_DOMAIN });

const tmp: string[] = [];
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), 'flood-drill-'));
  tmp.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

describe('refusal', () => {
  it('runs only in the drill stack: RWS_E2E=1, /ci/e2e-stack with mode drill and the e2e domain, the same domain in the environment', () => {
    expect(refusal(GOOD_ENV, stack)).toBeNull();
  });

  it('refuses without RWS_E2E=1 (a production host never has it), whatever else is right', () => {
    for (const env of [
      {},
      { RWS_E2E_DOMAIN: E2E_DOMAIN },
      { ...GOOD_ENV, RWS_E2E: '0' },
      { ...GOOD_ENV, RWS_E2E: 'true' },
    ])
      expect(refusal(env, stack)).toMatch(/RWS_E2E=1/);
  });

  it('refuses without the marker, with an unreadable one, another mode (loadtest, chaos, none) or another domain', () => {
    expect(refusal(GOOD_ENV, () => null)).toMatch(/does not exist/);
    expect(refusal(GOOD_ENV, marker('not json'))).toMatch(/not JSON/);
    expect(refusal(GOOD_ENV, marker('null'))).toMatch(/mode drill/);
    for (const mode of ['loadtest', 'chaos', '', undefined])
      expect(refusal(GOOD_ENV, marker({ mode, domain: E2E_DOMAIN }))).toMatch(/mode drill/);
    expect(refusal(GOOD_ENV, marker({ mode: 'drill', domain: 'example.org' }))).toMatch(/domain/);
    expect(refusal(GOOD_ENV, marker({ mode: 'drill' }))).toMatch(/domain/);
    expect(refusal({ RWS_E2E: '1' }, stack)).toMatch(/RWS_E2E_DOMAIN/);
    expect(refusal({ RWS_E2E: '1', RWS_E2E_DOMAIN: 'example.org' }, stack)).toMatch(/RWS_E2E_DOMAIN/);
  });

  it('echoes nothing of the environment or the marker', () => {
    const secret = 'sentinel-value-0123456789';
    const why = refusal({ RWS_E2E: '1', RWS_E2E_DOMAIN: secret }, marker({ mode: 'drill', domain: secret })) ?? '';
    expect(why).not.toContain(secret);
  });

  it('the command line stops at the refusal: exit 78 and nothing written', async () => {
    const raw = dir();
    expect(await main([raw], {}, stack)).toBe(78);
    expect(await main([raw], GOOD_ENV, () => null)).toBe(78);
    expect(readdirSync(raw)).toEqual([]);
  });

  it('the sh wrapper refuses here (no RWS_E2E, no /ci/e2e-stack) before it starts a container', () => {
    let status = 0;
    let stderr = '';
    try {
      execFileSync(new URL('scripts/flood-drill', ROOT).pathname, [], {
        stdio: 'pipe',
        env: { PATH: process.env.PATH },
      });
    } catch (err) {
      status = (err as { status: number }).status;
      stderr = String((err as { stderr: Buffer }).stderr);
    }
    expect([status, stderr]).toEqual([78, 'flood-drill: refused: RWS_E2E=1 is not set\n']);
  });

  it('usage errors are 64: an unknown option, a bad phase, a bad or distant --now', async () => {
    const raw = dir();
    const clock = () => NOW;
    for (const argv of [
      ['--nope'],
      ['--phase', 'x'],
      ['--phase'],
      ['--now', 'soon'],
      ['--now', '2026-10-12T14:00:00Z'],
      ['--now', '2026-10-12T05:00:00Z'],
    ])
      expect([argv, await main([...argv, raw], GOOD_ENV, stack, clock)]).toEqual([argv, 64]);
    expect(readdirSync(raw)).toEqual([]);
  });
});

describe('the scenes', () => {
  const planned = plan(NOW);

  it('are the set of the issue: DE-6 (test server, class 4, class-less, alerts), FR-5, the AGE alerts with Cancel and TEST, CH-4 Ciaran, DE-2', () => {
    expect(SCENES.map((s) => s.fixture)).toEqual([
      'de-6-stations-test',
      'de-6-stations-class4.synthetic',
      'de-6-stations-classless.synthetic',
      'de-6-alerts-test',
      'fr-5-vigilance-level4.synthetic',
      'lu-5-cap-20250908-231502-alert-lvl1',
      'lu-5-cap-20250908-231507-alert-lvl2',
      'lu-5-cap-20250909-080450-cancel',
      'lu-5-cap-20260202-095833-alert-test',
      'ch-4-forecast-ciaran-it',
      'de-2-wv-truncated.synthetic',
    ]);
    expect(SCENES.filter((s) => s.phase === 'cancel').map((s) => s.fixture)).toEqual([
      'lu-5-cap-20250909-080450-cancel',
      'lu-5-cap-20260202-095833-alert-test',
    ]);
    expect(SCENES.filter((s) => s.owner).map((s) => s.source)).toEqual(['DE-2']);
  });

  it('put each payload\'s anchor "lead" before the drill clock, none after it (invariant 4), by one offset per payload', () => {
    for (const p of planned) {
      expect(p.placed).toBe(NOW - p.scene.leadMs);
      expect(p.placed).toBeLessThanOrEqual(NOW);
    }
    // The AGE messages share one offset (the distance between the alert and its Cancel is the recorded one).
    const age = planned.filter((p) => p.scene.fixture.startsWith('lu-5-cap-2025'));
    expect(new Set(age.map((p) => p.deltaMs)).size).toBe(1);
  });

  it('shifted bodies state their anchor where the drill put it (and never after the fetch)', () => {
    const at = (fixture: string) => planned.find((p) => p.scene.fixture === fixture) as (typeof planned)[number];
    for (const f of ['de-6-stations-class4.synthetic', 'de-6-stations-classless.synthetic', 'de-6-alerts-test'])
      expect(anchorDe6(at(f).body)).toBe(at(f).placed);
    // The test server's answer is dated 30 minutes ago, its newest reading (the flood of 2024) 35 minutes ago.
    expect(anchorDe6(at('de-6-stations-test').body)).toBe(NOW - 30 * 60_000);
    expect(anchorDe6Events(at('de-6-stations-test').body)).toBe(NOW - 35 * 60_000);
    expect(at('de-6-stations-test').placed).toBe(NOW - 35 * 60_000);
    expect(anchorCap(at('lu-5-cap-20250908-231502-alert-lvl1').body)).toBe(NOW - 9 * 3600_000);
    expect(anchorCap(at('lu-5-cap-20260202-095833-alert-test').body)).toBe(NOW - 5 * 60_000);
    expect(anchorDe2(at('de-2-wv-truncated.synthetic').body)).toBe(NOW - 10 * 60_000);
    // Every CAP `sent` of the drill is before the fetch; the Cancel is after the alert it closes and before the drill clock.
    expect(anchorCap(at('lu-5-cap-20250909-080450-cancel').body)).toBeLessThan(NOW);
    expect(anchorCap(at('lu-5-cap-20250909-080450-cancel').body)).toBeGreaterThan(
      anchorCap(at('lu-5-cap-20250908-231507-alert-lvl2').body),
    );
  });

  it("only the test server's stations have two clocks: the answer is 5 minutes after its newest reading", () => {
    for (const p of planned)
      expect([p.scene.fixture, p.responseDeltaMs === p.deltaMs]).toEqual([
        p.scene.fixture,
        p.scene.fixture !== 'de-6-stations-test',
      ]);
    const test = planned.find((p) => p.scene.fixture === 'de-6-stations-test') as (typeof planned)[number];
    expect(test.deltaMs - test.responseDeltaMs).not.toBe(0);
  });

  it('the Cancel and the TEST message come after the alert is open: they are the cancel phase', () => {
    expect(plan(NOW, 'main').length).toBe(9);
    expect(plan(NOW, 'cancel').length).toBe(2);
    expect(plan(NOW, 'all').length).toBe(11);
  });

  it('are deterministic: the same clock gives the same bytes, another clock other bytes', () => {
    expect(plan(NOW).map((p) => sha256(p.body))).toEqual(planned.map((p) => sha256(p.body)));
    expect(plan(NOW + 60_000).map((p) => sha256(p.body))).not.toEqual(planned.map((p) => sha256(p.body)));
  });

  it('the CH-4 scene is the German figure production fetches, the DE-2 scene is owner audience and synthetic', () => {
    const ch4 = planned.find((p) => p.scene.source === 'CH-4') as (typeof planned)[number];
    expect(ch4.variant).toBe('2020');
    expect(ch4.url).toBe('https://www.hydrodaten.admin.ch/plots/q_forecast/2020_q_forecast_de.json');
    expect(
      (JSON.parse(ch4.body.toString('utf8')) as { plot: { data: { name: string }[] } }).plot.data.map((t) => t.name),
    ).toEqual([...LAYOUT_DE]);
    expect([...CIARAN_DE]).toEqual([...LAYOUT_DE]);
    const meta = JSON.parse(
      readFileSync(new URL('de-2/fixtures/de-2-wv-truncated.synthetic.meta.json', FIXTURES), 'utf8'),
    ) as { synthetic: boolean };
    expect(meta.synthetic).toBe(true);
    const de2 = planned.find((p) => p.scene.source === 'DE-2') as (typeof planned)[number];
    expect(de2.scene.owner).toBe(true);
    expect(de2.url).toMatch(
      /^https:\/\/www\.pegelonline\.wsv\.de\/webservices\/rest-api\/v2\/stations\/[0-9a-f-]{36}\/WV\/measurements\.json$/,
    );
  });
});

describe('the new fixtures', () => {
  it('fr-5-vigilance-level4.synthetic is exactly what shift-fr5.ts derives from the recorded archive map', () => {
    const archive = readFileSync(new URL('fr-5/fixtures/fr-5-vigilance-archive.raw', FIXTURES));
    const committed = readFileSync(new URL('fr-5/fixtures/fr-5-vigilance-level4.synthetic.raw', FIXTURES));
    expect(sha256(deriveLevel4(archive))).toBe(sha256(committed));
    const meta = JSON.parse(
      readFileSync(new URL('fr-5/fixtures/fr-5-vigilance-level4.synthetic.meta.json', FIXTURES), 'utf8'),
    ) as Record<string, unknown>;
    expect(meta).toMatchObject({ spec: 'fr-5-vigilance', source: 'FR-5', synthetic: true, status: 200 });
    expect(meta.bytes).toBe(committed.length);
    expect('recorded_at' in meta || 'from' in meta).toBe(false);
  });

  it('it is the Wayback structure: old property spelling, null feature ids, no map time, five raised sections', () => {
    const doc = JSON.parse(
      readFileSync(new URL('fr-5/fixtures/fr-5-vigilance-level4.synthetic.raw', FIXTURES), 'utf8'),
    ) as { name: string; features: { id: unknown; properties: Record<string, unknown> }[] } & Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(['type', 'name', 'bbox', 'features']);
    expect(doc.features).toHaveLength(56);
    expect(doc.features.every((f) => f.id === null && 'LbEntCru' in f.properties && 'TypEnSup_1' in f.properties)).toBe(
      true,
    );
    const raised = Object.fromEntries(
      doc.features
        .filter((f) => f.properties.NivInfViCr !== 1)
        .map((f) => [f.properties.CdEntCru, f.properties.NivInfViCr]),
    );
    expect(raised).toEqual(RAISED);
    const wayback = JSON.parse(readFileSync(new URL('fr-5/fixtures/fr-5-vigilance-wayback.raw', FIXTURES), 'utf8')) as {
      features: { properties: Record<string, unknown> }[];
    };
    expect(Object.keys(doc.features[0]?.properties ?? {})).toEqual(Object.keys(wayback.features[0]?.properties ?? {}));
  });

  it('the Ciaran conversion names the recorded traces and the German layout of the adapter', () => {
    const doc = JSON.parse(readFileSync(new URL('ch-4/fixtures/ch-4-forecast-ciaran-it.raw', FIXTURES), 'utf8')) as {
      plot: { data: { name: string }[] };
    };
    expect(doc.plot.data.map((t) => t.name)).toEqual([...CIARAN_IT]);
  });
});

describe('writeDrill', () => {
  it("writes one object and one valid manifest line per payload, fetched at the drill clock, through the recorder's Archive", async () => {
    const raw = dir();
    const lines = await writeDrill({ rawDir: raw, now: NOW });
    expect(lines).toHaveLength(11);
    const reader = new ArchiveReader(raw);
    const files = await reader.manifests();
    expect(files.map((f) => f.file)).toEqual(['2026-10-12.jsonl']);
    const text = readFileSync(join(raw, '_manifest', '2026-10-12.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(text).toHaveLength(11);
    const planned = plan(NOW);
    for (const [i, t] of text.entries()) {
      const line = ManifestLine.parse(JSON.parse(t));
      const p = planned[i] as (typeof planned)[number];
      expect(line).toMatchObject({
        source: p.scene.source,
        spec: p.scene.spec,
        variant: p.variant,
        status: 200,
        retention: 'forever',
        gate: { kind: 'hash', open: true },
        validity: { ok: true },
        fetched_at: { start: '2026-10-12T09:59:59.000Z', end: '2026-10-12T10:00:00.000Z' },
      });
      expect(line.seed).toBeUndefined();
      const body = await reader.readObject(line.key as string);
      expect(sha256(body)).toBe(line.sha256);
      expect(body.equals(p.body)).toBe(true);
    }
  });

  it('the cancel phase is fetched later and appends to the same manifest; lines fetched before the drill clock are refused', async () => {
    const raw = dir();
    await writeDrill({ rawDir: raw, now: NOW, phase: 'main' });
    const lines = await writeDrill({ rawDir: raw, now: NOW, phase: 'cancel', fetchedAt: NOW + 600_000 });
    expect(lines.map((l) => l.fetched_at.end)).toEqual(['2026-10-12T10:10:00.000Z', '2026-10-12T10:10:00.000Z']);
    expect(
      readFileSync(join(raw, '_manifest', '2026-10-12.jsonl'), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(11);
    await expect(writeDrill({ rawDir: dir(), now: NOW, fetchedAt: NOW - 1000 })).rejects.toThrow();
  });

  it('through the command line: a stack that says drill gets the lines, in the recorder modes', async () => {
    const raw = dir();
    const log: string[] = [];
    const orig = console.log;
    console.log = (m: string) => log.push(m);
    try {
      expect(
        await main(['--phase', 'main', '--now', new Date(NOW).toISOString(), raw], GOOD_ENV, stack, () => NOW + 3000),
      ).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(log.join('\n')).toMatch(/9 manifest lines \(9 payloads\), phase main, drill clock 2026-10-12T10:00:00.000Z/);
    expect(readdirSync(join(raw, '_manifest'))).toEqual(['2026-10-12.jsonl']);
    // The recorder's modes: nothing for others (the loader reads as the owner or the group).
    expect(statSync(join(raw, '_manifest', '2026-10-12.jsonl')).mode & 0o007).toBe(0);
    expect(statSync(join(raw, '_manifest')).mode & 0o007).toBe(0);
  });
});

// Each test copies the whole of registry/ (thousands of files): 5 s is too short on a busy CI runner.
describe('setup.sh (the drill registry)', { timeout: 30_000 }, () => {
  const run = (repo: string, out: string) => {
    try {
      const stdout = execFileSync(new URL('deploy/tests/flood/setup.sh', ROOT).pathname, [out, repo], {
        stdio: 'pipe',
      });
      return { status: 0, out: String(stdout) };
    } catch (err) {
      return { status: (err as { status: number }).status, out: String((err as { stderr: Buffer }).stderr) };
    }
  };
  const repoWith = (edit: (stations: string) => string) => {
    const repo = dir();
    mkdirSync(join(repo, 'registry', 'stations'), { recursive: true });
    cpSync(new URL('registry/', ROOT).pathname, join(repo, 'registry'), { recursive: true });
    const file = join(repo, 'registry', 'stations', 'ch-1.yaml');
    writeFileSync(file, edit(readFileSync(file, 'utf8')));
    return repo;
  };

  it("copies registry/ and changes one line: station 2020's discharge series is public, its water level stays off", () => {
    const out = dir();
    const repo = new URL('./', ROOT).pathname;
    const before = readFileSync(new URL('registry/stations/ch-1.yaml', ROOT), 'utf8');
    const r = run(repo, out);
    expect(r.status).toBe(0);
    const after = readFileSync(join(out, 'registry', 'stations', 'ch-1.yaml'), 'utf8');
    const diff = after.split('\n').flatMap((l, i) => (l === before.split('\n')[i] ? [] : [[before.split('\n')[i], l]]));
    expect(diff).toEqual([['    audience: "off"', '    audience: public']]);
    // registry/ itself is untouched (the copy is elsewhere), and the rest of the copy equals it.
    expect(readFileSync(new URL('registry/stations/ch-1.yaml', ROOT), 'utf8')).toBe(before);
    expect(readFileSync(join(out, 'registry', 'sources.yaml'), 'utf8')).toBe(
      readFileSync(new URL('registry/sources.yaml', ROOT), 'utf8'),
    );
  });

  it('fails loudly when the patch no longer applies (registry/stations/ch-1.yaml changed around it)', () => {
    const repo = repoWith((s) =>
      s.replace(
        '    audience: "off"\n    datum: null\n    gauge_zero: []\n  - id: ch.bafu.2021',
        '    audience: "off"\n    datum: NULL\n    gauge_zero: []\n  - id: ch.bafu.2021',
      ),
    );
    const r = run(repo, dir());
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/registry-patch no longer applies/);
  });

  it('fails when the registry is not there or the arguments are wrong', () => {
    expect(run(dir(), dir()).status).not.toBe(0);
    let status = 0;
    try {
      execFileSync(new URL('deploy/tests/flood/setup.sh', ROOT).pathname, [], { stdio: 'pipe' });
    } catch (err) {
      status = (err as { status: number }).status;
    }
    expect(status).toBe(64);
  });
});

describe('compose.drill.yaml (the drill registry mounts)', () => {
  const read = (path: string) =>
    parseYaml(readFileSync(new URL(path, ROOT), 'utf8')) as { services: Record<string, { volumes?: string[] }> };
  const overlay = read('deploy/tests/flood/compose.drill.yaml').services;

  it('mounts the copy of the registry read-only over /app/registry of the six services that read the registry, and nothing else', () => {
    expect(Object.keys(overlay).sort()).toEqual(['api', 'api-owner', 'load', 'migrate', 'publish', 'publish-owner']);
    for (const [name, s] of Object.entries(overlay))
      expect([name, s.volumes]).toEqual([name, ['/ci/flood/registry:/app/registry:ro']]);
  });

  it("every one of them is a service of the production files, capture is not touched, and /app/registry is the server image's registry", () => {
    const prod = { ...read('deploy/compose.yaml').services, ...read('deploy/compose.owner.yaml').services };
    for (const name of Object.keys(overlay)) expect(prod[name]).toBeDefined();
    expect(overlay.capture).toBeUndefined();
    expect(readFileSync(new URL('deploy/server/Dockerfile', ROOT), 'utf8')).toMatch(/cp -r registry \/out\/registry/);
    expect(readFileSync(new URL('deploy/server/Dockerfile', ROOT), 'utf8')).toMatch(/^WORKDIR \/app$/m);
  });

  it('the registry-patch makes one change, to the one series the CH-4 run needs', () => {
    const patch = readFileSync(new URL('deploy/tests/flood/registry-patch', ROOT), 'utf8');
    expect(patch.split('\n').filter((l) => /^[-+][^-+]/.test(l))).toEqual([
      '-    audience: "off"',
      '+    audience: public',
    ]);
    expect(patch).toContain('--- a/stations/ch-1.yaml');
  });

  it('the driver script runs what the plan says: seed, drill, check, cancel, check, Playwright with E2E_SPEC=flood-drill', () => {
    const run = readFileSync(new URL('deploy/tests/flood/run.sh', ROOT), 'utf8');
    for (const part of [
      'scripts/seed-loadtest.ts --print',
      'scripts/flood-drill" --phase main',
      'check open',
      'scripts/flood-drill" --phase cancel',
      'check closed',
      'E2E_SPEC=flood-drill',
      '--project=chromium',
      'PLAYWRIGHT_IMAGE',
      '^PASS flood-check$',
    ])
      expect(run, part).toContain(part);
    expect(run.indexOf('--phase main')).toBeLessThan(run.indexOf('check open'));
    expect(run.indexOf('check open')).toBeLessThan(run.indexOf('--phase cancel'));
    expect(run.indexOf('--phase cancel')).toBeLessThan(run.indexOf('check closed'));
  });
});
