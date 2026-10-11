import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { applyCaptureSkip, parseCaptureSkip, SKIP_MALFORMED, SKIP_UNKNOWN } from '../../src/capture/env.ts';
import { run } from '../../src/main.ts';
import { registry } from './helpers.ts';

// RWS_CAPTURE_SKIP (P12b A19): the rebuild drill leaves CH-1 and NL-1 out. It only removes specs (invariant 1).

const sourcesOf = (r: typeof registry) => new Set(r.specs.map((s) => s.source));
const skipOf = (v: string | undefined) => parseCaptureSkip({ RWS_CAPTURE_SKIP: v });

describe('RWS_CAPTURE_SKIP', () => {
  it('unset and empty skip nothing and return the same registry', () => {
    expect(parseCaptureSkip({})).toEqual([]);
    expect(skipOf('')).toEqual([]);
    expect(applyCaptureSkip(registry, [])).toBe(registry);
  });

  it('narrows: the specs of the listed sources go, every other spec stays, groups follow', () => {
    const skip = skipOf('CH-1,NL-1');
    expect(skip).toEqual(['CH-1', 'NL-1']);
    const out = applyCaptureSkip(registry, skip as string[]);
    if (typeof out === 'string') throw new Error(out);
    expect(sourcesOf(registry)).toContain('CH-1');
    expect(sourcesOf(registry)).toContain('NL-1');
    expect(sourcesOf(out)).not.toContain('CH-1');
    expect(sourcesOf(out)).not.toContain('NL-1');
    expect(out.specs).toEqual(registry.specs.filter((s) => s.source !== 'CH-1' && s.source !== 'NL-1'));
    // Every group's anchor is a spec that is still there, and no skipped source is listed.
    for (const g of out.groups) {
      expect(out.specs.some((s) => s.id === g.anchor)).toBe(true);
      expect(g.sources).not.toContain('CH-1');
      expect(g.sources).not.toContain('NL-1');
    }
  });

  it('never adds: the result is a subset of the registry, and hosts and secrets are untouched', () => {
    const out = applyCaptureSkip(registry, ['CH-1']);
    if (typeof out === 'string') throw new Error(out);
    const ids = new Set(registry.specs.map((s) => s.id));
    for (const s of out.specs) expect(ids.has(s.id)).toBe(true);
    expect(out.specs.length).toBeLessThan(registry.specs.length);
    expect(out.hosts).toBe(registry.hosts);
    expect(out.secretHeaders).toBe(registry.secretHeaders);
  });

  it.each([
    'ch-1',
    'CH-1,',
    ',CH-1',
    'CH-1,,NL-1',
    'CH-1, NL-1',
    'CH-1,CH-1',
    'XX-1',
    'CH-0',
    'CH-1;NL-1',
    '*',
    'all',
    'CH-1\nNL-1',
  ])('rejects the malformed list %j with a fixed code', (v) => {
    expect(skipOf(v)).toBe(SKIP_MALFORMED);
  });

  it('rejects an ID with no spec (an off source, a source that does not exist)', () => {
    for (const id of ['NL-3', 'DE-9', 'CH-99', 'BE-1']) {
      expect(sourcesOf(registry)).not.toContain(id);
      expect(applyCaptureSkip(registry, [id])).toBe(SKIP_UNKNOWN);
      expect(applyCaptureSkip(registry, ['CH-1', id])).toBe(SKIP_UNKNOWN);
    }
  });

  it('the capture role exits 78 on a bad list, before it reads a secret or opens the archive', async () => {
    const base = { RWS_DOMAIN: 'example.org', RWS_CONTACT_EMAIL: 'contact@example.org' };
    for (const v of ['nope', 'NL-3']) {
      const lines: string[] = [];
      expect(await run(['capture'], { ...base, RWS_CAPTURE_SKIP: v }, (l) => lines.push(l))).toBe(78);
      expect(lines.join('\n')).toMatch(/RWS_CAPTURE_SKIP_(MALFORMED|UNKNOWN)/);
      expect(lines.join('\n')).not.toContain(v);
    }
  });
});

// The rebuild drill's Q7 check (deploy/tests/rebuild-check.sh) judges the public sources that have tier-1
// series (they are the ones with a coverage entry), have a provider window of 7 days or more (every one of them
// does; docs/drills/rebuild-timing-sheet.md gives the windows) and are not skipped on the drill.
describe("the rebuild drill judges the registry's tier-1 public sources", () => {
  const root = new URL('../../../../', import.meta.url);
  it('Q7_SOURCES of rebuild-check.sh = public sources with tier-1 stations, less CH-1 and NL-1', () => {
    const script = readFileSync(new URL('deploy/tests/rebuild-check.sh', root), 'utf8');
    const listed = /^readonly Q7_SOURCES=\((.*)\)$/m.exec(script)?.[1]?.split(' ') ?? [];
    const audience = new Map(
      (
        parse(readFileSync(new URL('registry/sources.yaml', root), 'utf8')) as {
          sources: { id: string; audience: string }[];
        }
      ).sources.map((s) => [s.id, s.audience]),
    );
    const dir = new URL('registry/stations/', root);
    const tier1 = readdirSync(dir)
      .filter((f) => f.endsWith('.yaml') && /^\s*tier: 1\b/m.test(readFileSync(new URL(f, dir), 'utf8')))
      .map((f) => f.replace('.yaml', '').toUpperCase())
      .filter((id) => audience.get(id) === 'public' && id !== 'CH-1' && id !== 'NL-1');
    expect([...listed].sort()).toEqual(tier1.sort());
    expect(listed.length).toBeGreaterThan(0);
  });
});
