import { type Kysely, sql } from 'kysely';
import { OWNER_ONLY_VIEWS, VIEWS } from '../../db/audience.ts';
import type { DB } from '../../db/generated.ts';
import type { RenderCtx } from '../cycle.ts';
import { attributionFor } from './attribution.ts';
import { sourceDates } from './dates.ts';

// P9a (A§9.1, catalogue §1b): sources.json, the family's sources with the registry's attribution rows verbatim, the
// licence and the date the licence asks for. The owner file adds each source's audience and, for an owner source, its
// private basis (the clause verbatim, the terms page and the retrieval date; catalogue §0.8). Provider names and
// texts are data only (invariant 3).

type SourceRow = {
  id: string;
  name: string;
  provider: string;
  licence_kind: string | null;
  terms_url: string | null;
  audience: 'public' | 'owner';
};

/** The family's sources (its own source view), by id. */
export const familySources = (db: Kysely<DB>, family: RenderCtx['family']) =>
  sql<SourceRow>`
    SELECT id, name, provider, licence_kind, terms_url, audience::text AS audience
    FROM ${sql.table(VIEWS[family].source)} ORDER BY id`
    .execute(db)
    .then((r) => r.rows);

/** The owner family's private bases by source id (the owner role only; the public family never asks). */
const privateBases = (db: Kysely<DB>) =>
  sql<{ source_id: string; private_basis: unknown }>`
    SELECT source_id, private_basis FROM ${sql.table(OWNER_ONLY_VIEWS.privateBasis)}`
    .execute(db)
    .then((r) => new Map(r.rows.map((x) => [x.source_id, x.private_basis])));

export async function sources(c: RenderCtx): Promise<unknown> {
  const rows = await familySources(c.db, c.family);
  const dates = await sourceDates(c.db, c.family, c.attribution);
  const bases = c.family === 'owner' ? await privateBases(c.db) : new Map<string, unknown>();
  const entries = rows.map((s) => {
    const own = c.attribution.filter((a) => a.source_id === s.id);
    const d = dates.get(s.id);
    const entry = {
      id: s.id,
      name: s.name,
      provider: s.provider,
      licence: { kind: s.licence_kind, url: s.terms_url },
      attribution: own.map((a) => ({ lang: a.lang, text: a.text, url: a.url, required: a.required })),
      dateKind: own.find((a) => a.date_kind !== null)?.date_kind ?? null,
      date: d?.date ?? null,
      dateText: d?.dateText ?? null,
    };
    return c.family === 'owner' ? { ...entry, audience: s.audience, privateBasis: bases.get(s.id) ?? null } : entry;
  });
  return {
    schemaVersion: 1,
    generatedAt: new Date(c.now).toISOString(),
    sources: entries,
    attribution: attributionFor(
      c.attribution,
      rows.map((s) => s.id),
      dates,
    ),
  };
}
