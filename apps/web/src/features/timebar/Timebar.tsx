import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  amsterdam,
  formatDay,
  formatLocal,
  formatTick,
  localInstants,
  quantise,
  STEP_MS,
  wallInstant,
} from '../../lib/time/time.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { type Direction, playNext } from './play.ts';
import styles from './timebar.module.css';

// The time selector (A§10 features/timebar, D11): a date, a time in
// Amsterdam's clock, and a scrubber over [displayStart, end] in 10-minute UTC
// steps. `end` is now, or (P8b, D8) now plus the forecast horizon of the selected
// station, at most 48 h: the part after the "now" marker is forecast, said in the
// label, in the value text of the slider and in a note, never by the marker alone.
// Every change becomes one quantised UTC instant; the page puts it in `?t=`.
// On 2026-10-25 the repeated hour has two instants (02:30 CEST = 00:30Z,
// 02:30 CET = 01:30Z), and both are reachable by the time input (a choice
// appears) and by the scrubber. The date and time fields are the user's while
// they have the focus: a value is taken once it is complete and inside the
// range, and never written back into a field that is being typed in.

const PLAY_MS = 1000;
const HOUR_STEPS = 6;
/** Day labels under the track: the first and the last always, the ones between only where there is room. */
const TICKS = 6;

/** An icon of the buttons: our own simple shapes, hidden from assistive technology (the button has its name). */
function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
      <path d={d} fill="currentColor" />
    </svg>
  );
}
const ICON = {
  back: 'M4 4h2v12H4zM17 4v12L7 10z',
  forward: 'M14 4h2v12h-2zM3 4v12l10-6z',
  play: 'M6 4l10 6-10 6z',
  rewind: 'M14 4L4 10l10 6z',
  pause: 'M5 4h3.5v12H5zM11.5 4H15v12h-3.5z',
} as const;

const reducedMotion = '(prefers-reduced-motion: reduce)';
const subscribeMotion = (notify: () => void) => {
  const query = matchMedia(reducedMotion);
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
};
const useReducedMotion = () => useSyncExternalStore(subscribeMotion, () => matchMedia(reducedMotion).matches);

interface Props {
  locale: Locale;
  t: number;
  start: number;
  /** The page's now: the last instant with observations; the marker on the track. */
  now: number;
  /** The last instant the slider reaches: now, or the end of the forecast. */
  end: number;
  /** The selected station has no forecast at all: the track ends at now, and a note says why. */
  noForecast: boolean;
  epoch: number;
  /** P10a: live mode (no `t` in the URL): the page follows meta.now; "Nu" returns to it. */
  live: boolean;
  onChange: (t: number) => void;
}

export function Timebar({ locale, t, start, now, end, noForecast, epoch, live, onChange }: Props) {
  const id = useId();
  const [missing, setMissing] = useState(false);
  // P10e D7: collapsed at the start (the time, a short slider, the steps, play and "Nu"); the rest on request.
  const [expanded, setExpanded] = useState(false);
  const [playing, setPlaying] = useState<0 | Direction>(0);
  const reduced = useReducedMotion();
  const latest = useRef(t);
  latest.current = t;
  const local = useMemo(() => amsterdam(t), [t]);
  // Temporal zone conversions are the time bar's costliest work: once per t, not once per render (P10a Lighthouse).
  const twins = useMemo(() => localInstants(local.date, local.time), [local]);
  const forecast = t > now;
  const time = formatLocal(t, locale);
  const valueText = forecast ? m.slider_forecast_text({ time }, { locale }) : time;
  const first = amsterdam(start).date;
  const last = amsterdam(end).date;
  const dateRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLElement>(null);

  const go = (ms: number) => {
    setMissing(false);
    onChange(Math.min(end, Math.max(start, quantise(ms))));
  };
  /**
   * A typed date and time, once complete: the instant they name (see wallInstant), or the message when it does
   * not exist. A date counts once it is a day of the range (the time of day moves to the range's edge if it must),
   * a time once its instant is inside the range; anything else, such as a year still being typed, is left alone.
   */
  const wall = (date: string, time: string, fromDate: boolean) => {
    if (fromDate && (date < first || date > last)) return;
    const at = wallInstant(date, time, t);
    if (at === undefined) return;
    if (at === 'missing') setMissing(true);
    else if (fromDate || (quantise(at) >= start && quantise(at) <= end)) go(at);
  };

  // A value from elsewhere (the slider, Play, the other field) reaches a field only while it is not being typed in.
  useEffect(() => {
    for (const [el, value] of [
      [dateRef.current, local.date],
      [timeRef.current, local.time],
    ] as const)
      if (el !== null && el !== document.activeElement && el.value !== value) el.value = value;
  }, [local.date, local.time]);

  useEffect(() => {
    if (playing === 0) return;
    const timer = setInterval(() => {
      const next = playNext(latest.current, playing, start, end);
      if (next === null) setPlaying(0);
      else onChange(next);
    }, PLAY_MS);
    const hidden = () => {
      if (document.hidden) setPlaying(0);
    };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [playing, start, end, onChange]);
  useEffect(() => {
    if (reduced) setPlaying(0);
  }, [reduced]);
  // Play starts only where it has a step to take: at its bound the button stays Play, at once.
  const toggle = (dir: Direction) =>
    setPlaying((p) => (p === dir || playNext(latest.current, dir, start, end) === null ? 0 : dir));

  // The bar's real height, collapsed or expanded (its notes and the DST choice come and go), is --timebar-h: the
  // legend and the attribution buttons stand above it and a scrolled table keeps a focused row clear of it
  // (WCAG 2.4.11, timebar.module.css, App.module.css).
  useEffect(() => {
    const el = barRef.current;
    if (el === null) return;
    const root = document.documentElement;
    // Rounded up, never down: a fractional height must not leave a sliver of the bar over what stands above it.
    const size = new ResizeObserver(() =>
      root.style.setProperty('--timebar-h', `${Math.ceil(el.getBoundingClientRect().height)}px`),
    );
    size.observe(el);
    return () => {
      size.disconnect();
      root.style.removeProperty('--timebar-h');
    };
  }, []);

  // Arrows and Home/End are the range input's own; PageUp/PageDown move an hour.
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    const steps = e.key === 'PageUp' ? HOUR_STEPS : e.key === 'PageDown' ? -HOUR_STEPS : 0;
    if (steps === 0) return;
    e.preventDefault();
    go(t + steps * STEP_MS);
  };

  const span = end - start;
  const at = (ms: number) => (span > 0 ? Math.min(100, Math.max(0, ((ms - start) / span) * 100)) : 0);
  const epochAt = at(epoch);
  const nowAt = at(now);
  const note =
    end > now
      ? m.forecast_range_note({ time: formatLocal(end, locale) }, { locale })
      : noForecast
        ? m.forecast_station_none_note({}, { locale })
        : undefined;
  const describedBy = note === undefined ? `${id}-epoch` : `${id}-epoch ${id}-forecast`;
  return (
    <section
      ref={barRef}
      className={expanded ? `${styles.timebar} ${styles.expanded}` : styles.timebar}
      aria-labelledby={`${id}-h`}
    >
      <h2 id={`${id}-h`} className={styles.heading}>
        {m.timebar_heading({}, { locale })}
      </h2>
      <div className={styles.row}>
        <p className={styles.current}>
          <time dateTime={new Date(t).toISOString()}>{time}</time>
          {forecast && <span className={styles.badge}>{m.timebar_forecast({}, { locale })}</span>}
        </p>
        <div className={styles.track}>
          <input
            type="range"
            min={start}
            max={end}
            step={STEP_MS}
            value={t}
            aria-label={m.slider_label({}, { locale })}
            aria-valuetext={valueText}
            aria-describedby={expanded ? describedBy : undefined}
            onChange={(e) => go(Number(e.currentTarget.value))}
            onKeyDown={keys}
          />
          {expanded && <span className={styles.epoch} style={{ left: `${epochAt}%` }} aria-hidden="true" />}
          {/* The "now" marker: a tick above the track and its word; the forecast part is to its right. */}
          <span className={styles.nowTick} style={{ left: `${nowAt}%` }} aria-hidden="true" />
          <span
            className={styles.nowLabel}
            style={{ left: `${nowAt}%`, transform: `translateX(-${nowAt}%)` }}
            aria-hidden="true"
          >
            {m.now_marker({}, { locale })}
          </span>
          {expanded &&
            span > 0 &&
            Array.from({ length: TICKS }, (_, i) => {
              const pos = (i / (TICKS - 1)) * 100;
              return (
                <span
                  key={pos}
                  className={i === 0 || i === TICKS - 1 ? styles.tick : `${styles.tick} ${styles.tickMid}`}
                  style={{ left: `${pos}%`, transform: `translateX(-${pos}%)` }}
                  aria-hidden="true"
                >
                  {formatTick(start + (span * i) / (TICKS - 1), locale)}
                </span>
              );
            })}
        </div>
        {/* At a bound a button stays focusable and does nothing (aria-disabled): a disabled one would drop the focus. */}
        <div className={styles.buttons}>
          <button
            type="button"
            aria-label={m.step_back({}, { locale })}
            aria-disabled={t <= start}
            onClick={() => t > start && go(t - STEP_MS)}
          >
            <Icon d={ICON.back} />
          </button>
          <button
            type="button"
            aria-label={playing === 1 ? m.pause({}, { locale }) : m.play({}, { locale })}
            onClick={() => toggle(1)}
            disabled={reduced}
          >
            <Icon d={playing === 1 ? ICON.pause : ICON.play} />
          </button>
          <button
            type="button"
            aria-label={m.step_forward({}, { locale })}
            aria-disabled={t >= end}
            onClick={() => t < end && go(t + STEP_MS)}
          >
            <Icon d={ICON.forward} />
          </button>
          <button type="button" aria-disabled={t === now} onClick={() => t !== now && go(now)}>
            {m.to_now({}, { locale })}
          </button>
          <button
            type="button"
            className={styles.more}
            aria-expanded={expanded}
            aria-controls={`${id}-more`}
            onClick={() => {
              // Collapsing takes the reverse button, the only pause of reverse play, away: it stops (review round 1).
              if (expanded) setPlaying((p) => (p === -1 ? 0 : p));
              setExpanded(!expanded);
            }}
          >
            {m.timebar_more({}, { locale })}
            <span className={styles.chevron} aria-hidden="true" />
          </button>
        </div>
      </div>
      {/* The rest of the bar of P10d (a typed date and time, the reverse play, the repeated hour and the notes)
          is in the page only while it is expanded. */}
      <div id={`${id}-more`} hidden={!expanded}>
        {expanded && (
          <>
            <div className={styles.rowMore}>
              <div className={styles.fields}>
                <label>
                  {m.date_label({}, { locale })}
                  <input
                    ref={dateRef}
                    type="date"
                    defaultValue={local.date}
                    min={first}
                    max={last}
                    onChange={(e) => wall(e.currentTarget.value, local.time, true)}
                    onBlur={(e) => {
                      e.currentTarget.value = local.date;
                    }}
                  />
                </label>
                <label>
                  {m.time_label({}, { locale })}
                  <input
                    ref={timeRef}
                    type="time"
                    step={600}
                    defaultValue={local.time}
                    onChange={(e) => wall(local.date, e.currentTarget.value, false)}
                    onBlur={(e) => {
                      e.currentTarget.value = local.time;
                    }}
                  />
                </label>
              </div>
              <div className={styles.buttons}>
                <button
                  type="button"
                  aria-label={playing === -1 ? m.pause({}, { locale }) : m.play_reverse({}, { locale })}
                  onClick={() => toggle(-1)}
                  disabled={reduced}
                >
                  <Icon d={playing === -1 ? ICON.pause : ICON.rewind} />
                </button>
              </div>
            </div>
            {twins.length === 2 && (
              <fieldset className={styles.twins}>
                <legend>{m.repeated_hour_legend({}, { locale })}</legend>
                {twins.map((ms) => {
                  const at = amsterdam(ms);
                  return (
                    <label key={ms}>
                      <input type="radio" name={`${id}-twin`} checked={quantise(ms) === t} onChange={() => go(ms)} />
                      {` ${at.time} ${at.label} (UTC${at.offset})`}
                    </label>
                  );
                })}
              </fieldset>
            )}
            {missing && (
              <p role="alert" className={styles.missing}>
                {m.time_missing({}, { locale })}
              </p>
            )}
            <p id={`${id}-epoch`} className={styles.note}>
              {m.epoch_note({ date: formatDay(epoch, locale) }, { locale })}
            </p>
            {note !== undefined && (
              <p id={`${id}-forecast`} className={styles.note}>
                {note}
              </p>
            )}
            {live && <p className={styles.note}>{m.live_note({}, { locale })}</p>}
          </>
        )}
      </div>
      {/* Why play is off is said in both states. */}
      {reduced && <p className={styles.note}>{m.play_reduced_motion({}, { locale })}</p>}
    </section>
  );
}
