import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECKS, gateLists, ROADMAP2_CHECKS } from '../scripts/verify-prod.ts';
import { repoRoot } from './catalogue.ts';

// P20b (issue #68): the CI deploy gate (deploy/tests/e2e/verify-gate.sh) and the roadmap 2 list of verify-prod
// (ROADMAP2_CHECKS) say the same thing: a roadmap 2 check that needs live data may FAIL in CI and has its reason on its
// line of the gate; every other one must PASS. The gate itself runs here on synthetic verify-prod outputs.

const GATE = join(repoRoot, 'deploy/tests/e2e/verify-gate.sh');
const { live, required } = gateLists(readFileSync(GATE, 'utf8'));
/** The gate's `^FAIL (a|b) `: a live name excuses a FAIL of itself and of every check it starts, up to a space. */
const excused = (check: string) => [...live.keys()].some((n) => check === n || check.startsWith(`${n} `));
/** The checks before roadmap 2 that may FAIL in CI; they share one comment in the gate. */
const ROADMAP1_LIVE = [
  'freshness',
  'owner_specs',
  'health DE-1',
  'tier-1 DE-1',
  'loader lag',
  'replay DE-1',
  'health NL-1',
  'tier-1 NL-1',
  'replay NL-1',
  'health FR-1',
  'health CH-1',
  'tier-1 FR-1',
  'tier-1 CH-1',
  'coverage FR-1',
  'coverage CH-1',
  'interval CH-1',
  'belgian set',
  'fresh DE-1',
  'fresh NL-1',
  'fresh FR-1',
  'fresh CH-1',
  'api build',
  'health DE-7',
  'tier-1 DE-7',
  'coverage DE-7',
  'health LU-1',
  'tier-1 LU-1',
  'coverage LU-1',
  'interval DE-7',
  'bytes DE-7',
  'fresh DE-7',
  'fresh LU-1',
  'label offset LU-1',
  'owner health',
  'forecast NL-1',
  'forecast CH-4',
  'static settled',
  'static frames',
  'static series',
  'static lag',
  'static rerender',
];

describe('the deploy gate and ROADMAP2_CHECKS', () => {
  it('reads both lists of the gate', () => {
    expect(live.size).toBeGreaterThan(40);
    expect(required).toEqual(expect.arrayContaining(['headers /', 'owner leak', 'pages', 'og', 'method uncovered']));
  });

  it.each(ROADMAP2_CHECKS.map((c) => [c.check, c.live] as const))(
    '%s is either live with a reason or required, never neither or both',
    (check, isLive) => {
      if (isLive) {
        expect(live.get(check)).toMatch(/\w/);
        expect(required).not.toContain(check);
      } else {
        expect(required).toContain(check);
        expect(excused(check)).toBe(false);
      }
    },
  );

  it('every live check is one of roadmap 1 (no reason of its own) or a live check of ROADMAP2_CHECKS', () => {
    const roadmap2 = new Set(ROADMAP2_CHECKS.filter((c) => c.live).map((c) => c.check));
    for (const [name, reason] of live) {
      if (ROADMAP1_LIVE.includes(name)) expect(reason, name).toBeUndefined();
      else expect(roadmap2.has(name), name).toBe(true);
    }
    // The rivers checks and the download fixture need no live data (P20b): none is excused any more.
    for (const name of ['rivers manifest', 'rivers tiles', 'rivers layers', 'rivers reaches', 'rivers download']) {
      expect(required, name).toContain(name);
      expect(excused(name), name).toBe(false);
    }
  });

  it('no required check is excused by a live name', () => {
    expect(required.filter(excused)).toEqual([]);
  });
});

describe('verify-gate.sh on synthetic verify-prod outputs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'verify-gate-'));
  let n = 0;
  /** Every required check PASS (with the two `need` lines gateLists does not name), every live check FAIL. */
  const lines = () => [
    ...required.map((c) => `PASS ${c} — ok`),
    'PASS health — ok',
    'N/A  de-2 credit — DE-2 is an owner source',
    ...[...live.keys()].map((c) => `FAIL ${c} — needs live data`),
    'verify-prod: 100 checks, 50 failed (example.org, 2026-10-23T00:00:00.000Z)',
  ];
  const gate = (out: readonly string[]) => {
    n += 1;
    const file = join(dir, `out-${n}.txt`);
    writeFileSync(file, `${out.join('\n')}\n`);
    return spawnSync('bash', [GATE, file], { encoding: 'utf8' });
  };
  const without = (prefix: string) => lines().filter((l) => !l.startsWith(prefix));

  it('passes every required PASS with every live-data FAIL', () => {
    const r = gate(lines());
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^verify-gate: ok /);
  });

  it.each(['rivers layers', 'status specs', 'method uncovered', 'rivers download', 'owner leak'])(
    'fails a FAIL of %s',
    (name) => {
      const r = gate([...without(`PASS ${name} `), `FAIL ${name} — broken`]);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('failed a check other than the ones that need live data');
    },
  );

  it('fails without a PASS of method uncovered', () => {
    const r = gate(without('PASS method uncovered '));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no line matching ^PASS method uncovered ');
  });

  it('fails an unknown FAIL, and an empty output', () => {
    expect(gate([...lines(), 'FAIL something new — x']).status).toBe(1);
    expect(gate([]).status).toBe(1);
  });
});

describe('the --dry-run roadmap 2 block', () => {
  // Literal, so that deleting a check from ROADMAP2_CHECKS fails here.
  const EXPECTED: readonly (readonly [string, boolean])[] = [
    ['interval NL-1 nl-1-obs-sea', true],
    ['interval NL-1 nl-1-obs-wide', true],
    ['interval NL-1 nl-1-obs-slow', true],
    ['interval NL-1 nl-1-hwlw', true],
    ['fresh NL-1 coast', true],
    ['fresh NL-1 lakes', true],
    ['astro horizon', true],
    ['surge', true],
    ['catch-up NL-1', true],
    ['rivers manifest', false],
    ['rivers tiles', false],
    ['rivers layers', false],
    ['rivers reaches', false],
    ['status specs', false],
    ['method uncovered', false],
    ['owner leak', false],
  ];

  it('follows the CHECKS lines with one line per roadmap 2 check, each with one CHECKS line of its own', () => {
    const r = spawnSync(join(repoRoot, 'scripts/verify-prod.sh'), ['--dry-run', 'x'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    const out = r.stdout.trimEnd().split('\n');
    expect(out.indexOf('roadmap 2 (P20b):')).toBe(CHECKS.length);
    const block = out.slice(CHECKS.length + 1);
    expect(block).toHaveLength(EXPECTED.length);
    expect(ROADMAP2_CHECKS).toHaveLength(EXPECTED.length);
    for (const [name, isLive] of EXPECTED) {
      expect(
        CHECKS.filter((c) => c.startsWith(`${name}:`)),
        name,
      ).toHaveLength(1);
      expect(
        block.filter((l) => l.startsWith(`${name}:`)),
        name,
      ).toEqual([`${name}: ${isLive ? 'live data' : 'required PASS offline'}`]);
    }
  });
});
