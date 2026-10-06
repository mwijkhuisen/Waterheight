import type { StateBasis } from '@rws/contracts';
import type { WarningsAt } from '../../lib/data/warnings.ts';
import { basisLabel, lhpColour, useOwnerLabels } from '../../lib/labels/labels.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { OwnerBadge } from '../owner/OwnerBadge.tsx';
import { basisKind } from './state.ts';
import styles from './station.module.css';

interface Props {
  locale: Locale;
  basis: Pick<StateBasis, 'source' | 'kind' | 'ref' | 'label'>;
  /** The areas valid at t: an area basis's raw level code is on its feature (V2). */
  warnings: WarningsAt | undefined;
  ownerSources: ReadonlySet<string>;
}

/**
 * "<kind>: <raw label> — <ours>". The raw label is provider text and stays a text child (invariant 3); our
 * translation is added only when the catalogue has one. An LHP class (DE-6) shows its class number and legend colour
 * beside the number (colour is never the only cue), and a class taken from another operator's duplicate says so.
 */
export function BasisLabel({ locale, basis, warnings, ownerSources }: Props) {
  const owner = useOwnerLabels();
  const levelRaw =
    basis.kind === 'area'
      ? warnings?.features.find((f) => f.properties.source === basis.source && f.properties.area === basis.ref)
          ?.properties.levelRaw
      : undefined;
  const ours = basisLabel(basis, locale, { areaLevelRaw: levelRaw, owner });
  const text = ours === undefined ? basis.label : m.label_translation({ raw: basis.label, ours }, { locale });
  const lhp = basis.source === 'DE-6' && basis.kind === 'provider_class';
  const code = basis.ref.slice(basis.ref.lastIndexOf(':') + 1);
  const colour = lhp ? lhpColour('station', code) : undefined;
  return (
    <>
      {basisKind(basis, locale)}:{' '}
      {lhp && (
        <>
          {colour !== undefined && (
            <svg
              className={styles.swatch}
              viewBox="0 0 12 12"
              width="12"
              height="12"
              aria-hidden="true"
              focusable="false"
            >
              <rect width="12" height="12" fill={colour} stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
          {m.lhp_class({ n: code }, { locale })}{' '}
        </>
      )}
      {lhp && basis.ref.includes(':') ? m.class_from({ label: basis.label }, { locale }) : text}
      {ownerSources.has(basis.source) && (
        <>
          {' '}
          <OwnerBadge locale={locale} />
        </>
      )}
    </>
  );
}
