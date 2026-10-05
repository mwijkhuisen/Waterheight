import type { AttributionEntry } from '@rws/contracts';
import { type Kysely, sql } from 'kysely';
import { type ChannelAudience, VIEWS } from '../../db/audience.ts';
import type { DB } from '../../db/generated.ts';

// P9a (§4.2): every file's `attribution` lists exactly the sources its body names, each with its rows of the
// family's attribution view verbatim (the registry's text) and, where the licence asks for a date, that date.

export type AttributionRow = {
  source_id: string;
  lang: 'nl' | 'en' | 'de' | 'fr' | null;
  text: string;
  url: string | null;
  required: boolean;
  date_kind: AttributionEntry['dateKind'];
};

/** The family's attribution rows, by source then `ord`. */
export const attributionRows = (db: Kysely<DB>, family: ChannelAudience) =>
  sql<AttributionRow>`
    SELECT source_id, lang, text, url, required, date_kind FROM ${sql.table(VIEWS[family].attribution)}
    ORDER BY source_id, ord`
    .execute(db)
    .then((r) => r.rows);

/** A dated licence's date for one source (latest, sources and status files; null elsewhere: the web dates by t). */
export type SourceDate = { date: string | null; dateText: string | null };

/** The entries of the sources in `ids`, in row order; `dates` fills the date of a row whose licence asks for one. */
export function attributionFor(
  rows: readonly AttributionRow[],
  ids: Iterable<string>,
  dates: ReadonlyMap<string, SourceDate> = new Map(),
): AttributionEntry[] {
  const want = new Set(ids);
  return rows
    .filter((r) => want.has(r.source_id))
    .map((r) => {
      const d = r.date_kind === null ? undefined : dates.get(r.source_id);
      return {
        source: r.source_id,
        lang: r.lang,
        text: r.text,
        url: r.url,
        required: r.required,
        dateKind: r.date_kind,
        date: d?.date ?? null,
        dateText: d?.dateText ?? null,
      };
    });
}
