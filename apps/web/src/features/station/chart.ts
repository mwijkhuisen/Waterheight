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
import {
  ASTRO_COLOUR,
  type ChartData,
  drawer,
  markerSeries,
  type Pt,
  SURGE_DOWN_COLOUR,
  SURGE_UP_COLOUR,
} from './chartModel.ts';
import { MEASURED_COLOUR as COLOUR, FORECAST_COLOUR } from './colours.ts';
import { surgeBand } from './tide.ts';

use([LineChart, GridComponent, TooltipComponent, MarkLineComponent, MarkAreaComponent, CanvasRenderer]);

interface AxisParam {
  seriesId?: string;
  seriesName?: string;
  value?: unknown;
}

const SHOWN = new Set(['obs', 'median', 'estimate', 'astro', 'surge-up', 'surge-down']);
const flat = { symbol: 'none', connectNulls: false, smooth: false } as const;
// ECharts 6 stacks with 'samesign' by default: a spread over a negative base (a level below NAP) would be drawn from 0.
// 'all' stacks every spread on its own base whatever the signs (P19b critic C2).
const stacked = (name: string) => ({ stack: name, stackStrategy: 'all' }) as const;

/** One stacked pair (an invisible base and a filled spread) of the surge band; the pair id says the sign. */
const pair = (id: 'surge-up' | 'surge-down', colour: string, p: { base: Pt[]; spread: Pt[] }) =>
  p.spread.some(([, v]) => v !== null)
    ? [
        {
          ...flat,
          ...stacked(id),
          id: `${id}-base`,
          type: 'line',
          data: p.base,
          lineStyle: { opacity: 0 },
          silent: true,
          z: 1,
        },
        {
          ...flat,
          ...stacked(id),
          id,
          type: 'line',
          data: p.spread,
          lineStyle: { opacity: 0 },
          areaStyle: { color: colour, opacity: 0.45 },
          z: 1,
        },
      ]
    : [];

export function createChart(el: HTMLElement) {
  const chart = init(el, undefined, { renderer: 'canvas' });
  const resize = new ResizeObserver(() => chart.resize());
  resize.observe(el);
  testHook?.charts?.add(chart);
  /** The whole option; the marker series (the now and selected lines) first, see chartModel.ts. */
  const option = (d: ChartData, selected: number | undefined) => {
    // The e2e build counts the full redraws (O3: a step of t alone must not make one).
    if (testHook) testHook.chartDraws = (testHook.chartDraws ?? 0) + 1;
    // Plain text only (invariant 3): one line per shown series.
    const tip = (params: AxisParam | AxisParam[]): string => {
      const items = (Array.isArray(params) ? params : [params]).filter((p) => SHOWN.has(p.seriesId ?? ''));
      const lines: string[] = [];
      let at: number | undefined;
      for (const p of items) {
        const v = p.value;
        if (!Array.isArray(v) || typeof v[0] !== 'number' || typeof v[1] !== 'number') continue;
        at = v[0];
        const tip = d.tideTip;
        if (p.seriesId === 'astro' && tip !== undefined) lines.push(tip.astro(`${d.format(v[1])} ${d.unit}`));
        // The pair id gives the sign: the "down" spread holds −surge.
        else if ((p.seriesId === 'surge-up' || p.seriesId === 'surge-down') && tip !== undefined) {
          const s = (p.seriesId === 'surge-up' ? v[1] : -v[1]) + 0; // + 0: no "-0"
          lines.push(tip.surge(`${s > 0 ? '+' : ''}${d.format(s)} ${tip.unit}`));
        } else lines.push(`${p.seriesName}: ${d.format(v[1])} ${d.unit}`);
      }
      return at === undefined ? '' : [d.name, formatLocal(at, d.locale), ...lines].join('\n');
    };
    const tide = d.tide;
    const band = tide === undefined ? undefined : surgeBand(tide.astro, tide.surge);
    const tideSeries =
      tide === undefined || band === undefined
        ? []
        : [
            ...(tide.astro.length === 0
              ? []
              : [
                  {
                    ...flat,
                    id: 'astro',
                    type: 'line',
                    data: tide.astro,
                    lineStyle: { type: 'dashed', color: ASTRO_COLOUR, width: 1.5 },
                    itemStyle: { color: ASTRO_COLOUR },
                  },
                ]),
            ...pair('surge-up', SURGE_UP_COLOUR, band.up),
            ...pair('surge-down', SURGE_DOWN_COLOUR, band.down),
          ];
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
                    ...stacked('band'),
                    data: f.view.lower,
                    lineStyle: { opacity: 0 },
                    silent: true,
                  },
                  {
                    ...flat,
                    id: 'band-spread',
                    type: 'line',
                    ...stacked('band'),
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
    return {
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
        markerSeries(d, selected),
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
            // The now and selected lines are the marker series'.
            data: d.showThresholds
              ? d.marks.lines.map((l) => ({
                  yAxis: l.value,
                  name: l.text,
                  lineStyle: { type: 'dashed', color: '#555' },
                }))
              : [],
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
        ...tideSeries,
        ...forecastSeries,
      ],
    };
  };
  return {
    /** Draws `d` with the selected instant: in full for a new `d`, else the marker series alone (chartModel.ts drawer). */
    draw: drawer(chart, option),
    dispose() {
      resize.disconnect();
      testHook?.charts?.delete(chart);
      chart.dispose();
    },
  };
}
