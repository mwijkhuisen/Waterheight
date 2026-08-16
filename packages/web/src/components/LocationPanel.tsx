/**
 * Detail panel for the selected marker: identity, freshness, latest values,
 * and a time-series chart with a period selector.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LatestValue, LocationDetail, MeasurementType, ObservationsResponse } from '@rws/shared';
import { ApiRequestError, fetchLatest, fetchLocation, fetchObservations } from '../api.js';
import {
  FRESHNESS_COLOR,
  FRESHNESS_LABEL,
  formatAge,
  formatTimestamp,
  freshnessOf,
} from '../freshness.js';
import { DEFAULT_PERIOD, PERIODS, windowFor, type Period } from '../periods.js';
import { TimeSeriesChart } from './TimeSeriesChart.js';

export interface LocationPanelProps {
  code: string;
  onClose: () => void;
}

interface DetailState {
  detail: LocationDetail | null;
  latest: LatestValue[];
  loading: boolean;
  error: string | null;
}

/** waterinfo.rws.nl deep-links by location code and a map slug per quantity. */
const WATERINFO_MAPS: Record<string, string> = {
  WATHTE: 'waterhoogte',
  Q: 'waterafvoer',
  T: 'watertemperatuur',
  Hm0: 'golfhoogte',
  WINDSHD: 'wind',
  WINDRTG: 'wind',
};

function waterinfoUrl(code: string, quantity: string | null): string {
  const map = (quantity && WATERINFO_MAPS[quantity]) ?? 'waterhoogte';
  return `https://waterinfo.rws.nl/#/publiek/${map}?locationCode=${encodeURIComponent(code)}`;
}

/** Prefer something worth charting when the panel first opens. */
function pickDefaultQuantity(types: MeasurementType[]): MeasurementType | null {
  if (types.length === 0) return null;
  const preferred = ['WATHTE', 'Q', 'T', 'Hm0', 'WINDSHD'];
  for (const code of preferred) {
    const match = types.find((t) => t.quantity === code);
    if (match) return match;
  }
  // Otherwise whichever has the most stored history.
  return [...types].sort((a, b) => b.coverage.points - a.coverage.points)[0]!;
}

export function LocationPanel({ code, onClose }: LocationPanelProps) {
  const [state, setState] = useState<DetailState>({
    detail: null, latest: [], loading: true, error: null,
  });
  const [quantity, setQuantity] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>(DEFAULT_PERIOD);
  const [series, setSeries] = useState<ObservationsResponse | null>(null);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [seriesError, setSeriesError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setState({ detail: null, latest: [], loading: true, error: null });
    setSeries(null);
    setQuantity(null);
    setPeriod(DEFAULT_PERIOD);

    Promise.all([
      fetchLocation(code, controller.signal),
      // Best effort: a location with nothing ingested should still show its
      // identity and the list of what it measures.
      fetchLatest(code, controller.signal).catch(() => [] as LatestValue[]),
    ])
      .then(([detail, latest]) => {
        if (controller.signal.aborted) return;
        setState({ detail, latest, loading: false, error: null });
        setQuantity(pickDefaultQuantity(detail.measurementTypes)?.quantity ?? null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          detail: null, latest: [], loading: false,
          error: err instanceof ApiRequestError ? err.message : 'Could not load this location.',
        });
      });

    return () => controller.abort();
  }, [code]);

  const selectedType = useMemo(
    () => state.detail?.measurementTypes.find((t) => t.quantity === quantity) ?? null,
    [state.detail, quantity],
  );

  const loadSeries = useCallback((signal?: AbortSignal) => {
    if (!quantity || !selectedType) return;
    setSeriesLoading(true);
    setSeriesError(null);
    const { from, to } = windowFor(period);

    fetchObservations(
      {
        code, grootheid: quantity, compartiment: selectedType.compartment,
        from, to, resolution: period.resolution,
      },
      signal,
    )
      .then((res) => {
        if (signal?.aborted) return;
        setSeries(res);
        setSeriesLoading(false);
      })
      .catch((err: unknown) => {
        if (signal?.aborted) return;
        setSeriesError(
          err instanceof ApiRequestError ? err.message : 'Could not load measurements.',
        );
        setSeriesLoading(false);
      });
  }, [code, quantity, selectedType, period]);

  useEffect(() => {
    const controller = new AbortController();
    loadSeries(controller.signal);
    return () => controller.abort();
  }, [loadSeries]);

  const { detail, latest, loading, error } = state;
  const freshness = detail ? freshnessOf(detail.lastSeenAt) : 'delayed';
  const latestForQuantity = latest.find((l) => l.quantity === quantity) ?? null;

  return (
    <section className="panel" aria-label="Location details">
      <header className="panel__header">
        <div>
          <h2 className="panel__title">
            {loading ? <span className="skeleton skeleton--title" /> : detail?.name ?? code}
          </h2>
          <p className="panel__code">{code}</p>
        </div>
        <button type="button" className="panel__close" onClick={onClose} aria-label="Close details">
          ×
        </button>
      </header>

      {error && <p className="notice notice--error" role="alert">{error}</p>}

      {loading && !error && (
        <div className="panel__body">
          <span className="skeleton skeleton--line" />
          <span className="skeleton skeleton--block" />
        </div>
      )}

      {detail && !loading && (
        <div className="panel__body">
          <div className="panel__status">
            <span
              className="legend__swatch"
              style={{ background: FRESHNESS_COLOR[freshness] }}
              aria-hidden="true"
            />
            <span>{FRESHNESS_LABEL[freshness]} — last reported {formatAge(detail.lastSeenAt)}</span>
          </div>
          <p className="panel__timestamp">{formatTimestamp(detail.lastSeenAt)}</p>

          {detail.measurementTypes.length === 0 ? (
            <p className="notice">This location publishes no measurement types.</p>
          ) : (
            <>
              <div className="field">
                <label className="field__label" htmlFor="panel-quantity">Measurement</label>
                <select
                  id="panel-quantity"
                  className="field__input"
                  value={quantity ?? ''}
                  onChange={(e) => setQuantity(e.target.value || null)}
                >
                  {detail.measurementTypes.map((t) => (
                    <option key={`${t.compartment}-${t.quantity}-${t.seriesId}`} value={t.quantity}>
                      {t.quantityLabel ?? t.quantity}
                      {t.unit ? ` (${t.unit})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              {/* The headline value, so it never depends on reading the chart. */}
              <div className="reading">
                <span className="reading__value">
                  {latestForQuantity?.value !== undefined && latestForQuantity?.value !== null
                    ? <>{latestForQuantity.value}<span className="reading__unit">{selectedType?.unit ?? ''}</span></>
                    : <span className="reading__none">no current reading</span>}
                </span>
                {latestForQuantity && (
                  <span className="reading__time">
                    {formatTimestamp(latestForQuantity.timestamp)}
                  </span>
                )}
              </div>

              <div className="periods" role="group" aria-label="Chart period">
                {PERIODS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`periods__button${p.id === period.id ? ' periods__button--active' : ''}`}
                    aria-pressed={p.id === period.id}
                    onClick={() => setPeriod(p)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              <ChartArea
                loading={seriesLoading}
                error={seriesError}
                series={series}
                label={selectedType?.quantityLabel ?? quantity ?? ''}
                unit={selectedType?.unit ?? null}
                onRetry={() => loadSeries()}
              />
            </>
          )}

          <a
            className="panel__link"
            href={waterinfoUrl(code, quantity)}
            target="_blank"
            rel="noreferrer noopener"
          >
            View on waterinfo.rws.nl ↗
          </a>
        </div>
      )}
    </section>
  );
}

interface ChartAreaProps {
  loading: boolean;
  error: string | null;
  series: ObservationsResponse | null;
  label: string;
  unit: string | null;
  onRetry: () => void;
}

function ChartArea({ loading, error, series, label, unit, onRetry }: ChartAreaProps) {
  if (error) {
    return (
      <div className="notice notice--error" role="alert">
        {error}
        <button type="button" className="button button--ghost" onClick={onRetry}>Try again</button>
      </div>
    );
  }

  // First load has nothing to hold on to; a reload keeps the previous render at
  // reduced opacity instead of flashing a skeleton and jumping the layout.
  if (loading && !series) {
    return <span className="skeleton skeleton--chart" aria-label="Loading chart" />;
  }

  if (!series) return null;

  if (series.points.length === 0) {
    return (
      <p className="notice" role="status">
        {series.backfillPending
          // The API fetches on demand for short windows; a long window with no
          // data means the batch backfill has not covered it yet.
          ? 'No history stored for this measurement yet. Recent periods are fetched on demand — try 24h or 48h, or run the backfill for the full year.'
          : 'No measurements in this period.'}
      </p>
    );
  }

  return (
    <>
      <TimeSeriesChart
        points={series.points}
        resolution={series.resolution}
        unit={unit}
        label={label}
        reloading={loading}
      />
      {series.stale && (
        <p className="notice notice--warn" role="status">
          Rijkswaterstaat was unreachable; showing stored data
          {series.fetchedAt ? ` fetched ${formatAge(series.fetchedAt)}` : ''}.
        </p>
      )}
      {series.requestedResolution
        && series.requestedResolution !== series.resolution && (
        <p className="chart__note">
          Showing {series.resolution} data — the requested {series.requestedResolution}{' '}
          resolution exceeds the point limit for this period.
        </p>
      )}
      {series.truncated && (
        <p className="chart__note">
          Series truncated at the point limit; narrow the period to see all of it.
        </p>
      )}
    </>
  );
}
