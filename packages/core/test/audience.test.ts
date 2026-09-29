import { describe, expect, it } from 'vitest';
import { effective } from '../src/audience.ts';

const open = { audience: 'public', display: true, api: true, bulk_export: true, history_export: true } as const;
const owner = { audience: 'owner', display: true, api: true, bulk_export: false, history_export: true } as const;

describe('effective audience and channels', () => {
  it('is the source itself without an override', () => {
    expect(effective(open)).toEqual(open);
  });

  it('narrows the audience public > owner > off', () => {
    expect(effective(open, { key: 'a', audience: 'owner', reason: 'r' }).audience).toBe('owner');
    expect(effective(open, { key: 'a', audience: 'off', reason: 'r' }).audience).toBe('off');
    expect(effective(owner, { key: 'a', audience: 'off', reason: 'r' }).audience).toBe('off');
  });

  it('never widens the audience', () => {
    expect(effective(owner, { key: 'a', audience: 'public', reason: 'r' }).audience).toBe('owner');
  });

  it('keeps a channel only when source and override both allow it', () => {
    const e = effective(owner, { key: 'a', api: false, bulk_export: true, reason: 'r' });
    expect(e).toEqual({ audience: 'owner', display: true, api: false, bulk_export: false, history_export: true });
  });

  it('rejects an override with an unknown key', () => {
    expect(() => effective(open, { key: 'a', audiance: 'off', reason: 'r' })).toThrow(/audiance/);
  });
});
