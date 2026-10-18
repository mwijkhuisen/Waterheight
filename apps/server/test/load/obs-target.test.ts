import { describe, expect, it } from 'vitest';
import { LOAD_ADAPTERS } from '../../src/load/adapters.ts';

// P14b: `obsTarget` binds another source's registry for a payload's rows, which only a backfill may do (its rows
// are history, stop at DATA_FLOOR and dirty nothing); a live spec writing into another source's series would bypass
// that source's own health and precedence.

describe('obsTarget', () => {
  const specs = Object.entries(LOAD_ADAPTERS).flatMap(([source, a]) =>
    Object.entries(a.specs).map(([id, spec]) => ({ source, id, spec })),
  );

  it('is set only on a backfill spec, and names another loaded source', () => {
    for (const { source, id, spec } of specs) {
      if (spec.obsTarget === undefined) continue;
      expect([id, spec.backfill]).toEqual([id, true]);
      expect([id, spec.obsTarget === source]).toEqual([id, false]);
      expect([id, Object.hasOwn(LOAD_ADAPTERS, spec.obsTarget)]).toEqual([id, true]);
    }
  });
});
