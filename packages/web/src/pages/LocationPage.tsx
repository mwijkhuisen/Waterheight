/**
 * A single measurement location -- the registry's package page.
 *
 * Main column carries the tabbed content; the right rail carries the metadata
 * npm keeps there: how to fetch it, what it last published, where it came
 * from, and how much of it is stored.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AggregatePoint,
  LatestValue,
  LocationDetail,
  MeasurementType,
  ObservationsResponse,
  RawPoint,
} from '@rws/shared';
import { ApiRequestError, fetchLatest, fetchLocation, fetchObservations } from '../api.js';
import { useDocumentTitle } from '../hooks.js';
import { FRESHNESS_LABEL, formatAge, formatTimestamp, freshnessOf } from '../freshness.js';
import { formatCompact, formatCount, formatDate, formatReading, formatSpan, plural } from '../format.js';
import { DEFAULT_PERIOD, PERIODS, windowFor, type Period } from '../periods.js';
import { Link, navigate, searchPath, useQueryParams, useRoute } from '../router.js';
import { LazyMapView } from '../components/LazyMap.js';
import { TimeSeriesChart } from '../components/TimeSeriesChart.js';
import { Badge, Chip, CopyBlock, FreshnessTag, MetaBlock, Notice, Skeleton, Tabs } from '../components/ui.js';

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

/** Prefer something worth charting when the page first opens. */
function pickDefaultQuantity(types: MeasurementType[]): MeasurementType | null {
  if (types.length === 0) return null;
  for (const code of ['WATHTE', 'Q', 'T', 'Hm0', 'WINDSHD']) {
    const match = types.find((t) => t.quantity === code);
    if (match) return match;
  }
  // Otherwise whichever has the most stored history.
  return [...types].sort((a, b) => b.coverage.points - a.coverage.points)[0]!;
}

const TAB_IDS = ['overview', 'measurements', 'data', 'map'] as const;
type TabId = (typeof TAB_IDS)[number];

export function LocationPage({ code }: { code: string }) {
  const params = useQueryParams();
  const route = useRoute();
  const requestedTab = params.get('tab');
  const tab: TabId = TAB_IDS.includes(requestedTab as TabId) ? (requestedTab as TabId) : 'overview';

  const [detail, setDetail] = useState<LocationDetail | null>(null);
  const [latest, setLatest] = useState<LatestValue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [quantity, setQuantity] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>(DEFAULT_PERIOD);
  const [series, setSeries] = useState<ObservationsResponse | null>(null);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [seriesError, setSeriesError] = useState<string | null>(null);

  useDocumentTitle(detail ? `${detail.name} - rws` : `${code} - rws`);

  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setLatest([]);
    setLoading(true);
    setError(null);
    setSeries(null);
    setQuantity(null);
    setPeriod(DEFAULT_PERIOD);

    Promise.all([
      fetchLocation(code, controller.signal),
      // Best effort: a location with nothing ingested should still show its
      // identity and the list of what it measures.
      fetchLatest(code, controller.signal).catch(() => [] as LatestValue[]),
    ])
      .then(([loaded, latestValues]) => {
        if (controller.signal.aborted) return;
        setDetail(loaded);
        setLatest(latestValues);
        setQuantity(pickDefaultQuantity(loaded.measurementTypes)?.quantity ?? null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof ApiRequestError ? err.message : 'Could not load this location.');
        setLoading(false);
      });

    return () => controller.abort();
  }, [code]);

  const selectedType = useMemo(
    () => detail?.measurementTypes.find((t) => t.quantity === quantity) ?? null,
    [detail, quantity],
  );

  const loadSeries = useCallback((signal?: AbortSignal) => {
    if (!quantity || !selectedType) return;
    setSeriesLoading(true);
    setSeriesError(null);
    const { from, to } = windowFor(period);

    fetchObservations(
      { code, grootheid: quantity, compartiment: selectedType.compartment, from, to, resolution: period.resolution },
      signal,
    )
      .then((res) => {
        if (signal?.aborted) return;
        setSeries(res);
        setSeriesLoading(false);
      })
      .catch((err: unknown) => {
        if (signal?.aborted) return;
        setSeriesError(err instanceof ApiRequestError ? err.message : 'Could not load measurements.');
        setSeriesLoading(false);
      });
  }, [code, quantity, selectedType, period]);

  useEffect(() => {
    const controller = new AbortController();
    loadSeries(controller.signal);
    return () => controller.abort();
  }, [loadSeries]);

  function selectTab(next: string): void {
    const query = new URLSearchParams(params);
    if (next === 'overview') query.delete('tab');
    else query.set('tab', next);
    const encoded = query.toString();
    navigate(encoded ? `${route.path}?${encoded}` : route.path);
  }

  if (error) {
    return (
      <div className="page">
        <Notice tone="error" role="alert">{error}</Notice>
        <p className="page__back"><Link to="/search">← Back to all locations</Link></p>
      </div>
    );
  }

  if (loading || !detail) {
    return (
      <div className="page page--split">
        <div className="page__main">
          <Skeleton variant="title" />
          <Skeleton variant="line" />
          <Skeleton variant="chart" />
        </div>
        <aside className="page__aside"><Skeleton variant="block" /></aside>
      </div>
    );
  }

  const freshness = freshnessOf(detail.lastSeenAt);
  const latestForQuantity = latest.find((l) => l.quantity === quantity) ?? null;
  const storedPoints = detail.measurementTypes.reduce((sum, t) => sum + t.coverage.points, 0);
  const coverageFrom = earliest(detail.measurementTypes);
  const coverageTo = latestCoverage(detail.measurementTypes);

  return (
    <div className="page page--split">
      <div className="page__main">
        <nav className="breadcrumbs" aria-label="Breadcrumb">
          <Link to="/">Home</Link>
          <span aria-hidden="true">/</span>
          <Link to="/search">Locations</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{detail.code}</span>
        </nav>

        <header className="pkg__header">
          <h1 className="pkg__name">
            {detail.name}
            <Badge>{detail.code}</Badge>
            {detail.active && <Badge tone="accent">active</Badge>}
          </h1>
          <p className="pkg__summary">
            {detail.measurementTypes.length === 0
              ? 'This location publishes no measurement types.'
              : `Publishes ${plural(detail.measurementTypes.length, 'measurement series', 'measurement series')} — ${summarise(detail.measurementTypes)}.`}
          </p>
          <p className="pkg__status">
            <FreshnessTag state={freshness} label={FRESHNESS_LABEL[freshness]} />
            <span className="row__sep" aria-hidden="true">·</span>
            <span>last published {formatAge(detail.lastSeenAt)}</span>
          </p>
        </header>

        <Tabs
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'measurements', label: 'Measurements', count: detail.measurementTypes.length },
            { id: 'data', label: 'Data' },
            { id: 'map', label: 'Map' },
          ]}
          active={tab}
          onChange={selectTab}
        />

        <div className="tabpanel" id={`tabpanel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {tab === 'overview' && (
            <OverviewTab
              detail={detail}
              quantity={quantity}
              onQuantityChange={setQuantity}
              selectedType={selectedType}
              latestForQuantity={latestForQuantity}
              latest={latest}
              period={period}
              onPeriodChange={setPeriod}
              series={series}
              seriesLoading={seriesLoading}
              seriesError={seriesError}
              onRetry={() => loadSeries()}
            />
          )}

          {tab === 'measurements' && <MeasurementsTab detail={detail} latest={latest} />}

          {tab === 'data' && (
            <DataTab
              code={code}
              detail={detail}
              quantity={quantity}
              onQuantityChange={setQuantity}
              selectedType={selectedType}
              period={period}
              onPeriodChange={setPeriod}
              series={series}
              loading={seriesLoading}
              error={seriesError}
            />
          )}

          {tab === 'map' && <MapTab detail={detail} />}
        </div>
      </div>

      <aside className="page__aside" aria-label="Location metadata">
        <MetaBlock title="Fetch">
          <CopyBlock command={`curl ${origin()}/api/locations/${code}/latest`} label="API request" />
          <Link className="meta__link" to="/docs">API documentation →</Link>
        </MetaBlock>

        <MetaBlock title="Latest reading">
          {latestForQuantity && latestForQuantity.value !== null ? (
            <>
              <p className="meta__figure">
                {formatReading(latestForQuantity.value)}
                <span className="meta__unit">{selectedType?.unit ?? ''}</span>
              </p>
              <p className="meta__sub">
                {selectedType?.quantityLabel ?? quantity} · {formatAge(latestForQuantity.timestamp)}
              </p>
            </>
          ) : (
            <p className="meta__empty">No current reading</p>
          )}
        </MetaBlock>

        <div className="meta__pair">
          <MetaBlock title="Stored points">
            <p className="meta__value" title={formatCount(storedPoints)}>{formatCompact(storedPoints)}</p>
          </MetaBlock>
          <MetaBlock title="Series">
            <p className="meta__value">{formatCount(detail.measurementTypes.length)}</p>
          </MetaBlock>
        </div>

        <div className="meta__pair">
          <MetaBlock title="History">
            <p className="meta__value">{formatSpan(coverageFrom, coverageTo)}</p>
          </MetaBlock>
          <MetaBlock title="Since">
            <p className="meta__value">{formatDate(coverageFrom)}</p>
          </MetaBlock>
        </div>

        <MetaBlock title="Last publish">
          <p className="meta__value">{formatAge(detail.lastSeenAt)}</p>
          <p className="meta__sub">{formatTimestamp(detail.lastSeenAt)}</p>
        </MetaBlock>

        <MetaBlock title="Coordinates">
          {detail.lat !== null && detail.lon !== null ? (
            <p className="meta__mono">{detail.lat.toFixed(5)}, {detail.lon.toFixed(5)}</p>
          ) : (
            <p className="meta__empty">Not published</p>
          )}
        </MetaBlock>

        <MetaBlock title="Source">
          <a
            className="meta__link"
            href={waterinfoUrl(code, quantity)}
            target="_blank"
            rel="noreferrer noopener"
          >
            waterinfo.rws.nl ↗
          </a>
          <a
            className="meta__link"
            href="https://rijkswaterstaatdata.nl/waterdata/"
            target="_blank"
            rel="noreferrer noopener"
          >
            Rijkswaterstaat waterdata ↗
          </a>
        </MetaBlock>

        {detail.quantities.length > 0 && (
          <MetaBlock title="Measures">
            <p className="meta__chips">
              {detail.quantities.map((quantityCode) => (
                <Chip key={quantityCode} to={searchPath({ grootheid: quantityCode })}>
                  {labelFor(detail, quantityCode)}
                </Chip>
              ))}
            </p>
          </MetaBlock>
        )}

        <MetaBlock title="License">
          <p className="meta__value">Open data</p>
          <p className="meta__sub">Published by Rijkswaterstaat</p>
        </MetaBlock>
      </aside>
    </div>
  );
}

/* ---------- tabs ---------- */

interface OverviewTabProps {
  detail: LocationDetail;
  quantity: string | null;
  onQuantityChange: (code: string) => void;
  selectedType: MeasurementType | null;
  latestForQuantity: LatestValue | null;
  latest: LatestValue[];
  period: Period;
  onPeriodChange: (period: Period) => void;
  series: ObservationsResponse | null;
  seriesLoading: boolean;
  seriesError: string | null;
  onRetry: () => void;
}

function OverviewTab(props: OverviewTabProps) {
  const {
    detail, quantity, selectedType, latestForQuantity, latest,
    period, series, seriesLoading, seriesError,
  } = props;

  if (detail.measurementTypes.length === 0) {
    return <Notice>This location publishes no measurement types.</Notice>;
  }

  return (
    <>
      <div className="readme">
        <QuantityPicker
          types={detail.measurementTypes}
          value={quantity}
          onChange={props.onQuantityChange}
        />

        <div className="reading">
          <span className="reading__value">
            {latestForQuantity?.value !== undefined && latestForQuantity?.value !== null ? (
              <>{formatReading(latestForQuantity.value)}<span className="reading__unit">{selectedType?.unit ?? ''}</span></>
            ) : (
              <span className="reading__none">no current reading</span>
            )}
          </span>
          {latestForQuantity && (
            <span className="reading__time">{formatTimestamp(latestForQuantity.timestamp)}</span>
          )}
        </div>

        <div className="periods" role="group" aria-label="Chart period">
          {PERIODS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`periods__button${option.id === period.id ? ' periods__button--active' : ''}`}
              aria-pressed={option.id === period.id}
              onClick={() => props.onPeriodChange(option)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <ChartArea
          loading={seriesLoading}
          error={seriesError}
          series={series}
          label={selectedType?.quantityLabel ?? quantity ?? ''}
          unit={selectedType?.unit ?? null}
          onRetry={props.onRetry}
        />
      </div>

      {latest.length > 0 && (
        <section className="readme__section">
          <h2 className="readme__heading">Latest values</h2>
          <ul className="values">
            {latest.map((value) => (
              <li key={`${value.seriesId}-${value.timestamp}`} className="values__row">
                <span className="values__label">{value.quantity}</span>
                <span className="values__value">
                  {value.value !== null
                    ? <>{formatReading(value.value)} {value.unit ?? ''}</>
                    : <span className="values__gap">{value.valueText ?? 'gap'}</span>}
                  <span className="values__age">{formatAge(value.timestamp)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function MeasurementsTab({ detail, latest }: { detail: LocationDetail; latest: LatestValue[] }) {
  if (detail.measurementTypes.length === 0) {
    return <Notice>This location publishes no measurement types.</Notice>;
  }

  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="visually-hidden">Measurement series published by {detail.name}</caption>
        <thead>
          <tr>
            <th scope="col">Quantity</th>
            <th scope="col">Compartment</th>
            <th scope="col">Unit</th>
            <th scope="col">Stored range</th>
            <th scope="col" className="table__num">Points</th>
            <th scope="col" className="table__num">Latest</th>
          </tr>
        </thead>
        <tbody>
          {detail.measurementTypes.map((type) => {
            const current = latest.find((l) => l.seriesId === type.seriesId);
            return (
              <tr key={type.seriesId}>
                <th scope="row">
                  <span className="table__name">{type.quantityLabel ?? type.quantity}</span>
                  <span className="table__code">{type.quantity}</span>
                </th>
                <td>{type.compartmentLabel ?? type.compartment}</td>
                <td className="table__mono">{type.unit ?? '—'}</td>
                <td>
                  {type.coverage.from
                    ? `${formatDate(type.coverage.from)} → ${formatDate(type.coverage.to)}`
                    : 'nothing stored yet'}
                </td>
                <td className="table__num">{formatCount(type.coverage.points)}</td>
                <td className="table__num">
                  {current?.value !== undefined && current?.value !== null
                    ? `${formatReading(current.value)} ${current.unit ?? ''}`
                    : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface DataTabProps {
  code: string;
  detail: LocationDetail;
  quantity: string | null;
  onQuantityChange: (code: string) => void;
  selectedType: MeasurementType | null;
  period: Period;
  onPeriodChange: (period: Period) => void;
  series: ObservationsResponse | null;
  loading: boolean;
  error: string | null;
}

function DataTab(props: DataTabProps) {
  const { code, detail, quantity, selectedType, period, series, loading, error } = props;

  if (detail.measurementTypes.length === 0) {
    return <Notice>This location publishes no measurement types.</Notice>;
  }

  const { from, to } = windowFor(period);
  const requestUrl = `${origin()}/api/locations/${encodeURIComponent(code)}/observations`
    + `?grootheid=${encodeURIComponent(quantity ?? '')}`
    + `&from=${from.toISOString()}&to=${to.toISOString()}`
    + `&resolution=${period.resolution}`;

  return (
    <div className="readme">
      <QuantityPicker types={detail.measurementTypes} value={quantity} onChange={props.onQuantityChange} />

      <div className="periods" role="group" aria-label="Data period">
        {PERIODS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`periods__button${option.id === period.id ? ' periods__button--active' : ''}`}
            aria-pressed={option.id === period.id}
            onClick={() => props.onPeriodChange(option)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <h2 className="readme__heading">Request</h2>
      <CopyBlock command={`curl "${requestUrl}"`} label="observations request" />

      {error && <Notice tone="error" role="alert">{error}</Notice>}
      {loading && !series && <Skeleton variant="block" />}

      {series && (
        <>
          <h2 className="readme__heading">
            Response
            <span className="readme__hint">
              {series.resolution} resolution · {plural(series.points.length, 'point')}
            </span>
          </h2>
          {series.points.length === 0 ? (
            <Notice role="status">
              {series.backfillPending
                ? 'No history stored for this measurement yet. Recent periods are fetched on demand — try 24h or 48h.'
                : 'No measurements in this period.'}
            </Notice>
          ) : (
            <ObservationTable series={series} unit={selectedType?.unit ?? null} />
          )}
        </>
      )}
    </div>
  );
}

function ObservationTable({ series, unit }: { series: ObservationsResponse; unit: string | null }) {
  const aggregated = series.resolution !== 'raw';
  const rows = series.points.slice(-200).reverse();

  return (
    <>
      <div className="table-wrap table-wrap--tall">
      <table className="table table--dense">
        <caption className="visually-hidden">Observation values</caption>
        <thead>
          <tr>
            <th scope="col">Time (UTC)</th>
            <th scope="col" className="table__num">{aggregated ? 'Mean' : 'Value'}{unit ? ` (${unit})` : ''}</th>
            {aggregated && <th scope="col" className="table__num">Min</th>}
            {aggregated && <th scope="col" className="table__num">Max</th>}
            {aggregated && <th scope="col" className="table__num">Readings</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((point) => {
            const time = new Date(point.t).toISOString().replace('T', ' ').slice(0, 16);
            if (aggregated) {
              const aggregate = point as AggregatePoint;
              return (
                <tr key={aggregate.t}>
                  <td className="table__mono">{time}</td>
                  <td className="table__num">{formatReading(aggregate.mean)}</td>
                  <td className="table__num">{formatReading(aggregate.min)}</td>
                  <td className="table__num">{formatReading(aggregate.max)}</td>
                  <td className="table__num">{formatCount(aggregate.count)}</td>
                </tr>
              );
            }
            const raw = point as RawPoint;
            return (
              <tr key={raw.t}>
                <td className="table__mono">{time}</td>
                <td className="table__num">{formatReading(raw.v)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      {series.points.length > rows.length && (
        <p className="table__note table__note--outside">
          Showing the most recent {formatCount(rows.length)} of {formatCount(series.points.length)}.
          The API returns the full window.
        </p>
      )}
    </>
  );
}

function MapTab({ detail }: { detail: LocationDetail }) {
  if (detail.lat === null || detail.lon === null) {
    return <Notice>This location publishes no coordinates, so it cannot be placed on the map.</Notice>;
  }

  return (
    <div className="map-embed">
      <LazyMapView
        locations={[detail]}
        selectedCode={detail.code}
        onSelect={() => { /* already on this location's page */ }}
        flyTo={detail}
      />
    </div>
  );
}

/* ---------- shared bits ---------- */

function QuantityPicker({ types, value, onChange }: {
  types: MeasurementType[];
  value: string | null;
  onChange: (code: string) => void;
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor="quantity-picker">Measurement</label>
      <select
        id="quantity-picker"
        className="field__input"
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value)}
      >
        {types.map((type) => (
          <option key={type.seriesId} value={type.quantity}>
            {type.quantityLabel ?? type.quantity}{type.unit ? ` (${type.unit})` : ''}
          </option>
        ))}
      </select>
    </div>
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
      <Notice tone="error" role="alert">
        {error}
        <button type="button" className="button button--ghost" onClick={onRetry}>Try again</button>
      </Notice>
    );
  }

  // First load has nothing to hold on to; a reload keeps the previous render at
  // reduced opacity instead of flashing a skeleton and jumping the layout.
  if (loading && !series) return <Skeleton variant="chart" />;
  if (!series) return null;

  if (series.points.length === 0) {
    return (
      <Notice role="status">
        {series.backfillPending
          // The API fetches on demand for short windows; a long window with no
          // data means the batch backfill has not covered it yet.
          ? 'No history stored for this measurement yet. Recent periods are fetched on demand — try 24h or 48h, or run the backfill for the full year.'
          : 'No measurements in this period.'}
      </Notice>
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
        <Notice tone="warn" role="status">
          Rijkswaterstaat was unreachable; showing stored data
          {series.fetchedAt ? ` fetched ${formatAge(series.fetchedAt)}` : ''}.
        </Notice>
      )}
      {series.requestedResolution && series.requestedResolution !== series.resolution && (
        <p className="chart__note">
          Showing {series.resolution} data — the requested {series.requestedResolution} resolution
          exceeds the point limit for this period.
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

/* ---------- helpers ---------- */

function origin(): string {
  return typeof window === 'undefined' ? '' : window.location.origin;
}

function summarise(types: MeasurementType[]): string {
  const names = [...new Set(types.map((t) => t.quantityLabel ?? t.quantity))];
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

function labelFor(detail: LocationDetail, quantityCode: string): string {
  return detail.measurementTypes.find((t) => t.quantity === quantityCode)?.quantityLabel ?? quantityCode;
}

function earliest(types: MeasurementType[]): string | null {
  const values = types.map((t) => t.coverage.from).filter((v): v is string => Boolean(v));
  return values.length === 0 ? null : values.reduce((a, b) => (a < b ? a : b));
}

function latestCoverage(types: MeasurementType[]): string | null {
  const values = types.map((t) => t.coverage.to).filter((v): v is string => Boolean(v));
  return values.length === 0 ? null : values.reduce((a, b) => (a > b ? a : b));
}
