import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type Baseline,
  BEGIN,
  buildProfile,
  CAP_BEGIN,
  CAP_END,
  CLASSES,
  classify,
  compare,
  END,
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

  it('passes up to 1.2 x the baseline and fails above it in total; a class above it is a warning', () => {
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
    expect(over.lines.filter((l) => /^(FAIL|WARN)/.test(l)).map((l) => l.split(':')[0])).toEqual([
      'FAIL total',
      'WARN tiles',
      'WARN assets',
      'WARN data',
      'WARN api',
    ]);
    // One class far over its limit with the total inside it (the data class of a run that spans two days) passes.
    const oneClass = { ...b, bytes: { ...b.bytes, data: b.bytes.data * 2 }, total_bytes: b.total_bytes + b.bytes.data };
    expect(oneClass.total_bytes).toBeLessThanOrEqual(b.total_bytes * 1.2);
    const warned = compare(oneClass, b);
    expect(warned.ok).toBe(true);
    expect(warned.lines.filter((l) => /^(FAIL|WARN)/.test(l)).map((l) => l.split(':')[0])).toEqual(['WARN data']);
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

describe('the capacity.md writer owns its own block only', () => {
  const block = `${BEGIN}\negress\n${END}`;
  const cap = (body: string) => `${CAP_BEGIN}\n${body}\n${CAP_END}`;
  it('withSection replaces the block between the given markers and leaves the rest byte for byte', () => {
    expect(withSection(`a\n${block}\nb`, `${BEGIN}x${END}`)).toBe(`a\n${BEGIN}x${END}\nb`);
    expect(withSection(`a\n${block}\nb`, cap('p'), CAP_BEGIN, CAP_END)).toBe(`a\n${block}\nb\n\n${cap('p')}\n`);
    expect(withSection(`a\n${cap('old')}\n${block}`, cap('new'), CAP_BEGIN, CAP_END)).toBe(
      `a\n${cap('new')}\n${block}`,
    );
  });

  it('writeCapacity (verify-prod --capacity --out) writes its block and keeps every other part of the file', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cap-')), 'capacity.md');
    writeCapacity(file, '## first\n');
    expect(readFileSync(file, 'utf8')).toBe(`${cap('## first')}\n`);
    const rest = `# Capacity\n\nintro\n\n${block}\n\n## Tunnel mode (#109)\n\ntext\n\n## RWS capture archive growth until P16b\n\n| a | b |\n`;
    writeFileSync(file, rest.replace('intro\n', `intro\n\n${cap('stale')}\n`));
    writeCapacity(file, '## second\n');
    expect(readFileSync(file, 'utf8')).toBe(rest.replace('intro\n', `intro\n\n${cap('## second')}\n`));
    writeCapacity(file, '## third\n');
    expect(readFileSync(file, 'utf8')).toBe(rest.replace('intro\n', `intro\n\n${cap('## third')}\n`));
  });

  it('a file without the capacity block gets it appended after every section', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cap-')), 'capacity.md');
    const rest = `# Capacity\n\n${block}\n\n## Tunnel mode (#109)\n\ntext\n`;
    writeFileSync(file, rest);
    writeCapacity(file, '## new\n');
    expect(readFileSync(file, 'utf8')).toBe(`${rest}\n${cap('## new')}\n`);
  });
});
