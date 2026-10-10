import type { State, StationRecent } from '@rws/contracts';
import { inSeason, monthDay } from '@rws/core/season';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { LADDER, STATE_COLOUR } from '../legend/palette.ts';
// The generated file only (it has no imports): pages/parts/method.ts would pull station/state.ts into a cycle.
import { METHOD_CLASSES, METHOD_REFERENCES } from '../pages/method.gen.ts';
import { formatNumber } from './value.ts';

// The thresholds of one series (P10d, closes #88): the lines, the zones between them and the legend rows. A reference
// is a line; where the registry gives it a role (METHOD_REFERENCES: `<=`/`<` low, `>=` elevated, high or extreme) it
// also opens a zone, and an NL-4 class is a zone between its From and To bounds. A reference with no role is a line
// only. A seasonal reference counts only when its season holds at t (#99); the others are left out. Values arrive in
// canonical units; `conv` brings one to the native unit. Nothing here draws.

type Ref = StationRecent['series'][number]['references'][number];

export interface Zone {
  /** null: open at the bottom (from the axis floor) or at the top (to the axis ceiling). */
  from: number | null;
  to: number | null;
  level: State;
  colour: string;
}

/** One row of the Grenswaarden legend: a zone (swatch) or a line (dash). `name` is our text, `raw` the provider's. */
export interface LegendItem {
  kind: 'zone' | 'line';
  colour?: string;
  name: string;
  /** The value or range with the unit and its zero: "≥ 520 cm NAP", "720–1170 cm NAP". */
  range: string;
  raw?: string;
  /** The reference is an owner source's: the row carries the owner badge, as the chart line does (P10a T12). */
  owner?: true;
}

export interface Marks {
  lines: { value: number; text: string }[];
  zones: Zone[];
  items: LegendItem[];
  /** An NL-4 row is present: the legend adds "RWS Waterinfo legend, not an official warning" (C39). */
  hasNl4: boolean;
}

export interface MarkOptions {
  quantity: 'H' | 'Q';
  conv: (v: number) => number;
  /** Our text for a reference kind, or undefined. */
  ours: (r: Ref) => string | undefined;
  /** Our text for an NL-4 class stem, or undefined. */
  stem: (stem: string) => string | undefined;
  owner: (source: string) => boolean;
  locale: Locale;
  /** The series' unit with its zero ("cm NAP"). */
  unit: string;
  /** The selected time (epoch ms): it picks the season of a seasonal reference, in Europe/Amsterdam. */
  t: number;
}

/** The reference's quantity unit in canonical terms: cm for a stage or level, m³/s for a discharge; else not shown. */
const canonicalUnit = (unit: string, quantity: 'H' | 'Q'): boolean =>
  quantity === 'H' ? unit === 'cm' : /^m(3|³)\/s$/.test(unit);

/** FR-5 `CRUE_<hash>` is one kind (as crosswalk.ts and labels.ts read it). */
const roleKind = (r: Pick<Ref, 'source' | 'kind'>) =>
  r.source === 'FR-5' && r.kind.startsWith('CRUE_') ? 'CRUE' : r.kind;

const ROLES = new Map(METHOD_REFERENCES.map((r) => [`${r.source}\n${r.kind}`, r]));
const NL4_LEVEL = new Map(METHOD_CLASSES.filter((c) => c.source === 'NL-4').map((c) => [c.code, c.level]));

/** The NL-4 stem of a workbook label: cut at the first `(` (no regex: labels run to 700 characters). */
const stemOf = (label: string) => {
  const i = label.indexOf('(');
  return (i < 0 ? label : label.slice(0, i)).trim();
};

const rank = (level: State) => LADDER.indexOf(level);
const colourOf = (level: State) => STATE_COLOUR[level];

/** A range as text: open ends become "<", "≤" or "≥" and two ends "a–b", always with the unit. */
function rangeText(z: { from: number | null; to: number | null; strict?: boolean }, o: MarkOptions): string {
  const f = (v: number) => formatNumber(v, o.locale);
  const { unit, locale } = o;
  if (z.from !== null && z.to !== null) return m.threshold_between({ from: f(z.from), to: f(z.to), unit }, { locale });
  if (z.from !== null) return m.threshold_at_least({ value: f(z.from), unit }, { locale });
  const to = f(z.to as number);
  return z.strict
    ? m.threshold_below({ value: to, unit }, { locale })
    : m.threshold_at_most({ value: to, unit }, { locale });
}

interface Pending {
  zone: Zone;
  /** The lowest bound, for ordering. */
  key: number;
  strict: boolean;
  names: string[];
  raws: string[];
  owner: boolean;
}

export function referenceMarks(refs: readonly Ref[], o: MarkOptions): Marks {
  const { locale } = o;
  const md = monthDay(o.t);
  const usable = refs
    .filter(
      (r) => canonicalUnit(r.unit, o.quantity) && (r.season === undefined || inSeason(md, r.season.from, r.season.to)),
    )
    .map((r) => ({ r, v: o.conv(r.value) }));
  const lines = usable.map(({ r, v }) => ({
    value: v,
    text:
      m.chart_reference({ label: r.label ?? r.kind, kind: o.ours(r) ?? r.kind }, { locale }) +
      (o.owner(r.source) ? ` · ${m.owner_badge({}, { locale })}` : ''),
  }));

  const pending: Pending[] = [];
  /** The references that already have a zone: they get no line row of their own. */
  const zoned = new Set<Ref>();
  // An NL-4 class without our text is named by its stem; the full workbook label (up to 700 characters) stays raw.
  const stemName = (label: string, kind: string) => {
    const stem = stemOf(label);
    return o.stem(stem) ?? (stem === '' ? kind : stem);
  };
  const nameOf = (r: Ref) =>
    o.ours(r) ?? (r.label !== null && r.source === 'NL-4' ? stemName(r.label, r.kind) : (r.label ?? r.kind));
  const rawOf = (r: Ref, name: string) => (r.label !== null && r.label !== name ? r.label : undefined);

  // Zones from roles, one source at a time.
  const roleRefs = usable.flatMap(({ r, v }) => {
    const role = r.source === 'NL-4' ? undefined : ROLES.get(`${r.source}\n${roleKind(r)}`);
    return role?.op != null && role.level != null && rank(role.level) > 0
      ? [{ r, v, op: role.op, level: role.level }]
      : [];
  });
  const merged = new Map<string, Pending>();
  for (const x of roleRefs) {
    let from: number | null = null;
    let to: number | null = null;
    if (x.op === '>=') {
      from = x.v;
      const higher = roleRefs
        .filter((y) => y.r.source === x.r.source && y.op === '>=' && rank(y.level) > rank(x.level) && y.v > x.v)
        .map((y) => y.v);
      to = higher.length === 0 ? null : Math.min(...higher);
    } else {
      to = x.v;
    }
    const name = nameOf(x.r);
    const key = `${x.r.source}\n${x.level}`;
    const prev = merged.get(key);
    const raw = rawOf(x.r, name);
    if (prev === undefined) {
      merged.set(key, {
        zone: { from, to, level: x.level, colour: colourOf(x.level) },
        key: from ?? Number.NEGATIVE_INFINITY,
        strict: x.op === '<',
        names: [name],
        raws: raw === undefined ? [] : [raw],
        owner: o.owner(x.r.source),
      });
    } else {
      prev.zone.from = prev.zone.from === null || from === null ? null : Math.min(prev.zone.from, from);
      prev.zone.to = prev.zone.to === null || to === null ? null : Math.max(prev.zone.to, to);
      prev.key = prev.zone.from ?? Number.NEGATIVE_INFINITY;
      if (!prev.names.includes(name)) prev.names.push(name);
      if (raw !== undefined && !prev.raws.includes(raw)) prev.raws.push(raw);
    }
    zoned.add(x.r);
  }
  pending.push(...merged.values());

  // NL-4 classes: the From and To rows of one priority are one class, unless it still has several bounds (a file
  // without seasons, or two seasons that share an edge day).
  const nl4 = usable.filter(({ r }) => r.source === 'NL-4' && (r.kind === 'NL4_FROM' || r.kind === 'NL4_TO'));
  for (const priority of new Set(nl4.map(({ r }) => r.priority))) {
    const group = nl4.filter(({ r }) => r.priority === priority);
    const froms = new Set(group.filter(({ r }) => r.kind === 'NL4_FROM').map(({ v }) => v));
    const tos = new Set(group.filter(({ r }) => r.kind === 'NL4_TO').map(({ v }) => v));
    if (froms.size > 1 || tos.size > 1 || froms.size + tos.size === 0) continue; // ambiguous: lines only
    const label = group.find(({ r }) => r.label !== null)?.r.label ?? null;
    if (label === null) continue;
    const stem = stemOf(label);
    const level = NL4_LEVEL.get(stem);
    if (level === undefined || level === 'no_ref') continue;
    const from = froms.size === 0 ? null : (froms.values().next().value as number);
    const to = tos.size === 0 ? null : (tos.values().next().value as number);
    const name = stemName(label, 'NL-4');
    pending.push({
      zone: { from, to, level, colour: colourOf(level) },
      key: from ?? Number.NEGATIVE_INFINITY,
      strict: true,
      names: [name],
      raws: label !== name ? [label] : [],
      owner: o.owner('NL-4'),
    });
    for (const { r } of group) zoned.add(r);
  }

  pending.sort((a, b) => a.key - b.key || rank(a.zone.level) - rank(b.zone.level));
  const items: LegendItem[] = pending.map((p) => ({
    kind: 'zone',
    colour: p.zone.colour,
    name: p.names.join(' / '),
    range: rangeText({ from: p.zone.from, to: p.zone.to, strict: p.strict }, o),
    ...(p.raws.length === 0 ? {} : { raw: p.raws.join(' / ') }),
    ...(p.owner ? { owner: true as const } : {}),
  }));
  // Every other reference is a line row: shown-only kinds, kinds with no role, an ambiguous NL-4 class.
  for (const { r, v } of [...usable].sort((a, b) => a.v - b.v)) {
    if (zoned.has(r)) continue;
    const name = nameOf(r);
    const raw = rawOf(r, name);
    items.push({
      kind: 'line',
      name,
      range: m.threshold_line({ value: formatNumber(v, locale), unit: o.unit }, { locale }),
      ...(raw === undefined ? {} : { raw }),
      ...(o.owner(r.source) ? { owner: true as const } : {}),
    });
  }
  return {
    lines,
    zones: pending.map((p) => p.zone),
    items,
    hasNl4: usable.some(({ r }) => r.source === 'NL-4'),
  };
}
