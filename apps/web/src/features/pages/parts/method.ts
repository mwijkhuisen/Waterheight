import { type Datum, type NapRelation, TO_NAP } from '@rws/core/datums';
import type { ForecastCoverage } from '../../../lib/data/contracts.ts';
import { m } from '../../../paraglide/messages.js';
import type { Locale } from '../../../paraglide/runtime.js';
import { basisKind, stateWord } from '../../station/state.ts';
import { METHOD_AGENCIES, METHOD_CLASSES, METHOD_REFERENCES, type MethodReference } from '../method.gen.ts';
import { fractionText, intlLocale, listText } from './numbers.ts';

// The Method page's logic (P10b), pure: the class crosswalk and reference roles of method.gen.ts (generated from the
// code's own tables, never typed in here), the datum offsets of @rws/core/datums, and the forecast reaches of
// status.json. Words come from the existing state and basis messages and from the method_* ones, by static switches.

const na = (locale: Locale) => m.stat_na({}, { locale });

/** What a class or reference measures: the gauge's stage, a discharge, or an area. */
export function measureWord(basis: 'stage' | 'discharge' | 'area', locale: Locale): string {
  switch (basis) {
    case 'stage':
      return m.method_measure_stage({}, { locale });
    case 'discharge':
      return m.method_measure_discharge({}, { locale });
    case 'area':
      return m.method_measure_area({}, { locale });
  }
}

/** The kind of a class or reference (the basis kinds of the station panel; NL-4 carries its disclaimer). */
export const groupWord = (
  group: 'operational' | 'statistical' | 'provider_class' | 'area',
  source: string,
  locale: Locale,
) => basisKind({ kind: group, source }, locale);

export interface ClassRowView {
  key: string;
  source: string;
  agency: string;
  scale: string;
  code: string;
  level: string;
  measure: string;
  group: string;
  note: string;
}

export const classRows = (locale: Locale): ClassRowView[] =>
  METHOD_CLASSES.map((c) => ({
    key: `${c.source}\n${c.scale}\n${c.code}`,
    source: c.source,
    agency: METHOD_AGENCIES[c.source] ?? na(locale),
    scale: c.scale,
    code: c.code,
    level: stateWord(c.level, locale),
    measure: measureWord(c.basis, locale),
    group: groupWord(c.group, c.source, locale),
    note: c.noFlood ? m.method_no_flood({}, { locale }) : '',
  }));

function ruleWord(op: MethodReference['op'], locale: Locale): string {
  const o = { locale };
  switch (op) {
    case '>=':
      return m.method_op_ge({}, o);
    case '<=':
      return m.method_op_le({}, o);
    case '<':
      return m.method_op_lt({}, o);
    case null:
      return m.method_op_none({}, o);
  }
}

function formWord(form: MethodReference['form'], locale: Locale): string {
  const o = { locale };
  switch (form) {
    case 'scale':
      return m.method_form_scale({}, o);
    case 'stats':
      return m.method_form_stats({}, o);
    case 'percentile':
      return m.method_form_percentile({}, o);
    case null:
      return na(locale);
  }
}

export interface ReferenceRowView {
  key: string;
  source: string;
  agency: string;
  short: string;
  rule: string;
  level: string;
  measure: string;
  group: string;
  form: string;
}

export const referenceRows = (locale: Locale): ReferenceRowView[] =>
  METHOD_REFERENCES.map((r) => ({
    key: `${r.source}\n${r.kind}`,
    source: r.source,
    agency: METHOD_AGENCIES[r.source] ?? na(locale),
    short: r.short,
    rule: ruleWord(r.op, locale),
    level: r.level === null ? na(locale) : stateWord(r.level, locale),
    measure: measureWord(r.basis, locale),
    group: r.group === null ? na(locale) : groupWord(r.group, r.source, locale),
    form: formWord(r.form, locale),
  }));

export interface DatumRowView {
  datum: Datum;
  /** H_NAP = H_datum + offset; undefined when the datum is not converted. */
  offset: string | undefined;
  uncertainty: string | undefined;
  converted: string;
}

/** Every datum of the converter (H_NAP = H_datum + offset); the French and local ones are "not converted". */
export function datumRows(locale: Locale): DatumRowView[] {
  const metres = new Intl.NumberFormat(intlLocale(locale), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: 'exceptZero',
  });
  const plain = new Intl.NumberFormat(intlLocale(locale), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (Object.entries(TO_NAP) as [Datum, NapRelation][]).map(([datum, rel]) =>
    rel.converted
      ? {
          datum,
          offset: metres.format(rel.offsetM),
          uncertainty: `± ${plain.format(rel.uncertaintyM)}`,
          converted: m.datum_converted({}, { locale }),
        }
      : { datum, offset: undefined, uncertainty: undefined, converted: m.datum_not_converted({}, { locale }) },
  );
}

export interface ReachRowView {
  id: string;
  name: string;
  cover: string;
  /** Whether an official forecast fills the reach, then what a permission or an agency's silence says. */
  notes: string[];
}

/** The reaches of the forecast coverage: the name in the page's language and what is, or could be, published. */
export function reachRows(fc: ForecastCoverage, locale: Locale): ReachRowView[] {
  const o = { locale };
  return fc.reaches.map((r) => ({
    id: r.id,
    name: r.names[locale],
    cover: fractionText(r.covered, r.stations, locale),
    notes: [
      r.no_official_forecast ? m.coverage_no_forecast({}, o) : m.coverage_has_forecast({}, o),
      ...(r.after_permission.length === 0
        ? []
        : [m.coverage_after_permission({ agencies: listText(r.after_permission, locale) }, o)]),
      ...(r.none_publishes.length === 0
        ? []
        : [m.coverage_none_publishes({ agencies: listText(r.none_publishes, locale) }, o)]),
    ],
  }));
}
