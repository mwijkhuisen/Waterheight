import { SchemaDrift } from '@rws/core';
import { describe, expect, it } from 'vitest';
import { parseWaarnemingen } from '../../../src/adapters/nl-1/parse.ts';
import { PROVIDERS } from '../../../src/backfill/provider.ts';
import { rawFixture } from '../registry.ts';

// KG-355: Kwaliteitswaardecode is two to four digits. The recorded 2003 chunk carries 1004; the other shapes are
// made by editing its code in the real body.
const NAME = 'nl-1-backfill-lith-h-20030129';
const real = () => new TextDecoder().decode(rawFixture('NL-1', NAME).body);
const withCode = (code: string) =>
  new TextEncoder().encode(real().replaceAll('"Kwaliteitswaardecode":"1004"', `"Kwaliteitswaardecode":"${code}"`));

describe('Kwaliteitswaardecode shape', () => {
  it('the recorded body has 1004 and parses', () => {
    expect(real()).toContain('"Kwaliteitswaardecode":"1004"');
    expect(() => parseWaarnemingen(rawFixture('NL-1', NAME).body)).not.toThrow();
  });
  it.each(['00', '99', '123'])('accepts %s', (c) => {
    expect(() => parseWaarnemingen(withCode(c))).not.toThrow();
  });
  it.each(['0', '12345', 'ab', '1a', ''])('refuses %j', (c) => {
    expect(() => parseWaarnemingen(withCode(c))).toThrow(SchemaDrift);
  });
  it('the NL-1 backfill provider inspects the recorded chunk as ok', async () => {
    const r = await PROVIDERS['NL-1']?.inspect(rawFixture('NL-1', NAME).body);
    expect(r).toMatchObject({ ok: true });
  });
});
