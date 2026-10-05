import { StaticCache } from '../../src/api/states.ts';
import { attributionRows } from '../../src/attribution.ts';
import type { ChannelAudience } from '../../src/db/audience.ts';
import type { Db } from '../../src/db/pool.ts';
import type { RenderCtx } from '../../src/publish/cycle.ts';

// P9a S2: a render context over a role's real connection (rws_publish / rws_owner_api), for the sources, status and
// warnings tests.

export const NOW = Date.parse('2026-10-04T12:05:00Z');

export async function ctxFor(db: Db, family: ChannelAudience, over: Partial<RenderCtx> = {}): Promise<RenderCtx> {
  return {
    db: db.db,
    family,
    now: NOW,
    window: { dataEpochMs: Date.parse('2026-09-01T00:00:00Z'), displayStartMs: Date.parse('2026-10-01T00:00:00Z') },
    build: 'dev',
    sections: new Map(),
    cache: new StaticCache(60_000, () => NOW),
    inputs: undefined,
    attribution: await attributionRows(db.db, family),
    ...over,
  };
}

/** The ids of the owner-audience sources of the registry (invariant 11: never in a public file). */
export const OWNER_IDS = ['BE-3', 'LU-2', 'LU-3', 'LU-4', 'DE-2', 'DE-3', 'CANARY-OWNER'];
