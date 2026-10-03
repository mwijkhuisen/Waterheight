import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { H_DESCRIPTION, Q_DESCRIPTION } from '../apps/server/src/adapters/nl-4/normalise.ts';
import { readThresholds } from '../apps/server/src/load/thresholds.ts';
import { LabelFile, StationsFile } from '../packages/contracts/src/index.ts';
import { CROSSWALK, REFERENCE_ROLES } from '../packages/core/src/index.ts';

const root = new URL('..', import.meta.url);

// The provider label table (catalogue gap item 19; PHASES P7a): every provider class, alert level and reference kind
// that an adapter emits, as its goldens show, has a reviewed NL and EN text in registry/labels/<SOURCE-ID>.yaml,
// and so does every row of the class crosswalk and every NL-4 label stem on a registered NL-1 series. An unmapped
// one fails here. Codes only: the raw provider label is stored beside our text, never matched.

const LABELS = new URL('registry/labels/', root);
const ADAPTERS = new URL('apps/server/src/adapters/', root);

const files = readdirSync(LABELS)
  .filter((f) => f.endsWith('.yaml'))
  .sort();
const tables = new Map(
  files.map((f) => {
    const file = LabelFile.parse(parse(readFileSync(new URL(f, LABELS), 'utf8'), { maxAliasCount: 0 }));
    return [file.source, file] as const;
  }),
);
const has = (source: string, scale: string, code: string) =>
  tables.get(source)?.labels.some((l) => l.scale === scale && l.code === code) === true;

/** The scale of a source's class rows (a source publishes at most one gauge class scale) or warning rows. */
const scaleOf = (source: string, kind: 'class' | 'warning') => {
  const scales = new Set(
    CROSSWALK.filter((r) => r.source === source && (kind === 'warning') === (r.basis === 'area')).map((r) => r.scale),
  );
  return scales.size === 1 ? [...scales][0] : undefined;
};
const codeIn = (source: string, scale: string, code: string) =>
  CROSSWALK.some((r) => r.source === source && r.scale === scale && r.code === '*') ? '*' : code;

type Golden = {
  classes?: { code: string }[];
  warnings?: { rows: { level_raw: string | null }[] };
  references?: { kind: string }[];
};

/** Every code the goldens of an adapter show: [scale, code] pairs. */
function goldenCodes(adapter: string): [string, string][] {
  const dir = new URL(`${adapter}/fixtures/`, ADAPTERS);
  if (!existsSync(dir)) return [];
  const source = adapter.toUpperCase();
  const out: [string, string][] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.golden.json'))) {
    const g = JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as Golden;
    for (const c of g.classes ?? []) {
      const scale = scaleOf(source, 'class') as string;
      const code = c.code.replace(/^[A-Z]{2}:/, ''); // the LHP provenance prefix
      out.push([scale, codeIn(source, scale, code)]);
    }
    for (const w of g.warnings?.rows ?? []) {
      if (w.level_raw !== null) out.push([scaleOf(source, 'warning') as string, w.level_raw]);
    }
    for (const r of g.references ?? []) out.push(['reference', r.kind.startsWith('CRUE_') ? 'CRUE' : r.kind]);
  }
  return out;
}

describe('registry/labels', () => {
  it('every file parses strictly (no alias, no control character) and is named after its source', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const f of files)
      expect(f).toBe(`${LabelFile.parse(parse(readFileSync(new URL(f, LABELS), 'utf8'))).source}.yaml`);
  });

  it('every code in an adapter golden has an NL and EN label (an unmapped one fails)', () => {
    const missing: string[] = [];
    for (const adapter of readdirSync(ADAPTERS).filter((d) => !d.startsWith('_'))) {
      const source = adapter.toUpperCase();
      const pairs = [...new Set(goldenCodes(adapter).map((p) => p.join('\n')))].map((s) => s.split('\n'));
      for (const [scale = '', code = ''] of pairs) {
        if (!has(source, scale, code)) missing.push(`${source} ${scale} ${code}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every crosswalk row and every reference kind has a label', () => {
    const missing = [
      // gated rows (BE-1, DE-9, DE-10) need no label yet: their sources are built in P13
      ...CROSSWALK.filter((r) => !r.gated && !has(r.source, r.scale, r.code)).map(
        (r) => `${r.source} ${r.scale} ${r.code}`,
      ),
      ...REFERENCE_ROLES.filter((r) => !r.gated && !has(r.source, 'reference', r.kind)).map(
        (r) => `${r.source} reference ${r.kind}`,
      ),
    ];
    expect(missing).toEqual([]);
  });

  it('every NL-4 label stem on a registered NL-1 series has a label, and none calls a display class a warning', () => {
    const stations = StationsFile.parse(
      parse(readFileSync(new URL('registry/stations/nl-1.yaml', root), 'utf8')),
    ).stations.filter((s) => s.role === 'primary' && s.audience === 'public');
    const keys = new Set(
      stations
        .filter((s) => s.quantity === 'Q' || ('datum' in s && s.datum === 'NAP'))
        .map((s) => `${s.quantity === 'H' ? H_DESCRIPTION : Q_DESCRIPTION}\n${s.provider_code}`),
    );
    const stems = new Set(
      readThresholds(readFileSync(new URL('registry/thresholds/nl-4.csv', root), 'utf8'))
        .rows.filter((r) => keys.has(`${r.description}\n${r.code}`))
        .map((r) => r.label.replace(/\s*\(.*$/, '').trim()),
    );
    expect(stems.size).toBeGreaterThanOrEqual(15);
    const missing = [...stems].filter((stem) => !has('NL-4', 'stem', stem));
    expect(missing).toEqual([]);
    for (const l of tables.get('NL-4')?.labels ?? []) {
      expect([l.code, /waarschuwing|warning/i.test(`${l.nl} ${l.en}`)]).toEqual([l.code, false]);
    }
  });
});
