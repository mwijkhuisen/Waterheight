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

  it('passes on the repository', () => {
    expect(checkI18n(repoRoot)).toEqual([]);
  });
});
