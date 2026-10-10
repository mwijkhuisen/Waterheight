import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type Baseline,
  BEGIN,
  buildProfile,
  CLASSES,
  classify,
  compare,
  END,
  keepEgressBlock,
  parseBaseline,
  renderSection,
  withSection,
} from '../scripts/lib/capacity-egress.ts';
import { writeCapacity } from '../scripts/verify-prod.ts';

const ROOT = new URL('../', import.meta.url);
const base = (): Baseline => ({
  ...buildProfile(
    [
      { url: 'https://x.example/tiles/a.pmtiles', size: 4_000_000 },
      { url: 'https://x.example/assets/app-1.js', size: 1_000_000 },
      { url: 'https://x.example/data/v1/latest.json', size: 200_000 },
      { url: 'https://x.example/api/v1/snapshot', size: 100_000 },
      { url: 'https://x.example/', size: 5_000 },
    ],
    'note',
    '2026-10-10T00:00:00Z',
  ),
  inputs: {
    uplink_mbit_s: null,
    quota_tb: null,
    flood_sessions_per_hour: 20_000,
    flood_hours_per_day: 12,
    flood_days_per_month: 3,
    normal_sessions_per_day: 3_000,
    burst_factor: 2,
  },
});

describe('egress profile', () => {
  it('classifies the paths of a session', () => {
    expect(classify('/tiles/x.pmtiles')).toBe('tiles');
    expect(classify('/assets/fonts/Noto/0-255.pbf')).toBe('assets');
    expect(classify('/data/v1/rivers/manifest.json')).toBe('data');
    expect(classify('/api/v1/snapshot')).toBe('api');
    expect(classify('/')).toBe('html');
    expect(classify('/en/sources')).toBe('html');
    expect(classify('/favicon.ico')).toBe('other');
  });

  it('sums bytes and requests per class', () => {
    const p = base();
    expect(p.bytes.tiles).toBe(4_000_000);
    expect(p.requests.html).toBe(1);
    expect(p.total_bytes).toBe(5_305_000);
  });

  it('passes up to 1.2 x the baseline and fails above it, in total or per class', () => {
    const b = base();
    const same = compare(b, b);
    expect(same.ok).toBe(true);
    expect(same.lines).toHaveLength(CLASSES.length + 1);
    const scaled = (k: number) =>
      buildProfile(
        [
          { url: 'https://x.example/tiles/a.pmtiles', size: 4_000_000 * k },
          { url: 'https://x.example/assets/app-1.js', size: 1_000_000 * k },
          { url: 'https://x.example/data/v1/latest.json', size: 200_000 * k },
          { url: 'https://x.example/api/v1/snapshot', size: 100_000 * k },
          { url: 'https://x.example/', size: 5_000 * k },
        ],
        'n',
        't',
      );
    expect(compare(scaled(1.19), b).ok).toBe(true);
    const over = compare(scaled(1.21), b);
    expect(over.ok).toBe(false);
    expect(over.lines.filter((l) => l.startsWith('FAIL')).map((l) => l.split(':')[0])).toEqual([
      'FAIL total',
      'FAIL tiles',
      'FAIL assets',
      'FAIL data',
      'FAIL api',
    ]);
  });

  it('rejects a malformed baseline by field name', () => {
    const b = base();
    expect(() => parseBaseline(JSON.stringify({ ...b, total_bytes: 1 }))).toThrow('total_bytes');
    expect(() => parseBaseline(JSON.stringify({ ...b, inputs: { ...b.inputs, quota_tb: -1 } }))).toThrow(
      'inputs.quota_tb',
    );
    expect(() => parseBaseline(JSON.stringify(b))).not.toThrow();
  });

  it('the committed baseline is valid and docs/capacity.md carries its section', () => {
    const b = parseBaseline(readFileSync(new URL('docs/capacity-egress.json', ROOT), 'utf8'));
    const doc = readFileSync(new URL('docs/capacity.md', ROOT), 'utf8');
    expect(doc).toContain(renderSection(b));
  });
});

describe('egress section', () => {
  it('shows placeholders until the owner fills A3, then the 50% verdict of D20', () => {
    const empty = renderSection(base());
    expect(empty).toContain('**OWNER: A3**');
    expect(empty).toContain('not decided until the owner fills in A3');
    expect(empty).toContain('Never switch to OpenFreeMap');
    expect(empty).toContain('docs/runbooks/cdn-break-glass.md');
    // 5.305 MB x 20000 / h x 2 burst = 471.6 Mbit/s; month = (90000 + 720000) sessions = 4.30 TB
    const b = base();
    const ok = renderSection({ ...b, inputs: { ...b.inputs, uplink_mbit_s: 1000, quota_tb: 20 } });
    expect(ok).toContain('471.6 Mbit/s');
    expect(ok).toContain('4.30 TB');
    expect(ok).toContain('both lines hold');
    const bad = renderSection({ ...b, inputs: { ...b.inputs, uplink_mbit_s: 100, quota_tb: 20 } });
    expect(bad).toContain('arm the D20 fallback');
  });
});

describe('the capacity.md writer keeps the egress block', () => {
  const block = `${BEGIN}\nkept\n${END}`;
  it('carries the block over a regenerated document and appends it when the new text has no markers', () => {
    expect(keepEgressBlock(`# old\n${block}\ntail`, '# new\n')).toBe(`# new\n\n${block}\n`);
    expect(keepEgressBlock(`# old\n${block}`, `# new\n${BEGIN}fresh${END}\nz`)).toBe(`# new\n${block}\nz`);
    expect(keepEgressBlock(null, '# new\n')).toBe('# new\n');
    expect(keepEgressBlock('# old, no block', '# new\n')).toBe('# new\n');
    expect(withSection(`a\n${block}\nb`, `${BEGIN}x${END}`)).toBe(`a\n${BEGIN}x${END}\nb`);
  });

  it('writeCapacity (verify-prod --capacity --out) rewrites the file but not the block', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cap-')), 'capacity.md');
    writeCapacity(file, '# first\n');
    expect(readFileSync(file, 'utf8')).toBe('# first\n');
    writeFileSync(file, `# first\n\n${block}\n`);
    writeCapacity(file, '# second\n');
    expect(readFileSync(file, 'utf8')).toBe(`# second\n\n${block}\n`);
    writeCapacity(file, '# third\n');
    expect(readFileSync(file, 'utf8')).toBe(`# third\n\n${block}\n`);
  });
});
