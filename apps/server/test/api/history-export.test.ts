import { describe, expect, it } from 'vitest';
import { readRegistry } from '../../src/load/registry-sync.ts';

// A tripwire (review SR-2, KG-114). The API keeps an answer, and lets browsers
// keep it, for up to a day whatever a source's history window is; the views
// drop the rows past `history_window` only for a source without the
// history_export channel, and no public source is one today. The day one is,
// this fails: cap the API's cache lifetime by the history window first.

describe('the public registry and the cache lifetime of the API', () => {
  it('every public source, and every public series of one, keeps history_export', () => {
    const narrowed = readRegistry()
      .sources.filter((s) => s.audience === 'public')
      .flatMap((s) => [
        ...(s.history_export ? [] : [s.id]),
        ...s.series
          .filter((o) => (o.audience ?? 'public') === 'public' && o.history_export === false)
          .map((o) => `${s.id}/${o.key}`),
      ]);
    expect(
      narrowed,
      'public without history_export: cap the API cache (the LRU TTL and max-age) by the history window first (SR-2, KG-114)',
    ).toEqual([]);
  });
});
