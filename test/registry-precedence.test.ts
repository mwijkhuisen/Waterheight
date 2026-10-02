import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OFFSET_PAIR } from '../apps/server/src/load/label-offset.ts';
import { readRegistry } from '../apps/server/src/load/registry-sync.ts';
import type { Station } from '../packages/contracts/src/index.ts';

// Precedence and deduplication (A§7.4 step 6; issue #20 P5b): every physical gauge is published once. The
// registry decides it by role (primary, twin, mirror) and audience; the reader views show only public,
// primary series. This test reads the whole registry as the sync does (readRegistry: every station file,
// registry/twins.yaml and the registry/permissions records) and holds each precedence rule to it.

const { stations, twins } = readRegistry();
const published = (r: Station) => r.role === 'primary' && r.audience === 'public';
const row = (source: string, code: string, quantity: 'H' | 'Q' = 'H') => {
  const found = stations.filter((r) => r.source === source && r.provider_code === code && r.quantity === quantity);
  if (found.length !== 1) throw new Error(`${source} ${code} ${quantity}: ${found.length} rows`);
  return found[0] as Station;
};
const roleOf = (source: string, code: string, quantity: 'H' | 'Q' = 'H') => {
  const r = row(source, code, quantity);
  return `${r.role}/${r.audience}`;
};

/** Metres between two WGS84 points (equirectangular; exact enough below a kilometre). */
function metres(a: Station, b: Station): number {
  const rad = Math.PI / 180;
  const x =
    ((b.lon as number) - (a.lon as number)) * rad * Math.cos((((a.lat as number) + (b.lat as number)) / 2) * rad);
  const y = ((b.lat as number) - (a.lat as number)) * rad;
  return 6_371_000 * Math.hypot(x, y);
}

/**
 * Pairs of public primary series of different sources that stand within NEAR_M of each other and are
 * distinct gauges after review, with the reason. Empty: in the registry of P5b no two sources publish a
 * series of the same quantity within 300 m.
 */
const DISTINCT_GAUGES: readonly { a: string; b: string; why: string }[] = [];
const NEAR_M = 300;

describe('no physical gauge is published twice', { timeout: 30_000 }, () => {
  it(`no two public primary series of one quantity from different sources lie within ${NEAR_M} m (unless reviewed)`, () => {
    const placed = stations.filter((r) => published(r) && r.lon !== null && r.lat !== null);
    const close: string[] = [];
    for (let i = 0; i < placed.length; i += 1) {
      const a = placed[i] as Station;
      for (let j = i + 1; j < placed.length; j += 1) {
        const b = placed[j] as Station;
        if (a.source === b.source || a.quantity !== b.quantity || metres(a, b) > NEAR_M) continue;
        const pair = [a.id, b.id].sort().join(' ~ ');
        if (!DISTINCT_GAUGES.some((d) => [d.a, d.b].sort().join(' ~ ') === pair)) close.push(`${pair} (${a.quantity})`);
      }
    }
    expect(close).toEqual([]);
  });

  it('a series key is registered once per source, and a station id belongs to one source', () => {
    const keys = stations.map((r) => `${r.source}/${r.provider_key}`);
    expect(new Set(keys).size).toBe(keys.length);
    const sourceOf = new Map<string, string>();
    for (const r of stations) {
      expect([r.id, sourceOf.get(r.id) ?? r.source]).toEqual([r.id, r.source]);
      sourceOf.set(r.id, r.source);
    }
  });
});

describe('the precedence rules of A§7.4 step 6', () => {
  it('Basel from CH-1: the PEGELONLINE and Hub’Eau copies are mirrors, CH-2 is a twin', () => {
    expect(roleOf('CH-1', '2289')).toBe('primary/public');
    expect(roleOf('CH-1', '2289', 'Q')).toBe('primary/public');
    expect(roleOf('DE-1', '2310010')).toBe('mirror/public');
    expect(roleOf('FR-1', 'A021005050')).toBe('mirror/public');
    expect(roleOf('CH-2', '2289')).toBe('twin/public');
  });

  it('Konstanz (RP Freiburg, in PEGELONLINE) is an unpublished mirror', () => {
    expect(roleOf('DE-1', '3329')).toBe('mirror/public');
  });

  it("FR-1's copies of German gauges are mirrors where DE-1 publishes the gauge (incl. Hanweiler, P5a)", () => {
    for (const [fr, de] of [
      ['A040000101', '23300320'],
      ['A060005050', '23300900'],
      ['A355005050', '23500700'],
      ['A375005050', '23700200'],
      ['A940000101', '26400100'],
    ] as const) {
      expect([fr, roleOf('FR-1', fr)]).toEqual([fr, 'mirror/public']);
      expect([de, roleOf('DE-1', de)]).toEqual([de, 'primary/public']);
    }
  });

  it('Perl, Stadtbredimus and Grevenmacher from DE-1; the LU-1 copies are twins (Grevenmacher: owner decision 2026-10-02)', () => {
    for (const [lu, de] of [
      ['26100100', '26100100'],
      ['02610012', '26100130'],
      ['02610015', '26100200'],
    ] as const) {
      expect([lu, roleOf('LU-1', lu)]).toEqual([lu, 'twin/public']);
      expect([de, roleOf('DE-1', de)]).toEqual([de, 'primary/public']);
    }
  });

  it('the LfU RLP gauges inside LU-1 (Bollendorf, Gemünd) are withheld in both audiences until C4 or C11', () => {
    for (const code of ['15', '2626030300']) {
      expect(roleOf('LU-1', code)).toBe('primary/off');
      expect(row('LU-1', code).licence_gate).toBe('withheld');
    }
  });

  it('WSV gauges are never registered from DE-7 (site_no 102); Hattingen stays a DE-1 mirror that DE-7 does not carry', () => {
    const de1 = new Set(stations.filter((r) => r.source === 'DE-1').map((r) => r.provider_code));
    expect(stations.filter((r) => r.source === 'DE-7' && de1.has(r.provider_code))).toEqual([]);
    expect(roleOf('DE-1', '2769510000100')).toBe('mirror/public');
    expect(roleOf('DE-1', '2769510000100', 'Q')).toBe('mirror/public');
    // The placeholder numbers name no gauge.
    for (const code of ['1234567', '123456', '1234512345'])
      expect(stations.filter((r) => r.provider_code === code)).toEqual([]);
  });

  it('the §0.6 Belgian partner stations stay FR-1 primary in both audiences until a Belgian source is public (P13)', () => {
    const partners = stations.filter((r) => r.source === 'FR-1' && r.country === 'BE');
    expect(new Set(partners.map((r) => r.provider_code)).size).toBe(18);
    for (const r of partners) expect([r.id, r.role, r.audience]).toEqual([r.id, 'primary', 'public']);
  });

  it('every twin pair names two registered series, and a public pair has no withheld side', () => {
    expect(twins.map((t) => t.id).sort()).toEqual([
      'basel-ch1-de1-h',
      'chooz-fr3-fr1-h',
      'eijsden-grens-taw-nap',
      'grevenmacher-lu1-de1-h',
      'perl-lu1-de1-h',
      'stadtbredimus-lu1-de1-h',
      'uckange-fr3-fr1-q',
    ]);
    for (const t of twins) {
      for (const side of [t.a, t.b]) {
        const r = stations.find((s) => s.source === side.source && s.provider_key === side.provider_key);
        expect([t.id, side.provider_key, r?.audience]).toEqual([t.id, side.provider_key, 'public']);
      }
    }
  });

  it('the LU-1 label-offset detector compares the Perl twin pair of registry/twins.yaml', () => {
    const perl = twins.find((t) => t.id === 'perl-lu1-de1-h');
    expect(perl?.a).toEqual({ source: OFFSET_PAIR.source, provider_key: OFFSET_PAIR.key });
    expect(perl?.b).toEqual({ source: OFFSET_PAIR.against.source, provider_key: OFFSET_PAIR.against.key });
  });
});

describe('registry/permissions in the sync (readRegistry)', { timeout: 30_000 }, () => {
  /** A copy of registry/ with one file changed: readRegistry reads the copy. */
  function withFile(name: string, text: string | null): () => unknown {
    const dir = mkdtempSync(join(tmpdir(), 'rws-registry-'));
    cpSync(new URL('../registry/', import.meta.url), dir, { recursive: true });
    if (text === null) rmSync(join(dir, name));
    else writeFileSync(join(dir, name), text);
    return () => {
      try {
        return readRegistry(pathToFileURL(`${dir}/`));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
  }
  const front = (lines: string) => `---\n${lines}\n---\n# record\n`;

  it('applies no grant yet (P13): a grant record stops the sync', () => {
    const grant = front(
      'source: DE-12\ngranted_by: Test\ngranted_on: "2026-09-01"\nevidence: test\naudience: public\ndisplay: true\napi: false\nbulk_export: false\nhistory_export: false',
    );
    expect(withFile('permissions/DE-12.md', grant)).toThrow(/holds a grant/);
  });

  it('a withholding record must name registered series that are off', () => {
    const record = (keys: string) =>
      front(`source: LU-1\nwithheld: [${keys}]\naudience: "off"\nbasis: test\nrecorded_on: "2026-10-02"`);
    expect(withFile('permissions/LU-1.md', record('Bollendorf, Gemünd_Our'))).not.toThrow();
    expect(withFile('permissions/LU-1.md', record('Diekirch'))).toThrow(/Diekirch is not audience off/);
    expect(withFile('permissions/LU-1.md', record('Nowhere'))).toThrow(/Nowhere is not a registered series/);
  });
});
