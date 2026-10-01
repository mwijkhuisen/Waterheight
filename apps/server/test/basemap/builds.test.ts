import { describe, expect, it } from 'vitest';
import { isCalendarDate, parseBuilds } from '../../src/basemap/builds.ts';

const NOW = new Date('2026-10-01T23:30:00Z');
const entry = (build: string, version: string) => ({ key: `${build}.pmtiles`, version });
const parse = (doc: unknown, major = 4) =>
  parseBuilds(JSON.stringify(doc), major, NOW).map((b) => `${b.build}@${b.version}`);

describe('isCalendarDate', () => {
  it.each(['20261001', '20240229', '20001231'])('%s is a date', (d) => expect(isCalendarDate(d)).toBe(true));
  it.each([
    '20260229',
    '20261301',
    '20260001',
    '20260132',
    '2026101',
    '202610011',
    'abcdefgh',
    '2026-10-0',
    '00500101',
    '',
  ])('%s is not', (d) => expect(isCalendarDate(d)).toBe(false));
});

describe('parseBuilds', () => {
  it('keeps what matches the tiles major, oldest first', () => {
    expect(parse([entry('20261001', '4.15.2'), entry('20260930', '4.15.1'), entry('20260929', '4.9.12')])).toEqual([
      '20260929@4.9.12',
      '20260930@4.15.1',
      '20261001@4.15.2',
    ]);
  });

  it('follows the registry major, and a major of two digits is not a prefix match', () => {
    const doc = [entry('20261001', '4.15.2'), entry('20260930', '14.0.1'), entry('20260929', '40.0.1')];
    expect(parse(doc, 4)).toEqual(['20261001@4.15.2']);
    expect(parse(doc, 14)).toEqual(['20260930@14.0.1']);
  });

  it.each([
    ['an older major', entry('20261001', '3.9.0')],
    ['a version with a suffix', entry('20261001', '4.15.2-rc1')],
    ['a version with a leading space', entry('20261001', ' 4.15.2')],
    ['a short version', entry('20261001', '4.15')],
    ['a long number', entry('20261001', '4.123456.2')],
    ['a number as a version', { key: '20261001.pmtiles', version: 4.15 }],
    ['no version', { key: '20261001.pmtiles' }],
    ['a trailing suffix on the file', { key: '20261001.pmtiles.bak', version: '4.15.2' }],
    ['a leading path', { key: 'x/20261001.pmtiles', version: '4.15.2' }],
    ['a parent path', { key: '../20261001.pmtiles', version: '4.15.2' }],
    ['a seven-digit date', { key: '2026100.pmtiles', version: '4.15.2' }],
    ['a name that is not a date', { key: 'latest.pmtiles', version: '4.15.2' }],
    ['an impossible date', entry('20260231', '4.15.2')],
    ['a month 13', entry('20261301', '4.15.2')],
    ['a file name that is a number', { key: 20261001, version: '4.15.2' }],
    ['null', null],
    ['a string', 'x'],
    ['an array', [entry('20261001', '4.15.2')]],
  ])('ignores %s', (_why, item) => {
    expect(parse([item])).toEqual([]);
  });

  it('ignores builds after tomorrow (UTC), and takes tomorrow', () => {
    expect(parse([entry('20261002', '4.15.3'), entry('20261003', '4.15.4')])).toEqual(['20261002@4.15.3']);
  });

  it('drops a date that is listed with two versions', () => {
    expect(parse([entry('20261001', '4.15.2'), entry('20261001', '4.15.3'), entry('20260930', '4.15.1')])).toEqual([
      '20260930@4.15.1',
    ]);
    // Listed twice with the same version: fine.
    expect(parse([entry('20261001', '4.15.2'), entry('20261001', '4.15.2')])).toEqual(['20261001@4.15.2']);
  });

  it('ignores the rest of an entry', () => {
    expect(parse([{ ...entry('20261001', '4.15.2'), size: -1, md5sum: '<script>', extra: { deep: [1] } }])).toEqual([
      '20261001@4.15.2',
    ]);
  });

  it.each([['{}'], ['"x"'], ['null'], ['not json'], [''], ['['.repeat(50)], [`[${'[],'.repeat(60_000)}[]]`]])(
    'rejects a document that is not a bounded array (#%#)',
    (text) => {
      expect(() => parseBuilds(text, 4, NOW)).toThrowError(expect.objectContaining({ code: 'builds_invalid' }));
    },
  );
});
