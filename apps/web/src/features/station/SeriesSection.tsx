import type { ApiStation, SeriesMeta } from '@rws/contracts';
import { SUSPECT_BITS } from '@rws/core/qc';
import { useMemo, useState } from 'react';
import type { Change } from '../../lib/data/change.ts';
import type { WebSources } from '../../lib/data/contracts.ts';
import type { PlayedValue } from '../../lib/data/frames.ts';
import type { WebForecast as SnapshotForecast } from '../../lib/data/static.ts';
import type { WarningsAt } from '../../lib/data/warnings.ts';
import { basisLabel, referenceLabel, useOwnerLabels } from '../../lib/labels/labels.ts';
import type { Lapse } from '../../lib/stationStates.ts';
import { formatAge, formatDay, formatLocal, quantise } from '../../lib/time/time.ts';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { DhMark } from '../legend/DhMark.tsx';
import { OwnerBadge } from '../owner/OwnerBadge.tsx';
import { BasisLabel } from './BasisLabel.tsx';
import { Chart, ownerTag } from './Chart.tsx';
import { onAxis, runName, xRange } from './chartModel.ts';
import { FORECAST_COLOUR, MEASURED_COLOUR } from './colours.ts';
import { bandText, forecastValue, issueText } from './forecast.ts';
import { creditLines, dhValue, trendGlyph } from './provenance.ts';
import { SeriesTable } from './SeriesTable.tsx';
import { heightText, stateWord, valueStateWord } from './state.ts';
import styles from './station.module.css';
import { referenceMarks } from './thresholds.ts';
import { type RecentSeries, useSeriesData } from './useSeriesData.ts';
import { formatValue, quantityLabel, unitLabel } from './value.ts';

// One series of the station panel (P10d): its heading and last measurement, the chart or the table, the legends of the
// lines and of the thresholds, and the facts. Every string that came from data is a React text node.

type Value = PlayedValue;

interface Props {
  locale: Locale;
  /** The station's id keys the heading; `name` is its published name (chart text only). */
  station: Pick<ApiStation, 'name'>;
  headingId: string;
  series: SeriesMeta & { api?: boolean };
  values: ReadonlyMap<number, Value>;
  forecasts: ReadonlyMap<number, SnapshotForecast> | undefined;
  changes: ReadonlyMap<number, Change> | undefined;
  /** KG-233: this series has no value at t and its newest one is past the limit (or over 25 hours old). */
  lapse: Lapse | undefined;
  warnings: WarningsAt | undefined;
  ownerSources: ReadonlySet<string>;
  sourceDocs: WebSources['sources'] | undefined;
  recent: RecentSeries | undefined;
  recentFailed: boolean;
  t: number;
  serverNow: number;
  dataEpoch: number;
  span: { from: number; to: number };
  days: number;
  view: 'chart' | 'table';
  showThresholds: boolean;
  /** P11b: the values are played-back hourly frames (no state, basis or class: W5 hides those lines). */
  played?: boolean;
}

type SwatchKind = 'solid' | 'dashed' | 'dotted' | 'band' | 'zone' | 'dash';

/** A key of the legends: our own simple shape, hidden from assistive technology (the text beside it says it all). */
function Swatch({ kind, colour }: { kind: SwatchKind; colour: string }) {
  const dash = kind === 'dashed' || kind === 'dash' ? '5 3' : kind === 'dotted' ? '1.5 3' : undefined;
  return (
    <svg width="28" height="12" viewBox="0 0 28 12" aria-hidden="true" focusable="false" className={styles.swatchIcon}>
      {kind === 'zone' || kind === 'band' ? (
        <rect
          x="4"
          y="1"
          width="20"
          height="10"
          fill={colour}
          fillOpacity={kind === 'band' ? 0.25 : 0.6}
          stroke="#555"
          strokeWidth="1"
        />
      ) : (
        <line x1="1" y1="6" x2="27" y2="6" stroke={colour} strokeWidth="2.5" strokeDasharray={dash} />
      )}
    </svg>
  );
}

export function SeriesSection({
  locale,
  station,
  headingId,
  series,
  values,
  forecasts,
  changes,
  lapse,
  warnings,
  ownerSources,
  sourceDocs,
  recent,
  recentFailed,
  t,
  serverNow,
  dataEpoch,
  span,
  days,
  view,
  showThresholds,
  played = false,
}: Props) {
  const value = values.get(series.id);
  const forecast = forecasts?.get(series.id);
  const since = series.dataSince === null ? undefined : Date.parse(series.dataSince);
  const change = changes?.get(series.id);
  const credit = sourceDocs?.find((s) => s.id === series.source);
  const suspect = value !== undefined && (value.qc & SUSPECT_BITS) !== 0;
  const stale = value !== undefined && value.ageSeconds > 2 * series.expectedStepSeconds;
  // KG-233: no value at t, and the newest one is past the limit (stale) or over 25 hours old (hidden).
  const lapsed = value === undefined ? lapse : undefined;
  const unit = unitLabel(series, locale);
  const o = { locale };

  const data = useSeriesData({ series, t, span, serverNow, recent, recentFailed });
  const [chartFailed, setChartFailed] = useState(false);
  const ownerLabels = useOwnerLabels();
  const marks = useMemo(
    () =>
      referenceMarks(recent?.references ?? [], {
        quantity: series.quantity,
        conv: data.conv,
        ours: (r) => referenceLabel(r.source, r.kind, locale, ownerLabels),
        stem: (stem) => basisLabel({ source: 'NL-4', kind: 'provider_class', ref: stem }, locale),
        owner: (s) => ownerSources.has(s),
        locale,
        unit,
        t,
      }),
    [recent, series.quantity, data.conv, ownerLabels, ownerSources, locale, unit, t],
  );
  const run = data.run;
  const runText =
    run === undefined ? undefined : `${runName(run, locale)}${ownerTag(run.source, ownerSources, locale)}`;
  // The now line and the selected time's dashed line (when it is not now) exist only where the axis reaches.
  const runEnd = data.view?.end;
  const x = useMemo(() => xRange({ from: span.from, to: span.to }, runEnd), [span.from, span.to, runEnd]);
  const nowShown = onAxis(serverNow, x);
  const selectedMarked = t !== quantise(serverNow) && onAxis(t, x);

  return (
    <section className={styles.series} aria-labelledby={headingId}>
      <h3 id={headingId}>
        {quantityLabel(series, locale)}
        {ownerSources.has(series.source) && (
          <>
            {' '}
            <OwnerBadge locale={locale} />
          </>
        )}
      </h3>
      {forecasts !== undefined ? (
        forecast === undefined ? (
          <p className={styles.value}>{m.forecast_none({}, o)}</p>
        ) : (
          <>
            <p className={styles.value}>
              {forecast.value === null ? (
                forecastValue(forecast, series, locale)
              ) : (
                <>
                  <strong>{formatValue(forecast.value, series, locale)}</strong> {unit}
                </>
              )}
            </p>
            {forecast.estimate && <p className={styles.estimate}>{m.forecast_estimate_note({}, o)}</p>}
            {/* BAFU recommends explaining how its forecasts read (catalogue §2.7; review SEC-2). */}
            {forecast.source === 'CH-4' && <p className={styles.estimate}>{m.forecast_bafu_note({}, o)}</p>}
          </>
        )
      ) : value === undefined ? (
        <p className={styles.value}>{m.value_none({}, o)}</p>
      ) : (
        <p className={styles.value}>
          {m.panel_last_measurement({}, o)}: <strong>{formatValue(value.value, series, locale)}</strong> {unit}{' '}
          {m.panel_at_time({ time: formatLocal(Date.parse(value.ts), locale) }, o)}
          {value.section && <span className={styles.badge}>{m.section_badge({}, o)}</span>}
          {played && <span className={styles.note}> {m.played_value_note({}, o)}</span>}
        </p>
      )}
      {(suspect || stale || lapsed !== undefined) && (
        <ul className={styles.notes}>
          {suspect && <li>{m.suspect_note({}, o)}</li>}
          {stale && <li>{m.stale_note({}, o)}</li>}
          {lapsed !== undefined && (
            <li>
              {(lapsed.hidden ? m.lapsed_hidden_note : m.lapsed_note)({}, o)} ({m.age({}, o)}:{' '}
              {formatAge(lapsed.ageSeconds, locale)})
            </li>
          )}
        </ul>
      )}
      {(data.failed || chartFailed) && <p className={styles.note}>{m.chart_unavailable({}, o)}</p>}
      {data.historyNone && <p className={styles.note}>{m.history_none({}, o)}</p>}
      {data.recentOnly && <p className={styles.note}>{m.history_recent_only({}, o)}</p>}
      {view === 'chart' ? (
        <Chart
          locale={locale}
          name={station.name}
          unit={unit}
          x={x}
          now={nowShown ? serverNow : undefined}
          selected={selectedMarked ? t : undefined}
          days={days}
          data={data}
          marks={marks}
          showThresholds={showThresholds}
          ownerSources={ownerSources}
          onFailed={setChartFailed}
        />
      ) : (
        <SeriesTable locale={locale} quantity={quantityLabel(series, locale)} unit={unit} data={data} />
      )}

      <div className={styles.legendBox}>
        <h4>{m.legend_series_heading({}, o)}</h4>
        <ul className={styles.keys}>
          <li>
            <Swatch kind="solid" colour={MEASURED_COLOUR} />
            {m.chart_observed({}, o)}
          </li>
          {runText !== undefined && (
            <li>
              <Swatch kind="dashed" colour={FORECAST_COLOUR} />
              {runText}
            </li>
          )}
          {data.view !== undefined && data.view.estimate.length > 0 && runText !== undefined && (
            <li>
              <Swatch kind="dotted" colour={FORECAST_COLOUR} />
              {runText} ({m.forecast_estimate({}, o)})
            </li>
          )}
          {data.view?.hasBand === true && (
            <li>
              <Swatch kind="band" colour={FORECAST_COLOUR} />
              {m.forecast_band_label({}, o)}
            </li>
          )}
          {nowShown && (
            <li>
              <Swatch kind="solid" colour="#555" />
              {m.now_marker({}, o)}
            </li>
          )}
          {selectedMarked && (
            <li>
              <Swatch kind="dashed" colour="#555" />
              {m.chart_selected_time({}, o)}
            </li>
          )}
        </ul>
      </div>

      <div className={styles.legendBox}>
        <h4>{m.legend_thresholds_heading({}, o)}</h4>
        {marks.items.length === 0 ? (
          <p className={styles.keysNone}>{m.thresholds_none({}, o)}</p>
        ) : (
          <ul className={styles.keys}>
            {marks.items.map((i, n) => (
              // Two FR-5 floods or seasonal NL-4 rows can share name and value: the position keeps keys apart.
              // biome-ignore lint/suspicious/noArrayIndexKey: the rows are rebuilt as a whole, never reordered
              <li key={`${n}|${i.kind}|${i.name}|${i.range}`}>
                <Swatch kind={i.kind === 'zone' ? 'zone' : 'dash'} colour={i.colour ?? '#555'} />
                <span>
                  {m.legend_threshold_item({ name: i.name, range: i.range }, o)}
                  {i.raw === undefined ? '' : ` · ${i.raw}`}
                  {i.owner === true && (
                    <>
                      {' '}
                      <OwnerBadge locale={locale} />
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {marks.hasNl4 && <p className={styles.note}>{m.basis_nl4({}, o)}</p>}
      </div>

      <dl className={styles.facts}>
        {forecast !== undefined && (
          <ForecastFacts
            forecast={forecast}
            series={series}
            locale={locale}
            warnings={warnings}
            ownerSources={ownerSources}
          />
        )}
        {forecasts === undefined && value !== undefined && (
          <>
            <dt>{m.measured_at({}, o)}</dt>
            <dd>
              <time dateTime={value.ts}>{formatLocal(Date.parse(value.ts), locale)}</time>
            </dd>
            <dt>{m.age({}, o)}</dt>
            <dd>{formatAge(value.ageSeconds, locale)}</dd>
          </>
        )}
        {forecasts === undefined && value !== undefined && (
          <>
            <dt>{m.panel_state({}, o)}</dt>
            <dd>
              {valueStateWord(value, locale)}
              {value.section && ` ${m.section_marker({}, o)}`}
            </dd>
            {!played && (
              <>
                {value.basis !== null && (
                  <>
                    <dt>{m.panel_basis({}, o)}</dt>
                    <dd>
                      <BasisLabel locale={locale} basis={value.basis} warnings={warnings} ownerSources={ownerSources} />
                    </dd>
                  </>
                )}
                {value.area !== undefined && (
                  <>
                    <dt>{m.panel_area({}, o)}</dt>
                    <dd>
                      {stateWord(value.area.state, locale)}:{' '}
                      <BasisLabel
                        locale={locale}
                        basis={value.area.basis}
                        warnings={warnings}
                        ownerSources={ownerSources}
                      />
                    </dd>
                  </>
                )}
              </>
            )}
            {heightText(value, locale) !== null && (
              <>
                <dt>{m.panel_height({}, o)}</dt>
                <dd>{heightText(value, locale)}</dd>
              </>
            )}
          </>
        )}
        <dt>{m.panel_dh({}, o)}</dt>
        <dd>
          {forecasts !== undefined || change === undefined || change === null ? (
            m.dh_na({}, o)
          ) : (
            <>
              <DhMark glyph={trendGlyph(change.trend)} />{' '}
              {m.dh_value({ dh: dhValue(change.dh, series.quantity, locale) }, o)},{' '}
              {/* By name, never `m[key]`: indexing the namespace would bundle every message. */}
              {{ rising: m.trend_rising, falling: m.trend_falling, steady: m.trend_steady }[change.trend]({}, o)}
            </>
          )}
        </dd>
        <dt>{m.data_since({}, o)}</dt>
        <dd>
          {since === undefined
            ? m.data_since_none({}, o)
            : since < dataEpoch
              ? m.data_since_seeded({ date: formatDay(since, locale), epoch: formatDay(dataEpoch, locale) }, o)
              : formatDay(since, locale)}
        </dd>
        <dt>{m.panel_credit({}, o)}</dt>
        <dd>
          {series.source}
          {credit !== undefined && (
            <ul className={styles.credit}>
              {creditLines(credit, locale).map((c) => (
                <li key={`${c.lang}|${c.text}`} lang={c.lang ?? undefined}>
                  {c.href === undefined ? (
                    c.text
                  ) : (
                    <a href={c.href} rel="noopener noreferrer">
                      {c.text}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </dd>
      </dl>
    </section>
  );
}

/** The rows of a forecast: the instant it holds for, who issued it and when, the band, its state, how far it reaches. */
function ForecastFacts({
  forecast,
  series,
  locale,
  warnings,
  ownerSources,
}: {
  forecast: SnapshotForecast;
  series: SeriesMeta;
  locale: Locale;
  warnings: WarningsAt | undefined;
  ownerSources: ReadonlySet<string>;
}) {
  const band = bandText(forecast, series, locale);
  return (
    <>
      <dt>{m.forecast_valid_for({}, { locale })}</dt>
      <dd>
        <time dateTime={forecast.ts}>{formatLocal(Date.parse(forecast.ts), locale)}</time>
      </dd>
      <dt>{m.forecast_origin({}, { locale })}</dt>
      <dd>
        {issueText(forecast, locale)}
        {/* The band of an owner source (LU-3) says so, in words (P10a T12). */}
        {ownerSources.has(forecast.source) && (
          <>
            {' '}
            <OwnerBadge locale={locale} />
          </>
        )}
      </dd>
      {band !== null && (
        <>
          <dt>{m.forecast_band_label({}, { locale })}</dt>
          <dd>{band}</dd>
        </>
      )}
      {forecast.state !== null && (
        <>
          <dt>{m.panel_forecast_state({}, { locale })}</dt>
          <dd>{stateWord(forecast.state, locale)}</dd>
        </>
      )}
      {forecast.basis !== null && (
        <>
          <dt>{m.panel_basis({}, { locale })}</dt>
          <dd>
            <BasisLabel locale={locale} basis={forecast.basis} warnings={warnings} ownerSources={ownerSources} />
          </dd>
        </>
      )}
      <dt>{m.forecast_until({}, { locale })}</dt>
      <dd>
        <time dateTime={forecast.horizonEnd}>{formatLocal(Date.parse(forecast.horizonEnd), locale)}</time>
      </dd>
    </>
  );
}
