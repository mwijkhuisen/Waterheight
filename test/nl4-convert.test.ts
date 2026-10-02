import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GuardFailure } from '../apps/server/src/http/guards.ts';
import { readThresholds } from '../apps/server/src/load/thresholds.ts';
import { EDITION, generate, OUTPUT, readInput, SHA256 } from '../scripts/convert-nl4.ts';
import { zip } from './zip.ts';

// registry/thresholds/nl-4.csv is generated (scripts/convert-nl4.ts) from the archived NL-4 workbook: the
// committed file is exactly the converter's output, the converter reads only the pinned bytes, and every
// workbook goes through the XLSX guard before anything parses it.

const committed = readFileSync(OUTPUT, 'utf8');
const input = readInput();
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The guard's reason for a workbook, run through the converter with that workbook's own sha256 as the pin. */
async function refused(buf: Buffer): Promise<string> {
  try {
    await generate(buf, sha256(buf));
  } catch (e) {
    if (e instanceof GuardFailure) return e.reason;
    throw e;
  }
  return 'passed';
}

describe('registry/thresholds/nl-4.csv', () => {
  it('is exactly what the converter writes from the archived workbook, byte for byte on every run', async () => {
    const first = (await generate(input)).text;
    expect(first).toBe((await generate(input)).text);
    expect(committed).toBe(first);
    // Two conversions of a 3.8 MB sheet: seconds on a busy runner.
  }, 60_000);

  it('reads back with the pinned sha256 and edition: 1,542 classes', () => {
    const { sha256: hash, edition, rows } = readThresholds(committed);
    expect([hash, edition, rows.length]).toEqual([SHA256, EDITION, 1542]);
    expect(sha256(input)).toBe(SHA256);
  });

  it('fails closed on a hand edit, a lost header line or a changed row', () => {
    expect(() => readThresholds(committed.replace('# edition: ', '# edition '))).toThrow();
    expect(() => readThresholds(committed.replace(',1070,,1,0\n', ',1070.0,,1,0\n'))).toThrow();
    expect(() => readThresholds(committed.replace(',1070,,1,0\n', ',1070,,1,0,\n'))).toThrow();
    expect(() => readThresholds(committed.replace('Gehele jaar', '"Gehele jaar"'))).toThrow();
    expect(() => readThresholds(committed.replace('\ncode,', '\n# code,'))).toThrow();
    expect(() => readThresholds(committed.slice(0, -10))).toThrow();
  });
});

describe('the converter', () => {
  it('refuses a workbook whose sha256 is not the pinned one, before parsing it', async () => {
    const changed = Buffer.from(input);
    changed[changed.length - 1] = (changed[changed.length - 1] as number) ^ 1;
    await expect(generate(changed)).rejects.toThrow(/sha256/);
  });

  it('refuses a ZIP bomb, an unexpected member and a DOCTYPE, whatever the pin', async () => {
    expect(await refused(zip({ 'xl/worksheets/sheet2.xml': Buffer.alloc(8 * 1024 * 1024, 0x20) }))).toBe('zip_ratio');
    const workbook = Buffer.from('<?xml version="1.0"?><workbook><sheets/></workbook>');
    expect(await refused(zip({ 'xl/workbook.xml': workbook, 'xl/evil.xml': Buffer.from('<a/>') }))).toBe('zip_name');
    const dtd = Buffer.from('<?xml version="1.0"?><!DOCTYPE workbook [<!ENTITY a "b">]><workbook>&a;</workbook>');
    expect(await refused(zip({ 'xl/workbook.xml': dtd }))).toBe('xml_dtd');
    // The same clean workbook passes the guard and stops at the missing members instead.
    expect(await refused(zip({ 'xl/workbook.xml': workbook }))).toBe('xlsx_member_missing');
  });
});
