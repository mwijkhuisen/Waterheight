/**
 * Time-series chart: a mean line with a min–max band behind it when the data
 * has been downsampled.
 *
 * Hand-rolled SVG rather than a charting library — the whole requirement is one
 * line, one band, an axis pair and a crosshair, and owning the markup keeps the
 * theming, the aggregate band and the accessibility story straightforward.
 *
 * Design rules followed here: 2px line with round caps, the band as a ~10%
 * wash of the same hue, hairline solid gridlines one step off the surface, no
 * second y-axis, text in text tokens rather than the series colour, and a
 * crosshair that snaps to the nearest point so the reader aims at a time rather
 * than at a 2px line. The tooltip never gates a value: the endpoint is directly
 * labelled and every point is reachable in the table view.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { AggregatePoint, RawPoint, Resolution } from '@rws/shared';

/** Categorical slot 1. Light and dark steps of the same hue. */
const SERIES_LIGHT = '#2a78d6';
const SERIES_DARK = '#3987e5';

const MARGIN = { top: 12, right: 14, bottom: 26, left: 46 };
const HEIGHT = 210;

export interface TimeSeriesChartProps {
  points: RawPoint[] | AggregatePoint[];
  resolution: Resolution;
  unit: string | null;
  label: string;
  /** Held at reduced opacity while a new range loads, rather than flashing. */
  reloading?: boolean;
}

interface Datum {
  t: number;
  value: number | null;
  min: number | null;
  max: number | null;
  count: number | null;
}

function isAggregate(
  points: RawPoint[] | AggregatePoint[],
  resolution: Resolution,
): points is AggregatePoint[] {
  return resolution !== 'raw' && points.length > 0 && 'mean' in points[0]!;
}

/** Round axis bounds out to clean numbers so ticks read as values, not noise. */
function niceExtent(min: number, max: number): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) return [min - 1, max + 1];
  const span = max - min;
  const step = 10 ** Math.floor(Math.log10(span / 4));
  const nice = [1, 2, 2.5, 5, 10].map((m) => m * step)
    .find((s) => span / s <= 5) ?? step * 10;
  return [Math.floor(min / nice) * nice, Math.ceil(max / nice) * nice];
}

function ticks(lo: number, hi: number, count = 4): number[] {
  const step = (hi - lo) / count;
  return Array.from({ length: count + 1 }, (_, i) => lo + i * step);
}

function formatValue(v: number | null): string {
  if (v === null) return '—';
  const abs = Math.abs(v);
  const decimals = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return v.toFixed(decimals).replace(/\.0+$/, '');
}

function formatTick(t: number, spanMs: number): string {
  const d = new Date(t);
  if (spanMs <= 86_400_000) {
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  }
  // Past a day the clock time repeats -- a 48h window would label all three
  // ticks identically -- so the day has to come along.
  if (spanMs <= 3 * 86_400_000) {
    return d.toLocaleString('en-GB', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
    });
  }
  if (spanMs <= 120 * 86_400_000) {
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }
  // Not { year: '2-digit' }: "Mar 26" reads as the 26th of March.
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function formatFull(t: number): string {
  return `${new Date(t).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  })} UTC`;
}

export function TimeSeriesChart(props: TimeSeriesChartProps) {
  const { points, resolution, unit, label, reloading = false } = props;
  const gradientId = useId();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(320);
  const [hover, setHover] = useState<number | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(240, entry.contentRect.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The series colour is one of two selected steps, not an automatic flip.
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setDark(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  const series = dark ? SERIES_DARK : SERIES_LIGHT;
  const aggregated = isAggregate(points, resolution);

  const data = useMemo<Datum[]>(() => {
    if (aggregated) {
      return (points as AggregatePoint[]).map((p) => ({
        t: Date.parse(p.t), value: p.mean, min: p.min, max: p.max, count: p.count,
      }));
    }
    return (points as RawPoint[]).map((p) => ({
      t: Date.parse(p.t), value: p.v, min: null, max: null, count: null,
    }));
  }, [points, aggregated]);

  const geometry = useMemo(() => {
    const withValues = data.filter((d) => d.value !== null);
    if (withValues.length === 0) return null;

    const lows = data.map((d) => d.min ?? d.value).filter((v): v is number => v !== null);
    const highs = data.map((d) => d.max ?? d.value).filter((v): v is number => v !== null);
    const [lo, hi] = niceExtent(Math.min(...lows), Math.max(...highs));

    const t0 = data[0]!.t;
    const t1 = data.at(-1)!.t;
    const spanMs = Math.max(1, t1 - t0);

    const plotW = Math.max(1, width - MARGIN.left - MARGIN.right);
    const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
    const x = (t: number) => MARGIN.left + ((t - t0) / spanMs) * plotW;
    const y = (v: number) => MARGIN.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;

    // Break the line at gaps rather than drawing a straight segment across a
    // hole, which would invent data that was never measured.
    const segments: string[] = [];
    let current: string[] = [];
    for (const d of data) {
      if (d.value === null) {
        if (current.length > 1) segments.push(current.join(' '));
        current = [];
        continue;
      }
      current.push(`${current.length === 0 ? 'M' : 'L'}${x(d.t).toFixed(1)},${y(d.value).toFixed(1)}`);
    }
    if (current.length > 1) segments.push(current.join(' '));

    let band: string | null = null;
    if (aggregated) {
      const top: string[] = [];
      const bottom: string[] = [];
      for (const d of data) {
        if (d.max === null || d.min === null) continue;
        top.push(`${top.length === 0 ? 'M' : 'L'}${x(d.t).toFixed(1)},${y(d.max).toFixed(1)}`);
        bottom.unshift(`L${x(d.t).toFixed(1)},${y(d.min).toFixed(1)}`);
      }
      if (top.length > 1) band = `${top.join(' ')} ${bottom.join(' ')} Z`;
    }

    const last = withValues.at(-1)!;
    return {
      lo, hi, t0, t1, spanMs, plotW, plotH, x, y, segments, band,
      last: { x: x(last.t), y: y(last.value!), value: last.value! },
    };
  }, [data, width, aggregated]);

  const hovered = hover !== null ? data[hover] : null;

  function handleMove(event: React.PointerEvent<SVGSVGElement>): void {
    if (!geometry || data.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    // Snap to the nearest point: the reader aims at a time, not at a 2px line.
    const ratio = (px - MARGIN.left) / geometry.plotW;
    const target = geometry.t0 + ratio * geometry.spanMs;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < data.length; i++) {
      const dist = Math.abs(data[i]!.t - target);
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    setHover(best);
  }

  if (!geometry) {
    return (
      <p className="notice" role="status">
        No measurements in this period.
      </p>
    );
  }

  const yTicks = ticks(geometry.lo, geometry.hi);
  const xTickTimes = [geometry.t0, geometry.t0 + geometry.spanMs / 2, geometry.t1];
  const unitSuffix = unit ? ` ${unit}` : '';

  return (
    <div className="chart" ref={containerRef}>
      <svg
        className={`chart__svg${reloading ? ' chart__svg--reloading' : ''}`}
        width={width}
        height={HEIGHT}
        role="img"
        aria-label={
          `${label}${unitSuffix ? ` in ${unit}` : ''}, ${resolution} resolution, ` +
          `${data.length} points from ${formatFull(geometry.t0)} to ${formatFull(geometry.t1)}. ` +
          `Latest ${formatValue(geometry.last.value)}${unitSuffix}.`
        }
        onPointerMove={handleMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={series} stopOpacity="0.16" />
            <stop offset="100%" stopColor={series} stopOpacity="0.08" />
          </linearGradient>
        </defs>

        {/* Hairline, solid, recessive — never dashed. */}
        {yTicks.map((v) => (
          <g key={v}>
            <line
              x1={MARGIN.left} x2={width - MARGIN.right}
              y1={geometry.y(v)} y2={geometry.y(v)}
              className="chart__grid"
            />
            <text
              x={MARGIN.left - 6} y={geometry.y(v)}
              className="chart__tick" textAnchor="end" dominantBaseline="middle"
            >
              {formatValue(v)}
            </text>
          </g>
        ))}

        {xTickTimes.map((t, i) => (
          <text
            key={t}
            x={geometry.x(t)} y={HEIGHT - 8}
            className="chart__tick"
            textAnchor={i === 0 ? 'start' : i === xTickTimes.length - 1 ? 'end' : 'middle'}
          >
            {formatTick(t, geometry.spanMs)}
          </text>
        ))}

        {/* The min–max band, so an aggregated view is visibly aggregated. */}
        {geometry.band && (
          <path d={geometry.band} fill={`url(#${gradientId})`} stroke="none" />
        )}

        {geometry.segments.map((d, i) => (
          <path
            key={i} d={d} fill="none" stroke={series}
            strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
          />
        ))}

        {/* Direct label on the endpoint, so the latest value never depends on
            hovering. The 2px surface ring keeps it legible over the line. */}
        <circle
          cx={geometry.last.x} cy={geometry.last.y} r={4}
          fill={series} stroke="var(--bg)" strokeWidth={2}
        />

        {hovered && hovered.value !== null && (
          <g pointerEvents="none">
            <line
              x1={geometry.x(hovered.t)} x2={geometry.x(hovered.t)}
              y1={MARGIN.top} y2={MARGIN.top + geometry.plotH}
              className="chart__crosshair"
            />
            <circle
              cx={geometry.x(hovered.t)} cy={geometry.y(hovered.value)} r={4}
              fill={series} stroke="var(--bg)" strokeWidth={2}
            />
          </g>
        )}
      </svg>

      {hovered && hovered.value !== null && (
        <div className="chart__tooltip" role="status">
          {/* Value leads, label follows: the reader has the series and wants the number. */}
          <span className="chart__tooltip-value">
            {formatValue(hovered.value)}{unitSuffix}
          </span>
          <span className="chart__tooltip-time">{formatFull(hovered.t)}</span>
          {hovered.min !== null && hovered.max !== null && (
            <span className="chart__tooltip-range">
              range {formatValue(hovered.min)}–{formatValue(hovered.max)}{unitSuffix}
              {hovered.count !== null && ` · ${hovered.count} readings`}
            </span>
          )}
        </div>
      )}

      <div className="chart__footer">
        <span className="chart__caption">
          {aggregated
            ? `${resolution === 'hourly' ? 'Hourly' : 'Daily'} mean; shaded band is the min–max range`
            : `${data.length.toLocaleString('en-GB')} measurements`}
        </span>
        <button
          type="button"
          className="chart__toggle"
          onClick={() => setShowTable((v) => !v)}
          aria-expanded={showTable}
        >
          {showTable ? 'Hide values' : 'Show values'}
        </button>
      </div>

      {/* Tooltips enhance but never gate: every value is reachable here too. */}
      {showTable && (
        <div className="chart__table-wrap">
          <table className="chart__table">
            <caption className="visually-hidden">
              {label} values, {resolution} resolution
            </caption>
            <thead>
              <tr>
                <th scope="col">Time (UTC)</th>
                <th scope="col">{aggregated ? 'Mean' : 'Value'}{unitSuffix}</th>
                {aggregated && <th scope="col">Min</th>}
                {aggregated && <th scope="col">Max</th>}
              </tr>
            </thead>
            <tbody>
              {data.slice(-100).reverse().map((d) => (
                <tr key={d.t}>
                  <td>{formatFull(d.t).replace(' UTC', '')}</td>
                  <td className="chart__num">{formatValue(d.value)}</td>
                  {aggregated && <td className="chart__num">{formatValue(d.min)}</td>}
                  {aggregated && <td className="chart__num">{formatValue(d.max)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
          {data.length > 100 && (
            <p className="chart__table-note">Showing the most recent 100 of {data.length.toLocaleString('en-GB')}.</p>
          )}
        </div>
      )}
    </div>
  );
}
