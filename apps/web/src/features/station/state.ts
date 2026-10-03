import type { Snapshot } from '@rws/contracts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { formatNumber } from './value.ts';

// The classified state of a value and what it is based on (P7b). Words only, no colour (the legend is P10).
// The basis label is provider text: callers put it in a text node, never in HTML.

type Value = Snapshot['values'][number];
type Basis = NonNullable<Value['basis']>;

export const stateWord = (state: Value['state'], locale: Locale): string =>
  ({
    no_ref: m.state_no_ref,
    low: m.state_low,
    normal: m.state_normal,
    elevated: m.state_elevated,
    high: m.state_high,
    extreme: m.state_extreme,
  })[state]({}, { locale });

/** The kind of a basis in words; the NL-4 legend carries its "not an official warning" disclaimer (C39). */
export function basisKind(basis: Pick<Basis, 'kind' | 'source'>, locale: Locale): string {
  switch (basis.kind) {
    case 'operational':
      return m.basis_operational({}, { locale });
    case 'statistical':
      return m.basis_statistical({}, { locale });
    case 'area':
      return m.basis_area({}, { locale });
    case 'provider_class':
      return basis.source === 'NL-4' ? m.basis_nl4({}, { locale }) : m.basis_provider_class({}, { locale });
  }
}

/** One line for the map popup: "Waterstand: Verhoogd, <kind>: <label> (sectie)". */
export function popupLine(quantity: string, value: Value, locale: Locale): string {
  const parts = [`${quantity}: ${stateWord(value.state, locale)}`];
  if (value.basis !== null) parts.push(`${basisKind(value.basis, locale)}: ${value.basis.label}`);
  if (value.section) parts.push(m.section_marker({}, { locale }));
  return parts.join(', ');
}

/**
 * The detail-view height (D16): "≈ x.xx m NAP (± y cm)", without the "± 0 cm" of an exact zero, or an unverified
 * gauge zero; null when neither.
 */
export function heightText(value: Pick<Value, 'nap' | 'zero'>, locale: Locale): string | null {
  if (value.nap !== undefined) {
    const at = formatNumber(value.nap.m, locale);
    const pm = Math.round(value.nap.pm * 100);
    return pm === 0
      ? m.height_nap_exact({ m: at }, { locale })
      : m.height_nap({ m: at, pm: formatNumber(pm, locale) }, { locale });
  }
  if (value.zero !== undefined)
    return m.height_zero({ m: formatNumber(value.zero.m, locale), datum: value.zero.datum }, { locale });
  return null;
}
