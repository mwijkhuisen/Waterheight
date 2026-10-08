import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { emptyNormalised, type Normalised, SchemaDrift } from '@rws/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_TEXTS_BYTES, normalise } from '../../src/adapters/lu-5/normalise.ts';
import { type CapAlert, MAX_CHARS, parseCap, parseList, SENDER } from '../../src/adapters/lu-5/parse.ts';
import type { LoadContext } from '../../src/load/adapters.ts';
import { ADAPTER } from '../../src/load/wire/lu-5.ts';
import { goldenUrl, rawFixture } from './registry.ts';

// LU-5 LU-Alert CAP 1.2: parse + normalise of the real files of AGE (and five of other senders) equals the committed
// golden files (invariant 9); the hostile synthetic files are refused with a fixed code and nothing in them is
// ever resolved. `UPDATE_GOLDEN=1` rewrites the goldens; a golden change is reviewed like code.

const text = (name: string) => rawFixture('LU-5', name).body.toString('utf8');
const fetchedAt = (name: string) => Date.parse(rawFixture('LU-5', name).meta.recorded_at);
const run = (name: string) => normalise(parseCap(text(name)), { fetchedAt: fetchedAt(name) });
/** An AGE file parsed under the strict schema, or a failure of the test if it was taken for another sender's. */
function age(xml: string): CapAlert {
  const cap = parseCap(xml);
  if ('other' in cap) throw new Error('taken for another sender');
  return cap;
}

function golden(name: string, actual: Normalised): Normalised {
  const url = goldenUrl('LU-5', name);
  if (process.env.UPDATE_GOLDEN === '1') writeFileSync(url, `${JSON.stringify(actual, null, 1)}\n`);
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const wire = ADAPTER.specs['lu-5-cap'];
const loadCtx = (variant: string): LoadContext => ({
  registry: new Map(),
  fetchedAt: Date.parse('2026-10-03T12:00:00Z'),
  variant,
  unitMismatch: new Set(),
});
const viaWire = (body: string | Buffer, variant = 'file/00000000-0000-4000-8000-000000000000') =>
  wire?.run(typeof body === 'string' ? Buffer.from(body) : body, loadCtx(variant)) as Normalised;
/** The fixed code a call is refused with, or a failure of the test if it is refused with anything else. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SchemaDrift);
    return (err as SchemaDrift).code;
  }
  throw new Error('not refused');
}

const FILES = readdirSync(new URL('../../src/adapters/lu-5/fixtures/', import.meta.url))
  .filter((f) => /^lu-5-cap-\d{8}-\d{6}-.*\.raw$/.test(f))
  .map((f) => f.replace(/\.raw$/, ''));
const MOSELLE = 'lu-5-cap-20260213-095631-alert-lvl3';
/** The real files of other senders the first replay quarantined (#72): Police, ALVA, CGDIS and `LU-Alert`. */
const OTHERS = ['unrecognized-keys', 'too-big', 'text-char', 'lu-alert'].map((n) => `lu-5-other-${n}`);
const SUD_RED = 'lu-5-cap-20250908-231502-alert-lvl1';

describe('golden files (real payloads)', () => {
  it.each([
    SUD_RED,
    'lu-5-cap-20250909-080458-update-lvl1',
    'lu-5-cap-20250908-231529-cancel',
    'lu-5-cap-20260202-095833-alert-test',
    'lu-5-file',
    MOSELLE,
    'lu-5-cap-20250909-080509-alert-lvl4',
    ...OTHERS,
  ])('%s', (name) => {
    const out = run(name);
    expect(out).toEqual(golden(name, out));
  });

  it('the red alert for the south, sent 2025-09-08 23:15:02 (+02:00): one row, level 5, three languages, [lon, lat]', () => {
    const out = run(SUD_RED);
    expect(out.dropped).toEqual({});
    expect(out.warnings?.mode).toBe('message');
    const w = out.warnings as Extract<NonNullable<Normalised['warnings']>, { mode: 'message' }>;
    expect(w.sent).toBe('2025-09-08T21:15:02.000Z');
    expect(w.cancels).toEqual([]);
    expect(w.rows).toHaveLength(1);
    const row = w.rows[0] as (typeof w.rows)[number];
    expect(row).toMatchObject({
      area_key: 'Sud du Luxembourg',
      name: 'Sud du Luxembourg',
      level: 5,
      level_raw: 'ALERT_LVL_1',
      label_raw: 'Vigilance rouge inondations sud',
      valid_from: '2025-09-08T21:15:02.000Z',
      valid_to: '2025-09-09T16:00:00.000Z',
      issued_at: '2025-09-08T21:15:02.000Z',
      ref: 'LU-Alert.1757366102.4024.0',
    });
    // All three language blocks are kept, each with its own headline and description.
    expect(Object.keys(row.texts ?? {}).sort()).toEqual(['de', 'en-US', 'fr-FR']);
    expect(row.texts?.['fr-FR']?.headline).toBe('Inondations au sud du Luxembourg');
    expect(row.texts?.en?.headline).toBeUndefined();
    // The XML is decoded once: the provider's HTML stays text (never a sink), its own `&amp;#39;` is `&#39;`.
    const fr = row.texts?.['fr-FR']?.description ?? '';
    expect(fr.startsWith('<p><span style="color: black;">Le sud du Luxembourg')).toBe(true);
    expect(fr).toContain('l&#39;évolution');
    // CAP "lat,lon" → GeoJSON [lon, lat], the ring closed as published.
    const geo = JSON.parse(row.geometry as string);
    expect(geo.type).toBe('Polygon');
    expect(geo.coordinates[0][0]).toEqual([6.113263, 49.848093]);
    expect(geo.coordinates[0].at(-1)).toEqual(geo.coordinates[0][0]);
    expect(geo.coordinates[0]).toHaveLength(163);
  });

  it('the levels are inverted: ALERT_LVL_1 is level 5 (red) … ALERT_LVL_4 is level 2, in every real flood alert', () => {
    let seen = 0;
    for (const name of FILES) {
      const n = /-(?:alert|update)-lvl(\d)$/.exec(name)?.[1];
      if (n === undefined) continue;
      const w = run(name).warnings;
      if (w?.mode !== 'message') throw new Error('mode');
      expect(w.rows.map((r) => [r.level_raw, r.level])).toEqual([[`ALERT_LVL_${n}`, 6 - Number(n)]]);
      seen += 1;
    }
    expect(seen).toBe(19);
  });

  it('every real [AGE] file is stored or refused as designed: Cancels have no rows, an Update names what it replaces', () => {
    expect(FILES).toHaveLength(24);
    for (const name of FILES) {
      const cap = age(text(name));
      const out = run(name);
      const w = out.warnings;
      if (w?.mode !== 'message') throw new Error('mode');
      expect(cap.sender).toBe('[AGE]');
      if (name.endsWith('-cancel')) {
        expect(cap.info).toHaveLength(0);
        expect([w.rows.length, w.cancels.length > 0]).toEqual([0, true]);
      } else if (name.endsWith('-test')) {
        expect([out.dropped, w.rows, w.cancels]).toEqual([{ test: 1 }, [], []]);
      } else {
        expect(w.rows).toHaveLength(1);
        expect(w.cancels.length > 0).toBe(name.includes('-update-'));
      }
    }
  });

  it('an Update names the message it replaces; a Cancel the two it closes (identifiers of the triples)', () => {
    const u = run('lu-5-cap-20250909-080458-update-lvl1').warnings;
    const c = run('lu-5-cap-20250908-231529-cancel').warnings;
    expect(u?.mode === 'message' && u.cancels).toEqual(['LU-Alert.1757366102.4024.0']);
    expect(c?.mode === 'message' && c.cancels).toEqual(['LU-Alert.1757346271.4018.0', 'LU-Alert.1757348488.4018.1']);
  });

  it('the TEST of 2026-02-02 says <status>Actual</status> and is dropped by its parameter and headline, with no cancel', () => {
    const name = 'lu-5-cap-20260202-095833-alert-test';
    expect(age(text(name)).status).toBe('Actual');
    const out = run(name);
    expect(out.dropped).toEqual({ test: 1 });
    expect(out.warnings).toEqual({ mode: 'message', sent: '2026-02-02T08:58:33.000Z', rows: [], cancels: [] });
  });

  it('the ALVA food recall (a different sender, FOOD_RECALL) is dropped before anything is stored, with no warnings', () => {
    const out = run('lu-5-file');
    expect(out.dropped).toEqual({ other_sender: 1 });
    expect(out.warnings).toBeUndefined();
  });

  it('the Moselle alert of 2026-02-13: yellow (3 → 3), the sender-local +01:00 time in UTC', () => {
    const w = run(MOSELLE).warnings;
    expect(w?.mode === 'message' && w.rows[0]).toMatchObject({
      area_key: 'Moselle',
      level: 3,
      level_raw: 'ALERT_LVL_3',
      label_raw: 'Vigilance jaune inondations Moselle',
      valid_from: '2026-02-13T09:00:00.000Z',
      valid_to: '2026-02-15T09:00:00.000Z',
    });
  });
});

describe('what normalise drops, and when', () => {
  const moselle = text(MOSELLE);
  const go = (xml: string, at = Date.parse('2026-02-13T09:00:00Z')) => normalise(parseCap(xml), { fetchedAt: at });
  const rows = (out: Normalised) => (out.warnings?.mode === 'message' ? out.warnings.rows : []);

  it('a TEST by the cb-eu-level parameter alone, or by the headline alone, in any block, also on an Update', () => {
    expect(go(moselle.replaceAll('ALERT_LVL_3', 'TEST')).dropped).toEqual({ test: 1 });
    expect(go(moselle.replace('<headline>Hochwasser', '<headline>TEST Hochwasser')).dropped).toEqual({ test: 1 });
    const update = text('lu-5-cap-20260213-160002-update-lvl3').replaceAll('ALERT_LVL_3', 'TEST');
    const out = go(update, Date.parse('2026-02-14T00:00:00Z'));
    expect(out.warnings).toMatchObject({ rows: [], cancels: [] });
    expect(out.dropped).toEqual({ test: 1 });
  });

  it('a message whose <status> is not Actual (an exercise, a system or test message, a draft) is no real alert', () => {
    for (const status of ['Exercise', 'System', 'Test', 'Draft']) {
      const out = go(moselle.replace('<status>Actual</status>', `<status>${status}</status>`));
      expect([status, out.dropped, out.warnings]).toMatchObject([status, { not_actual: 1 }, { rows: [], cancels: [] }]);
    }
  });

  it('an AGE message that is not a flood is dropped', () => {
    expect(go(moselle.replaceAll('<value>FLOOD', '<value>FIRE')).dropped).toEqual({ not_flood: 1 });
    expect(go(moselle.replaceAll('<valueName>LU_Alert', '<valueName>Other')).dropped).toEqual({ not_flood: 1 });
  });

  it('a sent more than 15 minutes after the fetch is dropped as future, exactly 15 is kept', () => {
    const sent = Date.parse('2026-02-13T08:56:31Z');
    expect(go(moselle, sent - 16 * 60_000).dropped).toEqual({ future: 1 });
    expect(rows(go(moselle, sent - 16 * 60_000))).toEqual([]);
    expect(rows(go(moselle, sent - 15 * 60_000))).toHaveLength(1);
  });

  it('a level the crosswalk does not know, or none, drops the area as unmapped_class (kept for a replay)', () => {
    expect(go(moselle.replaceAll('ALERT_LVL_3', 'ALERT_LVL_9')).dropped).toEqual({ unmapped_class: 1 });
    expect(go(moselle.replaceAll(':cb-eu-level', ':cb-eu-levl')).dropped).toEqual({ unmapped_class: 1 });
  });

  it('blocks that state different levels for one area, or one language twice, withhold the area (conflict)', () => {
    expect(go(moselle.replace('ALERT_LVL_3', 'ALERT_LVL_2')).dropped).toEqual({ conflict: 1 });
    expect(go(moselle.replace('<language>de', '<language>fr-FR')).dropped).toEqual({ conflict: 1 });
  });

  it('two polygons of an area are a MultiPolygon; an area without a polygon has no geometry; an area per areaDesc', () => {
    const second = '<polygon>49.1,6.1 49.1,6.2 49.2,6.2 49.1,6.1</polygon>';
    const multi = moselle.replace('</area>', `${second}</area>`);
    const geo = JSON.parse(rows(go(multi))[0]?.geometry as string);
    expect(geo.type).toBe('MultiPolygon');
    expect(geo.coordinates).toHaveLength(2);
    expect(geo.coordinates[1]).toEqual([
      [
        [6.1, 49.1],
        [6.2, 49.1],
        [6.2, 49.2],
        [6.1, 49.1],
      ],
    ]);
    expect(rows(go(moselle.replace(/<polygon>[^<]*<\/polygon>/g, ''))).map((r) => r.geometry)).toEqual([null]);
    // A second area of the base block is a second row.
    const two = moselle.replace('</area>', '</area><area><areaDesc>Autre</areaDesc></area>');
    expect(rows(go(two)).map((r) => r.area_key)).toEqual(['Moselle', 'Autre']);
  });

  it('a malformed pair, a short ring, an unclosed ring and a coordinate out of range are bad_polygon, never repaired', () => {
    const poly = (p: string) => moselle.replace(/<polygon>[^<]*<\/polygon>/, `<polygon>${p}</polygon>`);
    const ring = '49.1,6.1 49.1,6.2 49.2,6.2';
    for (const p of [`${ring} 49.1;6.1`, `${ring} 49.1`, ring, `${ring} 49.2,6.1`, `${ring} 91,6.1 91,6.1`])
      expect(codeOf(() => go(poly(p)))).toBe('bad_polygon');
  });

  it('a time the provider states badly is bad_time; references that are no triples are bad_references', () => {
    expect(codeOf(() => go(moselle.replace('2026-02-13T09:56:31+01:00', '13.02.2026 09:56')))).toBe('bad_time');
    expect(
      codeOf(() => go(moselle.replace('<expires>2026-02-15T10:00:00+01:00', '<expires>2026-02-15T10:00:00'))),
    ).toBe('bad_time');
    const update = text('lu-5-cap-20260213-160002-update-lvl3');
    const later = Date.parse('2026-02-14T00:00:00Z');
    const refs = /<references>([^<]*)<\/references>/.exec(update)?.[1] as string;
    expect(codeOf(() => go(update.replace(refs, 'LU-Alert.1'), later))).toBe('bad_references');
    expect(codeOf(() => go(update.replace(refs, Array(51).fill('a,b,c').join(' ')), later))).toBe(
      'references_too_many',
    );
    // A message of type Alert never cancels, whatever it references.
    expect(
      go(moselle.replace('<code>IN_ZONE', `<references>${refs}</references><code>IN_ZONE`)).warnings,
    ).toMatchObject({
      cancels: [],
    });
  });

  it('an effective time is optional: the message is valid from its sent', () => {
    const out = go(moselle.replaceAll(/<effective>[^<]*<\/effective>/g, ''));
    expect(rows(out)[0]?.valid_from).toBe('2026-02-13T08:56:31.000Z');
  });

  it('an effective or expires more than 30 days after sent drops the area as future (review SR-7)', () => {
    const expires = (to: string) => moselle.replaceAll(/<expires>[^<]*<\/expires>/g, `<expires>${to}</expires>`);
    expect(rows(go(expires('2026-03-15T09:56:31+01:00')))).toHaveLength(1);
    const late = go(expires('2026-03-15T09:56:32+01:00'));
    expect([rows(late), late.dropped]).toEqual([[], { future: 1 }]);
    const effective = go(
      moselle.replaceAll(/<effective>[^<]*<\/effective>/g, '<effective>2026-04-01T00:00:00+01:00</effective>'),
    );
    expect([rows(effective), effective.dropped]).toEqual([[], { future: 1 }]);
  });

  it('texts over MAX_TEXTS_BYTES lose every description, whole, and are counted texts_trimmed (review SR-2)', () => {
    const long = moselle.replaceAll(
      /<description>[^<]*<\/description>/g,
      `<description>${'€'.repeat(8000)}</description>`,
    );
    const out = go(long);
    expect(out.dropped).toEqual({ texts_trimmed: 1 });
    const texts = rows(out)[0]?.texts ?? {};
    expect(Object.keys(texts).length).toBeGreaterThan(1);
    for (const t of Object.values(texts)) {
      expect(t.description).toBeUndefined();
      expect(t.headline).toBeDefined();
    }
    expect(Buffer.byteLength(JSON.stringify(texts))).toBeLessThanOrEqual(MAX_TEXTS_BYTES);
    // The real file is far under the bound: nothing is left out.
    expect(go(moselle).dropped).toEqual({});
  });
});

describe('strict parse', () => {
  const moselle = text(MOSELLE);
  const refused = (xml: string) => codeOf(() => parseCap(xml));

  it('refuses what the schema does not know, with a fixed code', () => {
    expect(refused(moselle.replace('<scope>', '<surprise>1</surprise><scope>'))).toBe('unrecognized_keys');
    expect(refused(moselle.replace('<sent>', '<sent a="1">'))).toBe('invalid_type');
    expect(refused(moselle.replace('<alert ', '<alert x="1" '))).toBe('unrecognized_keys');
    expect(refused(moselle.replace('<msgType>Alert', '<msgType>Remove'))).toBe('invalid_value');
    expect(refused(moselle.replace('cap:1.2:profile', 'cap:1.1:profile'))).toBe('invalid_format');
    expect(refused(moselle.replace(/ xmlns="[^"]*"/, ''))).toBe('invalid_type');
    expect(refused(moselle.replace('<identifier>', '<identifier>x</identifier><identifier>'))).toBe('invalid_type');
    expect(refused('<alert/>')).toBe('not_cap');
    expect(refused('<other xmlns="a"/>')).toBe('not_cap');
    expect(refused('<alert><![CDATA[x]]></alert>')).toBe('not_cap');
  });

  it('refuses a non-UTF-8 declaration, malformed XML, unknown entities and forbidden characters', () => {
    expect(refused(moselle.replace('UTF-8', 'ISO-8859-1'))).toBe('xml_encoding');
    expect(refused(moselle.replace('</alert>', ''))).toBe('xml_invalid');
    expect(refused(moselle.replace('Moselle</areaDesc>', '&nbsp;</areaDesc>'))).toBe('xml_reference');
    expect(refused(moselle.replace('Moselle</areaDesc>', '&#1;</areaDesc>'))).toBe('xml_reference');
    expect(refused(moselle.replace('Moselle</areaDesc>', '&#x202E;</areaDesc>'))).toBe('text_char');
    expect(refused(moselle.replace('Moselle</areaDesc>', '\u0007</areaDesc>'))).toBe('text_char');
    expect(refused(moselle.replace('Moselle</areaDesc>', '‮</areaDesc>'))).toBe('text_char');
  });

  it('bounds the file, its lists and its texts', () => {
    const block = /<info>[\s\S]*?<\/info>/.exec(moselle)?.[0] as string;
    expect(refused(moselle.replace(block, block.repeat(9)))).toBe('too_big');
    expect(refused(moselle.replace(/<headline>[^<]*/, `<headline>${'h'.repeat(501)}`))).toBe('too_big');
    expect(refused(moselle.replace(/<description>[^<]*/, `<description>${'d'.repeat(8001)}`))).toBe('too_big');
    expect(refused(moselle.replace('</alert>', `<!-- ${'-'.repeat(MAX_CHARS)} --></alert>`))).toBe('xml_size');
    expect(refused(`<alert xmlns="x">${'<a/>'.repeat(2001)}</alert>`)).toBe('xml_too_many_items');
    expect(refused(`${'<a>'.repeat(40)}${'</a>'.repeat(40)}`)).toBe('xml_too_deep');
    // Mixed content (text beside a child) is not a text field.
    expect(refused(moselle.replace('<code>IN_ZONE</code>', '<code>IN_ZONE<b>x</b></code>'))).toBe('invalid_type');
  });

  it('an element or attribute named __proto__ or constructor never reaches an object', () => {
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      expect(refused(moselle.replace('<scope>', `<${name}><polluted>1</polluted></${name}><scope>`))).toBe('xml_name');
      // An attribute is kept under an `@_` key and so cannot name a prototype; the schema refuses it as it does any.
      expect(refused(moselle.replace('<scope>', `<scope ${name}="1">`))).toBe('invalid_value');
    }
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    // As a value it is only text.
    expect(age(moselle.replace('<code>IN_ZONE', '<code>__proto__')).code).toBe('__proto__');
  });
});

describe('other senders (#72): told apart after every XML guard and before the strict schema', () => {
  const moselle = text(MOSELLE);
  const tag = `<sender>${SENDER}</sender>`;
  const police = moselle.replace(tag, '<sender>[Police]</sender>');
  const refused = (xml: string) => codeOf(() => parseCap(xml));
  const other = { ...emptyNormalised(), dropped: { other_sender: 1 } };
  const block = /<info>[\s\S]*?<\/info>/.exec(moselle)?.[0] as string;
  const control = String.fromCharCode(1);

  it('the four real files the first replay quarantined are other_sender, with no rows and no warnings', () => {
    for (const name of OTHERS) {
      expect([name, parseCap(text(name))]).toEqual([name, { other: true }]);
      const out = run(name);
      expect([name, out, out.warnings]).toEqual([name, other, undefined]);
      expect([name, viaWire(rawFixture('LU-5', name).body)]).toEqual([name, other]);
    }
  });

  it('an element, a list size or a character the schema refuses in an AGE file does not matter in another sender’s', () => {
    expect(police).not.toBe(moselle);
    for (const xml of [
      police.replace('<scope>', '<note>x</note><scope>'),
      police.replace(block, block.repeat(9)),
      police.replace('<headline>', `<headline>${control}`),
      moselle.replace(tag, '<sender>AGE</sender>'),
      // A sender that does not decode cleanly is no AGE sender either.
      moselle.replace(tag, '<sender>&#1;</sender>'),
      moselle.replace(tag, `<sender>${SENDER}&#x202E;</sender>`),
    ])
      expect(parseCap(xml)).toEqual({ other: true });
  });

  it('every XML guard still runs first, whoever the sender', () => {
    expect(refused(police.replace('<alert', '<!DOCTYPE alert><alert'))).toBe('xml_dtd');
    expect(refused(police.replace('<scope>', '<__proto__><polluted>1</polluted></__proto__><scope>'))).toBe('xml_name');
    expect(refused(police.replace('</alert>', `${'<a/>'.repeat(2001)}</alert>`))).toBe('xml_too_many_items');
    expect(refused(police.replace('UTF-8', 'ISO-8859-1'))).toBe('xml_encoding');
    expect(refused(police.replace('</alert>', ''))).toBe('xml_invalid');
    expect(refused(police.replace('</alert>', `<!-- ${'-'.repeat(MAX_CHARS)} --></alert>`))).toBe('xml_size');
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('a missing, repeated, attributed or empty sender is not_cap: drift, never other_sender', () => {
    expect(refused(moselle.replace(tag, ''))).toBe('not_cap');
    expect(refused(moselle.replace(tag, `${tag}${tag}`))).toBe('not_cap');
    expect(refused(police.replace('<sender>', `${tag}<sender>`))).toBe('not_cap');
    expect(refused(moselle.replace(tag, `<sender a="1">${SENDER}</sender>`))).toBe('not_cap');
    expect(refused(moselle.replace(tag, '<sender/>'))).toBe('not_cap');
    expect(refused(moselle.replace(tag, '<sender>  </sender>'))).toBe('not_cap');
  });

  it('AGE written with references or spaces is AGE, and stays under the strict schema', () => {
    const coded = moselle.replace(tag, '<sender>&#91;AGE&#93;</sender>');
    const at = { fetchedAt: Date.parse('2026-02-13T09:00:00Z') };
    expect(coded).not.toBe(moselle);
    expect(normalise(parseCap(coded), at)).toEqual(normalise(parseCap(moselle), at));
    expect(refused(coded.replace('<scope>', '<note>x</note><scope>'))).toBe('unrecognized_keys');
    expect(age(moselle.replace(tag, `<sender> ${SENDER} </sender>`)).sender).toBe(SENDER);
  });

  it('AGE’s own files are exactly as strict as before', () => {
    expect(refused(moselle.replace('<scope>', '<note>x</note><scope>'))).toBe('unrecognized_keys');
    expect(refused(moselle.replace(block, block.repeat(9)))).toBe('too_big');
    expect(refused(moselle.replace('<headline>', `<headline>${control}`))).toBe('text_char');
  });
});

describe('hostile files are refused with a fixed code and nothing in them is resolved', () => {
  it.each([
    ['lu-5-xxe-file.synthetic', 'xml_dtd'],
    ['lu-5-xxe-http.synthetic', 'xml_dtd'],
    ['lu-5-billion-laughs.synthetic', 'xml_dtd'],
    ['lu-5-doctype.synthetic', 'xml_dtd'],
  ])('%s: %s at the wire and in the pure parser', (name, code) => {
    const body = rawFixture('LU-5', name).body;
    expect(codeOf(() => viaWire(body))).toBe(code);
    expect(codeOf(() => parseCap(body.toString('utf8')))).toBe(code);
    // The refusal names no provider text: the code and nothing else.
    try {
      viaWire(body);
    } catch (err) {
      expect((err as Error).message).toBe(code);
    }
  });

  it('a polygon with a malformed pair is bad_polygon; an element named __proto__ is xml_name', () => {
    expect(codeOf(() => viaWire(rawFixture('LU-5', 'lu-5-bad-polygon.synthetic').body))).toBe('bad_polygon');
    expect(codeOf(() => viaWire(rawFixture('LU-5', 'lu-5-proto.synthetic').body))).toBe('xml_name');
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('a body over 1 MiB is xml_size (the wire and the parser); invalid UTF-8 is xml_utf8', () => {
    const big = Buffer.concat([Buffer.from('<alert>'), Buffer.alloc(1024 * 1024, 0x61), Buffer.from('</alert>')]);
    expect(codeOf(() => viaWire(big))).toBe('xml_size');
    expect(codeOf(() => parseCap(big.toString('utf8')))).toBe('xml_size');
    expect(codeOf(() => viaWire(Buffer.from([0x3c, 0xff, 0xfe])))).toBe('xml_utf8');
  });
});

describe('the wire', () => {
  it('a CAP file goes through the guard, the parser and normalise', () => {
    const out = viaWire(rawFixture('LU-5', 'lu-5-cap-20250908-231502-alert-lvl1').body);
    expect(out.warnings?.mode === 'message' && out.warnings.rows.map((r) => r.level)).toEqual([5]);
  });

  it('the resource list page is checked for its shape and stores nothing, for any variant but a file', () => {
    const page = rawFixture('LU-5', 'lu-5-cap').body;
    for (const variant of ['', 'default', 'list']) {
      const out = viaWire(page, variant);
      expect([out.obs, out.warnings, out.dropped]).toEqual([[], undefined, {}]);
    }
    expect(codeOf(() => viaWire('{"data": 1}', 'list'))).toBe('invalid_type');
    expect(codeOf(() => viaWire('{"data": [{"id": 1}]}', 'list'))).toBe('invalid_type');
    expect(codeOf(() => viaWire('nope', 'list'))).toBe('not_json');
    expect(codeOf(() => parseList(`{"data": [${Array(101).fill('{}').join(',')}]}`))).toBe('too_big');
  });
});

describe('property', () => {
  const real = text(MOSELLE);
  const cancel = text('lu-5-cap-20250908-231529-cancel');
  /** Only SchemaDrift (or a normalised message) ever comes out, from the wire's run too. */
  const safe = (xml: string) => {
    for (const f of [() => parseCap(xml), () => viaWire(xml)]) {
      try {
        f();
      } catch (err) {
        expect(err).toBeInstanceOf(SchemaDrift);
      }
    }
  };

  it('any string, any truncation and any insertion into a real file is a message or a SchemaDrift, nothing else', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (s) => safe(s)),
      { numRuns: 300 },
    );
    fc.assert(
      fc.property(fc.nat(real.length), (n) => safe(real.slice(0, n))),
      { numRuns: 150 },
    );
    fc.assert(
      fc.property(fc.nat(cancel.length), fc.string({ maxLength: 40 }), (n, s) =>
        safe(cancel.slice(0, n) + s + cancel.slice(n)),
      ),
      { numRuns: 300 },
    );
    fc.assert(
      fc.property(
        fc.nat(real.length),
        fc.constantFrom('<', '>', '&', '&#0;', '<!--', ']]>', '<![CDATA[', '"', '\u0000'),
        (n, s) => safe(real.slice(0, n) + s + real.slice(n)),
      ),
      { numRuns: 300 },
    );
  });

  it('any other sender, with any extra element in <alert> or an <info>, is other_sender and never a schema code (#72)', () => {
    // The parser trims the text, so ` [AGE] ` is AGE's: the filter trims as well. Controls and bad references stay in.
    const sender = fc
      .string({ unit: 'binary', maxLength: 30 })
      .filter((s) => s.trim() !== '' && s.trim() !== SENDER)
      .map((s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;'));
    const name = fc
      .stringMatching(/^[A-Za-z_][A-Za-z0-9_.-]{0,15}$/)
      .filter((n) => !['__proto__', 'constructor', 'prototype', 'sender'].includes(n));
    fc.assert(
      fc.property(sender, name, fc.constantFrom('<scope>', '<category>'), (s, n, before) => {
        const xml = real
          .replace(`<sender>${SENDER}</sender>`, `<sender>${s}</sender>`)
          .replace(before, `<${n}>x</${n}>${before}`);
        expect(parseCap(xml)).toEqual({ other: true });
      }),
      { numRuns: 200 },
    );
  });
});
