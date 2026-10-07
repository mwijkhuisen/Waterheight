import { lhpColour } from '../../lib/labels/labels.ts';
import type { Mode } from '../../lib/url/url.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { OwnerBadge } from '../owner/OwnerBadge.tsx';
import { DhMark } from './DhMark.tsx';
import { dhItems, LHP_ALERT_CODES, qItems, stateItems } from './items.ts';
import styles from './legend.module.css';
import { LHP_NO_DATA } from './palette.ts';

// The map legend (P10a T2): per mode, collapsible, with the honesty and NL-4 notes and the keys for the other cues.
// P10d: over the map's bottom-right corner (as on waterinfo). P10e: in that corner of the table view too, above the
// timebar and beside the drawer (App.module.css `.corner`). It starts collapsed at every width (owner, KG-251): open,
// it covered a third of the map beside a station panel; the states are also in words in the panel, the popup and
// the table.

export interface LegendProps {
  locale: Locale;
  mode: Mode;
  /** t is after now: the forecast marker key replaces the value keys. */
  forecast: boolean;
  /** Owner site: the "owner only" key is shown. */
  owner: boolean;
  /** Warning areas are on the map at t (their key is shown). */
  warnings: boolean;
}

const stateWord = {
  no_ref: m.state_no_ref,
  low: m.state_low,
  normal: m.state_normal,
  elevated: m.state_elevated,
  high: m.state_high,
  extreme: m.state_extreme,
} as const;

const dhWord = {
  [-3]: m.dh_fall_strong,
  [-2]: m.dh_fall,
  [-1]: m.dh_fall_slight,
  0: m.dh_steady,
  1: m.dh_rise_slight,
  2: m.dh_rise,
  3: m.dh_rise_strong,
} as const;

function Dot({ colour, r }: { colour: string; r: number }) {
  return (
    <svg width={2 * r + 4} height={2 * r + 4} aria-hidden="true" focusable="false">
      <circle cx={r + 2} cy={r + 2} r={r} fill={colour} stroke="#333" strokeWidth="1.5" />
    </svg>
  );
}

export function Legend({ locale, mode, forecast, owner, warnings }: LegendProps) {
  const o = { locale };
  return (
    <details className={`${styles.legend} ${styles.floating}`}>
      <summary>{m.legend_heading({}, o)}</summary>
      <ul className={styles.list}>
        {mode === 'state' &&
          stateItems().map((i) => (
            <li key={i.state}>
              <Dot colour={i.colour} r={i.radius} />
              {stateWord[i.state]({}, o)}
            </li>
          ))}
        {mode === 'delta' &&
          dhItems().map((i) => (
            <li key={i.bin}>
              <Dot colour={i.colour} r={6} />
              <DhMark glyph={i.glyph} />
              {dhWord[i.bin]({}, o)}
            </li>
          ))}
        {mode === 'q' &&
          qItems().map((i) => (
            <li key={i.size}>
              <Dot colour={i.colour} r={i.radius} />
              {i.kind === 'lt'
                ? m.legend_q_lt({ v: i.hi }, o)
                : i.kind === 'ge'
                  ? m.legend_q_ge({ v: i.lo }, o)
                  : m.legend_q_range({ lo: i.lo, hi: i.hi }, o)}
            </li>
          ))}
        {mode === 'q' && (
          <li>
            <Dot colour="#fff" r={4} />
            {m.q_none({}, o)}
          </li>
        )}
        <li>
          <Dot colour="#fff" r={5} />
          {m.legend_no_value({}, o)}
        </li>
      </ul>
      {forecast && <p className={styles.note}>{m.legend_forecast({}, o)}</p>}
      <ul className={styles.list}>
        <li>{m.legend_stale({}, o)}</li>
        <li>! {m.legend_suspect({}, o)}</li>
        <li>{m.legend_tidal({}, o)}</li>
        <li>{m.legend_impounded({}, o)}</li>
        <li>{m.legend_section({}, o)}</li>
        {owner && (
          <li>
            <OwnerBadge locale={locale} /> {m.legend_owner({}, o)}
          </li>
        )}
      </ul>
      {warnings && (
        <>
          <p className={styles.note}>{m.legend_warnings({}, o)}</p>
          <ul className={styles.list}>
            {LHP_ALERT_CODES.map((c) => (
              <li key={c}>
                <Dot colour={lhpColour('alert', c) ?? LHP_NO_DATA} r={5} />
                {m.lhp_class({ n: c }, o)}
              </li>
            ))}
          </ul>
          <p className={styles.note}>{m.legend_lhp2({}, o)}</p>
        </>
      )}
      <p className={styles.note}>{m.legend_honesty({}, o)}</p>
      <p className={styles.note}>{m.basis_nl4({}, o)}</p>
    </details>
  );
}
