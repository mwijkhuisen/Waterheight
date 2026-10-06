import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generate, labelKey, slug } from '../scripts/gen-web-labels.ts';
import { repoRoot } from './catalogue.ts';

const SCRIPT = join(repoRoot, 'scripts/gen-web-labels.ts');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A throw-away root: two sources (one public, one owner), one river, existing messages with hand-written keys. */
function tree(labels: string, owner = '  - { scale: reference, code: P05, nl: Een, en: One }\n') {
  const root = mkdtempSync(join(tmpdir(), 'gen-labels-'));
  dirs.push(root);
  for (const d of [
    'registry/labels',
    'apps/web/messages',
    'apps/web/src/lib/labels',
    'apps/web/src/features/owner',
    'node_modules/.bin',
  ])
    mkdirSync(join(root, d), { recursive: true });
  symlinkSync(join(repoRoot, 'node_modules/.bin/biome'), join(root, 'node_modules/.bin/biome'));
  writeFileSync(
    join(root, 'registry/sources.yaml'),
    'sources:\n  - { id: DE-6, audience: public }\n  - { id: BE-3, audience: owner }\n',
  );
  writeFileSync(join(root, 'registry/labels/DE-6.yaml'), `source: DE-6\nlabels:\n${labels}`);
  writeFileSync(join(root, 'registry/labels/BE-3.yaml'), `source: BE-3\nlabels:\n${owner}`);
  writeFileSync(join(root, 'registry/rivers.yaml'), 'rivers:\n  - { id: sauer-sure, name_nl: Sûre, name_en: Sauer }\n');
  const msgs = (v: string) => `${JSON.stringify({ z_first: v, river_chip: 'chip', lbl_stale: 'old' })}\n`;
  writeFileSync(join(root, 'apps/web/messages/nl.json'), msgs('a'));
  writeFileSync(join(root, 'apps/web/messages/en.json'), msgs('b'));
  return root;
}
const OK =
  "  - { scale: station, code: '-1', nl: Geen, en: None, color: '#7b7b7b' }\n  - { scale: alert, code: '*', nl: X, en: Y }\n";

describe('gen-web-labels', () => {
  it('slugs codes', () => {
    expect(labelKey({ source: 'DE-6', scale: 'station', code: '-1' })).toBe('lbl_de_6_station_m1');
    expect(slug('*')).toBe('any');
    expect(slug('Hoogwater / Stormvloed')).toBe('hoogwater_stormvloed');
  });

  it('keeps other keys, replaces the generated block, and keeps owner labels out of the messages', () => {
    const out = generate(tree(OK));
    const nl = JSON.parse(out.get('apps/web/messages/nl.json') ?? '') as Record<string, string>;
    expect(Object.keys(nl)).toEqual([
      'z_first',
      'river_chip',
      'lbl_de_6_alert_any',
      'lbl_de_6_station_m1',
      'river_sauer_sure',
    ]);
    expect(nl.river_sauer_sure).toBe('Sûre');
    expect(out.get('apps/web/messages/en.json')).not.toContain('be_3');
    expect(out.get('apps/web/src/features/owner/labels.gen.ts')).toContain('lbl_be_3_reference_p05');
    const index = out.get('apps/web/src/lib/labels/labels-index.gen.ts') ?? '';
    expect(index).toContain('#7b7b7b');
    expect(index).not.toContain('lbl_be_3_reference_p05_x');
  });

  it('is deterministic and --check detects drift', () => {
    const root = tree(OK);
    expect([...generate(root)]).toEqual([...generate(root)]);
    const run = (...a: string[]) => spawnSync(process.execPath, [SCRIPT, ...a, root], { encoding: 'utf8' });
    expect(run('--check').status).toBe(1);
    expect(run().status).toBe(0);
    expect(run('--check').status).toBe(0);
    writeFileSync(join(root, 'apps/web/messages/en.json'), '{}\n');
    expect(run('--check').status).toBe(1);
  });

  it('fails on a collision and on an empty text', () => {
    expect(() =>
      generate(tree("  - { scale: a, code: 'x y', nl: A, en: B }\n  - { scale: a, code: x-y, nl: A, en: B }\n")),
    ).toThrow(/collision/);
    expect(() => generate(tree("  - { scale: a, code: x, nl: '', en: B }\n"))).toThrow(/empty text/);
    expect(() => generate(tree('  - { scale: a, code: x, en: B }\n'))).toThrow(/empty text/);
  });

  it('the committed files are current', () => {
    expect(readFileSync(join(repoRoot, 'apps/web/messages/nl.json'), 'utf8')).toBe(
      generate(repoRoot).get('apps/web/messages/nl.json'),
    );
  });
});
