import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BEGIN,
  CATALOGUE,
  DOC,
  END,
  generate,
  inventory,
  type Row,
  render,
  TABLE,
  WFS,
} from '../scripts/rws-inventory.ts';
import { repoRoot } from './catalogue.ts';

const SCRIPT = join(repoRoot, 'scripts/rws-inventory.ts');
const catalogueBytes = readFileSync(join(repoRoot, CATALOGUE));
const wfsBytes = readFileSync(join(repoRoot, WFS));
const committed = readFileSync(join(repoRoot, DOC), 'utf8');
const catalogue = JSON.parse(catalogueBytes.toString('utf8')) as Record<string, unknown[]>;
const wfs = JSON.parse(wfsBytes.toString('utf8')) as { features: { properties: Record<string, unknown> }[] };

/** The catalogue with an empty marker pair at the end of §2.1 when it has none yet (B4 inserts the real one). */
const marked = committed.includes(BEGIN)
  ? committed
  : committed.replace('\n### 2.2 ', `\n${BEGIN}\n${END}\n\n### 2.2 `);
const gen = (table: Readonly<Record<string, Row>> = TABLE, doc = marked) =>
  generate(catalogueBytes, wfsBytes, doc, table);
const without = (code: string) => Object.fromEntries(Object.entries(TABLE).filter(([c]) => c !== code));
const outside = (doc: string) => doc.slice(0, doc.indexOf(BEGIN)) + doc.slice(doc.indexOf(END));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('scripts/rws-inventory.ts', () => {
  it('the committed §2.1 block equals generate()', () => {
    expect(committed.split(BEGIN)).toHaveLength(2);
    expect(gen(TABLE, committed)).toBe(committed);
  });

  it('fills a marked copy of the catalogue, changes nothing outside the markers and is a fixed point', () => {
    const out = gen();
    expect(outside(out)).toBe(outside(marked));
    expect(gen(TABLE, out)).toBe(out);
    expect(out).toMatch(/sha256 [0-9a-f]{12}…\) and nl-2-wfs-20261016\.raw \(sha256 [0-9a-f]{12}…\)/);
    expect(out).not.toMatch(/[0-9a-f]{64}/);
    const { counts } = inventory(catalogue, wfs);
    const live = new Set(wfs.features.map((f) => f.properties.CODE));
    expect(Object.values(counts).reduce((s, n) => s + n.locations, 0)).toBe(live.size);
    expect(Object.keys(TABLE)).toHaveLength(live.size);
  });

  it('is deterministic: two runs are byte-equal', () => {
    expect(gen()).toBe(gen());
  });

  it('fails, naming the code, on a missing row, an extra row, a missing reason or a reason on another type', () => {
    expect(() => gen(without('hoekvanholland'))).toThrow(/live location hoekvanholland has no TABLE row/);
    expect(() => gen({ ...TABLE, 'nl.not.live': { type: 'river' } })).toThrow(/TABLE row nl\.not\.live is not a live/);
    expect(() => gen({ ...TABLE, 'zwartsluis.gemaal.pomp1': { type: 'structure' } })).toThrow(
      /zwartsluis\.gemaal\.pomp1: a structure-internal row needs a reason/,
    );
    expect(() => gen({ ...TABLE, edam: { type: 'lake', reason: 'gate slot' } })).toThrow(
      /edam: only a structure-internal row has a reason/,
    );
    expect(() => gen({ ...TABLE, edam: { type: 'sea' } as unknown as Row })).toThrow(/edam: unknown type sea/);
    // A data code such as __proto__ is an ordinary row, never a prototype lookup.
    expect(() => gen({ ...TABLE, ['__proto__']: { type: 'river' } })).toThrow(/TABLE row __proto__ is not a live/);
  });

  it('fails on an unknown GETET* grouping and on a grouping with the wrong ProcesType', () => {
    const doc = (patch: (a: Record<string, unknown>) => void) => {
      const c = structuredClone(catalogue) as { AquoMetadataLijst: Record<string, unknown>[] };
      const a = c.AquoMetadataLijst.find((x) => (x.Groepering as { Code: string }).Code === 'GETETM2');
      if (a === undefined) throw new Error('no GETETM2 combination');
      patch(a);
      return () => inventory(c, wfs);
    };
    expect(doc((a) => (a.Groepering = { Code: 'GETETX9' }))).toThrow(/unknown grouping GETETX9/);
    expect(doc((a) => (a.ProcesType = 'astronomisch'))).toThrow(/grouping GETETM2 with ProcesType astronomisch/);
  });

  it('fails unless the markers appear exactly once each, in order, and never inserts them', () => {
    const noMarkers = marked.replace(`${BEGIN}\n`, '').replace(`${END}\n`, '');
    expect(() => gen(TABLE, noMarkers)).toThrow(/needs exactly one/);
    expect(() => gen(TABLE, `${marked}\n${BEGIN}\n${END}\n`)).toThrow(/needs exactly one/);
    expect(() => gen(TABLE, `${noMarkers}\n${END}\n${BEGIN}\n`)).toThrow(/needs exactly one/);
  });

  it('property: the order of the WFS features, the catalogue arrays and the TABLE rows changes nothing', () => {
    const expected = inventory(catalogue, wfs);
    const shuffle = <T>(xs: readonly T[], seed: number): T[] => {
      const out = [...xs];
      let s = seed >>> 0 || 1;
      for (let i = out.length - 1; i > 0; i--) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        const j = s % (i + 1);
        [out[i], out[j]] = [out[j] as T, out[i] as T];
      }
      return out;
    };
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const c = { ...catalogue };
        for (const k of ['AquoMetadataLijst', 'AquoMetadataLocatieLijst', 'LocatieLijst'])
          c[k] = shuffle(catalogue[k] as unknown[], seed + k.length);
        const w = { ...wfs, features: shuffle(wfs.features, seed) };
        const t = Object.fromEntries(shuffle(Object.entries(TABLE), seed ^ 0x5bd1e995));
        const got = inventory(c, w, t);
        expect(got).toEqual(expected);
        const hashes = { catalogue: '0'.repeat(12), wfs: '1'.repeat(12) };
        expect(render(got, hashes)).toBe(render(expected, hashes));
      }),
      { numRuns: 15 },
    );
  }, 60_000);

  it('--check exits 1 on drift and 0 when current; a usage error exits 64', () => {
    const root = mkdtempSync(join(tmpdir(), 'rws-inventory-'));
    dirs.push(root);
    for (const f of [CATALOGUE, WFS]) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      copyFileSync(join(repoRoot, f), join(root, f));
    }
    mkdirSync(dirname(join(root, DOC)), { recursive: true });
    writeFileSync(join(root, DOC), `# Catalogue\n\n${BEGIN}\n${END}\n\n## Next\n`);
    const run = (...a: string[]) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8' });
    expect(run('--check', root).status).toBe(1);
    expect(run(root).status).toBe(0);
    expect(run('--check', root).status).toBe(0);
    writeFileSync(join(root, DOC), readFileSync(join(root, DOC), 'utf8').replace('| **Total** |', '| Total |'));
    expect(run('--check', root).status).toBe(1);
    writeFileSync(join(root, DOC), '# Catalogue without markers\n');
    const missing = run(root);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/needs exactly one/);
    expect(readFileSync(join(root, DOC), 'utf8')).toBe('# Catalogue without markers\n');
    expect(run('--bogus', root).status).toBe(64);
    expect(run('--check', root, root).status).toBe(64);
  }, 30_000);
});
