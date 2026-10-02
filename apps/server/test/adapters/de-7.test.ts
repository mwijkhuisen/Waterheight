import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { type Normalised, ObsRow, obsParts, QC, type Registry, SchemaDrift, type SeriesDecl } from '@rws/core';
import fc from 'fast-check';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { CHUNK, type Context, keyOf, normalise, PLACEHOLDERS, TIME } from '../../src/adapters/de-7/normalise.ts';
import {
  HEADER,
  lineSink,
  MAX_LINE,
  MAX_ROWS,
  MAX_STATIONS,
  MAX_TIMES,
  parseText,
  type Readings,
} from '../../src/adapters/de-7/parse.ts';
import { LOAD_ADAPTERS, type LoadContext } from '../../src/load/adapters.ts';
import { goldenUrl, rawFixture, registryOf } from './registry.ts';

// DE-7 LANUK NRW `messwerte.txt` in `messwerte.zip` (DL-DE Zero): the loader inflates the ZIP under the §6.7 guard
// and feeds the lines to the strict sink (parse.ts), normalise.ts turns them into chunked rows. Goldens are the
// loader's result of the two real trimmed recordings (invariant 9), with the chunks flattened. `UPDATE_GOLDEN=1`
// rewrites them. The ZIP attack payloads are synthetic files (`de-7-zip-*.synthetic.raw`); each must end in the
// guard's own reason as a SchemaDrift.

const registry = registryOf('DE-7');
const spec = LOAD_ADAPTERS['DE-7']?.specs['de-7-messwerte'];
const pegelSpec = LOAD_ADAPTERS['DE-7']?.specs['de-7-pegeldaten'];

type Flat = Pick<Normalised, 'obs' | 'gaugeZeros' | 'dropped' | 'unknown'>;
const flat = (n: Normalised): Flat => ({
  obs: [...obsParts(n)].flat(),
  gaugeZeros: n.gaugeZeros,
  dropped: n.dropped,
  unknown: n.unknown,
});

/** The golden file, one row per line (thousands of rows); equals `JSON.stringify` of the value once parsed. */
function golden(name: string, actual: Flat): Flat {
  const url = goldenUrl('DE-7', name);
  if (process.env.UPDATE_GOLDEN === '1') {
    const rows = actual.obs.map((r) => `  ${JSON.stringify(r)}`).join(',\n');
    writeFileSync(
      url,
      `{\n "obs": [${rows === '' ? '' : `\n${rows}\n `}],\n "gaugeZeros": ${JSON.stringify(actual.gaugeZeros)},\n "dropped": ${JSON.stringify(actual.dropped)},\n "unknown": ${actual.unknown}\n}\n`,
    );
  }
  if (!existsSync(url)) throw new Error(`no golden for ${name}: run with UPDATE_GOLDEN=1 and review it`);
  return JSON.parse(readFileSync(url, 'utf8'));
}

const loadCtx = (name: string, extra: Partial<LoadContext> = {}): LoadContext => ({
  registry,
  fetchedAt: Date.parse(rawFixture('DE-7', name).meta.recorded_at),
  variant: '',
  unitMismatch: new Set(),
  ...extra,
});
/** The loader's own path: inflate under the guard, feed the sink, normalise. */
const load = async (name: string, extra: Partial<LoadContext> = {}) =>
  (await spec?.run(rawFixture('DE-7', name).body, loadCtx(name, extra))) as Normalised;
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(SchemaDrift);
    return (err as SchemaDrift).code;
  }
  return 'parsed';
};

const NO = '2847500000100';
const NOW = Date.parse('2026-09-29T13:00:00Z');
/** A row at `minutes` from NOW, in the provider's spelling (+01:00 all year). */
const at = (minutes: number) => new Date(NOW + minutes * 60_000 + 3_600_000).toISOString().replace('Z', '+01:00');
const row = (minutes: number, v: string | number, no = NO) => `${no};${at(minutes)};${v}`;
const read = (lines: string[], opts = { ascii: true }) =>
  parseText([HEADER, ...lines].join('\r\n'), 'messwerte.txt', opts);
const go = (lines: string[], extra: Partial<Context> = {}) =>
  normalise(read(lines), { registry, fetchedAt: NOW, ...extra });
const rows = (out: Normalised) => [...obsParts(out)].flat();
const of = (out: Normalised, no = NO) => rows(out).filter((r) => r.series === keyOf(no));
const drift = (fn: () => unknown): [string, string] | 'parsed' => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SchemaDrift);
    return [(err as SchemaDrift).code, (err as SchemaDrift).path];
  }
  return 'parsed';
};

describe('golden files (real payloads)', () => {
  it('six whole station blocks (trimmed from the P1a recording): +01:00 → UTC, cm, qc raw, the placeholder dropped', async () => {
    const out = await load('de-7-messwerte-blocks');
    expect(flat(out)).toEqual(golden('de-7-messwerte-blocks', flat(out)));
    // The rows come as chunks and `obs` stays empty (the loader reads obsParts).
    expect(out.obs).toEqual([]);
    expect(out.obsChunks).toBeTypeOf('function');
    // 4 stations × 672 rows at 15 minutes + 2768898001 × 2,013 rows at 5 minutes; 1234512345's 670 rows are dropped.
    expect(rows(out)).toHaveLength(4 * 672 + 2013);
    expect(out.dropped).toEqual({ placeholder: 670 });
    expect(out.unknown).toBe(0);
    // 2847500000100 "2026-09-22T14:45:00.000+01:00" is 13:45Z; 36.80 cm above the gauge zero, unvalidated raw data.
    expect(of(out)[0]).toEqual({ series: '2847500000100/W', ts: '2026-09-22T13:45:00.000Z', value: 36.8, qc: QC.RAW });
    expect(of(out)[1]).toEqual({ series: '2847500000100/W', ts: '2026-09-22T14:00:00.000Z', value: 36.7, qc: QC.RAW });
    // The 10-digit real station 2768898001 steps 5 minutes (with a gap or two), the others 15 exactly.
    const steps = (no: string) => {
      const ts = of(out, no).map((r) => Date.parse(r.ts));
      return ts.slice(1).map((t, i) => t - (ts[i] as number));
    };
    expect(steps('2768898001').filter((d) => d === 300_000).length).toBeGreaterThan(1900);
    expect(new Set(steps('2829100000100'))).toEqual(new Set([900_000]));
    for (const r of rows(out)) expect([ObsRow.parse(r).qc, r.series.endsWith('/W')]).toEqual([QC.RAW, true]);
    expect(rows(out).some((r) => r.series.startsWith('1234512345'))).toBe(false);
  });

  it('a production messwerte.zip (exported from the archive, 2026-10-01 00:50Z; the same six blocks)', async () => {
    const out = await load('de-7-messwerte-archive');
    expect(flat(out)).toEqual(golden('de-7-messwerte-archive', flat(out)));
    expect(rawFixture('DE-7', 'de-7-messwerte-archive').meta).toMatchObject({
      from: 'archive',
      spec: 'de-7-messwerte',
    });
    expect(out.dropped).toEqual({ placeholder: 661 });
    expect(out.unknown).toBe(0);
    // The newest Stah value is at most an hour older than the fetch (00:50Z): 15-minute steps up to then.
    expect(Date.parse(of(out, '2829100000100').at(-1)?.ts as string)).toBeGreaterThan(
      Date.parse('2026-10-01T00:50:00Z') - 3_600_000,
    );
  });

  it('the pegeldaten.zip seed (exported; Stah and the placeholder, 4 members): only pegel_messwerte.txt loads, 45 days', async () => {
    const name = 'de-7-pegeldaten-blocks';
    const out = (await pegelSpec?.run(rawFixture('DE-7', name).body, loadCtx(name))) as Normalised;
    expect(flat(out)).toEqual(golden(name, flat(out)));
    // The member reaches back to 2026-07-30; the 45-day age window keeps 2026-08-16 on (it covers display_start).
    const ts = of(out, '2829100000100').map((r) => Date.parse(r.ts));
    expect(ts[0]).toBeGreaterThanOrEqual(Date.parse('2026-08-16T12:00:00Z'));
    expect(out.dropped.too_old).toBeGreaterThan(0);
    expect(out.dropped.placeholder).toBeGreaterThan(0);
    expect(new Set(ts.slice(1).map((t, i) => t - (ts[i] as number)))).toEqual(new Set([900_000]));
  });

  it('the header alone (trimmed): no rows, no drift, no chunk', async () => {
    const out = await load('de-7-messwerte-empty');
    expect(flat(out)).toEqual(golden('de-7-messwerte-empty', flat(out)));
    expect([...obsParts(out)]).toEqual([]);
    expect(out).toMatchObject({ obs: [], dropped: {}, unknown: 0, gaugeZeros: [] });
  });

  it('the whole P1a file (238,678 rows of 252 stations): 670 placeholder rows dropped, every other station registered', async () => {
    const full = rawFixture('DE-7', 'de-7-messwerte');
    // The parse alone, from the inflated member: counts that were checked against the file with an independent tool.
    const member = Buffer.from(unzipSync(full.body)['messwerte.txt'] as Uint8Array).toString('ascii');
    const r = parseText(member, 'messwerte.txt', { ascii: true });
    expect([r.station.length, r.stations.length, r.terminators]).toEqual([238_678, 252, 253]);
    expect(r.stations).toContain('1234512345');
    // A time is shared by every station of that step: 7 days at 5 minutes are 2,016 distinct strings, not 238,678.
    expect(r.times.length).toBeLessThan(3000);

    const out = await load('de-7-messwerte');
    expect(out.dropped).toEqual({ placeholder: 670 });
    expect(out.unknown).toBe(0);
    const chunks = [...obsParts(out)];
    expect(chunks.flat()).toHaveLength(238_678 - 670);
    // Chunks of whole series: none above CHUNK rows, and no series in two chunks.
    expect(chunks.length).toBeGreaterThan(1);
    const where = new Map<string, number>();
    chunks.forEach((c, i) => {
      expect(c.length).toBeLessThanOrEqual(CHUNK);
      for (const s of new Set(c.map((x) => x.series))) {
        expect([s, where.has(s)]).toEqual([s, false]);
        where.set(s, i);
      }
    });
    expect(where.size).toBe(251);
    // Iterating again gives the same rows (the loader may count first and upsert after).
    expect([...obsParts(out)]).toEqual(chunks);
    // Every series is in time order and holds no point twice.
    const last = new Map<string, string>();
    let newest = '';
    for (const x of chunks.flat()) {
      expect(x.ts > (last.get(x.series) ?? '')).toBe(true);
      last.set(x.series, x.ts);
      if (x.ts > newest) newest = x.ts;
    }
    expect(Date.parse(newest)).toBeLessThanOrEqual(Date.parse(full.meta.recorded_at));
  }, 60_000);
});

describe('the ZIP guard on the loader path (synthetic attack payloads)', () => {
  it.each([
    ['de-7-zip-bomb.synthetic', 'zip_ratio'],
    ['de-7-zip-lying-size.synthetic', 'zip_size'],
    ['de-7-zip-slip.synthetic', 'zip_name'],
    ['de-7-zip-absolute-name.synthetic', 'zip_name'],
    ['de-7-zip-nested.synthetic', 'zip_name'],
    ['de-7-zip-duplicate-member.synthetic', 'zip_name'],
    ['de-7-zip-extra-member.synthetic', 'zip_name'],
    ['de-7-zip-many-members.synthetic', 'zip_members'],
    ['de-7-not-zip.synthetic', 'zip_eocd'],
  ])('%s ends in the guard reason %s as a SchemaDrift, with no rows', async (name, code) => {
    expect(await refusal(load(name))).toBe(code);
    // The metas say what they are, and the expected code is the one the note names.
    const meta = rawFixture('DE-7', name).meta as Record<string, unknown>;
    expect([meta.synthetic, meta.spec, meta.source]).toEqual([true, 'de-7-messwerte', 'DE-7']);
    expect(String(meta.note)).toContain(`Expected SchemaDrift code: ${code}.`);
    expect(rawFixture('DE-7', name).body.length).toBeLessThan(200_000);
  });

  it('the other spec (pegeldaten.zip, 2 months) refuses the same payloads: messwerte.txt is not its member', async () => {
    for (const name of ['de-7-messwerte-blocks', 'de-7-zip-slip.synthetic']) {
      expect(await refusal(Promise.resolve(pegelSpec?.run(rawFixture('DE-7', name).body, loadCtx(name))))).toBe(
        'zip_name',
      );
    }
  });

  const zip = (member: Uint8Array | string, name = 'messwerte.txt') =>
    zipSync({ [name]: typeof member === 'string' ? strToU8(member) : member });
  const run = (body: Uint8Array, s = spec) =>
    refusal(Promise.resolve(s?.run(body, { registry, fetchedAt: NOW, variant: '', unitMismatch: new Set() })));

  it('a sink failure inside the inflate keeps its own code (not zip_inflate), with the line number', async () => {
    expect(await run(zip(`station_no;time;value\r\n${row(-15, 1)}\r\n`))).toBe('csv_header');
    expect(await run(zip(`${HEADER}\r\n${row(-15, '1,5')}\r\n`))).toBe('bad_value');
    expect(await run(zip(`${HEADER}\r\n${NO};${at(-15)}\r\n`))).toBe('csv_width');
  });

  it('messwerte.txt is ASCII: a non-ASCII character, and bytes that are not UTF-8, end in encoding', async () => {
    expect(await run(zip(`${HEADER}\r\n${NO};${at(-15)};1é\r\n`))).toBe('encoding');
    expect(
      await run(
        zip(Buffer.concat([Buffer.from(`${HEADER}\r\n${NO};`), Buffer.from([0xff, 0xfe]), Buffer.from('\r\n')])),
      ),
    ).toBe('encoding');
  });

  it('a line without end is cut at 1,024 bytes by the splitter, one over 128 characters by the sink: line_length', async () => {
    expect(await run(zip(`${HEADER}\r\n${'x'.repeat(2000)}`))).toBe('line_length');
    expect(await run(zip(`${HEADER}\r\n${row(-15, 1)}${' '.repeat(100)}\r\n`))).toBe('line_length');
  });

  it('the pegeldaten spec reads only pegel_messwerte.txt (the other allowed members are inflated and dropped)', async () => {
    const lines = `${HEADER}\r\n${row(-15, 12.5)}\r\n${NO};\r\n`;
    const body = zipSync({
      'pegel_messwerte.txt': strToU8(lines),
      'pegel_tagesmittelwerte.txt': strToU8('not a measurement file\r\n'),
      'pegel_stationen.txt': strToU8('ü;ä\r\n'),
    });
    const out = (await pegelSpec?.run(body, {
      registry,
      fetchedAt: NOW,
      variant: '',
      unitMismatch: new Set(),
    })) as Normalised;
    expect(rows(out)).toEqual([{ series: '2847500000100/W', ts: '2026-09-29T12:45:00.000Z', value: 12.5, qc: QC.RAW }]);
    expect(await run(zip(lines, 'pegel_messwerte.txt'), pegelSpec)).toBe('parsed');
    expect(await run(zipSync({ 'pegel_messwerte.txt': strToU8(lines), 'other.txt': strToU8('x') }), pegelSpec)).toBe(
      'zip_name',
    );
    // The 2-month member is not declared ASCII: a non-ASCII character fails the field's own shape instead.
    expect(await run(zip(`${HEADER}\r\n${NO};${at(-15)};1é\r\n`, 'pegel_messwerte.txt'), pegelSpec)).toBe('bad_value');
  });
});

describe('parse (the strict line sink)', () => {
  it('the header is pinned, and nothing may precede it', () => {
    expect(HEADER).toBe('station_no;time;value(cm)');
    expect(drift(() => parseText('station_no;time;value\r\n', 'messwerte.txt', { ascii: true }))).toEqual([
      'csv_header',
      'line.1',
    ]);
    expect(drift(() => parseText(`${NO};${at(0)};1\r\n${HEADER}\r\n`, 'messwerte.txt', { ascii: true }))).toEqual([
      'csv_header',
      'line.1',
    ]);
    expect(drift(() => parseText(`${HEADER}\r\n`, 'messwerte.txt', { ascii: true }))).toBe('parsed');
    // LF line ends parse too; a BOM is the only thing the pegel member (not ASCII) may carry before the header.
    expect(parseText(`${HEADER}\n${row(0, 1)}\n`, 'messwerte.txt', { ascii: true }).station).toEqual([0]);
    expect(drift(() => parseText(`﻿${HEADER}\r\n`, 'pegel_messwerte.txt', { ascii: false }))).toBe('parsed');
    expect(drift(() => parseText(`﻿${HEADER}\r\n`, 'messwerte.txt', { ascii: true }))).toEqual(['encoding', 'line.1']);
  });

  it('a member without any line is csv_empty', () => {
    expect(drift(() => parseText('', 'messwerte.txt', { ascii: true }))).toEqual(['csv_empty', '']);
    expect(drift(() => lineSink('messwerte.txt', { ascii: true }).end())).toEqual(['csv_empty', '']);
    const r = parseText(`${HEADER}\r\n`, 'messwerte.txt', { ascii: true });
    expect(r).toEqual({ stations: [], times: [], station: [], time: [], value: [], terminators: 0 });
  });

  it.each([
    ['a field too few', `${NO};${at(0)}`, 'csv_width'],
    ['a field too many', `${NO};${at(0)};1;2`, 'csv_width'],
    ['no separator', NO, 'csv_width'],
    ['an empty value (three fields)', `${NO};${at(0)};`, 'bad_value'],
    ['a terminator whose second field is not empty', `${NO}; `, 'csv_width'],
    ['a terminator of a bad station number', '12;', 'station_no'],
    ['a station number of 5 digits', `12345;${at(0)};1`, 'station_no'],
    ['a station number of 14 digits', `12345678901234;${at(0)};1`, 'station_no'],
    ['a station number with a letter', `28475000001A0;${at(0)};1`, 'station_no'],
    ['an empty station number', `;${at(0)};1`, 'station_no'],
    ['a time with a space', `${NO};2026-09-22 14:45:00.000+01:00;1`, 'time_bad_format'],
    ['a time with Z', `${NO};2026-09-22T14:45:00.000Z;1`, 'time_bad_format'],
    ['a time without an offset', `${NO};2026-09-22T14:45:00.000;1`, 'time_bad_format'],
    ['a time with a compact offset', `${NO};2026-09-22T14:45:00.000+0100;1`, 'time_bad_format'],
    ['a time of four fractional digits', `${NO};2026-09-22T14:45:00.0000+01:00;1`, 'time_bad_format'],
    ['a value with a comma', `${NO};${at(0)};1,5`, 'bad_value'],
    ['a value with a plus sign', `${NO};${at(0)};+1`, 'bad_value'],
    ['a value without an integer part', `${NO};${at(0)};.5`, 'bad_value'],
    ['a value ending in a point', `${NO};${at(0)};1.`, 'bad_value'],
    ['a value of 6 integer digits', `${NO};${at(0)};123456`, 'bad_value'],
    ['a value of 4 decimals', `${NO};${at(0)};1.2345`, 'bad_value'],
    ['NaN', `${NO};${at(0)};NaN`, 'bad_value'],
    ['na in lower case', `${NO};${at(0)};na`, 'bad_value'],
    ['an exponent', `${NO};${at(0)};1e3`, 'bad_value'],
  ])('refuses %s as %s drift at line 3, never echoing the text', (_, line, code) => {
    // The offending line is the third: the header and one good row come first.
    const text = [HEADER, row(-15, 1), line].join('\r\n');
    const got = drift(() => parseText(text, 'messwerte.txt', { ascii: true }));
    expect(got).toEqual([code, 'line.3']);
    try {
      parseText(text, 'messwerte.txt', { ascii: true });
    } catch (err) {
      if (line.length > 3) expect((err as Error).message).not.toContain(line);
    }
  });

  it('a blank line is csv_width drift in the middle of a member; a blank last line is just the line end', () => {
    expect(
      drift(() => parseText(`${HEADER}\r\n${row(-15, 1)}\r\n\r\n${row(0, 1)}\r\n`, 'messwerte.txt', { ascii: true })),
    ).toEqual(['csv_width', 'line.3']);
    expect(drift(() => parseText(`${HEADER}\r\n${row(-15, 1)}\r\n`, 'messwerte.txt', { ascii: true }))).toBe('parsed');
  });

  it('accepts the shapes the real file has: 6–13 digit stations, 1–3 fractional digits, negatives, NA, bare terminators', () => {
    const r = read([
      `123456;${at(0)};-10.7`,
      `1234567890123;${at(0)};0`,
      `${NO};2026-09-22T14:45:00+01:00;193.4`,
      `${NO};2026-09-22T14:45:00.5+01:00;12345`,
      `${NO};2026-09-22T14:45:00.123-05:30;-12345.123`,
      `${NO};${at(0)};NA`,
      `${NO};`,
      `${NO};`,
    ]);
    expect([r.stations, r.station.length, r.terminators]).toEqual([['123456', '1234567890123', NO], 6, 2]);
    expect(r.value.map((v) => (Number.isNaN(v) ? 'NA' : v))).toEqual([-10.7, 0, 193.4, 12345, -12345.123, 'NA']);
    // The time strings are shared by the stations that have them; the columns index them.
    expect(r.times).toHaveLength(4);
    expect(r.time[0]).toBe(r.time[1]);
  });

  it('a terminator `<no>;` is skipped and counted, one per block, and holds no row', () => {
    const r = read([row(-30, 1), row(-15, 2), `${NO};`, row(-15, 3, '2869500000200'), '2869500000200;']);
    expect([r.station.length, r.terminators, r.stations]).toEqual([3, 2, [NO, '2869500000200']]);
  });

  it('a line over MAX_LINE (128) is line_length, before anything else is looked at', () => {
    const ok = `${NO};${at(0)};${'1'.repeat(MAX_LINE - NO.length - at(0).length - 2)}`;
    expect(ok).toHaveLength(MAX_LINE);
    // 128 characters of a bad value are bad_value; one more is line_length.
    expect(drift(() => read([ok]))).toEqual(['bad_value', 'line.2']);
    expect(drift(() => read([`${ok}1`]))).toEqual(['line_length', 'line.2']);
    expect(drift(() => read([`${HEADER}${' '.repeat(MAX_LINE)}`]))).toEqual(['line_length', 'line.2']);
  });

  it('messwerte.txt is ASCII: any character from U+0080 on is encoding drift (even inside the header and a terminator)', () => {
    for (const bad of ['é', 'ü', '€', '�', '\u0080']) {
      expect(drift(() => read([`${NO};${at(0)};1${bad}`]))).toEqual(['encoding', 'line.2']);
      expect(drift(() => read([`${NO};${bad}`]))).toEqual(['encoding', 'line.2']);
      expect(drift(() => parseText(`${HEADER}${bad}\r\n`, 'messwerte.txt', { ascii: true }))).toEqual([
        'encoding',
        'line.1',
      ]);
    }
    // The 2-month member is UTF-8 (decoded by the loader's fatal decoder); a character outside the field shapes
    // still fails, by its shape.
    expect(drift(() => read([`${NO};${at(0)};1é`], { ascii: false }))).toEqual(['bad_value', 'line.2']);
  });

  it('the row cap per member: MAX_ROWS rows fit, the next one is csv_rows (a loop of lines, not a huge string)', () => {
    expect(MAX_ROWS).toEqual({ 'messwerte.txt': 400_000, 'pegel_messwerte.txt': 3_000_000 });
    const sink = lineSink('messwerte.txt', { ascii: true });
    sink.line(HEADER);
    const line = row(-15, 1);
    for (let i = 0; i < MAX_ROWS['messwerte.txt']; i += 1) sink.line(line);
    // Terminators are not rows: they never count against the cap.
    sink.line(`${NO};`);
    expect(sink.end().station).toHaveLength(MAX_ROWS['messwerte.txt']);
    // The header, the rows and the terminator are lines 1…MAX+2; the next row is over the cap.
    expect(drift(() => sink.line(line))).toEqual(['csv_rows', `line.${MAX_ROWS['messwerte.txt'] + 3}`]);
  }, 60_000);

  it('the distinct station numbers per member: MAX_STATIONS fit, the next new one is csv_stations (review M1)', () => {
    expect(MAX_STATIONS).toBe(1_000);
    for (const member of ['messwerte.txt', 'pegel_messwerte.txt'] as const) {
      const sink = lineSink(member, { ascii: true });
      sink.line(HEADER);
      const no = (i: number) => String(9_000_000_000_000 + i);
      for (let i = 0; i < MAX_STATIONS; i += 1) sink.line(row(-15, 1, no(i)));
      // A known number still loads; a terminator of an unknown number is no station.
      sink.line(row(-30, 1, no(0)));
      sink.line(`${no(MAX_STATIONS)};`);
      expect(drift(() => sink.line(row(-15, 1, no(MAX_STATIONS))))).toEqual([
        'csv_stations',
        `line.${MAX_STATIONS + 4}`,
      ]);
    }
  });

  it('the distinct times per member: 4,000 in messwerte.txt, 20,000 in pegel_messwerte.txt, then csv_times (review M1)', () => {
    expect(MAX_TIMES).toEqual({ 'messwerte.txt': 4_000, 'pegel_messwerte.txt': 20_000 });
    for (const member of ['messwerte.txt', 'pegel_messwerte.txt'] as const) {
      const sink = lineSink(member, { ascii: true });
      sink.line(HEADER);
      for (let i = 0; i < MAX_TIMES[member]; i += 1) sink.line(row(-i, 1));
      // A time already seen, from another station, is no new time.
      sink.line(row(0, 1, '2869500000200'));
      expect(drift(() => sink.line(row(-MAX_TIMES[member], 1)))).toEqual([
        'csv_times',
        `line.${MAX_TIMES[member] + 3}`,
      ]);
    }
  });

  it('the real members stay well under the caps: 252 stations and 2,016 times in the P1a messwerte.txt', async () => {
    const out = parseText(
      Buffer.from(unzipSync(rawFixture('DE-7', 'de-7-messwerte').body)['messwerte.txt'] as Uint8Array).toString(),
      'messwerte.txt',
      { ascii: true },
    );
    expect([out.stations.length, out.times.length]).toEqual([252, 2016]);
  });

  it('the rows are compact columns: a time shared by many stations is one string', () => {
    const r = read([row(-15, 1), row(-15, 2, '2869500000200'), row(-15, 3, '9286455000200')]);
    expect(r.times).toHaveLength(1);
    expect(r.time).toEqual([0, 0, 0]);
  });
});

/** A registry of synthetic gauges, declared like the generated one (cm above the gauge zero, ×1). */
const decl = (key: string, extra: Partial<SeriesDecl> = {}): SeriesDecl => ({
  key,
  quantity: 'H',
  native_unit: 'cm',
  to_canonical: 1,
  value_kind: 'stage',
  native_step_ms: 900_000,
  expected_step_ms: 900_000,
  ...extra,
});
const synthetic = (nos: string[]): Registry => new Map(nos.map((no) => [keyOf(no), decl(keyOf(no))]));

describe('normalise (declared time convention, drops, window, chunks)', () => {
  it('the time convention is a fixed +01:00 all year, summer included; keys are <no>/W', () => {
    expect(TIME).toEqual({ kind: 'fixed-offset', offset: '+01:00' });
    expect(keyOf('2847500000100')).toBe('2847500000100/W');
    // A July instant keeps +01:00: 2026-07-01T12:00:00+01:00 is 11:00Z, not 10:00Z.
    const out = normalise(read([`${NO};2026-07-01T12:00:00.000+01:00;5`]), {
      registry,
      fetchedAt: Date.parse('2026-07-01T12:30:00Z'),
    });
    expect(of(out)[0]?.ts).toBe('2026-07-01T11:00:00.000Z');
  });

  it('a time at another offset is time_offset_mismatch drift of the payload, not a guess; so is an impossible date', () => {
    expect(drift(() => go([`${NO};2026-09-29T14:45:00.000+02:00;1`]))).toEqual(['time_offset_mismatch', '']);
    expect(drift(() => go([`${NO};2026-09-29T13:45:00.000+00:00;1`]))).toEqual(['time_offset_mismatch', '']);
    expect(drift(() => go([`${NO};2026-02-30T14:45:00.000+01:00;1`]))).toEqual(['time_bad_format', '']);
    // Even on a placeholder station's row, or among good ones: the payload is not what the adapter expects.
    expect(drift(() => go([row(-15, 1), `1234512345;2026-09-29T14:45:00.000+02:00;1`]))).toEqual([
      'time_offset_mismatch',
      '',
    ]);
  });

  it('the placeholder numbers are dropped (counted per row), never unknown, whatever the registry says', () => {
    expect([...PLACEHOLDERS].sort()).toEqual(['1234512345', '123456', '1234567']);
    for (const p of PLACEHOLDERS) expect([p, registry.has(keyOf(p))]).toEqual([p, false]);
    const withThem = new Map([...registry, ...synthetic([...PLACEHOLDERS])]);
    const out = normalise(
      read([
        row(-30, 1, '1234512345'),
        row(-15, 2, '1234512345'),
        row(-15, 3, '123456'),
        row(-15, 4, '1234567'),
        row(-15, 5),
      ]),
      {
        registry: withThem,
        fetchedAt: NOW,
      },
    );
    expect(out.dropped).toEqual({ placeholder: 4 });
    expect(out.unknown).toBe(0);
    expect(rows(out).map((r) => r.series)).toEqual([keyOf(NO)]);
  });

  it('an unregistered number is unknown once per series (not per row) and stores nothing', () => {
    const out = go([
      row(-30, 1, '9999999999991'),
      row(-15, 2, '9999999999991'),
      row(-15, 3, '9999999999992'),
      row(-15, 4),
    ]);
    expect(out.unknown).toBe(2);
    expect(out.dropped).toEqual({});
    expect(rows(out).map((r) => r.series)).toEqual([keyOf(NO)]);
  });

  it('NA is the provider gap: `sentinel`, never a value (and never a 0)', () => {
    const out = go([row(-45, 'NA'), row(-30, 0), row(-15, 'NA'), row(0, 1)]);
    expect(out.dropped).toEqual({ sentinel: 2 });
    expect(of(out).map((r) => r.value)).toEqual([0, 1]);
  });

  it('a value more than 15 minutes ahead of the fetch is `future` (15 minutes exactly is kept)', () => {
    const out = go([row(15, 1), row(16, 2), row(60, 3), row(0, 4)]);
    expect(out.dropped).toEqual({ future: 2 });
    expect(of(out).map((r) => r.value)).toEqual([4, 1]);
    // The slack is the fetch time's: a later fetch keeps the same points.
    expect(rows(go([row(16, 2)], { fetchedAt: NOW + 60_000 }))).toHaveLength(1);
  });

  it('a point older than 45 days is `too_old` (45 days to the millisecond is kept)', () => {
    const day = 24 * 60;
    const out = go([row(-45 * day - 1, 1), row(-45 * day, 2), row(-46 * day, 3), row(-44 * day, 4)]);
    expect(out.dropped).toEqual({ too_old: 2 });
    expect(of(out).map((r) => r.value)).toEqual([2, 4]);
  });

  it('`since` (the loader window): older points are `outside_window`, the point at `since` is kept; no `since`, no window', () => {
    const lines = [row(-120, 1), row(-61, 2), row(-60, 3), row(0, 4)];
    const out = go(lines, { since: NOW - 60 * 60_000 });
    expect(out.dropped).toEqual({ outside_window: 2 });
    expect(of(out).map((r) => r.value)).toEqual([3, 4]);
    expect(go(lines).dropped).toEqual({});
    // `too_old` is judged first: a point out of the 45 days is not also outside the window.
    expect(go([row(-60 * 1440, 1)], { since: NOW - 3_600_000 }).dropped).toEqual({ too_old: 1 });
  });

  it('the same point twice with the same value is one (`duplicate`, 36.8 = 36.80); with two values both are withheld (`conflict` 2)', () => {
    const out = go([row(-30, '36.8'), row(-30, '36.80'), row(-15, 1), row(-15, 2), row(0, 5), row(0, 5), row(0, 5)]);
    expect(out.dropped).toEqual({ duplicate: 3, conflict: 2 });
    expect(of(out).map((r) => [r.ts.slice(11, 16), r.value])).toEqual([
      ['12:30', 36.8],
      ['13:00', 5],
    ]);
    // The same point on another station is another point.
    const other = go([row(-15, 1), row(-15, 2, '2869500000200')]);
    expect(other.dropped).toEqual({});
    expect(rows(other)).toHaveLength(2);
  });

  it('values are canonical cm with qc raw; the range bit marks a stage outside −2,000…5,000 cm and the value is kept', () => {
    const out = go([row(-60, '5000'), row(-45, '5000.5'), row(-30, '-2000'), row(-15, '-2000.1'), row(0, '193.4')]);
    expect(of(out).map((r) => [r.value, r.qc])).toEqual([
      [5000, QC.RAW],
      [5000.5, QC.RAW | QC.RANGE],
      [-2000, QC.RAW],
      [-2000.1, QC.RAW | QC.RANGE],
      [193.4, QC.RAW],
    ]);
    // The registry's factor applies (cm here: ×1); a series declared otherwise scales.
    const mm = normalise(read([row(-15, 10)]), {
      registry: new Map([[keyOf(NO), decl(keyOf(NO), { to_canonical: 0.1 })]]),
      fetchedAt: NOW,
    });
    expect(of(mm)[0]?.value).toBe(1);
  });

  it('a series is in time order whatever the file order, and series come in first-seen order', () => {
    const out = go([row(0, 3), row(-30, 1), row(-15, 2, '2869500000200'), row(-15, 2), row(-30, 4, '2869500000200')]);
    expect(rows(out).map((r) => [r.series.slice(0, 4), r.ts.slice(11, 16), r.value])).toEqual([
      ['2847', '12:30', 1],
      ['2847', '12:45', 2],
      ['2847', '13:00', 3],
      ['2869', '12:30', 4],
      ['2869', '12:45', 2],
    ]);
  });

  it('chunks hold whole series: none above CHUNK rows, no series in two chunks, and obsParts can be iterated twice', () => {
    const sizes = [30_000, 30_000, 10_000, 40_000];
    const nos = sizes.map((_, i) => `900000000000${i}`);
    const data: Readings = { stations: nos, times: [], station: [], time: [], value: [], terminators: 0 };
    const start = NOW - 30 * 86_400_000;
    for (let i = 0; i < Math.max(...sizes); i += 1)
      data.times.push(new Date(start + i * 60_000 + 3_600_000).toISOString().replace('Z', '+01:00'));
    sizes.forEach((n, s) => {
      for (let i = 0; i < n; i += 1) {
        data.station.push(s);
        data.time.push(i);
        data.value.push(i % 1000);
      }
    });
    const out = normalise(data, { registry: synthetic(nos), fetchedAt: NOW });
    expect(out.obs).toEqual([]);
    const parts = [...obsParts(out)];
    // Greedy and in file order: 30,000 | 30,000 + 10,000 | 40,000.
    expect(parts.map((p) => p.length)).toEqual([30_000, 40_000, 40_000]);
    expect(CHUNK).toBe(50_000);
    expect(parts.map((p) => [...new Set(p.map((r) => r.series))])).toEqual([
      [keyOf(nos[0] as string)],
      [keyOf(nos[1] as string), keyOf(nos[2] as string)],
      [keyOf(nos[3] as string)],
    ]);
    expect(parts.flat()).toHaveLength(110_000);
    expect([...obsParts(out)]).toEqual(parts);
    for (const p of parts) for (const r of [p[0], p.at(-1)]) ObsRow.parse(r);
  });

  it('no kept row at all gives no chunk, and a series with only dropped points leaves none', () => {
    expect([...obsParts(go([row(-15, 'NA')]))]).toEqual([]);
    expect([...obsParts(go([row(16, 1)]))]).toEqual([]);
  });
});

describe('property and fuzz tests', () => {
  const frag = fc.oneof(
    fc.constantFrom(
      NO,
      '1234512345',
      '12345',
      `${NO};`,
      'NA',
      '36.80',
      at(0),
      at(5000),
      '2026-09-22T14:45:00.000+02:00',
      '',
      'é',
      '-',
      '.',
    ),
    fc.string({ maxLength: 12 }),
  );
  const line = fc.oneof(
    fc.array(frag, { maxLength: 4 }).map((a) => a.join(';')),
    fc.string({ maxLength: 160 }),
  );

  it('parse throws nothing but SchemaDrift on arbitrary or line-shaped input, and what it returns is consistent', () => {
    fc.assert(
      fc.property(fc.array(line, { maxLength: 14 }), fc.boolean(), fc.boolean(), (lines, header, ascii) => {
        const text = (header ? [HEADER, ...lines] : lines).join('\r\n');
        try {
          const r = parseText(text, 'messwerte.txt', { ascii });
          expect([r.time.length, r.value.length]).toEqual([r.station.length, r.station.length]);
          for (const s of r.station) expect(r.stations[s]).toMatch(/^\d{6,13}$/);
          for (const t of r.time) expect(r.times[t]).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        } catch (err) {
          expect(err).toBeInstanceOf(SchemaDrift);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('a payload built from valid shapes always parses (rows and terminators are counted, the cap is not reached)', () => {
    const validRow = fc.tuple(
      fc.stringMatching(/^\d{6,13}$/),
      fc.integer({ min: -100_000, max: 100 }),
      fc.oneof(
        fc.constant('NA'),
        fc.integer({ min: -99_999, max: 99_999 }).map((n) => (n / 100).toFixed(2)),
      ),
    );
    fc.assert(
      fc.property(fc.array(fc.oneof(validRow, fc.stringMatching(/^\d{6,13}$/)), { maxLength: 40 }), (items) => {
        const lines = items.map((it) => (typeof it === 'string' ? `${it};` : row(it[1], it[2], it[0])));
        const r = read(lines);
        expect([r.station.length, r.terminators]).toEqual([
          items.filter((i) => typeof i !== 'string').length,
          items.filter((i) => typeof i === 'string').length,
        ]);
      }),
      { numRuns: 300 },
    );
  });

  it('normalise yields valid, unique, never-future, in-window rows that equal an independent oracle', () => {
    const stations = ['2000000000001', '2000000000002', '1234512345', '2999999999999'];
    const reg = synthetic(['2000000000001', '2000000000002']);
    const minute = fc.oneof(
      fc.integer({ min: -4, max: 4 }).map((k) => k * 5),
      fc.integer({ min: -13_300, max: 8 }).map((k) => k * 5),
    );
    const value = fc.constantFrom('1.0', '1.00', '2.5', 'NA', '5000.5', '-2000.5', '0', '36.8');
    const point = fc.tuple(fc.constantFrom(...stations), minute, value);
    fc.assert(
      fc.property(
        fc.array(point, { maxLength: 40 }),
        fc.option(fc.integer({ min: -3000, max: 10 }), { nil: undefined }),
        (points, sinceMin) => {
          const since = sinceMin === undefined ? undefined : NOW + sinceMin * 60_000;
          const out = normalise(read(points.map(([no, m, v]) => row(m, v, no))), {
            registry: reg,
            fetchedAt: NOW,
            ...(since === undefined ? {} : { since }),
          });
          const got = rows(out);
          for (const r of got) ObsRow.parse(r);
          expect(new Set(got.map((r) => `${r.series}|${r.ts}`)).size).toBe(got.length);
          for (const r of got) {
            expect(Date.parse(r.ts)).toBeLessThanOrEqual(NOW + 15 * 60_000);
            expect(Date.parse(r.ts)).toBeGreaterThanOrEqual(NOW - 45 * 86_400_000);
            if (since !== undefined) expect(Date.parse(r.ts)).toBeGreaterThanOrEqual(since);
          }
          for (const series of new Set(got.map((r) => r.series))) {
            const ts = got.filter((r) => r.series === series).map((r) => r.ts);
            expect(ts).toEqual([...ts].sort());
          }

          // The oracle: per (station, instant) the distinct values of the rows that survive the window.
          const expected = new Map<string, Set<number>>();
          const count = { placeholder: 0, sentinel: 0, future: 0, too_old: 0, outside_window: 0 };
          const unknown = new Set<string>();
          for (const [no, m, v] of points) {
            if (no === '1234512345') count.placeholder += 1;
            else if (!reg.has(keyOf(no))) unknown.add(no);
            else if (v === 'NA') count.sentinel += 1;
            else if (m > 15) count.future += 1;
            else if (m * 60_000 < -45 * 86_400_000) count.too_old += 1;
            else if (since !== undefined && NOW + m * 60_000 < since) count.outside_window += 1;
            else {
              const k = `${keyOf(no)}|${new Date(NOW + m * 60_000).toISOString()}`;
              expected.set(k, (expected.get(k) ?? new Set()).add(Number(v)));
            }
          }
          for (const [k, vs] of Object.entries(count)) expect([k, out.dropped[k] ?? 0]).toEqual([k, vs]);
          expect(out.unknown).toBe(unknown.size);
          const want = [...expected].filter(([, vs]) => vs.size === 1).map(([k, vs]) => [k, [...vs][0]]);
          expect(new Map(got.map((r) => [`${r.series}|${r.ts}`, r.value]))).toEqual(
            new Map(want as [string, number][]),
          );
          for (const r of got) expect(r.qc).toBe(r.value > 5000 || r.value < -2000 ? QC.RAW | QC.RANGE : QC.RAW);
          // The chunks can be walked again with the same result.
          expect([...obsParts(out)]).toEqual([...obsParts(out)]);
        },
      ),
      { numRuns: 300 },
    );
  });
});
