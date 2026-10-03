import type { ClassRow, ReferenceRow, WarningRow, Warnings } from '@rws/core';
import { sql } from 'kysely';
import { readMeta, type Tx, writeMeta } from './store.ts';

// P7a: references, classes and warnings with validity ranges (A§6; PHASES P7a). Nothing is overwritten by
// another payload: a change closes the range it ends and opens a new one, and alerts by count only (never a
// value: an owner-audience threshold must not reach a log, invariant 11). Newest fetch wins, as for
// observations: a payload compares itself with the newest range of a key (open or closed) by
// (fetched_at, batch id) of the newest payload that stated it (`seen_at`, `seen_batch`), so a late payload
// never inserts behind a newer range and a replay writes nothing. Only the payload that stated a row may
// correct it in place (a replay after a parser fix). rws_load has no DELETE: ranges close by UPDATE.

export type RefChange = 'new' | 'changed' | 'corrected' | 'removed' | 'older_ignored';
export type Changes = Partial<Record<RefChange, number>>;

/** A reference row resolved to its series: `counted` when the series shares its source's audience. */
export type ResolvedRef = ReferenceRow & { id: number; counted: boolean };

/** The canonical text of a daterange as PostgreSQL prints it (inclusive `[from, to]` days → `[from,to+1)`). */
export function periodText(p: ReferenceRow['period']): string | null {
  if (p === null) return null;
  const [from, to] = p;
  if (to === null) return `[${from},)`;
  const next = new Date(Date.parse(`${to}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return `[${from},${next})`;
}

const keyOf = (id: number, r: Pick<ReferenceRow, 'kind' | 'season_from_md' | 'season_to_md' | 'priority'>) =>
  `${id}|${r.kind}|${r.season_from_md}|${r.season_to_md}|${r.priority}`;

type Stored = {
  series_id: number;
  kind: string;
  season_from_md: number;
  season_to_md: number;
  priority: number;
  value: number;
  unit: string;
  semantics: string;
  percentile_convention: string | null;
  period: string | null;
  basis_label: string | null;
  lo: Date | null;
  hi: Date | null;
  /** This payload is newer than the newest one that stated the row. */
  newer: boolean;
  /** This very payload is the newest one that stated it (a replay). */
  mine: boolean;
};

// `value` is a `real`: PostgreSQL prints it as its shortest decimal (0.05), so both sides compare as float32.
const sameRef = (s: Stored, r: ResolvedRef) =>
  Math.fround(s.value) === Math.fround(r.value) &&
  s.unit === r.unit &&
  s.semantics === r.semantics &&
  s.percentile_convention === r.convention &&
  s.period === periodText(r.period) &&
  s.basis_label === r.basis_label;

/**
 * Stores a payload's references. `scope` names the series whose references the payload states in full: an open
 * range of such a series that the payload no longer states is closed at the fetch time (`removed`).
 */
export async function applyReferences(
  tx: Tx,
  source: string,
  rows: readonly ResolvedRef[],
  scope: ReadonlySet<number>,
  batch: string,
  fetchedAt: Date,
): Promise<{ changes: Changes; writes: number }> {
  const changes: Changes = {};
  let writes = 0;
  const ids = [...new Set([...rows.map((r) => r.id), ...scope])];
  if (ids.length === 0) return { changes, writes };
  const { rows: stored } = await sql<Stored>`
    SELECT DISTINCT ON (series_id, kind, season_from_md, season_to_md, priority)
           series_id, kind, season_from_md, season_to_md, priority, value, unit, semantics, percentile_convention,
           period::text AS period, basis_label, lower(valid) AS lo, upper(valid) AS hi,
           seen_at IS NULL OR (seen_at, seen_batch) < (${fetchedAt}::timestamptz, ${batch}::bigint) AS newer,
           seen_batch IS NOT DISTINCT FROM ${batch}::bigint AS mine
    FROM reference_value
    WHERE source_id = ${source} AND series_id = ANY(${ids}::int[])
    ORDER BY series_id, kind, season_from_md, season_to_md, priority, lower(valid) DESC NULLS LAST`.execute(tx);
  const newest = new Map(stored.map((s) => [keyOf(s.series_id, s), s]));
  const wanted = new Map(rows.map((r) => [keyOf(r.id, r), r]));
  const note = (c: RefChange, counted: boolean) => {
    if (counted) changes[c] = (changes[c] ?? 0) + 1;
  };
  const at = (d: Date | string | null) => sql`${d === null ? null : new Date(d)}::timestamptz`;
  const where = (r: ResolvedRef, lo: Date | null) =>
    sql`source_id = ${source} AND series_id = ${r.id} AND kind = ${r.kind} AND season_from_md = ${r.season_from_md}
        AND season_to_md = ${r.season_to_md} AND priority = ${r.priority}
        AND lower(valid) IS NOT DISTINCT FROM ${at(lo)}`;
  const insert = (r: ResolvedRef, lo: Date | string | null) =>
    sql`INSERT INTO reference_value (series_id, source_id, kind, value, unit, semantics, percentile_convention,
          period, season_from_md, season_to_md, priority, basis_label, valid, batch_id, seen_at, seen_batch)
        VALUES (${r.id}, ${source}, ${r.kind}, ${r.value}, ${r.unit}, ${r.semantics}, ${r.convention},
          ${periodText(r.period)}::daterange, ${r.season_from_md}, ${r.season_to_md}, ${r.priority}, ${r.basis_label},
          tstzrange(${at(lo)}, NULL), ${batch}::bigint, ${fetchedAt}::timestamptz, ${batch}::bigint)`.execute(tx);
  const rewrite = (r: ResolvedRef, lo: Date | null) =>
    sql`UPDATE reference_value SET value = ${r.value}, unit = ${r.unit}, semantics = ${r.semantics},
          percentile_convention = ${r.convention}, period = ${periodText(r.period)}::daterange,
          basis_label = ${r.basis_label}, batch_id = ${batch}::bigint, seen_at = ${fetchedAt}::timestamptz,
          seen_batch = ${batch}::bigint
        WHERE ${where(r, lo)}`.execute(tx);

  for (const r of wanted.values()) {
    const cur = newest.get(keyOf(r.id, r));
    if (cur === undefined) {
      await insert(r, r.valid_from);
      note('new', r.counted);
    } else if (cur.mine) {
      if (sameRef(cur, r)) continue;
      await rewrite(r, cur.lo);
      note('corrected', r.counted);
    } else if (!cur.newer) {
      note('older_ignored', r.counted);
      continue;
    } else if (cur.hi !== null) {
      // The key was closed (no longer stated) by an earlier payload: it re-opens from this fetch on.
      await insert(r, cur.hi > fetchedAt ? cur.hi : fetchedAt);
      note('new', r.counted);
    } else if (sameRef(cur, r)) {
      await sql`UPDATE reference_value SET seen_at = ${fetchedAt}::timestamptz, seen_batch = ${batch}::bigint
                WHERE ${where(r, cur.lo)}`.execute(tx);
    } else {
      // A change: from the provider's own new start of validity when it states a later one, else from this fetch.
      const from = r.valid_from !== null && (cur.lo === null || new Date(r.valid_from) > cur.lo);
      const lo = from ? new Date(r.valid_from as string) : fetchedAt;
      if (cur.lo !== null && lo <= cur.lo) {
        // Fetched in the instant the range began: there is no time to close; the newer payload's tuple wins.
        await rewrite(r, cur.lo);
      } else {
        await sql`UPDATE reference_value SET valid = tstzrange(lower(valid), ${lo}::timestamptz)
                  WHERE ${where(r, cur.lo)}`.execute(tx);
        await insert(r, lo);
      }
      note('changed', r.counted);
    }
    writes += 1;
  }

  for (const cur of stored) {
    if (!scope.has(cur.series_id) || cur.hi !== null || !cur.newer) continue;
    if (wanted.has(keyOf(cur.series_id, cur))) continue;
    if (cur.lo !== null && fetchedAt <= cur.lo) continue;
    await sql`UPDATE reference_value SET valid = tstzrange(lower(valid), ${fetchedAt}::timestamptz),
                seen_at = ${fetchedAt}::timestamptz, seen_batch = ${batch}::bigint
              WHERE source_id = ${source} AND series_id = ${cur.series_id} AND kind = ${cur.kind}
                AND season_from_md = ${cur.season_from_md} AND season_to_md = ${cur.season_to_md}
                AND priority = ${cur.priority} AND upper_inf(valid)`.execute(tx);
    // Removal counts like a change of a series of the same audience; scope holds only resolved series.
    changes.removed = (changes.removed ?? 0) + 1;
    writes += 1;
  }
  return { changes, writes };
}

/**
 * Stores a payload's station classes on change only: a row is written when the newest stored row of the station
 * and source at or before its instant says something else. A replay by the batch that wrote a row corrects it in
 * place; a row of another batch at the same instant is left alone. Returns the rows written, split into the first
 * class of a station (`new`) and a change of it (`changed`), plus the stations the registry does not have.
 */
export async function applyClasses(
  tx: Tx,
  source: string,
  rows: readonly ClassRow[],
  batch: string,
): Promise<{ new: number; changed: number; unknown: number; writes: number }> {
  if (rows.length === 0) return { new: 0, changed: 0, unknown: 0, writes: 0 };
  // One row per station and instant (the last stated), so one statement never touches a row twice.
  const byKey = new Map(rows.map((r) => [`${r.station}\n${r.ts}`, r]));
  const stations = [...new Set([...byKey.values()].map((r) => r.station))];
  // A station the registry does not have is unknown (a registry change could still load it); one whose every
  // series is withheld (effective audience `off`, e.g. a CH-1 station off a Rhine water body) takes no class.
  const { rows: known } = await sql<{ id: string; stored: boolean }>`
    SELECT st.id, bool_or(s.active AND LEAST(src.audience, COALESCE(s.audience, src.audience)) <> 'off') AS stored
    FROM station st LEFT JOIN series s ON s.station_id = st.id LEFT JOIN source src ON src.id = s.source_id
    WHERE st.id = ANY(${stations}::text[]) GROUP BY st.id`.execute(tx);
  const ok = new Set(known.filter((k) => k.stored === true).map((k) => k.id));
  const kept = [...byKey.values()].filter((r) => ok.has(r.station));
  const unknown = stations.filter((s) => !known.some((k) => k.id === s)).length;
  if (kept.length === 0) return { new: 0, changed: 0, unknown, writes: 0 };
  const { rows: written } = await sql<{ first: boolean }>`
    WITH v AS (
      SELECT * FROM unnest(${kept.map((r) => r.station)}::text[], ${kept.map((r) => r.ts)}::timestamptz[],
                           ${kept.map((r) => r.code)}::text[], ${kept.map((r) => r.label)}::text[],
                           ${kept.map((r) => r.level)}::int2[]) AS v(station, ts, code, label, level)
    ), prev AS (
      SELECT v.*, p.provider_code AS pc, p.provider_label AS pl, p.level_norm AS pn, p.ts IS NULL AS first
      FROM v LEFT JOIN LATERAL (
        SELECT c.provider_code, c.provider_label, c.level_norm, c.ts FROM class_obs c
        WHERE c.subject_type = 'station' AND c.subject_id = v.station AND c.source_id = ${source} AND c.ts <= v.ts
        ORDER BY c.ts DESC LIMIT 1) p ON true
    ), ins AS (
      INSERT INTO class_obs (subject_type, subject_id, ts, source_id, provider_code, provider_label, level_norm, batch_id)
      SELECT 'station', station, ts, ${source}, code, label, level, ${batch}::bigint FROM prev
      WHERE (pc, pl, pn) IS DISTINCT FROM (code, label, level)
      ON CONFLICT (subject_type, subject_id, source_id, ts) DO UPDATE
        SET provider_code = EXCLUDED.provider_code, provider_label = EXCLUDED.provider_label,
            level_norm = EXCLUDED.level_norm
        WHERE class_obs.batch_id = EXCLUDED.batch_id
      RETURNING subject_id, ts
    )
    SELECT prev.first FROM ins JOIN prev ON prev.station = ins.subject_id AND prev.ts = ins.ts`.execute(tx);
  const first = written.filter((w) => w.first).length;
  return { new: first, changed: written.length - first, unknown, writes: written.length };
}

type StoredArea = {
  id: string;
  area_key: string;
  level_norm: number | null;
  level_raw: string | null;
  label_raw: string | null;
  lo: Date;
  hi: Date | null;
  newer: boolean;
  mine: boolean;
};

const sameArea = (s: StoredArea, w: WarningRow) =>
  s.level_norm === w.level && s.level_raw === w.level_raw && s.label_raw === w.label_raw;

/** The key of the app_meta map of message identifiers that a later message closed (an Update or a Cancel). */
export const closesKey = (source: string) => `cap_closes:${source}`;
type Closes = Record<string, string>;
/** The map holds only the referenced identifiers of one source's flood messages: a few per event. */
const CLOSES_MAX = 2000;

/** Stores a payload's warnings (snapshot or message mode, core `Warnings`). */
export async function applyWarnings(
  tx: Tx,
  source: string,
  w: Warnings | undefined,
  batch: string,
  fetchedAt: Date,
): Promise<{ changes: Changes; writes: number }> {
  const changes: Changes = {};
  let writes = 0;
  if (w === undefined) return { changes, writes };
  const note = (c: RefChange) => {
    changes[c] = (changes[c] ?? 0) + 1;
  };
  const insert = (r: WarningRow, lo: Date | string, hi: Date | string | null) =>
    sql`INSERT INTO warning_area (source_id, area_key, name, geometry_geojson, level_norm, level_raw, label_raw,
          valid, issued_at, batch_id, provider_ref, texts, seen_at, seen_batch)
        VALUES (${source}, ${r.area_key}, ${r.name}, ${r.geometry}, ${r.level}, ${r.level_raw}, ${r.label_raw},
          tstzrange(${new Date(lo)}::timestamptz, ${hi === null ? null : new Date(hi)}::timestamptz),
          ${r.issued_at === null ? null : new Date(r.issued_at)}::timestamptz, ${batch}::bigint, ${r.ref ?? null},
          ${r.texts === undefined ? null : JSON.stringify(r.texts)}::jsonb, ${fetchedAt}::timestamptz,
          ${batch}::bigint)`.execute(tx);

  if (w.mode === 'snapshot') {
    const at = new Date(w.at);
    const { rows: stored } = await sql<StoredArea>`
      SELECT DISTINCT ON (area_key) id::text AS id, area_key, level_norm, level_raw, label_raw,
             lower(valid) AS lo, upper(valid) AS hi,
             seen_at IS NULL OR (seen_at, seen_batch) < (${fetchedAt}::timestamptz, ${batch}::bigint) AS newer,
             seen_batch IS NOT DISTINCT FROM ${batch}::bigint AS mine
      FROM warning_area WHERE source_id = ${source}
      ORDER BY area_key, lower(valid) DESC`.execute(tx);
    const newest = new Map(stored.map((s) => [s.area_key, s]));
    const stated = new Set<string>();
    for (const r of w.rows) {
      stated.add(r.area_key);
      const lo = new Date(r.valid_from);
      const hi = r.valid_to === null ? null : new Date(r.valid_to);
      const cur = newest.get(r.area_key);
      const active = cur !== undefined && (cur.hi === null || cur.hi > lo);
      if (cur?.mine) {
        if (sameArea(cur, r)) continue;
        await sql`UPDATE warning_area SET level_norm = ${r.level}, level_raw = ${r.level_raw},
                    label_raw = ${r.label_raw}, name = ${r.name}, geometry_geojson = ${r.geometry}
                  WHERE id = ${cur.id}::bigint`.execute(tx);
        note('corrected');
      } else if (cur !== undefined && !cur.newer) {
        note('older_ignored');
        continue;
      } else if (cur !== undefined && active && sameArea(cur, r)) {
        // A confirmation; a provider that states its own end (CH-5) may move it.
        await sql`UPDATE warning_area SET seen_at = ${fetchedAt}::timestamptz, seen_batch = ${batch}::bigint,
                    valid = CASE WHEN ${hi}::timestamptz IS NULL OR ${hi}::timestamptz > lower(valid)
                                 THEN tstzrange(lower(valid), ${hi}::timestamptz) ELSE valid END
                  WHERE id = ${cur.id}::bigint`.execute(tx);
      } else if (cur !== undefined && active) {
        if (lo <= cur.lo) {
          await sql`UPDATE warning_area SET level_norm = ${r.level}, level_raw = ${r.level_raw},
                      label_raw = ${r.label_raw}, name = ${r.name}, geometry_geojson = ${r.geometry},
                      batch_id = ${batch}::bigint, seen_at = ${fetchedAt}::timestamptz, seen_batch = ${batch}::bigint
                    WHERE id = ${cur.id}::bigint`.execute(tx);
        } else {
          await sql`UPDATE warning_area SET valid = tstzrange(lower(valid), ${lo}::timestamptz)
                    WHERE id = ${cur.id}::bigint`.execute(tx);
          if (hi === null || hi > lo) await insert(r, lo, hi);
        }
        note('changed');
      } else {
        const from = cur?.hi != null && cur.hi > lo ? cur.hi : lo;
        if (hi !== null && hi <= from) continue;
        await insert(r, from, hi);
        note('new');
      }
      writes += 1;
    }
    // An area the snapshot no longer lists ends at the snapshot's time.
    for (const cur of stored) {
      if (stated.has(cur.area_key) || !cur.newer) continue;
      if (cur.hi !== null && cur.hi <= at) continue;
      if (at <= cur.lo) continue;
      await sql`UPDATE warning_area SET valid = tstzrange(lower(valid), ${at}::timestamptz),
                  seen_at = ${fetchedAt}::timestamptz, seen_batch = ${batch}::bigint
                WHERE id = ${cur.id}::bigint`.execute(tx);
      note('removed');
      writes += 1;
    }
    return { changes, writes };
  }

  // Message mode (CAP): each message stands for itself, whatever order the archive replays them in.
  const sent = new Date(w.sent);
  const closes = (await readMeta<Closes>(tx, closesKey(source))) ?? {};
  if (w.cancels.length > 0) {
    let grew = false;
    for (const ref of w.cancels) {
      const prior = closes[ref];
      if (prior === undefined || new Date(prior) > sent) {
        closes[ref] = w.sent;
        grew = true;
      }
      const { rows: ended } = await sql`
        UPDATE warning_area SET valid = tstzrange(lower(valid), ${sent}::timestamptz)
        WHERE source_id = ${source} AND provider_ref = ${ref} AND lower(valid) < ${sent}::timestamptz
          AND (upper_inf(valid) OR upper(valid) > ${sent}::timestamptz)
        RETURNING id`.execute(tx);
      if (ended.length > 0) {
        note('removed');
        writes += 1;
      }
    }
    if (grew && Object.keys(closes).length <= CLOSES_MAX) await writeMeta(tx, closesKey(source), closes);
  }
  for (const r of w.rows) {
    const { rows: seen } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM warning_area
      WHERE source_id = ${source} AND area_key = ${r.area_key} AND provider_ref IS NOT DISTINCT FROM ${r.ref ?? null}
        AND lower(valid) = ${new Date(r.valid_from)}::timestamptz`.execute(tx);
    if ((seen[0]?.n ?? 0) > 0) continue; // a replay
    const lo = new Date(r.valid_from);
    let hi = r.valid_to === null ? null : new Date(r.valid_to);
    const { rows: next } = await sql<{ lo: Date | null; same: number }>`
      SELECT min(lower(valid)) FILTER (WHERE lower(valid) > ${lo}::timestamptz) AS lo,
             count(*) FILTER (WHERE lower(valid) = ${lo}::timestamptz)::int AS same
      FROM warning_area WHERE source_id = ${source} AND area_key = ${r.area_key}`.execute(tx);
    if ((next[0]?.same ?? 0) > 0) {
      note('older_ignored'); // another message for the area at the same instant: the first stored stays
      continue;
    }
    const after = next[0]?.lo ?? null;
    if (after !== null && (hi === null || after < hi)) hi = after;
    const closed = r.ref === undefined ? undefined : closes[r.ref];
    if (closed !== undefined && (hi === null || new Date(closed) < hi)) hi = new Date(closed);
    if (hi !== null && hi <= lo) continue;
    await sql`UPDATE warning_area SET valid = tstzrange(lower(valid), ${lo}::timestamptz)
              WHERE source_id = ${source} AND area_key = ${r.area_key} AND lower(valid) < ${lo}::timestamptz
                AND (upper_inf(valid) OR upper(valid) > ${lo}::timestamptz)`.execute(tx);
    await insert(r, lo, hi);
    note('new');
    writes += 1;
  }
  return { changes, writes };
}
