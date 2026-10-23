import { lhpColour } from '../../lib/labels/labels.ts';
import type { Group, Mode } from '../../lib/url/url.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { OwnerBadge } from '../owner/OwnerBadge.tsx';
import { DhMark } from './DhMark.tsx';
import { dhItems, LHP_ALERT_CODES, qItems, reachItems, stateItems, surgeScale } from './items.ts';
import styles from './legend.module.css';
import {
  LAPSED_COLOUR,
  LAPSED_RADIUS,
  LHP_NO_DATA,
  REACH_HATCH_COLOURS,
  REACH_IMPOUNDED_COLOUR,
  REACH_NODATA_COLOUR,
  STATE_COLOUR,
} from './palette.ts';

// The map legend (P10a T2): per mode, collapsible, with the honesty and NL-4 notes and the keys for the other cues.
// P10d: over the map's bottom-right corner (as on waterinfo). P10e: in that corner of the table view too, above the
// timebar and beside the drawer (App.module.css `.corner`). It starts collapsed at every width (owner, KG-251): open,
// it covered a third of the map beside a station panel; the states are also in words in the panel, the popup and
// the table.

export interface LegendProps {
  /** P11b: the reaches are coloured on the map (the river layer is shown): their legend entries. */
  reaches?: boolean;
  /** #112: a span of the reaches is time-shifted by a sourced travel time: the "tijdverschoven, indicatief" note. */
  shifted?: boolean;
  locale: Locale;
  mode: Mode;
  /** t is after now: the forecast marker key replaces the value keys. */
  forecast: boolean;
  /** Owner site: the "owner only" key is shown. */
  owner: boolean;
  /** Warning areas are on the map at t (their key is shown). */
  warnings: boolean;
  /** P19a (O-3): the hidden layer groups (`?hide=`): their entries are left out. */
  hide: readonly Group[];
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

/** The lake fill and its outline, the canal line and the no-class grey, as `features/map/waterLayer.ts` draws them. */
const LAKE_FILL_OPACITY = 0.45;
const LAKE_OUTLINE = '#2b6f9e';
const LAKE_NO_CLASS = '#c8ccd0';
const CANAL_COLOUR = '#5b7f95';

/** P19a: a lake as the map fills it: the state colours of its reference gauge (a few of them), or the grey of no class. */
function LakeKey({ kind }: { kind: 'state' | 'none' }) {
  const fills =
    kind === 'none' ? [LAKE_NO_CLASS] : (['low', 'elevated', 'high', 'extreme'] as const).map((s) => STATE_COLOUR[s]);
  const w = 7;
  return (
    <svg width={w * fills.length + 2} height="12" aria-hidden="true" focusable="false">
      {fills.map((fill, i) => (
        <rect key={fill} x={1 + i * w} y="1" width={w} height="10" fill={fill} fillOpacity={LAKE_FILL_OPACITY} />
      ))}
      <rect x="1" y="1" width={w * fills.length} height="10" fill="none" stroke={LAKE_OUTLINE} strokeWidth="1" />
    </svg>
  );
}

/** A short line swatch of a reach key: dashed grey, hatched, or solid neutral (the text says it all). */
function LineKey({ kind }: { kind: 'nodata' | 'tidal' | 'impounded' | 'canal' }) {
  return (
    <svg width="28" height="10" aria-hidden="true" focusable="false">
      {kind === 'tidal' && (
        <defs>
          <pattern
            id="reach-hatch-key"
            width="4"
            height="4"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="4" height="4" fill={REACH_HATCH_COLOURS[1]} />
            <rect width="2" height="4" fill={REACH_HATCH_COLOURS[0]} />
          </pattern>
        </defs>
      )}
      {kind === 'tidal' ? (
        <rect x="1" y="2" width="26" height="6" fill="url(#reach-hatch-key)" />
      ) : (
        <line
          x1="1"
          y1="5"
          x2="27"
          y2="5"
          stroke={kind === 'nodata' ? REACH_NODATA_COLOUR : kind === 'canal' ? CANAL_COLOUR : REACH_IMPOUNDED_COLOUR}
          strokeWidth={kind === 'nodata' ? 3 : kind === 'canal' ? 2 : 4}
          strokeDasharray={kind === 'nodata' || kind === 'canal' ? '4 3' : undefined}
        />
      )}
    </svg>
  );
}

const reachWord = { nodata: m.reach_nodata, tidal: m.reach_tidal, impounded: m.reach_impounded } as const;

/** P19a: the surge scale, a bar of the stop colours with the stop values under it (in proportion, as drawn). */
function SurgeScale() {
  const stops = surgeScale();
  return (
    <div className={styles.scale}>
      <div
        className={styles.scaleBar}
        aria-hidden="true"
        style={{ background: `linear-gradient(to right, ${stops.map((s) => `${s.colour} ${s.at}%`).join(', ')})` }}
      />
      {stops.map((s, i) => (
        <span
          key={s.cm}
          className={`${styles.tick} ${i === 0 ? styles.tickFirst : i === stops.length - 1 ? styles.tickLast : ''}`}
          style={{ left: `${s.at}%` }}
        >
          {s.label}
        </span>
      ))}
    </div>
  );
}

export function Legend({ reaches, shifted, locale, mode, forecast, owner, warnings, hide }: LegendProps) {
  const o = { locale };
  // P19a: the layer entries need the map with its tiles (`reaches`) and show per visible group (O-3).
  const rivers = reaches === true && !hide.includes('rivers');
  const lakes = reaches === true && !hide.includes('lakes');
  const coast = reaches === true && !hide.includes('coast');
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
        <li>
          <Dot colour={LAPSED_COLOUR} r={LAPSED_RADIUS} />
          {m.legend_stale({}, o)}
        </li>
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
      {coast && mode === 'state' && (
        <>
          <p className={styles.note}>{m.legend_surge({}, o)}</p>
          <SurgeScale />
          <p className={styles.note}>{m.surge_derived({}, o)}</p>
          <ul className={styles.list}>
            <li>
              <DhMark glyph="▲" />
              {m.legend_surge_up({}, o)}
            </li>
            <li>
              <DhMark glyph="▼" />
              {m.legend_surge_down({}, o)}
            </li>
            <li>
              <Dot colour="#fff" r={5} />
              {m.legend_surge_none({}, o)}
            </li>
          </ul>
        </>
      )}
      {(coast || (lakes && mode === 'state')) && (
        <ul className={styles.list}>
          {coast && (
            <li>
              <span className={styles.mslMark}>{m.map_msl_short({}, o)}</span>
              {m.legend_msl({}, o)}
            </li>
          )}
          {lakes && mode === 'state' && (
            <>
              <li>
                <LakeKey kind="state" />
                {m.legend_lake({}, o)}
              </li>
              <li>
                <LakeKey kind="none" />
                {m.lake_no_class({}, o)}
              </li>
            </>
          )}
        </ul>
      )}
      {rivers && (
        <>
          <p className={styles.note}>{m.reach_legend_heading({}, o)}</p>
          <ul className={styles.list}>
            {reachItems().map((k) => (
              <li key={k}>
                <LineKey kind={k} />
                {reachWord[k]({}, o)}
              </li>
            ))}
            <li>
              <LineKey kind="canal" />
              {m.legend_canal({}, o)}
            </li>
          </ul>
          <p className={styles.note}>{m.reach_interpolated({}, o)}</p>
          {shifted && <p className={styles.note}>{m.reach_shifted({}, o)}</p>}
        </>
      )}
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
