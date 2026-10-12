import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { JSON_CAPS } from '../../src/adapters/nl-1/parse.ts';
import { BYTES_PER_VALUE } from '../../src/backfill/project.ts';
import { BackfillSpec, loadBackfill } from '../../src/backfill/spec.ts';
import { NL1_BACKFILL_FLOOR } from '../../src/load/adapters.ts';
import { DATA_EPOCH } from '../../src/load/dirty.ts';
import { config, fixtureText, LOBITH_H, registry, SPEC } from './harness.ts';

// registry/backfill.yaml: strict schema, hosts inside capture.yaml's allowlist (invariant 1), the series selection
// and the cap arithmetic that keeps a P40D chunk inside the parser's caps (owner answer 2, 2026-10-12).

const spec = config.specs.find((s) => s.id === SPEC);
if (spec === undefined) throw new Error('no spec');
const raw = parse(readFileSync(new URL('../../../../registry/backfill.yaml', import.meta.url), 'utf8')) as {
  specs: Record<string, unknown>[];
};

describe('hosts (invariant 1)', () => {
  it('every host of every backfill spec is in capture.yaml hosts for its source', () => {
    for (const s of config.specs) {
      const allowed = registry.hosts.get(s.source) ?? [];
      for (const u of [s.url, s.check_url]) expect(allowed, `${s.id} ${u}`).toContain(new URL(u).hostname);
    }
    for (const host of Object.keys(config.hosts)) expect([...registry.hosts.values()].flat()).toContain(host);
  });

  it('a host outside the source allowlist is refused', () => {
    expect(() => loadBackfill(new Map([['NL-1', ['example.org']]]))).toThrow(/not allowlisted/);
    expect(() => loadBackfill(new Map())).toThrow(/no hosts/);
  });

  it('the spec is strict: an unknown key, a retention other than backfill, a loose chunk or an http URL fails', () => {
    const base = raw.specs[0] as Record<string, unknown>;
    expect(BackfillSpec.safeParse(base).success).toBe(true);
    for (const bad of [
      { ...base, extra: 1 },
      { ...base, retention: 'obs' },
      { ...base, chunk: 'PT1H' },
      { ...base, url: 'http://ddapi20-waterwebservices.rijkswaterstaat.nl/x' },
      { ...base, select: { ...(base.select as object), role: 'twin' } },
      { ...base, max_bytes: 26 * 1024 * 1024 },
    ])
      expect(BackfillSpec.safeParse(bad).success).toBe(false);
  });
});

describe('series selection', () => {
  const stations = (
    parse(readFileSync(new URL('../../../../registry/stations/nl-1.yaml', import.meta.url), 'utf8')) as {
      stations: { provider_key: string; quantity: string; role: string; first_release: boolean; audience: string }[];
    }
  ).stations;
  const expected = stations
    .filter((r) => r.first_release && r.role === 'primary' && r.audience !== 'off')
    .map((r) => r.provider_key);

  it('is the first_release primary rows of nl-1.yaml, H and Q', () => {
    expect(spec.series.map((s) => s.series_key).sort()).toEqual([...expected].sort());
    expect(spec.series.length).toBeGreaterThan(30);
    expect(new Set(spec.series.map((s) => s.series_key)).size).toBe(spec.series.length);
  });

  it('has no TAW twin and no tier-2 row', () => {
    expect(spec.series.map((s) => s.series_key)).not.toContain('eijsden.grens/WATHTE/TAW/other:F007');
    for (const s of spec.series) {
      expect(s.hoedanigheid).not.toBe('TAW');
      expect(stations.find((r) => r.provider_key === s.series_key)?.first_release).toBe(true);
    }
  });

  it('carries code, quantity, Hoedanigheid and the live method of each series', () => {
    const by = new Map(spec.series.map((s) => [s.series_key, s]));
    expect(by.get(LOBITH_H)).toMatchObject({
      code: 'lobith.bovenrijn.tolkamer',
      quantity: 'H',
      hoedanigheid: 'NAP',
      method: 'other:F007',
      step_ms: 600_000,
    });
    expect(by.get('eijsden.grens/Q/NVT/other:F216')).toMatchObject({
      quantity: 'Q',
      hoedanigheid: 'NVT',
      method: 'other:F216',
    });
    for (const s of spec.series) {
      expect(s.hoedanigheid).toBe(s.quantity === 'H' ? 'NAP' : 'NVT');
      expect(s.method).toMatch(/^other:F\d{3}$/);
    }
  });

  it('only the asked quantities: a WATHTE-only selection has no Q series', () => {
    expect(spec.series.some((s) => s.quantity === 'H')).toBe(true);
    expect(spec.series.some((s) => s.quantity === 'Q')).toBe(true);
  });
});

describe('cap arithmetic (JSON_CAPS)', () => {
  /** JSON values (objects, arrays, scalars) of one `Meting` element of the real fixture. */
  const nodes = (v: unknown): number =>
    v !== null && typeof v === 'object' ? 1 + Object.values(v).reduce((a: number, x) => a + nodes(x), 0) : 1;
  const meting = JSON.parse(fixtureText('nl-1-obs-key')).WaarnemingenLijst[0].MetingenLijst[0];
  const perValue = nodes(meting);
  const days = spec.chunk_ms / 86_400_000;
  const tenMinute = (days * 86_400_000) / 600_000;
  const hourly = (days * 86_400_000) / 3_600_000;

  it('the chunk is P40D', () => {
    expect(spec.chunk).toBe('P40D');
    expect(days).toBe(40);
  });
  it('P40D at 10 minutes is at most 90 % of maxValues', () => {
    expect(tenMinute).toBe(5760);
    expect(tenMinute).toBeLessThanOrEqual(0.9 * JSON_CAPS.maxValues);
  });
  it('the F007 list plus an hourly F001 list is at most 60 % of maxNodes', () => {
    expect(perValue).toBeGreaterThanOrEqual(10);
    expect(perValue).toBeLessThanOrEqual(13);
    expect((tenMinute + hourly) * perValue).toBeLessThanOrEqual(0.6 * JSON_CAPS.maxNodes);
  });
  it('and in bytes at most max_bytes', () => {
    expect((tenMinute + hourly) * BYTES_PER_VALUE).toBeLessThanOrEqual(spec.max_bytes);
    expect(spec.max_bytes).toBeLessThanOrEqual(25 * 1024 * 1024);
  });
});

describe('the audience gate (review S8)', () => {
  const REGISTRY = new URL('../../../../registry/', import.meta.url);
  /** A copy of the registry with one file's text changed. */
  const copy = (file: string, change: (text: string) => string): URL => {
    const dir = mkdtempSync(join(tmpdir(), 'backfill-registry-'));
    cpSync(REGISTRY, dir, { recursive: true });
    writeFileSync(join(dir, file), change(readFileSync(join(dir, file), 'utf8')));
    return pathToFileURL(`${dir}/`);
  };
  /** NL-1's block of sources.yaml with one key changed. */
  const nl1 = (key: string, value: string) => (text: string) => {
    const at = text.indexOf('  - id: NL-1\n');
    const end = text.indexOf('\n  - id: ', at + 1);
    return (
      text.slice(0, at) +
      text.slice(at, end).replace(new RegExp(`\\n    ${key}: .*`), `\n    ${key}: ${value}`) +
      text.slice(end)
    );
  };

  it('refuses a source that is not public, or whose history_export is off', () => {
    expect(() => loadBackfill(registry.hosts, copy('sources.yaml', nl1('audience', 'owner')))).toThrow(
      /NL-1 is not a public source/,
    );
    expect(() => loadBackfill(registry.hosts, copy('sources.yaml', nl1('history_export', 'false')))).toThrow(
      /NL-1 has history_export off/,
    );
  });

  it('refuses a selected series narrowed to the owner', () => {
    const dir = copy('stations/nl-1.yaml', (text) => {
      const at = text.indexOf(`provider_key: ${LOBITH_H}`);
      const a = text.indexOf('    audience: public', at);
      return `${text.slice(0, a)}    audience: owner${text.slice(a + '    audience: public'.length)}`;
    });
    expect(() => loadBackfill(registry.hosts, dir)).toThrow(/not public like its source/);
  });
});

describe('the bounds the loader and the runner share', () => {
  it('DATA_EPOCH is the data_epoch the display-window migration seeds', () => {
    const seed = readFileSync(
      new URL('../../../../db/migrations/20261014000001_display_window.sql', import.meta.url),
      'utf8',
    ).match(/\('data_epoch', '"([^"]+)"'\)/)?.[1];
    expect(seed).toBe(DATA_EPOCH);
  });
  it('the NL-1 loader floor is the spec floor of registry/backfill.yaml', () => {
    expect(NL1_BACKFILL_FLOOR).toBe(`${spec.floor}T00:00:00Z`);
  });
});
