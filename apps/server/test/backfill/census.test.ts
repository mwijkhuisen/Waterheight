import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bareLine } from '../../../../scripts/fixture-archive.ts';
import { parseWaarnemingen } from '../../src/adapters/nl-1/parse.ts';
import { ArchiveReader } from '../../src/archive/reader.ts';
import { Archive, objectKey, sha256 } from '../../src/archive/writer.ts';
import { beforeFix, census, isoStep } from '../../src/backfill/census.ts';
import { backfillMain, parseBackfillArgs } from '../../src/backfill/cli.ts';
import { loadBackfill } from '../../src/backfill/spec.ts';
import { loadRegistry } from '../../src/capture/specs.ts';
import { readRegistry } from '../../src/load/registry-sync.ts';
import { rawFixture } from '../adapters/registry.ts';

// `backfill census` (#184, KG-342) on one archive of real NL-1 backfill payloads, a few synthetic edits of them (a
// synthetic payload is an extra test, never a golden) and every kind of line the walk must count or skip. Offline:
// the census reads a temp archive and the registry; nothing fetches and no database is opened.

const SPEC = 'nl-1-backfill-obs';
const LITH = 'lith.boven/WATHTE/NAP/other:F007';
const LIVE = rawFixture('NL-1', 'nl-1-fc-1h').body; // any real NL-1 payload, filed under another spec
const real = (name: string) => rawFixture('NL-1', `nl-1-backfill-${name}`).body;

type Meting = {
  Meetwaarde: { Waarde_Numeriek: number };
  Tijdstip: string;
  WaarnemingMetadata: { Kwaliteitswaardecode: string; Statuswaarde: string };
};
type Coded = { Code: string };
type Lijst = {
  AquoMetadata: {
    WaardeBewerkingsMethode: Coded;
    WaardeBepalingsMethode: Coded;
    Grootheid: Coded;
    Hoedanigheid: Coded;
    Eenheid: Coded;
  };
  Locatie: { Code: string };
  MetingenLijst: Meting[];
};
type Doc = { WaarnemingenLijst: Lijst[] };
const json = (body: Buffer) => JSON.parse(body.toString('utf8')) as Doc;
const shiftYear = (doc: Doc, from: string, to: string) => {
  for (const l of doc.WaarnemingenLijst) for (const m of l.MetingenLijst) m.Tijdstip = m.Tijdstip.replaceAll(from, to);
};
const toBody = (doc: Doc) => Buffer.from(JSON.stringify(doc));

/** The 2004 copy of the Lith payload with the two edits, and what they must produce. */
function lith2004() {
  const doc = json(real('lith-h-20030129'));
  shiftYear(doc, '2003-', '2004-');
  const list = (bewerking: string) => {
    const l = doc.WaarnemingenLijst.find((x) => x.AquoMetadata.WaardeBewerkingsMethode.Code === bewerking);
    if (l === undefined) throw new Error(`no ${bewerking} list`);
    return l;
  };
  const daily = new Map(
    list('GEM24H').MetingenLijst.map((m) => [Date.parse(m.Tijdstip), m.Meetwaarde.Waarde_Numeriek]),
  );
  const midnights = list('NVT').MetingenLijst.filter(
    (m) => daily.has(Date.parse(m.Tijdstip)) && m.WaarnemingMetadata.Kwaliteitswaardecode === '00',
  );
  const differing = midnights.find((m) => daily.get(Date.parse(m.Tijdstip)) !== m.Meetwaarde.Waarde_Numeriek);
  const same = midnights.find((m) => daily.get(Date.parse(m.Tijdstip)) === m.Meetwaarde.Waarde_Numeriek);
  if (differing === undefined || same === undefined) throw new Error('no midnight instant to edit');
  const orphan = {
    ts: new Date(Date.parse(differing.Tijdstip)).toISOString(),
    value: daily.get(Date.parse(differing.Tijdstip)),
  };
  differing.WaarnemingMetadata.Kwaliteitswaardecode = '99'; // a gap value: the NVT sample is dropped, the daily one was not
  same.WaarnemingMetadata.Statuswaarde = 'Ongecontroleerd'; // the same value, an older state than the daily mean's
  return { body: toBody(doc), orphan };
}

/** A provider string that would break a line or inject markup if it were ever printed (review SR-4). */
const EVIL = 'x<script>"\n{"orphan":1}';
/** The 1996 copy of the Lobith H 1995 payload with every printed code hostile. */
function hostile() {
  const doc = json(real('lobith-h-19950125'));
  shiftYear(doc, '1995-', '1996-');
  for (const l of doc.WaarnemingenLijst) {
    l.Locatie.Code = EVIL;
    for (const f of [
      'Grootheid',
      'Hoedanigheid',
      'WaardeBepalingsMethode',
      'WaardeBewerkingsMethode',
      'Eenheid',
    ] as const)
      l.AquoMetadata[f].Code = EVIL;
  }
  return toBody(doc);
}

/** The Lobith H 1995 payload moved to another year, optionally under another location code. */
function lobithH(year: string, code?: string) {
  const doc = json(real('lobith-h-19950125'));
  shiftYear(doc, '1995-', `${year}-`);
  if (code !== undefined) for (const l of doc.WaarnemingenLijst) l.Locatie.Code = code;
  return toBody(doc);
}

/** The Lobith Q payload moved to 2011. */
function lobithQ2011() {
  const doc = json(real('lobith-q-20100101'));
  shiftYear(doc, '2010-', '2011-');
  return toBody(doc);
}

let root: string;
let emptyDir: string;
let otherSpecRoot: string;
let missingRoot: string;
let orphan: { ts: string; value: number | undefined };
const out: unknown[] = [];
const err: string[] = [];
let code: number;

const registryInput = readRegistry();
const config = loadBackfill(loadRegistry().hosts);
const run = async (reader: ArchiveReader, spec = SPEC) => {
  const lines: unknown[] = [];
  const logs: string[] = [];
  const exit = await census(
    { cmd: 'census', spec },
    { config, registry: registryInput, reader },
    (o) => lines.push(o),
    (l) => logs.push(l),
  );
  return { exit, lines, logs };
};

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'census-test-'));
  emptyDir = mkdtempSync(join(tmpdir(), 'census-empty-'));
  otherSpecRoot = mkdtempSync(join(tmpdir(), 'census-other-'));
  missingRoot = join(emptyDir, 'no-such-root');

  // Fetches a minute apart, from just before a UTC midnight: the manifest spans two day files.
  let at = Date.parse('2026-10-13T23:50:30Z');
  const next = () => {
    at += 60_000;
    return new Date(at);
  };
  const store = async (archive: Archive, spec: string, body: Buffer, when: Date) => {
    const hash = sha256(body);
    const { key, stored } = await archive.put('NL-1', spec, when, body, hash);
    return { hash, key, stored };
  };
  const archive = new Archive(root);
  const window = (job: number, chunk: number, from: string, to: string) => ({
    job,
    chunk,
    from: `${from}T00:00:00.000Z`,
    to: `${to}T00:00:00.000Z`,
  });
  const put = async (
    body: Buffer,
    backfill: ReturnType<typeof window> | undefined,
    extra: Partial<Parameters<typeof bareLine>[3]> = {},
    spec = SPEC,
  ) => {
    const when = next();
    const { hash, key, stored } = await store(archive, spec, body, when);
    await archive.append(
      bareLine('NL-1', spec, when, {
        request: { method: 'POST', url: 'https://ddapi20-waterwebservices.rijkswaterstaat.nl/x' },
        sha256: hash,
        bytes: body.length,
        stored_bytes: stored,
        key,
        validity: { ok: true, reason: null, count: 1 },
        retention: 'backfill',
        ...(backfill === undefined ? {} : { backfill }),
        ...extra,
      }),
    );
  };

  const lith = real('lith-h-20030129');
  await put(lith, window(1, 0, '2003-01-29', '2003-03-10')); // 1
  await put(real('lobith-q-20100101'), window(2, 0, '2010-01-01', '2010-02-10')); // 2
  await put(real('lobith-h-19950125'), window(3, 0, '1995-01-25', '1995-03-06')); // 3
  await put(real('lobith-h-19600101'), window(3, 1, '1960-01-01', '1960-02-10')); // 4: below the 1990 floor
  await put(lith, window(5, 0, '2003-01-29', '2003-03-10')); // 5: a re-planned job's refetch
  const l04 = lith2004();
  orphan = l04.orphan;
  await put(l04.body, window(4, 0, '2004-01-29', '2004-03-10')); // 6
  await put(hostile(), window(6, 0, '1996-01-25', '1996-03-06')); // 7
  await put(lobithQ2011(), undefined); // 8: an open window
  await put(LIVE, undefined, {}, 'nl-1-obs-key'); // 9: another spec
  // 10: an error line, no payload
  await archive.append(
    bareLine('NL-1', SPEC, next(), { status: null, error: 'timeout', key: null, retention: 'backfill' }),
  );
  // 11: a stored object, but the provider said 500
  await put(real('lobith-h-19600101'), window(7, 0, '1960-01-01', '1960-02-10'), { status: 500 });
  // 12: bytes that are not JSON
  await put(Buffer.from('not json'), window(8, 0, '1990-01-01', '1990-02-10'));
  // 13: a stored body whose line states another sha256
  await put(real('lobith-h-19600101'), window(9, 0, '1960-01-01', '1960-02-10'), { sha256: 'a'.repeat(64) });
  // 14: a well-formed key whose object was never stored
  {
    const when = next();
    const body = Buffer.from('never stored');
    const hash = sha256(body);
    await archive.append(
      bareLine('NL-1', SPEC, when, {
        request: { method: 'POST', url: 'https://ddapi20-waterwebservices.rijkswaterstaat.nl/x' },
        sha256: hash,
        bytes: body.length,
        stored_bytes: 12,
        key: objectKey('NL-1', SPEC, when, hash),
        validity: { ok: true, reason: null, count: 1 },
        retention: 'backfill',
        backfill: window(10, 0, '1990-01-01', '1990-02-10'),
      }),
    );
  }
  // 15: the capture's own validity check failed
  await put(real('lobith-h-19600101'), window(11, 0, '1960-01-01', '1960-02-10'), {
    validity: { ok: false, reason: 'status', count: null },
  });

  // An archive that holds only line 9's spec.
  const other = new Archive(otherSpecRoot);
  const body = LIVE;
  const when = next();
  const stored = await store(other, 'nl-1-obs-key', body, when);
  await other.append(
    bareLine('NL-1', 'nl-1-obs-key', when, {
      sha256: stored.hash,
      bytes: body.length,
      stored_bytes: stored.stored,
      key: stored.key,
    }),
  );
  mkdirSync(join(emptyDir, 'plain'));

  const r = await run(new ArchiveReader(root));
  code = r.exit;
  out.push(...r.lines);
  err.push(...r.logs);
}, 120_000);

afterAll(() => {
  for (const d of [root, emptyDir, otherSpecRoot]) rmSync(d, { recursive: true, force: true });
});

afterEach(() => vi.restoreAllMocks());

const statuses = (o: number, g: number, d: number) => ({ Ongecontroleerd: o, Gecontroleerd: g, Definitief: d });
const group = (g: Record<string, unknown>) => ({
  group: { role: null, audience: null, gap: 0, unknown_quality: 0, statuses: statuses(0, 0, 0), ...g },
});

describe('backfill census', { timeout: 60_000 }, () => {
  it('exits 0 and logs nothing', () => {
    expect(code).toBe(0);
    expect(err).toEqual([]);
  });

  it('prints the orphan at once, then the groups, the series and the totals, in order', () => {
    expect(out).toEqual([
      // The edited midnight: the old code kept the daily mean (its value), the NVT sample is now a gap value.
      { orphan: { series: LITH, ts: orphan.ts, value: orphan.value } },
      // Hostile codes print as "?", with no role and no audience; its Tijdstip were moved to 1996 (265 values).
      group({
        code: '?',
        quantity: '?',
        hoedanigheid: '?',
        method: '?',
        bewerking: '?',
        unit: '?',
        lists: 1,
        values: 265,
        ok_values: 265,
        statuses: statuses(0, 0, 265),
        first: '1996-01-25T00:00:00.000Z', // 01:00+01:00, the first value of the real payload
        last: '1996-02-05T00:00:00.000Z',
        step: 'PT1H',
      }),
      group({
        code: 'lith.boven',
        quantity: 'WATHTE',
        hoedanigheid: 'NAP',
        method: 'other:F007',
        bewerking: 'GEM24H',
        unit: 'cm',
        role: 'primary',
        audience: 'public',
        lists: 2, // 2003 and 2004
        values: 80,
        ok_values: 80,
        statuses: statuses(0, 80, 0),
        first: '2003-01-29T23:00:00.000Z', // 2003-01-30T00:00+01:00
        last: '2004-03-09T23:00:00.000Z', // 2004-03-10T00:00+01:00
        step: 'P1D',
      }),
      group({
        code: 'lith.boven',
        quantity: 'WATHTE',
        hoedanigheid: 'NAP',
        method: 'other:F007',
        bewerking: 'NVT',
        unit: 'cm',
        role: 'primary',
        audience: 'public',
        lists: 2,
        values: 2 * 5761,
        // 5761 per chunk, 10 of them quality 1004 each, 1 each at the window end; the 2004 chunk has one gap value.
        ok_values: 5750 + 5749,
        gap: 1,
        unknown_quality: 20,
        statuses: statuses(1, 2 * 5761 - 1, 0),
        first: '2003-01-29T00:00:00.000Z', // the first value, 01:00+01:00
        last: '2004-03-09T23:50:00.000Z', // the last value inside the window; only the census output can say
        step: 'PT10M',
      }),
      group({
        code: 'lobith.bovenrijn.tolkamer',
        quantity: 'Q',
        hoedanigheid: 'NVT',
        method: 'other:F216',
        bewerking: 'GEM24H',
        unit: 'm3/s',
        lists: 2, // 2010 and 2011 (the open window)
        values: 20,
        ok_values: 20,
        statuses: statuses(0, 20, 0),
        first: '2010-01-01T23:00:00.000Z',
        last: '2011-01-10T23:00:00.000Z',
        step: 'P1D',
      }),
      group({
        code: 'lobith.bovenrijn.tolkamer',
        quantity: 'Q',
        hoedanigheid: 'NVT',
        method: 'other:F216',
        bewerking: 'NVT',
        unit: 'm3/s',
        lists: 2,
        values: 2 * 241,
        ok_values: 2 * 241,
        statuses: statuses(0, 2 * 241, 0),
        first: '2010-01-01T00:00:00.000Z',
        last: '2011-01-11T00:00:00.000Z',
        step: 'PT1H',
      }),
      group({
        code: 'lobith.bovenrijn.tolkamer',
        quantity: 'WATHTE',
        hoedanigheid: 'NAP',
        method: 'other:F007',
        bewerking: 'NVT',
        unit: 'cm',
        role: 'primary',
        audience: 'public',
        lists: 1,
        values: 265,
        ok_values: 265,
        statuses: statuses(0, 0, 265),
        first: '1995-01-25T00:00:00.000Z',
        last: '1995-02-05T00:00:00.000Z',
        step: 'PT1H',
      }),
      group({
        code: 'lobith.bovenrijn.tolkamer',
        quantity: 'WATHTE',
        hoedanigheid: 'NAP',
        method: 'other:F009',
        bewerking: 'NVT',
        unit: 'cm',
        lists: 1,
        values: 40,
        ok_values: 0, // before the 1990 floor
        statuses: statuses(0, 0, 40),
        first: null,
        last: null,
        step: 'P1D',
      }),
      // 26 midnights where the daily mean disagrees in 2003, 25 in 2004 (the edited one is now a gap value).
      { series: { key: LITH, restorable: 26 + 25, requalified: 1, orphan: 1 } },
      {
        totals: {
          spec: SPEC,
          manifest_from: '2026-10-13',
          manifest_to: '2026-10-14',
          lines: 12, // 1-8 and 12-15: not the other spec (9), the error (10) and the 500 (11)
          objects: 7, // 1-4 and 6-8; line 5 repeats line 1
          duplicate_lines: 1,
          duplicate_lines_differing: 0,
          failed_validity: 1,
          missing: 1,
          bad_object: 1,
          unreadable: 0,
          unparsed: 1,
          excluded_lists: 0,
          withheld_lists: 0,
          values: 2 * 5801 + 2 * 251 + 2 * 265 + 40,
          processed_values: 2 * 40 + 2 * 10 + 265, // the hostile list's bewerking is not NVT either
          restorable: 26 + 25,
          requalified: 1,
          orphan: 1,
          groups: 7,
          expect: { lines: 12, n_new: 26 + 25 + 1, n_changed: 0, quarantined: 2, skipped: 2 },
        },
      },
    ]);
  });

  it('prints no provider free text', () => {
    const text = JSON.stringify(out);
    for (const s of ['<script>', 'Omschrijving', 'Lith, boven', 'Vlotterniveaumeter']) expect(text).not.toContain(s);
    // Every printed string is a code, a key, a day or an instant: no quote, markup, space or line break (review SR-4).
    const strings: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === 'string') strings.push(v);
      else if (v !== null && typeof v === 'object') for (const x of Object.values(v)) walk(x);
    };
    walk(out);
    expect(strings.filter((s) => !/^[A-Za-z0-9.:/?_-]*$/.test(s))).toEqual([]);
  });

  it('restores nothing from a hostile location code', () => {
    expect(JSON.stringify(out)).not.toContain('"series":"?');
    expect(out.filter((o) => (o as { series?: { key: string } }).series !== undefined)).toHaveLength(1);
  });
});

describe('recovered lines and other audiences (review CR-4, SR-2)', { timeout: 60_000 }, () => {
  it('a recovered line of a counted object is a duplicate; recovered lines of other objects count; an off series is not described', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'census-dedupe-'));
    try {
      const archive = new Archive(dir);
      let at = Date.parse('2026-10-15T10:00:00Z');
      const put = async (body: Buffer, extra: Partial<Parameters<typeof bareLine>[3]>) => {
        at += 60_000;
        const when = new Date(at);
        const hash = sha256(body);
        const { key, stored } = await archive.put('NL-1', SPEC, when, body, hash);
        const line = bareLine('NL-1', SPEC, when, {
          sha256: hash,
          bytes: body.length,
          stored_bytes: stored,
          key,
          validity: { ok: true, reason: null, count: 1 },
          retention: 'backfill',
          ...extra,
        });
        await archive.append(line);
        return line;
      };
      const recovered = { recovered: true as const, request: null };
      const first = await put(real('lobith-h-19950125'), {
        backfill: { job: 1, chunk: 0, from: '1995-01-25T00:00:00.000Z', to: '1995-03-06T00:00:00.000Z' },
      });
      // The recorder's recovery of the same object (KG-341): no chunk window, the same bytes.
      at += 60_000;
      await archive.append({ ...first, ...recovered, fetched_at: { start: new Date(at).toISOString(), end: null } });
      // Two recovered lines of other objects of the same location: both count (no chunk key without a window).
      await put(lobithH('1997'), recovered);
      await put(lobithH('1998'), recovered);
      // A registered NL-1 series whose audience is off: counted as withheld, never described.
      await put(lobithH('1999', 'haghorst.sluis4.schuif1'), {
        backfill: { job: 2, chunk: 0, from: '1999-01-25T00:00:00.000Z', to: '1999-03-06T00:00:00.000Z' },
      });
      const r = await run(new ArchiveReader(dir));
      expect(r.exit).toBe(0);
      expect(JSON.stringify(r.lines)).not.toContain('haghorst');
      const groups = r.lines.filter((o) => (o as { group?: unknown }).group !== undefined);
      expect(groups).toEqual([
        group({
          code: 'lobith.bovenrijn.tolkamer',
          quantity: 'WATHTE',
          hoedanigheid: 'NAP',
          method: 'other:F007',
          bewerking: 'NVT',
          unit: 'cm',
          role: 'primary',
          audience: 'public',
          lists: 3, // 1995, 1997, 1998
          values: 3 * 265,
          ok_values: 3 * 265,
          statuses: statuses(0, 0, 3 * 265),
          first: '1995-01-25T00:00:00.000Z',
          last: '1998-02-05T00:00:00.000Z',
          step: 'PT1H',
        }),
      ]);
      const totals = (r.lines.at(-1) as { totals: Record<string, unknown> }).totals;
      expect(totals).toMatchObject({
        lines: 5,
        objects: 4,
        duplicate_lines: 1,
        duplicate_lines_differing: 0,
        withheld_lists: 1,
        values: 3 * 265,
        restorable: 0,
        groups: 1,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('exit codes', { timeout: 60_000 }, () => {
  it('64 for a spec that is not an NL-1 backfill spec', async () => {
    expect((await run(new ArchiveReader(root), 'de-8-backfill-w')).exit).toBe(64);
    const r = await run(new ArchiveReader(root), 'no-such-spec');
    expect(r.exit).toBe(64);
    expect(r.lines).toEqual([]);
  });

  it('1 for a root that does not exist, an empty directory and an archive of another spec', async () => {
    expect((await run(new ArchiveReader(missingRoot))).exit).toBe(1);
    expect((await run(new ArchiveReader(join(emptyDir, 'plain')))).exit).toBe(1);
    const r = await run(new ArchiveReader(otherSpecRoot));
    expect(r.exit).toBe(1);
    expect(r.lines).toEqual([]);
  });
});

describe('parseBackfillArgs census', () => {
  it('takes --spec and nothing else', () => {
    expect(parseBackfillArgs(['census'])).toEqual(expect.any(String));
    expect(parseBackfillArgs(['census', '--spec', SPEC])).toEqual({ cmd: 'census', spec: SPEC });
    expect(parseBackfillArgs(['census', '--spec', SPEC, '--dry-run'])).toEqual(expect.any(String));
    expect(parseBackfillArgs(['census', '--spec', SPEC, '--from', '2003-01-01'])).toEqual(expect.any(String));
    expect(parseBackfillArgs(['census', '--spec', SPEC, '--series', 'x'])).toEqual(expect.any(String));
    expect(parseBackfillArgs(['census', '--spec', 'NL 1'])).toEqual(expect.any(String));
  });
});

describe('backfillMain census', { timeout: 60_000 }, () => {
  it('runs on RWS_RAW_DIR with no database environment at all', async () => {
    const printed: string[] = [];
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((l: string) => void printed.push(l));
    const exit = await backfillMain(['census', '--spec', SPEC], { RWS_RAW_DIR: root }, (l) => logs.push(l));
    expect(exit).toBe(0);
    expect(logs).toEqual([]);
    const lines = printed.map((l) => JSON.parse(l));
    expect(lines).toEqual(out);
    expect(Object.keys(lines.at(-1))).toEqual(['totals']);
  });
});

describe('helpers', () => {
  it('isoStep prints whole days, hours, minutes, else seconds', () => {
    expect(isoStep(86_400_000)).toBe('P1D');
    expect(isoStep(3_600_000)).toBe('PT1H');
    expect(isoStep(600_000)).toBe('PT10M');
    expect(isoStep(90_000)).toBe('PT90S');
  });

  it('beforeFix reads a processed list as instantaneous and leaves the rest alone', () => {
    const lists = parseWaarnemingen(real('lith-h-20030129'));
    const codeOf = (l: (typeof lists)[number]) => l.aquo.WaardeBewerkingsMethode.Code;
    expect(lists.map(codeOf)).toEqual(['NVT', 'GEM24H']);
    const fixed = beforeFix(lists);
    expect(fixed.map(codeOf)).toEqual(['NVT', 'NVT']);
    expect(fixed[0]).toBe(lists[0]); // an instantaneous list is the same object
    expect(fixed[1]).not.toBe(lists[1]);
    expect(codeOf(lists[1] as (typeof lists)[number])).toBe('GEM24H'); // the input is not mutated
  });
});
