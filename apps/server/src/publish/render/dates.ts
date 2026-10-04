import { type Kysely, sql } from 'kysely';
import { type ChannelAudience, VIEWS } from '../../db/audience.ts';
import type { DB } from '../../db/generated.ts';
import type { AttributionRow, SourceDate } from './attribution.ts';

// P9a (catalogue §1b, A§9.1): the date each licence asks for, per source, for latest.json, sources.json and
// status.json. `update`: the provider's own last-update instant where we store one (DE-6: source_health.detail
// `provider_updated`, written by the loader), else the newest instant of the source's data; `retrieval`: the last
// successful fetch. `stand` and `reference` are not stored yet (the registry sync writes `update` and `retrieval`
// only): null. dateText is set only for DE-6 ("Stand: TT.MM.JJJJ hh:mm", Europe/Berlin), never provider text.

type HealthRow = {
  source_id: string;
  newest_ts: Date | null;
  last_fetch_ok: Date | null;
  provider_updated: string | null;
};

const BERLIN = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** `Stand: TT.MM.JJJJ hh:mm` in Europe/Berlin (the LHP form, catalogue §1b). */
export function standText(ms: number): string {
  const p = Object.fromEntries(BERLIN.formatToParts(ms).map((x) => [x.type, x.value]));
  return `Stand: ${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
}

/** The dated licences' dates of the family's sources (only sources whose rows ask for one). */
export async function sourceDates(
  db: Kysely<DB>,
  family: ChannelAudience,
  rows: readonly AttributionRow[],
): Promise<Map<string, SourceDate>> {
  const kinds = new Map(rows.flatMap((r) => (r.date_kind === null ? [] : [[r.source_id, r.date_kind] as const])));
  const out = new Map<string, SourceDate>();
  if (kinds.size === 0) return out;
  const { rows: health } = await sql<HealthRow>`
    SELECT source_id, newest_ts, last_fetch_ok, detail ->> 'provider_updated' AS provider_updated
    FROM ${sql.table(VIEWS[family].sourceHealth)}`.execute(db);
  for (const h of health) {
    const kind = kinds.get(h.source_id);
    if (kind === 'retrieval') out.set(h.source_id, { date: h.last_fetch_ok?.toISOString() ?? null, dateText: null });
    if (kind !== 'update') continue;
    const provider = h.provider_updated === null ? Number.NaN : Date.parse(h.provider_updated);
    if (Number.isFinite(provider)) {
      const date = new Date(provider).toISOString();
      out.set(h.source_id, { date, dateText: h.source_id === 'DE-6' ? standText(provider) : null });
    } else out.set(h.source_id, { date: h.newest_ts?.toISOString() ?? null, dateText: null });
  }
  return out;
}
