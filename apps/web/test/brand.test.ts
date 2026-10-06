import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FONTS } from '../notices.ts';

// The brand (P10c, docs/design/BRAND.md): the vendored fonts are what SHA256SUMS lists, the token pairs meet the
// contrast BRAND.md states, and no signal colour of the map, the labels or the notices is a brand colour.

const web = join(import.meta.dirname, '..');
const fontsDir = join(web, 'src/styles/fonts');
const read = (path: string) => readFileSync(join(web, path), 'utf8');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('the vendored fonts', () => {
  const listed = readFileSync(join(fontsDir, 'SHA256SUMS'), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const m = /^([0-9a-f]{64}) {2}([A-Za-z0-9.-]+)$/.exec(l);
      if (m === null) throw new Error('SHA256SUMS: a malformed line');
      return { sha: m[1] as string, file: m[2] as string };
    });

  it('are exactly the files SHA256SUMS lists, byte for byte', () => {
    expect(listed.map((l) => l.file).sort()).toEqual(
      readdirSync(fontsDir)
        .filter((f) => f !== 'SHA256SUMS')
        .sort(),
    );
    for (const { sha, file } of listed) expect(sha256(readFileSync(join(fontsDir, file))), file).toBe(sha);
  });

  it('are six woff2 files, every one used by base.css, with an OFL text the notices ship', () => {
    const css = read('src/styles/base.css');
    const woff2 = listed.map((l) => l.file).filter((f) => f.endsWith('.woff2'));
    expect(woff2).toHaveLength(6);
    for (const f of woff2) expect(css, f).toContain(`url("./fonts/${f}")`);
    for (const f of FONTS) expect(readFileSync(join(fontsDir, f.file), 'utf8')).toMatch(/SIL OPEN FONT LICENSE/);
    // Fonts load from our origin only (invariant 7): no url() in the CSS leaves the folder.
    for (const [, url] of css.matchAll(/url\("([^"]+)"\)/g)) expect(url).toMatch(/^\.\/fonts\/[a-z0-9-]+\.woff2$/);
  });
});

/** WCAG 2 contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('the tokens', () => {
  const tokens = new Map(
    [...read('src/styles/base.css').matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6});/g)].map(([, k, v]) => [
      k as string,
      v as string,
    ]),
  );
  const t = (name: string) => {
    const v = tokens.get(name);
    if (v === undefined) throw new Error(`base.css: no --${name}`);
    return v;
  };

  it('are the brand colours of the design document', () => {
    expect([t('ink'), t('water'), t('paper'), t('accent'), t('muted'), t('water-dark'), t('name-dark')]).toEqual([
      '#0e3a4b',
      '#1a7f96',
      '#f4f1ea',
      '#17738a',
      '#46606b',
      '#4fb3c9',
      '#7ccadb',
    ]);
  });

  // [foreground, background, minimum]: 4.5 for text, 3 for large text and graphics (WCAG 1.4.3, 1.4.11).
  it.each([
    ['ink', 'paper', 10],
    ['muted', 'paper', 4.5],
    ['accent', 'paper', 4.5],
    ['accent-ink', 'accent', 4.5],
    ['water', 'paper', 3],
    ['paper', 'ink', 10],
    ['name-dark', 'ink', 4.5],
    ['water-dark', 'ink', 3],
    ['signal-caution-ink', 'signal-caution-bg', 4.5],
    ['signal-error-ink', 'paper', 4.5],
  ])('--%s on --%s reaches %s:1', (fg, bg, min) => {
    expect(contrast(t(fg), t(bg))).toBeGreaterThanOrEqual(min);
  });

  it('keep Waterblauw out of small text: it fails 4.5:1 on the off-white', () => {
    expect(contrast(t('water'), t('paper'))).toBeLessThan(4.5);
  });

  it('never use a brand colour as a signal colour', () => {
    const brand = new Set([...tokens].filter(([k]) => !k.startsWith('signal-')).map(([, v]) => v));
    brand.add('#8fd0de'); // Lichtwater, the logo's wave line
    const signals = [
      ...[...tokens].filter(([k]) => k.startsWith('signal-')).map(([, v]) => v),
      ...['src/features/legend/palette.ts', 'src/lib/labels/labels-index.gen.ts', 'src/features/map/stationLayer.ts']
        .flatMap((f) => read(f).match(/#[0-9a-fA-F]{6}\b/g) ?? [])
        .map((c) => c.toLowerCase()),
    ];
    expect(signals.length).toBeGreaterThan(10);
    expect(signals.filter((c) => brand.has(c))).toEqual([]);
  });
});
