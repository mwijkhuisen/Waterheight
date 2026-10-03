import {
  type ClassRow,
  emptyNormalised,
  isFuture,
  levelOf,
  type Normalised,
  parseInstant,
  QC,
  type ReferenceRow,
  type Registry,
  rangeBit,
  SchemaDrift,
  type SeriesDecl,
  scale,
  type TimeConvention,
  TimeError,
  toIso,
} from '@rws/core';
import { columnsOf } from '../_shared/kiwis/parse.ts';
import type { LayerItem, Table, ValuesItem } from './parse.ts';

// BE-3 SPW KiWIS → canonical rows (catalogue §2.4, §4.2, §4.5, §4.8; owner audience). Declared here, never inferred
// per row:
//  - series: `<station_no>/<stationparameter_no>` (`8702/H`, `5451/QADM`), never a name: "HASTIERE" (8622) is on
//    the Hermeton and a "Hastière" elsewhere is another station; DCENN "Dinant" (L8470, Fonds de Leffe) is not DGH
//    "DINANT" (8059, Meuse). A key the registry does not know counts `unknown` once. Two `ts_id`s may share a key
//    (measured 2026-10-02: DCENN L5860 Theux has `Cmd.RunOff.Comp` and `Cmd.RunOff.Comp-Alarmes` in the discharge
//    group, stating the same values): their rows meet per instant, the same value once (`duplicate`), two values
//    withheld (`conflict`);
//  - time: ISO 8601 with its own offset or Z. The capture asks `timezone=UTC`, but a stamp may still carry
//    `+02:00` (a sample did): each is read with the offset it states;
//  - unit and factor from the series' registry row: H and H_sonde are metres relative to the gauge zero, Habs and
//    Habs_sonde metres DNG (= TAW), both ×100 to cm, Q and QADM m³/s. The payload's `ts_unitsymbol` must equal the
//    registry's native unit (`m3/s` and `cumec` mean `m³/s`), else every value of that series is withheld
//    (`unit_mismatch`, withheld and alerted), and so is a values item that states no unit (every call asks for it).
//    Nothing is listed in `unitMismatch`: the loader keeps one such list per source, and the layers and the
//    catch-up's calls state disjoint sets of series, so each payload would erase the others' entries; every item
//    carries its own unit;
//  - quality: a value layer states none, and live data is quality 200, "raw". A values row says it in its `Quality
//    Code` column (found by name): 200 → raw, 0…199 → validated, 205 and 210 "douteux" → raw + provider-suspect,
//    253 "valeurs fantômes" → dropped (`phantom`), -1 "missing" → dropped (`sentinel`), any other code is withheld
//    (`unknown_quality`, kept for a replay); no such column → raw;
//  - gaps: a null value or time is a gap; a discharge of exactly -1 is KiWIS' placeholder (`sentinel`), and QADM's
//    coverage always ends one step in the future with `[time, null, -1]` (dropped by its -1 code; a value that far
//    ahead is `future`). A value more than 120 days old belongs to a request we never make (`too_old`; the catch-up
//    reaches about two months back);
//  - a gauge zero: `station_gauge_datum` in m DNG (= TAW) for every registered stage series of the station. As
//    measured on the list of 2026-10-02 (501 stations): 254 state a value in DNG; SPW marks a zero it does not know
//    by `9999.0` or `0.0` (`zero_unknown`; no Walloon gauge lies at sea level) and one without a datum system by the
//    unit `---` or an empty one (`zero_datum_unknown`), all counted, none stored or alerted. The start of validity,
//    `station_gauge_datum_from`, is epoch milliseconds (negative before 1970; 0 means none); an ISO date or
//    date-time with an offset is read too (a date alone starts at local midnight of SPW's fixed UTC+01:00);
//  - references (P7a, `be-3-refs`): the weekly values of the percentile series `Cmd.POR.P05…P95`, `Med`, `Mean` (the
//    relative ones, to the gauge zero: statistical, kinds P05, P10, P15, MEDIAN, MOYEN, P85, P90, P95; SPW's P90 is
//    the level exceeded 10 % of the time, so the percentiles are `non_exceedance`, the mean has no convention) and
//    `Cmd.ReferenceFlood.Top3` (historical, TOP3_1…TOP3_3 by value, the event's day in station time as the label), on the series
//    `<station_no>/<stationparameter_no>`, in the registry's unit (m ×100 → cm, m³/s as is). A series' kinds are
//    spread over several payloads (100 ts_ids a call), so no payload states a series in full: no `refScope`, and a
//    kind SPW withdraws is not closed;
//  - NIVCRU (P7a): the `NIVCRU` attribute of a station (`t<n>/<state>`, empty = none) is a provider class of the
//    station, stored raw (≤ 40 characters, else `bad_value`), its meaning unknown (level null).

export const SOURCE = 'BE-3';
export const TIME: TimeConvention = { kind: 'iso-offset' };

/** The catch-up reaches back to the display start (2026-08-24); an older value is not one we asked for. */
const MAX_AGE_MS = 120 * 86_400_000;

/** A layer states no quality code, and live data is 200 "Unknown (raw)" (`getQualityCodes`). */
const LIVE = 200;

/** SPW's station time zone is a fixed UTC+01:00 all year (catalogue §2.4, "Time"). */
const STATION_OFFSET = '+01:00';

export type Context = {
  registry: Registry;
  /** When the payload was fetched (UTC ms): the reference for "future" and "too old". */
  fetchedAt: number;
};

// Maps, not objects: a provider string must not find an inherited property.
const UNIT_ALIAS: ReadonlyMap<string, string> = new Map([
  ['m3/s', 'm³/s'],
  ['cumec', 'm³/s'],
]);
const unitOf = (unit: string) => UNIT_ALIAS.get(unit) ?? unit;

function instant(raw: string | number): number {
  try {
    return parseInstant(TIME, raw);
  } catch (err) {
    if (err instanceof TimeError) throw new SchemaDrift(`time_${err.code}`);
    throw err;
  }
}

const count = (out: Normalised, code: string, n = 1) => {
  if (n > 0) out.dropped[code] = (out.dropped[code] ?? 0) + n;
};

type Quality = number | 'sentinel' | 'phantom' | 'unknown_quality';

function quality(code: unknown): Quality {
  if (typeof code !== 'number' || !Number.isInteger(code)) return 'unknown_quality';
  if (code === LIVE) return QC.RAW;
  if (code === 205 || code === 210) return QC.RAW | QC.PROVIDER_SUSPECT;
  if (code === 253) return 'phantom';
  if (code === -1) return 'sentinel';
  return code >= 0 && code < LIVE ? QC.VALIDATED : 'unknown_quality';
}

/** One value as an answer states it, before any rule. */
type Raw = { time: string | number | null; value: string | number | null; code: unknown };
/** One series of an answer: a layer item (one value) or a values item (its rows). */
type Item = { key: string; tsId: string; unit: string | undefined; rows: Raw[] };

const keyOf = (stationNo: string, parameter: string) => `${stationNo}/${parameter}`;

/** The rules of every value, shared by a layer and a values answer. */
function normaliseItems(items: readonly Item[], ctx: Context): Normalised {
  const out = emptyNormalised();
  const byKey = new Map<string, Item[]>();
  for (const item of items) {
    const group = byKey.get(item.key);
    if (group === undefined) byKey.set(item.key, [item]);
    else group.push(item);
  }
  // Per series, per instant: the row, or null once two rows disagree.
  const series = new Map<string, Map<number, { value: number; qc: number } | null>>();
  for (const [key, group] of byKey) {
    const decl = ctx.registry.get(key);
    if (decl === undefined) {
      out.unknown += 1;
      continue;
    }
    const n = group.reduce((sum, item) => sum + item.rows.length, 0);
    if (group.some((item) => item.unit === undefined || unitOf(item.unit) !== decl.native_unit)) {
      count(out, 'unit_mismatch', n);
      continue;
    }
    const kind = decl.quantity === 'Q' ? 'Q' : (decl.value_kind ?? 'stage');
    for (const r of group.flatMap((item) => item.rows)) {
      const q = quality(r.code);
      if (q === 'sentinel' || q === 'phantom') {
        count(out, q);
        continue;
      }
      if (r.time === null || r.value === null) {
        count(out, 'gap');
        continue;
      }
      if (q === 'unknown_quality') {
        count(out, q);
        continue;
      }
      if (typeof r.value !== 'number') throw new SchemaDrift('bad_value');
      if (decl.quantity === 'Q' && r.value === -1) {
        count(out, 'sentinel');
        continue;
      }
      const ts = instant(r.time);
      if (isFuture(ts, ctx.fetchedAt)) {
        count(out, 'future');
        continue;
      }
      if (ts < ctx.fetchedAt - MAX_AGE_MS) {
        count(out, 'too_old');
        continue;
      }
      const value = scale(decl.to_canonical, r.value);
      const qc = q | rangeBit(kind, value);
      let byTime = series.get(decl.key);
      if (byTime === undefined) {
        byTime = new Map();
        series.set(decl.key, byTime);
      }
      const before = byTime.get(ts);
      if (before === undefined) byTime.set(ts, { value, qc });
      else if (before === null) count(out, 'conflict');
      else if (before.value === value && before.qc === qc) count(out, 'duplicate');
      else {
        byTime.set(ts, null);
        count(out, 'conflict', 2);
      }
    }
  }
  for (const key of [...series.keys()].sort()) {
    const byTime = series.get(key) ?? new Map();
    for (const ts of [...byTime.keys()].sort((a, b) => a - b)) {
      const row = byTime.get(ts);
      if (row) out.obs.push({ series: key, ts: toIso(ts), value: row.value, qc: row.qc });
    }
  }
  return out;
}

/** `getTimeseriesValueLayer` (`be-3-values`): the latest value of every series of a group, quality 200. */
export function normaliseLayer(items: readonly LayerItem[], ctx: Context): Normalised {
  return normaliseItems(
    items.map((i) => ({
      key: keyOf(i.station_no, i.stationparameter_no),
      tsId: i.ts_id,
      unit: i.ts_unitsymbol,
      rows: [{ time: i.timestamp, value: i.ts_value, code: LIVE }],
    })),
    ctx,
  );
}

/** `getTimeseriesValues` (`be-3-catchup` stage 2): the rows of each series, columns found by name. */
export function normaliseValues(items: readonly ValuesItem[], ctx: Context): Normalised {
  return normaliseItems(
    items.map((i) => {
      if (i.station_no === undefined || i.stationparameter_no === undefined) throw new SchemaDrift('kiwis_no_metadata');
      const columns = columnsOf(i);
      const time = columns.get('Timestamp');
      const value = columns.get('Value');
      const code = columns.get('Quality Code');
      if (time === undefined || value === undefined) throw new SchemaDrift('kiwis_columns');
      return {
        key: keyOf(i.station_no, i.stationparameter_no),
        tsId: i.ts_id,
        unit: i.ts_unitsymbol,
        rows: i.data.map((row) => {
          if (row.length !== columns.size) throw new SchemaDrift('kiwis_row_width');
          return { time: row[time] ?? null, value: row[value] ?? null, code: code === undefined ? LIVE : row[code] };
        }),
      };
    }),
    ctx,
  );
}

/** The parameters whose value is relative to the gauge zero: only these have a zero to store. */
const STAGE_PARAMETERS = ['H', 'H_sonde'];
/** One anchored pattern for `station_gauge_datum` ("109.9", "88,25"): linear, no ReDoS. */
const ZERO = /^-?\d{1,4}(?:[.,]\d{1,4})?$/;
const ZERO_UNKNOWN_M = 9999;
const ZERO_MIN_M = -10;
const ZERO_MAX_M = 1000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REQUIRED = ['station_no', 'station_gauge_datum', 'station_gauge_datum_unit'];

const text = (cell: string | number | null | undefined) =>
  cell === null || cell === undefined ? '' : String(cell).trim();

/** Epoch milliseconds from 1900 to 2100 (SPW's `station_gauge_datum_from`). */
const EPOCH_MS = /^-?\d{1,13}$/;
const EPOCH_MIN = Date.UTC(1900, 0, 1);
const EPOCH_MAX = Date.UTC(2100, 0, 1);

/** `station_gauge_datum_from`: epoch milliseconds, or an ISO date or date-time with an offset, else none. */
function validFrom(cell: string | number | null | undefined): string | null {
  const raw = text(cell);
  if (EPOCH_MS.test(raw)) {
    const ms = Number(raw);
    return ms !== 0 && ms >= EPOCH_MIN && ms < EPOCH_MAX ? new Date(ms).toISOString() : null;
  }
  try {
    return toIso(parseInstant(TIME, DATE.test(raw) ? `${raw}T00:00:00${STATION_OFFSET}` : raw));
  } catch (err) {
    if (err instanceof TimeError) return null;
    throw err;
  }
}

/**
 * The daily `getStationList`: the published gauge zero of every registered stage series (H, H_sonde). Habs series
 * are absolute and need none. A station listed twice gives no zero (`conflict`); no value is ever inferred.
 */
export function normaliseStations(rows: Table, ctx: { registry: Registry; fetchedAt: number }): Normalised {
  const out = emptyNormalised();
  const first = rows[0];
  if (first !== undefined && !REQUIRED.every((c) => Object.hasOwn(first, c))) throw new SchemaDrift('kiwis_columns');
  const byStation = new Map<string, Table>();
  for (const row of rows) {
    const no = text(row.station_no);
    if (no === '') continue;
    const group = byStation.get(no);
    if (group === undefined) byStation.set(no, [row]);
    else group.push(row);
  }
  for (const no of [...byStation.keys()].sort()) {
    const decls = STAGE_PARAMETERS.map((p) => ctx.registry.get(keyOf(no, p))).filter(
      (d): d is SeriesDecl => d?.value_kind === 'stage',
    );
    const group = byStation.get(no) ?? [];
    const row = group[0];
    if (decls.length === 0 || row === undefined) continue;
    if (group.length > 1) {
      count(out, 'conflict');
      continue;
    }
    const raw = text(row.station_gauge_datum);
    const m = ZERO.test(raw) ? Number(raw.replace(',', '.')) : Number.NaN;
    const drop =
      raw === ''
        ? 'zero_missing'
        : Number.isNaN(m)
          ? 'bad_zero'
          : m === ZERO_UNKNOWN_M || m === 0
            ? 'zero_unknown'
            : ['', '---'].includes(text(row.station_gauge_datum_unit))
              ? 'zero_datum_unknown'
              : text(row.station_gauge_datum_unit) !== 'DNG'
                ? 'unknown_zero_unit'
                : m < ZERO_MIN_M || m > ZERO_MAX_M
                  ? 'bad_zero'
                  : null;
    if (drop !== null) {
      count(out, drop);
      continue;
    }
    const from = validFrom(row.station_gauge_datum_from);
    for (const decl of decls) out.gaugeZeros.push({ series: decl.key, value_m: m, datum: 'DNG', valid_from: from });
  }
  classesOf(rows, byStation, ctx, out);
  return out;
}

const NIVCRU_MAX = 40;

/** The NIVCRU class of every registered station that states one (the list has no timestamp: the fetch time). */
function classesOf(
  rows: Table,
  byStation: ReadonlyMap<string, Table>,
  ctx: { registry: Registry; fetchedAt: number },
  out: Normalised,
) {
  if (rows[0] === undefined || !Object.hasOwn(rows[0], 'NIVCRU')) return;
  const stationOf = new Map<string, string>();
  for (const [key, decl] of ctx.registry) {
    if (decl.station !== undefined) stationOf.set(key.split('/')[0] as string, decl.station);
  }
  const ts = toIso(ctx.fetchedAt);
  const classes: ClassRow[] = [];
  out.classes = classes;
  for (const no of [...byStation.keys()].sort()) {
    const group = byStation.get(no) ?? [];
    const station = stationOf.get(no);
    const code = text(group[0]?.NIVCRU);
    // A station listed twice has no single class (the zero path counted the conflict).
    if (station === undefined || group.length !== 1 || code === '') continue;
    if (code.length > NIVCRU_MAX || /[\p{Cc}\p{Cf}]/u.test(code)) {
      count(out, 'bad_value');
      continue;
    }
    const level = levelOf(SOURCE, 'nivcru', code);
    if (level === undefined) count(out, 'unmapped_class');
    else classes.push({ station, ts, code, label: null, level });
  }
}

/** The `Cmd.*` shortnames of `be-3-refs` → the reference kind, its semantics and its convention. */
const PERCENTILES: ReadonlyMap<string, { kind: string; convention: 'non_exceedance' | null }> = new Map([
  ['Cmd.POR.P05', { kind: 'P05', convention: 'non_exceedance' }],
  ['Cmd.POR.P10', { kind: 'P10', convention: 'non_exceedance' }],
  ['Cmd.POR.P15', { kind: 'P15', convention: 'non_exceedance' }],
  ['Cmd.POR.Med', { kind: 'MEDIAN', convention: 'non_exceedance' }],
  ['Cmd.POR.Mean', { kind: 'MOYEN', convention: null }],
  ['Cmd.POR.P85', { kind: 'P85', convention: 'non_exceedance' }],
  ['Cmd.POR.P90', { kind: 'P90', convention: 'non_exceedance' }],
  ['Cmd.POR.P95', { kind: 'P95', convention: 'non_exceedance' }],
]);
const TOP3 = 'Cmd.ReferenceFlood.Top3';
/**
 * The calendar day of an instant in SPW's station time (STATION_OFFSET, a fixed UTC+01:00): the period of record
 * starts at local midnight (1999-01-01T00:00+01:00 is 1998-12-31T23:00Z), so its UTC day would be the day before
 * (review CR-10); an event's day is read the same way.
 */
const day = (ts: number) => toIso(ts + 3_600_000).slice(0, 10);

/**
 * `getTimeseriesValues` of `be-3-refs` stage 2: the percentile values and the reference floods as references of the
 * registered series. The series is named by the item's metadata (station, parameter, shortname, unit), never by its
 * position; a registered key, a known shortname and the registry's unit are required, else the item is counted.
 */
export function normaliseReferences(items: readonly ValuesItem[], ctx: Context): Normalised {
  const out = emptyNormalised();
  const refs: ReferenceRow[] = [];
  out.references = refs;
  for (const item of items) {
    const { station_no: no, stationparameter_no: parameter, ts_shortname: shortname } = item;
    if (no === undefined || parameter === undefined || shortname === undefined)
      throw new SchemaDrift('kiwis_no_metadata');
    const decl = ctx.registry.get(keyOf(no, parameter));
    if (decl === undefined) {
      out.unknown += 1;
      continue;
    }
    const percentile = PERCENTILES.get(shortname);
    if (percentile === undefined && shortname !== TOP3) {
      count(out, 'unknown_shortname');
      continue;
    }
    if (item.ts_unitsymbol === undefined || unitOf(item.ts_unitsymbol) !== decl.native_unit) {
      count(out, 'unit_mismatch', item.data.length);
      continue;
    }
    const columns = columnsOf(item);
    const time = columns.get('Timestamp');
    const value = columns.get('Value');
    if (time === undefined || value === undefined) throw new SchemaDrift('kiwis_columns');
    const points: { ts: number; value: number }[] = [];
    for (const row of item.data) {
      if (row.length !== columns.size) throw new SchemaDrift('kiwis_row_width');
      const [t, v] = [row[time] ?? null, row[value] ?? null];
      if (t === null || v === null) {
        count(out, 'gap');
        continue;
      }
      if (typeof v !== 'number') throw new SchemaDrift('bad_value');
      const ts = instant(t);
      if (isFuture(ts, ctx.fetchedAt)) count(out, 'future');
      else points.push({ ts, value: scale(decl.to_canonical, v) });
    }
    const unit = decl.quantity === 'H' ? 'cm' : 'm³/s';
    const base = {
      series: decl.key,
      unit,
      season_from_md: 101,
      season_to_md: 1231,
      priority: 0,
      valid_from: null,
    } as const;
    if (percentile !== undefined) {
      // One value for the period of record; if an answer ever holds more, the newest stands.
      points.sort((a, b) => a.ts - b.ts);
      const last = points.pop();
      count(out, 'superseded', points.length);
      if (last !== undefined)
        refs.push({
          ...base,
          kind: percentile.kind,
          value: last.value,
          semantics: 'statistical',
          convention: percentile.convention,
          period: [day(last.ts), null],
          basis_label: 'SPW',
        });
    } else {
      points.sort((a, b) => b.value - a.value || a.ts - b.ts);
      count(out, 'extra_flood', Math.max(0, points.length - 3));
      for (const [i, p] of points.slice(0, 3).entries())
        refs.push({
          ...base,
          kind: `TOP3_${i + 1}`,
          value: p.value,
          semantics: 'historical',
          convention: null,
          period: null,
          basis_label: day(p.ts),
        });
    }
  }
  return out;
}
