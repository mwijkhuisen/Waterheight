import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { H_DESCRIPTION, Q_DESCRIPTION } from '../apps/server/src/adapters/nl-4/normalise.ts';
import { readThresholds } from '../apps/server/src/load/thresholds.ts';
import { BASIS_KINDS, SourcesFile, STATES, StateBasis, StationsFile } from '../packages/contracts/src/index.ts';
import {
  CLASS_WINDOW_MIN,
  CROSSWALK,
  crosswalkRow,
  type Group,
  LEVEL_NORM,
  LEVELS,
  type Measure,
  nl4Stem,
  PERMISSION_REQUIRED,
  REFERENCE_ROLES,
} from '../packages/core/src/index.ts';

// Pins between the classifier's constants and the files they restate (P7b): a constant in core that no file or
// contract enforces is a copy that drifts.

const root = new URL('..', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

describe('contracts and core agree', () => {
  it('STATES is no_ref and the levels of core', () => {
    expect([...STATES]).toEqual(['no_ref', ...LEVELS]);
  });

  it('BASIS_KINDS is the Group of the crosswalk (checked by the compiler both ways, and by value)', () => {
    type Kinds = (typeof BASIS_KINDS)[number];
    const same: [Group] extends [Kinds] ? ([Kinds] extends [Group] ? true : never) : never = true;
    expect(same).toBe(true);
    expect([...BASIS_KINDS]).toEqual(['operational', 'statistical', 'provider_class', 'area']);
    for (const r of CROSSWALK) expect(BASIS_KINDS).toContain(r.group);
  });

  it('the measures of StateBasis are the Measure of the classifier (both ways, and by value)', () => {
    type Measures = StateBasis['measure'];
    const same: [Measure] extends [Measures] ? ([Measures] extends [Measure] ? true : never) : never = true;
    expect(same).toBe(true);
    expect([...StateBasis.shape.measure.options].sort()).toEqual(['area', 'discharge', 'level', 'stage']);
  });
});

describe('REFERENCE_ROLES', () => {
  it('every (source, group) with a classifying kind has exactly one set form (review CR-11)', () => {
    // setCandidate takes the form of a set's first role: a second form in one set would depend on row order.
    const forms = new Map<string, Set<string | null>>();
    for (const r of REFERENCE_ROLES) {
      if (r.op === null) continue;
      const key = `${r.source} ${r.group}`;
      forms.set(key, (forms.get(key) ?? new Set()).add(r.form));
    }
    expect(forms.size).toBeGreaterThanOrEqual(10);
    expect([...forms].filter(([, f]) => f.size !== 1 || f.has(null)).map(([key]) => key)).toEqual([]);
  });
});

describe('CLASS_WINDOW_MIN follows registry/capture.yaml', () => {
  const capture = parse(read('registry/capture.yaml'), { maxAliasCount: 0 }) as {
    specs: { id: string; source: string; cron?: string }[];
  };

  /** The shortest gap in minutes between two runs of a cron's minute field (a step `a-b/n`, a list `a,b` or one minute). */
  const cadence = (cron: string): number => {
    const minute = cron.split(/\s+/)[0] as string;
    const step = /\/(\d+)$/.exec(minute)?.[1];
    if (step !== undefined) return Number(step);
    const list = minute
      .split(',')
      .map(Number)
      .sort((a, b) => a - b);
    if (list.length === 1) return 60;
    return Math.min(...list.map((m, i) => ((list[(i + 1) % list.length] as number) - m + 60) % 60 || 60));
  };

  const SPECS: Record<string, string> = {
    'DE-6': 'de-6-stations',
    'CH-1': 'ch-1-lindas',
    'FR-5': 'fr-5-vigilance',
    'LU-5': 'lu-5-cap',
    'CH-5': 'ch-5-warn',
  };

  it('every class and area source is pinned, nothing else is', () => {
    expect(Object.keys(CLASS_WINDOW_MIN).sort()).toEqual(Object.keys(SPECS).sort());
  });

  for (const [source, id] of Object.entries(SPECS)) {
    it(`${source}: max(3 × the cadence of ${id}, 45 min)`, () => {
      const spec = capture.specs.find((s) => s.id === id);
      expect(spec?.source).toBe(source);
      expect(typeof spec?.cron).toBe('string');
      expect(CLASS_WINDOW_MIN[source]).toBe(Math.max(3 * cadence(spec?.cron as string), 45));
    });
  }
});

describe('PERMISSION_REQUIRED follows registry/sources.yaml', () => {
  it('is the set of sources with permission_required: true', () => {
    const { sources } = SourcesFile.parse(parse(read('registry/sources.yaml'), { maxAliasCount: 0 }));
    expect([...PERMISSION_REQUIRED].sort()).toEqual(
      sources
        .filter((s) => s.permission_required)
        .map((s) => s.id)
        .sort(),
    );
  });
});

describe('NL-4 stems on registered series', () => {
  const stations = StationsFile.parse(parse(read('registry/stations/nl-1.yaml'))).stations.filter(
    (s) => s.role === 'primary' && s.audience === 'public',
  );
  const keys = new Set(
    stations
      .filter((s) => s.quantity === 'Q' || ('datum' in s && s.datum === 'NAP'))
      .map((s) => `${s.quantity === 'H' ? H_DESCRIPTION : Q_DESCRIPTION}\n${s.provider_code}`),
  );
  const rows = readThresholds(read('registry/thresholds/nl-4.csv')).rows.filter((r) =>
    keys.has(`${r.description}\n${r.code}`),
  );

  it('every stem is a crosswalk row of NL-4', () => {
    expect(rows.length).toBeGreaterThan(100);
    const missing = [...new Set(rows.map((r) => nl4Stem(r.label)))].filter(
      (s) => crosswalkRow('NL-4', 'stem', s) === undefined,
    );
    expect(missing).toEqual([]);
  });

  it('within one series and season set, a larger workbook order never maps to a higher level', () => {
    const sets = new Map<string, { order: number; stem: string; level: number }[]>();
    for (const r of rows) {
      const row = crosswalkRow('NL-4', 'stem', nl4Stem(r.label));
      if (row === undefined || row.level === 'no_ref') continue;
      const key = `${r.code}\n${r.description}\n${r.from_md}\n${r.to_md}`;
      sets.set(key, [
        ...(sets.get(key) ?? []),
        { order: r.order, stem: nl4Stem(r.label), level: LEVEL_NORM[row.level] },
      ]);
    }
    expect(sets.size).toBeGreaterThan(50);
    const bad: string[] = [];
    for (const [key, bands] of sets) {
      const byOrder = [...bands].sort((a, b) => a.order - b.order);
      for (let i = 1; i < byOrder.length; i++) {
        const [prev, cur] = [byOrder[i - 1], byOrder[i]];
        if (prev && cur && cur.level > prev.level)
          bad.push(`${key.split('\n')[0]}: ${prev.stem} (${prev.order}) < ${cur.stem} (${cur.order})`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('first_release in the station registry', () => {
  it('is true exactly for public, primary, tier-1 stations, in every file', () => {
    const files = readdirSync(new URL('registry/stations/', root)).filter((f) => f.endsWith('.yaml'));
    expect(files.length).toBeGreaterThanOrEqual(10);
    let n = 0;
    const bad: string[] = [];
    for (const f of files) {
      for (const s of StationsFile.parse(parse(read(`registry/stations/${f}`))).stations) {
        n++;
        const expected = s.audience === 'public' && s.role === 'primary' && s.tier === 1;
        if (s.first_release !== expected) bad.push(`${f} ${s.id}`);
      }
    }
    expect(n).toBeGreaterThan(2000);
    expect(bad).toEqual([]);
  });
});
