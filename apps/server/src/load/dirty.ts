import { createHash } from 'node:crypto';
import { type RawBuilder, sql } from 'kysely';
import { CHANNEL_AUDIENCES, type ChannelAudience, VIEWS } from '../db/audience.ts';
import { readMeta, type Tx, writeMeta } from './store.ts';

// P9a: what the publishers must render again (A§9.1 "Cache versioning"). The loader's writers note what they
// changed (`Touch`); the pipeline turns the notes into entries (each series' station and effective audience) and,
// once per transaction and under the loader lock, `markDirty` writes one publish_dirty row per (family, kind) and
// bumps the version of every UTC day that a revision reaches and that may already be rendered as settled. The
// publishers only read both (invariant 2). Rows commit in id order, because every writer holds the lock.

/** The first UTC month that may hold data (migrate's partition floor): an open-ended range starts here. */
export const DATA_FLOOR = '2026-08-01T00:00:00Z';
const FLOOR_MS = Date.parse(DATA_FLOOR);
/**
 * A revision of a day that began more than this before now bumps the day: a superset of "settled" (the day ended
 * 48 hours ago), so the race between a day settling and a revision always bumps (an extra bump is harmless).
 */
export const BUMP_AGE_MS = 48 * 3_600_000;
const DAY_MS = 86_400_000;

export const DIRTY_KINDS = ['obs', 'forecast', 'reference', 'class', 'warning', 'gauge_zero'] as const;
export type DirtyKind = (typeof DIRTY_KINDS)[number];
export type Audience = ChannelAudience | 'off';

/** A writer's note: a series or a station changed from `from` on (null: since ever) to `to` (default: now). */
export type Touch = { series?: number; station?: string; from: number | null; to?: number };
export type DirtyEntry = { kind: DirtyKind; audience: Audience; from: number; to: number; stations: readonly string[] };

/** Why a day's version moved: the loader's revision, a registry change, or a narrowing (old versions go at once). */
export type BumpReason = 'revision' | 'registry' | 'narrowed';
export type DayVersion = { v: number; reason: BumpReason; at: string };
export const versionKey = (family: ChannelAudience) => `day_versions:${family}`;

const RANK: Record<Audience, number> = { off: 0, owner: 1, public: 2 };
/** A series may narrow its source's audience, never widen it: public > owner > off. */
export const narrow = (a: Audience, b: Audience): Audience => (RANK[a] <= RANK[b] ? a : b);

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Raises the version of each day by one (an absent day is version 1), in the caller's transaction. */
export async function bumpDays(
  tx: Tx,
  family: ChannelAudience,
  days: Iterable<string>,
  reason: BumpReason,
  now: Date,
): Promise<void> {
  const list = [...new Set(days)];
  if (list.length === 0) return;
  const map = (await readMeta<Record<string, DayVersion>>(tx, versionKey(family))) ?? {};
  for (const d of list) map[d] = { v: (map[d]?.v ?? 1) + 1, reason, at: now.toISOString() };
  await writeMeta(tx, versionKey(family), map);
}

/** The UTC days of [from, to] that began before now − BUMP_AGE_MS. */
export function bumpedDays(from: number, to: number, nowMs: number): string[] {
  const days: string[] = [];
  for (let d = Math.floor(from / DAY_MS) * DAY_MS; d <= to && d < nowMs - BUMP_AGE_MS; d += DAY_MS) days.push(dayOf(d));
  return days;
}

/**
 * Writes the transaction's dirty rows and bumps. A public change dirties both families (the owner family sees public
 * rows); an owner change only the owner family; an `off` one nothing. Ranges are clipped to [DATA_FLOOR, now].
 * Forecast entries name stations only and never bump a day.
 */
export async function markDirty(tx: Tx, now: Date, entries: readonly DirtyEntry[]): Promise<void> {
  const nowMs = now.getTime();
  type Group = { family: ChannelAudience; kind: DirtyKind; from: number; to: number; stations: Set<string> };
  const groups = new Map<string, Group>();
  for (const e of entries) {
    if (e.audience === 'off') continue;
    const from = Math.max(e.from, FLOOR_MS);
    const to = Math.max(from, Math.min(e.to, nowMs));
    for (const family of e.audience === 'public' ? (['public', 'owner'] as const) : (['owner'] as const)) {
      const g = groups.get(`${family}|${e.kind}`);
      if (g === undefined) {
        groups.set(`${family}|${e.kind}`, { family, kind: e.kind, from, to, stations: new Set(e.stations) });
      } else {
        g.from = Math.min(g.from, from);
        g.to = Math.max(g.to, to);
        for (const s of e.stations) g.stations.add(s);
      }
    }
  }
  const bumps = new Map<ChannelAudience, Set<string>>();
  for (const g of groups.values()) {
    await sql`
      INSERT INTO publish_dirty (family, kind, from_ts, to_ts, stations)
      VALUES (${g.family}, ${g.kind}, ${new Date(g.from)}, ${new Date(g.to)}, ${[...g.stations].sort()}::text[])`.execute(
      tx,
    );
    if (g.kind === 'forecast') continue;
    const days = bumps.get(g.family) ?? new Set<string>();
    for (const d of bumpedDays(g.from, g.to, nowMs)) days.add(d);
    bumps.set(g.family, days);
  }
  for (const [family, days] of bumps) await bumpDays(tx, family, days, 'revision', now);
}

/**
 * What a settled file depends on besides loaded rows (§9 C10), per family: each visible series' staleness (seconds)
 * and effective history_export, and digests of the NL-4 class bounds and the family's attribution rows.
 */
export type Visible = { series: Record<string, [number, boolean]>; nl4: string; attribution: string };
export const visibleKey = (family: ChannelAudience) => `registry_visible:${family}`;

async function digest(tx: Tx, query: RawBuilder<unknown>): Promise<string> {
  const { rows } = await query.execute(tx);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16);
}

/** A series gone or its history_export off narrows; a staleness, a widening or a digest change is 'registry'. */
export function visibilityChange(old: Visible, cur: Visible): BumpReason | undefined {
  let reason: BumpReason | undefined;
  for (const [id, [stale, history]] of Object.entries(old.series)) {
    const now = cur.series[id];
    if (now === undefined || (history && !now[1])) return 'narrowed';
    if (now[0] !== stale || now[1] !== history) reason = 'registry';
  }
  return reason ?? (old.nl4 !== cur.nl4 || old.attribution !== cur.attribution ? 'registry' : undefined);
}

/**
 * migrate's registry bump (§9 C10), under the loader lock after the registry sync: compares each family's visible
 * registry with the stored one and bumps every day from display_start to today − 2 on a change. Pure additions bump
 * nothing (replayed data bumps through markDirty); the first run only stores the map.
 */
export async function registryBump(tx: Tx, now: Date): Promise<Partial<Record<ChannelAudience, BumpReason>>> {
  const nl4 = await digest(
    tx,
    sql`
      SELECT series_id, kind, value, unit, semantics, season_from_md, season_to_md, priority, basis_label,
             lower(valid) AS valid_from
      FROM reference_value WHERE source_id = 'NL-4'
      ORDER BY series_id, kind, season_from_md, season_to_md, priority, value, basis_label`,
  );
  const start = Date.parse((await readMeta<string>(tx, 'display_start')) ?? DATA_FLOOR);
  const bumped: Partial<Record<ChannelAudience, BumpReason>> = {};
  for (const family of CHANNEL_AUDIENCES) {
    const v = VIEWS[family];
    const { rows } = await sql<{ id: number; staleness_s: number; lic_history_export: boolean }>`
      SELECT id, EXTRACT(EPOCH FROM staleness_limit)::double precision AS staleness_s, lic_history_export
      FROM ${sql.table(v.series)}`.execute(tx);
    const cur: Visible = {
      series: Object.fromEntries(rows.map((r) => [String(r.id), [r.staleness_s, r.lic_history_export]])),
      nl4,
      attribution: await digest(
        tx,
        sql`
          SELECT source_id, ord, lang, text, url, needs_date, date_kind, logo_allowed, required
          FROM ${sql.table(v.attribution)} ORDER BY source_id, ord`,
      ),
    };
    const old = await readMeta<Visible>(tx, visibleKey(family));
    const reason = old === undefined ? undefined : visibilityChange(old, cur);
    if (reason !== undefined) {
      await bumpDays(tx, family, bumpedDays(start, now.getTime(), now.getTime()), reason, now);
      bumped[family] = reason;
    }
    await writeMeta(tx, visibleKey(family), cur);
  }
  return bumped;
}
