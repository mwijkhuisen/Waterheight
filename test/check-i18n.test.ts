import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkI18n, findHardcoded } from '../scripts/check-i18n.ts';
import { repoRoot } from './catalogue.ts';

const found = (source: string) => findHardcoded('a.tsx', source);

describe('check-i18n: hard-coded UI text', () => {
  it.each([
    ['JSX text', '<p>Hallo</p>', 'hard-coded JSX text'],
    ['a string child', "<p>{'Hallo'}</p>", 'hard-coded string as a JSX child'],
    ['a template child', '<p>{`Hallo`}</p>', 'hard-coded string as a JSX child'],
    ['a string in a conditional child', "<p>{open ? 'Open' : label}</p>", 'hard-coded string as a JSX child'],
    ['aria-label', '<button aria-label="Sluiten" />', 'hard-coded aria-label attribute'],
    ['alt in braces', "<img alt={'kaart'} />", 'hard-coded alt attribute'],
    ['title as a template', '<a title={`x`} />', 'hard-coded title attribute'],
    ['placeholder in a fragment', '<><input placeholder="Zoek" /></>', 'hard-coded placeholder attribute'],
  ])('flags %s', (_, source, what) => {
    expect(found(source)).toEqual([`a.tsx:1: ${what}`]);
  });

  it('flags a UI-text property set to a literal in a .ts builder (an ECharts axis name; review round 1)', () => {
    expect(findHardcoded('chart.ts', "const o = { yAxis: { name: 'Waterstand' } };")).toEqual([
      'chart.ts:1: hard-coded name property',
    ]);
    expect(findHardcoded('chart.ts', "const o = { title: { text: cond ? 'Afvoer' : x } };")).toEqual([
      'chart.ts:1: hard-coded text property',
    ]);
    // A variable, a message call, an id-like key and punctuation are fine.
    expect(
      findHardcoded('chart.ts', "const o = { name: d.unit, label: m.x({}, o), id: 'obs', type: 'line', text: ' – ' };"),
    ).toEqual([]);
  });

  it('reports the line of the text, not of its element', () => {
    expect(found('<div>\n  <p>\n    Hallo\n  </p>\n</div>')).toEqual(['a.tsx:3: hard-coded JSX text']);
  });

  it.each([
    ['a message call', '<p>{m.heading({}, { locale })}</p>'],
    ['punctuation around an expression', '<p>({code})</p>'],
    ['symbols only', '<span> · </span>'],
    ['digits and an entity', '<span>12 &nbsp; – 3</span>'],
    ['an attribute from a variable', '<input aria-label={label} />'],
    ['className and data-*', '<div className="x" data-testid="map" />'],
    ['a string in a call argument', "<p className={cx('a', 'b')}>{t('Hallo')}</p>"],
    ['an empty string', '<p title="" aria-label={``}>{""}</p>'],
    ['TypeScript outside JSX', "const x: string = 'Hallo'; export const y = `Hallo`;"],
  ])('passes %s', (_, source) => {
    expect(found(source)).toEqual([]);
  });
});

describe('check-i18n: messages', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A throw-away repository root with the two message files and, optionally, one component. */
  const tree = (nl: object, en: object, tsx?: string) => {
    const root = mkdtempSync(join(tmpdir(), 'check-i18n-'));
    dirs.push(root);
    mkdirSync(join(root, 'apps/web/messages'), { recursive: true });
    mkdirSync(join(root, 'apps/web/src/paraglide'), { recursive: true });
    writeFileSync(join(root, 'apps/web/messages/nl.json'), JSON.stringify(nl));
    writeFileSync(join(root, 'apps/web/messages/en.json'), JSON.stringify(en));
    // The compiled messages are generated code: never scanned.
    writeFileSync(join(root, 'apps/web/src/paraglide/messages.tsx'), '<p>Generated</p>');
    if (tsx !== undefined) writeFileSync(join(root, 'apps/web/src/A.tsx'), tsx);
    return root;
  };

  it('passes a clean tree', () => {
    expect(checkI18n(tree({ a: 'Een', $schema: 'x' }, { a: 'One' }, '<p>{m.a()}</p>'))).toEqual([]);
  });

  it('reports a key missing in en.json', () => {
    expect(checkI18n(tree({ a: 'Een', b: 'Twee' }, { a: 'One' }))).toEqual(['message "b" is missing in en.json']);
  });

  it('reports a value that is not a non-empty string', () => {
    expect(checkI18n(tree({ a: '', b: 'Twee', c: ['x'] }, { a: 'One', b: '  ', c: 'Three' }))).toEqual([
      'message "a" in nl.json is not a non-empty string',
      'message "b" in en.json is not a non-empty string',
      'message "c" in nl.json is not a non-empty string',
    ]);
  });

  it('reports hard-coded text with its repo-relative path', () => {
    expect(checkI18n(tree({ a: 'Een' }, { a: 'One' }, '<p>Hallo</p>'))).toEqual([
      'apps/web/src/A.tsx:1: hard-coded JSX text',
    ]);
  });

  describe('the label catalogue', () => {
    /** A tree with one public and one owner source, one label each and one river, all present. */
    const withRegistry = (opts: { nlText?: string; dropEn?: boolean; dropOwner?: boolean } = {}) => {
      const key = 'lbl_de_6_station_m1';
      const nl: Record<string, string> = { [key]: 'Geen', river_rhine: 'Rijn' };
      const en: Record<string, string> = { [key]: 'None', river_rhine: 'Rhine' };
      if (opts.dropEn) delete en[key];
      const root = tree(nl, en);
      mkdirSync(join(root, 'registry/labels'), { recursive: true });
      mkdirSync(join(root, 'apps/web/src/features/owner'), { recursive: true });
      writeFileSync(
        join(root, 'registry/sources.yaml'),
        'sources:\n  - { id: DE-6, audience: public }\n  - { id: BE-3, audience: owner }\n',
      );
      writeFileSync(
        join(root, 'registry/labels/DE-6.yaml'),
        `source: DE-6\nlabels:\n  - { scale: station, code: '-1', ${opts.nlText ?? 'nl: Geen'}, en: None }\n`,
      );
      writeFileSync(
        join(root, 'registry/labels/BE-3.yaml'),
        'source: BE-3\nlabels:\n  - { scale: reference, code: P05, nl: Een, en: One }\n',
      );
      writeFileSync(join(root, 'registry/rivers.yaml'), 'rivers:\n  - { id: rhine, name_nl: Rijn, name_en: Rhine }\n');
      writeFileSync(
        join(root, 'apps/web/src/features/owner/labels.gen.ts'),
        opts.dropOwner ? 'export {};\n' : 'const a = { lbl_be_3_reference_p05: "x" };\n',
      );
      return root;
    };

    it('passes when every label and river is in the catalogue', () => {
      expect(checkI18n(withRegistry())).toEqual([]);
    });
    it('fails on a registry label without an nl text', () => {
      expect(checkI18n(withRegistry({ nlText: 'x: 1' }))).toEqual([
        'label DE-6 station -1 has no nl text in the registry',
      ]);
    });
    it('fails on a key missing in en.json', () => {
      expect(checkI18n(withRegistry({ dropEn: true }))).toContain(
        'label DE-6 station -1 ("lbl_de_6_station_m1") is missing in en.json',
      );
    });
    it('fails on an owner label missing in labels.gen.ts', () => {
      expect(checkI18n(withRegistry({ dropOwner: true }))).toEqual([
        'label BE-3 reference P05 ("lbl_be_3_reference_p05") is missing in labels.gen.ts',
        'label BE-3 reference P05 ("lbl_be_3_reference_p05") is missing in labels.gen.ts',
      ]);
    });
  });

  describe('the pages’ prose (P10b)', () => {
    const CONTENT = 'apps/web/src/features/pages/content';
    /** A tree with content files: locale → name → source. */
    const withContent = (files: Record<'nl' | 'en', Record<string, string>>) => {
      const root = tree({ a: 'Een' }, { a: 'One' });
      for (const loc of ['nl', 'en'] as const) {
        mkdirSync(join(root, CONTENT, loc), { recursive: true });
        for (const [name, source] of Object.entries(files[loc])) writeFileSync(join(root, CONTENT, loc, name), source);
      }
      return root;
    };
    const page = (h1: string) =>
      `import { PageLink } from '../../parts/PageLink.tsx';\nexport default function About() {\n  return <h1>${h1} <PageLink id="home" locale="nl">kaart</PageLink></h1>;\n}\n`;

    it('is exempt from the hard-coded text scan when both languages have the file', () => {
      expect(checkI18n(withContent({ nl: { 'About.tsx': page('Over') }, en: { 'About.tsx': page('About') } }))).toEqual(
        [],
      );
    });
    it('fails on a page missing in one language, and on an empty file', () => {
      expect(
        checkI18n(
          withContent({ nl: { 'About.tsx': page('Over'), 'Privacy.tsx': ' \n' }, en: { 'About.tsx': page('x') } }),
        ),
      ).toEqual([`${CONTENT}/en/Privacy.tsx is missing`, `${CONTENT}/nl/Privacy.tsx: empty`]);
    });
    it('fails on an import other than react and ../../parts/*, a dynamic import and an HTML string', () => {
      const bad = [
        "import { m } from '../../../../paraglide/messages.js';",
        "import x from '../../parts/../../../lib/data/api.ts';",
        "export * from 'zod';",
        'const y = import("./other.tsx");',
        'const z = <div dangerouslySetInnerHTML={{ __html: "x" }} />;',
      ].join('\n');
      expect(checkI18n(withContent({ nl: { 'About.tsx': bad }, en: { 'About.tsx': page('About') } }))).toEqual([
        `${CONTENT}/nl/About.tsx: a dynamic import`,
        `${CONTENT}/nl/About.tsx: imports ../../../../paraglide/messages.js`,
        `${CONTENT}/nl/About.tsx: imports ../../parts/../../../lib/data/api.ts`,
        `${CONTENT}/nl/About.tsx: imports zod`,
        `${CONTENT}/nl/About.tsx: sets HTML from a string`,
      ]);
    });
  });

  it('passes on the repository', () => {
    expect(checkI18n(repoRoot)).toEqual([]);
  });
});
