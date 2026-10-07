// The lazy chart chunk (A§10: ECharts is never in the initial bundle). Only the
// parts the panel uses are registered. The tooltip is drawn on the canvas
// (`renderMode: 'richText'`) and its formatter returns plain text, so a station
// name is never parsed as HTML (invariant 3).
import { LineChart } from 'echarts/charts';
import { GridComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent } from 'echarts/components';
import { init, use } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { testHook } from '../../lib/testHook.ts';
import { formatLocal, formatShort } from '../../lib/time/time.ts';
import type { Locale } from '../../paraglide/runtime.js';
import type { ForecastView, Pt } from './chartModel.ts';
import { MEASURED_COLOUR as COLOUR, FORECAST_COLOUR } from './colours.ts';
import type { Marks } from './thresholds.ts';

use([LineChart, GridComponent, TooltipComponent, MarkLineComponent, MarkAreaComponent, CanvasRenderer]);

export interface ChartData {
  locale: Locale;
  /** The station name exactly as published: untrusted text. */
  name: string;
  /** The unit as published, with its zero ("cm NAP"). */
  unit: string;
  /** Observed points: [UTC ms, value in the native unit]. */
  points: Pt[];
  /** The selected instant when it is not now and on the axis: a dashed vertical line. */
  selected: number | undefined;
  /** The server's now when it is on the axis: a solid vertical line, named `nowName`. */
  now: number | undefined;
  nowName: string;
  /** The title of the time axis ("Nederlandse tijd"). */
  axisName: string;
  format: (value: number) => string;
  /** One run (never blended with another): its series names come from Paraglide. */
  forecast?: { view: ForecastView; name: string; estimateName: string } | undefined;
  marks: Marks;
  /** The threshold lines and zones are drawn only when this is true. */
  showThresholds: boolean;
  observedName: string;
  /** The time axis: the panel's span, stretched to the end of the run shown (xRange). */
  x: { min: number; max: number };
}

interface AxisParam {
  seriesId?: string;
  seriesName?: string;
  value?: unknown;
}

const SHOWN = new Set(['obs', 'median', 'estimate']);
const flat = { symbol: 'none', connectNulls: false, smooth: false } as const;

export function createChart(el: HTMLElement) {
  const chart = init(el, undefined, { renderer: 'canvas' });
  const resize = new ResizeObserver(() => chart.resize());
  resize.observe(el);
  testHook?.charts?.add(chart);
  return {
    update(d: ChartData) {
      // Plain text only (invariant 3): one line per shown series.
      const tip = (params: AxisParam | AxisParam[]): string => {
        const items = (Array.isArray(params) ? params : [params]).filter((p) => SHOWN.has(p.seriesId ?? ''));
        const lines: string[] = [];
        let at: number | undefined;
        for (const p of items) {
          const v = p.value;
          if (!Array.isArray(v) || typeof v[0] !== 'number' || typeof v[1] !== 'number') continue;
          at = v[0];
          lines.push(`${p.seriesName}: ${d.format(v[1])} ${d.unit}`);
        }
        return at === undefined ? '' : [d.name, formatLocal(at, d.locale), ...lines].join('\n');
      };
      const f = d.forecast;
      const forecastSeries =
        f === undefined
          ? []
          : [
              ...(f.view.hasBand
                ? [
                    {
                      ...flat,
                      id: 'band-lo',
                      type: 'line',
                      stack: 'band',
                      data: f.view.lower,
                      lineStyle: { opacity: 0 },
                      silent: true,
                    },
                    {
                      ...flat,
                      id: 'band-spread',
                      type: 'line',
                      stack: 'band',
                      data: f.view.spread,
                      lineStyle: { opacity: 0 },
                      areaStyle: { color: FORECAST_COLOUR, opacity: 0.2 },
                      silent: true,
                    },
                  ]
                : []),
              {
                ...flat,
                id: 'median',
                type: 'line',
                name: f.name,
                data: f.view.provider,
                lineStyle: { type: 'dashed', color: FORECAST_COLOUR },
                itemStyle: { color: FORECAST_COLOUR },
              },
              {
                ...flat,
                id: 'estimate',
                type: 'line',
                name: f.estimateName,
                data: f.view.estimate,
                lineStyle: { type: 'dotted', color: FORECAST_COLOUR },
                itemStyle: { color: FORECAST_COLOUR },
              },
            ];
      chart.setOption(
        {
          animation: false,
          grid: { left: 56, right: 16, top: 24, bottom: 52 },
          xAxis: {
            type: 'time',
            min: d.x.min,
            max: d.x.max,
            name: d.axisName,
            nameLocation: 'middle',
            nameGap: 30,
            axisLabel: { formatter: (v: number) => formatShort(v, d.locale), hideOverlap: true },
          },
          yAxis: {
            type: 'value',
            scale: true,
            name: d.unit,
            nameTextStyle: { align: 'left' },
            splitLine: { show: true, lineStyle: { color: '#d9d9d9' } },
          },
          tooltip: { trigger: 'axis', renderMode: 'richText', formatter: tip },
          series: [
            {
              ...flat,
              id: 'obs',
              type: 'line',
              name: d.observedName,
              data: d.points,
              lineStyle: { color: COLOUR },
              itemStyle: { color: COLOUR },
              markLine: {
                silent: true,
                symbol: 'none',
                // A function, never a template string: a label may hold `{…}` (provider text).
                label: { show: true, position: 'insideEndTop', formatter: (p: { name?: string }) => p.name ?? '' },
                data: [
                  ...(d.now === undefined
                    ? []
                    : [{ xAxis: d.now, name: d.nowName, lineStyle: { type: 'solid', color: '#555' } }]),
                  ...(d.selected === undefined ? [] : [{ xAxis: d.selected, name: '', label: { show: false } }]),
                  ...(d.showThresholds
                    ? d.marks.lines.map((l) => ({
                        yAxis: l.value,
                        name: l.text,
                        lineStyle: { type: 'dashed', color: '#555' },
                      }))
                    : []),
                ],
              },
              markArea: {
                silent: true,
                // An open end has no `yAxis`: ECharts clamps it to the axis.
                data: d.showThresholds
                  ? d.marks.zones.map((z) => [
                      { ...(z.from === null ? {} : { yAxis: z.from }), itemStyle: { color: z.colour, opacity: 0.15 } },
                      z.to === null ? {} : { yAxis: z.to },
                    ])
                  : [],
              },
            },
            ...forecastSeries,
          ],
        },
        { notMerge: true },
      );
    },
    dispose() {
      resize.disconnect();
      testHook?.charts?.delete(chart);
      chart.dispose();
    },
  };
}
