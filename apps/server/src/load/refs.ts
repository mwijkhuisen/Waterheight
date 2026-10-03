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
  // In place: `batch_id` stays the range's opener (its provenance and the pruner's forever promotion; review CR-2),
  // and a range this payload had closed (no longer stated) re-opens when it states the key again.
  const rewrite = (r: ResolvedRef, lo: Date | null) =>
    sql`UPDATE reference_value SET value = ${r.value}, unit = ${r.unit}, semantics = ${r.semantics},
          percentile_convention = ${r.convention}, period = ${periodText(r.period)}::daterange,
          basis_label = ${r.basis_label}, valid = tstzrange(lower(valid), NULL), seen_at = ${fetchedAt}::timestamptz,
          seen_batch = ${batch}::bigint
        WHERE ${where(r, lo)}`.execute(tx);

  for (const r of wanted.values()) {
    const cur = newest.get(keyOf(r.id, r));
    if (cur === undefined) {
      await insert(r, r.valid_from);
      note('new', r.counted);
    } else if (cur.mine) {
      // This payload is the key's newest statement: its replay after a parser fix corrects the range in place.
      if (sameRef(cur, r) && cur.hi === null) continue;
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
    // The newest statement's own replay closes too: a key it no longer states after a parser fix.
    if (!scope.has(cur.series_id) || cur.hi !== null || !(cur.newer || cur.mine)) continue;
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
 * and source at or before its instant says something else. At the same instant newest fetch wins (review CR-1): a
 * class stated by a newer payload than the one that holds the row replaces it in place (`changed`), the same class
 * makes that payload the holder (`batch_id`), and an older payload changes nothing, so the rows do not depend on
 * the order the payloads load in; a replay by the holder corrects it in place. Returns the rows written, split into
 * the first class of a station (`new`) and a change of it (`changed`), the rows of stations that take classes
 * (`kept`), plus the stations the registry does not have.
 */
export async function applyClasses(
  tx: Tx,
  source: string,
  rows: readonly ClassRow[],
  batch: string,
  fetchedAt: Date,
): Promise<{ new: number; changed: number; unknown: number; kept: number; writes: number }> {
  if (rows.length === 0) return { new: 0, changed: 0, unknown: 0, kept: 0, writes: 0 };
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
  if (kept.length === 0) return { new: 0, changed: 0, unknown, kept: 0, writes: 0 };
  // `wins`: this payload is the holder's own replay or newer than it, by (fetched_at, batch id) as for observations.
  const { rows: written } = await sql<{ kind: 'new' | 'changed' | 'held' }>`
    WITH v AS (
      SELECT * FROM unnest(${kept.map((r) => r.station)}::text[], ${kept.map((r) => r.ts)}::timestamptz[],
                           ${kept.map((r) => r.code)}::text[], ${kept.map((r) => r.label)}::text[],
                           ${kept.map((r) => r.level)}::int2[]) AS v(station, ts, code, label, level)
    ), prev AS (
      SELECT v.*, p.ts AS pts, p.batch_id AS pb,
             (p.provider_code, p.provider_label, p.level_norm) IS DISTINCT FROM (v.code, v.label, v.level) AS differs,
             p.batch_id = ${batch}::bigint OR b.id IS NULL
               OR (b.fetched_at, b.id) < (${fetchedAt}::timestamptz, ${batch}::bigint) AS wins
      FROM v LEFT JOIN LATERAL (
        SELECT c.provider_code, c.provider_label, c.level_norm, c.ts, c.batch_id FROM class_obs c
        WHERE c.subject_type = 'station' AND c.subject_id = v.station AND c.source_id = ${source} AND c.ts <= v.ts
        ORDER BY c.ts DESC LIMIT 1) p ON true
      LEFT JOIN ingest_batch b ON b.id = p.batch_id
    ), ins AS (
      INSERT INTO class_obs (subject_type, subject_id, ts, source_id, provider_code, provider_label, level_norm, batch_id)
      SELECT 'station', station, ts, ${source}, code, label, level, ${batch}::bigint FROM prev
      WHERE (pts IS NULL OR pts < ts) AND differs
      RETURNING subject_id, ts
    ), upd AS (
      UPDATE class_obs c SET provider_code = p.code, provider_label = p.label, level_norm = p.level,
                             batch_id = ${batch}::bigint
      FROM prev p
      WHERE c.subject_type = 'station' AND c.subject_id = p.station AND c.source_id = ${source} AND c.ts = p.ts
        AND p.pts = p.ts AND p.wins AND (p.differs OR p.pb IS DISTINCT FROM ${batch}::bigint)
      RETURNING p.differs
    )
    SELECT CASE WHEN prev.pts IS NULL THEN 'new' ELSE 'changed' END AS kind
    FROM ins JOIN prev ON prev.station = ins.subject_id AND prev.ts = ins.ts
    UNION ALL SELECT CASE WHEN differs THEN 'changed' ELSE 'held' END FROM upd`.execute(tx);
  const n = (k: string) => written.filter((w) => w.kind === k).length;
  return { new: n('new'), changed: n('changed'), unknown, kept: kept.length, writes: written.length };
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

/** The level is the warning's state: a change opens a range. Name, geometry and texts are presentation. */
const sameArea = (s: StoredArea, w: WarningRow) =>
  s.level_norm === w.level && s.level_raw === w.level_raw && s.label_raw === w.label_raw;

/** The key of the app_meta map of message identifiers that a later message closed (an Update or a Cancel). */
export const closesKey = (source: string) => `cap_closes:${source}`;
/** The map holds only the referenced identifiers of one source's flood messages: a few per event. */
const CLOSES_MAX = 2000;
/** An identifier longer than a stored `provider_ref` can name no stored message. */
const REF_MAX = 200;
/**
 * A closing sent more than this before or after the message being loaded is forgotten (review SR-4): a Cancel or
 * an Update names messages of the same event, hours or days before it, so whichever order the archive loads them
 * in (the tail oldest first, the seed newest first), the closing is still held when its target arrives.
 */
const CLOSES_KEEP_MS = 60 * 86_400_000;

/**
 * Stores a payload's warnings (snapshot or message mode, core `Warnings`). `full`: the map of held closings is at
 * its cap, so this payload's new ones were not kept (alert `cap_closes_full`).
 */
export async function applyWarnings(
  tx: Tx,
  source: string,
  w: Warnings | undefined,
  batch: string,
  fetchedAt: Date,
): Promise<{ changes: Changes; writes: number; full: boolean }> {
  const changes: Changes = {};
  let writes = 0;
  if (w === undefined) return { changes, writes, full: false };
  const note = (c: RefChange) => {
    changes[c] = (changes[c] ?? 0) + 1;
  };
  const textsOf = (r: WarningRow) => (r.texts === undefined ? null : JSON.stringify(r.texts));
  const insert = (r: WarningRow, lo: Date | string, hi: Date | string | null) =>
    sql`INSERT INTO warning_area (source_id, area_key, name, geometry_geojson, level_norm, level_raw, label_raw,
          valid, issued_at, batch_id, provider_ref, texts, seen_at, seen_batch)
        VALUES (${source}, ${r.area_key}, ${r.name}, ${r.geometry}, ${r.level}, ${r.level_raw}, ${r.label_raw},
          tstzrange(${new Date(lo)}::timestamptz, ${hi === null ? null : new Date(hi)}::timestamptz),
          ${r.issued_at === null ? null : new Date(r.issued_at)}::timestamptz, ${batch}::bigint, ${r.ref ?? null},
          ${textsOf(r)}::jsonb, ${fetchedAt}::timestamptz, ${batch}::bigint)`.execute(tx);
  // Presentation follows the newest statement in place (review CR-4); an unchanged geometry or text keeps its
  // stored value, so a confirmation rewrites no large field.
  const present = (r: WarningRow) =>
    sql`name = ${r.name},
        geometry_geojson = CASE WHEN geometry_geojson IS DISTINCT FROM ${r.geometry}::text THEN ${r.geometry}::text
                                ELSE geometry_geojson END,
        texts = CASE WHEN texts IS DISTINCT FROM ${textsOf(r)}::jsonb THEN ${textsOf(r)}::jsonb ELSE texts END`;

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
    // An area the payload lists but whose row the adapter withheld stays as stored, open or not (review CR-5).
    const stated = new Set<string>(w.kept ?? []);
    for (const r of w.rows) {
      stated.add(r.area_key);
      const lo = new Date(r.valid_from);
      const hi = r.valid_to === null ? null : new Date(r.valid_to);
      const cur = newest.get(r.area_key);
      if (cur?.mine) {
        // This payload is the area's newest statement: its replay after a parser fix corrects the row in place.
        const { rows: fixed } = await sql`
          UPDATE warning_area SET level_norm = ${r.level}, level_raw = ${r.level_raw}, label_raw = ${r.label_raw},
            ${present(r)}
          WHERE id = ${cur.id}::bigint
            AND (level_norm, level_raw, label_raw, name, geometry_geojson, texts) IS DISTINCT FROM
                (${r.level}::int2, ${r.level_raw}::text, ${r.label_raw}::text, ${r.name}::text, ${r.geometry}::text,
                 ${textsOf(r)}::jsonb)
          RETURNING id`.execute(tx);
        if (fixed.length === 0) continue;
        note('corrected');
      } else if (cur !== undefined && !cur.newer) {
        note('older_ignored');
        continue;
      } else if (cur === undefined || (cur.hi !== null && cur.hi <= lo)) {
        // A first statement, or the stored range ended (no longer listed, or the provider's end) before this starts.
        if (hi !== null && hi <= lo) continue;
        await insert(r, lo, hi);
        note('new');
      } else if (sameArea(cur, r)) {
        // A confirmation: presentation follows it, and a provider that states its own end (CH-5) may move it.
        await sql`UPDATE warning_area SET seen_at = ${fetchedAt}::timestamptz, seen_batch = ${batch}::bigint,
                    ${present(r)},
                    valid = CASE WHEN ${hi}::timestamptz IS NULL OR ${hi}::timestamptz > lower(valid)
                                 THEN tstzrange(lower(valid), ${hi}::timestamptz) ELSE valid END
                  WHERE id = ${cur.id}::bigint`.execute(tx);
      } else {
        // A level change, from the provider's own later start, else from the payload's time: CH-5 keeps a bulletin's
        // `valid_from` while its level changes, and the earlier level is history (review CR-3).
        const start = lo > cur.lo ? lo : at;
        if (start <= cur.lo) {
          // No time to close: the newer payload's level wins in place; `batch_id` stays the opener.
          await sql`UPDATE warning_area SET level_norm = ${r.level}, level_raw = ${r.level_raw},
                      label_raw = ${r.label_raw}, ${present(r)},
                      seen_at = ${fetchedAt}::timestamptz, seen_batch = ${batch}::bigint
                    WHERE id = ${cur.id}::bigint`.execute(tx);
        } else {
          const closes = cur.hi === null || cur.hi > start;
          const opens = hi === null || hi > start;
          if (!closes && !opens) continue;
          if (closes) {
            await sql`UPDATE warning_area SET valid = tstzrange(lower(valid), ${start}::timestamptz),
                        seen_at = ${fetchedAt}::timestamptz, seen_batch = ${batch}::bigint
                      WHERE id = ${cur.id}::bigint`.execute(tx);
          }
          if (opens) await insert(r, start, hi);
        }
        note('changed');
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
    return { changes, writes, full: false };
  }

  // Message mode (CAP): each message stands for itself, whatever order the archive replays them in.
  const sent = new Date(w.sent);
  // A Map, not an object: an identifier such as `__proto__` is a key like any other (review SR-4).
  const closes = new Map(Object.entries((await readMeta<Record<string, string>>(tx, closesKey(source))) ?? {}));
  let full = false;
  if (w.cancels.length > 0) {
    let grew = false;
    for (const ref of w.cancels) {
      if (ref.length > REF_MAX) continue;
      const prior = closes.get(ref);
      if (prior === undefined || new Date(prior) > sent) {
        closes.set(ref, w.sent);
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
    if (grew) {
      for (const [ref, at] of closes)
        if (Math.abs(Date.parse(at) - sent.getTime()) > CLOSES_KEEP_MS) closes.delete(ref);
      if (closes.size <= CLOSES_MAX) await writeMeta(tx, closesKey(source), Object.fromEntries(closes));
      else full = true;
    }
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
    const closed = r.ref === undefined ? undefined : closes.get(r.ref);
    if (closed !== undefined && (hi === null || new Date(closed) < hi)) hi = new Date(closed);
    if (hi !== null && hi <= lo) continue;
    await sql`UPDATE warning_area SET valid = tstzrange(lower(valid), ${lo}::timestamptz)
              WHERE source_id = ${source} AND area_key = ${r.area_key} AND lower(valid) < ${lo}::timestamptz
                AND (upper_inf(valid) OR upper(valid) > ${lo}::timestamptz)`.execute(tx);
    await insert(r, lo, hi);
    note('new');
    writes += 1;
  }
  return { changes, writes, full };
}
