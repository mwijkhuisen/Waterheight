import type { StaticMeta } from '@rws/contracts';
import { readMeta } from '../../api/data.ts';
import { iso } from '../../api/util.ts';
import { attributionFor } from '../../attribution.ts';
import type { MetaInput, RenderCtx } from '../cycle.ts';

// P9a: meta.json, written last: the API's /meta plus what the cycle knows (day versions, degraded, latestFrom).

export async function renderMeta(c: RenderCtx, m: MetaInput): Promise<StaticMeta> {
  const meta = await readMeta(c.db, c.family, c.window, c.build, new Date(c.now));
  return {
    ...meta,
    schemaVersion: 1,
    generatedAt: iso(new Date(c.now)),
    dayVersions: m.dayVersions,
    degraded: m.degraded,
    latestFrom: m.latestFrom,
    attribution: attributionFor(
      c.attribution,
      meta.sources.map((s) => s.id),
    ),
  };
}
