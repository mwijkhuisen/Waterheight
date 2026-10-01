import { type KeyboardEvent, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import {
  amsterdam,
  formatDay,
  formatLocal,
  localInstants,
  quantise,
  STEP_MS,
  wallInstant,
} from '../../lib/time/time.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import styles from './timebar.module.css';

// The time selector (A§10 features/timebar, D11): a date, a time in
// Amsterdam's clock, and a scrubber over [displayStart, now] in 10-minute UTC
// steps. Every change becomes one quantised UTC instant; the page puts it in
// `?t=`. On 2026-10-25 the repeated hour has two instants (02:30 CEST = 00:30Z,
// 02:30 CET = 01:30Z), and both are reachable by the time input (a choice
// appears) and by the scrubber. The date and time fields are the user's while
// they have the focus: a value is taken once it is complete and inside the
// range, and never written back into a field that is being typed in.

const PLAY_MS = 1000;
const HOUR_STEPS = 6;

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
  end: number;
  epoch: number;
  onChange: (t: number) => void;
}

export function Timebar({ locale, t, start, end, epoch, onChange }: Props) {
  const id = useId();
  const [missing, setMissing] = useState(false);
  const [playing, setPlaying] = useState(false);
  const reduced = useReducedMotion();
  const latest = useRef(t);
  latest.current = t;
  const local = amsterdam(t);
  const twins = localInstants(local.date, local.time);
  const valueText = formatLocal(t, locale);
  const first = amsterdam(start).date;
  const last = amsterdam(end).date;
  const dateRef = useRef<HTMLInputElement>(null);
  const timeRef = useRef<HTMLInputElement>(null);

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
    if (!playing) return;
    const timer = setInterval(() => {
      const next = latest.current + STEP_MS;
      if (next > end) setPlaying(false);
      else onChange(next);
    }, PLAY_MS);
    const hidden = () => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [playing, end, onChange]);
  useEffect(() => {
    if (reduced) setPlaying(false);
  }, [reduced]);

  // Arrows and Home/End are the range input's own; PageUp/PageDown move an hour.
  const keys = (e: KeyboardEvent<HTMLInputElement>) => {
    const steps = e.key === 'PageUp' ? HOUR_STEPS : e.key === 'PageDown' ? -HOUR_STEPS : 0;
    if (steps === 0) return;
    e.preventDefault();
    go(t + steps * STEP_MS);
  };

  const span = end - start;
  const epochAt = span > 0 ? Math.min(100, Math.max(0, ((epoch - start) / span) * 100)) : 0;
  return (
    <section className={styles.timebar} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className={styles.heading}>
        {m.timebar_heading({}, { locale })}
      </h2>
      <p className={styles.current}>
        <time dateTime={new Date(t).toISOString()}>{valueText}</time>
      </p>
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
      <div className={styles.track}>
        <input
          type="range"
          min={start}
          max={end}
          step={STEP_MS}
          value={t}
          aria-label={m.slider_label({}, { locale })}
          aria-valuetext={valueText}
          aria-describedby={`${id}-epoch`}
          onChange={(e) => go(Number(e.currentTarget.value))}
          onKeyDown={keys}
        />
        <span className={styles.epoch} style={{ left: `${epochAt}%` }} aria-hidden="true" />
      </div>
      <p id={`${id}-epoch`} className={styles.note}>
        {m.epoch_note({ date: formatDay(epoch, locale) }, { locale })}
      </p>
      {/* At a bound a button stays focusable and does nothing (aria-disabled): a disabled one would drop the focus. */}
      <div className={styles.buttons}>
        <button type="button" aria-disabled={t <= start} onClick={() => t > start && go(t - STEP_MS)}>
          {m.step_back({}, { locale })}
        </button>
        <button type="button" onClick={() => setPlaying((p) => !p)} disabled={reduced}>
          {playing ? m.pause({}, { locale }) : m.play({}, { locale })}
        </button>
        <button type="button" aria-disabled={t >= end} onClick={() => t < end && go(t + STEP_MS)}>
          {m.step_forward({}, { locale })}
        </button>
        <button type="button" aria-disabled={t >= end} onClick={() => t < end && go(end)}>
          {m.to_now({}, { locale })}
        </button>
      </div>
      {reduced && <p className={styles.note}>{m.play_reduced_motion({}, { locale })}</p>}
    </section>
  );
}
