import { expect, it } from 'vitest';
import { STALENESS_CAP_MS } from '../packages/contracts/src/stations.ts';
import { STALENESS_CAP } from '../scripts/gen-views.ts';

// #212: the cap lives twice, as SQL in the generator and as ms in the registry validator; the copies stay equal.
it('STALENESS_CAP (SQL) equals STALENESS_CAP_MS (registry validator)', () => {
  expect(STALENESS_CAP).toBe(`interval '${STALENESS_CAP_MS / 86_400_000} days'`);
});
