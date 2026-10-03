import { existsSync, readdirSync, readFileSync } from 'node:fs';
import type { TimeConvention } from '@rws/core';
import { describe, expect, it } from 'vitest';
import { ADAPTER_TIME, DST_PROOF, DST_REFUSED, GATED_KINDS, gate, LOAD_ADAPTERS } from '../../src/load/adapters.ts';

// The DST gate (A§7.4 step 2; catalogue §0.3; issue #20 P5b): every adapter whose observation timestamps carry no
// offset (`naive-local`, `local-labelled-z`, `start-of-interval`) is loaded only with a synthetic fall-back
// fixture (the repeated local hour) and a spring-forward fixture (the missing hour), each with its golden. This
// test finds the adapters by their declared convention (every adapters/*/normalise.ts `TIME`), so a later
// offset-less parser (DE-6 in P7, DE-3 in P8, DE-10/12/13 in P13) inherits it; the adapter's own test holds each
// golden's exact UTC instants. load/adapters.ts `gate()` drops a spec without its proof at start-up.

import { TIME as BE3 } from '../../src/adapters/be-3/normalise.ts';
import { TIME as CH1 } from '../../src/adapters/ch-1/normalise.ts';
import { TIME as CH2 } from '../../src/adapters/ch-2/normalise.ts';
import { TIME as CH3 } from '../../src/adapters/ch-3/normalise.ts';
import { TIME as CH5 } from '../../src/adapters/ch-5/normalise.ts';
import { TIME as DE1 } from '../../src/adapters/de-1/normalise.ts';
import { TIME as DE6 } from '../../src/adapters/de-6/normalise.ts';
import { TIME as DE7 } from '../../src/adapters/de-7/normalise.ts';
import { TIME as FR1 } from '../../src/adapters/fr-1/normalise.ts';
import { TIME as FR3 } from '../../src/adapters/fr-3/normalise.ts';
import { TIME as FR5 } from '../../src/adapters/fr-5/normalise.ts';
import { TIME as LU1 } from '../../src/adapters/lu-1/normalise.ts';
import { TIME as LU2 } from '../../src/adapters/lu-2/normalise.ts';
import { TIME as LU3 } from '../../src/adapters/lu-3/normalise.ts';
import { TIME as LU5 } from '../../src/adapters/lu-5/normalise.ts';
import { TIME as NL1 } from '../../src/adapters/nl-1/normalise.ts';
import { TIME as NL2 } from '../../src/adapters/nl-2/normalise.ts';

const ADAPTERS = new URL('../../src/adapters/', import.meta.url);

/**
 * Every adapter's declared convention (its normalise.ts `TIME`; null: the adapter has no timestamps). Listed
 * by hand because module names may not be computed (scripts/check-boundaries.ts); the first test fails when an
 * adapter with a normalise.ts is missing here, so a new one cannot slip past the gate.
 */
const declared: Readonly<Record<string, TimeConvention | null>> = {
  'BE-3': BE3,
  'CH-1': CH1,
  'CH-2': CH2,
  'CH-3': CH3,
  'CH-5': CH5,
  'DE-1': DE1,
  'DE-6': DE6,
  'DE-7': DE7,
  'DE-8': null,
  'FR-1': FR1,
  'FR-3': FR3,
  'FR-5': FR5,
  'LU-1': LU1,
  'LU-2': LU2,
  'LU-3': LU3,
  'LU-4': null,
  'LU-5': LU5,
  'LU-6': null,
  'NL-1': NL1,
  'NL-2': NL2,
  'NL-4': null,
};
const isGated = (t: TimeConvention | null | undefined) => t !== null && t !== undefined && GATED_KINDS.has(t.kind);

/** What a spec's proof lacks: a list of each kind, and for every name a raw file, a synthetic meta and a golden. */
function proofProblems(
  source: string,
  spec: string,
  proof: { fallBack: readonly string[]; springForward: readonly string[] } | undefined,
  exists: (url: URL) => boolean = existsSync,
): string[] {
  if (proof === undefined) return [`${spec}: no DST proof`];
  const problems: string[] = [];
  if (proof.fallBack.length === 0) problems.push(`${spec}: no fall-back fixture`);
  if (proof.springForward.length === 0) problems.push(`${spec}: no spring-forward fixture`);
  const dir = new URL(`${source.toLowerCase()}/fixtures/`, ADAPTERS);
  for (const name of [...proof.fallBack, ...proof.springForward]) {
    if (!name.endsWith('.synthetic')) problems.push(`${name}: not a synthetic fixture`);
    for (const suffix of ['.raw', '.meta.json', '.golden.json'])
      if (!exists(new URL(`${name}${suffix}`, dir))) problems.push(`${name}${suffix}: missing`);
    if (exists(new URL(`${name}.meta.json`, dir))) {
      const meta = JSON.parse(readFileSync(new URL(`${name}.meta.json`, dir), 'utf8')) as Record<string, unknown>;
      if (meta.synthetic !== true || meta.spec !== spec) problems.push(`${name}: meta is not a synthetic ${spec}`);
    }
  }
  return problems;
}

describe('DST gate', () => {
  it("lists every adapter's convention: each normalise.ts, and whether it declares a TIME", () => {
    const folders = readdirSync(ADAPTERS)
      .filter((d) => existsSync(new URL(`${d}/normalise.ts`, ADAPTERS)))
      .map((d) => d.toUpperCase())
      .sort();
    expect(Object.keys(declared).sort()).toEqual(folders);
    for (const source of folders) {
      const text = readFileSync(new URL(`${source.toLowerCase()}/normalise.ts`, ADAPTERS), 'utf8');
      expect([source, /^export const TIME\b/m.test(text)]).toEqual([source, declared[source] !== null]);
    }
  });

  it('finds the offset-less adapters by their declared convention (today DE-6, LU-1 and NL-2)', () => {
    const gated = Object.entries(declared)
      .filter(([, t]) => isGated(t))
      .map(([s]) => s)
      .sort();
    expect(gated).toEqual(['DE-6', 'LU-1', 'NL-2']);
  });

  it("each loaded source's declared convention is its adapter's TIME (null: no timestamps)", () => {
    for (const source of Object.keys(LOAD_ADAPTERS)) {
      expect([source, Object.hasOwn(ADAPTER_TIME, source)]).toEqual([source, true]);
      expect([source, ADAPTER_TIME[source]]).toEqual([source, declared[source]]);
    }
  });

  it('every loaded spec of an offset-less adapter has both synthetic fixtures with goldens, and runs on them', async () => {
    for (const [source, adapter] of Object.entries(LOAD_ADAPTERS)) {
      if (!isGated(ADAPTER_TIME[source])) continue;
      for (const [id, spec] of Object.entries(adapter.specs)) {
        expect(proofProblems(source, id, DST_PROOF[id])).toEqual([]);
        const proof = DST_PROOF[id] as { fallBack: readonly string[]; springForward: readonly string[] };
        for (const name of [...proof.fallBack, ...proof.springForward]) {
          const dir = new URL(`${source.toLowerCase()}/fixtures/`, ADAPTERS);
          const meta = JSON.parse(readFileSync(new URL(`${name}.meta.json`, dir), 'utf8')) as { recorded_at: string };
          const out = await spec.run(readFileSync(new URL(`${name}.raw`, dir)), {
            registry: new Map(),
            fetchedAt: Date.parse(meta.recorded_at),
            variant: '',
            unitMismatch: new Set(),
          });
          expect(out.dropped).toBeDefined();
        }
      }
    }
    // Nothing is refused today: every gated spec has its proof.
    expect(DST_REFUSED).toEqual([]);
  });

  it('a proof with a fixture removed fails (the check is not decorative)', () => {
    for (const [id, proof] of Object.entries(DST_PROOF)) {
      const source = id.startsWith('lu-1') ? 'LU-1' : id.startsWith('de-6') ? 'DE-6' : 'NL-2';
      for (const name of [...proof.fallBack, ...proof.springForward]) {
        const without = (url: URL) => !url.pathname.endsWith(`/${name}.raw`) && existsSync(url);
        expect(proofProblems(source, id, proof, without)).toEqual([`${name}.raw: missing`]);
      }
      expect(proofProblems(source, id, { ...proof, springForward: [] })).toContain(`${id}: no spring-forward fixture`);
    }
  });

  it('gate() drops a gated spec without proof, and a source without a declared convention, and nothing else', () => {
    expect(gate(LOAD_ADAPTERS, {}).refused).toEqual(['de-6-alerts', 'de-6-stations', 'lu-1-csv', 'nl-2-wfs']);
    expect(gate(LOAD_ADAPTERS, { 'lu-1-csv': DST_PROOF['lu-1-csv'] }).refused).toEqual([
      'de-6-alerts',
      'de-6-stations',
      'nl-2-wfs',
    ]);
    const { 'DE-7': _, ...times } = ADAPTER_TIME;
    expect(gate(LOAD_ADAPTERS, DST_PROOF, times).refused).toEqual(['de-7-messwerte', 'de-7-pegeldaten']);
    expect(Object.keys(gate(LOAD_ADAPTERS).adapters)).toEqual(Object.keys(LOAD_ADAPTERS));
  });
});
